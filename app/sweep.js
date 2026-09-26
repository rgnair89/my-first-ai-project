// Logic for the grid sweep. No React and no network calls here, so it can be tested on its own.
//
// A sweep covers one city with small map cells. Each cell is one Google search that can return at most 60 places; a
// cell that comes back with a full 60 is split into four quarters and searched again, so crowded areas end up
// covered in finer detail than empty ones.
//
// The rectangle used to be written here, and in App.js, and in commute-times: three copies of one fact. It now comes
// from service_areas, which is also what the app reads, so widening a city happens in one place.

// Only a fallback, for a screen that has somehow not been told which city it is sweeping. Mumbai's original sweep
// rectangle, which is tighter than its service area: the service area says who is inside, this says where to look.
export const SWEEP_BOUNDS = { south: 18.88, north: 19.32, west: 72.76, east: 73.2 };

// A city row from service_areas, as the corners a grid is built from.
export function boundsOf(area) {
  const n = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const b = { south: n(area?.lat_min), north: n(area?.lat_max), west: n(area?.lng_min), east: n(area?.lng_max) };
  const ok = Object.values(b).every(Number.isFinite) && b.south < b.north && b.west < b.east;
  return ok ? b : null;
}

// Every city, including the ones not yet shown to parents - sweeping one is how it stops being empty.
export async function loadSweepCities(db) {
  const { data, error } = await db.from('service_areas')
    .select('key,name,lat_min,lat_max,lng_min,lng_max,live,sort_order').order('sort_order', { ascending: true });
  if (error) return { rows: [], error };
  const rows = (data ?? []).map((a) => ({ key: a.key, name: a.name, live: !!a.live, bounds: boundsOf(a) }))
    .filter((c) => c.key && c.name && c.bounds);
  return { rows, error: null };
}

// How big a sweep would be, before anybody spends anything on it.
export function sweepSize(bounds, step = STEP) {
  const cells = buildGrid(bounds, step).length;
  return { cells, batches: Math.ceil(cells / BATCH_SIZE) };
}
export const STEP = 0.03; // about 3.3 km
export const BATCH_SIZE = 6; // cells per function call (the function accepts at most 8)
export const MAX_DEPTH = 3; // a crowded cell is split into quarters at most 3 times (about 400 m)
export const MAX_REQUESTS = 2000; // hard stop on Google requests for one sweep
export const BUDGET_TOP_UP = 500; // extra requests the admin can approve after the limit is reached

const r5 = (n) => Math.round(n * 1e5) / 1e5;

export const emptyTotals = () => ({
  batches: 0, cells: 0, requests: 0, fetched: 0, inserted: 0, updated: 0,
  wouldInsert: 0, wouldUpdate: 0, splits: 0, unresolved: 0, errors: [], stopped: null,
});

// Adds two sets of totals, so a sweep that was stopped and resumed still shows one running total.
export function mergeTotals(a, b) {
  const out = emptyTotals();
  for (const k of Object.keys(out)) if (typeof out[k] === 'number') out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  out.errors = [...(a.errors ?? []), ...(b.errors ?? [])];
  out.stopped = b.stopped ?? null;
  out.queued = b.queued ?? a.queued ?? 0;
  return out;
}

export function buildGrid(bounds = SWEEP_BOUNDS, step = STEP) {
  const rows = Math.ceil((bounds.north - bounds.south) / step - 1e-9);
  const cols = Math.ceil((bounds.east - bounds.west) / step - 1e-9);
  const cells = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      // Clamped to the city's own edges. Without this the last row and column stick out past the boundary - for
      // Pune, a hundredth of a degree east of it - and the function refuses every one of them as being outside the
      // city, which is ten cells of a sweep failing for a reason nobody could see.
      const low = { lat: r5(bounds.south + i * step), lng: r5(bounds.west + j * step) };
      const high = {
        lat: r5(Math.min(bounds.south + (i + 1) * step, bounds.north)),
        lng: r5(Math.min(bounds.west + (j + 1) * step, bounds.east)),
      };
      if (high.lat <= low.lat || high.lng <= low.lng) continue;
      cells.push({ id: `g${i}-${j}`, depth: 0, low, high });
    }
  }
  return cells;
}

export function splitCell(cell) {
  const midLat = r5((cell.low.lat + cell.high.lat) / 2);
  const midLng = r5((cell.low.lng + cell.high.lng) / 2);
  const quarters = [
    [cell.low.lat, cell.low.lng, midLat, midLng],
    [cell.low.lat, midLng, midLat, cell.high.lng],
    [midLat, cell.low.lng, cell.high.lat, midLng],
    [midLat, midLng, cell.high.lat, cell.high.lng],
  ];
  return quarters.map(([la0, lo0, la1, lo1], k) => ({
    id: `${cell.id}.${k}`,
    depth: cell.depth + 1,
    low: { lat: la0, lng: lo0 },
    high: { lat: la1, lng: lo1 },
  }));
}

