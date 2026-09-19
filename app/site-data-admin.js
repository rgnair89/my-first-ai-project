// Logic for the School data tab: reading school websites and reviewing what was found. No React and no network here,
// so it can be tested on its own. Every function that talks to the database takes the client as an argument.

export const VIEWS = [
  { key: 'pending', label: 'Waiting for review' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'no_findings', label: 'Nothing found' },
];

export const FINDING_SELECT =
  'id, school_id, checked_at, website, pages, boards, levels, admission, error, review_status, reviewed_at, review_note, ' +
  'schools(name, board, boards, levels, website, admissions_open, admissions_year)';

export const BATCH = 6;             // schools per call of the reader (it allows up to 10)
export const SESSION_CAP = 300;     // a run stops by itself after this many schools; press Start again to go on

const one = (x) => (Array.isArray(x) ? x[0] ?? null : x ?? null);

export function normalizeFinding(row) {
  const school = one(row.schools) ?? {};
  return {
    id: row.id,
    schoolId: row.school_id,
    school: school.name ?? '(school no longer listed)',
    currentBoard: school.board ?? '',
    currentLevels: Array.isArray(school.levels) ? school.levels : [],
    website: row.website ?? school.website ?? '',
    checkedAt: row.checked_at ?? '',
    boards: Array.isArray(row.boards) ? row.boards : [],
    levels: Array.isArray(row.levels) ? row.levels : [],
    admission: row.admission ?? null,
    pages: Array.isArray(row.pages) ? row.pages : [],
    error: row.error ?? '',
    status: row.review_status,
    note: row.review_note ?? '',
  };
}

export const isConfirmed = (hit) => hit?.verified?.confirmed === true;

// What is ticked when a finding is first shown: strong or CBSE-confirmed boards, strong levels, and a dated, current
// admission notice.
export function defaultChoice(f) {
  return {
    boards: f.boards.filter((b) => b.strong || isConfirmed(b)).map((b) => b.board),
    levels: (f.levels ?? []).filter((l) => l.strong).map((l) => l.level),
    admission: !!(f.admission && !f.admission.stale && f.admission.year),
  };
}

export function boardLabel(hit) {
  if (isConfirmed(hit)) return `${hit.board} - confirmed by CBSE's record (${(hit.verified.reasons ?? []).join(', ')})`;
  if (hit.verified && hit.verified.confirmed === false) return `${hit.board} - NOT confirmed: ${(hit.verified.reasons ?? []).join(', ')}`;
  return `${hit.board}${hit.strong ? '' : ' (weak: only mentioned)'}`;
}

export const LEVEL_NAMES = { daycare: 'Daycare', preschool: 'Preschool (nursery, KG)', primary: 'Primary (classes 1 to 7)', secondary: 'Secondary (classes 8 to 12)' };
export const levelLabel = (hit) => `${LEVEL_NAMES[hit.level] ?? hit.level}${hit.strong ? '' : ' (weak: only mentioned)'}`;
export const levelsText = (levels) => (levels?.length ? levels.map((l) => (LEVEL_NAMES[l] ?? l).replace(/ \(.*\)$/, '')).join(', ') : 'not stated');

export function admissionLabel(a) {
  if (!a) return '';
  const what = a.status === 'open' ? 'Admissions open' : 'Admissions closed';
  if (a.stale) return `${what} for ${a.year} - an old notice, cannot be used`;
  return a.year ? `${what} for ${a.year}` : `${what} (the page gives no year)`;
}

// The arguments for review_site_finding, or an explanation of what cannot be done.
export function reviewCall(f, choice, note) {
  const found = new Set(f.boards.map((b) => b.board));
  const boards = [...new Set(choice.boards ?? [])].filter((b) => found.has(b));
  const foundLevels = new Set((f.levels ?? []).map((l) => l.level));
  const levels = [...new Set(choice.levels ?? [])].filter((l) => foundLevels.has(l));
  if (choice.admission && (!f.admission || f.admission.stale)) return { error: 'That admission notice cannot be used.' };
  return { p_finding: f.id, p_boards: boards, p_use_admission: !!choice.admission, p_note: (note ?? '').trim() || null, p_levels: levels };
}

// Pending findings whose CBSE board is confirmed by CBSE's own record: safe to accept in one go (the board only).
export function confirmedCbse(findings) {
  return findings.filter((f) => f.status === 'pending' && f.boards.some((b) => b.board === 'CBSE' && isConfirmed(b)));
}

export function progressLine(p) {
  if (!p) return '';
  const left = typeof p.remaining === 'number' ? `, ${p.remaining} still to read` : '';
  return `Read ${p.processed} ${p.processed === 1 ? 'school' : 'schools'} this run: ${p.withFindings} with something to review, ${p.errors} could not be read${left}.`;
}

export function friendlyError(error) {
  const msg = String(error?.message ?? error ?? '');
  if (/admin only|admin_only|permission denied|row-level security/i.test(msg)) return 'Only admins can do this.';
  if (/school_site_findings\.levels|site_levels|p_levels|20260919001100/i.test(msg)) return 'Run the 20260919001100_levels_from_websites.sql migration first.';
  if (/not_configured|20260919000800|last_site_check_at|school_site_findings|schema cache/i.test(msg)) return 'Run the 20260919000800_school_website_findings.sql migration first.';
  if (/404|not found/i.test(msg) && /function/i.test(msg)) return 'The read-school-websites function is not deployed yet.';
  if (/already dealt with/i.test(msg)) return 'Someone already decided on this one. Refresh the list.';
  if (/network|fetch/i.test(msg)) return 'Could not reach the server. Check the connection and try again.';
  return msg || 'Something went wrong.';
}

// ---- database access ----
export async function loadFindings(db, view) {
  const { data, error } = await db.from('school_site_findings').select(FINDING_SELECT).eq('review_status', view).order('checked_at', { ascending: false }).limit(100);
  return { findings: (data ?? []).map(normalizeFinding), error };
}

export async function loadCounts(db) {
  const out = {};
  for (const v of VIEWS) {
    const { count } = await db.from('school_site_findings').select('id', { count: 'exact', head: true }).eq('review_status', v.key);
    out[v.key] = count ?? 0;
  }
  return out;
}

export async function review(db, f, choice, note) {
  const call = reviewCall(f, choice, note);
  if (call.error) return { error: { message: call.error } };
  return db.rpc('review_site_finding', call);
}

// One call of the website reader. Returns { ok, ...summary } or { ok: false, error }.
export async function readBatch(db, { dryRun = false, limit = BATCH } = {}) {
  let res;
  try {
    res = await db.functions.invoke('read-school-websites', { body: { limit, dryRun } });
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  }
  const { data, error } = res ?? {};
  if (error) {
    if (error.context?.status === 404) return { ok: false, error: 'The read-school-websites function is not deployed yet.' };
    let body = null;
    try { body = typeof error.context?.json === 'function' ? await error.context.json() : null; } catch { /* no body */ }
    return { ok: false, error: friendlyError(body?.error ?? body?.code ?? error.message) };
  }
  if (!data?.ok) return { ok: false, error: friendlyError(data?.error ?? data?.code) };
  return data;
}
