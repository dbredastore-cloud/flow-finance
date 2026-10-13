// Recuperação de senha do painel: gera o link de redefinição e envia por e-mail pela conta Gmail da Flow
// (flow@tbnegociosdigitais.com). Público (sem login), porque quem esqueceu a senha não tem sessão.
//
// Cuidados:
//   - resposta igual exista ou não a conta (não revela quem tem acesso);
//   - limite de pedidos por e-mail e por IP (tabela auth_mail_log);
//   - só contas da lista de acesso (app_admins) recebem o link;
//   - se o Gmail ainda não foi configurado, devolve code "mail_not_configured" e o painel usa o envio padrão do Supabase.
//
// Secrets: GMAIL_APP_PASSWORD (e, opcional, GMAIL_USER). Ver mail.ts.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { mailConfigured, PANEL_URL, recoveryEmail, sendMail } from "./mail.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const ALLOWED_ORIGINS = ["https://gestorflowtools.shop", "https://www.gestorflowtools.shop", "http://localhost:8765"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_PER_EMAIL = 3, MAX_PER_IP = 10;   // por hora

function corsFor(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const clientIp = (req: Request) =>
  ((req.headers.get("cf-connecting-ip") ?? (req.headers.get("x-forwarded-for") ?? "").split(",")[0] ?? "").trim() || "desconhecido");

// O link só pode voltar para uma página do próprio painel.
function safeRedirect(raw: unknown): string {
  const s = String(raw ?? "");
  try {
    const u = new URL(s);
    if (ALLOWED_ORIGINS.includes(u.origin)) return u.origin + u.pathname;
  } catch { /* usa o padrão */ }
  return PANEL_URL;
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ ok: false, code: "input", error: "Pedido inválido." }, 400); }
  if (body.action !== "recover") return json({ ok: false, code: "input", error: "Ação desconhecida." }, 400);

  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
  if (!EMAIL_RE.test(email)) return json({ ok: false, code: "input", error: "Digite um e-mail válido." }, 400);
  if (!mailConfigured()) return json({ ok: false, code: "mail_not_configured", error: "Envio de e-mail ainda não configurado." });

  const ip = clientIp(req), since = new Date(Date.now() - 3600_000).toISOString();
  const [byEmail, byIp] = await Promise.all([
    sb.from("auth_mail_log").select("id", { count: "exact", head: true }).eq("kind", "recover").eq("email", email).gte("created_at", since),
    sb.from("auth_mail_log").select("id", { count: "exact", head: true }).eq("kind", "recover").eq("ip", ip).gte("created_at", since),
  ]);
  if ((byEmail.count ?? 0) >= MAX_PER_EMAIL || (byIp.count ?? 0) >= MAX_PER_IP) {
    return json({ ok: false, code: "rate", error: "Muitos pedidos de redefinição. Tente de novo em alguns minutos." }, 429);
  }
  await sb.from("auth_mail_log").insert({ kind: "recover", email, ip });

  try {
    const { data, error } = await sb.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: safeRedirect(body.redirectTo) } });
    const uid = data?.user?.id, link = data?.properties?.action_link;
    if (!error && uid && link) {
      const { data: admin } = await sb.from("app_admins").select("user_id").eq("user_id", uid).maybeSingle();
      if (admin) await sendMail({ to: email, ...recoveryEmail(link) });
    }
  } catch (e) {
    console.error("auth-mail recover", (e as Error)?.message);
    return json({ ok: false, code: "send", error: "Não foi possível enviar o e-mail agora. Tente de novo em instantes." });
  }
  // Mesma resposta para conta existente, inexistente ou sem acesso.
  return json({ ok: true });
});
