// Logic for admission applications, the school's own admissions system (CRM) and the count of visits to a school's
// website. No React and no network here, so it can be tested on its own.

export const STAGES = [
  { key: 'submitted', label: 'New', tone: 'blue', next: true },
  { key: 'in_review', label: 'Being looked at', tone: 'blue', next: true },
  { key: 'visit_scheduled', label: 'Visit arranged', tone: 'blue', next: true },
  { key: 'offered', label: 'A place is offered', tone: 'green', next: true },
  { key: 'waitlisted', label: 'On the waiting list', tone: 'amber', next: true },
  { key: 'accepted', label: 'Accepted', tone: 'green', next: true },
  { key: 'declined', label: 'Not offered a place', tone: 'red', next: true },
  { key: 'withdrawn', label: 'Withdrawn by the family', tone: 'grey', next: false },
];
// The stages a school may choose; 'submitted' is where every application starts and 'withdrawn' is the family's own.
export const CHOOSABLE_STAGES = STAGES.filter((s) => s.next && s.key !== 'submitted');
export const stageLabel = (key) => STAGES.find((s) => s.key === key)?.label ?? key;
export const stageTone = (key) => STAGES.find((s) => s.key === key)?.tone ?? 'grey';

export const CLASSES = [
  ['playgroup', 'Playgroup'], ['nursery', 'Nursery'], ['jr_kg', 'Junior KG'], ['sr_kg', 'Senior KG'],
  ['class_1', 'Class 1'], ['class_2', 'Class 2'], ['class_3', 'Class 3'], ['class_4', 'Class 4'], ['class_5', 'Class 5'],
  ['class_6', 'Class 6'], ['class_7', 'Class 7'], ['class_8', 'Class 8'], ['class_9', 'Class 9'], ['class_10', 'Class 10'],
  ['class_11', 'Class 11'], ['class_12', 'Class 12'],
];
export const classLabel = (key) => CLASSES.find(([k]) => k === key)?.[1] ?? key;

export const APPLICATION_COLUMNS = 'id, school_id, parent_id, status, status_note, child_first_name, child_last_name, '
  + 'child_dob, child_gender, class_applying, academic_year, current_school, parent_name, parent_relation, parent_phone, '
  + 'parent_email, address, pincode, notes, consent_at, created_at, updated_at, schools(name)';

export const RELATIONS = { mother: 'Mother', father: 'Father', guardian: 'Guardian' };

export function normalize(row) {
  const school = Array.isArray(row.schools) ? row.schools[0] : row.schools;
  return {
    id: row.id,
    schoolId: row.school_id,
    schoolName: school?.name ?? '',
    status: row.status,
    statusNote: row.status_note ?? '',
    childName: [row.child_first_name, row.child_last_name].filter(Boolean).join(' '),
    dob: row.child_dob,
    gender: row.child_gender ?? '',
    className: classLabel(row.class_applying),
    year: row.academic_year,
    currentSchool: row.current_school ?? '',
    parentName: row.parent_name,
    relation: RELATIONS[row.parent_relation] ?? row.parent_relation,
    phone: row.parent_phone,
    email: row.parent_email,
    address: row.address,
    pincode: row.pincode,
    notes: row.notes ?? '',
    consentAt: row.consent_at,
    createdAt: row.created_at,
  };
}

// Age in whole years on the first of June of the year applied for, which is how schools think about it.
export function ageAtStart(dob, academicYear) {
  const born = new Date(dob);
  const start = Number(String(academicYear ?? '').slice(0, 4));
  if (Number.isNaN(born.getTime()) || !start) return null;
  const on = new Date(Date.UTC(start, 5, 1));
  let age = on.getUTCFullYear() - born.getUTCFullYear();
  if (on.getUTCMonth() < born.getUTCMonth() || (on.getUTCMonth() === born.getUTCMonth() && on.getUTCDate() < born.getUTCDate())) age -= 1;
  return age >= 0 && age < 25 ? age : null;
}

export const inStage = (app, view) => (view === 'open' ? !['accepted', 'declined', 'withdrawn'].includes(app.status) : view === 'all' ? true : app.status === view);

export function countByStage(apps) {
  const counts = { all: apps.length, open: apps.filter((a) => inStage(a, 'open')).length };
  for (const s of STAGES) counts[s.key] = apps.filter((a) => a.status === s.key).length;
  return counts;
}

export function friendlyError(error) {
  const msg = String(error?.message ?? error ?? '');
  if (/only update applications to your own school|your own school|row-level security|permission denied|42501/i.test(msg)) {
    return 'You can only work on applications to your own school.';
  }
  if (/withdrew/i.test(msg)) return 'The family withdrew this application, so it cannot be moved on.';
  if (/admission_applications|set_admission_status|crm|outbound|schema cache|PGRST202/i.test(msg)) {
    return 'Run the 20260920000300_partner_schools.sql migration first.';
  }
  if (/network|failed to fetch/i.test(msg)) return 'Could not reach the server. Check the connection and try again.';
  return msg || 'Something went wrong.';
}

