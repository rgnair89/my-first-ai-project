// Logic for school profiles (facilities, achievements, photo, staff, change log): used by Kidscover admins and by
// each school's own staff. No React here, so it can be tested on its own. Every function that talks to the database
// takes the client as an argument; Wikimedia searches take a fetch function.

import { describeFeeChange } from './fees-admin';

export const FACILITIES = [
  { key: 'cafeteria', label: 'Cafeteria / canteen' },
  { key: 'outdoor_playground', label: 'Open playground' },
  { key: 'indoor_play', label: 'Indoor play / sports hall' },
  { key: 'swimming_pool', label: 'Swimming pool' },
  { key: 'sports_courts', label: 'Sports courts and grounds' },
  { key: 'library', label: 'Library' },
  { key: 'science_labs', label: 'Science labs' },
  { key: 'computer_lab', label: 'Computer lab' },
  { key: 'maths_lab', label: 'Maths lab' },
  { key: 'stem_lab', label: 'STEM / robotics lab' },
  { key: 'ai_lab', label: 'AI / coding lab' },
  { key: 'smart_classes', label: 'Smart classrooms' },
  { key: 'auditorium', label: 'Auditorium' },
  { key: 'art_music', label: 'Art and music rooms' },
  { key: 'transport', label: 'School bus' },
  { key: 'medical_room', label: 'Nurse / medical room' },
  { key: 'cctv', label: 'CCTV and security' },
  { key: 'air_conditioned', label: 'Air-conditioned classrooms' },
  { key: 'special_needs', label: 'Special needs support' },
  { key: 'teacher_ratio', label: 'Teacher-student ratio', detail: 'required', placeholder: '1:20' },
];
export const facilityLabel = (key) => FACILITIES.find((f) => f.key === key)?.label ?? key;

export const ACHIEVEMENT_KINDS = [
  { key: 'class10', label: 'Class 10 results' },
  { key: 'class12', label: 'Class 12 results' },
  { key: 'placements', label: 'College and university placements' },
  { key: 'alumni', label: 'Notable alumni' },
  { key: 'award', label: 'Awards and rankings' },
  { key: 'other', label: 'Other' },
];
export const kindLabel = (key) => ACHIEVEMENT_KINDS.find((k) => k.key === key)?.label ?? key;

export const SOURCE_LABELS = { school: 'from the school', 'school website': "from the school's website", kidscover: 'checked by Kidscover' };

// Levels, in the order parents see them.
export const LEVEL_NAMES = { daycare: 'Daycare', preschool: 'Preschool (nursery, KG)', primary: 'Primary (classes 1 to 7)', secondary: 'Secondary (classes 8 to 12)' };
export const LEVEL_ORDER = Object.keys(LEVEL_NAMES);
export const levelsText = (levels) => (levels?.length ? levels.map((l) => (LEVEL_NAMES[l] ?? l).replace(/ \(.*\)$/, '')).join(', ') : 'not stated');

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PROFILE_SCHOOL_COLUMNS = 'id, name, address, website, is_hidden, category, photo_url, photo_source, photo_credit, photo_licence, photo_page_url';
// Read on their own, so the rest of the page still works before 20260919001400 is run.
export const LEVEL_COLUMNS = 'levels, profile_levels, profile_levels_source, start_time, start_time_source';

