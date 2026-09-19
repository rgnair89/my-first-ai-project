// supabase/functions/read-school-websites/index.ts
//
// Reads schools' own websites for: which board they follow, which levels they run (preschool, primary, secondary,
// daycare), their facilities (library, labs, pool, school bus, teacher-student ratio ...), the achievements they claim
// (class 10 / 12 results, placements, alumni, awards) and whether admissions are open. For CBSE, an
// affiliation number the school gives is checked against CBSE's public record for that number. Everything found goes
// into school_site_findings for an admin to accept or reject in the Partner Portal: nothing reaches parents unchecked.
// Self-contained: paste this whole file into the dashboard editor as a new function called "read-school-websites".
//
// Before it can work: run supabase/migrations/20260919000800_school_website_findings.sql and, for levels,
// 20260919001100_levels_from_websites.sql and 20260919001300_facilities_achievements_from_websites.sql. Only places in the "school" category are read (20260919001000). No secrets are needed: the
// function acts AS THE ADMIN who pressed the button (their sign-in), so only admins can run it.
//
// Request (POST): { "limit": 6, "dryRun": false }            -> the next schools whose website was not read recently
//                 { "schoolIds": ["uuid", ...] }             -> exactly these (max 10)
// Answer: { ok, processed, withFindings, errors, remaining, stoppedEarly, results: [{ school, website, boards, levels, facilities, achievements, admission, error }] }
//
// Manners: identifies itself as KidscoverBot, obeys robots.txt, reads at most 4 pages per school (the home page and
// the three most likely to state the board, admissions or facilities), 1.5 MB and 10 seconds per page, 3 schools at a time.
// Safety: website addresses come from outside data, so private and internal addresses are refused, and every redirect
// is checked again. PDFs are not read.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ==== BEGIN testable logic (must not use imports or Deno globals) ====

const BOARDS = ["CBSE", "ICSE", "IB", "IGCSE", "State Board", "NIOS"];
const USER_AGENT = "KidscoverBot/1.0 (school directory; reads public pages for board and admission details; github.com/rgnair89/kidscover-app)";
const MAX_BYTES = 1_500_000;
const PAGE_TIMEOUT_MS = 10000;
const ROBOTS_TIMEOUT_MS = 5000;
const MAX_EXTRA_PAGES = 3;
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

