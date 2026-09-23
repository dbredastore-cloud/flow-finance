// Login do painel com registro de tentativas, bloqueio por força bruta e aviso no Telegram.
//
// O painel não chama o login do Supabase direto: manda e-mail/senha para cá. Esta função
//   - bloqueia o IP (e o e-mail) após MAX_FAILS erros em WINDOW_MIN minutos;
//   - valida a senha no Supabase Auth e só devolve a sessão para quem está em app_admins;
//   - grava a tentativa em login_attempts (e-mail, IP, dispositivo) — a senha NUNCA é gravada
//     nem enviada: um erro de digitação do próprio dono exporia a senha real;
//   - avisa no Telegram: erro de login, bloqueio e login certo vindo de um IP novo.
//
// Secrets opcionais para o aviso: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const sb = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const MAX_FAILS = 5;
const WINDOW_MIN = 15;
const ALLOWED_ORIGINS = ["https://gestorflowtools.shop", "https://www.gestorflowtools.shop", "http://localhost:8765"];
const GENERIC_ERROR = "E-mail ou senha incorretos.";

function corsFor(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function clientInfo(req: Request) {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return {
    ip: (req.headers.get("cf-connecting-ip") ?? fwd.split(",")[0] ?? "").trim() || "desconhecido",
    country: req.headers.get("cf-ipcountry") ?? req.headers.get("x-country") ?? null,
    user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300),
  };
}

function device(ua: string) {
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone/iPad"
    : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "desconhecido";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl|python|node|axios|Go-http/i.test(ua) ? "script/robô" : "desconhecido";
  return `${br} no ${os}`;
}

async function notify(lines: string[]) {
  const token = (Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "").trim();
  const chat = (Deno.env.get("TELEGRAM_CHAT_ID") ?? "").trim();
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: lines.join("\n"), disable_web_page_preview: true }),
    });
  } catch { /* aviso é best-effort */ }
}

const brt = () => new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

Deno.serve(async (req) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const info = clientInfo(req);
  let email = "", password = "";
  try {
    const body = await req.json();
    email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
    password = String(body.password ?? "");
  } catch { return json({ error: GENERIC_ERROR }, 400); }
  if (!email || !password) return json({ error: GENERIC_ERROR }, 400);

  // Registra a tentativa e conta os erros recentes de uma vez só (atômico no banco), para que
  // rajadas em paralelo não escapem. Bloqueia por IP e por e-mail (trocar de IP não adianta).
  const { data: gate, error: gateErr } = await sb.rpc("login_gate", {
    p_ip: info.ip, p_email: email, p_ua: info.user_agent, p_country: info.country, p_window_min: WINDOW_MIN,
  });
  if (gateErr || !gate?.[0]) return json({ error: "Login indisponível no momento." }, 503);
  const { attempt_id: attemptId, ip_fails: ipFails, email_fails: emailFails } = gate[0];
  const log = (success: boolean, reason: string) =>
    sb.from("login_attempts").update({ success, reason }).eq("id", attemptId);

  if ((ipFails ?? 0) >= MAX_FAILS || (emailFails ?? 0) >= MAX_FAILS * 2) {
    await log(false, "bloqueado por excesso de tentativas");
    if ((ipFails ?? 0) === MAX_FAILS) {
      await notify([
        "⛔ Painel Flow — IP bloqueado por excesso de tentativas",
        `E-mail tentado: ${email}`, `IP: ${info.ip}${info.country ? ` (${info.country})` : ""}`,
        `Dispositivo: ${device(info.user_agent)}`, `Horário: ${brt()}`,
        `Bloqueio: ${WINDOW_MIN} minutos`,
      ]);
    }
    return json({ error: `Muitas tentativas. Tente de novo em ${WINDOW_MIN} minutos.` }, 429);
  }

  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const session = await r.json().catch(() => ({}));
  password = "";

  if (!r.ok || !session?.access_token) {
    await log(false, "e-mail ou senha incorretos");
    await notify([
      "🚨 Painel Flow — tentativa de acesso com senha errada",
      `E-mail tentado: ${email}`, `IP: ${info.ip}${info.country ? ` (${info.country})` : ""}`,
      `Dispositivo: ${device(info.user_agent)}`, `Horário: ${brt()}`,
      `Erros deste IP nos últimos ${WINDOW_MIN} min: ${(ipFails ?? 0) + 1} de ${MAX_FAILS}`,
    ]);
    return json({ error: GENERIC_ERROR }, 401);
  }

  // Senha certa, mas conta fora da lista de administradores: derruba a sessão.
  const { data: admin } = await sb.from("app_admins").select("user_id").eq("user_id", session.user?.id).maybeSingle();
  if (!admin) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.access_token}` } });
    await log(false, "conta sem permissão de administrador");
    await notify([
      "🚨 Painel Flow — login de conta SEM permissão",
      `E-mail: ${email}`, `IP: ${info.ip}${info.country ? ` (${info.country})` : ""}`,
      `Dispositivo: ${device(info.user_agent)}`, `Horário: ${brt()}`,
      "A senha estava certa, mas a conta não é administradora. Acesso negado.",
    ]);
    return json({ error: GENERIC_ERROR }, 401);
  }

  // Login certo: avisa se é um IP que nunca entrou antes.
  const { count: knownIp } = await sb.from("login_attempts").select("id", { count: "exact", head: true })
    .eq("email", email).eq("ip", info.ip).eq("success", true);
  await log(true, "ok");
  if (!knownIp) {
    await notify([
      "✅ Painel Flow — acesso de um IP novo",
      `E-mail: ${email}`, `IP: ${info.ip}${info.country ? ` (${info.country})` : ""}`,
      `Dispositivo: ${device(info.user_agent)}`, `Horário: ${brt()}`,
      "Se não foi você, troque a senha imediatamente.",
    ]);
  }
  return json({ access_token: session.access_token, refresh_token: session.refresh_token, expires_in: session.expires_in });
});
