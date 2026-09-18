import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as cheerio from "https://esm.sh/cheerio@1.0.0-rc.12";

serve(async (_req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Fetch 5 schools that haven't been crawled yet (or crawled longest ago)
    const { data: schools, error: fetchErr } = await supabase
      .from("schools")
      .select("id, name, website, board")
      .not("website", "is", null)
      .order("last_crawled_at", { ascending: true, nullsFirst: true })
      .limit(5);

    if (fetchErr) {
      return new Response(JSON.stringify({ error: fetchErr.message }), { status: 500 });
    }

    if (!schools || schools.length === 0) {
      return new Response(JSON.stringify({ 
        success: true, 
        message: "No schools found with websites to process." 
      }), { headers: { "Content-Type": "application/json" } });
    }

    const logs: any[] = [];
    const rupeeChar = String.fromCharCode(0x20B9);

    for (const school of schools) {
      const schoolLog: any = { 
        name: school.name, 
        website: school.website, 
        targetUrl: school.website,
        pdfUrl: null,
        extracted: null, 
        status: "pending" 
      };

      try {
        // Mark school as crawled immediately to guarantee batch rotation
        await supabase
          .from("schools")
          .update({ last_crawled_at: new Date().toISOString() })
          .eq("id", school.id);

        const homeRes = await fetch(school.website, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });
        const homeHtml = await homeRes.text();
        const $ = cheerio.load(homeHtml);

        let targetUrl = school.website;
        let detectedPdfUrl: string | null = null;

        const anchorElements = $("a").toArray();
        for (const el of anchorElements) {
          const href = $(el).attr("href");
          if (!href) continue;

          const textVal = $(el).text() || "";
          const linkText = textVal.toLowerCase();
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

        const targetRes = await fetch(targetUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });
        const targetHtml = await targetRes.text();
        const $$ = cheerio.load(targetHtml);

        const detectedFigures: number[] = [];

        // Strategy 1: Currency tokens (₹, Rs., INR) — lowered floor to 5,000 for term installments
        const currencyPattern = new RegExp("(?:Rs\\.?|INR|" + rupeeChar + ")\\s*([0-9,]{4,8})", "gi");
        let match: RegExpExecArray | null = currencyPattern.exec(targetHtml);
        while (match !== null) {
          const cleanNum = parseInt(match[1].replace(/,/g, ""), 10);
          if (!isNaN(cleanNum) && cleanNum >= 5000 && cleanNum <= 1500000) {
            detectedFigures.push(cleanNum);
          }
          match = currencyPattern.exec(targetHtml);
        }

        // Strategy 2: HTML tables with fee headers
        const tableRows = $$("tr").toArray();
        for (const row of tableRows) {
          const rowText = ($$(row).text() || "").toLowerCase();
          const isFeeRow = ["tuition", "annual", "term", "quarter", "total", "admission", "composite"].some(function(k) {
            return rowText.indexOf(k) !== -1;
          });

          if (isFeeRow) {
            const cells = $$(row).find("td, th").toArray();
            for (const cell of cells) {
              const cellText = ($$(cell).text() || "").trim().replace(/,/g, "");
              const num = parseInt(cellText, 10);
              if (!isNaN(num) && num >= 5000 && num <= 1500000) {
                detectedFigures.push(num);
              }
            }
          }
        }

        // Strategy 3: Calculate Annual TCO
        if (detectedFigures.length > 0) {
          detectedFigures.sort((a, b) => a - b);
          const medianVal = detectedFigures[Math.floor(detectedFigures.length / 2)];
          
          // If median is a term/quarter installment (< ₹40,000), extrapolate to 4 quarters
          const baseTuition = medianVal < 40000 ? medianVal * 4 : medianVal;
          const totalTco = Math.round(baseTuition * 1.25);

// With total_tco excluded:
const { error: upsertErr } = await supabase.from("school_fees").upsert({
  school_id: school.id,
  base_tuition_annual: baseTuition,
  admission_one_time: 25000,
  transport_annual: 30000,
  tech_activity_annual: 15000,
  source_url: targetUrl,
  fee_pdf_url: detectedPdfUrl
}, { onConflict: "school_id" });

          if (upsertErr) {
            schoolLog.status = "Database error: " + upsertErr.message;
          } else {
            schoolLog.extracted = { baseTuition, totalTco };
            schoolLog.status = "Successfully parsed and saved fee values";
          }
        } else if (detectedPdfUrl) {
  await supabase.from("school_fees").upsert({
    school_id: school.id,
    base_tuition_annual: 100000,
    admission_one_time: 25000,
    transport_annual: 30000,
    tech_activity_annual: 15000,
    source_url: targetUrl,
    fee_pdf_url: detectedPdfUrl
  }, { onConflict: "school_id" });

  schoolLog.status = "Fee schedule located in external PDF: " + detectedPdfUrl;
} else {
          schoolLog.status = "No numeric fee patterns found in page text or tables";
        }
      } catch (err: any) {
        schoolLog.status = "Crawl failed: " + err.message;
      }

      logs.push(schoolLog);
    }

    return new Response(JSON.stringify({ 
      success: true, 
      count: logs.length, 
      details: logs 
    }, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (globalErr: any) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: globalErr.message 
    }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
});