// ---- reading ----
export async function loadApplications(db, { schoolId = null, limit = 200 } = {}) {
  let q = db.from('admission_applications').select(APPLICATION_COLUMNS).order('created_at', { ascending: false }).limit(limit);
  if (schoolId) q = q.eq('school_id', schoolId);
  const { data, error } = await q;
  return { applications: (data ?? []).map(normalize), error: error ?? null };
}

export async function loadApplicationEvents(db, applicationId) {
  const { data, error } = await db.from('admission_application_events').select('id, status, note, by_role, at')
    .eq('application_id', applicationId).order('at', { ascending: true }).limit(100);
  return { events: data ?? [], error: error ?? null };
}

export async function setStage(db, applicationId, status, note) {
  if (!CHOOSABLE_STAGES.some((s) => s.key === status)) return { error: { message: 'Choose a stage for this application.' } };
  const text = String(note ?? '').trim();
  if (text.length > 500) return { error: { message: 'Keep the note to the family under 500 characters.' } };
  const { error } = await db.rpc('set_admission_status', { p_app: applicationId, p_status: status, p_note: text || null });
  return { error: error ?? null };
}

export const whoDid = (role) => (role === 'parent' ? 'the family' : role === 'school' ? 'the school' : 'Kidscover');

// ---- the school's own admissions system ----
export const CRM_COLUMNS = 'school_id, url, enabled, updated_at, last_success_at, last_failure_at, last_error';
export const DELIVERY_COLUMNS = 'id, school_id, application_id, event, status, attempts, http_status, last_error, created_at, delivered_at';

export function checkWebhookUrl(url) {
  const u = String(url ?? '').trim();
  if (!u) return 'Paste the https address the school gave you.';
  if (u.length > 500) return 'That address is too long.';
  if (!/^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(:443)?(\/[^\s]*)?$/i.test(u)) {
    return 'Use an https web address with a real host name (not an IP address, and not localhost).';
  }
  if (/^https:\/\/[^/]*\.(local|localhost|internal|intranet|lan|home|corp|arpa)(:443)?(\/|$)/i.test(u)) {
    return 'That address is inside a private network, so Kidscover cannot reach it.';
  }
  return '';
}

export async function loadCrm(db, schoolId) {
  const [hook, deliveries] = await Promise.all([
    db.from('school_crm_webhooks').select(CRM_COLUMNS).eq('school_id', schoolId).maybeSingle(),
    db.from('crm_deliveries').select(DELIVERY_COLUMNS).eq('school_id', schoolId).order('id', { ascending: false }).limit(20),
  ]);
  const error = hook.error ?? deliveries.error ?? null;
  return { crm: hook.data ?? null, deliveries: deliveries.data ?? [], error };
}

export async function saveCrm(db, schoolId, url, enabled = true) {
  const problem = checkWebhookUrl(url);
  if (problem) return { error: { message: problem } };
  const { data, error } = await db.rpc('set_crm_webhook', { p_school: schoolId, p_url: String(url).trim(), p_enabled: !!enabled });
  return { secret: data ?? null, error: error ?? null };
}

export async function rotateCrmSecret(db, schoolId) {
  const { data, error } = await db.rpc('rotate_crm_secret', { p_school: schoolId });
  return { secret: data ?? null, error: error ?? null };
}
export const removeCrm = async (db, schoolId) => ({ error: (await db.rpc('remove_crm_webhook', { p_school: schoolId })).error ?? null });
export const sendCrmTest = async (db, schoolId) => ({ error: (await db.rpc('queue_crm_test', { p_school: schoolId })).error ?? null });
export const retryDelivery = async (db, id) => ({ error: (await db.rpc('retry_crm_delivery', { p_id: id })).error ?? null });

export function deliveryText(d) {
  const what = d.event === 'webhook.test' ? 'Test message' : d.event === 'application.withdrawn' ? 'Withdrawal' : 'Application';
  if (d.status === 'delivered') return `${what}: delivered`;
  if (d.status === 'failed') return `${what}: could not be delivered after ${d.attempts} tries (${d.last_error ?? 'no reason given'})`;
  if (d.status === 'sending') return `${what}: being sent`;
  return `${what}: waiting to be sent${d.attempts ? ` (tried ${d.attempts} times)` : ''}`;
}

// ---- how many families went on to the school's own pages ----
export const CLICK_KINDS = { website: 'Opened the school website', admission_page: 'Opened the admissions page', fee_page: 'Opened the fees page', directions: 'Asked for directions' };

export async function loadClickStats(db, schoolId = null, days = 30) {
  const { data, error } = await db.rpc('outbound_click_stats', { p_school: schoolId, p_days: days });
  return { stats: (data ?? []).map((r) => ({ ...r, clicks: Number(r.clicks), people: Number(r.people) })), error: error ?? null };
}

// Asks the CRM sender to run now, so a family's application reaches the school straight away. A problem here never
// stops the thing the person was doing: the queue is tried again later anyway.
export async function nudgeSender(db, which = 'crm-deliver') {
  try {
    const { error } = await db.functions.invoke(which, { body: {} });
    return { error: error ?? null };
  } catch (e) {
    return { error: e };
  }
}
