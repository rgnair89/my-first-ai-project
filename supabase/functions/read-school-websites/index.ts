// supabase/functions/read-school-websites/index.ts
//
// Reads schools' own websites for two facts: which board they follow, and whether admissions are open. For CBSE, an
// affiliation number the school gives is checked against CBSE's public record for that number. Everything found goes
// into school_site_findings for an admin to accept or reject in the Partner Portal: nothing reaches parents unchecked.
// Self-contained: paste this whole file into the dashboard editor as a new function called "read-school-websites".
//
// Before it can work: run supabase/migrations/20260919000800_school_website_findings.sql. No secrets are needed: the
// function acts AS THE ADMIN who pressed the button (their sign-in), so only admins can run it.
//
// Request (POST): { "limit": 6, "dryRun": false }            -> the next schools whose website was not read recently
//                 { "schoolIds": ["uuid", ...] }             -> exactly these (max 10)
// Answer: { ok, processed, withFindings, errors, remaining, stoppedEarly, results: [{ school, website, boards, admission, error }] }
//
// Manners: identifies itself as KidscoverBot, obeys robots.txt, reads at most 3 pages per school (the home page and
// the two most likely to state the board or admissions), 1.5 MB and 10 seconds per page, 3 schools at a time.
// Safety: website addresses come from outside data, so private and internal addresses are refused, and every redirect
// is checked again. PDFs are not read.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ==== BEGIN testable logic (must not use imports or Deno globals) ====

const BOARDS = ["CBSE", "ICSE", "IB", "IGCSE", "State Board", "NIOS"];
const USER_AGENT = "KidscoverBot/1.0 (school directory; reads public pages for board and admission details; github.com/rgnair89/kidscover-app)";
const MAX_BYTES = 1_500_000;
const PAGE_TIMEOUT_MS = 10000;
const ROBOTS_TIMEOUT_MS = 5000;
const MAX_EXTRA_PAGES = 2;
const MAX_REDIRECTS = 5;
const MAX_SCHOOLS_PER_CALL = 10;
const DEFAULT_LIMIT = 6;
const CONCURRENCY = 3;
const TIME_BUDGET_MS = 100000; // stop starting new schools after this; the function's own limit is 150 s
const RECHECK_DAYS = 30;
const STRONG = 5;               // a score from which a board is shown as a strong suggestion
const SUGGEST = 3;              // below this a mention is not suggested at all
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cbseRecordUrl = (no: string) => `https://saras.cbse.gov.in/SARAS/AffiliatedList/AfflicationDetails/${no}`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ---- which addresses may be fetched ----
function privateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// A school website address made safe to fetch, or null. Adds https:// when the scheme is missing.
function safeUrl(raw: unknown, base?: string): URL | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let s = raw.trim();
  if (!base && !/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s.replace(/^\/+/, "");
  let u: URL;
  try { u = base ? new URL(s, base) : new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".")) return null;
  if (host.startsWith("[") || host.includes(":")) return null; // IPv6 literals: never needed for a school website
  if (/(^|\.)(localhost|local|internal|localdomain|home|lan|corp|intranet)$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && privateIPv4(host)) return null;
  if (/^\d+$/.test(host) || /^0x/i.test(host)) return null; // decimal / hex tricks for an IP
  u.hash = "";
  return u;
}

const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");

// ---- robots.txt ----
// Returns true when our bot may read the path. Uses the group for "kidscoverbot" if there is one, else "*".
// Longest matching rule wins; Allow wins a tie. "*" and "$" work as in the robots standard.
function robotsAllows(robots: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let cur: { agents: string[]; rules: { allow: boolean; pattern: string }[] } | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      if (val || key === "allow") cur.rules.push({ allow: key === "allow", pattern: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && "kidscoverbot".includes(a.replace(/\/.*$/, ""))));
  const group = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of group) {
    for (const r of g.rules) {
      if (!r.pattern) continue;
      const anchored = r.pattern.endsWith("$");
      const body = anchored ? r.pattern.slice(0, -1) : r.pattern;
      const re = new RegExp("^" + body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
      if (re.test(path)) {
        const len = r.pattern.length;
        if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
      }
    }
  }
  return best ? best.allow : true;
}

