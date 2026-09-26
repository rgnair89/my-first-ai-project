// supabase/functions/crawl-school-fees/index.ts
//
// Self-contained: paste this whole file into the dashboard editor. No other files are needed.
// Secrets it reads:
//   SB_SECRET_KEY  optional - a Supabase secret key (sb_secret_...). Falls back to the built-in
//                  SUPABASE_SERVICE_ROLE_KEY, which stops working once legacy keys are disabled.
//
// Before it can work: run supabase/migrations/20260926000100_fee_findings.sql.
//
// It reads school websites and writes what it SAW into school_fee_findings - never into school_fee_schedules.
// The difference matters. The first version of this crawler took the median of every rupee figure on a page and
// called it a fee, which is how a school with a 25,000 uniform bill gets advertised at 25,000 a year. A wrong fee is
// worse than no fee: a family chooses a school on it and has no way of knowing. So nothing here reaches a parent
// until a Kidscover admin has looked at the row it came from and agreed to it.
//
// What it does instead of guessing: it reads fee *tables*. A row that names a class and a column that names what the
// money is for give a figure its meaning - "Class I to V, Tuition, 45,000" is a fee; "45,000" on its own is a number.
// Findings with both are marked "high"; anything less is "low" and sorts to the bottom of the queue.
//
// It also writes one row per school into school_fee_crawls saying what reading that site actually turned up - a
// table, only a PDF, a fee page with no numbers on it, no fee page at all, or a site that could not be read. Counting
// those is what decides whether writing a PDF reader is worth it, and costs nothing to find out.
//
// POST body, all optional: { "limit": 8, "schoolIds": ["uuid", ...], "dryRun": true }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as cheerio from "https://esm.sh/cheerio@1.0.0-rc.12";

// ==== BEGIN testable logic (must not use imports or Deno globals) ====

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_SCHOOLS_PER_CALL = 25;
const MAX_FINDINGS_PER_PAGE = 60;
const MIN_FEE = 300;         // a registration fee can be small; below this it is not money anybody charges
const MAX_FEE = 5000000;     // the same ceiling the fees table has

// ---- reading a class out of whatever the school wrote -----------------------------------------------------------
const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12,
};

