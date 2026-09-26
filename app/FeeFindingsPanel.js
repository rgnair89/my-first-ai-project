'use client';

// Fees read off school websites, waiting for somebody to agree with them.
//
// The crawler never writes a fee. It writes down what it saw, with the row it read and the page it read it on, and
// this is where a person turns that into a fee - or sets it aside. Nine numbers become one press, and the row the
// number came from is always on screen next to it, so nobody has to take a machine's word for anything.

import { useEffect, useState } from 'react';
import { supabase } from '@/utils/supabase';
import {
  LEVELS, PARTS, loadWaitingSchools, loadFindings, groupByLevel, draftFromFindings, whyNotYet,
  acceptFindings, rejectFindings, readMoreWebsites, crawlSummary, crawlNeedsAttention, rupees, levelLabel,
  loadOutcomes, outcomeTally, outcomeLabel, whatTheNumbersSay,
} from './fee-findings-admin';

export default function FeeFindingsPanel() {
  const [schools, setSchools] = useState([]);
  const [chosen, setChosen] = useState(null);      // the school being looked at
  const [findings, setFindings] = useState([]);
  const [drafts, setDrafts] = useState({});        // level (or 'none') -> the fee being corrected
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [lastRun, setLastRun] = useState([]);       // what the last press turned up, school by school
  const [tally, setTally] = useState([]);           // and how every school read so far divides up
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => { refresh(); }, []);

  async function refresh() {
    loadOutcomes(supabase).then((got) => { if (!got.error) setTally(got.rows); });
    const res = await loadWaitingSchools(supabase);
    setLoading(false);
    if (res.error) { setError(`Could not load the queue: ${res.error.message}`); return; }
    setError('');
    setSchools(res.rows);
  }

  async function open(school) {
    setChosen(school);
    setNotice('');
    setError('');
    const res = await loadFindings(supabase, school.school_id);
    if (res.error) { setError(res.error.message); return; }
    setFindings(res.rows);
    const next = {};
    for (const group of groupByLevel(res.rows)) next[group.level ?? 'none'] = { ...draftFromFindings(group.rows), level: group.level ?? '' };
    setDrafts(next);
  }

  function edit(key, field, value) {
    setDrafts((now) => ({ ...now, [key]: { ...(now[key] ?? {}), [field]: value } }));
  }

  async function accept(group) {
    const key = group.level ?? 'none';
    const draft = drafts[key] ?? {};
    const level = group.level ?? draft.level;
    setBusy(key);
    setError('');
    setNotice('');
    const res = await acceptFindings(supabase, group.rows.map((r) => r.id), level, draft);
    setBusy('');
    if (res.error) { setError(res.error.message); return; }
    setNotice(`Saved the ${levelLabel(level).toLowerCase()} fees for ${chosen.school_name}. Parents will see them, with a link to the page they came from.`);
    await open(chosen);
    await refresh();
  }

  async function setAside(group) {
    const key = group.level ?? 'none';
    setBusy(key);
    setError('');
    const res = await rejectFindings(supabase, group.rows.map((r) => r.id));
    setBusy('');
    if (res.error) { setError(res.error.message); return; }
    setNotice('Set aside. The crawler will not offer those lines again.');
    await open(chosen);
    await refresh();
  }

  async function readMore() {
    setBusy('crawl');
    setError('');
    setNotice('');
    const res = await readMoreWebsites(supabase, { limit: 8 });
    setBusy('');
    if (res.error) { setError(res.error.message); return; }
    // A run that needs somebody to do something is not good news, and is not shown as good news.
    if (crawlNeedsAttention(res.result)) setError(crawlSummary(res.result));
    else setNotice(crawlSummary(res.result));
    setLastRun(res.result?.details ?? []);
    await refresh();
  }

  const groups = groupByLevel(findings);
  const counted = outcomeTally(tally);

  return (
    <div className="bg-white text-gray-900 border border-gray-200 rounded-xl shadow-sm p-6" data-testid="fee-findings-panel">
      <h2 className="text-lg font-bold text-gray-900 mb-1">Fees found on school websites</h2>
      <p className="text-sm text-gray-600 mb-4">
        Nothing here is a fee yet. The crawler reads a school&apos;s fee page and writes down what it saw; a fee only
        reaches a parent when you agree with it. Every line shows the row it came from and links to the page.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <button
          data-testid="crawl-more"
          onClick={readMore}
          disabled={busy === 'crawl'}
          className="px-3 py-1.5 rounded-lg font-bold text-sm bg-blue-600 text-white disabled:opacity-50"
        >
          {busy === 'crawl' ? 'Reading websites...' : 'Read 8 more websites'}
        </button>
        <span className="text-sm text-gray-500">
          {schools.length === 0 ? 'No school is waiting.' : `${schools.length} school${schools.length === 1 ? '' : 's'} waiting.`}
        </span>
      </div>

      {/* What is on school websites, counted. This is the question the crawler is really answering. */}
      {counted.total > 0 && (
        <div className="mb-4 border border-gray-200 rounded-lg p-3 bg-gray-50" data-testid="fee-outcomes">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">
            Where the fees are, across {counted.total} school{counted.total === 1 ? '' : 's'} read
          </p>
          <div className="space-y-1">
            {counted.rows.map((row) => (
              <div key={row.key} data-testid={`outcome-${row.key}`} className="flex items-center gap-2 text-sm">
                <span className="w-56 shrink-0 text-gray-700">{row.label}</span>
                <span className="h-2 rounded bg-blue-600" style={{ width: `${Math.max(row.share, 1) * 2}px` }} />
                <span className="font-bold text-gray-900 tabular-nums">{row.schools}</span>
                <span className="text-gray-500">({row.share}%)</span>
              </div>
            ))}
          </div>
          <p className="text-sm text-gray-800 mt-2 font-semibold" data-testid="fee-verdict">{whatTheNumbersSay(tally)}</p>
        </div>
      )}

      {error && <p data-testid="fee-findings-error" className="text-sm font-bold text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3">{error}</p>}
      {notice && <p data-testid="fee-findings-notice" className="text-sm font-bold text-green-700 bg-green-50 border border-green-200 rounded p-3 mb-3">{notice}</p>}
      {loading && <p className="text-sm text-gray-500">Loading...</p>}

      {/* The last press, school by school, so nothing has to be taken on trust. */}
      {lastRun.length > 0 && (
        <details className="mb-4 border border-gray-200 rounded-lg bg-white" data-testid="fee-last-run">
          <summary className="cursor-pointer px-3 py-2 text-sm font-bold text-gray-700">
            What the last {lastRun.length} website{lastRun.length === 1 ? '' : 's'} turned up
          </summary>
          <div className="px-3 pb-3 overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                {lastRun.map((r, i) => (
                  <tr key={`${r.school}-${i}`} data-testid={`last-run-${i}`} className="border-t border-gray-100">
                    <td className="py-1 pr-3 font-semibold text-gray-900 align-top">{r.school}</td>
                    <td className="py-1 pr-3 whitespace-nowrap text-gray-700 align-top">{outcomeLabel(r.outcome)}</td>
                    <td className="py-1 pr-3 text-gray-500 align-top">{r.status}</td>
                    <td className="py-1 align-top">
                      {r.pdf && <a href={r.pdf} target="_blank" rel="noreferrer" className="text-blue-700 font-bold hover:underline">PDF</a>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className="grid md:grid-cols-[18rem_1fr] gap-6">
        {/* the queue */}
        <div className="space-y-1 max-h-[32rem] overflow-y-auto pr-1" data-testid="fee-findings-queue">
          {!loading && schools.length === 0 && (
            <p className="text-sm text-gray-500 italic">
              Nothing is waiting. Press &ldquo;Read 8 more websites&rdquo; to look at the schools nobody has read yet.
            </p>
          )}
          {schools.map((s) => (
            <button
              key={s.school_id}
              data-testid={`fee-school-${s.school_id}`}
              onClick={() => open(s)}
              className={`w-full text-left px-3 py-2 rounded-lg border ${chosen?.school_id === s.school_id
                ? 'border-blue-600 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
            >
              <span className="block font-bold text-sm text-gray-900">{s.school_name}</span>
              <span className="block text-xs text-gray-500">{s.address}</span>
              <span className="block text-xs text-gray-600 mt-0.5">
                {s.findings} line{Number(s.findings) === 1 ? '' : 's'}
                {Number(s.confident) > 0 && <span className="text-green-700 font-bold"> · {s.confident} worth a look</span>}
              </span>
            </button>
          ))}
        </div>

        {/* what was read about the one school */}
        <div className="space-y-5">
          {!chosen && <p className="text-sm text-gray-500 italic">Choose a school to see what was read from its website.</p>}

          {chosen && groups.length === 0 && (
            <p className="text-sm text-gray-500 italic" data-testid="fee-nothing-left">
              Nothing is left waiting for {chosen.school_name}.
            </p>
          )}

          {chosen && groups.map((group) => {
            const key = group.level ?? 'none';
            const draft = drafts[key] ?? {};
            const level = group.level ?? draft.level;
            const stops = whyNotYet(level, draft);
            return (
              <div key={key} data-testid={`fee-group-${key}`} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                <div className="flex flex-wrap justify-between items-baseline gap-2 mb-2">
                  <h3 className="font-bold text-gray-900">{group.label}</h3>
                  <span className="text-xs text-gray-500">
                    {group.rows.length} line{group.rows.length === 1 ? '' : 's'} read
                    {group.confident > 0 && <span className="text-green-700 font-bold"> · {group.confident} named a class and a charge</span>}
                  </span>
                </div>

                {/* what the page actually said */}
                <div className="bg-white border border-gray-200 rounded p-3 mb-3 max-h-56 overflow-y-auto">
                  <table className="w-full text-xs">
                    <tbody>
                      {group.rows.map((r) => (
                        <tr key={r.id} data-testid={`fee-line-${r.id}`} className="border-b border-gray-100 last:border-0">
                          <td className="py-1 pr-2 text-gray-500">{r.confidence === 'high' ? '✓' : '?'}</td>
                          <td className="py-1 pr-2 font-mono text-gray-800">{r.evidence}</td>
                          <td className="py-1 pr-2 whitespace-nowrap text-gray-600">
                            {r.component === 'unknown' ? 'not sure what for' : (PARTS.find((p) => p.key === r.component)?.label ?? r.component)}
                          </td>
                          <td className="py-1 text-right font-bold whitespace-nowrap text-gray-900">{rupees(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <a href={group.rows[0]?.source_url} target="_blank" rel="noreferrer"
                    data-testid={`fee-source-${key}`} className="text-xs text-blue-700 font-bold hover:underline mt-2 inline-block">
                    Open the page it was read from
                  </a>
                </div>

                {/* the fee it suggests, for a person to correct */}
                {!group.level && (
                  <label className="block text-xs font-bold text-gray-700 mb-2">
                    Which classes are these for?
                    <select
                      data-testid={`fee-level-${key}`}
                      value={draft.level ?? ''}
                      onChange={(e) => edit(key, 'level', e.target.value)}
                      className="block mt-1 border border-gray-300 rounded px-2 py-1 text-sm font-normal"
                    >
                      <option value="">Choose...</option>
                      {LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
                    </select>
                  </label>
                )}

                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
                  {PARTS.map((part) => (
                    <label key={part.key} className="block text-xs font-bold text-gray-700">
                      {part.label}{part.required && <span className="text-red-600"> *</span>}
                      <input
                        data-testid={`fee-${key}-${part.key}`}
                        type="number"
                        min="0"
                        value={draft[part.key] ?? ''}
                        onChange={(e) => edit(key, part.key, e.target.value)}
                        className="block w-full mt-0.5 border border-gray-300 rounded px-2 py-1 text-sm font-normal"
                      />
                    </label>
                  ))}
                  <label className="block text-xs font-bold text-gray-700">
                    Academic year
                    <input
                      data-testid={`fee-${key}-year`}
                      value={draft.academic_year ?? ''}
                      onChange={(e) => edit(key, 'academic_year', e.target.value)}
                      placeholder="2026-27"
                      className="block w-full mt-0.5 border border-gray-300 rounded px-2 py-1 text-sm font-normal"
                    />
                  </label>
                </div>

                {stops && <p data-testid={`fee-stops-${key}`} className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 mb-2">{stops}</p>}

                <div className="flex flex-wrap gap-2">
                  <button
                    data-testid={`fee-accept-${key}`}
                    onClick={() => accept(group)}
                    disabled={!!stops || busy === key}
                    className="px-3 py-1.5 rounded-lg font-bold text-sm bg-green-700 text-white disabled:opacity-40"
                  >
                    {busy === key ? 'Saving...' : 'These are the fees'}
                  </button>
                  <button
                    data-testid={`fee-reject-${key}`}
                    onClick={() => setAside(group)}
                    disabled={busy === key}
                    className="px-3 py-1.5 rounded-lg font-bold text-sm bg-gray-200 text-gray-800 disabled:opacity-40"
                  >
                    Set these lines aside
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
