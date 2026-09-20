'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/utils/supabase';
import {
  FEE_LEVELS, FEE_PARTS, academicYearChoices, currentAcademicYear, feeTotals, rupees, levelLabel,
  loadFees, setFees, setStartTime, startTimeText,
} from './fees-admin';
import {
  loadCrm, saveCrm, rotateCrmSecret, removeCrm, sendCrmTest, retryDelivery, deliveryText, loadClickStats, CLICK_KINDS,
  nudgeSender, friendlyError,
} from './applications-admin';

const btn = 'px-3 py-1.5 rounded text-sm font-bold disabled:opacity-50';
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const EMPTY_FEES = Object.fromEntries(FEE_PARTS.map((p) => [p.key, '']));

// ---- what a year at this school costs a family -------------------------------------------------------------------
export function FeesSection({ school, busy, act, version }) {
  const [fees, setFeeRows] = useState({});
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState({ ...EMPTY_FEES, academic_year: currentAcademicYear(), note: '', source_url: '' });

  const apply = useCallback((res) => {
    if (res.error) setError(friendlyError(res.error)); else { setError(''); setFeeRows(res.fees); }
  }, []);
  useEffect(() => { loadFees(supabase, school.id).then(apply); }, [school.id, version, apply]);

  function edit(level) {
    const row = fees[level];
    setOpen(level);
    setForm(row
      ? { ...Object.fromEntries(FEE_PARTS.map((p) => [p.key, String(row[p.key] ?? '')])), academic_year: row.academic_year, note: row.note ?? '', source_url: row.source_url ?? '' }
      : { ...EMPTY_FEES, academic_year: currentAcademicYear(), note: '', source_url: '' });
  }

  const totals = feeTotals(form);

  return (
    <section className="mb-6" data-testid="fees-section">
      <h4 className="font-bold mb-2">Fees</h4>
      <p className="text-sm text-gray-600 mb-2">
        What a family really pays in a year, so they can compare schools honestly. Parents see the total for the first
        year (with the one-time fees) and for each year after it, and the breakdown below it.
      </p>
      {!!error && <p data-testid="fees-error" className="text-sm text-red-700 mb-2">{error}</p>}
      <div className="grid md:grid-cols-2 gap-2 mb-2">
        {FEE_LEVELS.map((l) => {
          const row = fees[l.key];
          return (
            <div key={l.key} className="border border-gray-100 rounded p-2 text-sm" data-testid={`fee-level-${l.key}`}>
              <p className="font-bold">{l.label}</p>
              {row ? (
                <p data-testid={`fee-total-${l.key}`}>
                  {rupees(row.first_year_total)} in the first year, then {rupees(row.annual_total)} a year
                  <span className="text-xs text-gray-500"> ({row.academic_year}, {row.source === 'school' ? 'from the school' : row.source === 'kidscover' ? 'checked by Kidscover' : "from the school's website"})</span>
                </p>
              ) : <p className="text-gray-600">Not given yet.</p>}
              <div className="flex gap-2 mt-1">
                <button data-testid={`fee-edit-${l.key}`} onClick={() => edit(l.key)} className={`${btn} bg-gray-200 text-gray-800 text-xs`}>{row ? 'Change' : 'Add fees'}</button>
                {row && (
                  <button data-testid={`fee-remove-${l.key}`} disabled={busy}
                    onClick={() => act(() => setFees(supabase, school.id, l.key, null), `${levelLabel(l.key)} fees removed.`).then(() => loadFees(supabase, school.id).then(apply))}
                    className={`${btn} bg-gray-200 text-gray-800 text-xs`}>Remove</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {open && (
        <div className="border border-gray-200 rounded p-3 bg-gray-50" data-testid="fee-form">
          <p className="font-bold text-sm mb-2">{levelLabel(open)}</p>
          <label className="block text-xs font-bold text-gray-600">Academic year</label>
          <select data-testid="fee-year" value={form.academic_year} onChange={(e) => setForm((f) => ({ ...f, academic_year: e.target.value }))}
            className="border border-gray-300 rounded px-2 py-1 text-sm text-black mb-2">
            {academicYearChoices().map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <div className="grid md:grid-cols-3 gap-2">
            {FEE_PARTS.map((p) => (
              <label key={p.key} className="text-xs">
                <span className="block font-bold text-gray-600">
                  {p.label}{p.when === 'once' ? ' (once)' : p.when === 'deposit' ? ' (given back)' : ' a year'}
                </span>
                <input data-testid={`fee-${p.key}`} value={form[p.key]} inputMode="numeric"
                  onChange={(e) => setForm((f) => ({ ...f, [p.key]: e.target.value.replace(/[^0-9]/g, '').slice(0, 7) }))}
                  placeholder="0" className="w-full border border-gray-300 rounded px-2 py-1 text-sm text-black" />
              </label>
            ))}
          </div>
          <p data-testid="fee-preview" className="text-sm font-bold mt-2">
            First year {rupees(totals.firstYear)}, then {rupees(totals.yearly)} a year
            {totals.deposit ? `, plus a refundable deposit of ${rupees(totals.deposit)}` : ''}
          </p>
          <input data-testid="fee-note" value={form.note} maxLength={200} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            placeholder="Anything a family should know (optional), e.g. 10% less for a second child"
            className="block w-full border border-gray-300 rounded px-2 py-1 text-sm text-black mt-2" />
          <input data-testid="fee-source" value={form.source_url} onChange={(e) => setForm((f) => ({ ...f, source_url: e.target.value }))}
            placeholder="Link to the school's own fee page (optional)"
            className="block w-full border border-gray-300 rounded px-2 py-1 text-sm text-black mt-2" />
          <div className="flex gap-2 mt-2">
            <button data-testid="fee-save" disabled={busy}
              onClick={() => act(() => setFees(supabase, school.id, open, form), `${levelLabel(open)} fees saved.`).then((ok) => { if (ok) { setOpen(null); loadFees(supabase, school.id).then(apply); } })}
              className={`${btn} bg-blue-600 text-white`}>Save fees</button>
            <button data-testid="fee-cancel" onClick={() => setOpen(null)} className={`${btn} bg-gray-200 text-gray-800`}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---- when the school day starts ------------------------------------------------------------------------------------
// The parent gives this a key of the saved time, so the box starts again from whatever was saved.
export function SchoolDaySection({ school, start, busy, act }) {
  const [time, setTime] = useState(String(start?.start_time ?? '').slice(0, 5));

  return (
    <section className="mb-6" data-testid="school-day-section">
      <h4 className="font-bold mb-2">Start of the school day</h4>
      <p data-testid="school-day-now" className="text-sm">{startTimeText(start ?? {})}</p>
      <p className="text-xs text-gray-600 mb-2">
        Parents use this to see when to leave home to be here on time, in traffic.
      </p>
      <div className="flex gap-2 items-center">
        <input data-testid="start-time" value={time} onChange={(e) => setTime(e.target.value)} placeholder="08:15"
          className="w-24 border border-gray-300 rounded px-2 py-1 text-sm text-black" />
        <button data-testid="start-time-save" disabled={busy || !time}
          onClick={() => act(() => setStartTime(supabase, school.id, time), `The school day starts at ${time}.`)}
          className={`${btn} bg-blue-600 text-white`}>Save</button>
        {!!start?.start_time && (
          <button data-testid="start-time-clear" disabled={busy}
            onClick={() => act(() => setStartTime(supabase, school.id, ''), 'Start of the school day removed.')}
            className={`${btn} bg-gray-200 text-gray-800`}>Not known</button>
        )}
      </div>
    </section>
  );
}

// ---- the school's own admissions system (Kidscover admins) ------------------------------------------------------------
export function CrmSection({ school, busy, act }) {
  const [crm, setCrm] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');

  const apply = useCallback((res) => {
    if (res.error) setError(friendlyError(res.error));
    else { setError(''); setCrm(res.crm); setDeliveries(res.deliveries); setUrl(res.crm?.url ?? ''); }
  }, []);
  useEffect(() => { loadCrm(supabase, school.id).then(apply); }, [school.id, apply]);
  const refresh = () => loadCrm(supabase, school.id).then(apply);

  return (
    <section className="mb-6" data-testid="crm-section">
      <h4 className="font-bold mb-2">The school&apos;s own admissions system</h4>
      <p className="text-sm text-gray-600 mb-2">
        Kidscover can pass every application straight into the school&apos;s own system as soon as a family sends it.
        Ask the school&apos;s IT for the https address to send to, then give them the signing secret shown once below,
        so they can prove each message really came from Kidscover.
      </p>
      {!!error && <p data-testid="crm-error" className="text-sm text-red-700 mb-2">{error}</p>}
      {!!secret && (
        <p data-testid="crm-secret" className="text-sm font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded p-3 mb-2">
          Signing secret (shown once; copy it to the school now): <span className="font-mono break-all">{secret}</span>
        </p>
      )}
      <div className="flex gap-2 mb-2">
        <input data-testid="crm-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://admissions.theschool.example/kidscover"
          className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm text-black" />
        <button data-testid="crm-save" disabled={busy}
          onClick={() => act(async () => { const r = await saveCrm(supabase, school.id, url, true); if (!r.error && r.secret) setSecret(r.secret); return r; }, 'Connected.').then((ok) => { if (ok) refresh(); })}
          className={`${btn} bg-blue-600 text-white`}>Connect</button>
      </div>
      {crm && (
        <>
          <p className="text-xs text-gray-600 mb-2">
            {crm.enabled ? 'Switched on.' : 'Switched off.'}
            {crm.last_success_at ? ` Last delivered ${when(crm.last_success_at)}.` : ' Nothing delivered yet.'}
            {crm.last_error ? ` Last problem: ${crm.last_error}` : ''}
          </p>
          <div className="flex flex-wrap gap-2 mb-2">
            <button data-testid="crm-test" disabled={busy}
              onClick={() => act(async () => { const r = await sendCrmTest(supabase, school.id); if (!r.error) await nudgeSender(supabase); return r; }, 'Test message sent.').then((ok) => { if (ok) refresh(); })}
              className={`${btn} bg-gray-200 text-gray-800`}>Send a test</button>
            <button data-testid="crm-rotate" disabled={busy}
              onClick={() => act(async () => { const r = await rotateCrmSecret(supabase, school.id); if (!r.error && r.secret) setSecret(r.secret); return r; }, 'New secret made. Give it to the school; the old one stops working now.')}
              className={`${btn} bg-gray-200 text-gray-800`}>New signing secret</button>
            <button data-testid="crm-remove" disabled={busy}
              onClick={() => act(() => removeCrm(supabase, school.id), 'Disconnected.').then((ok) => { if (ok) { setSecret(''); refresh(); } })}
              className={`${btn} bg-gray-200 text-gray-800`}>Disconnect</button>
          </div>
          <ul className="space-y-1" data-testid="crm-deliveries">
            {deliveries.slice(0, 8).map((d) => (
              <li key={d.id} className="text-xs text-gray-700 flex items-center gap-2">
                <span>{deliveryText(d)} &middot; {when(d.created_at)}</span>
                {d.status === 'failed' && (
                  <button data-testid={`crm-retry-${d.id}`} disabled={busy}
                    onClick={() => act(async () => { const r = await retryDelivery(supabase, d.id); if (!r.error) await nudgeSender(supabase); return r; }, 'Trying again now.').then((ok) => { if (ok) refresh(); })}
                    className={`${btn} bg-gray-200 text-gray-800 text-xs`}>Try again</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ---- how many families went on to the school's own pages ---------------------------------------------------------------
export function ClicksSection({ school }) {
  const [stats, setStats] = useState([]);
  const [error, setError] = useState('');
  const apply = useCallback((res) => { if (res.error) setError(friendlyError(res.error)); else { setError(''); setStats(res.stats); } }, []);
  useEffect(() => { loadClickStats(supabase, school.id, 30).then(apply); }, [school.id, apply]);

  return (
    <section className="mb-6" data-testid="clicks-section">
      <h4 className="font-bold mb-2">Families going on to your own pages</h4>
      {!!error && <p data-testid="clicks-error" className="text-sm text-red-700 mb-2">{error}</p>}
      {stats.length === 0 && !error && <p className="text-sm text-gray-600">Nobody in the last 30 days.</p>}
      <ul className="text-sm">
        {stats.map((s) => (
          <li key={s.kind} data-testid={`clicks-${s.kind}`}>
            {CLICK_KINDS[s.kind] ?? s.kind}: <span className="font-bold">{s.clicks}</span> times, by {s.people} {s.people === 1 ? 'family' : 'families'} (last 30 days)
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-500 mt-1">Counts only. Kidscover never tells a school which family looked.</p>
    </section>
  );
}
