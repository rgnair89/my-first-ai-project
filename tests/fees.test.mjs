// Tests for the part of crawl-school-fees that decides what a number on a school's website means.
// Run: node tests/fees.test.mjs
//
// The function itself is one file, because it is pasted into the Supabase dashboard. The part worth testing is
// marked off inside it and uses no imports and no Deno globals, so it can be lifted out and run here. Node reads the
// TypeScript directly; nothing needs installing.
//
// Why this exists at all: the crawler before this one guessed, and its guesses reached parents. Every rule about
// what counts as a fee is now written down twice - once in the function, once here as the case it was written for.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'supabase', 'functions', 'crawl-school-fees', 'index.ts'), 'utf8');
const a = src.indexOf('// ==== BEGIN testable logic');
const b = src.indexOf('// ==== END testable logic');
if (a < 0 || b < 0) throw new Error('the markers are gone from crawl-school-fees/index.ts');

const names = ['tidy', 'levelFromGrade', 'gradeSpansLevels', 'componentFrom', 'amountFrom', 'academicYearFrom',
  'findingsFromTable', 'findingsFromLines', 'readFeePage', 'bestFeeLink', 'howManySchools', 'dedupe', 'outcomeOf'];
fs.mkdirSync(path.join(here, '.tmp'), { recursive: true });
const file = path.join(here, '.tmp', 'fee-logic.mts');
fs.writeFileSync(file, `${src.slice(a, b)}\nexport { ${names.join(', ')} };\n`);
const L = await import(pathToFileURL(file).href);

let pass = 0;
let fail = 0;
const check = (what, ok, extra = '') => {
  if (ok) { pass += 1; console.log('PASS  ' + what); } else { fail += 1; console.log('FAIL  ' + what + (extra ? '  -> ' + extra : '')); }
};
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// =================================================================================================================
console.log('=== what class is this about? ===');
check('the words Indian schools actually use for the youngest children',
  ['Nursery', 'LKG', 'UKG', 'Jr. KG', 'Sr KG', 'Play Group', 'Pre-Primary', 'Montessori', 'Kindergarten']
    .every((x) => L.levelFromGrade(x) === 'preschool'),
  ['Nursery', 'LKG', 'UKG', 'Jr. KG', 'Sr KG', 'Play Group', 'Pre-Primary', 'Montessori', 'Kindergarten'].map((x) => x + '=' + L.levelFromGrade(x)).join(' '));
check('a creche is daycare, which is not the same thing as a preschool',
  L.levelFromGrade('Creche') === 'daycare' && L.levelFromGrade('Day Care') === 'daycare');
check('classes 1 to 7 are primary, written however the school writes them',
  ['Class I', 'Std. 3', 'Grade 5', 'Class I - V', 'Classes 1 to 7'].every((x) => L.levelFromGrade(x) === 'primary'),
  ['Class I', 'Std. 3', 'Grade 5', 'Class I - V', 'Classes 1 to 7'].map((x) => x + '=' + L.levelFromGrade(x)).join(' '));
check('classes 8 and up are secondary, in roman numerals too',
  ['Class VIII', 'Std. 10', 'Class IX - X', 'Grade 11', 'Class XII'].every((x) => L.levelFromGrade(x) === 'secondary'),
  ['Class VIII', 'Std. 10', 'Class IX - X', 'Grade 11', 'Class XII'].map((x) => x + '=' + L.levelFromGrade(x)).join(' '));
check('the words for it, when a school names no number at all',
  L.levelFromGrade('Higher Secondary') === 'secondary' && L.levelFromGrade('High School') === 'secondary' && L.levelFromGrade('Primary Section') === 'primary');
check('a number with no class word is not a class: "45,000" is money, not class 45',
  L.levelFromGrade('45,000') === null && L.levelFromGrade('2026') === null && L.levelFromGrade('') === null && L.levelFromGrade(null) === null);
check('a range that crosses primary and secondary is flagged, because the level is then a choice and not a reading',
  L.gradeSpansLevels('Class I to X') === true && L.gradeSpansLevels('Class I - V') === false && L.gradeSpansLevels('Nursery') === false);

// =================================================================================================================
console.log('\n=== what is the money for? ===');
check('the nine things the fees table knows about, each recognised from how a school writes it',
  L.componentFrom('Tuition Fee') === 'tuition'
  && L.componentFrom('Admission Fee') === 'admission_fee'
  && L.componentFrom('Registration Charges') === 'registration_fee'
  && L.componentFrom('Caution Money (Refundable)') === 'deposit'
  && L.componentFrom('Bus Fee') === 'transport'
  && L.componentFrom('Canteen / Meals') === 'meals'
  && L.componentFrom('Uniform & Books') === 'uniform_books'
  && L.componentFrom('Sports and Activities') === 'activities'
  && L.componentFrom('Development Charges') === 'other_annual');