// ---- pages to text ----
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: "...", copy: "(c)" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/td|\/th|\/a|\/span)\b[^>]*>/gi, "$& . ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\u00a0\u2000-\u200b\u2028\u2029]/g, " ")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/(\s*\.\s*){2,}/g, " . ")
    .replace(/\s+/g, " ")
    .trim();
}

// Up to MAX_EXTRA_PAGES links on the same site most likely to state the board or admissions.
function pickExtraPages(html: string, base: URL): string[] {
  const scored = new Map<string, number>();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
    const label = htmlToText(m[4] ?? "").toLowerCase();
    const u = safeUrl(href, base.href);
    if (!u || !sameSite(u, base)) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|docx?|xlsx?|pptx?|zip|mp4|mp3)(\?|$)/i.test(u.pathname)) continue;
    u.hash = "";
    const key = u.href;
    if (key === base.href || key === base.href.replace(/\/$/, "")) continue;
    const hay = (u.pathname + " " + label).toLowerCase();
    let score = 0;
    if (/mandatory|disclosure/.test(hay)) score = Math.max(score, 5);
    if (/affiliat/.test(hay)) score = Math.max(score, 4);
    if (/admission|enrol|registration/.test(hay)) score = Math.max(score, 3);
    if (/about|overview|who-we-are|our-school|curriculum|academics/.test(hay)) score = Math.max(score, 1);
    if (score > 0 && score > (scored.get(key) ?? 0)) scored.set(key, score);
  }
  return [...scored].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, MAX_EXTRA_PAGES).map(([k]) => k);
}

// ---- boards ----
type BoardHit = { board: string; score: number; strong: boolean; evidence: string; url: string; affiliationNo?: string; schoolCode?: string; verified?: any };

// Each rule: [board, pattern, points, capture group name]. Points add up per page; a sentence that names three or more
// boards (a comparison, or a coaching class listing what it teaches) only counts its strongest rule.
const BOARD_RULES: [string, RegExp, number, string?][] = [
  ["CBSE", /affiliat\w*\s+(?:to|with|by)\s+(?:the\s+)?(?:c\.?\s?b\.?\s?s\.?\s?e\b|central board of secondary education)/i, 5],
  ["CBSE", /central board of secondary education/i, 3],
  ["CBSE", /\bc\.?\s?b\.?\s?s\.?\s?e\b/i, 1],
  ["ICSE", /affiliat\w*\s+(?:to|with|by)\s+(?:the\s+)?(?:c\.?i\.?s\.?c\.?e\b|council for the indian school certificate|i\.?c\.?s\.?e\b)/i, 5],
  ["ICSE", /council for the indian school certificate examinations?/i, 3],
  ["ICSE", /\bc\.?i\.?s\.?c\.?e\b|\bi\.?c\.?s\.?e\b/i, 1],
  ["IB", /\bIB world school\b/i, 5],
  ["IB", /international baccalaureate/i, 3],
  ["IB", /\bIB\s?(?:DP|PYP|MYP|CP|diploma programme|primary years|middle years)\b/i, 2],
  ["IGCSE", /cambridge (?:assessment )?international (?:education|examinations?|school)/i, 4],
  ["IGCSE", /\bI\.?G\.?C\.?S\.?E\b/i, 2],
  ["IGCSE", /\bcambridge (?:curriculum|school|centre|center)\b/i, 2],
  ["State Board", /maharashtra state board|state board of secondary and higher secondary education|\bMSBSHSE\b/i, 5],
  ["State Board", /\bS\.?\s?S\.?\s?C\.?\s+board\b|\bstate board\b/i, 3],
  ["State Board", /\bS\.S\.C\.?(?![a-z])|\bSSC\b/, 1],
  ["NIOS", /national institute of open schooling/i, 4],
  ["NIOS", /\bNIOS\b/, 2],
];

