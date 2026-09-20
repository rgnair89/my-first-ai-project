// supabase/functions/crm-deliver/index.ts
//
// Sends admission applications on to each partner school's own admissions system (CRM), signed so the school can
// prove the message really came from Kidscover.
// Self-contained: paste this whole file into the dashboard editor as a new function called "crm-deliver".
//
// Before it can work (once):
//   1. Run supabase/migrations/20260920000300_partner_schools.sql in the SQL editor.
//   2. Set the secret SB_SECRET_KEY to a Supabase secret key (sb_secret_...). This function needs it because it reads
//      the school's signing secret, which nobody signed in may read.
//   3. Connect a school in the Partner Portal (School Profiles > Admissions system), and give that school the signing
//      secret it shows you, once.
//
// Who may call it: a Kidscover admin or a school's own staff (the portal calls it after an application arrives or when
// somebody presses Retry), or a scheduled job presenting the secret key itself.
//
// What the school receives (POST, application/json):
//   headers  X-Kidscover-Event: application.submitted | application.withdrawn | webhook.test
//            X-Kidscover-Delivery: <number>
//            X-Kidscover-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the signing secret>
//   body     { event, delivery_id, sent_at, school: { id, name }, application: { ... } | null }
// The school should check the signature before trusting the body, and answer 2xx within 10 seconds. Anything else is
// tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours.
//
// Safety: only https addresses with a real host name are ever called (the database checks this when the address is
// saved, and this function checks again). Addresses that resolve to a private or local network are refused, so a
// mistyped address cannot be used to reach anything inside Supabase. Redirects are not followed. Nothing about a
// child is written to the logs.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ==== BEGIN testable logic (must not use imports or Deno globals) ====

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SEND_TIMEOUT_MS = 10000;
const MAX_PER_RUN = 20;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// The same rule as the database: https, a real host name, the standard port, nothing local or internal.
function safeWebhookUrl(url: string): boolean {
  if (typeof url !== "string" || url.length > 500) return false;
  if (!/^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(:443)?(\/[^\s]*)?$/i.test(url)) return false;
  if (/^https:\/\/[^/]*\.(local|localhost|internal|intranet|lan|home|corp|arpa)(:443)?(\/|$)/i.test(url)) return false;
  if (/^https:\/\/[^/]*(supabase\.co|supabase\.in)(:443)?(\/|$)/i.test(url)) return false;
  return true;
}

// Addresses inside the machine, the network, or a cloud provider's metadata service.
function isPrivateAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return true;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19))
        || a >= 224;
  }
  const v6 = ip.trim().toLowerCase();
  if (!v6.includes(":")) return true;                       // not an address we understand
  if (v6 === "::1" || v6 === "::") return true;
  if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true;  // unique local, link local
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return false;
}

// "t=1758330000,v1=<hex>" over "<t>.<body>", as Stripe and GitHub do it, so a school's developer will recognise it.
async function signBody(crypto: Crypto, secret: string, body: string, atSeconds: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${atSeconds}.${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${atSeconds},v1=${hex}`;
}

type Deps = {
  env: { get(name: string): string | undefined };
  fetch: typeof fetch;
  createClient: (url: string, key: string, options?: any) => any;
  crypto: Crypto;
  now: () => Date;
  resolve?: (host: string) => Promise<string[]>;
};

function createHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ ok: false, code: "bad_request" }, 405);
    try {
      const secretKey = deps.env.get("SB_SECRET_KEY") ?? deps.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      if (!secretKey) return json({ ok: false, code: "not_configured" });
      const admin = deps.createClient(deps.env.get("SUPABASE_URL") ?? "", secretKey, { auth: { persistSession: false } });

      // who is asking: a school's staff, a Kidscover admin, or a scheduled job with the secret key itself
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!token) return json({ ok: false, code: "sign_in" }, 401);
      if (token !== secretKey) {
        const { data: who, error } = await admin.auth.getUser(token);
        if (error || !who?.user) return json({ ok: false, code: "sign_in" }, 401);
        const { data: profile } = await admin.from("profiles").select("role").eq("id", who.user.id).maybeSingle();
        if (profile?.role !== "admin" && profile?.role !== "school_admin") return json({ ok: false, code: "not_allowed" }, 403);
      }

      const { data: jobs, error: claimErr } = await admin.rpc("claim_crm_deliveries", { p_limit: MAX_PER_RUN });
      if (claimErr) {
        const missing = /claim_crm_deliveries|schema cache|PGRST202/i.test(String(claimErr.message ?? ""));
        return json({ ok: false, code: missing ? "not_configured" : "failed" });
      }

      let delivered = 0, failed = 0;
      for (const job of jobs ?? []) {
        const finish = (ok: boolean, status: number | null, error: string | null) =>
          admin.rpc("finish_crm_delivery", { p_id: job.delivery_id, p_ok: ok, p_http_status: status, p_error: error });

        if (!safeWebhookUrl(job.url)) {
          failed += 1;
          await finish(false, null, "The address is not a plain https web address");
          continue;
        }
        if (deps.resolve) {
          try {
            const host = new URL(job.url).hostname;
            const addresses = await deps.resolve(host);
            if (!addresses.length || addresses.some(isPrivateAddress)) {
              failed += 1;
              await finish(false, null, "The address points inside a private network");
              continue;
            }
          } catch {
            failed += 1;
            await finish(false, null, "The address could not be looked up");
            continue;
          }
        }

        const body = JSON.stringify(job.payload);
        const signature = await signBody(deps.crypto, job.secret, body, Math.floor(deps.now().getTime() / 1000));
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
        try {
          const res = await deps.fetch(job.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "Kidscover-Webhook/1.0",
              "X-Kidscover-Event": String(job.event),
              "X-Kidscover-Delivery": String(job.delivery_id),
              "X-Kidscover-Signature": signature,
            },
            body,
            redirect: "manual",
            signal: ctrl.signal,
          });
          if (res.status >= 200 && res.status < 300) {
            delivered += 1;
            await finish(true, res.status, null);
          } else {
            failed += 1;
            const why = res.status >= 300 && res.status < 400 ? "The address redirects somewhere else" : `The school's system answered ${res.status}`;
            await finish(false, res.status, why);
          }
        } catch (e) {
          failed += 1;
          const timedOut = (e as any)?.name === "AbortError";
          await finish(false, null, timedOut ? "The school's system did not answer in 10 seconds" : "Could not reach the school's system");
        } finally {
          clearTimeout(timer);
        }
      }
      return json({ ok: true, delivered, failed, taken: (jobs ?? []).length });
    } catch (_err) {
      return json({ ok: false, code: "failed" }, 500);
    }
  };
}

// ==== END testable logic ====

Deno.serve(
  createHandler({
    env: Deno.env,
    fetch,
    createClient,
    crypto,
    now: () => new Date(),
    resolve: async (host: string) => {
      const out: string[] = [];
      for (const kind of ["A", "AAAA"] as const) {
        try { out.push(...(await Deno.resolveDns(host, kind))); } catch { /* the other kind may still answer */ }
      }
      return out;
    },
  }),
);
