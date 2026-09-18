// supabase/functions/crawl-school-fees/index.ts
//
// Self-contained: paste this whole file into the dashboard editor. No other files are needed.
// Secrets it reads:
//   SB_SECRET_KEY  optional - a Supabase secret key (sb_secret_...). Falls back to the built-in
//                  SUPABASE_SERVICE_ROLE_KEY, which stops working once legacy keys are disabled.
//
// REPORT-ONLY. It visits up to 5 schools' websites per call and reports which fee figures it can see,
// but it does NOT write to school_fees: that table requires academic_year and grade_level, and the old
// guessed numbers (admission 25,000 / transport 30,000 / activity 15,000, and 1,00,000 for PDF-only
// sites) were invented. It still stamps schools.last_crawled_at so repeated calls move on to the next
// schools. Fee storage comes back once the fee model (per year and grade, with sources) is designed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as cheerio from "https://esm.sh/cheerio@1.0.0-rc.12";

// ---- BEGIN admin-auth (identical in every function) ----
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Returns a Response to send back when the caller is not allowed, or null when they are.
async function requireAdmin(req: Request, admin: any, secretKey: string): Promise<Response | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Missing bearer token" }, 401);

  // Server-to-server callers (e.g. a pg_cron job) present the secret key itself.
  if (secretKey && token === secretKey) return null;

  const { data, error } = await admin.auth.getUser(token);
  const user = data?.user;
  if (error || !user) return json({ error: "Invalid session" }, 401);

  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return json({ error: "Admin role required" }, 403);
  return null;
}
// ---- END admin-auth ----

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const rupeeChar = String.fromCharCode(0x20B9);

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const secretKey = Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", secretKey);

    const denied = await requireAdmin(req, supabase, secretKey);
    if (denied) return denied;

    // The 5 schools crawled longest ago (or never)
    const { data: schools, error: fetchErr } = await supabase
      .from("schools")
      .select("id, name, website")
      .not("website", "is", null)
      .order("last_crawled_at", { ascending: true, nullsFirst: true })
      .limit(5);

    if (fetchErr) return json({ error: fetchErr.message }, 500);
    if (!schools || schools.length === 0) {
      return json({ success: true, message: "No schools found with websites to process." });
    }

    const logs: any[] = [];

    for (const school of schools) {
      const schoolLog: any = {
        name: school.name,
        website: school.website,
        targetUrl: school.website,
        pdfUrl: null,
        figures_found: [],
        median_guess: null,
        status: "pending",
      };

      try {
        // Mark as crawled first so the batch rotates even if this school's site fails
        await supabase.from("schools").update({ last_crawled_at: new Date().toISOString() }).eq("id", school.id);

        const homeRes = await fetch(school.website, { headers: UA, signal: AbortSignal.timeout(10000) });
        const homeHtml = await homeRes.text();
        const $ = cheerio.load(homeHtml);

        let targetUrl: string = school.website;
        let detectedPdfUrl: string | null = null;

        for (const el of $("a").toArray()) {
          const href = $(el).attr("href");
          if (!href) continue;

          const linkText = ($(el).text() || "").toLowerCase();
          const lowerHref = href.toLowerCase();

          const isPdf = lowerHref.endsWith(".pdf");
          const hasFeeKeyword = lowerHref.indexOf("fee") !== -1 || linkText.indexOf("fee") !== -1 || lowerHref.indexOf("disclosure") !== -1;
          const hasAdmissionKeyword = linkText.indexOf("admission") !== -1 || linkText.indexOf("tuition") !== -1;

          if (isPdf && hasFeeKeyword) {
            detectedPdfUrl = href.startsWith("http") ? href : new URL(href, school.website).href;
          } else if (!detectedPdfUrl && (hasFeeKeyword || hasAdmissionKeyword)) {
            targetUrl = href.startsWith("http") ? href : new URL(href, school.website).href;
          }
        }

        schoolLog.targetUrl = targetUrl;
        schoolLog.pdfUrl = detectedPdfUrl;

        const targetRes = await fetch(targetUrl, { headers: UA, signal: AbortSignal.timeout(10000) });
        const targetHtml = await targetRes.text();
        const $$ = cheerio.load(targetHtml);

        const detectedFigures: number[] = [];

        // Strategy 1: currency tokens (Rs., INR, rupee sign), floor of 5,000 to allow term instalments
        const currencyPattern = new RegExp("(?:Rs\\.?|INR|" + rupeeChar + ")\\s*([0-9,]{4,8})", "gi");
        let match: RegExpExecArray | null = currencyPattern.exec(targetHtml);
        while (match !== null) {
          const num = parseInt(match[1].replace(/,/g, ""), 10);
          if (!isNaN(num) && num >= 5000 && num <= 1500000) detectedFigures.push(num);
          match = currencyPattern.exec(targetHtml);
        }

        // Strategy 2: table rows that look like fee rows
        for (const row of $$("tr").toArray()) {
          const rowText = ($$(row).text() || "").toLowerCase();
          const isFeeRow = ["tuition", "annual", "term", "quarter", "total", "admission", "composite"].some((k) => rowText.indexOf(k) !== -1);
          if (!isFeeRow) continue;
          for (const cell of $$(row).find("td, th").toArray()) {
            const num = parseInt(($$(cell).text() || "").trim().replace(/,/g, ""), 10);
            if (!isNaN(num) && num >= 5000 && num <= 1500000) detectedFigures.push(num);
          }
        }

        detectedFigures.sort((a, b) => a - b);
        schoolLog.figures_found = detectedFigures.slice(0, 15);
        // A guess, not a fee: the median of every rupee figure on the page. Reported only, never saved.
        schoolLog.median_guess = detectedFigures.length ? detectedFigures[Math.floor(detectedFigures.length / 2)] : null;

        if (detectedFigures.length > 0) schoolLog.status = "figures found (reported, not saved)";
        else if (detectedPdfUrl) schoolLog.status = "fee schedule appears to be in a PDF: " + detectedPdfUrl;
        else schoolLog.status = "no numeric fee patterns found in page text or tables";
      } catch (err) {
        schoolLog.status = "crawl failed: " + (err instanceof Error ? err.message : String(err));
      }

      logs.push(schoolLog);
    }

    return json({ success: true, mode: "report-only (nothing written to school_fees)", count: logs.length, details: logs });
  } catch (err) {
    return json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