// A handful of cells for a cheap trial run before the full sweep.
//
// This used to name a window of Mumbai - Bandra to Kurla - which was a reasonable place to look for schools and a
// terrible way to write it down: pointed at Pune it matched no cells at all, and the trial asked the function to
// search nothing, which it refused. The middle of a city is where its schools are, whichever city it is.
export function testCells(grid = buildGrid(), count = BATCH_SIZE) {
  const cells = Array.isArray(grid) ? grid.filter((c) => c?.low && c?.high) : [];
  if (cells.length <= count) return cells;
  const lat = (c) => (c.low.lat + c.high.lat) / 2;
  const lng = (c) => (c.low.lng + c.high.lng) / 2;
  const midLat = (Math.min(...cells.map(lat)) + Math.max(...cells.map(lat))) / 2;
  const midLng = (Math.min(...cells.map(lng)) + Math.max(...cells.map(lng))) / 2;
  // nearest the middle first, so a trial of six is six cells of city rather than six of coastline
  return [...cells]
    .sort((a, b) => ((lat(a) - midLat) ** 2 + (lng(a) - midLng) ** 2) - ((lat(b) - midLat) ** 2 + (lng(b) - midLng) ** 2))
    .slice(0, count);
}

// ---- Remembering progress across a page refresh, and refusing to run in two tabs at once ----

const STATE_VERSION = 1;

export function serializeState({ queue, done, budget }) {
  return JSON.stringify({ v: STATE_VERSION, queue, done, budget });
}

// Returns { queue, done, budget } or null if the saved text is missing, damaged or from another version.
export function restoreState(text) {
  if (!text) return null;
  try {
    const s = JSON.parse(text);
    if (s?.v !== STATE_VERSION || !Array.isArray(s.queue)) return null;
    const okCell = (c) =>
      c && typeof c.id === 'string' && Number.isFinite(c.depth) &&
      [c.low?.lat, c.low?.lng, c.high?.lat, c.high?.lng].every(Number.isFinite);
    if (!s.queue.every(okCell)) return null;
    return {
      queue: s.queue,
      done: { ...emptyTotals(), ...(s.done ?? {}) },
      budget: Number.isFinite(s.budget) && s.budget > 0 ? s.budget : MAX_REQUESTS,
    };
  } catch {
    return null;
  }
}

// A running tab writes a lock before every batch. Another tab treats a fresh lock as "a sweep is running".
export const LOCK_MAX_AGE_MS = 180000;
export const makeLock = (id, now = Date.now()) => JSON.stringify({ id, at: now });

export function lockedByOtherTab(lockText, myId, now = Date.now(), maxAge = LOCK_MAX_AGE_MS) {
  if (!lockText) return false;
  try {
    const l = JSON.parse(lockText);
    return l.id !== myId && Number.isFinite(l.at) && now - l.at < maxAge;
  } catch {
    return false;
  }
}

/**
 * Works through `queue` (changed in place: finished cells are removed, quarters of crowded cells are added, and a
 * batch whose call failed is put back) by calling invoke({ dryRun, cells }) BATCH_SIZE cells at a time.
 * `invoke` must resolve to { data, error } like supabase.functions.invoke does.
 * Stops on: an error, the request budget, the batch limit, or shouldStop(). Returns the running totals.
 */
export async function runSweep({
  queue,
  invoke,
  dryRun = false,
  maxBatches = Infinity,
  maxRequests = MAX_REQUESTS,
  budgetLabel = maxRequests, // the total limit to name in the stop message (maxRequests is only what is left of it)
  shouldStop = () => false,
  onProgress = () => {},
}) {
  const t = emptyTotals();

  while (queue.length) {
    if (shouldStop()) { t.stopped = 'stopped by you'; break; }
    if (t.batches >= maxBatches) { t.stopped = 'batch limit reached'; break; }
    if (t.requests >= maxRequests) { t.stopped = `Google request budget reached (${budgetLabel})`; break; }

    const batch = queue.splice(0, BATCH_SIZE);
    const { data, error } = await invoke({ dryRun, cells: batch.map(({ id, low, high }) => ({ id, low, high })) });

    if (error || !data) {
      queue.unshift(...batch); // nothing is lost: the same cells are tried again on resume
      t.stopped = 'error';
      t.errors.push(error?.message ?? 'no response');
      break;
    }

    const byId = new Map(batch.map((c) => [c.id, c]));
    for (const z of data.zones ?? []) {
      t.requests += z.pages ?? 0;
      t.fetched += z.fetched ?? 0;
      if (z.capped) {
        const cell = byId.get(z.zone);
        if (cell && cell.depth < MAX_DEPTH) { queue.push(...splitCell(cell)); t.splits++; }
        else t.unresolved++; // still crowded at the finest level; some schools here may be missing
      }
    }
    t.batches++;
    t.cells += batch.length;
    t.inserted += data.inserted ?? 0;
    t.updated += data.updated ?? 0;
    t.wouldInsert += data.would_insert ?? 0;
    t.wouldUpdate += data.would_update ?? 0;
    if (data.errors?.length) t.errors.push(...data.errors);
    onProgress({ ...t, queued: queue.length });
  }

  return { ...t, queued: queue.length };
}
