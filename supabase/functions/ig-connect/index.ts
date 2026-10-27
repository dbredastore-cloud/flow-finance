// Conectar Instagram (Portal do Afiliado): o influencer autoriza o próprio Instagram pelo login oficial do Instagram
// (API do Instagram com Login do Instagram) e a Flow passa a ler stories, alcance, salvamentos e público dele.
//
//   POST { action: "start" }       (login do afiliado)  → { url } da página de autorização do Instagram
//   GET  ?code=…&state=…           (volta do Instagram) → guarda o token de 60 dias e devolve para o portal
//   POST { action: "disconnect" }  (login do afiliado)  → apaga o token; os dados já lidos ficam
//
// A senha do influencer nunca passa por aqui. O token fica em instagram_connections, que nenhum login lê.
// Sem JWT obrigatório no gateway (verify_jwt = false) porque a volta do Instagram não traz login: o POST confere o
// login do afiliado aqui dentro e o GET confere o "state" criado no POST (vale 15 min, uso único).
//
// Secrets (Supabase → Edge Functions → Secrets):
//   IG_APP_ID, IG_APP_SECRET   "ID do app do Instagram" e "Chave secreta do app do Instagram" (app da Meta → Instagram →
//                              Configuração da API com login do Instagram)
//   IG_GRAPH_VERSION           opcional; padrão v25.0
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const PORTAL_URL = "https://gestorflowtools.shop/parceiro/";
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/ig-connect`;
const SCOPES = "instagram_business_basic,instagram_business_manage_insights";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

class Fail extends Error { code: string; extra?: Record<string, unknown>; constructor(code: string, m: string, extra?: Record<string, unknown>) { super(m); this.code = code; this.extra = extra; } }
const env = (k: string) => (Deno.env.get(k) ?? "").trim();
function config() {
  const appId = env("IG_APP_ID"), secret = env("IG_APP_SECRET");
  if (!appId || !secret) {
    // Para a equipe achar o problema: quais faltam e quais nomes IG_* existem (só os nomes, nunca os valores).
    const missing = [!appId && "IG_APP_ID", !secret && "IG_APP_SECRET"].filter(Boolean);
    const seen = Object.keys(Deno.env.toObject()).filter((k) => /^\s*IG_/i.test(k)).sort();
    throw new Fail("no_config", "A conexão com o Instagram ainda está sendo liberada pela Flow. Tente de novo em breve.", { missing, seen });
  }
  return { appId, secret, ver: env("IG_GRAPH_VERSION") || "v25.0" };
}

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const back = (params: Record<string, string>) => Response.redirect(PORTAL_URL + "?" + new URLSearchParams(params).toString(), 302);
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

async function readJson(r: Response) {
  const js = await r.json().catch(() => ({}));
  if (r.ok) return js;
  const err = js?.error ?? {};
  const msg = String(err.error_user_msg || err.message || js?.error_message || `HTTP ${r.status}`);
  throw new Fail("api", msg.slice(0, 240));
}

// Afiliado do login (o mesmo vínculo das funções portal_*).
async function partnerOf(req: Request) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new Fail("auth", "Entre no Portal do Afiliado para conectar o Instagram.");
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) throw new Fail("auth", "Sessão expirada. Entre de novo no portal.");
  const { data: p } = await sb.from("partner_users").select("affiliate_email").eq("user_id", data.user.id).eq("active", true).maybeSingle();
  if (!p) throw new Fail("auth", "Só o próprio afiliado, com o login do portal, pode conectar o Instagram.");
  return { userId: data.user.id, email: String(p.affiliate_email) };
}

async function start(req: Request) {
  const cfg = config();
  const who = await partnerOf(req);
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const state = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await sb.from("instagram_connect_states").delete().lt("expires_at", new Date().toISOString());
  const { error } = await sb.from("instagram_connect_states").insert({ state, affiliate_email: who.email, user_id: who.userId });
  if (error) throw error;
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("force_reauth", "true");
  url.searchParams.set("client_id", cfg.appId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  return json({ ok: true, url: url.toString() });
}

async function callback(url: URL) {
  const state = url.searchParams.get("state") ?? "";
  if (url.searchParams.get("error")) return back({ ig: "cancelado" });
  const { data: st } = await sb.from("instagram_connect_states").select("*").eq("state", state).maybeSingle();
  if (!st || Date.parse(st.expires_at) < Date.now()) return back({ ig: "erro", motivo: "O pedido de conexão expirou. Clique em Conectar Instagram de novo." });
  await sb.from("instagram_connect_states").delete().eq("state", state);
  try {
    const cfg = config();
    const code = String(url.searchParams.get("code") ?? "").replace(/#_$/, "");
    // 1) código → token curto (1 h)
    const short = await readJson(await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      body: new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.secret, grant_type: "authorization_code", redirect_uri: REDIRECT_URI, code }),
    }));
    const s0 = Array.isArray(short?.data) ? short.data[0] : short;
    if (!s0?.access_token) throw new Fail("api", "O Instagram não devolveu a autorização.");
    // 2) token curto → token longo (60 dias)
    const ll = new URL("https://graph.instagram.com/access_token");
    ll.searchParams.set("grant_type", "ig_exchange_token");
    ll.searchParams.set("client_secret", cfg.secret);
    ll.searchParams.set("access_token", s0.access_token);
    const long = await readJson(await fetch(ll));
    const token = String(long.access_token);
    const expires = new Date(Date.now() + (Number(long.expires_in) || 5184000) * 1000).toISOString();
    // 3) quem conectou
    const me = new URL(`https://graph.instagram.com/${cfg.ver}/me`);
    me.searchParams.set("fields", "user_id,username,name,profile_picture_url,followers_count,follows_count,media_count,account_type");
    me.searchParams.set("access_token", token);
    const u = await readJson(await fetch(me));
    const now = new Date().toISOString();
    const perms = s0.permissions ? (Array.isArray(s0.permissions) ? s0.permissions : String(s0.permissions).split(",")) : SCOPES.split(",");
    const { error: e1 } = await sb.from("instagram_connections").upsert({
      affiliate_email: st.affiliate_email, ig_user_id: String(u.user_id ?? u.id ?? s0.user_id ?? ""), username: u.username ?? null,
      access_token: token, token_expires_at: expires, scopes: perms, connected_at: now, connected_by: st.user_id,
      last_refresh_at: now, status: "ok", error: null, last_full_at: null,
    }, { onConflict: "affiliate_email" });
    if (e1) throw e1;
    // A ficha do afiliado passa a ter o perfil conectado, se ainda não tinha (senão a leitura pública o tiraria do painel).
    const { data: aff } = await sb.from("affiliates").select("instagram").eq("email", st.affiliate_email).maybeSingle();
    const handle = String(aff?.instagram ?? "").trim() || `https://www.instagram.com/${u.username}`;
    if (!String(aff?.instagram ?? "").trim() && u.username) await sb.from("affiliates").update({ instagram: handle }).eq("email", st.affiliate_email);
    await sb.from("instagram_accounts").upsert({
      affiliate_email: st.affiliate_email, input_handle: handle, username: u.username ?? null, ig_user_id: String(u.user_id ?? u.id ?? ""),
      name: u.name ?? null, profile_picture_url: u.profile_picture_url ?? null, followers_count: num(u.followers_count),
      follows_count: num(u.follows_count), media_count: num(u.media_count), source: "oauth", fetched_at: now, error: null,
    }, { onConflict: "affiliate_email" });
    // Primeira leitura completa já agora, sem segurar a volta para o portal.
    const first = fetch(`${SUPABASE_URL}/functions/v1/ig-partners`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ email: st.affiliate_email, full: true }),
    }).catch(() => {});
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(first);
    return back({ ig: "conectado" });
  } catch (e) {
    console.error("ig-connect callback", (e as Error)?.message);
    return back({ ig: "erro", motivo: String((e as Error)?.message ?? e).slice(0, 160) });
  }
}

async function disconnect(req: Request) {
  const who = await partnerOf(req);
  await sb.from("instagram_connections").delete().eq("affiliate_email", who.email);
  await sb.from("instagram_accounts").update({ source: "discovery" }).eq("affiliate_email", who.email);
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.has("state") || url.searchParams.has("error")) return callback(url);
    return back({});
  }
  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  try {
    if (body.action === "start") return await start(req);
    if (body.action === "disconnect") return await disconnect(req);
    return json({ ok: false, code: "input", error: "Ação desconhecida." }, 400);
  } catch (e) {
    const code = e instanceof Fail ? e.code : "internal";
    return json({ ok: false, code, error: String((e as Error)?.message ?? e).slice(0, 300), ...(e instanceof Fail ? e.extra : {}) }, code === "auth" ? 401 : code === "no_config" ? 200 : 500);
  }
});
