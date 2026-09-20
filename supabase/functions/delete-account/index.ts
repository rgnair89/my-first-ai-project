// supabase/functions/delete-account/index.ts
//
// Deletes a parent's account and everything about them, at their own request, from the app's Settings screen.
// Self-contained: paste this whole file into the dashboard editor as a new function called "delete-account".
//
// Before it can work (once):
//   1. Run supabase/migrations/20260920000500_account_and_security.sql in the SQL editor.
//   2. Set the secret SB_SECRET_KEY to a Supabase secret key (sb_secret_...). Removing a sign-in needs it.
//
// Request (POST, from the signed-in app): no body.
// Answer: { ok: true } - the account is gone, and the app signs out.
//         { ok: false, code: "reauth" } - they must enter their password again first (their sign-in is too old).
//         { ok: false, code: "sign_in" | "not_configured" | "failed" }
//
// What happens: their reviews, applications, notifications, phones and staff access are deleted first (as them, so the
// database's own rules apply), then their sign-in is removed, which takes their profile, their enquiries and their
// messages with it. Words a school staff member wrote in other families' conversations stay, without the person.
// There is no undo, and no copy is kept. A school that already received an application in its own system keeps that
// copy; the app says so before asking to go ahead.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ==== BEGIN testable logic (must not use imports or Deno globals) ====

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

type Deps = {
  env: { get(name: string): string | undefined };
  createClient: (url: string, key: string, options?: any) => any;
};

function createHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ ok: false, code: "bad_request" }, 405);
    try {
      const url = deps.env.get("SUPABASE_URL") ?? "";
      const secretKey = deps.env.get("SB_SECRET_KEY") ?? deps.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      if (!secretKey) return json({ ok: false, code: "not_configured" });

      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!token) return json({ ok: false, code: "sign_in" }, 401);

      // as the person themselves: their own sign-in decides what may be deleted
      const apikey = req.headers.get("apikey") ?? deps.env.get("SUPABASE_ANON_KEY") ?? "";
      const asUser = deps.createClient(url, apikey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: who, error: whoErr } = await asUser.auth.getUser(token);
      const user = who?.user;
      if (whoErr || !user) return json({ ok: false, code: "sign_in" }, 401);

      const { error: dataErr } = await asUser.rpc("delete_my_account_data");
      if (dataErr) {
        const msg = String(dataErr.message ?? "");
        if (/password again/i.test(msg)) return json({ ok: false, code: "reauth" });
        if (/delete_my_account_data|schema cache|PGRST202/i.test(msg)) return json({ ok: false, code: "not_configured" });
        return json({ ok: false, code: "failed" });
      }

      // and only then, with the secret key, the sign-in itself
      const admin = deps.createClient(url, secretKey, { auth: { persistSession: false } });
      const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
      if (delErr) return json({ ok: false, code: "failed" });
      return json({ ok: true });
    } catch (_err) {
      return json({ ok: false, code: "failed" }, 500);
    }
  };
}

// ==== END testable logic ====

Deno.serve(createHandler({ env: Deno.env, createClient }));
