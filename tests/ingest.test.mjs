// Tests for the part of ingest-schools that decides where to look.
// Run: node tests/ingest.test.mjs
//
// This is the function that spends money: every cell of the grid is one or more Google Places calls. A grid that is
// twice as fine costs four times as much, and one that leaves gaps costs nothing and finds nothing. So the geometry
// is worth writing down twice - once in the function, once here as the case it was written for.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'supabase', 'functions', 'ingest-schools', 'index.ts'), 'utf8');
const a = src.indexOf('// ==== BEGIN testable logic');
const b = src.indexOf('// ==== END testable logic');
if (a < 0 || b < 0) throw new Error('the markers are gone from ingest-schools/index.ts');

const names = ['gridFor', 'partsOf', 'cellsForPart', 'parseCells', 'spanOf', 'searchBody',
  'MAX_CELLS_PER_CALL', 'CELL_SPAN', 'MAX_SPAN', 'MIN_SPAN', 'isRetryable', 'isFatal', 'RETRIES'];
fs.mkdirSync(path.join(here, '.tmp'), { recursive: true });
const file = path.join(here, '.tmp', 'ingest-logic.mts');
fs.writeFileSync(file, `${src.slice(a, b)}\nexport { ${names.join(', ')} };\n`);
const L = await import(pathToFileURL(file).href);

let pass = 0;
let fail = 0;
const check = (what, ok, extra = '') => {
  if (ok) { pass += 1; console.log('PASS  ' + what); } else { fail += 1; console.log('FAIL  ' + what + (extra ? '  -> ' + extra : '')); }
};

// the two cities that matter today, exactly as service_areas has them
const MUMBAI = { key: 'mumbai', name: 'Mumbai', latMin: 18.5, latMax: 19.7, lngMin: 72.5, lngMax: 73.5 };
const PUNE = { key: 'pune', name: 'Pune', latMin: 18.4, latMax: 18.7, lngMin: 73.7, lngMax: 74.05 };

// =================================================================================================================
console.log('=== how big a cell is ===');
check('the usual cell is about three kilometres across, which is small enough that most do not fill up', L.CELL_SPAN === 0.03);
check('a smaller one can be asked for, and a silly one cannot',
  L.spanOf(0.02) === 0.02 && L.spanOf(0.0001) === L.MIN_SPAN && L.spanOf(5) === L.MAX_SPAN);
check('...and nothing sensible-looking is taken from nonsense', L.spanOf(undefined) === L.CELL_SPAN
  && L.spanOf('wide') === L.CELL_SPAN && L.spanOf(-1) === L.CELL_SPAN && L.spanOf(null) === L.CELL_SPAN);

console.log('\n=== the grid over a city ===');
{
  const grid = L.gridFor(PUNE);
  check('Pune comes out as a grid of cells, not a list somebody typed', grid.length === 120, String(grid.length));
  check('...every one of them inside Pune and nowhere else',
    grid.every((c) => c.low.latitude >= PUNE.latMin && c.high.latitude <= PUNE.latMax
      && c.low.longitude >= PUNE.lngMin && c.high.longitude <= PUNE.lngMax),
    JSON.stringify(grid.find((c) => c.high.latitude > PUNE.latMax || c.high.longitude > PUNE.lngMax) ?? null));
  check('...the first cell starting at the south-west corner',
    grid[0].low.latitude === 18.4 && grid[0].low.longitude === 73.7, JSON.stringify(grid[0].low));
  check('...the last one finishing exactly on the north-east corner, rather than stopping short of it',
    grid.at(-1).high.latitude === 18.7 && grid.at(-1).high.longitude === 74.05, JSON.stringify(grid.at(-1).high));
  check('...and each one named for where it is, so a capped cell can be found again',
    /pune 18\.4,73\.7/.test(grid[0].name), grid[0].name);
}
{
  // The whole point of a grid: no school falls between two cells, and none is paid for twice.
  const grid = L.gridFor(PUNE);
  const sorted = [...grid].sort((x, y) => x.low.latitude - y.low.latitude || x.low.longitude - y.low.longitude);
  const bottomRow = sorted.filter((c) => c.low.latitude === sorted[0].low.latitude);
  let gap = null;
  for (let i = 1; i < bottomRow.length; i += 1) {
    if (Math.abs(bottomRow[i].low.longitude - bottomRow[i - 1].high.longitude) > 1e-9) gap = [bottomRow[i - 1], bottomRow[i]];
  }
  check('cells sit edge to edge, so nothing falls between them and nothing is searched twice', gap === null, JSON.stringify(gap));
}
{
  const fine = L.gridFor(PUNE, 0.015);
  const coarse = L.gridFor(PUNE, 0.06);
  check('halving the cell size roughly quadruples the cost, which is worth knowing before pressing the button',
    fine.length > coarse.length * 10, `${fine.length} vs ${coarse.length}`);
}
check('Mumbai is a much bigger sweep than Pune, as anyone would expect', L.gridFor(MUMBAI).length > L.gridFor(PUNE).length * 8,
  `${L.gridFor(MUMBAI).length} vs ${L.gridFor(PUNE).length}`);
