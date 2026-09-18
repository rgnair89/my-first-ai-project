// supabase/functions/ingest-mumbai-schools/index.ts
//
// Self-contained: paste this whole file into the dashboard editor. No other files are needed.
// Secrets it reads:
//   GOOGLE_MAPS_API_KEY  required
//   SB_SECRET_KEY        optional - a Supabase secret key (sb_secret_...). Falls back to the built-in
//                        SUPABASE_SERVICE_ROLE_KEY, which stops working once legacy keys are disabled.
// Request body (optional):  { "dryRun": true }  -> reports what would change and writes nothing.
//
// What it stores: only what Google returns. Anything Google does not provide stays NULL - no guessed
// ratings, founding years, fees or admission status.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ==== BEGIN testable logic (must not use imports or Deno globals) ====

const MUMBAI_ZONES = [
  { name: "Bandra West Mumbai", latitude: 19.0657, longitude: 72.8383 },
  { name: "Andheri West Mumbai", latitude: 19.1136, longitude: 72.8335 },
  { name: "Parel Sewri Mumbai", latitude: 19.0033, longitude: 72.8424 },
  { name: "Mulund West Mumbai", latitude: 19.1726, longitude: 72.9562 },
  { name: "Chembur Mumbai", latitude: 19.0625, longitude: 72.9023 },
  { name: "Oshiwara Andheri Mumbai", latitude: 19.1450, longitude: 72.8340 },
  { name: "Borivali West Mumbai", latitude: 19.2307, longitude: 72.8567 },
  { name: "Thane West", latitude: 19.2183, longitude: 72.9781 },
];

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.websiteUri,places.types,nextPageToken";
const MAX_PAGES_PER_ZONE = 3; // Google returns at most 20 places per page and 60 per query

// ---- BEGIN admin-auth (identical in every function) ----
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Returns a Response to send back when the caller is not allowed, or null when they are.
async function requireAdmin(req: Request, admin: any, secretKey: string): Promise<Response | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Missing bearer token" }, 401);

  // Server-to-server callers (e.g. a pg_cron job) present the secret key itself.
  if (secretKey && token === secretKey) return null;

  const { data, error } = await admin.auth.getUser(token);
  const user = data?.user;
  if (error || !user) return json({ error: "Invalid session" }, 401);

  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return json({ error: "Admin role required" }, 403);
  return null;
}
// ---- END admin-auth ----

type Place = {
  placeId: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  rating: number | null;
  reviewCount: number | null;
  website: string | null;
  types: string[];
};

type SchoolRow = {
  id: string;
  name: string;
  latitude: number | string | null;
  longitude: number | string | null;
  website: string | null;
  google_place_id: string | null;
  _n?: string;
};

type Deps = {
  env: { get(name: string): string | undefined };
  fetch: typeof fetch;
  createClient: (url: string, key: string) => any;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
};

// Only accept places Google types as a school, and drop coaching / tuition centres that carry that type.
const SCHOOL_TYPES = ["school", "primary_school", "secondary_school"];
const NOT_A_SCHOOL = /\b(coaching|tuitions?|tutorials?|classes)\b/i;

function isSchoolPlace(p: Place): boolean {
  return p.types.some((t) => SCHOOL_TYPES.includes(t)) && !NOT_A_SCHOOL.test(p.name);
}

// Board is only set when the school's own name says so, as a whole word. Otherwise it stays NULL (unknown)
// until it is read from an authoritative source. (The old substring matching tagged "Vibgyor" as IB.)
const BOARD_PATTERNS: [string, RegExp][] = [
  ["IB", /\bIB\b|international baccalaureate/i],
  ["IGCSE", /\bIGCSE\b/],
  ["ICSE", /\bICSE\b/],
  ["CBSE", /\bCBSE\b/],
  ["State Board", /\bSSC\b|state board/i],
];

