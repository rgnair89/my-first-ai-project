// Logic for the Mumbai grid sweep. No React and no network calls here, so it can be tested on its own.
//
// The sweep covers Mumbai, Thane and Navi Mumbai with small map cells. Each cell is one Google search that can
// return at most 60 places; a cell that returns a full 60 is split into four quarters and searched again, so
// crowded areas are covered in finer detail.

export const SWEEP_BOUNDS = { south: 18.88, north: 19.32, west: 72.76, east: 73.2 };
export const STEP = 0.03; // about 3.3 km
export const BATCH_SIZE = 6; // cells per function call (the function accepts at most 8)
export const MAX_DEPTH = 3; // a crowded cell is split into quarters at most 3 times (about 400 m)
export const MAX_REQUESTS = 1200; // hard stop on Google requests for one sweep

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
      cells.push({
        id: `g${i}-${j}`,
        depth: 0,
        low: { lat: r5(bounds.south + i * step), lng: r5(bounds.west + j * step) },
        high: { lat: r5(bounds.south + (i + 1) * step), lng: r5(bounds.west + (j + 1) * step) },
      });
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

// A handful of cells in the dense Bandra - Andheri - Kurla area, for a cheap trial run before the full sweep.
export function testCells(grid = buildGrid(), count = BATCH_SIZE) {
  const inWindow = (c) => {
    const lat = (c.low.lat + c.high.lat) / 2;
    const lng = (c.low.lng + c.high.lng) / 2;
    return lat >= 19.03 && lat <= 19.13 && lng >= 72.82 && lng <= 72.91;
  };
  return grid.filter(inWindow).slice(0, count);
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
  shouldStop = () => false,
  onProgress = () => {},
}) {
  const t = emptyTotals();

  while (queue.length) {
    if (shouldStop()) { t.stopped = 'stopped by you'; break; }
    if (t.batches >= maxBatches) { t.stopped = 'batch limit reached'; break; }
    if (t.requests >= maxRequests) { t.stopped = `Google request budget reached (${maxRequests})`; break; }

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
