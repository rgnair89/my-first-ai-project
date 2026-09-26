// Tests for the portal side of a sweep: the grid it builds, the trial it offers first, and the rectangle it takes
// from a city. Run: node tests/sweep.test.mjs
//
// app/sweep.js has said "no React and no network calls here, so it can be tested on its own" since the day it was
// written, and had no test. The first thing one would have caught: a trial run hardcoded to a window of Mumbai,
// which matched no cells in Pune and asked the function to search nothing.
import * as L from '../app/sweep.js';

let pass = 0;
let fail = 0;
const check = (what, ok, extra = '') => {
  if (ok) { pass += 1; console.log('PASS  ' + what); } else { fail += 1; console.log('FAIL  ' + what + (extra ? '  -> ' + extra : '')); }
};

// the rows as service_areas really holds them: numbers as text
const PUNE_ROW = { key: 'pune', name: 'Pune', lat_min: '18.4', lat_max: '18.7', lng_min: '73.7', lng_max: '74.05' };
const MUMBAI_ROW = { key: 'mumbai', name: 'Mumbai', lat_min: '18.5', lat_max: '19.7', lng_min: '72.5', lng_max: '73.5' };

console.log('=== a city becomes a rectangle ===');
check('the corners come back as numbers, because the database hands them over as text',
  JSON.stringify(L.boundsOf(PUNE_ROW)) === JSON.stringify({ south: 18.4, north: 18.7, west: 73.7, east: 74.05 }),
  JSON.stringify(L.boundsOf(PUNE_ROW)));
check('a row with nothing written in for its corners is no rectangle at all, rather than one at nought',
  L.boundsOf({ lat_min: null, lat_max: null, lng_min: null, lng_max: null }) === null
  && L.boundsOf({}) === null && L.boundsOf(null) === null);
check('...and neither is one drawn inside out', L.boundsOf({ lat_min: 19, lat_max: 18, lng_min: 72, lng_max: 73 }) === null);

console.log('\n=== the grid ===');
{
  const pune = L.buildGrid(L.boundsOf(PUNE_ROW));
  const mumbai = L.buildGrid(L.boundsOf(MUMBAI_ROW));
  check('Pune is a manageable sweep and Mumbai is not, which is worth knowing before starting one',
    pune.length === 120 && mumbai.length === 1360, `${pune.length} and ${mumbai.length}`);
  check('every cell of Pune is inside Pune',
    pune.every((c) => c.low.lat >= 18.4 && c.high.lat <= 18.7 && c.low.lng >= 73.7 && c.high.lng <= 74.05));
  check('the cost of a sweep can be asked for before it is run, and nothing is spent asking',
    L.sweepSize(L.boundsOf(PUNE_ROW)).cells === 120 && L.sweepSize(L.boundsOf(PUNE_ROW)).batches === 20,
    JSON.stringify(L.sweepSize(L.boundsOf(PUNE_ROW))));
}

console.log('\n=== the trial that comes first ===');
{
  const middleOf = (cells) => {
    const lat = cells.map((c) => (c.low.lat + c.high.lat) / 2);
    const lng = cells.map((c) => (c.low.lng + c.high.lng) / 2);
    return { lat: (Math.min(...lat) + Math.max(...lat)) / 2, lng: (Math.min(...lng) + Math.max(...lng)) / 2 };
  };
  for (const [name, row, expect] of [['Pune', PUNE_ROW, { lat: 18.55, lng: 73.85 }], ['Mumbai', MUMBAI_ROW, { lat: 19.1, lng: 73 }]]) {
    const grid = L.buildGrid(L.boundsOf(row));
    const trial = L.testCells(grid);
    check(`${name} gets a trial of six cells - the bug this test exists for gave Pune none`,
      trial.length === L.BATCH_SIZE, String(trial.length));
    const mid = middleOf(trial);
    check(`...taken from the middle of ${name}, where its schools are, not from its coastline`,
      Math.abs(mid.lat - expect.lat) < 0.2 && Math.abs(mid.lng - expect.lng) < 0.2, JSON.stringify(mid));
    check(`...and every one of them a real cell of ${name}'s own grid`, trial.every((c) => grid.includes(c)));
  }
}
check('a city smaller than one trial gives every cell it has, rather than none',
  L.testCells(L.buildGrid(L.boundsOf(PUNE_ROW)).slice(0, 3)).length === 3);
check('...and nothing at all gives nothing, without throwing', L.testCells([]).length === 0 && L.testCells(null).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
