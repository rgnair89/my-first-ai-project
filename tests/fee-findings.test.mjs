// Tests for the portal side of fee findings: how crawled lines are arranged, what they suggest, and what stops a
// suggestion being saved. Run: node tests/fee-findings.test.mjs
import * as L from '../app/fee-findings-admin.js';

let pass = 0;
let fail = 0;
const check = (what, ok, extra = '') => {
  if (ok) { pass += 1; console.log('PASS  ' + what); } else { fail += 1; console.log('FAIL  ' + what + (extra ? '  -> ' + extra : '')); }
};
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// a stand-in database that records what it was asked
const fakeDb = (answer = { data: [], error: null }) => {
  const calls = [];
  const chain = {};
  for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = (...a) => { calls.push([m, ...a]); return chain; };
  chain.then = (res, rej) => Promise.resolve(answer).then(res, rej);
  return {
    calls,
    from: (t) => { calls.push(['from', t]); return chain; },
    rpc: async (fn, args) => { calls.push(['rpc', fn, args]); return answer; },
    functions: { invoke: async (name, opts) => { calls.push(['invoke', name, opts]); return answer; } },
  };
};

const line = (over = {}) => ({
  id: 1, school_id: 's1', source_url: 'https://school.in/fees', grade_text: 'Nursery', component_text: 'Tuition Fee',
  evidence: 'Nursery | 45,000', level: 'preschool', academic_year: '2026-27', component: 'tuition', amount: 45000,
  confidence: 'high', ...over,
});

// =================================================================================================================
console.log('=== money, as a family reads it ===');
check('Indian grouping', L.rupees(233000) === '₹2,33,000' && L.rupees(45000) === '₹45,000' && L.rupees(500) === '₹500');
check('nothing is nothing, not blank', L.rupees(0) === '₹0' && L.rupees(null) === '₹0');

console.log('\n=== arranging what was read ===');
{
  const rows = [
    line({ id: 1, level: 'preschool', component: 'tuition', amount: 45000 }),
    line({ id: 2, level: 'preschool', component: 'transport', amount: 12000 }),
    line({ id: 3, level: 'primary', component: 'tuition', amount: 55000 }),
    line({ id: 4, level: null, component: 'unknown', amount: 9000, confidence: 'low', grade_text: null }),
  ];
  const groups = L.groupByLevel(rows);
  check('one group per level, youngest first, and the ones it could not place last',
    eq(groups.map((g) => g.level), ['preschool', 'primary', null]), JSON.stringify(groups.map((g) => g.level)));
  check('...each group holds only its own lines, because one press turns one group into one fee',
    groups[0].rows.length === 2 && groups[1].rows.length === 1 && groups[2].rows.length === 1);
  check('...and says how many of them are worth trusting', groups[0].confident === 2 && groups[2].confident === 0);
  check('...the ones it could not place are named as that, not left blank', groups[2].label === 'Lines it could not place');
  check('nothing read means nothing to arrange', L.groupByLevel([]).length === 0 && L.groupByLevel(null).length === 0);
}

console.log('\n=== what a group suggests ===');
{
  const rows = [
    line({ component: 'tuition', amount: 45000 }),
    line({ component: 'transport', amount: 12000 }),
    line({ component: 'admission_fee', amount: 25000 }),
  ];
  const draft = L.draftFromFindings(rows);
  check('every charge it read becomes a figure to check', draft.tuition === 45000 && draft.transport === 12000 && draft.admission_fee === 25000);
  check('...and nothing it did not read is invented as a nought', !('meals' in draft) && !('deposit' in draft), JSON.stringify(draft));
  check('...with the year and the page it came from', draft.academic_year === '2026-27' && draft.source_url === 'https://school.in/fees');
}
{
  const rows = [line({ component: 'tuition', amount: 15000, confidence: 'low' }), line({ component: 'tuition', amount: 60000, confidence: 'high' })];
  check('where a charge was read twice, the line it is surer of is the one offered', L.draftFromFindings(rows).tuition === 60000);
}
{
  const rows = [line({ component: 'tuition', amount: 15000, confidence: 'low' }), line({ component: 'tuition', amount: 60000, confidence: 'low' })];
  check('...and where it is no surer of either, the yearly figure rather than the termly one', L.draftFromFindings(rows).tuition === 60000);
}
{
  const rows = [line({ academic_year: '2026-27' }), line({ academic_year: '2026-27' }), line({ academic_year: '2025-26' })];
  check('the year most of the page agreed on', L.draftFromFindings(rows).academic_year === '2026-27');
}
check('a group with nothing in it suggests nothing', eq(L.draftFromFindings([]), { academic_year: '', source_url: '' }));

console.log('\n=== what stops it being saved ===');
check('a fee with no class is not a fee', L.whyNotYet(null, { tuition: 1, academic_year: '2026-27' }) === 'Choose which classes these fees are for.');
check('a fee with no tuition is not a fee, and it says what to do about it',
  /yearly tuition/.test(L.whyNotYet('primary', { academic_year: '2026-27' }) ?? ''), L.whyNotYet('primary', { academic_year: '2026-27' }));
check('a fee with no year is not a fee, and it shows the shape wanted',
  /2026-27/.test(L.whyNotYet('primary', { tuition: 5 }) ?? ''), L.whyNotYet('primary', { tuition: 5 }));
