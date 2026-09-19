'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/utils/supabase';
import {
  VIEWS, BATCH, SESSION_CAP, loadFindings, loadCounts, review, readBatch, defaultChoice, boardLabel, admissionLabel,
  confirmedCbse, progressLine, friendlyError, isConfirmed, levelLabel, levelsText, facilityHitLabel, achievementHitLabel,
} from './site-data-admin';

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function SiteDataPanel() {
  const [view, setView] = useState('pending');
  const [findings, setFindings] = useState([]);
  const [counts, setCounts] = useState({});
  const [choices, setChoices] = useState({});
  const [notes, setNotes] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [preview, setPreview] = useState(null);
  const stopRef = useRef(false);

  function applyList(res, counted) {
    if (res.error) { setError(friendlyError(res.error)); return; }
    setError('');
    setFindings(res.findings);
    setChoices(Object.fromEntries(res.findings.map((f) => [f.id, defaultChoice(f)])));
    if (counted) setCounts(counted);
  }

  useEffect(() => {
    Promise.all([loadFindings(supabase, 'pending'), loadCounts(supabase)]).then(([res, c]) => applyList(res, c));
  }, []);

  async function show(v) {
    setView(v);
    setNotice('');
    applyList(await loadFindings(supabase, v), await loadCounts(supabase));
  }

  async function decide(f, choice) {
    setBusyId(f.id);
    setError('');
    setNotice('');
    const res = await review(supabase, f, choice, notes[f.id]);
    setBusyId(null);
    if (res?.error) { setError(friendlyError(res.error)); return; }
    setNotice(res.data === 'rejected' ? `${f.school}: rejected. Nothing about the school changed.` : `${f.school}: saved. Parents now see it.`);
    applyList(await loadFindings(supabase, view), await loadCounts(supabase));
  }

  async function acceptConfirmed() {
    const list = confirmedCbse(findings);
    setError('');
    setNotice('');
    let done = 0;
    for (const f of list) {
      setBusyId(f.id);
      const res = await review(supabase, f, { boards: ['CBSE'], levels: [], facilities: [], achievements: [], admission: false }, 'Accepted in bulk: confirmed by the CBSE record');
      if (res?.error) { setError(`${f.school}: ${friendlyError(res.error)}`); break; }
      done++;
    }
    setBusyId(null);
    setNotice(`Accepted CBSE for ${done} ${done === 1 ? 'school' : 'schools'} confirmed by CBSE's record.`);
    applyList(await loadFindings(supabase, view), await loadCounts(supabase));
  }

  async function start() {
    stopRef.current = false;
    setRunning(true);
    setError('');
    setPreview(null);
    const total = { processed: 0, withFindings: 0, errors: 0, remaining: null };
    setProgress({ ...total });
    let failure = '';
    while (!stopRef.current && total.processed < SESSION_CAP) {
      const res = await readBatch(supabase, { limit: BATCH });
      if (!res.ok) { failure = res.error; break; }
      total.processed += res.processed;
      total.withFindings += res.withFindings;
      total.errors += res.errors;
      total.remaining = res.remaining;
      setProgress({ ...total });
      if (res.processed === 0 || res.remaining === 0) break;
    }
    setRunning(false);
    applyList(await loadFindings(supabase, view), await loadCounts(supabase));
    if (failure) setError(failure); // after the refresh, which would otherwise clear it
  }

  async function tryThree() {
    setError('');
    setPreview(null);
    setRunning(true);
    const res = await readBatch(supabase, { limit: 3, dryRun: true });
    setRunning(false);
    if (!res.ok) { setError(res.error); return; }
    setPreview(res.results ?? []);
  }

  const setChoice = (id, patch) => setChoices((c) => ({ ...c, [id]: { ...c[id], ...patch } }));
  const confirmedCount = confirmedCbse(findings).length;

  return (
    <div className="bg-white text-gray-900 border border-gray-200 rounded-xl shadow-sm p-6" data-testid="site-panel">
      <h2 className="text-lg font-bold text-gray-900 mb-1">School data from school websites</h2>
      <p className="text-sm text-gray-600 mb-4">
        Reads each school&apos;s own website for its board, its levels (preschool, primary, secondary, daycare), its facilities,
        the achievements it claims and whether admissions are open, and checks CBSE affiliation numbers against CBSE&apos;s public record. Nothing reaches parents
        until you accept it here.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-2">
        {!running ? (
          <>
            <button data-testid="site-start" onClick={start} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-blue-700">Read school websites</button>
            <button data-testid="site-try" onClick={tryThree} className="px-4 py-2 rounded-lg text-sm font-bold bg-gray-200 text-gray-800 hover:bg-gray-300">Try 3 without saving</button>
          </>
        ) : (
          <button data-testid="site-stop" onClick={() => { stopRef.current = true; }} className="bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-bold">Stop after this batch</button>
        )}
        <span className="text-xs text-gray-500">{BATCH} schools per batch; a run stops by itself after {SESSION_CAP}.</span>
      </div>
      {progress && <p data-testid="site-progress" className="text-sm text-gray-800 mb-3">{progressLine(progress)}</p>}
      {preview && (
        <div data-testid="site-preview" className="text-sm bg-gray-50 border border-gray-200 rounded p-3 mb-3">
          <p className="font-bold">Preview (nothing saved):</p>
          <ul className="list-disc ml-5">
            {preview.map((p) => <li key={p.school}>{p.school}: {p.boards.length ? p.boards.join(', ') : 'no board found'}; {p.levels?.length ? `levels ${p.levels.join(', ')}` : 'no levels found'}{p.facilities?.length ? `; facilities ${p.facilities.join(', ')}` : ''}{p.achievements?.length ? `; achievements ${p.achievements.join(', ')}` : ''}{p.admission ? `; admissions ${p.admission}` : ''}{p.error ? ` (${p.error})` : ''}</li>)}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {VIEWS.map((v) => (
          <button key={v.key} data-testid={`sview-${v.key}`} onClick={() => show(v.key)}
            className={`px-3 py-1.5 rounded-lg font-bold text-sm ${view === v.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
            {v.label} ({counts[v.key] ?? 0})
          </button>
        ))}
        {view === 'pending' && confirmedCount > 0 && (
          <button data-testid="site-accept-confirmed" onClick={acceptConfirmed} disabled={!!busyId} className="px-3 py-1.5 rounded-lg font-bold text-sm bg-green-600 text-white disabled:opacity-50">
            Accept CBSE for all {confirmedCount} confirmed by CBSE&apos;s record
          </button>
        )}
      </div>

      {error && <p data-testid="site-error" className="text-sm font-bold text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3">{error}</p>}
      {notice && <p data-testid="site-notice" className="text-sm font-bold text-green-700 bg-green-50 border border-green-200 rounded p-3 mb-3">{notice}</p>}
      {findings.length === 0 && !error && <p data-testid="site-empty" className="text-sm text-gray-500 italic">Nothing here.</p>}

      <div className="space-y-4">
        {findings.map((f) => {
          const c = choices[f.id] ?? { boards: [], levels: [], admission: false };
          const picked = c.levels ?? [];
          const pickedFac = c.facilities ?? [];
          const pickedAch = c.achievements ?? [];
          return (
            <div key={f.id} data-testid={`finding-${f.id}`} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
              <div className="flex justify-between gap-3">
                <div>
                  <p className="font-bold text-gray-900">{f.school}</p>
                  {f.website && <a className="text-xs text-blue-700 underline break-all" href={/^https?:/i.test(f.website) ? f.website : `https://${f.website}`} target="_blank" rel="noreferrer noopener">{f.website}</a>}
                  <p className="text-xs text-gray-500">Board now: {f.currentBoard || 'not known'}. Levels now: {levelsText(f.currentLevels)}. Read {when(f.checkedAt)}.</p>
                </div>
                {f.status !== 'pending' && <span className="text-xs uppercase font-bold px-2 py-0.5 rounded bg-gray-200 text-gray-700 h-fit">{f.status.replace('_', ' ')}</span>}
              </div>
              {f.error && <p className="text-xs text-amber-800 mt-1">Could not read: {f.error}</p>}

              {f.boards.map((b) => (
                <div key={b.board} className="mt-2 text-sm">
                  <label className="flex items-start gap-2">
                    {f.status === 'pending' && (
                      <input type="checkbox" data-testid={`pick-${f.id}-${b.board}`} checked={c.boards.includes(b.board)}
                        onChange={(e) => setChoice(f.id, { boards: e.target.checked ? [...c.boards, b.board] : c.boards.filter((x) => x !== b.board) })} />
                    )}
                    <span className={isConfirmed(b) ? 'font-bold text-green-800' : ''}>{boardLabel(b)}</span>
                  </label>
                  {b.evidence && <p className="text-xs text-gray-700 ml-6 italic">&ldquo;{b.evidence}&rdquo; {b.url && <a className="underline" href={b.url} target="_blank" rel="noreferrer noopener">source</a>}</p>}
                  {b.verified?.record && <p className="text-xs ml-6"><a className="underline text-blue-700" href={b.verified.record} target="_blank" rel="noreferrer noopener">CBSE record {b.affiliationNo}</a>{b.verified.name ? `: ${b.verified.name}, ${b.verified.district ?? ''} ${b.verified.pin ?? ''}` : ''}</p>}
                </div>
              ))}

              {f.levels.map((l) => (
                <div key={l.level} className="mt-2 text-sm">
                  <label className="flex items-start gap-2">
                    {f.status === 'pending' && (
                      <input type="checkbox" data-testid={`pick-${f.id}-level-${l.level}`} checked={picked.includes(l.level)}
                        onChange={(e) => setChoice(f.id, { levels: e.target.checked ? [...picked, l.level] : picked.filter((x) => x !== l.level) })} />
                    )}
                    <span>{levelLabel(l)}</span>
                  </label>
                  {l.evidence && <p className="text-xs text-gray-700 ml-6 italic">&ldquo;{l.evidence}&rdquo; {l.url && <a className="underline" href={l.url} target="_blank" rel="noreferrer noopener">source</a>}</p>}
                </div>
              ))}

              {f.facilities.length > 0 && <p className="mt-3 text-xs font-bold uppercase text-gray-500">Facilities</p>}
              {f.facilities.map((x) => (
                <div key={x.facility} className="mt-1 text-sm">
                  <label className="flex items-start gap-2">
                    {f.status === 'pending' && (
                      <input type="checkbox" data-testid={`pick-${f.id}-fac-${x.facility}`} checked={pickedFac.includes(x.facility)}
                        onChange={(e) => setChoice(f.id, { facilities: e.target.checked ? [...pickedFac, x.facility] : pickedFac.filter((k) => k !== x.facility) })} />
                    )}
                    <span>{facilityHitLabel(x)}</span>
                  </label>
                  {x.evidence && <p className="text-xs text-gray-700 ml-6 italic">&ldquo;{x.evidence}&rdquo; {x.url && <a className="underline" href={x.url} target="_blank" rel="noreferrer noopener">source</a>}</p>}
                </div>
              ))}

              {f.achievements.length > 0 && <p className="mt-3 text-xs font-bold uppercase text-gray-500">Achievements the school claims</p>}
              {f.achievements.map((a, i) => (
                <div key={i} className="mt-1 text-sm">
                  <label className="flex items-start gap-2">
                    {f.status === 'pending' && (
                      <input type="checkbox" data-testid={`pick-${f.id}-ach-${i}`} checked={pickedAch.includes(i)}
                        onChange={(e) => setChoice(f.id, { achievements: e.target.checked ? [...pickedAch, i] : pickedAch.filter((k) => k !== i) })} />
                    )}
                    <span>{achievementHitLabel(a)}</span>
                  </label>
                  {a.url && <p className="text-xs ml-6"><a className="underline text-blue-700" href={a.url} target="_blank" rel="noreferrer noopener">Check it on the school&apos;s page</a></p>}
                </div>
              ))}

              {f.admission && (
                <div className="mt-2 text-sm">
                  <label className="flex items-start gap-2">
                    {f.status === 'pending' && !f.admission.stale && (
                      <input type="checkbox" data-testid={`pick-${f.id}-admission`} checked={!!c.admission} onChange={(e) => setChoice(f.id, { admission: e.target.checked })} />
                    )}
                    <span className={f.admission.stale ? 'text-gray-500 line-through' : ''}>{admissionLabel(f.admission)}</span>
                  </label>
                  <p className="text-xs text-gray-700 ml-6 italic">&ldquo;{f.admission.evidence}&rdquo; {f.admission.url && <a className="underline" href={f.admission.url} target="_blank" rel="noreferrer noopener">source</a>}</p>
                </div>
              )}

              {f.status === 'pending' && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input data-testid={`note-${f.id}`} value={notes[f.id] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [f.id]: e.target.value }))}
                    placeholder="Note (optional)" className="border border-gray-300 rounded px-2 py-1 text-sm text-black" />
                  <button data-testid={`save-${f.id}`} onClick={() => decide(f, c)} disabled={busyId === f.id}
                    className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm font-bold disabled:opacity-50">
                    {c.boards.length || picked.length || pickedFac.length || pickedAch.length || c.admission ? 'Accept what is ticked' : 'Reject (nothing ticked)'}
                  </button>
                  <button data-testid={`reject-${f.id}`} onClick={() => decide(f, { boards: [], levels: [], facilities: [], achievements: [], admission: false })} disabled={busyId === f.id}
                    className="px-3 py-1.5 rounded text-sm font-bold bg-gray-200 text-gray-800 disabled:opacity-50">Reject all</button>
                </div>
              )}
              {f.status !== 'pending' && f.note && <p className="text-xs text-gray-600 mt-2">Note: {f.note}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
