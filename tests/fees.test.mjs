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
  'findingsFromTable', 'findingsFromLines', 'readFeePage', 'bestFeeLink', 'howManySchools', 'dedupe', 'outcomeOf', 'headerRowIndex', 'scoreFeeLink', 'looksLikeFees'];
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
  // This fixture was here from the start and only ever asked about the year. It was quietly failing the far more
  // important question, and 96 lines were read off real school websites and marked untrustworthy before anybody
  // asked it: a title line above the headings was being read as the headings.
  check('...and a title line above the headings does not cost every column its name',
    got.length === 9 && got.every((f) => f.confidence === 'high'),
    JSON.stringify(got.slice(0, 2).map((f) => [f.grade_text, f.component, f.confidence])));
}
{
  const twoTitles = [['Fee Structure'], ['2026-27'], ...classic];
  const got = L.findingsFromTable(twoTitles, 'https://school.in/fees', null);
  check('...nor do two of them', got.length === 9 && got.every((f) => f.confidence === 'high'), String(got.filter((f) => f.confidence === 'high').length));
}
console.log('\n=== finding the headings ===');
check('the headings are the first row with more than one thing on it and no money in it',
  L.headerRowIndex([['Fee Structure 2026-27'], ['Class', 'Tuition'], ['Nursery', '45,000']]) === 1);
check('...the first row, when that is what they are', L.headerRowIndex([['Class', 'Tuition'], ['Nursery', '45,000']]) === 0);
check('...and a table that starts straight into figures has none, rather than losing its first row to the pretence',
  L.headerRowIndex([['Nursery', '45,000'], ['Class I', '55,000']]) === -1);
{
  const noHead = [['Nursery', '45,000'], ['Class I - V', '55,000']];
  const got = L.findingsFromTable(noHead, 'https://x.in/f', null);
  check('...so every row of it is read, including the first', got.length === 2 && got[0].amount === 45000, JSON.stringify(got.map((f) => f.amount)));
}
check('a title so long it is the whole table is not mistaken for headings',
  L.headerRowIndex([['Fee Structure for the academic year 2026-27'], ['Class', 'Tuition'], ['Nursery', '45,000']]) === 1);

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

// =================================================================================================================
// Every link below was really chosen, on a real Mumbai school's website, by a scorer that looked for the letters
// instead of the word. Following the wrong page is worse than following none: the school then gets recorded as
// having a fee page and having chosen to put nothing on it, which is a claim about that school that we made up.
// =================================================================================================================
// Every fixture below is a row this crawler really read off a Mumbai school's website, and got wrong.
console.log('\n=== the class written above the table, not in it ===');
{
  // The commonest fee table in India: two columns, one table per class, and the class in a heading above it.
  // Reading only what was inside the table left all 52 lines off nine real fee tables with no class at all.
  const page = {
    tables: [{
      heading: 'Nursery',
      rows: [
        ['Registration Fee', '\u20B9 500/- (Non Refundable)'],
        ['Tuition Fee (A)', '\u20B9 60,000/-'],
        ['Term Fee (B)', '\u20B9 10,000/-'],
        ['Gymkhana Fee (C)', '\u20B9 6,500/-'],
        ['Annual Charges (A+B)', '\u20B9 70,000/-'],
        ['Admission Fee (One-Time)', '\u20B9 25,000/- (Non Refundable)'],
      ],
    }],
    lines: [],
    text: 'Fee Structure 2026-27',
  };
  const got = L.readFeePage(page, 'https://school.in/fees');
  check('a two-column table with the class above it is read, and read confidently',
    got.length === 6 && got.every((f) => f.confidence === 'high' && f.level === 'preschool'),
    JSON.stringify(got.map((f) => [f.level, f.component, f.confidence])));
  check('...with each charge named for what it is',
    got.map((f) => f.component).join() === 'registration_fee,tuition,tuition,activities,other_annual,admission_fee',
    got.map((f) => f.component).join());
  check('...a gymkhana being an activity, not a mystery', got.find((f) => f.amount === 6500)?.component === 'activities');
  check('...and the heading kept as what was read, so a person can see where the class came from',
    got.every((f) => f.grade_text === 'Nursery'), got[0]?.grade_text);
}
{
  const page = { tables: [{ heading: 'Class VIII to X', rows: [['Tuition Fee', '\u20B9 90,000/-']] }], lines: [], text: '' };
  check('a heading naming older classes places them just as well', L.readFeePage(page, 'https://x.in/f')[0]?.level === 'secondary');
}
{
  const page = { tables: [{ heading: 'Our Fee Policy', rows: [['Tuition Fee', '\u20B9 90,000/-']] }], lines: [], text: '' };
  check('...and a heading that names no class leaves the line unsure, rather than inventing one',
    L.readFeePage(page, 'https://x.in/f')[0]?.confidence === 'low');
}

