'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/utils/supabase';
import {
  VIEWS, RELATIONSHIPS, REASONS, loadReviews, moderate, inView, sortFor, countByView, actionsFor, actionLabel,
  needsNote, noteHelp, describeReports, stars, doneMessage,
} from './reviews-admin';

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function ReviewsPanel({ onChanged }) {
  const [reviews, setReviews] = useState([]);
  const [view, setView] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [draft, setDraft] = useState(null); // { id, action } while a reason is being written
  const [note, setNote] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const res = await loadReviews(supabase); // the screen starts out "loading", so nothing to set before the request
    if (res.error) setError(`Could not load reviews: ${res.error.message}`);
    else { setError(''); setReviews(res.reviews); }
    setLoading(false);
  }

  async function run(review, action, reason) {
    setBusyId(review.id);
    setError('');
    setNotice('');
    const res = await moderate(supabase, review.id, action, reason);
    setBusyId(null);
    if (res.error) { setError(res.error.message); return; }
    setDraft(null);
    setNote('');
    setNotice(doneMessage(action));
    await load();
    onChanged?.();
  }

  function choose(review, action) {
    setError('');
    setNotice('');
    if (needsNote(action)) { setDraft({ id: review.id, action }); setNote(''); }
    else run(review, action, null);
  }

  const counts = countByView(reviews);
  const shown = reviews.filter((r) => inView(r, view)).sort(sortFor(view));

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6" data-testid="reviews-panel">
      <h2 className="text-lg font-bold text-gray-900 mb-1">Parent reviews</h2>
      <p className="text-sm text-gray-600 mb-4">
        New reviews wait here until you publish them. Three reports from different parents also send a published review back to Waiting.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            data-testid={`view-${v.key}`}
            onClick={() => { setView(v.key); setDraft(null); setNotice(''); }}
            className={`px-3 py-1.5 rounded-lg font-bold text-sm ${view === v.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            {v.label} ({counts[v.key] ?? 0})
          </button>
        ))}
      </div>

      {error && <p data-testid="reviews-error" className="text-sm font-bold text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3">{error}</p>}
      {notice && <p data-testid="reviews-notice" className="text-sm font-bold text-green-700 bg-green-50 border border-green-200 rounded p-3 mb-3">{notice}</p>}
      {loading && reviews.length === 0 && <p className="text-sm text-gray-500">Loading...</p>}
      {!loading && shown.length === 0 && !error && (
        <p data-testid="reviews-empty" className="text-sm text-gray-500 italic">
          {view === 'pending' ? 'Nothing is waiting. New reviews will show up here.' : 'Nothing here.'}
        </p>
      )}

      <div className="space-y-4">
        {shown.map((r) => (
          <div key={r.id} data-testid={`review-${r.id}`} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
            <div className="flex justify-between items-start gap-3">
              <div>
                <p className="font-bold text-gray-900">{r.school}</p>
                <p className="text-amber-500 text-lg leading-none">{stars(r.rating)}</p>
              </div>
              <div className="text-right text-xs text-gray-500">
                <span className="uppercase font-bold px-2 py-0.5 rounded bg-gray-200 text-gray-700">{r.status}</span>
                <p className="mt-1">{when(r.createdAt)}</p>
              </div>
            </div>
            {r.title && <p className="font-semibold text-gray-900 mt-2">{r.title}</p>}
            <p className="text-sm text-gray-800 mt-1 whitespace-pre-wrap">{r.body}</p>
            <p className="text-xs text-gray-500 mt-2">
              {RELATIONSHIPS[r.relationship] ?? 'Parent'} · written by <span data-testid={`author-${r.id}`} className="font-semibold">{r.authorName}{r.authorEmail ? ` (${r.authorEmail})` : ''}</span>
              {' '}(only admins can see this)
            </p>

            {r.openReports.length > 0 && (
              <div data-testid={`reports-${r.id}`} className="mt-3 text-sm bg-amber-50 border border-amber-200 rounded p-3">
                <p className="font-bold text-amber-800">{r.openReports.length} open {r.openReports.length === 1 ? 'report' : 'reports'}: {describeReports(r.openReports)}</p>
                {r.openReports.filter((x) => x.details).map((x) => (
                  <p key={x.id} className="text-amber-900 mt-1">&ldquo;{x.details}&rdquo; ({REASONS[x.reason] ?? x.reason})</p>
                ))}
              </div>
            )}
            {r.note && <p className="text-xs text-gray-600 mt-2 italic">Moderator note: {r.note}</p>}

            {draft?.id === r.id ? (
              <div className="mt-3">
                <p className="text-xs text-gray-600 mb-1">{noteHelp(draft.action)}</p>
                <input
                  data-testid="note-input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Reason"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-black"
                />
                <div className="flex gap-2 mt-2">
                  <button data-testid="confirm-action" disabled={busyId === r.id} onClick={() => run(r, draft.action, note)} className="bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-red-700 disabled:opacity-50">
                    {busyId === r.id ? 'Working...' : `Confirm: ${actionLabel(draft.action, r)}`}
                  </button>
                  <button data-testid="cancel-action" onClick={() => setDraft(null)} className="text-sm font-bold text-gray-500 hover:text-black px-2">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 mt-3">
                {actionsFor(r).map((a) => (
                  <button
                    key={a}
                    data-testid={`${a}-${r.id}`}
                    disabled={busyId === r.id}
                    onClick={() => choose(r, a)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-bold disabled:opacity-50 ${a === 'publish' ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100'}`}
                  >
                    {actionLabel(a, r)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
