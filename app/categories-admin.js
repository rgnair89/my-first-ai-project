// Logic for the Categories tab: which places parents see as schools, after-school classes or colleges, which are
// hidden, and moving one. No React and no network here, so it can be tested on its own. Every function that talks to
// the database takes the client as an argument.

export const VIEWS = [
  { key: 'after_school', label: 'After-school classes' },
  { key: 'college', label: 'Colleges' },
  { key: 'hidden', label: 'Hidden' },
  { key: 'school', label: 'Schools' },
];

// What an admin can do with one place ('auto' hands it back to the rules).
export const CHOICES = [
  { key: 'school', label: 'School' },
  { key: 'after_school', label: 'After-school' },
  { key: 'college', label: 'College' },
  { key: 'hidden', label: 'Hide' },
  { key: 'auto', label: 'Automatic' },
];

export const PLACE_SELECT = 'id, name, address, website, category, category_override, hidden_override, is_hidden, auto_hidden_reason, google_primary_type';
export const PAGE = 50;

// Search text made safe for a PostgREST "or" filter (commas and brackets would start a new condition).
export const cleanSearch = (text) => String(text ?? '').replace(/[,()*"\\%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

// The places in one view: schools, classes and colleges are what parents can see; "hidden" is everything they cannot.
export function viewFilter(query, view, search = '') {
  let q = view === 'hidden' ? query.eq('is_hidden', true) : query.eq('is_hidden', false).eq('category', view);
  const term = cleanSearch(search);
  if (term) q = q.or(`name.ilike.*${term}*,address.ilike.*${term}*`);
  return q;
}

export function normalizePlace(row) {
  return {
    id: row.id,
    name: row.name ?? '(no name)',
    address: row.address ?? '',
    website: row.website ?? '',
    category: row.category ?? 'school',
    categoryOverride: row.category_override ?? null,
    hiddenOverride: row.hidden_override ?? null,
    hidden: row.is_hidden === true,
    reason: row.auto_hidden_reason ?? '',
    googleType: row.google_primary_type ?? '',
  };
}

// Where a place is now, as one of the CHOICES keys.
export const currentChoice = (p) => (p.hidden ? 'hidden' : p.category);
export const overridden = (p) => p.categoryOverride !== null || p.hiddenOverride !== null;

// The buttons for one place: every other list, and "Automatic" only when an admin has decided before.
export const choicesFor = (p) => CHOICES.filter((c) => (c.key === 'auto' ? overridden(p) : c.key !== currentChoice(p)));

// Why a place is where it is, in a line an admin can check.
export function whyText(p) {
  const google = p.googleType ? ` Google calls it "${p.googleType.replace(/_/g, ' ')}".` : '';
  if (p.hidden) return p.hiddenOverride === true ? 'Hidden by an admin.' : `Hidden by the rules (${p.reason || 'not a school'}).${google}`;
  if (p.categoryOverride) return 'Put here by an admin.';
  if (p.hiddenOverride === false) return 'Shown by an admin.';
  return `Sorted by the rules, from its name.${google}`;
}

export function movedText(p, choice) {
  if (choice === 'hidden') return `${p.name}: hidden from parents.`;
  if (choice === 'auto') return `${p.name}: back to the automatic rules.`;
  const label = VIEWS.find((v) => v.key === choice)?.label ?? choice;
  return `${p.name}: moved to ${label}.`;
}

export function friendlyError(error) {
  const msg = String(error?.message ?? error ?? '');
  if (/only an admin|permission denied|row-level security|42501/i.test(msg)) return 'Only admins can do this.';
  if (/set_school_category|category_override|column schools\.category|schema cache|20260919001000/i.test(msg)) return 'Run the 20260919001000_school_categories.sql migration first.';
  if (/no such school/i.test(msg)) return 'That place is no longer in the list. Refresh.';
  if (/network|fetch/i.test(msg)) return 'Could not reach the server. Check the connection and try again.';
  return msg || 'Something went wrong.';
}

// ---- database access ----
export async function loadPlaces(db, view, search = '', page = 0) {
  const from = page * PAGE;
  const { data, error } = await viewFilter(db.from('schools').select(PLACE_SELECT), view, search)
    .order('name_sort', { ascending: true }).order('id', { ascending: true }).range(from, from + PAGE - 1);
  if (error) return { places: [], hasMore: false, error };
  const rows = data ?? [];
  return { places: rows.map(normalizePlace), hasMore: rows.length === PAGE, error: null };
}

export async function loadCounts(db) {
  const out = {};
  for (const v of VIEWS) {
    const { count } = await viewFilter(db.from('schools').select('id', { count: 'exact', head: true }), v.key);
    out[v.key] = count ?? 0;
  }
  return out;
}

export async function setCategory(db, place, choice) {
  const { error } = await db.rpc('set_school_category', { p_school: place.id, p_choice: choice });
  return { error: error ?? null };
}