function tidy(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Numbers only count as classes when the cell says it is talking about classes. Without that rule, "45,000" sitting
// in a column headed "Class" would be read as class 45.
function gradeNumbersIn(t: string): number[] {
  if (!/\b(class|classes|std|standard|grade|grades|cl)\b/.test(t)) return [];
  const nums: number[] = [];
  for (const m of t.matchAll(/\b(1[0-2]|[1-9])\b/g)) nums.push(Number(m[1]));
  for (const m of t.matchAll(/\b(xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/g)) {
    const n = ROMAN[m[1]];
    if (n) nums.push(n);
  }
  return nums;
}

// Which of the four levels a piece of text is about, or null when it is not about a class at all.
function levelFromGrade(text: unknown): string | null {
  const t = tidy(text);
  if (!t) return null;
  if (/\b(cr[eè]che|day\s?care|daycare)\b/.test(t)) return "daycare";
  if (/\b(play\s?group|play\s?home|pre\s?-?\s?nursery|nursery|montessori|kinder\s?garten|lkg|ukg|kg|jr\.?\s?kg|sr\.?\s?kg|junior\s?kg|senior\s?kg|pre\s?-?\s?kg|pre\s?-?\s?primary|pre\s?-?\s?school)\b/.test(t)) return "preschool";
  const nums = gradeNumbersIn(t);
  if (nums.length) {
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    if (hi <= 7) return "primary";
    if (lo >= 8) return "secondary";
    return "primary";   // a range across both, like "I to X": the lower one, and the caller calls it unsure
  }
  if (/\b(higher|senior)\s+secondary\b|\bhsc\b|\bplus\s?two\b|\bjunior\s+college\b/.test(t)) return "secondary";
  if (/\bsecondary\b|\bhigh\s?school\b/.test(t)) return "secondary";
  if (/\bprimary\b|\bmiddle\b|\belementary\b/.test(t)) return "primary";
  return null;
}

// True when the class text covers both primary and secondary, so the level is a choice rather than a reading.
function gradeSpansLevels(text: unknown): boolean {
  const nums = gradeNumbersIn(tidy(text));
  if (nums.length < 2) return false;
  return Math.min(...nums) <= 7 && Math.max(...nums) >= 8;
}

// ---- reading what the money is for ------------------------------------------------------------------------------
// Order matters: "annual charges" is a development-type fee, not tuition, so it has to be tried first.
const COMPONENTS: Array<[string, RegExp]> = [
  ["admission_fee", /\badmission\b/],
  ["registration_fee", /\b(registration|enrol|enroll|application|prospectus|form)\b/],
  ["deposit", /\b(deposit|caution|security|refundable)\b/],
  ["transport", /\b(transport|bus|van|conveyance)\b/],
  ["meals", /\b(meal|meals|food|lunch|canteen|mess|snack|nutrition)\b/],
  // "books" and not "book": a preschool page offering to BOOK A SESSION was being read as a charge for textbooks.
  ["uniform_books", /\b(uniform|books|stationer|text\s?books?)\b/],
  ["activities", /\b(activit|sports?|excursion|trip|club|swim|music|dance|gymkhana|lab|computer)/],
  ["other_annual", /\b(development|maintenance|building|infrastructure|miscellaneous|misc|annual\s+charge|general\s+charge|amenit)/],
  // A column headed with nothing but a period - "Monthly", "Annual", "Per Term" - is the tuition for that period.
  // It is the commonest heading on a class-per-row table, and calling it unknown buried 28 perfectly good lines
  // off one school: "Grade I | 11,667 | 1,40,000" is the monthly and the yearly figure, and both are tuition.
  ["tuition", /\b(tuition|academic|composite|school\s+fee|term\s+fee|session\s+fee|monthly|per\s+month|annual|annually|per\s+annum|yearly|per\s+year|quarterly|per\s+term|termly|amount|payable)\b/],
];

function componentFrom(text: unknown): string {
  const t = tidy(text);
  if (!t) return "unknown";
  for (const [key, pattern] of COMPONENTS) if (pattern.test(t)) return key;
  return "unknown";
}

// ---- reading an amount ------------------------------------------------------------------------------------------
function amountFrom(cell: unknown): number | null {
  const t = String(cell ?? "");
  const hasCurrency = /(?:rs\.?|inr|₹)/i.test(t);
  const m = t.match(/(\d[\d,]*\d|\d)(?:\s*\/-)?/);
  if (!m) return null;
  const digits = m[1].replace(/,/g, "");
  if (!/^\d{3,8}$/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n < MIN_FEE || n > MAX_FEE) return null;
  // A bare four-digit number near today is a year, not money - unless it is written the way money is written.
  if (!hasCurrency && !m[1].includes(",") && n >= 1990 && n <= 2100) return null;
  return n;
}

// ---- the academic year the page is about ------------------------------------------------------------------------
function academicYearFrom(text: unknown): string | null {
  const t = String(text ?? "");
  for (const m of t.matchAll(/\b(20[2-9][0-9])\s*[-–—\/]\s*(20)?(\d{2})\b/g)) {
    const start = Number(m[1]);
    const endTwo = Number(m[3]);
    if ((start + 1) % 100 === endTwo) return `${start}-${m[3].padStart(2, "0")}`;
  }
  return null;
}

// Whether a table is about money at all.
//
// A CBSE Mandatory Public Disclosure page is mostly tables, and almost none of them are fees: the affiliation number
// (1130325), the school code (30251) and the campus area (4887 sq mtr) all read as perfectly plausible rupee amounts.
// A table earns a reading only if something on it says it is about fees.
function looksLikeFees(rows: string[][]): boolean {
  for (const row of rows ?? []) {
    for (const cell of row ?? []) {
      if (/\bfees?\b|\u20B9|\brs\.?\b|\binr\b|\btuition\b|\badmission\b/i.test(String(cell ?? ""))) return true;
    }
  }
  return false;
}

// ---- turning one table into findings ----------------------------------------------------------------------------
// `rows` is the table as plain strings. Two shapes are common on school sites and both are handled: classes down the
// side with what the money is for across the top, and the other way round.
// Which row holds the column headings.
//
// Assuming it is the first row is wrong on most real fee tables, because they open with a title line - "Fee
// Structure 2026-27", spanning the width - above the headings. Reading that as the headings leaves every column
// unnamed, and then every figure on the table comes out as a number nobody can say anything about. That is exactly
// what happened to the first 96 lines this crawler read: not one of them could be trusted.
//
// The headings are the first row near the top with more than one thing written on it and no money in it.
function headerRowIndex(rows: string[][]): number {
  const look = Math.min(rows.length - 1, 4);
  for (let i = 0; i < look; i += 1) {
    const row = rows[i] ?? [];
    if (row.filter((c) => String(c ?? "").trim() !== "").length < 2) continue;   // a title across the table
    if (row.some((c) => amountFrom(c) !== null)) continue;                        // already a row of figures
    return i;
  }
  return -1;   // no headings at all: every row is a row of the table
}

// `heading` is whatever was written immediately above the table on the page. It matters more than it sounds: the
// commonest fee table in India is two columns - the charge and the amount - with the class in a heading above it
// ("Nursery", "Class I to V"), one table per class. Reading only what is inside the table leaves every one of those
// rows with no class at all, which is why 52 lines off nine real fee tables were all marked untrustworthy.
function findingsFromTable(rows: string[][], sourceUrl: string, pageYear: string | null, heading?: unknown): any[] {
  const out: any[] = [];
  // One row is a small fee table, not a broken one: "Tuition Fee | 90,000" says everything it needs to.
  if (!Array.isArray(rows) || rows.length < 1) return out;

  const headAt = headerRowIndex(rows);
  const head = headAt >= 0 ? rows[headAt] : [];
  const body = rows.slice(headAt + 1);
  const headLevels = head.filter((c) => levelFromGrade(c)).length;
  const headComponents = head.filter((c) => componentFrom(c) !== "unknown").length;
  const transposed = headLevels >= 2 && headLevels > headComponents;

  const rowYear = academicYearFrom(rows.map((r) => r.join(" ")).join(" ")) ?? pageYear;

  // The class is often written as a row of the table rather than above it: one line saying "Nursery", then that
  // class's charges, then a line saying "Class I to V", and so on down a single table. Such a row names a class and
  // carries no money. Remembering it is what tells the rows beneath it who they are about - without it, one table
  // yields "Tuition Fee" three times over with three different amounts and no way to tell them apart.
  const isClassRow = (row: string[]) => {
    const filled = (row ?? []).map((c) => String(c ?? "").trim()).filter((c) => c !== "");
    if (!filled.length || filled.length > 2) return false;
    if ((row ?? []).some((c) => amountFrom(c) !== null)) return false;
    return levelFromGrade(filled[0]) !== null;
  };

  let saidAbove = String(heading ?? "");

  for (const row of body) {
    if (!Array.isArray(row)) continue;
    if (isClassRow(row)) {
      saidAbove = (row.map((c) => String(c ?? "").trim()).filter((c) => c !== "")[0]) ?? saidAbove;
      continue;
    }
    if (row.length < 2) continue;
    const label = row[0] ?? "";
    for (let i = 1; i < row.length; i += 1) {
      const amount = amountFrom(row[i]);
      if (amount === null) continue;
      const headCell = head[i] ?? "";

      const gradeText = transposed ? headCell : label;
      const componentText = transposed ? label : (componentFrom(headCell) !== "unknown" ? headCell : label);

      // the class from the row if it is there, otherwise from the last class named on the way down the table,
      // otherwise from whatever was written above the table
      const fromRow = levelFromGrade(gradeText);
      const level = fromRow ?? levelFromGrade(saidAbove);
      const saidWhere = fromRow ? gradeText : (level ? saidAbove : gradeText);
      const component = componentFrom(componentText);
      const unsure = level === null || component === "unknown" || gradeSpansLevels(saidWhere);

      out.push({
        source_url: sourceUrl,
        grade_text: String(saidWhere).slice(0, 120) || null,
        component_text: String(componentText).slice(0, 120) || null,
        evidence: row.join(" | ").replace(/\s+/g, " ").trim().slice(0, 400),
        level,
        academic_year: rowYear,
        component,
        amount,
        confidence: unsure ? "low" : "high",
      });
      if (out.length >= MAX_FINDINGS_PER_PAGE) return out;
    }
  }
  return out;
}

// ---- and one line of prose, for sites with no table at all ------------------------------------------------------
// Only lines that name what the money is for. "Rs. 45,000" on its own is a number, not a finding.
function findingsFromLines(lines: string[], sourceUrl: string, pageYear: string | null): any[] {
  const out: any[] = [];
  for (const line of lines ?? []) {
    const text = String(line ?? "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 200) continue;
    const parts = text.split(/[:–-]\s|\s{2,}/);
    if (parts.length < 2) continue;
    // An address ending in a pincode - "Juhu, Mumbai - 400049" - was being read as a charge of four lakh. A sentence
    // has to say "fee" before any number in it is treated as one.
    if (!/\bfees?\b/i.test(text)) continue;
    const label = parts[0];
    const component = componentFrom(label);
    if (component === "unknown") continue;
    const amount = amountFrom(parts.slice(1).join(" "));
    if (amount === null) continue;
    const level = levelFromGrade(text);
    out.push({
      source_url: sourceUrl,
      grade_text: level ? text.slice(0, 120) : null,
      component_text: label.slice(0, 120),
      evidence: text.slice(0, 400),
      level,
      academic_year: academicYearFrom(text) ?? pageYear,
      component,
      amount,
      confidence: "low",   // prose never names a class as plainly as a table does
    });
    if (out.length >= MAX_FINDINGS_PER_PAGE) break;
  }
  return out;
}

// The same figure printed twice on a page is one finding, not two.
function dedupe(findings: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const f of findings) {
    const key = [f.level ?? "", f.component, f.amount, f.grade_text ?? "", f.component_text ?? ""].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// Everything above, over a whole page. `page` is { tables, lines, text }, already pulled out of the HTML.
function readFeePage(page: any, sourceUrl: string): any[] {
  const pageYear = academicYearFrom(page?.text ?? "");
  const found: any[] = [];
  for (const table of page?.tables ?? []) {
    // a table is either the bare rows, or the rows with whatever was written above them
    const rows = Array.isArray(table) ? table : table?.rows;
    const heading = Array.isArray(table) ? "" : (table?.heading ?? "");
    if (!Array.isArray(rows) || !looksLikeFees(rows)) continue;
    for (const f of findingsFromTable(rows, sourceUrl, pageYear, heading)) found.push(f);
    if (found.length >= MAX_FINDINGS_PER_PAGE) break;
  }
  // Prose is a fallback, not an addition: a page with a real table has already said what it has to say.
  if (found.length === 0) for (const f of findingsFromLines(page?.lines ?? [], sourceUrl, pageYear)) found.push(f);
  return dedupe(found).slice(0, MAX_FINDINGS_PER_PAGE);
}

// Words that contain "fee" but are not about fees, and pages that are not where a fee is written down.
//
// Every one of these was picked, on a real school site, by a scorer that looked for the letters rather than the word:
// six "infrastructure" pages matched "structure", a "parents-feedback" page matched "fee", and a shelf of payment
// portals matched "payment". A page fetched by mistake is worse than no page at all, because it gets counted as a
// school that has a fee page and chose to put nothing on it - which is a claim about the school, made up by us.
const NOT_ABOUT_FEES = /feedback|feeder|coffee|infrastructure/;
// A place to hand over money is never a place that lists what the money is. Unless it says, plainly, that it is
// the fee structure - some schools do put the table on the payment page.
const PLACE_TO_PAY = /\b(pay|paying|payment|payments|epay|gateway|checkout|collect|collection|login|signin|portal|transaction)\b/;
// Nor is anything a school wrote about itself.
const NOT_A_PAGE_AT_ALL = /\b(blog|blogs|article|articles|news|circular|circulars|gallery|event|events)\b/;
const SAYS_FEE = /\bfees?\b/;
const SAYS_FEE_STRUCTURE = /\bfees?\s+structure\b/;

// How likely one link is to lead to a page with the fees written on it. Nought means do not follow it.
function scoreFeeLink(text: unknown, href: unknown): number {
  const t = tidy(text);
  // the address read as words, so "/fee-structure", "/fees.aspx" and "/fees" all say the same thing
  const h = String(href ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const both = `${t} ${h}`;
  if (NOT_ABOUT_FEES.test(both)) return 0;
  if (NOT_A_PAGE_AT_ALL.test(h)) return 0;
  if (PLACE_TO_PAY.test(both) && !SAYS_FEE_STRUCTURE.test(both)) return 0;
  let score = 0;
  if (SAYS_FEE_STRUCTURE.test(both)) score += 5;
  if (SAYS_FEE.test(t)) score += 4;
  if (SAYS_FEE.test(h)) score += 3;
  if (/\btuition\b/.test(both)) score += 3;
  if (/\bfees?\s+(schedule|details|particulars|chart|list)\b/.test(both)) score += 2;
  // Every CBSE school must publish one, and the fee structure is on it. Usually as a PDF.
  if (/mandatory public disclosure/.test(both)) score += 3;
  return score;
}

// Below this, do not follow the link at all. An admissions page, or a page that merely mentions admissions, is not a
// fee page; following it anyway is how a school ends up recorded as publishing a fee page with nothing on it.
const FOLLOW_AT = 3;

// Which link on a school's home page is most likely to lead to the fees.
function bestFeeLink(links: Array<{ href: string; text: string }>, base: string): { page: string | null; pdf: string | null } {
  let page: string | null = null;
  let pdf: string | null = null;
  let bestScore = 0;
  for (const link of links ?? []) {
    const href = String(link?.href ?? "");
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    const low = href.toLowerCase();
    const score = scoreFeeLink(link?.text, href);
    if (score < FOLLOW_AT) continue;
    let absolute: string;
    try {
      absolute = new URL(href, base).href;
    } catch {
      continue;
    }
    if (low.endsWith(".pdf")) {
      if (!pdf) pdf = absolute;
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      page = absolute;
    }
  }
  return { page, pdf };
}

// What reading one school's site came to. The distinction that matters is between a fee page with nothing on it -
// an enquiry form, or "please email us", which is a deliberate choice by the school - and no fee page found at all,
// which might just as easily mean this crawler looked in the wrong place.
function outcomeOf(what: { found?: number; pdf?: string | null; feePage?: string | null; failed?: boolean }): string {
  if (what?.failed) return "failed";
  if (Number(what?.found ?? 0) > 0) return "table";
  if (what?.pdf) return "pdf_only";
  if (what?.feePage) return "page_no_numbers";
  return "no_fee_page";
}

function howManySchools(input: unknown): number {
  const n = Math.trunc(Number(input));
  if (!Number.isFinite(n) || n < 1) return 8;
  return Math.min(n, MAX_SCHOOLS_PER_CALL);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ==== END testable logic ====

const UA = { "User-Agent": "Mozilla/5.0 (compatible; KidscoverBot/1.0; +https://kidscover.in)" };

async function requireAdmin(req: Request, admin: any, secretKey: string): Promise<Response | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Missing bearer token" }, 401);
  if (secretKey && token === secretKey) return null;
  const { data, error } = await admin.auth.getUser(token);
  const user = data?.user;
  if (error || !user) return json({ error: "Invalid session" }, 401);
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profile?.role !== "admin") return json({ error: "Admin role required" }, 403);
  return null;
}

// The HTML, reduced to the few plain things the logic above works on.
function pageFromHtml(html: string): { tables: Array<{ rows: string[][]; heading: string }>; lines: string[]; text: string } {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const tables: Array<{ rows: string[][]; heading: string }> = [];
  for (const table of $("table").toArray()) {
    const rows: string[][] = [];
    for (const tr of $(table).find("tr").toArray()) {
      const cells = $(tr).find("th, td").toArray().map((c) => $(c).text().replace(/\s+/g, " ").trim());
      if (cells.length) rows.push(cells);
    }
    if (rows.length < 2) continue;
    tables.push({ rows, heading: headingAbove($, table) });
  }
  const lines: string[] = [];
  for (const el of $("li, p, dd, dt").toArray()) {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text && text.length <= 200) lines.push(text);
    if (lines.length > 600) break;
  }
  return { tables, lines, text: $("body").text().replace(/\s+/g, " ").trim().slice(0, 20000) };
}

// What was written above a table, which is where the class usually is.
//
// Looking only for h1-h6, strong, b or p missed it on a real school site, where each class's fee table sits in an
// accordion and the class is a plain <div> - "Nursery" - just outside the wrapper the table lives in. Nothing about
// a heading requires it to be a heading tag. So: walk outwards and backwards from the table, gather the few short
// pieces of text written before it, and take the first that actually names a class.
function headingAbove($: any, table: any): string {
  const candidates: string[] = [];
  const add = (text: unknown) => {
    const v = String(text ?? "").replace(/\s+/g, " ").trim();
    // A long one is a paragraph or a whole section wrapper, not a heading over a table.
    if (v && v.length <= 160) candidates.push(v);
  };
  add($(table).find("caption").first().text());
  let node = $(table);
  for (let up = 0; up < 3 && node && node.length; up += 1) {
    $(node).prevAll().slice(0, 3).each((_: unknown, el: unknown) => add($(el).text()));
    node = $(node).parent();
  }
  for (const c of candidates) if (levelFromGrade(c)) return c.slice(0, 160);
  return (candidates[0] ?? "").slice(0, 160);
}

async function grab(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`the site answered ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (/pdf|octet-stream/i.test(type)) throw new Error("that page is a PDF");
  return await res.text();
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const secretKey = Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!secretKey) return json({ success: false, error: "SB_SECRET_KEY is not set" }, 500);
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", secretKey);

    const denied = await requireAdmin(req, supabase, secretKey);
    if (denied) return denied;

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const limit = howManySchools(body?.limit);
    const dryRun = body?.dryRun === true;

    let query = supabase.from("schools").select("id, name, website").not("website", "is", null);
    if (Array.isArray(body?.schoolIds) && body.schoolIds.length) {
      query = query.in("id", body.schoolIds.slice(0, MAX_SCHOOLS_PER_CALL));
    } else {
      query = query.order("last_crawled_at", { ascending: true, nullsFirst: true });
    }

    const { data: schools, error: fetchErr } = await query.limit(limit);
    if (fetchErr) return json({ success: false, error: fetchErr.message }, 500);
    if (!schools?.length) return json({ success: true, message: "No schools with a website left to read.", details: [] });

    const details: any[] = [];
    let written = 0;
    let confident = 0;

    const outcomes: Record<string, number> = {};
    for (const school of schools) {
      const log: any = { school: school.name, website: school.website, feePage: null, pdf: null, found: 0, high: 0, status: "pending" };
      let failed = false;
      let feePageFound: string | null = null;
      try {
        if (!dryRun) await supabase.from("schools").update({ last_crawled_at: new Date().toISOString() }).eq("id", school.id);

        const homeHtml = await grab(school.website);
        const $ = cheerio.load(homeHtml);
        const links = $("a").toArray().map((el) => ({ href: $(el).attr("href") ?? "", text: $(el).text() ?? "" }));
        const { page: feePage, pdf } = bestFeeLink(links, school.website);
        feePageFound = feePage;
        log.feePage = feePage ?? school.website;
        log.pdf = pdf;

        const targetHtml = feePage && feePage !== school.website ? await grab(feePage) : homeHtml;
        const findings = readFeePage(pageFromHtml(targetHtml), log.feePage);

        log.found = findings.length;
        log.high = findings.filter((f: any) => f.confidence === "high").length;
        confident += log.high;

        if (findings.length === 0) {
          log.status = pdf ? `nothing readable on the page; the fees look to be in a PDF: ${pdf}` : "no fee table or labelled amount on the page";
        } else if (dryRun) {
          log.status = "read, nothing saved (dry run)";
          log.sample = findings.slice(0, 5);
        } else {
          const rows = findings.map((f: any) => ({ ...f, school_id: school.id }));
          const { error: writeErr } = await supabase
            .from("school_fee_findings")
            .upsert(rows, { onConflict: "school_id,source_url,grade_text,component_text,amount", ignoreDuplicates: true });
          if (writeErr) {
            log.status = "read, but could not be saved: " + writeErr.message;
          } else {
            written += rows.length;
            log.status = `${log.high} of ${log.found} lines are worth looking at`;
          }
        }
      } catch (err) {
        failed = true;
        log.status = "could not be read: " + (err instanceof Error ? err.message : String(err));
      }

      log.outcome = outcomeOf({ found: log.found, pdf: log.pdf, feePage: feePageFound, failed });
      outcomes[log.outcome] = (outcomes[log.outcome] ?? 0) + 1;
      if (!dryRun) {
        // One row per school, replaced each time. Counting these is the whole point of keeping them.
        await supabase.from("school_fee_crawls").upsert({
          school_id: school.id,
          read_at: new Date().toISOString(),
          outcome: log.outcome,
          fee_page: (log.feePage ?? "").slice(0, 500) || null,
          pdf_url: (log.pdf ?? "").slice(0, 500) || null,
          lines_found: log.found,
          lines_confident: log.high,
          note: String(log.status ?? "").slice(0, 300) || null,
        }, { onConflict: "school_id" });
      }
      details.push(log);
    }

    return json({
      success: true,
      mode: dryRun ? "dry run - nothing saved" : "findings saved for review",
      schools: schools.length,
      findings_written: written,
      worth_looking_at: confident,
      outcomes,
      details,
    });
  } catch (err) {
    return json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