// =================================================================================================================
// Two real Mumbai fee tables, copied cell for cell off the pages themselves. Between them they read 52 lines and
// produced nothing anybody could trust, for two different reasons.
console.log('\n=== two real fee tables ===');
{
  // orchidsinternationalschool.com/fee-structure - a class on every row, and the charge named only by its period.
  // "Monthly Fees" never matched, because the pattern was "monthly fee" with a word boundary after it, and the
  // page says fees. A plural cost 28 lines.
  const orchids = { tables: [{ heading: '', rows: [
    ['Class', 'Monthly Fees (\u20B9)', 'Annual Fees (\u20B9)'],
    ['Pre Nursery', '9,167', '1,10,000'],
    ['Grade I', '11,667', '1,40,000'],
    ['Grade IX', '15,000', '1,80,000'],
  ] }], lines: [], text: '' };
  const got = L.readFeePage(orchids, 'https://x.in/f');
  check('a class on every row and a column headed only with a period reads in full',
    got.length === 6 && got.every((f) => f.confidence === 'high' && f.component === 'tuition'),
    JSON.stringify(got.map((f) => [f.level, f.component, f.confidence])));
  check('...with each class placed where it belongs',
    got.map((f) => f.level).join() === 'preschool,preschool,primary,primary,secondary,secondary', got.map((f) => f.level).join());
  check('...and both the monthly and the yearly figure kept, for a person to choose between',
    got.filter((f) => f.amount === 9167).length === 1 && got.filter((f) => f.amount === 110000).length === 1);
}
check('a plural is still the same word: "Monthly Fees" is what pages actually say',
  L.componentFrom('Monthly Fees (\u20B9)') === 'tuition' && L.componentFrom('Annual Fees (\u20B9)') === 'tuition'
  && L.componentFrom('Annual Charges (A+B)') === 'other_annual');
{
  // svischool.com - one table per class, each in an accordion, the class written in a plain <div> above it. Nothing
  // about a heading requires it to be a heading tag, and looking only for h1-h6 found none of them.
  const svis = { tables: [{ heading: 'Nursery \u25BE', rows: [
    ['Registration Fee', '\u20B9 500/- (Non Refundable)'],
    ['Admission Fee (One-Time)', '\u20B9 25,000/- (Non Refundable)'],
    ['Tuition Fee (A)', '\u20B9 72,000/-'],
    ['Term Fee (B)', '\u20B9 12,000/-'],
  ] }], lines: [], text: '' };
  const got = L.readFeePage(svis, 'https://x.in/f');
  check('a two-column table whose class is written above it reads in full',
    got.length === 4 && got.every((f) => f.confidence === 'high' && f.level === 'preschool'),
    JSON.stringify(got.map((f) => [f.level, f.component, f.confidence])));
  check('...and the arrow a dropdown leaves on the heading does not stop the class being read',
    got.every((f) => f.grade_text === 'Nursery \u25BE'), got[0]?.grade_text);
}
{
  // the other shape: one table, with the class written as a row between each block of charges
  const blocks = { tables: [{ heading: '', rows: [
    ['Particulars', 'Amount'],
    ['Nursery', ''],
    ['Tuition Fee', '\u20B9 60,000/-'],
    ['Class I to V', ''],
    ['Tuition Fee', '\u20B9 72,000/-'],
  ] }], lines: [], text: '' };
  const got = L.readFeePage(blocks, 'https://x.in/f');
  check('a class named part way down a table holds for the rows beneath it',
    got.length === 2 && got[0].level === 'preschool' && got[1].level === 'primary' && got.every((f) => f.confidence === 'high'),
    JSON.stringify(got.map((f) => [f.grade_text, f.level, f.amount, f.confidence])));
  check('...so the same charge twice over is told apart by the class it belongs to',
    got[0].amount === 60000 && got[1].amount === 72000);
}

console.log('\n=== the tables that are not about money ===');
check('a CBSE disclosure page is mostly tables, and an affiliation number reads exactly like a fee',
  !L.looksLikeFees([['1', 'Affiliation no.(if applicable)', '1130325'], ['2', 'School code', '30251']]));
check('...as does a campus area in square metres', !L.looksLikeFees([['1', 'Total campus area of the school (in sq mtr)', '4887.05 sq. mtr.']]));
check('...and a board results table', !L.looksLikeFees([['1', '2024-25', '361', '360', '100%', '-']]));
check('a table that says so is about fees', L.looksLikeFees([['Class', 'Tuition Fee'], ['Nursery', '45,000']])
  && L.looksLikeFees([['Registration Fee', '\u20B9 500/-']]));