check('a rectangle drawn round half of India is refused a grid big enough to bankrupt anybody',
  L.gridFor({ key: 'all', name: 'Everywhere', latMin: 8, latMax: 35, lngMin: 68, lngMax: 97 }).length <= 4000);

console.log('\n=== sweeping it a part at a time ===');
{
  const grid = L.gridFor(PUNE);
  const parts = L.partsOf(grid.length);
  check('a sweep is broken into parts of eight, because one call is one press', parts === 15 && L.MAX_CELLS_PER_CALL === 8, String(parts));
  check('...the first part being the first eight cells', L.cellsForPart(grid, 0).length === 8 && L.cellsForPart(grid, 0)[0] === grid[0]);
  check('...and every cell landing in exactly one part',
    Array.from({ length: parts }, (_, i) => L.cellsForPart(grid, i)).flat().length === grid.length);
  check('a city smaller than one part is still one part, not none', L.partsOf(3) === 1 && L.partsOf(0) === 1);
}

console.log('\n=== when Google has a bad second ===');
// This is not hypothetical. A real Mumbai sweep died on cell g24-15 with INTERNAL: "Internal server error. Please
// retry." Every Google failure was being treated as fatal, so one bad second anywhere in 1,360 cells ended the run.
check('the errors Google tells you to retry are retried',
  ['INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'ABORTED', 'UNKNOWN'].every((e) => L.isRetryable(e)));
check('...however they are capitalised, because a status is not worth arguing with',
  L.isRetryable('internal') && L.isRetryable('Unavailable'));
check('...and they are not treated as walls', !['INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED'].some((e) => L.isFatal(e)));
check('a refused key or an exhausted quota is a wall: retrying it spends money to be told the same thing',
  ['PERMISSION_DENIED', 'UNAUTHENTICATED', 'INVALID_ARGUMENT', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION'].every((e) => L.isFatal(e)));
check('...and a wall is never retried', !['PERMISSION_DENIED', 'RESOURCE_EXHAUSTED'].some((e) => L.isRetryable(e)));
check('something nobody has seen before is neither retried nor allowed to end the run: the cell is lost, the sweep goes on',
  !L.isRetryable('SOMETHING_NEW') && !L.isFatal('SOMETHING_NEW') && !L.isRetryable(null) && !L.isFatal(undefined));
check('a bad second is tried again more than once, because two in a row happens', L.RETRIES >= 2);

console.log('\n=== what an admin page is allowed to ask for ===');
{
  const inside = [{ id: 'c1', low: { lat: 18.51, lng: 73.85 }, high: { lat: 18.54, lng: 73.88 } }];
  check('a cell inside the city is allowed', Array.isArray(L.parseCells(inside, PUNE)));
  const elsewhere = [{ id: 'c1', low: { lat: 19.05, lng: 72.82 }, high: { lat: 19.08, lng: 72.85 } }];
  check('...and the same cell is refused for a different city, by name, so the message means something',
    L.parseCells(elsewhere, PUNE) === 'cell is outside Pune', String(L.parseCells(elsewhere, PUNE)));
  check('...while it is fine for the city it is actually in', Array.isArray(L.parseCells(elsewhere, MUMBAI)));
}
check('a cell too big to be a cell is refused, because it would cost a lot and return sixty results',
  typeof L.parseCells([{ low: { lat: 18.4, lng: 73.7 }, high: { lat: 18.7, lng: 74.0 } }], PUNE) === 'string');
check('a cell drawn inside out is refused', typeof L.parseCells([{ low: { lat: 18.6, lng: 73.9 }, high: { lat: 18.5, lng: 73.8 } }], PUNE) === 'string');
check('nine cells at once are refused, however they are drawn',
  typeof L.parseCells(Array.from({ length: 9 }, () => ({ low: { lat: 18.51, lng: 73.85 }, high: { lat: 18.52, lng: 73.86 } })), PUNE) === 'string');
check('...and so is nothing at all', typeof L.parseCells([], PUNE) === 'string' && typeof L.parseCells('cells', PUNE) === 'string');

console.log('\n=== what is asked of Google ===');
{
  const cell = L.gridFor(PUNE)[0];
  const body = L.searchBody(cell);
  check('a cell is searched as a rectangle, so results never spill into the next city',
    !!body.locationRestriction?.rectangle && !body.locationBias, JSON.stringify(Object.keys(body)));
  check('...asking for schools, in India, twenty at a time', body.includedType === 'school' && body.regionCode === 'IN' && body.pageSize === 20);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
