// Logic for the Drive times card in the Partner Portal. No React and no network here, so it can be tested on its own.

// A fixed point in Bandra Kurla Complex for the test, so it never uses anyone's real location.
export const TEST_POINT = { lat: 19.066, lng: 72.868 };

// What each answer from the commute-times function means for the person setting it up.
export function explainCode(code) {
  switch (code) {
    case 'not_deployed': return 'The commute-times function is not deployed yet. In Supabase: Edge Functions > Deploy a new function > name it commute-times > paste supabase/functions/commute-times/index.ts.';
    case 'not_configured': return 'Something is missing in the setup. Run the 20260919000700_drive_times.sql migration, and check the GOOGLE_MAPS_API_KEY secret in Supabase. The detail below says which.';
    case 'routes_not_enabled': return 'Google says the Routes API is not switched on. In Google Cloud: APIs & Services > Library > Routes API > Enable (same project as the Places key).';
    case 'google_key_blocked': return 'The Google key is limited to other APIs. In Google Cloud: Credentials > your key > API restrictions > add Routes API.';
    case 'google_key_invalid': return 'Google does not accept the key in GOOGLE_MAPS_API_KEY. Check the secret in Supabase.';
    case 'switched_off': return 'Drive times are switched off in commute_settings.';
    case 'daily_budget': return 'Today\'s drive-time budget is used up. It resets at midnight India time.';
    case 'user_limit': return 'Your own account has used today\'s lookups. It resets at midnight India time.';
    case 'confirm_email': return 'This admin account has no confirmed email, which drive times require.';
    case 'google_busy': case 'google_timeout': case 'google_error': case 'network': return 'Google did not answer properly just now. Try again in a minute.';
    case 'sign_in': return 'Your sign-in was not accepted. Sign out and in again.';
    default: return 'Something went wrong. The detail below may say more.';
  }
}

// Runs one small test lookup (3 schools, "right now"). Returns { ok, code, message, detail, results }.
export async function testDriveTimes(db) {
  const { data: schools, error } = await db.from('schools').select('id,name,latitude,longitude')
    .eq('is_hidden', false).not('latitude', 'is', null).not('longitude', 'is', null).order('name_sort', { ascending: true }).limit(3);
  if (error) return { ok: false, code: 'failed', message: 'Could not read schools to test with.', detail: error.message };
  if (!schools?.length) return { ok: false, code: 'failed', message: 'There are no schools with coordinates to test with.' };
  let res;
  try {
    res = await db.functions.invoke('commute-times', { body: { ...TEST_POINT, schoolIds: schools.map((s) => s.id), when: 'now' } });
  } catch (e) {
    return { ok: false, code: 'network', message: explainCode('network'), detail: String(e?.message ?? e) };
  }
  const { data, error: fnError } = res ?? {};
  if (fnError) {
    const code = fnError.context?.status === 404 ? 'not_deployed' : fnError.name === 'FunctionsFetchError' ? 'network' : 'failed';
    return { ok: false, code, message: explainCode(code), detail: String(fnError.message ?? '') };
  }
  if (!data?.ok) return { ok: false, code: data?.code ?? 'failed', message: explainCode(data?.code), detail: data?.detail ?? '' };
  const results = schools.map((s) => ({ name: s.name, time: data.times?.[s.id] ?? data.times?.[String(s.id).toLowerCase()] ?? null }));
  return { ok: true, code: 'ok', message: 'Drive times work. Google answered for the test schools below.', results, lookupsLeft: data.lookupsLeft ?? null };
}

// Today's use and the limits. Both tables are readable by admins only.
export async function loadUsage(db, today) {
  const [settings, usage] = await Promise.all([
    db.from('commute_settings').select('enabled,per_user_daily_lookups,global_daily_elements,max_schools_per_lookup').maybeSingle(),
    db.from('commute_usage_daily').select('day,lookups,elements').order('day', { ascending: false }).limit(7),
  ]);
  if (settings.error || usage.error) return { error: settings.error ?? usage.error };
  const rows = usage.data ?? [];
  const todayRow = rows.find((r) => r.day === today) ?? { day: today, lookups: 0, elements: 0 };
  return { settings: settings.data, today: todayRow, week: rows, error: null };
}

// The date in India, as the database counts days (YYYY-MM-DD).
export function indiaToday(now = new Date()) {
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
}

export function usageLine(today, settings) {
  if (!settings) return '';
  const pct = settings.global_daily_elements > 0 ? Math.round((100 * today.elements) / settings.global_daily_elements) : 0;
  return `Today: ${today.lookups} ${today.lookups === 1 ? 'lookup' : 'lookups'}, ${today.elements} of ${settings.global_daily_elements} schools (${pct}%)`;
}

export function minutesText(t) {
  if (!t || typeof t.minutes !== 'number') return 'no road found';
  return `${t.minutes} min, ${t.km} km`;
}
