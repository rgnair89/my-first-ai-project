'use client';

import { useRef, useState } from 'react';
import { supabase } from '@/utils/supabase';
import { buildGrid, testCells, runSweep, emptyTotals, mergeTotals, MAX_REQUESTS, BUDGET_TOP_UP } from './sweep';

// supabase-js sends the signed-in admin's session; the function checks the admin role itself.
async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('ingest-mumbai-schools', { body });
  if (!error) return { data, error: null };
  const detail = error.context?.text ? await error.context.text().catch(() => '') : '';
  return { data: null, error: { message: `${error.message}${detail ? ` - ${detail}` : ''}` } };
}

const toRequestCell = ({ id, low, high }) => ({ id, low, high });

export default function SweepPanel() {
  const queue = useRef([]); // cells still to search; survives a stop so the sweep can resume
  const done = useRef(emptyTotals()); // totals from earlier runs of this sweep
  const stopRequested = useRef(false);
  const budget = useRef(MAX_REQUESTS); // Google requests this sweep may use in total
  const [limit, setLimit] = useState(MAX_REQUESTS); // the same number, kept in state so the screen can show it
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [left, setLeft] = useState(0);
  const [trialResult, setTrialResult] = useState('');

  async function trial() {
    setRunning(true);
    setTrialResult('');
    const { data, error } = await invoke({ dryRun: true, cells: testCells().map(toRequestCell) });
    setTrialResult(error ? `Error: ${error.message}` : JSON.stringify(data, null, 2));
    setRunning(false);
  }

  async function sweep() {
    const fresh = queue.current.length === 0;
    if (
      fresh &&
      !window.confirm(
        `This starts the full grid sweep of Mumbai, Thane and Navi Mumbai.\n\n` +
          `Expect roughly 800-1,500 Google Places requests (about $30-55 at Google's list price, and 10-20 minutes). ` +
          `It stops by itself at ${MAX_REQUESTS} requests (about $70). Keep this tab open. If it stops for any reason, press Resume.\n\nContinue?`,
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
    stopRequested.current = false;
    setRunning(true);

    const result = await runSweep({
      queue: queue.current,
      invoke,
      dryRun: false,
      maxRequests: budget.current - done.current.requests,
      shouldStop: () => stopRequested.current,
      onProgress: (p) => {
        setProgress(mergeTotals(done.current, p));
        setLeft(p.queued);
      },
    });

    done.current = mergeTotals(done.current, result);
    setProgress(done.current);
    setLeft(result.queued);
    setRunning(false);
  }

  function startOver() {
    queue.current = [];
    done.current = emptyTotals();
    setProgress(null);
    setLeft(0);
  }

  const pct = progress && progress.cells + left > 0 ? Math.round((progress.cells / (progress.cells + left)) * 100) : 0;
  const finished = progress && !running && left === 0 && !progress.stopped;

  return (
    <div className="bg-white border border-gray-200 p-6 rounded-xl shadow-sm mb-8">
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
