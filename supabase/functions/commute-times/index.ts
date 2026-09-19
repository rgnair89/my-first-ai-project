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
// Request (POST, from the signed-in app): { "lat": 19.076, "lng": 72.878, "schoolIds": ["uuid", ...], "when": "school_run" | "now" }
//   at most 20 schools; the position must be inside the Mumbai region; it is rounded to about 100 m here as well.
//   "school_run" = leaving at 7:30 am India time on the next weekday (Google can only plan car trips by departure
//   time, not "arrive by"); "now" = leaving now.
// Answer (always HTTP 200 unless something crashed):
//   { ok: true, when, departure, times: { "<schoolId>": { minutes, km } | null }, lookupsLeft }
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

type Parsed = { lat: number; lng: number; ids: string[]; when: "school_run" | "now" };

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
  if (w !== "school_run" && w !== "now") return { code: "bad_request" };
  // never send Google more than about 100 m of precision, whatever the app sent
  return { lat: Math.round(lat * 1000) / 1000, lng: Math.round(lng * 1000) / 1000, ids, when: w };
}

// 7:30 am India time on the next weekday that is still at least 15 minutes away. Google refuses a departure time in
// the past for car trips, and a weekday morning is when the school run happens.
function schoolRunDeparture(now: Date): Date {
  const earliest = now.getTime() + 15 * 60 * 1000;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  for (let add = 0; add < 8; add++) {
    const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add));
    const weekday = day.getUTCDay(); // the India date's day of the week
    if (weekday === 0 || weekday === 6) continue;
    const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 7, 30) - IST_OFFSET_MS;
    if (at >= earliest) return new Date(at);
  }
  throw new Error("no weekday found"); // cannot happen: a week always has a weekday
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
      const { data: rows, error: schoolErr } = await db.from("schools").select("id,latitude,longitude").in("id", parsed.ids).eq("is_hidden", false);
      if (schoolErr) return json({ ok: false, code: "failed", ...detail(schoolErr.message) }, 500);
      const byId = new Map((rows ?? []).map((r: any) => [String(r.id).toLowerCase(), r]));
      const dests = parsed.ids.map((id) => byId.get(id)).filter(hasCoords) as any[];
      if (dests.length === 0) return json({ ok: true, when: parsed.when, departure: null, times: {}, lookupsLeft: null });

      const key = deps.env.get("GOOGLE_MAPS_API_KEY") ?? "";
      if (!key) return json({ ok: false, code: "not_configured", ...detail("The GOOGLE_MAPS_API_KEY secret is missing in Supabase.") });

      // Take the allowance BEFORE calling Google, so a burst of requests cannot slip past the limits.
      const quota = await db.rpc("take_commute_quota", { p_elements: dests.length });
      if (quota.error) {
        const msg = String(quota.error.message ?? "");
        const missing = /take_commute_quota|schema cache|PGRST202|does not exist/i.test(msg) || quota.error.code === "PGRST202";
        return json({ ok: false, code: missing ? "not_configured" : "failed", ...detail(missing ? "Run the 20260919000700_drive_times.sql migration." : msg) });
      }
      if (!quota.data?.ok) return json({ ok: false, code: quota.data?.reason ?? "failed", ...(quota.data?.limit ? { limit: quota.data.limit } : {}) });

      const departure = parsed.when === "school_run" ? schoolRunDeparture(deps.now()) : null;
      const googleBody = {
        origins: [{ waypoint: { location: { latLng: { latitude: parsed.lat, longitude: parsed.lng } } } }],
        destinations: dests.map((d) => ({ waypoint: { location: { latLng: { latitude: Number(d.latitude), longitude: Number(d.longitude) } } } })),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        ...(departure ? { departureTime: departure.toISOString() } : {}),
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), GOOGLE_TIMEOUT_MS);
      let res: Response;
      try {
        res = await deps.fetch(ROUTES_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
          body: JSON.stringify(googleBody),
          signal: ctrl.signal,
        });
      } catch (e) {
        return json({ ok: false, code: (e as any)?.name === "AbortError" ? "google_timeout" : "google_error" });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      if (!res.ok) return json({ ok: false, code: googleProblem(res.status, text), ...detail(text) });
      let elements: unknown;
      try { elements = JSON.parse(text); } catch { return json({ ok: false, code: "google_error", ...detail(text) }); }

      const ids = dests.map((d) => String(d.id).toLowerCase());
      return json({
        ok: true,
        when: parsed.when,
        departure: departure ? departure.toISOString() : null,
        times: readMatrix(elements, ids),
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
