// Logic for fees and the start of the school day. No React and no network here, so it can be tested on its own.
// Every function that talks to the database takes the client as an argument.

export const FEE_LEVELS = [
  { key: 'daycare', label: 'Daycare' },
  { key: 'preschool', label: 'Preschool (nursery, KG)' },
  { key: 'primary', label: 'Primary (classes 1 to 7)' },
  { key: 'secondary', label: 'Secondary (classes 8 to 12)' },
];

// The parts of the true cost of a year at a school. "Every year" ones repeat; the one-time ones are paid on joining.
export const FEE_PARTS = [
  { key: 'tuition', label: 'Tuition', when: 'year', required: true },
  { key: 'transport', label: 'School bus', when: 'year' },
  { key: 'meals', label: 'Meals', when: 'year' },
  { key: 'uniform_books', label: 'Uniform and books', when: 'year' },
  { key: 'activities', label: 'Activities and trips', when: 'year' },
  { key: 'other_annual', label: 'Other yearly fees', when: 'year' },
  { key: 'admission_fee', label: 'Admission fee', when: 'once' },
  { key: 'registration_fee', label: 'Registration fee', when: 'once' },
  { key: 'deposit', label: 'Refundable deposit', when: 'deposit' },
];
export const FEE_COLUMNS = 'level, academic_year, tuition, transport, meals, uniform_books, activities, other_annual, '
  + 'admission_fee, registration_fee, deposit, annual_total, first_year_total, note, source, source_url, updated_at';

export const MAX_FEE = 5000000;
export const levelLabel = (key) => FEE_LEVELS.find((l) => l.key === key)?.label ?? key;

// Indian grouping, as a family reads it: 2,33,000.
export function rupees(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
  } catch {
    return `₹${Math.round(n)}`;
  }
}

// "2026-27" for the year that starts this June, unless we are already past March.
export function currentAcademicYear(today = new Date()) {
  const start = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function academicYearChoices(today = new Date()) {
  const start = Number(currentAcademicYear(today).slice(0, 4));
  return [start - 1, start, start + 1, start + 2].map((y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`);
}

const amount = (value) => {
  const text = String(value ?? '').replace(/[,\s₹]/g, '');
  if (text === '') return 0;
  if (!/^\d{1,7}$/.test(text)) return NaN;
  return Number(text);
};

// What the family pays in the first year, and every year after it, from a form or a saved row.
export function feeTotals(form) {
  const part = (k) => amount(form?.[k]) || 0;
  const yearly = ['tuition', 'transport', 'meals', 'uniform_books', 'activities', 'other_annual'].reduce((n, k) => n + part(k), 0);
  return { yearly, firstYear: yearly + part('admission_fee') + part('registration_fee'), deposit: part('deposit') };
}

export function checkFees(form) {
  for (const p of FEE_PARTS) {
    const value = amount(form?.[p.key]);
    if (Number.isNaN(value)) return `${p.label}: use whole rupees, with no decimal point.`;
    if (value > MAX_FEE) return `${p.label}: that looks too high (the most is ${rupees(MAX_FEE)}).`;
  }
  if (!amount(form?.tuition)) return 'Give the tuition fee for the year.';
  if (!/^20\d\d-\d\d$/.test(String(form?.academic_year ?? ''))) return 'Choose the academic year.';
  if (String(form?.note ?? '').length > 200) return 'Keep the note under 200 characters.';
  const url = String(form?.source_url ?? '').trim();
  if (url && !/^https?:\/\//i.test(url)) return 'The link must start with http:// or https://';
  return '';
}

export async function setFees(db, schoolId, level, form) {
  if (form === null) return { error: (await db.rpc('set_school_fees', { p_school: schoolId, p_level: level, p_fees: null })).error ?? null };
  const problem = checkFees(form);
  if (problem) return { error: { message: problem } };
  const fees = { academic_year: form.academic_year };
  for (const p of FEE_PARTS) fees[p.key] = amount(form[p.key]) || 0;
  const note = String(form.note ?? '').trim();
  const url = String(form.source_url ?? '').trim();
  if (note) fees.note = note;
  if (url) fees.source_url = url;
  const { error } = await db.rpc('set_school_fees', { p_school: schoolId, p_level: level, p_fees: fees });
  return { error: error ?? null };
}

export async function loadFees(db, schoolId) {
  const { data, error } = await db.from('school_fee_schedules').select(FEE_COLUMNS).eq('school_id', schoolId);
  const byLevel = Object.fromEntries((data ?? []).map((row) => [row.level, row]));
  return { fees: byLevel, error: error ?? null };
}

// ---- when the school day starts ----
export function checkStartTime(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(t)) return 'Give the start time like 08:15.';
  const minutes = Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
  if (minutes < 6 * 60 || minutes > 11 * 60) return 'The school day should start between 06:00 and 11:00.';
  return '';
}

export async function setStartTime(db, schoolId, text) {
  const value = String(text ?? '').trim();
  const problem = checkStartTime(value);
  if (problem) return { error: { message: problem } };
  const { error } = await db.rpc('set_school_start_time', { p_school: schoolId, p_time: value || null });
  return { error: error ?? null };
}

export const startTimeText = (school) => {
  const t = String(school?.start_time ?? '').slice(0, 5);
  if (!t) return 'Not known yet, so drive times assume 8:00 am.';
  const by = school.start_time_source === 'school' ? 'the school' : school.start_time_source === 'kidscover' ? 'Kidscover' : 'the school website';
  return `The school day starts at ${t}, from ${by}.`;
};

// What the change history says about a fee or start-time change.
export function describeFeeChange(c) {
  const verb = c.action === 'added' ? 'added' : c.action === 'removed' ? 'removed' : 'changed';
  if (c.what === 'fees') {
    const after = c.after ?? c.before ?? {};
    const totals = feeTotals(after);
    return `${levelLabel(c.record_key).replace(/ \(.*\)$/, '')} fees ${verb} (${rupees(totals.firstYear)} in the first year)`;
  }
  const t = (c.after ?? c.before ?? {}).time;
  return c.action === 'removed' ? 'Start of the school day removed' : `Start of the school day ${verb} to ${String(t ?? '').slice(0, 5)}`;
}