function detectBoard(name: string): string | null {
  const found = BOARD_PATTERNS.filter(([, re]) => re.test(name)).map(([label]) => label);
  return found.length ? found.join(" / ") : null;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizePlace(place: any): Place | null {
  const name = place?.displayName?.text;
  const lat = place?.location?.latitude;
  const lng = place?.location?.longitude;
  if (!place?.id || !name || typeof lat !== "number" || typeof lng !== "number") return null;
  return {
    placeId: place.id,
    name,
    address: place.formattedAddress ?? null,
    lat,
    lng,
    rating: typeof place.rating === "number" ? place.rating : null,
    reviewCount: typeof place.userRatingCount === "number" ? place.userRatingCount : null,
    website: place.websiteUri ?? null,
    types: Array.isArray(place.types) ? place.types : [],
  };
}

// Rows stored before place IDs existed: same name and (within ~50 m) the same coordinates Google gave us.
// The matched row is removed from the pool so two places can never claim one row.
function takeLegacyMatch(pool: SchoolRow[], p: Place): SchoolRow | null {
  const n = normName(p.name);
  const i = pool.findIndex(
    (r) =>
      r._n === n &&
      Math.abs(Number(r.latitude) - p.lat) < 0.0005 &&
      Math.abs(Number(r.longitude) - p.lng) < 0.0005,
  );
  return i === -1 ? null : pool.splice(i, 1)[0];
}

// Words too common to prove two records are the same school (generic terms and neighbourhood names).
const GENERIC_WORDS = new Set([
  "school", "schools", "high", "junior", "senior", "primary", "secondary", "the", "of", "and", "mumbai",
  "public", "english", "international", "academy", "college", "vidyalaya", "convent", "municipal", "bmc",
  "pre", "nursery", "montessori", "foundation", "trust", "education", "educational", "institute", "west",
  "east", "north", "south", "andheri", "bandra", "borivali", "chembur", "mulund", "thane", "parel",
  "oshiwara", "malad", "goregaon", "kandivali", "dahisar", "powai", "sewri",
]);

function significantWords(name: string): string[] {
  return normName(name).split(" ").filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
}

function metersBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat1 - lat2) * 111320;
  const dLng = (lng1 - lng2) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

// Report only, never acts on it: would-be new schools that sit within 300 m of a stored school that this run
// could not match, and share a distinctive word in the name. Catches renamed or moved listings.
function findPossibleDuplicates(
  inserts: { name: string; latitude: number; longitude: number }[],
  unmatched: SchoolRow[],
): { new: string; existing: string; existing_id: string }[] {
  const out: { new: string; existing: string; existing_id: string }[] = [];
  for (const ins of inserts) {
    const words = significantWords(ins.name);
    if (!words.length) continue;
    const hit = unmatched.find(
      (r) =>
        metersBetween(ins.latitude, ins.longitude, Number(r.latitude), Number(r.longitude)) <= 300 &&
        significantWords(r.name).some((w) => words.includes(w)),
    );
    if (hit) out.push({ new: ins.name, existing: hit.name, existing_id: hit.id });
  }
  return out;
}

function insertRow(p: Place, nowIso: string) {
  return {
    name: p.name,
    address: p.address,
    latitude: p.lat,
    longitude: p.lng,
    website: p.website,
    google_place_id: p.placeId,
    google_rating: p.rating,
    google_review_count: p.reviewCount,
    board: detectBoard(p.name),
    admissions_open: null, // unknown until read from the school's own site
    last_synced_at: nowIso,
  };
}

// Existing rows only get Google-sourced fields refreshed; a website we already have is kept.
// A rating is only written when Google actually returned one: "no rating in this response" must never
// overwrite a rating we already hold.
function updatePatch(existing: SchoolRow, p: Place, nowIso: string) {
  return {
    google_place_id: p.placeId,
    ...(p.rating !== null ? { google_rating: p.rating } : {}),
    ...(p.reviewCount !== null ? { google_review_count: p.reviewCount } : {}),
    website: existing.website ?? p.website,
    last_synced_at: nowIso,
  };
}

