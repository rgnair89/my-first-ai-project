// Logic for the review moderation screen. No React and no network here, so it can be tested on its own.
// Every function that talks to the database takes the client as an argument.

export const VIEWS = [
  { key: 'pending', label: 'Waiting' },
  { key: 'reported', label: 'Reported' },
  { key: 'published', label: 'Published' },
  { key: 'closed', label: 'Rejected / removed' },
];

export const RELATIONSHIPS = {
  current_parent: 'Current parent',
  former_parent: 'Former parent',
  applicant: 'Applied / visited',
  other: 'Other',
};

export const REASONS = {
  spam: 'Spam',
  abusive: 'Abusive',
  fake: 'Looks fake',
  personal_info: 'Personal details',
  other: 'Something else',
};

// One query for every view. Who wrote it comes from the private table, which only admins can read.
// profiles!author_id picks the author link, because the private table also points at profiles through moderated_by.
export const REVIEW_SELECT =
  'id, rating, title, body, relationship, status, created_at, updated_at, ' +
  'schools(name), ' +
  'school_review_private(author_id, moderation_note, moderated_at, author:profiles!author_id(first_name, last_name, email)), ' +
  'review_reports(id, reason, details, status, created_at)';

export const MIN_NOTE_LENGTH = 5;

// PostgREST returns a single object for a one-to-one link and an array for one-to-many; accept both.
const one = (x) => (Array.isArray(x) ? x[0] ?? null : x ?? null);

export function normalize(row) {
  const priv = one(row.school_review_private);
  const author = one(priv?.author);
  const reports = row.review_reports ?? [];
  const name = author ? [author.first_name, author.last_name].filter(Boolean).join(' ') : '';
  return {
    id: row.id,
    rating: row.rating,
    title: row.title ?? '',
    body: row.body,
    relationship: row.relationship,
    status: row.status,
    createdAt: row.created_at ?? '',
    school: one(row.schools)?.name ?? '(school no longer listed)',
    authorName: author ? name || '(no name given)' : '(unknown)',
    authorEmail: author?.email ?? '',
    note: priv?.moderation_note ?? '',
    reports,
    openReports: reports.filter((r) => r.status === 'open'),
  };
}

export function inView(review, view) {
  switch (view) {
    case 'pending': return review.status === 'pending';
    case 'reported': return review.openReports.length > 0 && (review.status === 'published' || review.status === 'pending');
    case 'published': return review.status === 'published';
    case 'closed': return review.status === 'rejected' || review.status === 'removed';
    default: return true;
  }
}

// Waiting: oldest first (first come, first served). Reported: most reports first. The rest: newest first.
export function sortFor(view) {
  if (view === 'pending') return (a, b) => a.createdAt.localeCompare(b.createdAt);
  if (view === 'reported') return (a, b) => b.openReports.length - a.openReports.length || a.createdAt.localeCompare(b.createdAt);
  return (a, b) => b.createdAt.localeCompare(a.createdAt);
}

export function countByView(reviews) {
  return Object.fromEntries(VIEWS.map((v) => [v.key, reviews.filter((r) => inView(r, v.key)).length]));
}

// What a moderator may do next. Publishing a review that has open reports means "keep it": the reports are dismissed.
export function actionsFor(review) {
  switch (review.status) {
    case 'pending': return ['publish', 'reject', 'remove'];
    case 'published': return review.openReports.length ? ['publish', 'reject', 'remove'] : ['reject', 'remove'];
    case 'rejected': return ['publish', 'remove'];
    case 'removed': return ['publish'];
    default: return [];
  }
}

export function actionLabel(action, review) {
  if (action === 'publish') {
    if (review.status === 'published') return 'Keep it (dismiss reports)';
    if (review.status === 'pending') return 'Publish';
    return 'Restore and publish';
  }
  if (action === 'reject') return review.status === 'published' ? 'Take down' : 'Reject';
  return 'Remove for good';
}

export const needsNote = (action) => action === 'reject' || action === 'remove';

export function noteHelp(action) {
  return action === 'reject'
    ? 'Tell the parent why, so they can fix it. They will see this.'
    : 'Internal reason. The parent will see that a moderator removed it.';
}

// Turns a button press into the arguments for the database function, or explains what is missing.
export function moderationCall(action, note) {
  const text = (note ?? '').trim();
  if (needsNote(action) && text.length < MIN_NOTE_LENGTH) {
    return { error: `Please write a short reason (at least ${MIN_NOTE_LENGTH} characters).` };
  }
  const status = { publish: 'published', reject: 'rejected', remove: 'removed' }[action];
  if (!status) return { error: 'Unknown action.' };
  return { status, note: needsNote(action) ? text : null };
}

export function describeReports(reports) {
  const counts = {};
  for (const r of reports) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
  return Object.entries(counts).map(([k, n]) => `${REASONS[k] ?? k}${n > 1 ? ` x${n}` : ''}`).join(', ');
}

export function stars(n) {
  const k = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
  return '★'.repeat(k) + '☆'.repeat(5 - k);
}

export function doneMessage(action) {
  return { publish: 'Done. The review is published.', reject: 'Done. The review was rejected and the parent can see why.', remove: 'Done. The review was removed.' }[action] ?? 'Done.';
}

// ---- database access ----
export async function loadReviews(db) {
  const { data, error } = await db.from('school_reviews').select(REVIEW_SELECT).order('created_at', { ascending: false }).limit(300);
  return { reviews: (data ?? []).map(normalize), error };
}

export async function loadPendingCount(db) {
  const { count } = await db.from('school_reviews').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  return count ?? 0;
}

export async function moderate(db, id, action, note) {
  const call = moderationCall(action, note);
  if (call.error) return { error: { message: call.error } };
  return db.rpc('moderate_review', { p_review: id, p_status: call.status, p_note: call.note });
}
