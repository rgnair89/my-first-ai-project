// supabase/functions/send-push/index.ts
//
// Sends the waiting notifications to parents' phones through Expo's push service, each in the parent's own language.
// Self-contained: paste this whole file into the dashboard editor as a new function called "send-push".
//
// Before it can work (once):
//   1. Run supabase/migrations/20260920000400_notifications.sql in the SQL editor.
//   2. Set the secret SB_SECRET_KEY to a Supabase secret key (sb_secret_...). Reading the queue needs it.
//   3. Build the app with Expo (the APK), so phones have a push token. Android also needs a Firebase project
//      connected to the Expo build; see the README in the app repository.
//   4. Optional but recommended: in expo.dev, switch on "Enhanced Security for Push Notifications", make an access
//      token, and set it here as the secret EXPO_ACCESS_TOKEN.
//
// Who may call it: a Kidscover admin or a school's own staff (the portal calls it right after a reply or a change of
// stage), or a scheduled job presenting the secret key itself.
//
// What a phone shows: "<school name>" and one short line - that the school replied, or which stage an application
// reached. Never the words of a message: a locked screen is not a private place.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ==== BEGIN testable logic (must not use imports or Deno globals) ====

const EXPO_URL = "https://exp.host/--/api/v2/push/send";
const CHUNK = 100;
const SEND_TIMEOUT_MS = 15000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ==== BEGIN push words (generated from the app's own translations by scripts/build-push-words.cjs) ====
const PUSH_WORDS: Record<string, Record<string, string>> = {
  en: {
    "push.reply.body": "The school replied to your enquiry.",
    "push.status.body": "Your application is now: {stage}",
    "push.fallback.title": "Kidscover",
    "stage.in_review": "Being looked at",
    "stage.visit_scheduled": "Visit arranged",
    "stage.offered": "A place is offered",
    "stage.waitlisted": "On the waiting list",
    "stage.accepted": "Accepted",
    "stage.declined": "Not offered a place",
  },
};
// ==== END push words ====

function words(language: string, key: string): string {
  const lang = PUSH_WORDS[language] ?? {};
  return lang[key] ?? PUSH_WORDS.en[key] ?? key;
}

// One message for one phone, or null when there is nothing worth sending.
function pushMessage(row: any): any | null {
  const language = String(row?.language ?? "en");
  const school = String(row?.school_name ?? "").trim();
  const title = school || words(language, "push.fallback.title");
  let body = "";
  if (row?.kind === "enquiry_reply") {
    body = words(language, "push.reply.body");
  } else if (row?.kind === "application_status") {
    const stage = words(language, `stage.${row?.status}`);
    body = words(language, "push.status.body").replace("{stage}", stage);
  } else {
    return null;
  }
  return {
    to: row.token,
    title,
    body,
    sound: "default",
    channelId: "default",
    priority: "default",
    data: { kind: row.kind, notificationId: row.notification_id },
  };
}

const chunk = <T>(items: T[], size = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

// Expo answers with one result per message, in the same order.
function readExpoAnswer(answer: any, sent: any[]): { deadTokens: string[]; failed: Set<number> } {
  const deadTokens: string[] = [];
  const failed = new Set<number>();
  const results = Array.isArray(answer?.data) ? answer.data : [];
  sent.forEach((message, i) => {
    const result = results[i];
    if (!result || result.status !== "ok") {
      const reason = result?.details?.error ?? "";
      if (reason === "DeviceNotRegistered") deadTokens.push(message.to);
      else failed.add(message.data.notificationId);
    }
  });
  return { deadTokens, failed };
}

type Deps = {
  env: { get(name: string): string | undefined };
  fetch: typeof fetch;
  createClient: (url: string, key: string, options?: any) => any;
};

function createHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ ok: false, code: "bad_request" }, 405);
    try {
      const secretKey = deps.env.get("SB_SECRET_KEY") ?? deps.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      if (!secretKey) return json({ ok: false, code: "not_configured" });
      const admin = deps.createClient(deps.env.get("SUPABASE_URL") ?? "", secretKey, { auth: { persistSession: false } });

      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!token) return json({ ok: false, code: "sign_in" }, 401);
      if (token !== secretKey) {
        const { data: who, error } = await admin.auth.getUser(token);
        if (error || !who?.user) return json({ ok: false, code: "sign_in" }, 401);
        const { data: profile } = await admin.from("profiles").select("role").eq("id", who.user.id).maybeSingle();
        if (profile?.role !== "admin" && profile?.role !== "school_admin") return json({ ok: false, code: "not_allowed" }, 403);
      }

      const { data: rows, error: claimErr } = await admin.rpc("claim_push_batch", { p_limit: 200 });
      if (claimErr) {
        const missing = /claim_push_batch|schema cache|PGRST202/i.test(String(claimErr.message ?? ""));
        return json({ ok: false, code: missing ? "not_configured" : "failed" });
      }
      const messages = (rows ?? []).map(pushMessage).filter(Boolean) as any[];
      if (messages.length === 0) return json({ ok: true, sent: 0, dropped: 0 });

      const expoToken = deps.env.get("EXPO_ACCESS_TOKEN") ?? "";
      const dead: string[] = [];
      const failed = new Set<number>();
      let sentCount = 0;

      for (const batch of chunk(messages)) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
        try {
          const res = await deps.fetch(EXPO_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              ...(expoToken ? { Authorization: `Bearer ${expoToken}` } : {}),
            },
            body: JSON.stringify(batch),
            signal: ctrl.signal,
          });
          const text = await res.text();
          if (!res.ok) {
            batch.forEach((m) => failed.add(m.data.notificationId));
            continue;
          }
          let answer: any = null;
          try { answer = JSON.parse(text); } catch { /* handled below */ }
          if (!answer) {
            batch.forEach((m) => failed.add(m.data.notificationId));
            continue;
          }
          const read = readExpoAnswer(answer, batch);
          dead.push(...read.deadTokens);
          read.failed.forEach((id) => failed.add(id));
          sentCount += batch.length - read.failed.size;
        } catch {
          batch.forEach((m) => failed.add(m.data.notificationId));
        } finally {
          clearTimeout(timer);
        }
      }

      for (const t of [...new Set(dead)]) await admin.rpc("forget_push_token", { p_token: t });
      // Anything that reached Expo (or has nowhere left to go) is done; the rest is tried again on the next run.
      const done = [...new Set(messages.map((m) => m.data.notificationId).filter((id) => !failed.has(id)))];
      if (done.length) await admin.rpc("finish_push", { p_ids: done });

      return json({ ok: true, sent: sentCount, dropped: dead.length, retrying: failed.size });
    } catch (_err) {
      return json({ ok: false, code: "failed" }, 500);
    }
  };
}

// ==== END testable logic ====

Deno.serve(createHandler({ env: Deno.env, fetch, createClient }));