function searchBody(zone: { name: string; latitude: number; longitude: number }, pageToken?: string) {
  return {
    textQuery: `schools in ${zone.name}`,
    includedType: "school",
    languageCode: "en",
    regionCode: "IN",
    pageSize: 20,
    locationBias: { circle: { center: { latitude: zone.latitude, longitude: zone.longitude }, radius: 5000.0 } },
    ...(pageToken ? { pageToken } : {}),
  };
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadSchools(db: any): Promise<SchoolRow[]> {
  const rows: SchoolRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("schools")
      .select("id, name, latitude, longitude, website, google_place_id")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`could not read schools: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  for (const r of rows) r._n = normName(r.name);
  return rows;
}

function createHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

    try {
      const url = deps.env.get("SUPABASE_URL") ?? "";
      const secretKey = deps.env.get("SB_SECRET_KEY") ?? deps.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const db = deps.createClient(url, secretKey);

      const denied = await requireAdmin(req, db, secretKey);
      if (denied) return denied;

      let body: { dryRun?: boolean } = {};
      try { body = await req.json(); } catch { /* no body */ }
      const dryRun = body?.dryRun === true;

      const googleKey = deps.env.get("GOOGLE_MAPS_API_KEY") ?? "";
      if (!googleKey) return json({ error: "GOOGLE_MAPS_API_KEY secret is missing in Supabase." }, 400);

      const known = await loadSchools(db);
      const byPlaceId = new Map<string, SchoolRow>();
      const legacy: SchoolRow[] = [];
      for (const r of known) (r.google_place_id ? byPlaceId.set(r.google_place_id, r) : legacy.push(r));

      const nowIso = deps.now().toISOString();
      const seen = new Set<string>();
      const toInsert: ReturnType<typeof insertRow>[] = [];
      const toUpdate: { id: string; patch: ReturnType<typeof updatePatch> }[] = [];
      const skippedExamples: string[] = [];
      const zones: { zone: string; pages: number; fetched: number; kept: number; skipped: number; capped: boolean }[] = [];
      let rated = 0;
      let unrated = 0;

      for (const zone of MUMBAI_ZONES) {
        const z = { zone: zone.name, pages: 0, fetched: 0, kept: 0, skipped: 0, capped: false };
        let pageToken: string | undefined;
        let lastPageSize = 0;

        for (let page = 0; page < MAX_PAGES_PER_ZONE; page++) {
          const res = await deps.fetch(PLACES_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Goog-Api-Key": googleKey, "X-Goog-FieldMask": FIELD_MASK },
            body: JSON.stringify(searchBody(zone, pageToken)),
          });
          const data = await res.json();
          if (data.error) {
            return json({ ok: false, zone: zone.name, google_error: data.error.message, status: data.error.status }, 502);
          }
          z.pages++;
          lastPageSize = (data.places ?? []).length;

          for (const place of data.places ?? []) {
            z.fetched++;
            const p = normalizePlace(place);
            if (!p || !isSchoolPlace(p)) {
              z.skipped++;
              if (skippedExamples.length < 10) skippedExamples.push(p?.name ?? "(incomplete record)");
              continue;
            }
            if (seen.has(p.placeId)) continue;
            seen.add(p.placeId);
            z.kept++;
            if (p.rating !== null) rated++; else unrated++;

            const existing = byPlaceId.get(p.placeId) ?? takeLegacyMatch(legacy, p);
            if (existing) toUpdate.push({ id: existing.id, patch: updatePatch(existing, p, nowIso) });
            else toInsert.push(insertRow(p, nowIso));
          }

          pageToken = data.nextPageToken;
          if (!pageToken) break;
        }

        // Google serves at most 60 results per query and issues no token after the 3rd page, so a zone that
        // used all 3 pages with a full last page (20) is truncated even though no token is left.
        z.capped = Boolean(pageToken) || (z.pages === MAX_PAGES_PER_ZONE && lastPageSize >= 20);
        zones.push(z);
        await deps.sleep(300); // pacing between zones
      }

      // `legacy` now holds only stored schools this run could not match to a Google result
      const possibleDuplicates = findPossibleDuplicates(toInsert, legacy);

      const errors: string[] = [];
      let inserted = 0;
      let updated = 0;

      if (!dryRun) {
        for (const chunk of chunks(toInsert, 100)) {
          const { data, error } = await db
            .from("schools")
            .upsert(chunk, { onConflict: "google_place_id", ignoreDuplicates: true })
            .select("id");
          if (error) errors.push(`insert failed: ${error.message}`);
          else inserted += data?.length ?? 0;
        }
        for (const chunk of chunks(toUpdate, 20)) {
          await Promise.all(
            chunk.map(async (u) => {
              const { error } = await db.from("schools").update(u.patch).eq("id", u.id);
              if (error) errors.push(`update ${u.id}: ${error.message}`);
              else updated++;
            }),
          );
        }
      }

      return json({
        ok: errors.length === 0,
        dryRun,
        would_insert: toInsert.length,
        would_update: toUpdate.length,
        inserted,
        updated,
        skipped_not_school: zones.reduce((n, z) => n + z.skipped, 0),
        skipped_examples: skippedExamples,
        ratings: { with_rating: rated, without_rating: unrated },
        stored_but_unmatched: { count: legacy.length, examples: legacy.slice(0, 10).map((r) => r.name) },
        possible_duplicates: { count: possibleDuplicates.length, examples: possibleDuplicates.slice(0, 10) },
        zones,
        errors: errors.slice(0, 20),
        ...(dryRun ? { sample: { insert: toInsert.slice(0, 3), update: toUpdate.slice(0, 3) } } : {}),
      });
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
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
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }),
);
