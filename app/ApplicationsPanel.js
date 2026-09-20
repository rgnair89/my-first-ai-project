'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/utils/supabase';
import {
  STAGES, CHOOSABLE_STAGES, stageLabel, stageTone, countByStage, inStage, ageAtStart, whoDid, friendlyError,
  loadApplications, loadApplicationEvents, setStage, loadCrm, deliveryText, retryDelivery, nudgeSender,
} from './applications-admin';

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const TONE = {
  blue: 'bg-blue-100 text-blue-800', green: 'bg-green-100 text-green-800', amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800', grey: 'bg-gray-200 text-gray-700',
};
const btn = 'px-3 py-1.5 rounded text-sm font-bold disabled:opacity-50';

// mode 'admin': every school. mode 'staff': only the schools this person looks after (schoolIds).
export default function ApplicationsPanel({ mode = 'admin', schoolIds = null, onChanged }) {
  const isAdmin = mode === 'admin';
  const [apps, setApps] = useState([]);
  const [view, setView] = useState('open');
  const [openId, setOpenId] = useState(null);
  const [events, setEvents] = useState([]);
  const [crm, setCrm] = useState({ crm: null, deliveries: [] });
  const [stage, setStageChoice] = useState('in_review');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const apply = useCallback((res) => {
    if (res.error) setError(friendlyError(res.error));
    else {
      setError('');
      setApps(schoolIds ? res.applications.filter((a) => schoolIds.includes(a.schoolId)) : res.applications);
    }
    setLoading(false);
    onChanged?.();
  }, [schoolIds, onChanged]);
  const load = useCallback(() => loadApplications(supabase, {}).then(apply), [apply]);
  useEffect(() => { loadApplications(supabase, {}).then(apply); }, [apply]);

  const open = apps.find((a) => a.id === openId) ?? null;

  useEffect(() => {
    if (!open) return;
    loadApplicationEvents(supabase, open.id).then((r) => setEvents(r.events));
    loadCrm(supabase, open.schoolId).then((r) => setCrm({ crm: r.crm, deliveries: (r.deliveries ?? []).filter((d) => d.application_id === open.id) }));
  }, [openId, open]);

  async function move() {
    setBusy(true); setError(''); setNotice('');
    const res = await setStage(supabase, open.id, stage, note);
    setBusy(false);
    if (res.error) { setError(friendlyError(res.error)); return; }
    setNote('');
    setNotice(`The family has been told: ${stageLabel(stage)}.`);
    await nudgeSender(supabase, 'send-push');
    await load();
    const again = await loadApplicationEvents(supabase, open.id);
    setEvents(again.events);
  }

  const counts = countByStage(apps);
  const shown = apps.filter((a) => inStage(a, view));

  return (
    <div className="bg-white text-gray-900 border border-gray-200 rounded-xl shadow-sm p-6" data-testid="applications-panel">
      <h2 className="text-lg font-bold mb-1">Admission applications</h2>
      <p className="text-sm text-gray-600 mb-4">
        The Kidscover Standard form, filled in by a family for one child and one school. They agreed to share these
        details with {isAdmin ? 'the school they applied to' : 'you'}. Please keep them to the admissions team.
      </p>
      {error && <p data-testid="applications-error" className="text-sm font-bold text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3">{error}</p>}
      {notice && <p data-testid="applications-notice" className="text-sm font-bold text-green-700 bg-green-50 border border-green-200 rounded p-3 mb-3">{notice}</p>}

      <div className="flex flex-wrap gap-2 mb-4">
        {[{ key: 'open', label: 'Open' }, ...STAGES, { key: 'all', label: 'All' }].map((s) => (
          <button key={s.key} data-testid={`apps-view-${s.key}`} onClick={() => { setView(s.key); setOpenId(null); }}
            className={`px-3 py-1.5 rounded-lg text-sm font-bold ${view === s.key ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}>
            {s.label} ({counts[s.key] ?? 0})
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-gray-500">Loading...</p>}
      {!loading && shown.length === 0 && <p data-testid="apps-empty" className="text-sm text-gray-600">No applications here yet.</p>}

      <ul className="space-y-2">
        {shown.map((a) => (
          <li key={a.id} data-testid={`app-${a.id}`} className="border border-gray-100 rounded-lg">
            <button onClick={() => { setOpenId(openId === a.id ? null : a.id); setNotice(''); setError(''); setStageChoice('in_review'); }}
              data-testid={`app-open-${a.id}`} className="w-full text-left p-3 hover:bg-gray-50">
              <span className={`text-xs font-bold px-2 py-0.5 rounded ${TONE[stageTone(a.status)]}`}>{stageLabel(a.status)}</span>
              <span className="font-bold ml-2">{a.childName}</span>
              <span className="text-gray-600"> {a.className}, {a.year}</span>
              {isAdmin && <span className="text-gray-500"> | {a.schoolName}</span>}
              <span className="block text-xs text-gray-500">Applied {day(a.createdAt)} by {a.parentName} ({a.relation})</span>
            </button>

            {openId === a.id && (
              <div className="border-t border-gray-100 p-3 text-sm" data-testid={`app-detail-${a.id}`}>
                <div className="grid md:grid-cols-2 gap-x-6 gap-y-1 mb-3">
                  <p><span className="text-gray-500">Child:</span> <span className="font-bold">{a.childName}</span>{a.gender ? `, ${a.gender}` : ''}</p>
                  <p><span className="text-gray-500">Date of birth:</span> {day(a.dob)}{ageAtStart(a.dob, a.year) !== null ? ` (${ageAtStart(a.dob, a.year)} in June ${String(a.year).slice(0, 4)})` : ''}</p>
                  <p><span className="text-gray-500">Applying for:</span> {a.className}, {a.year}</p>
                  <p><span className="text-gray-500">Now at:</span> {a.currentSchool || 'not said'}</p>
                  <p><span className="text-gray-500">Parent:</span> {a.parentName} ({a.relation})</p>
                  <p><span className="text-gray-500">Phone:</span> <a className="underline" href={`tel:${a.phone}`}>{a.phone}</a></p>
                  <p><span className="text-gray-500">Email:</span> <a className="underline" href={`mailto:${a.email}`}>{a.email}</a></p>
                  <p><span className="text-gray-500">Address:</span> {a.address}, {a.pincode}</p>
                </div>
                {!!a.notes && <p className="mb-3"><span className="text-gray-500">The family added:</span> {a.notes}</p>}
                <p className="text-xs text-gray-500 mb-3">Shared with the school by the family on {when(a.consentAt)}.</p>

                <h4 className="font-bold mb-1">What has happened</h4>
                <ul className="mb-3 space-y-1" data-testid={`app-events-${a.id}`}>
                  {events.map((e) => (
                    <li key={e.id} className="text-xs text-gray-700">
                      {stageLabel(e.status)} &middot; {when(e.at)} &middot; by {whoDid(e.by_role)}{e.note ? ` — "${e.note}"` : ''}
                    </li>
                  ))}
                </ul>

                {a.status === 'withdrawn' ? (
                  <p className="text-sm text-gray-600">The family withdrew this application.</p>
                ) : (
                  <div className="bg-gray-50 border border-gray-200 rounded p-3 grid gap-2">
                    <p className="font-bold">Move it on, and tell the family</p>
                    <select data-testid="app-stage" value={stage} onChange={(e) => setStageChoice(e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-sm text-black">
                      {CHOOSABLE_STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                    <textarea data-testid="app-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500}
                      placeholder="A line for the family (optional), e.g. please come on Monday at 10 am"
                      className="border border-gray-300 rounded px-2 py-1 text-sm text-black" />
                    <div>
                      <button data-testid="app-save-stage" disabled={busy} onClick={move} className={`${btn} bg-blue-600 text-white`}>Save and tell the family</button>
                    </div>
                  </div>
                )}

                {crm.crm && (
                  <div className="mt-3" data-testid={`app-crm-${a.id}`}>
                    <h4 className="font-bold mb-1">Sent to the school&apos;s own system</h4>
                    {crm.deliveries.length === 0 && <p className="text-xs text-gray-600">Nothing sent for this application yet.</p>}
                    <ul className="space-y-1">
                      {crm.deliveries.map((d) => (
                        <li key={d.id} className="text-xs text-gray-700 flex items-center gap-2">
                          <span>{deliveryText(d)} &middot; {when(d.created_at)}</span>
                          {d.status === 'failed' && (
                            <button data-testid={`retry-${d.id}`} disabled={busy}
                              onClick={async () => { setBusy(true); const r = await retryDelivery(supabase, d.id); await nudgeSender(supabase); setBusy(false); if (r.error) setError(friendlyError(r.error)); else { setNotice('Trying again now.'); const c = await loadCrm(supabase, a.schoolId); setCrm({ crm: c.crm, deliveries: (c.deliveries ?? []).filter((x) => x.application_id === a.id) }); } }}
                              className={`${btn} bg-gray-200 text-gray-800 text-xs`}>Try again</button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