export const cleanSearch = (text) => String(text ?? '').replace(/[,()*"\\%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export function friendlyError(error) {
  const msg = String(error?.message ?? error ?? '');
  if (/only change your own school|only a kidscover admin|permission denied|row-level security|42501/i.test(msg)) {
    return /only a kidscover admin/i.test(msg) ? msg : 'You can only change your own school.';
  }
  if (/profile_levels|set_school_levels|20260919001400/i.test(msg)) return 'Run the 20260919001400_hand_set_levels.sql migration first.';
  if (/school_fee_schedules|set_school_fees|set_school_start_time|start_time|20260920000200/i.test(msg)) return 'Run the 20260920000200_fees_and_start_times.sql migration first.';
  if (/school_crm_webhooks|crm_deliveries|outbound_click|admission_application|20260920000300/i.test(msg)) return 'Run the 20260920000300_partner_schools.sql migration first.';
  if (/school_facilities|school_achievements|school_change_log|school_staff|set_school_|save_school_achievement|photo_url|schema cache|20260919001200/i.test(msg)) {
    return 'Run the 20260919001200_school_profiles.sql migration first.';
  }
  if (/bucket not found/i.test(msg)) return 'Run the 20260919001200_school_profiles.sql migration first (it creates the photo storage).';
  if (/network|failed to fetch/i.test(msg)) return 'Could not reach the server. Check the connection and try again.';
  return msg || 'Something went wrong.';
}

// ---- one school's profile ----
export async function loadProfile(db, schoolId) {
  const [s, f, a, l] = await Promise.all([
    db.from('schools').select(PROFILE_SCHOOL_COLUMNS).eq('id', schoolId).maybeSingle(),
    db.from('school_facilities').select('facility, detail, source, source_url, updated_at').eq('school_id', schoolId),
    db.from('school_achievements').select('id, kind, text, year, source, source_url, updated_at').eq('school_id', schoolId)
      .order('kind', { ascending: true }).order('year', { ascending: false, nullsFirst: false }),
    db.from('schools').select(LEVEL_COLUMNS).eq('id', schoolId).maybeSingle(),
  ]);
  const error = s.error ?? f.error ?? a.error ?? null;
  if (error) return { error };
  if (!s.data) return { error: { message: 'That school is not in the list any more.' } };
  return {
    school: s.data, facilities: f.data ?? [], achievements: a.data ?? [],
    levels: l.error ? null : { now: l.data?.levels ?? [], hand: l.data?.profile_levels ?? null, source: l.data?.profile_levels_source ?? null },
    start: l.error ? null : { start_time: l.data?.start_time ?? null, start_time_source: l.data?.start_time_source ?? null },
    levelsError: l.error ? friendlyError(l.error) : '', error: null,
  };
}

// Admins find any school by name or area (hidden places included, marked); staff get the schools they look after.
export async function findSchools(db, term) {
  const t = cleanSearch(term);
  if (t.length < 2) return { schools: [], error: null };
  const { data, error } = await db.from('schools').select('id, name, address, is_hidden, category')
    .or(`name.ilike.*${t}*,address.ilike.*${t}*`).order('name_sort', { ascending: true }).limit(20);
  return { schools: data ?? [], error: error ?? null };
}

export async function loadMySchools(db, userId) {
  const { data, error } = await db.from('school_staff').select('school_id, schools(id, name, address)').eq('user_id', userId);
  const schools = (data ?? []).map((r) => (Array.isArray(r.schools) ? r.schools[0] : r.schools)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { schools, error: error ?? null };
}

// ---- changes ----
export function checkFacility(key, has, detail) {
  const f = FACILITIES.find((x) => x.key === key);
  if (!f) return 'Unknown facility.';
  const d = String(detail ?? '').trim();
  if (has && f.detail === 'required' && !/^1\s*:\s*\d{1,3}$/.test(d)) return 'Give the teacher-student ratio like 1:20.';
  if (d.length > 120) return 'Keep the detail under 120 characters.';
  return '';
}
export async function setFacility(db, schoolId, key, has, detail) {
  const problem = checkFacility(key, has, detail);
  if (problem) return { error: { message: problem } };
  const { error } = await db.rpc('set_school_facility', { p_school: schoolId, p_facility: key, p_has: !!has, p_detail: String(detail ?? '').trim() || null });
  return { error: error ?? null };
}

// levels: some of LEVEL_ORDER, or null to go back to the levels worked out automatically.
export function checkLevels(levels) {
  if (levels === null) return '';
  if (!Array.isArray(levels) || !levels.length || !levels.every((l) => LEVEL_ORDER.includes(l))) return 'Tick at least one level, or go back to automatic.';
  return '';
}
export async function setLevels(db, schoolId, levels) {
  const problem = checkLevels(levels);
  if (problem) return { error: { message: problem } };
  const { error } = await db.rpc('set_school_levels', { p_school: schoolId, p_levels: levels === null ? null : LEVEL_ORDER.filter((l) => levels.includes(l)) });
  return { error: error ?? null };
}
export const levelsSourceText = (lv) => (lv?.hand ? `Set by ${lv.source === 'school' ? 'the school' : 'Kidscover'}.`
  : "Worked out automatically, from the school's name, Google and accepted website findings.");

export function checkAchievement(a) {
  if (!ACHIEVEMENT_KINDS.some((k) => k.key === a.kind)) return 'Choose what kind of achievement it is.';
  const text = String(a.text ?? '').trim();
  if (text.length < 3 || text.length > 300) return 'Describe it in 3 to 300 characters.';
  const year = a.year === '' || a.year === null || a.year === undefined ? null : Number(a.year);
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear() + 1)) return 'That year does not look right.';
  const url = String(a.url ?? '').trim();
  if (url && !/^https?:\/\//i.test(url)) return 'The link must start with http:// or https://';
  return '';
}
export async function saveAchievement(db, schoolId, a) {
  const problem = checkAchievement(a);
  if (problem) return { error: { message: problem } };
  const year = a.year === '' || a.year === null || a.year === undefined ? null : Number(a.year);
  const { data, error } = await db.rpc('save_school_achievement', {
    p_school: schoolId, p_id: a.id ?? null, p_kind: a.kind, p_text: String(a.text).trim(), p_year: year, p_url: String(a.url ?? '').trim() || null,
  });
  return { id: data ?? null, error: error ?? null };
}
export async function deleteAchievement(db, id) {
  const { error } = await db.rpc('delete_school_achievement', { p_id: id });
  return { error: error ?? null };
}

// ---- the photo ----
export function checkPhotoFile(file) {
  if (!file) return 'Choose a photo first.';
  if (!PHOTO_TYPES.includes(file.type)) return 'Use a JPEG, PNG or WebP picture.';
  if (file.size > PHOTO_MAX_BYTES) return 'The photo is larger than 5 MB. Use a smaller one.';
  return '';
}
export const photoPath = (schoolId, file, now = Date.now()) => `${schoolId}/photo-${now}.${file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'}`;

// Uploads to the school's folder, then makes it the school's photo. The school confirms it may use the photo.
export async function uploadPhoto(db, schoolId, file, credit, now = Date.now()) {
  const problem = checkPhotoFile(file);
  if (problem) return { error: { message: problem } };
  const path = photoPath(schoolId, file, now);
  const up = await db.storage.from('school-photos').upload(path, file, { contentType: file.type, upsert: false });
  if (up.error) return { error: up.error };
  const url = db.storage.from('school-photos').getPublicUrl(path).data.publicUrl;
  const { error } = await db.rpc('set_school_photo', { p_school: schoolId, p_url: url, p_source: 'school', p_credit: String(credit ?? '').trim() || null, p_licence: null, p_page_url: null });
  return { url, error: error ?? null };
}

export async function chooseWikimediaPhoto(db, schoolId, pick) {
  const { error } = await db.rpc('set_school_photo', { p_school: schoolId, p_url: pick.url, p_source: 'wikimedia', p_credit: pick.credit, p_licence: pick.licence, p_page_url: pick.pageUrl });
  return { error: error ?? null };
}
export async function removePhoto(db, schoolId) {
  const { error } = await db.rpc('set_school_photo', { p_school: schoolId, p_url: null, p_source: null, p_credit: null, p_licence: null, p_page_url: null });
  return { error: error ?? null };
}

export const WIKIMEDIA_API = 'https://commons.wikimedia.org/w/api.php';
export function wikimediaSearchUrl(term) {
  const q = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6', gsrlimit: '12',
    gsrsearch: String(term ?? '').trim().slice(0, 100), prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiurlwidth: '800',
  });
  return `${WIKIMEDIA_API}?${q}`;
}
// Free-licensed photos on Wikimedia Commons, with what the licence asks for: the author and the licence name.
export async function searchWikimedia(fetchFn, term) {
  if (String(term ?? '').trim().length < 3) return { photos: [], error: null };
  let json;
  try {
    const res = await fetchFn(wikimediaSearchUrl(term));
    if (!res.ok) return { photos: [], error: { message: `Wikimedia Commons answered ${res.status}` } };
    json = await res.json();
  } catch (e) {
    return { photos: [], error: { message: 'Could not reach Wikimedia Commons: ' + (e?.message ?? e) } };
  }
  const pages = Object.values(json?.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const photos = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii || !PHOTO_TYPES.includes(ii.mime)) continue;
    const meta = ii.extmetadata ?? {};
    const licence = stripHtml(meta.LicenseShortName?.value);
    const credit = stripHtml(meta.Artist?.value) || stripHtml(meta.Credit?.value);
    const url = ii.thumburl ?? ii.url;
    if (!licence || !credit || !/^https:\/\/upload\.wikimedia\.org\//.test(url ?? '') || !/^https:\/\/commons\.wikimedia\.org\//.test(ii.descriptionurl ?? '')) continue;
    photos.push({ title: String(p.title ?? '').replace(/^File:/, ''), url, pageUrl: ii.descriptionurl, licence: licence.slice(0, 100), credit: credit.slice(0, 200) });
  }
  return { photos, error: null };
}