check('a figure too big to be real is caught here, not by the database',
  /fifty lakh/.test(L.whyNotYet('primary', { tuition: 5, academic_year: '2026-27', deposit: 9000000 }) ?? ''));
check('and a fee that has everything it needs has nothing standing in its way',
  L.whyNotYet('primary', { tuition: 45000, academic_year: '2026-27' }) === null);

console.log('\n=== what is sent ===');
{
  const sent = L.feesPayload({ tuition: '45000', transport: 0, meals: '', deposit: 10000, academic_year: ' 2026-27 ', source_url: ' https://x.in/f ', note: ' from the fee page ' });
  check('only the amounts that are really amounts', sent.tuition === 45000 && sent.deposit === 10000 && !('transport' in sent) && !('meals' in sent), JSON.stringify(sent));
  check('...tidied up on the way', sent.academic_year === '2026-27' && sent.source_url === 'https://x.in/f' && sent.note === 'from the fee page');
}
check('a note longer than the database allows is cut here rather than refused there',
  L.feesPayload({ note: 'x'.repeat(300) }).note.length === 200);

console.log('\n=== deciding ===');
{
  const db = fakeDb({ error: null });
  const res = await L.acceptFindings(db, [1, 2], 'preschool', { tuition: 45000, academic_year: '2026-27', source_url: 'https://x.in/f' });
  check('accepting sends the lines, the level and the fee, in one call', res.error === null
    && db.calls[0][0] === 'rpc' && db.calls[0][1] === 'accept_fee_findings'
    && eq(db.calls[0][2].p_ids, [1, 2]) && db.calls[0][2].p_level === 'preschool' && db.calls[0][2].p_fees.tuition === 45000,
  JSON.stringify(db.calls[0]));
}
{
  const db = fakeDb({ error: null });
  const res = await L.acceptFindings(db, [1], 'preschool', { academic_year: '2026-27' });
  check('...and a fee that is not ready is stopped before anything is sent', !!res.error && db.calls.length === 0, res.error?.message);
}
{
  const db = fakeDb({ error: null });
  await L.rejectFindings(db, [3, 4]);
  check('setting lines aside sends just the lines', db.calls[0][1] === 'reject_fee_findings' && eq(db.calls[0][2].p_ids, [3, 4]));
}
check('...and setting nothing aside is refused rather than sent', !!(await L.rejectFindings(fakeDb(), [])).error);

console.log('\n=== reading more websites ===');
{
  const db = fakeDb({ data: { success: true, schools: 8, findings_written: 22, worth_looking_at: 14 }, error: null });
  const res = await L.readMoreWebsites(db, { limit: 8 });
  check('the crawler is asked for a batch', db.calls[0][1] === 'crawl-school-fees' && db.calls[0][2].body.limit === 8);
  check('...and what it did is said in plain words',
    L.crawlSummary(res.result) === 'Read 8 websites, took down 22 lines, 14 of them worth looking at.', L.crawlSummary(res.result));
}
check('the crawler that only reports is recognised by its answer, and named, instead of being read as silence',
  L.isOldCrawler({ success: true, mode: 'report-only (nothing written to school_fees)', count: 5, details: [] })
  && /old crawler/.test(L.crawlSummary({ success: true, mode: 'report-only', count: 5 })),
  L.crawlSummary({ success: true, mode: 'report-only', count: 5 }));
check('...and that is a thing to fix, not a result to celebrate', L.crawlNeedsAttention({ mode: 'report-only', count: 5 }) === true);
check('an answer in a shape this screen has never seen is said to be exactly that, with the words it came with',
  /does not recognise: teapot/.test(L.crawlSummary({ success: true, message: 'teapot' })), L.crawlSummary({ success: true, message: 'teapot' }));
check('...rather than being turned into a confident sentence about nothing having happened',
  L.crawlSummary({ success: true, message: 'teapot' }) !== 'No schools with a website were left to read.');
check('and the new crawler saying a true nought is still a true nought, not a problem',
  L.crawlSummary({ schools: 0 }) === 'No schools with a website were left to read.' && L.crawlNeedsAttention({ schools: 0 }) === false);
check('a run that found nothing says so, without pretending', L.crawlSummary({ schools: 5, findings_written: 0 }) === 'Read 5 websites and found no fee table on any of them.');
check('...and one with nothing left to read says that instead', L.crawlSummary({ schools: 0 }) === 'No schools with a website were left to read.');
{
  const db = fakeDb({ data: { success: false, error: 'SB_SECRET_KEY is not set' }, error: null });
  const res = await L.readMoreWebsites(db);
  check('a crawler that could not start is an error here, not a silent success', !!res.error && /SB_SECRET_KEY/.test(res.error.message));
}

console.log('\n=== asking the database ===');
{
  const db = fakeDb();
  await L.loadFindings(db, 's1');
  check('only the lines still waiting, for the one school, oldest first',
    eq(db.calls.map((c) => c[0]), ['from', 'select', 'eq', 'eq', 'order', 'limit'])
    && db.calls[2][2] === 's1' && db.calls[3][2] === 'new', JSON.stringify(db.calls));
}
check('and nothing is asked for when no school is chosen', (await L.loadFindings(fakeDb(), null)).rows.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
