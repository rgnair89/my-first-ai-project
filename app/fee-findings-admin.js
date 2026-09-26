// Turning what the crawler read into a fee somebody is willing to stand behind.
// No React and no network here, so it can be tested on its own. Every function that talks to the database takes the
// client as an argument.
//
// The rule this whole file exists to keep: nothing proposes itself into being true. The crawler reads a page, this
// arranges what it read, and a person presses the button. A wrong fee is worse than no fee - a family chooses a
// school on it and has no way of knowing it was a machine's guess.

export const FINDING_COLUMNS = 'id, school_id, source_url, grade_text, component_text, evidence, level, '
  + 'academic_year, component, amount, confidence, found_at';

export const LEVELS = [
  { key: 'daycare', label: 'Daycare' },
  { key: 'preschool', label: 'Preschool (nursery, KG)' },
  { key: 'primary', label: 'Primary (classes 1 to 7)' },
  { key: 'secondary', label: 'Secondary (classes 8 to 12)' },
];

// The nine amounts a fee is made of, in the order a person reads a fee page.
export const PARTS = [
  { key: 'tuition', label: 'Tuition', required: true },
  { key: 'transport', label: 'School bus' },
  { key: 'meals', label: 'Meals' },
  { key: 'uniform_books', label: 'Uniform and books' },
  { key: 'activities', label: 'Activities and trips' },
  { key: 'other_annual', label: 'Other yearly fees' },
  { key: 'admission_fee', label: 'Admission fee' },
  { key: 'registration_fee', label: 'Registration fee' },
  { key: 'deposit', label: 'Refundable deposit' },
];
const PART_KEYS = PARTS.map((p) => p.key);

export const levelLabel = (key) => LEVELS.find((l) => l.key === key)?.label ?? 'Not sure which class';