export function photoCredit(school) {
  if (!school?.photo_url) return '';
  if (school.photo_source === 'wikimedia') return `Photo: ${school.photo_credit}, ${school.photo_licence}, via Wikimedia Commons`;
  return school.photo_credit ? `Photo: ${school.photo_credit}` : 'Photo from the school';
}

// ---- staff (Kidscover admins only) ----
export async function loadStaff(db, schoolId) {
  const { data, error } = await db.from('school_staff').select('user_id, added_at, profiles(first_name, last_name, email)').eq('school_id', schoolId);
  const staff = (data ?? []).map((r) => {
    const p = (Array.isArray(r.profiles) ? r.profiles[0] : r.profiles) ?? {};
    return { userId: r.user_id, name: [p.first_name, p.last_name].filter(Boolean).join(' ') || '(no name)', email: p.email ?? '', addedAt: r.added_at };
  });
  return { staff, error: error ?? null };
}
export async function addStaff(db, schoolId, email) {
  const e = String(email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { error: { message: 'Enter the email address they signed up with.' } };
  const { error } = await db.rpc('add_school_staff', { p_school: schoolId, p_email: e });
  return { error: error ?? null };
}
export async function removeStaff(db, schoolId, userId) {
  const { error } = await db.rpc('remove_school_staff', { p_school: schoolId, p_user: userId });
  return { error: error ?? null };
}

// ---- the change log ----
export async function loadChanges(db, schoolId = null, limit = 30) {
  let q = db.from('school_change_log').select('id, school_id, what, record_key, action, before, after, changed_by, changed_by_role, changed_at, reverts, reverted_at, schools(name)');
  if (schoolId) q = q.eq('school_id', schoolId);
  const { data, error } = await q.order('changed_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
  return { changes: (data ?? []).map((c) => ({ ...c, schoolName: (Array.isArray(c.schools) ? c.schools[0] : c.schools)?.name ?? '' })), error: error ?? null };
}
export async function revertChange(db, logId) {
  const { error } = await db.rpc('revert_school_change', { p_log: logId });
  return { error: error ?? null };
}

const facilityText = (v) => (v?.detail ? `${facilityLabel(v.facility)} (${v.detail})` : facilityLabel(v?.facility));
const clip = (s, n = 80) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '\u2026' : String(s ?? ''));
export function describeChange(c) {
  const verb = c.action === 'added' ? 'added' : c.action === 'removed' ? 'removed' : 'changed';
  if (c.what === 'facility') {
    if (c.action === 'changed') return `${facilityLabel(c.record_key)} changed: ${c.before?.detail ?? 'no detail'} \u2192 ${c.after?.detail ?? 'no detail'}`;
    return `${facilityText(c.after ?? c.before)} ${verb}`;
  }
  if (c.what === 'achievement') {
    const v = c.after ?? c.before ?? {};
    return `${kindLabel(v.kind)} ${verb}: \u201c${clip(v.text)}\u201d${v.year ? ` (${v.year})` : ''}`;
  }
  if (c.what === 'photo') return c.action === 'removed' ? 'Photo removed' : `Photo ${verb} (${c.after?.source === 'wikimedia' ? 'Wikimedia Commons' : 'uploaded by the school'})`;
  if (c.what === 'staff') return `Staff member ${verb}`;
  if (c.what === 'fees' || c.what === 'start_time') return describeFeeChange(c);
  if (c.what === 'levels') {
    if (c.action === 'removed') return `Levels back to automatic (were set to ${levelsText(c.before?.levels)})`;
    if (c.action === 'changed') return `Levels changed: ${levelsText(c.before?.levels)} \u2192 ${levelsText(c.after?.levels)}`;
    return `Levels set to ${levelsText(c.after?.levels)}`;
  }
  return `${c.what} ${verb}`;
}
export const whoText = (c) => (c.changed_by_role === 'admin' ? 'Kidscover admin' : c.changed_by_role === 'school_admin' ? 'school staff' : 'system');
export const canRevert = (c) => c.what !== 'staff' && !c.reverted_at;
