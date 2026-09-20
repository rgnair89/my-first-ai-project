// supabase/functions/commute-times/index.ts
//
// Drive time by car from where a parent is to the schools on their screen, from Google's Routes API.
// Self-contained: paste this whole file into the dashboard editor as a new function called "commute-times".
//
// Before it can work (once):
//   1. Run supabase/migrations/20260919000700_drive_times.sql in the SQL editor (the daily limits live there).
//   2. In Google Cloud (the project whose key is in GOOGLE_MAPS_API_KEY): APIs & Services > Library > "Routes API" >
//      Enable. If that key has "API restrictions", add Routes API to its list.
// Secrets it reads: GOOGLE_MAPS_API_KEY (already set for the school importer). No Supabase secret key: the function
// talks to the database AS THE PARENT who called it, so the database rules (hidden schools, limits) apply to it.
//
// Request (POST, from the signed-in app): { "lat": 19.076, "lng": 72.878, "schoolIds": ["uuid", ...], "when": "school_run" | "now" | "arrive" }
//   at most 20 schools; the position must be inside the Mumbai region; it is rounded to about 100 m here as well.
//   "school_run" = leaving at 7:30 am India time on the next weekday (Google can only plan car trips by departure
//   time, not "arrive by"); "now" = leaving now; "arrive" = in time for each school's own start of day, so the answer
//   also says when to leave home. A school whose start time nobody has given is taken as 8:00 am, and says so.
// Answer (always HTTP 200 unless something crashed):
//   { ok: true, when, departure, times: { "<schoolId>": { minutes, km, leaveBy?, startTime?, assumedStart? } | null }, lookupsLeft }
//   { ok: false, code } with code one of: bad_request, outside_area, too_many_schools, sign_in, confirm_email,
//   user_limit, daily_budget, switched_off, not_configured, routes_not_enabled, google_key_blocked,
//   google_key_invalid, google_busy, google_timeout, google_error, failed. Admins also get a "detail" to fix setup.
//
// Privacy: the parent's position goes to Google for this one calculation. It is not written to the database and not
// logged here. The database only counts how many lookups each parent made today.
// Cost: Google bills per school looked up. The limits in commute_settings cap it (default 500 schools a day).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ==== BEGIN testable logic (must not use imports or Deno globals) ====

const ROUTES_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const FIELD_MASK = "originIndex,destinationIndex,duration,distanceMeters,condition,status";
// The same box the school importer is limited to. A position outside it would only buy answers about schools far away.
const SERVICE_AREA = { latMin: 18.5, latMax: 19.7, lngMin: 72.5, lngMax: 73.5 };
const MAX_SCHOOLS = 20;
// "arrive" needs one Google lookup per start time on the screen, so only the four commonest are worked out.
const MAX_START_GROUPS = 4;
const DEFAULT_START_MINUTES = 8 * 60;   // when nobody has said when the school day starts
const LEAVE_EARLY_MINUTES = 45;         // the traffic is asked about 45 minutes before the bell
const GOOGLE_TIMEOUT_MS = 12000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IST_OFFSET_MS = 330 * 60 * 1000; // India is UTC+5:30 all year

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

type Parsed = { lat: number; lng: number; ids: string[]; when: "school_run" | "now" | "arrive" };

function inArea(lat: number, lng: number): boolean {
  return lat >= SERVICE_AREA.latMin && lat <= SERVICE_AREA.latMax && lng >= SERVICE_AREA.lngMin && lng <= SERVICE_AREA.lngMax;
}

// Checks what the app sent. Returns the cleaned request, or { code } saying what is wrong.
function parseRequest(body: any): Parsed | { code: string } {
  if (!body || typeof body !== "object") return { code: "bad_request" };
  const { lat, lng, schoolIds, when } = body;
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return { code: "bad_request" };
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { code: "bad_request" };
  if (!inArea(lat, lng)) return { code: "outside_area" };
  if (!Array.isArray(schoolIds) || schoolIds.length === 0) return { code: "bad_request" };
  if (!schoolIds.every((x: unknown) => typeof x === "string" && UUID.test(x))) return { code: "bad_request" };
  const ids = [...new Set(schoolIds.map((x: string) => x.toLowerCase()))];
  if (ids.length > MAX_SCHOOLS) return { code: "too_many_schools" };
  const w = when ?? "school_run";
  if (w !== "school_run" && w !== "now" && w !== "arrive") return { code: "bad_request" };
  // never send Google more than about 100 m of precision, whatever the app sent
  return { lat: Math.round(lat * 1000) / 1000, lng: Math.round(lng * 1000) / 1000, ids, when: w };
}