// Indian grouping, as a family reads it: 2,33,000.
export function rupees(amount) {
  const n = Math.round(Number(amount) || 0);
  const s = String(Math.abs(n));
  if (s.length <= 3) return `${n < 0 ? '-' : ''}₹${s}`;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}₹${rest},${last3}`;
}

// ---- reading the queue ---------------------------------------------------------------------------------------------
export async function loadWaitingSchools(db) {
  const { data, error } = await db.from('fee_findings_waiting').select('*').order('confident', { ascending: false }).limit(200);
  return { rows: data ?? [], error: error ?? null };
}

export async function loadFindings(db, schoolId) {
  if (!schoolId) return { rows: [], error: null };
  const { data, error } = await db.from('school_fee_findings').select(FINDING_COLUMNS)
    .eq('school_id', schoolId).eq('status', 'new').order('id', { ascending: true }).limit(200);
  return { rows: data ?? [], error: error ?? null };
}

// ---- arranging it so a person can judge it ---------------------------------------------------------------------------
// One group per level, the ones it could place first, and everything it could not place last under its own heading.
// A group is what one press turns into one fee, so the lines in it must be the lines for that level and no others.
export function groupByLevel(findings) {
  const order = ['daycare', 'preschool', 'primary', 'secondary', null];
  const groups = new Map();
  for (const f of findings ?? []) {
    const key = f?.level ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return order
    .filter((k) => groups.has(k))
    .map((key) => {
      const rows = groups.get(key);
      return {
        level: key,
        label: key ? levelLabel(key) : 'Lines it could not place',
        rows,
        confident: rows.filter((r) => r.confidence === 'high').length,
      };
    });
}

// The fee a group suggests, ready for a person to correct. Where a level has the same charge twice - two tuition
// lines, say, because the page lists a term and a year - the larger is offered, because the fees table holds the
// yearly figure. That is a suggestion and it is shown alongside both, never instead of them.
export function draftFromFindings(rows) {
  const draft = {};
  for (const key of PART_KEYS) {
    const forPart = (rows ?? []).filter((r) => r.component === key && Number(r.amount) > 0);
    if (!forPart.length) continue;
    const best = forPart.slice().sort((a, b) => {
      if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
      return Number(b.amount) - Number(a.amount);
    })[0];
    draft[key] = Number(best.amount);
  }
  const years = (rows ?? []).map((r) => r.academic_year).filter(Boolean);
  const counted = new Map();
  for (const y of years) counted.set(y, (counted.get(y) ?? 0) + 1);
  const year = [...counted.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0]?.[0] ?? '';
  return { ...draft, academic_year: year, source_url: (rows ?? [])[0]?.source_url ?? '' };
}

// What stops this draft being saved, said the way a person would say it, or null when nothing does.
export function whyNotYet(level, draft) {
  if (!level) return 'Choose which classes these fees are for.';
  if (!Number(draft?.tuition)) return 'A fee needs a yearly tuition figure. Fill it in, or set these lines aside.';
  if (!/^20\d{2}-\d{2}$/.test(String(draft?.academic_year ?? ''))) return 'Give the academic year, like 2026-27.';
  const tooBig = PART_KEYS.filter((k) => Number(draft?.[k]) > 5000000);
  if (tooBig.length) return `That is more than fifty lakh (check ${tooBig[0].replace(/_/g, ' ')}).`;
  return null;
}

// Only the amounts, as whole rupees, plus the year and the page. Anything empty is left out rather than sent as a nought.
export function feesPayload(draft) {
  const out = {};
  for (const key of PART_KEYS) {
    const n = Math.round(Number(draft?.[key]));
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  out.academic_year = String(draft?.academic_year ?? '').trim();
  const url = String(draft?.source_url ?? '').trim();
  if (url) out.source_url = url;
  const note = String(draft?.note ?? '').trim();
  if (note) out.note = note.slice(0, 200);
  return out;
}

// ---- deciding --------------------------------------------------------------------------------------------------------
export async function acceptFindings(db, ids, level, draft) {
  const problem = whyNotYet(level, draft);
  if (problem) return { error: { message: problem } };
  const { error } = await db.rpc('accept_fee_findings', { p_ids: ids, p_level: level, p_fees: feesPayload(draft) });
  return { error: error ?? null };
}

export async function rejectFindings(db, ids) {
  if (!ids?.length) return { error: { message: 'Nothing was chosen.' } };
  const { error } = await db.rpc('reject_fee_findings', { p_ids: ids });
  return { error: error ?? null };
}

// ---- running the crawler ---------------------------------------------------------------------------------------------
export async function readMoreWebsites(db, { limit = 8, dryRun = false } = {}) {
  const { data, error } = await db.functions.invoke('crawl-school-fees', { body: { limit, dryRun } });
  if (error) return { result: null, error };
  if (data && data.success === false) return { result: null, error: { message: data.error ?? 'The crawler could not finish.' } };
  return { result: data, error: null };
}

// The crawler before this one answered in a different shape: { mode: 'report-only...', count, details } and no
// "schools" at all. A portal that simply read result.schools saw nothing there, read it as a nought, and announced
// that there was nothing to read - while the function it was talking to had just read five websites and said so.
// So: recognise the old one by name and say what it is, and never turn an answer you do not understand into a
// confident sentence about what happened.
export function isOldCrawler(result) {
  return !!result && result.schools === undefined && (typeof result.count === 'number' || /report-only/i.test(String(result.mode ?? '')));
}

// A line of plain English about what a run of the crawler did.
export function crawlSummary(result) {
  if (!result) return '';
  if (isOldCrawler(result)) {
    return 'That is the old crawler, which only reports and never writes anything down. Paste the new '
      + 'crawl-school-fees into the dashboard and deploy it, then try again.';
  }
  if (result.schools === undefined) {
    // something answered, but not in a shape this screen knows. Say so, and hand over its own words.
    return `The crawler answered in a way this screen does not recognise${result.message ? `: ${result.message}` : '.'}`;
  }
  const schools = Number(result.schools ?? 0);
  const found = Number(result.findings_written ?? 0);
  const worth = Number(result.worth_looking_at ?? 0);
  if (!schools) return 'No schools with a website were left to read.';
  if (!found) return `Read ${schools} website${schools === 1 ? '' : 's'} and found no fee table on any of them.`;
  return `Read ${schools} website${schools === 1 ? '' : 's'}, took down ${found} line${found === 1 ? '' : 's'}, `
    + `${worth} of them worth looking at.`;
}

// True when the run needs somebody to do something before it will work, rather than simply having found nothing.
export const crawlNeedsAttention = (result) => isOldCrawler(result) || (!!result && result.schools === undefined);
