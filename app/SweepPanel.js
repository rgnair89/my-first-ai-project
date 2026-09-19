'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/utils/supabase';
import {
  buildGrid, testCells, runSweep, emptyTotals, mergeTotals, serializeState, restoreState,
  makeLock, lockedByOtherTab, MAX_REQUESTS, BUDGET_TOP_UP,
} from './sweep';

const STATE_KEY = 'kidscover.sweep.v1'; // unfinished sweep, so a refresh resumes instead of starting over
const LOCK_KEY = 'kidscover.sweep.lock'; // set by the tab that is running, so a second tab cannot start another

// Browser storage can be blocked or full. The sweep still works without it; it just cannot resume after a refresh.
function readStore(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStore(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* ignore */ }
}

// supabase-js sends the signed-in admin's session; the function checks the admin role itself.
async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('ingest-mumbai-schools', { body });
  if (!error) return { data, error: null };
  const detail = error.context?.text ? await error.context.text().catch(() => '') : '';
  return { data: null, error: { message: `${error.message}${detail ? ` - ${detail}` : ''}` } };
}

const toRequestCell = ({ id, low, high }) => ({ id, low, high });

export default function SweepPanel() {
  // Read once, on the first render. This panel only appears after sign-in, so it never renders on the server.
  const [saved] = useState(() => restoreState(readStore(STATE_KEY)));
  const queue = useRef(saved?.queue ?? []); // cells still to search
  const done = useRef(saved?.done ?? emptyTotals()); // totals from earlier runs of this sweep
  const budget = useRef(saved?.budget ?? MAX_REQUESTS); // Google requests this sweep may use in total
  const stopRequested = useRef(false);
  const tabId = useRef(null);
  const [limit, setLimit] = useState(saved?.budget ?? MAX_REQUESTS); // same number as the budget ref, for the screen
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(saved && saved.done.cells > 0 ? saved.done : null);
  const [left, setLeft] = useState(saved?.queue.length ?? 0);
  const [restored, setRestored] = useState(Boolean(saved && saved.queue.length > 0));
  const [blocked, setBlocked] = useState(false);
  const [trialResult, setTrialResult] = useState('');

  useEffect(() => {
    tabId.current = globalThis.crypto?.randomUUID?.() ?? String(Math.random());
  }, []);

  // While a sweep is running: ask before the page is closed or refreshed, and give up the lock when it goes away
  // so the refreshed page can resume straight away. (If the browser crashes instead, the lock expires by itself.)
  useEffect(() => {
    if (!running) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    const release = () => {
      try {
        if (JSON.parse(readStore(LOCK_KEY) ?? 'null')?.id === tabId.current) writeStore(LOCK_KEY, null);
      } catch { /* ignore */ }
    };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('pagehide', release);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('pagehide', release);
    };
  }, [running]);

  // Called before every batch: tells other tabs that a sweep is running here.
  async function invokeBatch(body) {
    writeStore(LOCK_KEY, makeLock(tabId.current));
    return invoke(body);
  }

  async function trial() {
    setRunning(true);
    setTrialResult('');
    const { data, error } = await invoke({ dryRun: true, cells: testCells().map(toRequestCell) });
    setTrialResult(error ? `Error: ${error.message}` : JSON.stringify(data, null, 2));
    setRunning(false);
  }

  async function sweep() {
    if (lockedByOtherTab(readStore(LOCK_KEY), tabId.current)) {
      setBlocked(true);
      return;
    }
    setBlocked(false);

    const fresh = queue.current.length === 0;
    if (
      fresh &&
      !window.confirm(
        `This starts the full grid sweep of Mumbai, Thane and Navi Mumbai.\n\n` +
          `Expect roughly 800-1,500 Google Places requests (about $30-55 at Google's list price, and 10-20 minutes). ` +
          `It stops by itself at ${MAX_REQUESTS} requests (about $70). If the page is refreshed it resumes where it left off.\n\nContinue?`,
      )
    ) {
      return;
    }
    if (!fresh && done.current.stopped?.includes('budget')) {
      if (!window.confirm(`The sweep stopped at its limit of ${budget.current} Google requests.\n\nAllow ${BUDGET_TOP_UP} more (about $${Math.round(BUDGET_TOP_UP * 0.035)})?`)) return;
      budget.current += BUDGET_TOP_UP;
      setLimit(budget.current);
    }
    if (fresh) {
      queue.current = buildGrid();
      done.current = emptyTotals();
      budget.current = MAX_REQUESTS;
      setLimit(MAX_REQUESTS);
      setProgress(null);
    }
    setRestored(false);
    stopRequested.current = false;
    setRunning(true);
    writeStore(STATE_KEY, serializeState({ queue: queue.current, done: done.current, budget: budget.current }));

    const result = await runSweep({
      queue: queue.current,
      invoke: invokeBatch,
      dryRun: false,
      maxRequests: budget.current - done.current.requests,
      budgetLabel: budget.current,
      shouldStop: () => stopRequested.current,
      onProgress: (p) => {
        const merged = mergeTotals(done.current, p);
        setProgress(merged);
        setLeft(p.queued);
        writeStore(STATE_KEY, serializeState({ queue: queue.current, done: merged, budget: budget.current }));
      },
    });

    done.current = mergeTotals(done.current, result);
    setProgress(done.current);
    setLeft(result.queued);
    writeStore(STATE_KEY, queue.current.length ? serializeState({ queue: queue.current, done: done.current, budget: budget.current }) : null);
    writeStore(LOCK_KEY, null);
    setRunning(false);
  }

  function startOver() {
    queue.current = [];
    done.current = emptyTotals();
    writeStore(STATE_KEY, null);
    setProgress(null);
    setLeft(0);
    setRestored(false);
    setBlocked(false);
  }

  const pct = progress && progress.cells + left > 0 ? Math.round((progress.cells / (progress.cells + left)) * 100) : 0;
  const finished = progress && !running && left === 0 && !progress.stopped;

  return (
    <div className="bg-white text-gray-900 border border-gray-200 p-6 rounded-xl shadow-sm mb-8">
      <h2 className="text-lg font-bold text-gray-900 mb-2">Mumbai School Data Pipeline</h2>
      <p className="text-sm text-gray-600 mb-4">
        Searches Mumbai, Thane and Navi Mumbai on Google Places in small map cells, adds new schools and links existing ones.
        Try the trial first: it searches {testCells().length} cells in Bandra-Andheri and writes nothing.
      </p>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={trial}
          disabled={running}
          className="bg-white border border-blue-600 text-blue-600 px-4 py-2 rounded-lg font-bold text-sm hover:bg-blue-50 disabled:opacity-50"
        >
          Trial: {testCells().length} cells, no changes
        </button>
        <button
          onClick={sweep}
          disabled={running}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg font-bold text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {running ? 'Sweeping...' : left > 0 ? `Resume sweep (${left} cells left)` : 'Run full sweep'}
        </button>
        {running && (
          <button
            onClick={() => { stopRequested.current = true; }}
            className="bg-white border border-gray-400 text-gray-700 px-4 py-2 rounded-lg font-bold text-sm hover:bg-gray-50"
          >
            Stop after this batch
          </button>
        )}
        {!running && left > 0 && (
          <button onClick={startOver} className="text-sm text-gray-500 font-bold hover:text-black px-2">
            Start over
          </button>
        )}
      </div>

      {blocked && (
        <p className="mt-3 text-sm font-bold text-amber-700">
          A sweep is already running in another tab or window. Use that one. If you closed it, wait 3 minutes and try again.
        </p>
      )}
      {restored && !running && (
        <p className="mt-3 text-sm text-gray-700">
          Picked up an unfinished sweep from this browser ({left} cells left). Press Resume to continue, or Start over.
        </p>
      )}

      {progress && (
        <div className="mt-5 text-sm text-gray-800 space-y-1">
          <div className="w-full bg-gray-200 rounded h-2 mb-2">
            <div className="bg-blue-600 h-2 rounded" style={{ width: `${pct}%` }} />
          </div>
          <p>Cells searched: <b>{progress.cells}</b> · still queued: <b>{left}</b> · split into finer cells: <b>{progress.splits}</b></p>
          <p>Google requests used: <b>{progress.requests}</b> of {limit} maximum</p>
          <p>New schools added: <b>{progress.inserted}</b> · existing schools linked or refreshed: <b>{progress.updated}</b></p>
          {progress.unresolved > 0 && (
            <p className="text-amber-700">Cells still too crowded at the finest level: {progress.unresolved} (some schools there may be missing)</p>
          )}
          {progress.stopped && <p className="font-bold text-amber-700">Stopped: {progress.stopped}</p>}
          {progress.errors.length > 0 && (
            <pre className="text-xs font-mono bg-red-50 text-red-800 p-3 rounded border border-red-200 whitespace-pre-wrap">{progress.errors.slice(0, 5).join('\n')}</pre>
          )}
          {finished && <p className="font-bold text-green-700">Sweep complete.</p>}
        </div>
      )}

      {trialResult && (
        <pre className="mt-4 text-xs font-mono bg-gray-50 p-3 rounded border text-black whitespace-pre-wrap max-h-96 overflow-auto">{trialResult}</pre>
      )}
    </div>
  );
}
