// Logic for the admissions enquiries inbox. No React and no network here, so it can be tested on its own.
// Every function that talks to the database takes the client as an argument.

export const VIEWS = [
  { key: 'needs_reply', label: 'Needs a reply' },
  { key: 'waiting', label: 'Waiting for the parent' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

export const THREAD_SELECT =
  'id, school_id, school_name, parent_id, parent_first_name, parent_last_name, parent_email, ' +
  'subject, grade_of_interest, start_year, status, created_at, last_message_at, ' +
  'message_count, last_message, unread_for_staff';

export const MESSAGE_SELECT = 'id, sender_id, message, created_at';
export const MAX_REPLY = 4000;
export const MIN_REPLY = 2;

export function normalize(row) {
  const name = [row.parent_first_name, row.parent_last_name].filter(Boolean).join(' ').trim();
  return {
    id: row.id,
    school: row.school_name ?? '(school no longer listed)',
    parentId: row.parent_id,
    parentName: name || '(no name given)',
    parentEmail: row.parent_email ?? '',
    subject: row.subject ?? '',
    grade: row.grade_of_interest ?? '',
    startYear: row.start_year ?? null,
    status: row.status,
    createdAt: row.created_at ?? '',
    lastMessageAt: row.last_message_at ?? '',
    lastMessage: row.last_message ?? '',
    messageCount: row.message_count ?? 0,
    unread: !!row.unread_for_staff,
  };
}

export function inView(thread, view) {
  switch (view) {
    case 'needs_reply': return thread.status === 'open';
    case 'waiting': return thread.status === 'replied';
    case 'closed': return thread.status === 'closed';
    default: return true;
  }
}

// Needs a reply: the family who has waited longest comes first. Everything else: most recent movement first.
export function sortFor(view) {
  if (view === 'needs_reply') return (a, b) => a.lastMessageAt.localeCompare(b.lastMessageAt);
  return (a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt);
}

export function countByView(threads) {
  return Object.fromEntries(VIEWS.map((v) => [v.key, threads.filter((t) => inView(t, v.key)).length]));
}

export function statusLabel(status) {
  return { open: 'Needs a reply', replied: 'Waiting for the parent', closed: 'Closed' }[status] ?? status;
}

// What the enquiry is about, in one line, for the list.
export function aboutLine(thread) {
  const bits = [];
  if (thread.grade) bits.push(thread.grade);
  if (thread.startYear) bits.push(`starting ${thread.startYear}`);
  return bits.join(', ');
}

export function waitingDays(thread, now = Date.now()) {
  const t = new Date(thread.lastMessageAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86400000));
}

// Threads that have been waiting for an answer for a while, so the inbox can say so.
export function overdue(threads, days = 2, now = Date.now()) {
  return threads.filter((t) => t.status === 'open' && (waitingDays(t, now) ?? 0) >= days);
}

export function checkReply(text) {
  const body = (text ?? '').trim();
  if (body.length < MIN_REPLY) return { error: 'Please write a reply first.' };
  if (body.length > MAX_REPLY) return { error: `Please keep the reply under ${MAX_REPLY} characters (${body.length} now).` };
  return { body };
}

// Who wrote a message. The parent's id is on the thread, so staff names are never shown to anyone.
export const isFromParent = (message, thread) => message.sender_id === thread.parentId;
export const senderLabel = (message, thread) => (isFromParent(message, thread) ? 'Parent' : 'Kidscover');

export function friendlyError(error) {
  const msg = String(error?.message ?? error ?? '');
  if (/row-level security|permission denied|not yours/i.test(msg)) return 'You do not have permission to do that. Check that your account is an admin.';
  if (/network|fetch/i.test(msg)) return 'Could not reach the database. Check your connection and try again.';
  if (/schema cache|does not exist|PGRST202/i.test(msg)) return 'Enquiries are not switched on in the database yet. Run the 20260919000600 migration in the SQL editor.';
  return msg || 'Something went wrong. Please try again.';
}

// ---- database access ----
export async function loadThreads(db) {
  const { data, error } = await db.from('enquiry_threads').select(THREAD_SELECT).order('last_message_at', { ascending: false }).limit(300);
  return { threads: (data ?? []).map(normalize), error };
}

export async function loadOpenCount(db) {
  const { count } = await db.from('enquiry_threads').select('id', { count: 'exact', head: true }).eq('status', 'open');
  return count ?? 0;
}

export async function loadMessages(db, ticketId) {
  const { data, error } = await db.from('ticket_messages').select(MESSAGE_SELECT).eq('ticket_id', ticketId).order('created_at', { ascending: true }).limit(200);
  return { messages: data ?? [], error };
}

export async function sendReply(db, ticketId, text) {
  const call = checkReply(text);
  if (call.error) return { error: { message: call.error } };
  return db.from('ticket_messages').insert({ ticket_id: ticketId, message: call.body });
}

export const setStatus = (db, ticketId, status) => db.rpc('set_ticket_status', { p_ticket: ticketId, p_status: status });
export const markRead = (db, ticketId) => db.rpc('mark_ticket_read', { p_ticket: ticketId });