// Up to MAX_EXTRA_PAGES links on the same site most likely to state the board or admissions. When one website serves
// several schools (a trust's site), this school's pages go before the others: every distinctive word of its name is
// in the link. Its own page ("ab-goregaokar-english-school.php") beats another school's admissions page, and its own
// admissions page beats both. A page with the name but no school word (the trust's sports club) gets nothing extra.
// Once a site shows it serves several schools (this school's own page, and pages of two or more other schools), the
// other schools' pages are not read at all: their levels, board or admissions would be taken for this school's.
function pickExtraPages(html: string, base: URL, schoolName = ""): string[] {
  const own = [...nameTokens(schoolName)];
  const scored = new Map<string, number>();
  const otherSchool = new Set<string>();
  let trustSite = false;
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
    if (/facilit|infrastructure|campus|amenit|achievement|results|alumni|awards/.test(hay)) score = Math.max(score, 2);
    if (/about|overview|who-we-are|our-school|curriculum|academics|section|wing|kindergarten|primary|secondary|junior-college/.test(hay)) score = Math.max(score, 1);
    const words = " " + hay.replace(/[^a-z0-9]+/g, " ") + " ";
    const schoolish = /school|vidyalay|mandir|convent|balvihar/.test(hay);
    if (own.length && own.every((w) => words.includes(" " + w + " "))) {
      if (score > 0) score += 1;
      else if (/school|vidyalay|mandir|convent/.test(hay)) score = 3.5;
      if (schoolish) trustSite = true;
    } else if (own.length && schoolish) {
      otherSchool.add(key);
    }
    if (score > 0 && score > (scored.get(key) ?? 0)) scored.set(key, score);
  }
  const shared = trustSite && otherSchool.size >= 2; // this school has its own pages, and at least two other schools do
  return [...scored].filter(([k]) => !(shared && otherSchool.has(k)))
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, MAX_EXTRA_PAGES).map(([k]) => k);
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
  // Marathi and Hindi (after latinInitials): the board's full name; "affiliated to the SSC / state board"; "SSC board"
  // or "state board". A trust's own name ("... shikshan mandal", an education society) is not a board and not matched.
  ["State Board", /\u092e\u0939\u093e\u0930\u093e\u0937\u094d\u091f\u094d\u0930\s*\u0930\u093e\u091c\u094d\u092f\s*\u092e\u093e\u0927\u094d\u092f\u092e\u093f\u0915\s*(?:\u0935|\u0906\u0923\u093f|\u090f\u0935\u0902|\u0914\u0930)?\s*\u0909\u091a\u094d\u091a\s*\u092e\u093e\u0927\u094d\u092f\u092e\u093f\u0915\s*\u0936\u093f\u0915\u094d\u0937/, 5],
  ["State Board", /(?:(?<![A-Za-z])S\.?\s?S\.?\s?C\.?|(?<![\u0900-\u097f])(?:\u0930\u093e\u091c\u094d\u092f|\u0938\u094d\u091f\u0947\u091f))\s*(?:\u0936\u093f\u0915\u094d\u0937\u0923\s*|\u0936\u093f\u0915\u094d\u0937\u093e\s*)?(?:\u092c\u094b\u0930\u094d\u0921|\u092e\u0902\u0921\u0933|\u092e\u0902\u0921\u0932)\S*\s*(?:\u0938\u0947\s+)?(?:\u0938\u0902\u0932\u0917\u094d\u0928|\u0938\u0932\u0902\u0917\u094d\u0928|\u0938\u0902\u092c\u0926\u094d\u0927|\u092e\u093e\u0928\u094d\u092f\u0924\u093e\u092a\u094d\u0930\u093e\u092a\u094d\u0924)/, 5],
  ["State Board", /(?:(?<![A-Za-z])S\.?\s?S\.?\s?C\.?|(?<![\u0900-\u097f])(?:\u0930\u093e\u091c\u094d\u092f|\u0938\u094d\u091f\u0947\u091f))\s*(?:\u0936\u093f\u0915\u094d\u0937\u0923\s*|\u0936\u093f\u0915\u094d\u0937\u093e\s*)?(?:\u092c\u094b\u0930\u094d\u0921|\u092e\u0902\u0921\u0933|\u092e\u0902\u0921\u0932)/, 3],
  ["NIOS", /national institute of open schooling/i, 4],
  ["NIOS", /\bNIOS\b/, 2],
];

