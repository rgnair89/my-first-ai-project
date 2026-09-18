// supabase/functions/_shared/auth.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function deny(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Returns a Response to send back when the caller isn't allowed, or null when they are.
async function requireAdmin(req: Request): Promise<Response | null> {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return deny(401, "Missing bearer token");

  // Server-to-server callers (e.g. a pg_cron job) present the service-role key itself.
  if (token === serviceKey) return null;

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey);
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) return deny(401, "Invalid session");

  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return deny(403, "Admin role required");
  return null;
}

// Wraps a handler: answers CORS preflight, rejects non-admins, and adds CORS headers to the result.
export function withAdminAuth(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const denied = await requireAdmin(req);
    if (denied) return denied;

    const res = await handler(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  };
}
