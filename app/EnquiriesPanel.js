'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/utils/supabase';
import {
  VIEWS, loadThreads, loadMessages, sendReply, setStatus, markRead, nudgePush,
  inView, sortFor, countByView, statusLabel, aboutLine, waitingDays, overdue, senderLabel, friendlyError,
} from './enquiries-admin';

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export default function EnquiriesPanel({ onChanged, mode = 'admin' }) {
  const isAdmin = mode === 'admin';
  const [threads, setThreads] = useState([]);
  const [view, setView] = useState('needs_reply');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openId, setOpenId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const res = await loadThreads(supabase); // the screen starts out "loading", so nothing to set before the request
    if (res.error) setError(`Could not load enquiries: ${friendlyError(res.error)}`);
    else { setError(''); setThreads(res.threads); }
    setLoading(false);
  }

  async function open(thread) {
    setError('');
    setNotice('');
    setReply('');
    if (openId === thread.id) { setOpenId(null); return; }
    setOpenId(thread.id);
    setMessages([]);
    setLoadingThread(true);
    const res = await loadMessages(supabase, thread.id);
    setLoadingThread(false);
    if (res.error) { setError(friendlyError(res.error)); return; }
    setMessages(res.messages);
    if (thread.unread) {
      const marked = await markRead(supabase, thread.id);
      if (!marked?.error) { await load(); onChanged?.(); }
    }
  }

  async function send(thread) {
    setBusy(true);
    setError('');
    setNotice('');
    const res = await sendReply(supabase, thread.id, reply);
    setBusy(false);
    if (res.error) { setError(friendlyError(res.error)); return; }
    setReply('');
    setNotice('Sent. The parent can read it in the app.');
    await nudgePush(supabase);
    const msgs = await loadMessages(supabase, thread.id);
    if (!msgs.error) setMessages(msgs.messages);
    await load();
    onChanged?.();
  }

  async function changeStatus(thread, status) {
    setBusy(true);
    setError('');
    setNotice('');
    const res = await setStatus(supabase, thread.id, status);
    setBusy(false);
    if (res?.error) { setError(friendlyError(res.error)); return; }
    setNotice(status === 'closed' ? 'Closed. The parent can still write again if they need to.' : 'Reopened.');
    await load();
    onChanged?.();
  }

  const counts = countByView(threads);
  // The conversation you have open stays on screen even after a reply moves it to another tab, so you can see your
  // answer land. It leaves the list when you hide it or change tab.
  const shown = threads.filter((t) => inView(t, view) || t.id === openId).sort(sortFor(view));
  const late = overdue(threads);

  return (
    <div className="bg-white text-gray-900 border border-gray-200 rounded-xl shadow-sm p-6" data-testid="enquiries-panel">
      <h2 className="text-lg font-bold text-gray-900 mb-1">Admissions enquiries</h2>
      <p className="text-sm text-gray-600 mb-4">
        Questions parents sent from the app. Replying here shows up in the parent&apos;s app straight away. Enquiries do not
        include a child&apos;s name or date of birth &mdash; ask the family once you are talking.
        {!isAdmin && ' Kidscover passes your reply on without giving out the family\u2019s email address.'}
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            data-testid={`eview-${v.key}`}
            onClick={() => { setView(v.key); setOpenId(null); setNotice(''); }}
            className={`px-3 py-1.5 rounded-lg font-bold text-sm ${view === v.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            {v.label} ({counts[v.key] ?? 0})
          </button>
        ))}
      </div>

      {late.length > 0 && (
        <p data-testid="enquiries-overdue" className="text-sm font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded p-3 mb-3">
          {late.length} {late.length === 1 ? 'family has' : 'families have'} been waiting two days or more.
        </p>
      )}
      {error && <p data-testid="enquiries-error" className="text-sm font-bold text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3">{error}</p>}
      {notice && <p data-testid="enquiries-notice" className="text-sm font-bold text-green-700 bg-green-50 border border-green-200 rounded p-3 mb-3">{notice}</p>}
      {loading && threads.length === 0 && <p className="text-sm text-gray-500">Loading...</p>}
      {!loading && shown.length === 0 && !error && (
        <p data-testid="enquiries-empty" className="text-sm text-gray-500 italic">
          {view === 'needs_reply' ? 'Nothing is waiting for an answer.' : 'Nothing here.'}
        </p>
      )}

      <div className="space-y-4">
        {shown.map((t) => (
          <div key={t.id} data-testid={`enquiry-${t.id}`} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
            <div className="flex justify-between items-start gap-3">
              <div>
                <p className="font-bold text-gray-900">
                  {t.unread && <span data-testid={`unread-${t.id}`} className="inline-block w-2 h-2 rounded-full bg-blue-600 mr-2 align-middle" />}
                  {t.school}
                </p>
                <p className="text-sm text-gray-800">{t.subject}</p>
                {aboutLine(t) && <p className="text-xs text-gray-600 mt-0.5">{aboutLine(t)}</p>}
                <p className="text-xs text-gray-500 mt-1">
                  From <span data-testid={`parent-${t.id}`} className="font-semibold">{isAdmin ? `${t.parentName}${t.parentEmail ? ` (${t.parentEmail})` : ''}` : 'a family on Kidscover'}</span>
                </p>
              </div>
              <div className="text-right text-xs text-gray-500">
                <span className="uppercase font-bold px-2 py-0.5 rounded bg-gray-200 text-gray-700">{statusLabel(t.status)}</span>
                <p className="mt-1">{when(t.lastMessageAt)}</p>
                {t.status === 'open' && waitingDays(t) >= 1 && (
                  <p data-testid={`waiting-${t.id}`} className="mt-1 font-bold text-amber-700">waiting {waitingDays(t)} {waitingDays(t) === 1 ? 'day' : 'days'}</p>
                )}
              </div>
            </div>

            {openId !== t.id && (
              <>
                <p className="text-sm text-gray-700 mt-2 truncate">{t.lastMessage}</p>
                <button
                  data-testid={`open-${t.id}`}
                  onClick={() => open(t)}
                  className="mt-3 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-blue-700"
                >
                  Open conversation ({t.messageCount})
                </button>
              </>
            )}

            {openId === t.id && (
              <div className="mt-3" data-testid={`thread-${t.id}`}>
                {loadingThread && <p className="text-sm text-gray-500">Loading the conversation...</p>}
                <div className="space-y-2">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      data-testid={`message-${m.id}`}
                      className={`p-3 rounded-lg text-sm ${senderLabel(m, t) === 'Parent' ? 'bg-white border border-gray-200' : 'bg-blue-50 border border-blue-100'}`}
                    >
                      <p className="text-xs font-bold text-gray-500">{senderLabel(m, t)} &middot; {when(m.created_at)}</p>
                      <p className="text-gray-900 mt-1 whitespace-pre-wrap">{m.message}</p>
                    </div>
                  ))}
                </div>

                {t.status !== 'closed' && (
                  <div className="mt-3">
                    <textarea
                      data-testid={`reply-${t.id}`}
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      rows={3}
                      placeholder="Write back to the parent..."
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-black"
                    />
                    <p className="text-xs text-gray-500">The parent sees this as coming from Kidscover, not from you by name.</p>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 mt-2">
                  {t.status !== 'closed' && (
                    <button
                      data-testid={`send-${t.id}`}
                      onClick={() => send(t)}
                      disabled={busy}
                      className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-blue-700 disabled:opacity-50"
                    >
                      {busy ? 'Sending...' : 'Send reply'}
                    </button>
                  )}
                  {t.status === 'closed' ? (
                    <button data-testid={`reopen-${t.id}`} onClick={() => changeStatus(t, 'open')} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-bold bg-gray-200 text-gray-800 hover:bg-gray-300 disabled:opacity-50">
                      Reopen
                    </button>
                  ) : (
                    <button data-testid={`close-${t.id}`} onClick={() => changeStatus(t, 'closed')} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-bold bg-gray-200 text-gray-800 hover:bg-gray-300 disabled:opacity-50">
                      Close
                    </button>
                  )}
                  <button data-testid={`collapse-${t.id}`} onClick={() => open(t)} className="px-4 py-2 rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-200">
                    Hide
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