check('"annual charges" is a development fee, not tuition - the order these are tried in matters',
  L.componentFrom('Annual Charges') === 'other_annual' && L.componentFrom('Annual Fee') === 'tuition');
check('anything it cannot place is called unknown rather than guessed at',
  L.componentFrom('Total') === 'unknown' && L.componentFrom('Particulars') === 'unknown' && L.componentFrom('') === 'unknown');

// =================================================================================================================
console.log('\n=== is that an amount? ===');
check('money as Indian schools print it', L.amountFrom('45,000') === 45000 && L.amountFrom('Rs. 1,20,000/-') === 120000
  && L.amountFrom('₹ 8500') === 8500 && L.amountFrom('INR 60000') === 60000);
check('a bare year is not money', L.amountFrom('2026') === null && L.amountFrom('2027') === null);
check('...but the same digits written as money are', L.amountFrom('Rs. 2026') === 2026 && L.amountFrom('2,026') === 2026);
check('nothing too small to be a fee, and nothing bigger than the fees table allows',
  L.amountFrom('50') === null && L.amountFrom('299') === null && L.amountFrom('300') === 300 && L.amountFrom('90,00,000') === null);
check('an empty cell is not a nought', L.amountFrom('') === null && L.amountFrom('-') === null && L.amountFrom(null) === null);

// =================================================================================================================
console.log('\n=== which year are these fees for? ===');
check('the ways a school writes an academic year', L.academicYearFrom('Fee Structure 2026-27') === '2026-27'
  && L.academicYearFrom('Session 2026-2027') === '2026-27' && L.academicYearFrom('A.Y. 2027 - 28') === '2027-28');
check('...and not a pair of years that is not one', L.academicYearFrom('2026-29') === null && L.academicYearFrom('established 1998') === null && L.academicYearFrom('') === null);

// =================================================================================================================
console.log('\n=== a real fee table ===');
const classic = [
  ['Class', 'Tuition Fee', 'Transport', 'Admission Fee'],
  ['Nursery', '45,000', '12,000', '25,000'],
  ['Class I - V', '55,000', '12,000', '25,000'],
  ['Class VIII - X', '72,000', '14,000', '30,000'],
];
{
  const got = L.findingsFromTable(classic, 'https://school.in/fees', '2026-27');
  check('every amount in it becomes a finding, and nothing else does', got.length === 9, String(got.length));
  const nursery = got.filter((f) => f.level === 'preschool');
  check('...the class on the row and the heading on the column together give a figure its meaning',
    nursery.length === 3 && eq(nursery.map((f) => [f.component, f.amount]), [['tuition', 45000], ['transport', 12000], ['admission_fee', 25000]]),
    JSON.stringify(nursery.map((f) => [f.component, f.amount])));
  check('...so those are the ones worth a person looking at', got.every((f) => f.confidence === 'high'), JSON.stringify(got.filter((f) => f.confidence !== 'high')));
  check('...the row it was read from is kept, word for word, so nobody has to take this on trust',
    /Nursery \| 45,000/.test(nursery[0].evidence), nursery[0].evidence);
  check('...and classes 8 to 10 are secondary', got.filter((f) => f.level === 'secondary').length === 3);
  check('...with the year carried down from the page', got.every((f) => f.academic_year === '2026-27'));
}
{
  const withYear = [['Fee Structure 2027-28', '', ''], ...classic];
  const got = L.findingsFromTable(withYear, 'https://school.in/fees', '2026-27');
  check('a year printed inside the table beats the one on the rest of the page', got.every((f) => f.academic_year === '2027-28'), got[0]?.academic_year);
}

console.log('\n=== the same table, the other way round ===');
{
  const transposed = [
    ['Particulars', 'Nursery', 'LKG', 'Class VI'],
    ['Tuition Fee', '45,000', '48,000', '61,000'],
    ['Bus Fee', '12,000', '12,000', '14,000'],
  ];
  const got = L.findingsFromTable(transposed, 'https://school.in/fees', null);
  check('classes across the top and the charges down the side is read just as well', got.length === 6, String(got.length));
  check('...each figure still gets the right class and the right charge',
    eq(got.slice(0, 3).map((f) => [f.level, f.component, f.amount]),
      [['preschool', 'tuition', 45000], ['preschool', 'tuition', 48000], ['primary', 'tuition', 61000]]),
    JSON.stringify(got.slice(0, 3).map((f) => [f.level, f.component, f.amount])));
}