// Numbers a board gives a school, found anywhere on the page: on disclosure pages they sit in a table cell next to
// their label, so they are read from the whole text, allowing only separators between label and number.
const CAPTURE_RULES: [string, RegExp, number, string][] = [
  ["CBSE", /(?:c\.?\s?b\.?\s?s\.?\s?e\.?|affiliation|affl?\.?)\s*(?:no|number|code|#)?\.?[\s:.\-]*?(11\d{5})\b/i, 4, "affiliationNo"],
  ["ICSE", /(?:school|cisce|icse)\s*code[\s:.\-]*?(MA\s?\d{3})\b/i, 4, "schoolCode"],
];

// Split into sentences, without splitting after "No." or "St." or an initial ("S.S.C."), and at the breaks left
// where one block of the page ends and the next begins.
const ABBREVIATION = /\b(No|Nos|St|Dr|Mr|Mrs|Ms|Sr|Jr|Pvt|Ltd|Std|Aff|Affl|Reg|Govt|Estd|Est|Vol|Sec|Sch|[A-Z])\./g;
function sentences(text: string): string[] {
  const mark = String.fromCharCode(1);
  return text.replace(ABBREVIATION, "$1" + mark)
    .split(/(?<=[.!?|])\s+|\s+\.\s+/)
    .map((s) => s.split(mark).join(".").replace(/\s+\.$/, "").trim())
    .filter((s) => s.length > 3);
}

const clip = (s: string, n = 300) => (s.length <= n ? s : s.slice(0, n - 3).trimEnd() + "...");

// A short piece of text around position i, for the evidence an admin reads.
const around = (text: string, i: number, len: number) => clip(text.slice(Math.max(0, i - 120), i + len + 120).trim());

function findBoards(text: string, url: string): BoardHit[] {
  const acc = new Map<string, BoardHit & { mentions: number; best: number }>();
  for (const [board, re, points, field] of CAPTURE_RULES) {
    const m = re.exec(text);
    if (!m) continue;
    const cur = acc.get(board) ?? { board, score: 0, strong: false, evidence: "", url, mentions: 0, best: 0 };
    cur.score += points;
    (cur as any)[field] = m[1].replace(/\s+/g, "");
    if (points > cur.best) { cur.best = points; cur.evidence = around(text, m.index, m[0].length); }
    acc.set(board, cur);
  }
  for (const sent of sentences(text)) {
    const hits: { board: string; points: number; captured?: [string, string] }[] = [];
    for (const [board, re, points, cap] of BOARD_RULES) {
      const m = re.exec(sent);
      if (m) hits.push({ board, points, captured: cap && m[1] ? [cap, m[1].replace(/\s+/g, "")] : undefined });
    }
    if (!hits.length) continue;
    const named = new Set(hits.map((h) => h.board));
    // a sentence listing many boards is a comparison or a class timetable, not a statement about this school
    const counted = named.size >= 3 ? [hits.reduce((a, b) => (b.points > a.points ? b : a))].filter((h) => h.points >= 4) : hits;
    const perBoard = new Map<string, number>();
    for (const h of counted) {
      const cur = acc.get(h.board) ?? { board: h.board, score: 0, strong: false, evidence: "", url, mentions: 0, best: 0 };
      if (h.points === 1) {
        if (cur.mentions >= 3) continue; // plain mentions add at most 3
        cur.mentions += 1;
      }
      cur.score += h.points;
      if (h.captured) (cur as any)[h.captured[0]] = h.captured[1];
      const inSentence = (perBoard.get(h.board) ?? 0) + h.points;
      perBoard.set(h.board, inSentence);
      if (inSentence > cur.best) { cur.best = inSentence; cur.evidence = clip(sent); }
      acc.set(h.board, cur);
    }
  }
  return [...acc.values()].map(({ mentions, best, ...h }) => ({ ...h, strong: h.score >= STRONG }));
}

// Combine what several pages of one site said. The best page for each board gives its evidence.
function mergeBoards(perPage: BoardHit[][]): BoardHit[] {
  const out = new Map<string, BoardHit>();
  for (const hits of perPage) {
    for (const h of hits) {
      const cur = out.get(h.board);
      if (!cur) { out.set(h.board, { ...h }); continue; }
      const better = h.score > cur.score ? h : cur;
      out.set(h.board, {
        ...better,
        score: Math.min(cur.score + h.score, 20),
        affiliationNo: cur.affiliationNo ?? h.affiliationNo,
        schoolCode: cur.schoolCode ?? h.schoolCode,
      });
    }
  }
  return [...out.values()]
    .map((h) => ({ ...h, strong: h.score >= STRONG }))
    .filter((h) => h.score >= SUGGEST)
    .sort((a, b) => b.score - a.score || a.board.localeCompare(b.board))
    .slice(0, 6);
}

// ---- admissions ----
type Admission = { status: "open" | "closed"; year: string | null; evidence: string; url: string; stale: boolean };

// The academic year that has started by `now` (India: the school year starts in April to June).
function currentAcademicStart(now: Date): number {
  const ist = new Date(now.getTime() + 330 * 60000);
  return ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
}

function yearIn(s: string): string | null {
  for (const m of s.matchAll(/\b(20\d{2})\s*[-/]\s*(?:20)?(\d{2})\b/g)) {
    const a = Number(m[1]), b = Number(m[2]);
    if ((a + 1) % 100 === b) return `${a}-${String(b).padStart(2, "0")}`;
  }
  return null;
}

const OPEN_RE = /\badmissions?\s+(?:are\s+|is\s+)?(?:now\s+)?open\b|\bopen\s+for\s+admissions?\b|\b(?:registrations?|enrol(?:l)?ments?)\s+(?:are\s+|is\s+)?(?:now\s+)?open\b|\badmissions?\s+(?:for|to)\s+(?:the\s+)?(?:academic\s+)?(?:(?:year|session)\s+)?\S+\s+(?:are|is)\s+(?:now\s+)?open\b/i;
const CLOSED_RE = /\badmissions?\s+(?:are\s+|is\s+|have\s+been\s+)?(?:now\s+)?closed\b|\b(?:registrations?)\s+(?:are\s+|is\s+|have\s+been\s+)?closed\b|\bno\s+(?:more\s+)?seats?\s+(?:are\s+)?available\b|\bseats?\s+(?:are\s+)?(?:full|filled)\b|\badmissions?\s+(?:for|to)\s+(?:the\s+)?(?:academic\s+)?(?:(?:year|session)\s+)?\S+\s+(?:are|is|have\s+been)\s+(?:now\s+)?closed\b/i;

function findAdmission(text: string, url: string, now: Date): Admission | null {
  const start = currentAcademicStart(now);
  const cands: Admission[] = [];
  const all = sentences(text);
  all.forEach((sent, i) => {
    const open = OPEN_RE.test(sent);
    const closed = CLOSED_RE.test(sent);
    if (!open && !closed) return;
    // "admissions open for nursery, closed for class 5": too mixed to call either way
    if ((open && (closed || /\bclosed\b|\bfull\b/i.test(sent))) || (closed && /\bopen\b/i.test(sent))) return;
    const year = yearIn(sent) ?? yearIn(all[i + 1] ?? "") ?? yearIn(all[i - 1] ?? "");
    const stale = year !== null && Number(year.slice(0, 4)) < start;
    cands.push({ status: open ? "open" : "closed", year, evidence: clip(sent), url, stale });
  });
  if (!cands.length) return null;
  // the newest dated notice wins; an undated one only when nothing is dated
  cands.sort((a, b) => (b.year ?? "0").localeCompare(a.year ?? "0"));
  return cands[0];
}

// ---- CBSE's public record for an affiliation number ----
type CbseRecord = { name: string; affiliationNo: string; state: string; district: string; address: string; pin: string; website: string; level: string };

function parseCbseRecord(html: string): CbseRecord | null {
  const t = htmlToText(html);
  const labels = ["Name of Institution", "Affiliation Number", "State", "District", "Postal Address", "Pin Code", "Website", "Year of Foundation", "Status of The School", "School Type"];
  const get = (label: string) => {
    const i = t.indexOf(label);
    if (i < 0) return "";
    let rest = t.slice(i + label.length);
    let end = rest.length;
    for (const l of labels) { const j = rest.indexOf(l); if (j >= 0 && j < end) end = j; }
    for (const stop of ["Date of First Opening", "Name of Principal", "Email", "Phone", "Fax"]) { const j = rest.indexOf(stop); if (j >= 0 && j < end) end = j; }
    rest = rest.slice(0, end);
    return rest.replace(/^\s*[:.\-]?\s*/, "").replace(/\s*\.\s*$/, "").replace(/\s+\.\s+/g, " ").trim();
  };
  const affiliationNo = (get("Affiliation Number").match(/\d{7}/) ?? [""])[0];
  const name = get("Name of Institution");
  if (!affiliationNo || !name) return null;
  return {
    name, affiliationNo,
    state: get("State").toUpperCase(),
    district: get("District").toUpperCase(),
    address: get("Postal Address"),
    pin: (get("Pin Code").match(/\d{6}/) ?? [""])[0],
    website: get("Website"),
    level: get("Status of The School"),
  };
}

const STOP_WORDS = new Set(["school", "schools", "high", "the", "english", "medium", "and", "of", "public", "international", "academy", "junior", "college", "vidyalaya", "primary", "secondary", "senior", "convent", "a"]);
const nameTokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w)));
function nameOverlap(a: string, b: string): number {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.size || !y.size) return 0;
  let common = 0; for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size);
}
const domainOf = (s: string) => { const u = safeUrl(s); return u ? u.hostname.replace(/^www\./, "") : ""; };