// Numbers a board gives a school, found anywhere on the page: on disclosure pages they sit in a table cell next to
// their label, so they are read from the whole text, allowing only separators between label and number.
const CAPTURE_RULES: [string, RegExp, number, string][] = [
  ["CBSE", /(?:c\.?\s?b\.?\s?s\.?\s?e\.?|affiliation|affl?\.?)\s*(?:no|number|code|#)?\.?[\s:.\-]*?(11\d{5})\b/i, 4, "affiliationNo"],
  ["ICSE", /(?:school|cisce|icse)\s*code[\s:.\-]*?(MA\s?\d{3})\b/i, 4, "schoolCode"],
];

// Marathi and Hindi pages write the boards' initials in Devanagari, with or without dots ("es. es. si." for S.S.C.).
// They are spelled in Latin letters before reading, so the rules and the sentence splitter treat them like "S.S.C.".
const DEVANAGARI_INITIALS: [RegExp, string][] = [
  [/(?<![\u0900-\u097f])\u090f\u0938\u094d?\.?\s?\u090f\u0938\u094d?\.?\s?\u0938\u0940(?![\u0900-\u097f])\.?/g, "S.S.C."],
  [/(?<![\u0900-\u097f])\u0938\u0940\.?\s?\u092c\u0940\.?\s?\u090f\u0938\u094d?\.?\s?\u0908(?![\u0900-\u097f])\.?/g, "C.B.S.E."],
  [/(?<![\u0900-\u097f])\u0906\u092f\.?\s?\u0938\u0940\.?\s?\u090f\u0938\u094d?\.?\s?\u0908(?![\u0900-\u097f])\.?/g, "I.C.S.E."],
];
const latinInitials = (text: string) => DEVANAGARI_INITIALS.reduce((t, [re, to]) => t.replace(re, to), text);

// Split into sentences, without splitting after "No." or "St." or an initial ("S.S.C."), and at the breaks left
// where one block of the page ends and the next begins. Hindi and Marathi sentences may end with a danda.
const ABBREVIATION = /\b(No|Nos|St|Dr|Mr|Mrs|Ms|Sr|Jr|Pvt|Ltd|Std|Aff|Affl|Reg|Govt|Estd|Est|Vol|Sec|Sch|[A-Z])\./g;
function sentences(text: string): string[] {
  const mark = String.fromCharCode(1);
  return text.replace(ABBREVIATION, "$1" + mark)
    .split(/(?<=[.!?|\u0964\u0965])\s+|\s+\.\s+/)
    .map((s) => s.split(mark).join(".").replace(/\s+\.$/, "").trim())
    .filter((s) => s.length > 3);
}

const clip = (s: string, n = 300) => (s.length <= n ? s : s.slice(0, n - 3).trimEnd() + "...");

// A short piece of text around position i, for the evidence an admin reads.
const around = (text: string, i: number, len: number) => clip(text.slice(Math.max(0, i - 120), i + len + 120).trim());

function findBoards(page: string, url: string): BoardHit[] {
  const text = latinInitials(page);
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

// ---- levels ----
// Which of the app's levels a school's own site says it runs: daycare, preschool (nursery, KG), primary (classes 1 to 7)
// and secondary (classes 8 to 12, junior college included). A range is the clearest ("Nursery to Grade 10", "Classes I
// to X", Marathi "iyatta 5 vi te 10 vi"): 5 points for every level in it. A named section ("Primary section", "Junior
// College") is 3; a class on its own ("Class 10 results") or a plain preschool word ("Nursery") is 2, and counts at most
// twice. "Primary" or "secondary" alone ("our primary aim") counts for nothing.
type LevelHit = { level: string; score: number; strong: boolean; evidence: string; url: string };
const LEVEL_ORDER = ["daycare", "preschool", "primary", "secondary"];

const PRE = String.raw`pre[- ]?nursery|nursery|play[- ]?group|play[- ]?school|pre[- ]?primary|pre[- ]?school|kindergarten|montessori|jr\.?\s?k\.?\s?g\b\.?|sr\.?\s?k\.?\s?g\b\.?|l\.?k\.?g\b\.?|u\.?k\.?g\b\.?|k\.?g\b\.?`;
const CLASS = String.raw`(?:class(?:es)?|grades?|std\.?|stds\.?|standards?)`;
const NUM = String.raw`1[0-2]|[1-9]|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i`;
const RANGE_RE = new RegExp(String.raw`\b(?:(${PRE})|${CLASS}\s*(${NUM})(?:st|nd|rd|th)?)\s*(?:to|till|until|up\s?to|through|-)\s*(?:(${PRE})|(?:${CLASS}\s*)?(${NUM})(?:st|nd|rd|th)?)\b`, "gi");
const ONE_CLASS_RE = new RegExp(String.raw`\b${CLASS}\s*(${NUM})(?:st|nd|rd|th)?\b`, "gi");
// Marathi and Hindi: "iyatta 1 li te 10 vi", "kaksha 1 se 10", "balwadi te iyatta 4 thi", with either kind of digit
const DEV_NUM = "1[0-2]|[1-9]|\u0967[\u0966-\u0968]|[\u0967-\u096f]";
const DEV_PRE = "\u092c\u093e\u0932\u0935\u093e\u0921\u0940|\u0936\u093f\u0936\u0941\\s?\u0935\u0930\u094d\u0917|\u0928\u0930\u094d\u0938\u0930\u0940|\u092a\u0942\u0930\u094d\u0935\\s?[- ]?\\s?\u092a\u094d\u0930\u093e\u0925\u092e\u093f\u0915|\u0915\u0947\\.?\\s?\u091c\u0940\\.?";
const DEV_RANGE_RE = new RegExp(`(?:(${DEV_PRE})|(?:\u0907\u092f\u0924\u094d\u0924\u093e|\u0915\u0915\u094d\u0937\u093e)\\s*(${DEV_NUM}))\\s*(?:\u0932\u0940|\u0930\u0940|\u0925\u0940|\u0935\u0940|\u0935\u0940\u0902)?\\s*(?:\u0924\u0947|\u0938\u0947)\\s*(?:\u0907\u092f\u0924\u094d\u0924\u093e\\s*|\u0915\u0915\u094d\u0937\u093e\\s*)?(${DEV_NUM})`, "g");

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
function classNumber(s: string): number | null {
  const t = s.toLowerCase().replace(/[\u0966-\u096f]/g, (d) => String(d.charCodeAt(0) - 0x0966));
  const n = /^\d+$/.test(t) ? Number(t) : ROMAN[t] ?? null;
  return n !== null && n >= 1 && n <= 12 ? n : null;
}
const levelOfClass = (n: number) => (n <= 7 ? "primary" : "secondary");

// The levels a range covers: from preschool or class a, to preschool or class b. Null when it makes no sense.
function rangeLevels(fromPre: boolean, a: number | null, toPre: boolean, b: number | null): string[] | null {
  if (toPre) return fromPre ? ["preschool"] : null;
  if (b === null) return null;
  const start = fromPre ? 1 : a;
  if (start === null) return null;
  const out = new Set<string>(fromPre ? ["preschool"] : []);
  for (let k = start; k <= b; k++) out.add(levelOfClass(k));
  return out.size ? [...out] : null; // backwards ("Class 10 to 5") comes out empty
}

const LEVEL_RULES: [string, RegExp, number, boolean?][] = [
  ["daycare", /\b(?:day[- ]?care|cr[e\u00e8]che)\b/i, 3],
  ["daycare", /\u092a\u093e\u0933\u0923\u093e\u0918\u0930|\u0921\u0947\s?\u0915\u0947\u0905\u0930/, 3],
  ["preschool", /\b(?:pre[- ]?primary|kindergarten|pre[- ]?school|play[- ]?group|montessori|nursery)\s+(?:section|wing|school|classes|programme|program|department)\b/i, 4],
  ["preschool", /\b(?:pre[- ]?nursery|nursery|play[- ]?group|pre[- ]?primary|kindergarten|jr\.?\s?k\.?\s?g\b|sr\.?\s?k\.?\s?g\b|l\.?k\.?g\b|u\.?k\.?g\b)/i, 2, true],
  ["preschool", /\u092a\u0942\u0930\u094d\u0935\s?[- ]?\s?\u092a\u094d\u0930\u093e\u0925\u092e\u093f\u0915|\u092c\u093e\u0932\u0935\u093e\u0921\u0940|\u0936\u093f\u0936\u0941\s?\u0935\u0930\u094d\u0917/, 3],
  ["primary", /(?<!pre[- ]?)\bprimary\s+(?:section|wing|school|classes|department|block|years)\b|\b(?:lower|upper)\s+primary\b/i, 3],
  ["primary", /(?<!\u092a\u0942\u0930\u094d\u0935\s?[- ]?\s?)\u092a\u094d\u0930\u093e\u0925\u092e\u093f\u0915\s*(?:\u0935\u093f\u092d\u093e\u0917|\u0936\u093e\u0933\u093e|\u0935\u0930\u094d\u0917)/, 3],
  ["secondary", /\b(?:secondary|high)\s+(?:section|wing|school|classes|department)\b|\bhigher\s+secondary\b|\b(?:junior|jr\.?)\s?college\b/i, 3],
  ["secondary", /\b(?:S\.?S\.?C\.?|H\.?S\.?C\.?|board)\s+(?:results?|exams?|examinations?|batch)\b/i, 3],
  ["secondary", /(?:\u0909\u091a\u094d\u091a\s*)?\u092e\u093e\u0927\u094d\u092f\u092e\u093f\u0915\s*(?:\u0935\u093f\u092d\u093e\u0917|\u0936\u093e\u0933\u093e|\u0935\u0930\u094d\u0917)|\u0915\u0928\u093f\u0937\u094d\u0920\s*\u092e\u0939\u093e\u0935\u093f\u0926\u094d\u092f\u093e\u0932\u092f/, 3],
];

function findLevels(text: string, url: string): LevelHit[] {
  const acc = new Map<string, { score: number; best: number; evidence: string; plain: number }>();
  const add = (level: string, points: number, sent: string, inSentence: Map<string, number>, plain = false) => {
    const cur = acc.get(level) ?? { score: 0, best: 0, evidence: "", plain: 0 };
    if (plain) {
      if (cur.plain >= 2) return; // plain mentions add at most twice
      cur.plain += 1;
    }
    cur.score += points;
    const here = (inSentence.get(level) ?? 0) + points;
    inSentence.set(level, here);
    if (here > cur.best) { cur.best = here; cur.evidence = clip(sent); }
    acc.set(level, cur);
  };
  for (const sent of sentences(text)) {
    const here = new Map<string, number>();
    const ranged = new Set<string>(); // levels a range in this sentence gave (each once)
    for (const m of sent.matchAll(RANGE_RE)) {
      for (const l of rangeLevels(!!m[1], m[2] ? classNumber(m[2]) : null, !!m[3], m[4] ? classNumber(m[4]) : null) ?? []) ranged.add(l);
    }
    for (const m of sent.matchAll(DEV_RANGE_RE)) {
      for (const l of rangeLevels(!!m[1], m[2] ? classNumber(m[2]) : null, false, classNumber(m[3])) ?? []) ranged.add(l);
    }
    for (const l of ranged) add(l, 5, sent, here);
    // a class or a preschool word on its own counts only for a level no range in the sentence gave
    // ("Nursery to Grade 10" is one statement, not three; "Nursery and Class 1 to 4" still counts the nursery)
    for (const m of sent.matchAll(ONE_CLASS_RE)) {
      const n = classNumber(m[1]);
      if (n !== null && !ranged.has(levelOfClass(n))) add(levelOfClass(n), 2, sent, here, true);
    }
    for (const [level, re, points, plain] of LEVEL_RULES) {
      if (plain && ranged.has(level)) continue;
      if (re.test(sent)) add(level, points, sent, here, !!plain);
    }
  }
  return [...acc.entries()].map(([level, v]) => ({ level, score: v.score, strong: v.score >= STRONG, evidence: v.evidence, url }));
}

function mergeLevels(perPage: LevelHit[][]): LevelHit[] {
  const out = new Map<string, LevelHit>();
  for (const hits of perPage) {
    for (const h of hits) {
      const cur = out.get(h.level);
      if (!cur) { out.set(h.level, { ...h }); continue; }
      const better = h.score > cur.score ? h : cur;
      out.set(h.level, { ...better, score: Math.min(cur.score + h.score, 20) });
    }
  }
  return [...out.values()]
    .map((h) => ({ ...h, strong: h.score >= STRONG }))
    .filter((h) => h.score >= SUGGEST)
    .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
}

// ---- facilities ----
// The facilities on the app's list (the same keys as public.facility_keys()). A mention is 2 points, 4 in a sentence
// that is about the school's facilities ("our campus has", "well-equipped", "infrastructure"); a facility counts at
// most three times. 4 or more is a strong suggestion. A teacher-student ratio is taken only as a ratio ("1:20").
type FacilityHit = { facility: string; detail: string | null; score: number; strong: boolean; evidence: string; url: string };
const FACILITY_ORDER = ["cafeteria", "outdoor_playground", "indoor_play", "swimming_pool", "sports_courts", "library", "science_labs",
  "computer_lab", "maths_lab", "stem_lab", "ai_lab", "smart_classes", "auditorium", "art_music", "transport", "medical_room", "cctv",
  "air_conditioned", "special_needs", "teacher_ratio"];
const FACILITY_RULES: [string, RegExp][] = [
  ["cafeteria", /\b(?:cafeteria|canteen|dining hall)\b/i],
  ["outdoor_playground", /\b(?:play ?grounds?|sports grounds?|open grounds?|play ?fields?)\b/i],
  ["indoor_play", /\b(?:indoor (?:games|sports|play(?: area)?)|sports hall|multi-?purpose hall|gymnasium)\b/i],
  ["swimming_pool", /\bswimming pools?\b/i],
  ["sports_courts", /\b(?:basketball|volleyball|tennis|badminton|squash|throwball) courts?\b|\bskating rink\b|\b(?:football|cricket) (?:field|ground|turf|pitch|nets)\b/i],
  ["library", /\blibrar(?:y|ies)\b/i],
  ["science_labs", /\b(?:science|physics|chemistry|biology) lab(?:s|oratory|oratories)?\b/i],
  ["computer_lab", /\b(?:computer|ict|it) lab(?:s|oratory|oratories)?\b/i],
  ["maths_lab", /\b(?:maths?|mathematics) lab(?:s|oratory)?\b/i],
  ["stem_lab", /\b(?:stem|steam|robotics|tinkering) lab(?:s|oratory)?\b|\batal tinkering\b/i],
  ["ai_lab", /\b(?:ai|artificial intelligence|coding) lab(?:s|oratory)?\b/i],
  ["smart_classes", /\bsmart ?(?:class(?:room)?s?|boards?)\b|\binteractive (?:flat )?(?:panels|boards)\b|\bdigital classrooms?\b/i],
  ["auditorium", /\b(?:auditorium|amphitheatre|amphitheater)\b/i],
  ["art_music", /\b(?:art|music|dance) (?:room|studio)s?\b/i],
  ["transport", /\bschool bus(?:es)?\b|\btransport(?:ation)? (?:facilit(?:y|ies)|service)\b|\bbus service\b/i],
  ["medical_room", /\b(?:infirmary|sick bay|medical room|school nurse|resident nurse|doctor on call|first[- ]aid room)\b/i],
  ["cctv", /\bcctv\b/i],
  ["air_conditioned", /\bair[- ]?conditioned\b|\bfully a\.?c\.?\b/i],
  ["special_needs", /\b(?:special needs|inclusive education|learning support|special educators?|resource room)\b/i],
];
const FACILITY_CONTEXT = /\b(?:facilit(?:y|ies)|infrastructure|campus|equipped|state[- ]of[- ]the[- ]art|spacious|well[- ]stocked|we (?:have|offer|provide)|(?:has|have) (?:a|an|its own)|boasts?|houses)\b/i;
const RATIO_RE = /\b(?:teacher|faculty|staff)s?[- ]?(?:to[- ])?(?:student|pupil)s?[- ]ratio\D{0,25}?(1\s*:\s*\d{1,3})\b|\b(?:student|pupil)s?[- ]?(?:to[- ])?(?:teacher|faculty)s?[- ]ratio\D{0,25}?(\d{1,3}\s*:\s*1)\b/i;

function findFacilities(text: string, url: string): FacilityHit[] {
  const acc = new Map<string, FacilityHit & { best: number; mentions: number }>();
  for (const sent of sentences(text)) {
    const points = FACILITY_CONTEXT.test(sent) ? 4 : 2;
    for (const [facility, re] of FACILITY_RULES) {
      if (!re.test(sent)) continue;
      const cur = acc.get(facility) ?? { facility, detail: null, score: 0, strong: false, evidence: "", url, best: 0, mentions: 0 };
      if (cur.mentions >= 3) continue;
      cur.mentions += 1;
      cur.score += points;
      if (points > cur.best) { cur.best = points; cur.evidence = clip(sent); }
      acc.set(facility, cur);
    }
    const r = RATIO_RE.exec(sent);
    const n = r ? Number((r[1] ? r[1].split(":")[1] : r[2].split(":")[0]).trim()) : NaN;
    if (!acc.has("teacher_ratio") && n >= 2 && n <= 80) {
      acc.set("teacher_ratio", { facility: "teacher_ratio", detail: `1:${n}`, score: 6, strong: true, evidence: clip(sent), url, best: 6, mentions: 1 });
    }
  }
  return [...acc.values()].map(({ best, mentions, ...h }) => h); // strong is decided once all pages are in
}

function mergeFacilities(perPage: FacilityHit[][]): FacilityHit[] {
  const out = new Map<string, FacilityHit>();
  for (const hits of perPage) {
    for (const h of hits) {
      const cur = out.get(h.facility);
      if (!cur) { out.set(h.facility, { ...h }); continue; }
      const better = h.score > cur.score ? h : cur;
      out.set(h.facility, { ...better, score: Math.min(cur.score + h.score, 12) });
    }
  }
  return [...out.values()]
    .map((h) => ({ ...h, strong: h.score >= 4 }))
    .sort((a, b) => FACILITY_ORDER.indexOf(a.facility) - FACILITY_ORDER.indexOf(b.facility));
}

// ---- achievements the school claims ----
// Board results need the exam (SSC / ICSE / class 10, HSC / ISC / class 12) AND a result word AND a percentage in the
// same sentence. Placements need admission or placement words near universities or colleges; alumni and awards their
// own phrases. The sentence itself is kept as the achievement, for an admin to check against the page.
type AchievementHit = { kind: string; text: string; year: number | null; evidence: string; url: string };
const ACHIEVEMENT_ORDER = ["class10", "class12", "placements", "alumni", "award"];
const RESULT_WORDS = /\b(?:results?|pass(?:ed)?|passing|toppers?|scored|scores?|distinctions?|first class|centum)\b/i;
const PERCENT = /\b\d{2,3}(?:\.\d{1,2})?\s*%/;
const CLASS10_RE = /\b(?:S\.?S\.?C\.?|I\.?C\.?S\.?E\.?|IGCSE|class\s*(?:x|10)(?:th)?|std\.?\s*(?:x|10)(?:th)?|grade\s*10|10th)\b/i;
const CLASS12_RE = /\b(?:H\.?S\.?C\.?|I\.?S\.?C\.?|AISSCE|class\s*(?:xii|12)(?:th)?|std\.?\s*(?:xii|12)(?:th)?|grade\s*12|12th|IB diploma|A[- ]levels?)\b/i;
const PLACEMENT_RE = /\b(?:admitted|admissions?|placed|placements?|offers?|secured|got into|accepted)\b.{0,80}\b(?:universit(?:y|ies)|IITs?|NITs?|BITS|AIIMS|Ivy League|Oxford|Cambridge|Stanford|Harvard|MIT|colleges? (?:in|abroad|across)|abroad)\b/i;
const ALUMNI_RE = /\b(?:notable|distinguished|eminent|illustrious|famous|proud) alumni\b|\balumni (?:include|includes|such as|like)\b|\bour alumni\b.{0,60}\b(?:include|such as|are)\b/i;
const AWARD_RE = /\b(?:awarded|won|received|conferred|ranked|recogni[sz]ed|felicitated|honou?red)\b.{0,80}\b(?:awards?|ranking|rank|prize|trophy|best school|no\.?\s?1|number one|top \d+|accreditation)\b/i;

function findAchievements(text: string, url: string, now: Date): AchievementHit[] {
  const out: AchievementHit[] = [];
  const latest = now.getUTCFullYear() + 1;
  for (const sent of sentences(text)) {
    if (sent.length < 12) continue;
    const results = RESULT_WORDS.test(sent) && PERCENT.test(sent);
    let kind: string | null = null;
    if (results && CLASS12_RE.test(sent)) kind = "class12";
    else if (results && CLASS10_RE.test(sent)) kind = "class10";
    else if (ALUMNI_RE.test(sent)) kind = "alumni";
    else if (PLACEMENT_RE.test(sent) && !/\badmissions?\s+(?:are\s+|is\s+)?(?:now\s+)?(?:open|closed)\b/i.test(sent)) kind = "placements";
    else if (AWARD_RE.test(sent)) kind = "award";
    if (!kind) continue;
    const years = [...sent.matchAll(/\b(19[5-9]\d|20\d{2})\b/g)].map((m) => Number(m[1])).filter((y) => y <= latest);
    const t = clip(sent, 300);
    if (out.some((a) => a.text.toLowerCase() === t.toLowerCase())) continue;
    out.push({ kind, text: t, year: years.length ? Math.max(...years) : null, evidence: t, url });
  }
  return out;
}

// At most three of a kind and twelve in all, board results first, newest first within a kind.
function mergeAchievements(perPage: AchievementHit[][]): AchievementHit[] {
  const seen = new Set<string>();
  const all = perPage.flat().filter((a) => { const k = a.text.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const out: AchievementHit[] = [];
  for (const kind of ACHIEVEMENT_ORDER) {
    out.push(...all.filter((a) => a.kind === kind).sort((a, b) => (b.year ?? 0) - (a.year ?? 0)).slice(0, 3));
  }
  return out.slice(0, 12);
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
type Reading = { pages: { url: string; status: number; note?: string }[]; boards: BoardHit[]; levels: LevelHit[]; facilities: FacilityHit[]; achievements: AchievementHit[]; admission: Admission | null; error: string | null };

async function readSchool(deps: Deps, school: School, deadline: number): Promise<Reading> {
  const pages: Reading["pages"] = [];
  const home = safeUrl(school.website);
  if (!home) return { pages, boards: [], levels: [], facilities: [], achievements: [], admission: null, error: "website address is missing or not allowed" };
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
    for (const extra of pickExtraPages(first.html, finalHome, school.name)) {
      if (deps.now().getTime() > deadline) break;
      const u = safeUrl(extra);
      if (u) await read(u);
    }
  }
  if (!texts.length) return { pages, boards: [], levels: [], facilities: [], achievements: [], admission: null, error: pages[pages.length - 1]?.note ?? "could not read the website" };

  const boards = mergeBoards(texts.map((t) => findBoards(t.text, t.url)));
  const levels = mergeLevels(texts.map((t) => findLevels(t.text, t.url)));
  const facilities = mergeFacilities(texts.map((t) => findFacilities(t.text, t.url)));
  const achievements = mergeAchievements(texts.map((t) => findAchievements(t.text, t.url, deps.now())));
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
  return { pages, boards, levels, facilities, achievements, admission, error: null };
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
          .eq("is_hidden", false).eq("category", "school").not("website", "is", null).or(`last_site_check_at.is.null,last_site_check_at.lt.${since}`)
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
            p_school: school.id, p_website: school.website ?? "", p_pages: r.pages, p_boards: r.boards, p_admission: r.admission, p_error: r.error, p_levels: r.levels, p_facilities: r.facilities, p_achievements: r.achievements,
          });
          if (error) return { school: school.name, website: school.website, boards: [], levels: [], facilities: [], achievements: [], admission: null, error: `could not save: ${error.message}` };
        }
        return { school: school.name, website: school.website, boards: r.boards.map((b) => `${b.board}${b.strong ? "" : "?"}${b.verified?.confirmed ? " (CBSE record)" : ""}`), levels: r.levels.map((l) => `${l.level}${l.strong ? "" : "?"}`), facilities: r.facilities.map((x) => `${x.facility}${x.detail ? " " + x.detail : ""}${x.strong ? "" : "?"}`), achievements: r.achievements.map((a) => a.kind), admission: r.admission ? `${r.admission.status}${r.admission.year ? " " + r.admission.year : ""}${r.admission.stale ? " (old)" : ""}` : null, error: r.error };
      });
      const done = results.filter(Boolean) as any[];

      let remaining: number | null = null;
      if (!ids) {
        const { count } = await db.from("schools").select("id", { count: "exact", head: true })
          .eq("is_hidden", false).eq("category", "school").not("website", "is", null).or(`last_site_check_at.is.null,last_site_check_at.lt.${since}`);
        remaining = typeof count === "number" ? count : null;
      }
      return json({
        ok: true, dryRun,
        processed: done.length,
        withFindings: done.filter((d) => d.boards.length || d.levels.length || d.facilities.length || d.achievements.length || d.admission).length,
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