console.log('\n=== and the tables that are not fee tables ===');
{
  const staff = [['Name', 'Phone'], ['Mrs Rao', '9820011111'], ['Mr Iyer', '9820022222']];
  check('a staff list with phone numbers in it yields nothing', L.findingsFromTable(staff, 'https://x.in', null).length === 0);
  const results = [['Class', 'Pass %', 'Year'], ['Class X', '98', '2026'], ['Class XII', '97', '2025']];
  check('a results table yields nothing either: percentages are too small and years are not money',
    L.findingsFromTable(results, 'https://x.in', null).length === 0, JSON.stringify(L.findingsFromTable(results, 'https://x.in', null)));
}
{
  const vague = [['Fees', 'Amount'], ['Total', '1,20,000'], ['Class I to X', '85,000']];
  const got = L.findingsFromTable(vague, 'https://x.in', null);
  check('a row it cannot place is still reported, but marked as not worth trusting on its own',
    got.length === 2 && got.every((f) => f.confidence === 'low'), JSON.stringify(got.map((f) => [f.grade_text, f.component, f.confidence])));
}

console.log('\n=== a page with no table at all ===');
{
  const lines = ['Tuition Fee: Rs. 45,000 per annum', 'Admission Fee - 25,000', 'Our school was founded in 1998',
    'Call us on 9820011111', 'Rs. 60,000'];
  const got = L.findingsFromLines(lines, 'https://x.in/fees', '2026-27');
  check('a labelled amount in a sentence is worth something', got.length === 2 && eq(got.map((f) => [f.component, f.amount]), [['tuition', 45000], ['admission_fee', 25000]]),
    JSON.stringify(got.map((f) => [f.component, f.amount])));
  check('...a number with nothing said about it is worth nothing', !got.some((f) => f.amount === 60000));
  check('...a phone number and the year the school was founded are not fees', !got.some((f) => f.amount === 1998 || String(f.amount).startsWith('98200')));
  check('...and prose is never called reliable, because it never names the class as plainly as a table does',
    got.every((f) => f.confidence === 'low'));
}
{
  const page = { tables: [classic], lines: ['Tuition Fee: Rs. 99,000'], text: 'Fees for 2026-27' };
  const got = L.readFeePage(page, 'https://x.in/fees');
  check('when a page has a real table, the sentences around it are left alone', got.length === 9 && !got.some((f) => f.amount === 99000), String(got.length));
}
check('the same figure printed twice is one finding, not two',
  L.dedupe([{ level: 'primary', component: 'tuition', amount: 5, grade_text: 'a', component_text: 'b' },
    { level: 'primary', component: 'tuition', amount: 5, grade_text: 'a', component_text: 'b' }]).length === 1);

console.log('\n=== finding the fee page in the first place ===');
{
  const links = [
    { href: '/about', text: 'About us' },
    { href: '/admissions', text: 'Admissions' },
    { href: '/fee-structure', text: 'Fee Structure' },
    { href: '/docs/fees-2026.pdf', text: 'Fee schedule (PDF)' },
    { href: 'mailto:head@school.in', text: 'Email the fees office' },
  ];
  const got = L.bestFeeLink(links, 'https://school.in/');
  check('the page that says "fee structure" wins over the one that says "admissions"', got.page === 'https://school.in/fee-structure', got.page);
  check('...a relative link is made whole against the school\'s own address', got.page.startsWith('https://school.in/'));
  check('...a PDF is noted separately, because it cannot be read as a page', got.pdf === 'https://school.in/docs/fees-2026.pdf', got.pdf);
  check('...and an email address is not a page', !String(got.page).includes('mailto'));
  check('a site with nothing fee-shaped on it sends nobody anywhere', eq(L.bestFeeLink([{ href: '/about', text: 'About' }], 'https://x.in/'), { page: null, pdf: null }));
}

console.log('\n=== what reading one site came to ===');
check('numbers on a page is the good case, whatever we went on to make of them',
  L.outcomeOf({ found: 3, feePage: 'https://x.in/fees' }) === 'table'
  && L.outcomeOf({ found: 1, pdf: 'https://x.in/f.pdf', feePage: 'https://x.in/fees' }) === 'table');
check('only a PDF is the case that decides whether a PDF reader is worth writing',
  L.outcomeOf({ found: 0, pdf: 'https://x.in/fees.pdf', feePage: 'https://x.in/fees' }) === 'pdf_only');
check('a fee page with nothing on it is not the same as no fee page: one is the school\'s choice, the other may be ours',
  L.outcomeOf({ found: 0, feePage: 'https://x.in/fees' }) === 'page_no_numbers'
  && L.outcomeOf({ found: 0 }) === 'no_fee_page');
check('a site that could not be read is counted as that, and not as a school with no fees',
  L.outcomeOf({ failed: true, found: 0 }) === 'failed'
  && L.outcomeOf({ failed: true, found: 3, feePage: 'https://x.in/fees' }) === 'failed');
check('and nothing at all still gets an answer rather than a crash', L.outcomeOf({}) === 'no_fee_page' && L.outcomeOf(undefined) === 'no_fee_page');

console.log('\n=== how many schools in one go ===');
check('a sensible default, and never more than the ceiling, whatever is asked for',
  L.howManySchools(undefined) === 8 && L.howManySchools(3) === 3 && L.howManySchools(500) === 25 && L.howManySchools('x') === 8 && L.howManySchools(-1) === 8);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