// Does CBSE's record describe this school? It has to be in Maharashtra, and match on at least one of: PIN code,
// website, or most of the distinctive words in the name.
function confirmCbse(rec: CbseRecord, school: { name: string; address?: string | null; website?: string | null }) {
  const reasons: string[] = [];
  if (rec.state !== "MAHARASHTRA") return { confirmed: false, reasons: [`CBSE record is in ${rec.state || "an unknown state"}`] };
  const pin = /\b(4\d{5})\b/.exec(school.address ?? "")?.[1];
  if (pin && rec.pin && pin === rec.pin) reasons.push(`PIN ${pin} matches`);
  if (school.website && rec.website && domainOf(school.website) && domainOf(school.website) === domainOf(rec.website)) reasons.push("website matches");
  const overlap = nameOverlap(rec.name, school.name);
  if (overlap >= 0.6) reasons.push("name matches");
  return { confirmed: reasons.length > 0, reasons: reasons.length ? reasons : ["CBSE record does not match this school's name, PIN or website"] };
}

// ---- fetching, politely and safely ----
type Deps = {
  env: { get(name: string): string | undefined };
  fetch: typeof fetch;
  createClient: (url: string, key: string, options?: any) => any;
  now: () => Date;
};
type Page = { url: string; status: number; note?: string; html?: string };