// A given time of day (in minutes after midnight, India time) on the next weekday that is still far enough away.
// Google refuses a departure time in the past for car trips, and a weekday morning is when the school run happens.
function nextWeekdayAt(now: Date, minutesOfDay: number, aheadMinutes = 15): Date {
  const earliest = now.getTime() + aheadMinutes * 60 * 1000;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  for (let add = 0; add < 8; add++) {
    const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add));
    const weekday = day.getUTCDay(); // the India date's day of the week
    if (weekday === 0 || weekday === 6) continue;
    const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, minutesOfDay) - IST_OFFSET_MS;
    if (at >= earliest) return new Date(at);
  }
  throw new Error("no weekday found"); // cannot happen: a week always has a weekday
}

const schoolRunDeparture = (now: Date): Date => nextWeekdayAt(now, 7 * 60 + 30);

// "08:15:00" (or "08:15") as minutes after midnight, or null if it is not a time.
function startMinutes(value: unknown): number | null {
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])(:[0-5][0-9])?$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// For "arrive": the schools on the screen, gathered by the time their day starts, commonest first, at most four
// groups (each group costs one Google lookup). Schools in the groups left over get no time rather than a wrong one.
function startGroups(schools: any[], max = MAX_START_GROUPS): { minutes: number; assumed: boolean; schools: any[] }[] {
  const byStart = new Map<number, { minutes: number; assumed: boolean; schools: any[] }>();
  for (const s of schools) {
    const own = startMinutes(s?.start_time);
    const minutes = own ?? DEFAULT_START_MINUTES;
    const key = own === null ? -1 : minutes;          // "not told" is its own group, even at 8:00
    if (!byStart.has(key)) byStart.set(key, { minutes, assumed: own === null, schools: [] });
    byStart.get(key)!.schools.push(s);
  }
  return [...byStart.values()].sort((a, b) => b.schools.length - a.schools.length || a.minutes - b.minutes).slice(0, max);
}

// Google writes durations as "712s" (sometimes with decimals).
function parseSeconds(d: unknown): number | null {
  if (typeof d !== "string") return null;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(d.trim());
  return m ? Number(m[1]) : null;
}

type Time = { minutes: number; km: number } | null;

// Turns Google's list of results into { schoolId: { minutes, km } | null }. Google leaves out an index of 0 (its JSON
// drops zero values), so a missing destinationIndex means the first school. No route, or an error on one school, gives
// null for that school instead of a made-up number.
function readMatrix(elements: unknown, destIds: string[]): Record<string, Time> {
  const out: Record<string, Time> = Object.fromEntries(destIds.map((id) => [id, null]));
  if (!Array.isArray(elements)) return out;
  for (const el of elements as any[]) {
    if (!el || typeof el !== "object") continue;
    const di = el.destinationIndex ?? 0;
    const oi = el.originIndex ?? 0;
    if (!Number.isInteger(di) || di < 0 || di >= destIds.length || oi !== 0) continue;
    if (el.status && el.status.code) continue;
    if (el.condition !== "ROUTE_EXISTS") continue;
    const sec = parseSeconds(el.duration);
    if (sec === null) continue;
    const meters = typeof el.distanceMeters === "number" ? el.distanceMeters : 0;
    out[destIds[di]] = { minutes: Math.max(1, Math.round(sec / 60)), km: Math.round(meters / 100) / 10 };
  }
  return out;
}

// What went wrong at Google, in a word the app can turn into a sentence.
function googleProblem(status: number, text: string): string {
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(text)) return "google_busy";
  if (/API_KEY_INVALID|API key not valid/i.test(text)) return "google_key_invalid";
  if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(text)) return "routes_not_enabled";
  if (/API_KEY_SERVICE_BLOCKED|API_KEY_HTTP_REFERRER_BLOCKED|API_KEY_IP_ADDRESS_BLOCKED|are blocked/i.test(text)) return "google_key_blocked";
  if (status === 403) return "routes_not_enabled";
  return "google_error";
}

const hasCoords = (r: any) => {
  const lat = Number(r?.latitude), lng = Number(r?.longitude);
  return r?.latitude != null && r?.longitude != null && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
};

type Deps = {
  env: { get(name: string): string | undefined };
  fetch: typeof fetch;
  createClient: (url: string, key: string, options?: any) => any;
  now: () => Date;
};

function createHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ ok: false, code: "bad_request" }, 405);
    try {
      let body: unknown = null;
      try { body = await req.json(); } catch { /* no body */ }
      const parsed = parseRequest(body);
      if ("code" in parsed) return json({ ok: false, code: parsed.code });

      // Talk to the database as the parent: their own sign-in and the app's public key, nothing more powerful.
      const authHeader = req.headers.get("Authorization") ?? "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (!token) return json({ ok: false, code: "sign_in" });
      const apikey = req.headers.get("apikey") ?? deps.env.get("SUPABASE_ANON_KEY") ?? "";
      const db = deps.createClient(deps.env.get("SUPABASE_URL") ?? "", apikey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: who, error: whoErr } = await db.auth.getUser(token);
      const user = who?.user;
      if (whoErr || !user) return json({ ok: false, code: "sign_in" });
      const { data: profile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
      const isAdmin = profile?.role === "admin";
      const detail = (d: string) => (isAdmin ? { detail: d.slice(0, 500) } : {});

      // The schools as this parent may see them: hidden places are left out by the database rules and here too.
      const { data: rows, error: schoolErr } = await db.from("schools").select("id,latitude,longitude,start_time").in("id", parsed.ids).eq("is_hidden", false);
      if (schoolErr) return json({ ok: false, code: "failed", ...detail(schoolErr.message) }, 500);
      const byId = new Map((rows ?? []).map((r: any) => [String(r.id).toLowerCase(), r]));
      const dests = parsed.ids.map((id) => byId.get(id)).filter(hasCoords) as any[];
      if (dests.length === 0) return json({ ok: true, when: parsed.when, departure: null, times: {}, lookupsLeft: null });

      const key = deps.env.get("GOOGLE_MAPS_API_KEY") ?? "";
      if (!key) return json({ ok: false, code: "not_configured", ...detail("The GOOGLE_MAPS_API_KEY secret is missing in Supabase.") });

      // One trip to Google for "now" and "school_run"; for "arrive", one per start time on the screen.
      const groups = parsed.when === "arrive"
        ? startGroups(dests).map((g) => {
            const arrive = nextWeekdayAt(deps.now(), g.minutes, LEAVE_EARLY_MINUTES + 15);
            return { ...g, arrive, departure: new Date(arrive.getTime() - LEAVE_EARLY_MINUTES * 60 * 1000) };
          })
        : [{ minutes: 0, assumed: false, schools: dests, arrive: null as Date | null,
             departure: parsed.when === "school_run" ? schoolRunDeparture(deps.now()) : null }];
      const elementCount = groups.reduce((n, g) => n + g.schools.length, 0);

      // Take the allowance BEFORE calling Google, so a burst of requests cannot slip past the limits.
      const quota = await db.rpc("take_commute_quota", { p_elements: elementCount });
      if (quota.error) {
        const msg = String(quota.error.message ?? "");
        const missing = /take_commute_quota|schema cache|PGRST202|does not exist/i.test(msg) || quota.error.code === "PGRST202";
        return json({ ok: false, code: missing ? "not_configured" : "failed", ...detail(missing ? "Run the 20260919000700_drive_times.sql migration." : msg) });
      }
      if (!quota.data?.ok) return json({ ok: false, code: quota.data?.reason ?? "failed", ...(quota.data?.limit ? { limit: quota.data.limit } : {}) });

      const askGoogle = async (group: typeof groups[number]) => {
        const googleBody = {
          origins: [{ waypoint: { location: { latLng: { latitude: parsed.lat, longitude: parsed.lng } } } }],
          destinations: group.schools.map((d) => ({ waypoint: { location: { latLng: { latitude: Number(d.latitude), longitude: Number(d.longitude) } } } })),
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
          ...(group.departure ? { departureTime: group.departure.toISOString() } : {}),
        };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), GOOGLE_TIMEOUT_MS);
        try {
          const res = await deps.fetch(ROUTES_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
            body: JSON.stringify(googleBody),
            signal: ctrl.signal,
          });
          const text = await res.text();
          if (!res.ok) return { problem: googleProblem(res.status, text), text };
          try { return { elements: JSON.parse(text) }; } catch { return { problem: "google_error", text }; }
        } catch (e) {
          return { problem: (e as any)?.name === "AbortError" ? "google_timeout" : "google_error", text: "" };
        } finally {
          clearTimeout(timer);
        }
      };

      const answers = await Promise.all(groups.map(askGoogle));
      const firstProblem = answers.find((a) => (a as any).problem) as any;
      if (firstProblem && answers.every((a) => (a as any).problem)) {
        return json({ ok: false, code: firstProblem.problem, ...detail(firstProblem.text ?? "") });
      }

      const times: Record<string, any> = {};
      groups.forEach((group, i) => {
        const answer = answers[i] as any;
        const ids = group.schools.map((d) => String(d.id).toLowerCase());
        const got = answer.elements ? readMatrix(answer.elements, ids) : Object.fromEntries(ids.map((id) => [id, null]));
        for (const id of ids) {
          const t = got[id];
          if (t && group.arrive) {
            times[id] = {
              ...t,
              startTime: hhmm(group.minutes),
              assumedStart: group.assumed,
              leaveBy: new Date(group.arrive.getTime() - t.minutes * 60 * 1000).toISOString(),
              arriveBy: group.arrive.toISOString(),
            };
          } else {
            times[id] = t;
          }
        }
      });

      return json({
        ok: true,
        when: parsed.when,
        departure: groups[0].departure ? groups[0].departure.toISOString() : null,
        times,
        lookupsLeft: quota.data.lookups_left ?? null,
      });
    } catch (_err) {
      return json({ ok: false, code: "failed" }, 500);
    }
  };
}

// ==== END testable logic ====

Deno.serve(
  createHandler({
    env: Deno.env,
    fetch,
    createClient,
    now: () => new Date(),
  }),
);
