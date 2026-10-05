// Recebe os acessos dos usuários nos softwares (Flow Pages, Flow Tracking, Flow Spy), enviados pela Biancode.
//
//   POST {SUPABASE_URL}/functions/v1/usage-ingest
//   Header: x-api-key: fu_...   (gerada em Financeiro → Saúde dos clientes → Integração)
//   Corpo:  { "events": [ { "software": "flowpages", "email": "cliente@exemplo.com", "at": "2026-10-04T14:30:00-03:00", "hits": 1 } ] }
//           (também aceita um único evento, ou a lista direto). "at" e "hits" são opcionais:
//           sem "at" vale o momento do recebimento; sem "hits" vale 1. Até 5000 eventos por chamada.
//   Resposta: { ok: true, received, saved }   saved = linhas usuário/software/dia atualizadas.
//
// A função é pública (sem JWT do Supabase); quem protege é a chave de API. Só o hash da chave fica no banco
// (usage_api_keys) e ela pode ser revogada pelo painel. A soma por dia é feita no banco (usage_ingest).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BODY = 1_500_000;
const MAX_EVENTS = 5000;

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "use POST" }, 405);

  const key = (req.headers.get("x-api-key") ?? "").trim();
  if (!/^fu_[0-9a-f]{64}$/.test(key)) return json({ ok: false, error: "chave inválida" }, 401);
  const { data: k } = await sb.from("usage_api_keys").select("id").eq("key_hash", await sha256Hex(key)).is("revoked_at", null).maybeSingle();
  if (!k) return json({ ok: false, error: "chave inválida ou revogada" }, 401);

  const text = await req.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: "corpo grande demais" }, 413);
  let body: any;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: "JSON inválido" }, 400); }
  const events = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : body?.software ? [body] : null;
  if (!events || !events.length) return json({ ok: false, error: "envie { events: [...] }" }, 400);
  if (events.length > MAX_EVENTS) return json({ ok: false, error: `máximo de ${MAX_EVENTS} eventos por chamada` }, 413);

  const { data, error } = await sb.rpc("usage_ingest", { p_events: events });
  if (error) {
    console.error("usage-ingest", error.message);
    return json({ ok: false, error: "dados inválidos (confira software, e-mail e data)" }, 400);
  }
  await sb.from("usage_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", k.id);
  return json({ ok: true, received: events.length, saved: data });
});