async function readLimited(res: Response, max: number): Promise<string | null> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0; for (const c of chunks) { all.set(c, off); off += c.length; }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

async function fetchPage(deps: Deps, start: URL, timeoutMs = PAGE_TIMEOUT_MS, accept = "text/html,application/xhtml+xml"): Promise<Page> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await deps.fetch(url.href, { redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": USER_AGENT, Accept: accept, "Accept-Language": "en-IN,en;q=0.9" } });
    } catch (e) {
      clearTimeout(timer);
      return { url: url.href, status: 0, note: (e as any)?.name === "AbortError" ? "timed out" : "could not connect" };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      clearTimeout(timer);
      const next = safeUrl(res.headers.get("location"), url.href);
      if (!next) return { url: url.href, status: res.status, note: "redirects to an address that is not allowed" };
      url = next;
      continue;
    }
    try {
      if (res.status !== 200) return { url: url.href, status: res.status, note: `answered ${res.status}` };
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (accept.includes("html") && type && !/html|xml/.test(type)) return { url: url.href, status: res.status, note: "not a web page" };
      const body = await readLimited(res, MAX_BYTES);
      if (body === null) return { url: url.href, status: res.status, note: "page too large" };
      return { url: url.href, status: res.status, html: body };
    } catch (e) {
      return { url: url.href, status: 0, note: (e as any)?.name === "AbortError" ? "timed out" : "could not read" };
    } finally {
      clearTimeout(timer);
    }
  }
  return { url: url.href, status: 0, note: "too many redirects" };
}