console.log('\n=== the sentences that are not about money ===');
{
  const notFees = [
    'The Student Scoop Floor P-1/13-Raj Rahul Building, Hatkesh Society, Juhu, Mumbai - 400049',
    'U. S CLUB, 14/4 MAGDALA HOUSE, NEAR R. C CHURCH, Mumbai, Maharashtra, India - 400005',
  ];
  check('an address ending in a pincode is not a charge of four lakh',
    notFees.every((line) => L.findingsFromLines([line], 'https://x.in', null).length === 0),
    JSON.stringify(L.findingsFromLines(notFees, 'https://x.in', null)));
  check('"BOOK A SESSION" is not a charge for textbooks',
    L.findingsFromLines(['BOOK A SESSIONRs.800 - 1000Rs.800 - 1000Book Now'], 'https://x.in', null).length === 0);
  check('...and a sentence that really does name a fee is still read',
    L.findingsFromLines(['Tuition Fee: Rs. 45,000 per annum'], 'https://x.in', null).length === 1);
}

console.log('\n=== the pages that are not fee pages ===');
const followed = (text, href) => L.scoreFeeLink(text, href) >= 3;
{
  const wrong = [
    ['six of these were picked because "infrastructure" ends in "structure"', 'Infrastructure', 'https://friendsacademy.in/infrastructure/'],
    ['...including a safety committee page', 'Students Safety and Infrastructure', 'https://canossahighschool.edu.in/about-us/managing-committee/students-safety-and-infrastructure-development-committee'],
    ['"feedback" begins with "fee" and has nothing to do with money', 'Parents Feedback', 'https://www.risingstarpreprimaryschool.com/parents-feedback'],
    ['a place to hand over a fee never says what the fee is', 'Pay Fees', 'https://littleleaders.in/pay-fees'],
    ['...nor does a payment page', 'Payment', 'https://mindseed.in/payment'],
    ['...nor a bank gateway', 'Online Payment Terms', 'https://stjohnsuniversal.edu.in/admission/online-payment-terms/'],
    ['a blog post about schools is not a fee page', 'Blog', 'https://www.jbcnschool.edu.in/blog/unveiling-how-the-best-ib-schools-in-mumbai-nurtures-every-learners-potential/'],
    ['...nor is a list of articles', 'Articles', 'https://branches.narayanaschools.in/locations/mumbai/borivali/narayana-schools-in-borivali-mumbai--4Khwtm/articles'],
    ['...nor a page of circulars', 'Circulars', 'https://greenlawns.org/GLSW/Circulars.html?ModuleUploadID=2170'],
    ['an admissions page is about admission, and was being followed for want of anything better', 'Admissions', 'https://www.asbindia.org/join-our-school/admissions'],
    ['...as was an enquiry form', 'Enquiry', 'http://www.archimedesacademy.co.in/EnquiryForm.asp'],
  ];
  for (const [what, text, href] of wrong) check(what, !followed(text, href), `scored ${L.scoreFeeLink(text, href)}`);
}

console.log('\n=== and the pages that are ===');
{
  const right = [
    ['a page that says fee structure', 'Fee Structure', 'https://school.in/fee-structure'],
    ['a tuition fee page', 'Tuition Fee', 'https://www.activityinfantschool.com/new-parent-school-tuition-fee.php'],
    ['a page simply called Fees, however the address is spelled', 'Fees', 'http://www.bsmsmumbai.ac.in/Fees.aspx'],
    ['...or with no spelling at all', 'Fees', 'https://stmarysicsekk.com/fees'],
    ['the disclosure every CBSE school must publish, which is where its fees are', 'Mandatory Public Disclosure', 'https://podar.org/school-information'],
  ];
  for (const [what, text, href] of right) check(what, followed(text, href), `scored ${L.scoreFeeLink(text, href)}`);
}
check('a payment page is followed after all when it says plainly that it carries the fee structure',
  followed('Fee Structure and Payment', 'https://school.in/fee-structure-payment'), String(L.scoreFeeLink('Fee Structure and Payment', 'https://school.in/fee-structure-payment')));

console.log('\n=== how many schools in one go ===');
check('a sensible default, and never more than the ceiling, whatever is asked for',
  L.howManySchools(undefined) === 8 && L.howManySchools(3) === 3 && L.howManySchools(500) === 25 && L.howManySchools('x') === 8 && L.howManySchools(-1) === 8);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