async function robotsFor(deps: Deps, site: URL): Promise<string> {
  const page = await fetchPage(deps, new URL("/robots.txt", site.origin), ROBOTS_TIMEOUT_MS, "text/plain,*/*");
  return page.status === 200 && page.html ? page.html.slice(0, 100000) : "";
}

type School = { id: string; name: string; website: string | null; address?: string | null };
type Reading = { pages: { url: string; status: number; note?: string }[]; boards: BoardHit[]; admission: Admission | null; error: string | null };

async function readSchool(deps: Deps, school: School, deadline: number): Promise<Reading> {
  const pages: Reading["pages"] = [];
  const home = safeUrl(school.website);
  if (!home) return { pages, boards: [], admission: null, error: "website address is missing or not allowed" };
  const robots = await robotsFor(deps, home);
  const texts: { url: string; text: string }[] = [];
  const read = async (u: URL) => {
    if (!robotsAllows(robots, u.pathname + u.search)) { pages.push({ url: u.href, status: 0, note: "robots.txt asks us not to read this page" }); return null; }
    const p = await fetchPage(deps, u);
    pages.push({ url: p.url, status: p.status, ...(p.note ? { note: p.note } : {}) });
    if (!p.html) return null;
    texts.push({ url: p.url, text: htmlToText(p.html) });
    return p;
  };
  const first = await read(home);
  if (first?.html) {
    const finalHome = safeUrl(first.url) ?? home;
    for (const extra of pickExtraPages(first.html, finalHome)) {
      if (deps.now().getTime() > deadline) break;
      const u = safeUrl(extra);
      if (u) await read(u);
    }
  }
  if (!texts.length) return { pages, boards: [], admission: null, error: pages[pages.length - 1]?.note ?? "could not read the website" };

  const boards = mergeBoards(texts.map((t) => findBoards(t.text, t.url)));
  let admission: Admission | null = null;
  for (const t of texts) {
    const a = findAdmission(t.text, t.url, deps.now());
    if (a && (!admission || (a.year ?? "0") > (admission.year ?? "0"))) admission = a;
  }

  // a CBSE affiliation number is looked up on CBSE's own record (one request per number, at most two numbers)
  const cbse = boards.find((b) => b.board === "CBSE");
  if (cbse?.affiliationNo && deps.now().getTime() < deadline) {
    const p = await fetchPage(deps, new URL(cbseRecordUrl(cbse.affiliationNo)));
    pages.push({ url: p.url, status: p.status, ...(p.note ? { note: p.note } : {}) });
    const rec = p.html ? parseCbseRecord(p.html) : null;
    if (rec && rec.affiliationNo === cbse.affiliationNo) {
      const c = confirmCbse(rec, school);
      cbse.verified = { source: "cbse", confirmed: c.confirmed, reasons: c.reasons, name: rec.name, district: rec.district, pin: rec.pin, level: rec.level, record: p.url };
      if (c.confirmed) { cbse.score = Math.max(cbse.score, 10); cbse.strong = true; }
    } else {
      cbse.verified = { source: "cbse", confirmed: false, reasons: [rec ? "CBSE record is for a different number" : "no CBSE record found for this number"], record: p.url };
    }
  }
  return { pages, boards, admission, error: null };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function createHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ ok: false, code: "bad_request" }, 405);
    const started = deps.now().getTime();
    try {
      let body: any = {};
      try { body = await req.json(); } catch { /* none */ }
      const dryRun = body?.dryRun === true;
      const ids: string[] | null = Array.isArray(body?.schoolIds) ? body.schoolIds : null;
      if (ids && (ids.length === 0 || ids.length > MAX_SCHOOLS_PER_CALL || !ids.every((x) => typeof x === "string" && UUID.test(x)))) {
        return json({ ok: false, code: "bad_request", error: `schoolIds must be 1 to ${MAX_SCHOOLS_PER_CALL} school ids` }, 400);
      }
      const limit = Math.max(1, Math.min(MAX_SCHOOLS_PER_CALL, Number.isInteger(body?.limit) ? body.limit : DEFAULT_LIMIT));

      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!token) return json({ ok: false, code: "sign_in" }, 401);
      const db = deps.createClient(deps.env.get("SUPABASE_URL") ?? "", req.headers.get("apikey") ?? deps.env.get("SUPABASE_ANON_KEY") ?? "", {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: who } = await db.auth.getUser(token);
      if (!who?.user) return json({ ok: false, code: "sign_in" }, 401);
      const { data: profile } = await db.from("profiles").select("role").eq("id", who.user.id).maybeSingle();
      if (profile?.role !== "admin") return json({ ok: false, code: "admin_only" }, 403);

      const since = new Date(started - RECHECK_DAYS * 86400000).toISOString();
      let schools: School[] = [];
      if (ids) {
        const { data, error } = await db.from("schools").select("id,name,website,address").in("id", ids);
        if (error) return json({ ok: false, code: "failed", error: error.message }, 500);
        schools = data ?? [];
      } else {
        const { data, error } = await db.from("schools").select("id,name,website,address")
          .eq("is_hidden", false).not("website", "is", null).or(`last_site_check_at.is.null,last_site_check_at.lt.${since}`)
          .order("last_site_check_at", { ascending: true, nullsFirst: true }).order("name_sort", { ascending: true }).limit(limit);
        if (error) {
          const missing = /last_site_check_at|does not exist|schema cache/i.test(error.message ?? "");
          return json({ ok: false, code: missing ? "not_configured" : "failed", error: missing ? "Run the 20260919000800_school_website_findings.sql migration first." : error.message }, missing ? 400 : 500);
        }
        schools = data ?? [];
      }

      const deadline = started + TIME_BUDGET_MS;
      let stoppedEarly = false;
      const results = await mapLimit(schools, CONCURRENCY, async (school) => {
        if (deps.now().getTime() > deadline) { stoppedEarly = true; return null; }
        const r = await readSchool(deps, school, deadline);
        if (!dryRun) {
          const { error } = await db.rpc("record_site_finding", {
            p_school: school.id, p_website: school.website ?? "", p_pages: r.pages, p_boards: r.boards, p_admission: r.admission, p_error: r.error,
          });
          if (error) return { school: school.name, website: school.website, boards: [], admission: null, error: `could not save: ${error.message}` };
        }
        return { school: school.name, website: school.website, boards: r.boards.map((b) => `${b.board}${b.strong ? "" : "?"}${b.verified?.confirmed ? " (CBSE record)" : ""}`), admission: r.admission ? `${r.admission.status}${r.admission.year ? " " + r.admission.year : ""}${r.admission.stale ? " (old)" : ""}` : null, error: r.error };
      });
      const done = results.filter(Boolean) as any[];

      let remaining: number | null = null;
      if (!ids) {
        const { count } = await db.from("schools").select("id", { count: "exact", head: true })
          .eq("is_hidden", false).not("website", "is", null).or(`last_site_check_at.is.null,last_site_check_at.lt.${since}`);
        remaining = typeof count === "number" ? count : null;
      }
      return json({
        ok: true, dryRun,
        processed: done.length,
        withFindings: done.filter((d) => d.boards.length || d.admission).length,
        errors: done.filter((d) => d.error).length,
        remaining, stoppedEarly,
        results: done,
      });
    } catch (err) {
      return json({ ok: false, code: "failed", error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };
}

// ==== END testable logic ====

Deno.serve(createHandler({ env: Deno.env, fetch, createClient, now: () => new Date() }));
