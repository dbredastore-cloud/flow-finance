// Conectar YouTube (Portal do Afiliado): o influencer autoriza o próprio canal pelo login do Google e a Flow passa a
// ler o tempo assistido (YouTube Analytics API: tempo médio, % assistido, minutos assistidos, retenção, inscritos ganhos).
//
//   POST { action: "start" }       (login do afiliado)  → { url } da página de autorização do Google
//   GET  ?code=…&state=…           (volta do Google)    → guarda o refresh token e devolve para o portal
//   POST { action: "disconnect" }  (login do afiliado)  → revoga e apaga o token; os números já lidos ficam
//
// Só leitura: yt-analytics.readonly + youtube.readonly (para saber qual canal foi autorizado). A senha nunca passa aqui.
// O token fica em youtube_connections, que nenhum login lê. verify_jwt = false porque a volta do Google não traz login:
// o POST confere o login do afiliado aqui dentro e o GET confere o "state" criado no POST (15 min, uso único).
//
// Secrets (Supabase → Edge Functions → Secrets):
//   YT_OAUTH_CLIENT_ID, YT_OAUTH_CLIENT_SECRET   cliente OAuth "Aplicativo da Web" do Google Cloud, com o URI de
//                                                 redirecionamento https://<projeto>.supabase.co/functions/v1/yt-connect
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const PORTAL_URL = "https://gestorflowtools.shop/parceiro/";
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/yt-connect`;
const SCOPES = "https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.readonly";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

class Fail extends Error { code: string; extra?: Record<string, unknown>; constructor(code: string, m: string, extra?: Record<string, unknown>) { super(m); this.code = code; this.extra = extra; } }
const env = (k: string) => (Deno.env.get(k) ?? "").trim();
function config() {
  const id = env("YT_OAUTH_CLIENT_ID"), secret = env("YT_OAUTH_CLIENT_SECRET");
  if (!id || !secret) {
    const missing = [!id && "YT_OAUTH_CLIENT_ID", !secret && "YT_OAUTH_CLIENT_SECRET"].filter(Boolean);
    throw new Fail("no_config", "A conexão com o YouTube ainda está sendo liberada pela Flow. Tente de novo em breve.", { missing });
  }
  return { id, secret };
}

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const back = (params: Record<string, string>) => Response.redirect(PORTAL_URL + "?" + new URLSearchParams(params).toString(), 302);

async function readJson(r: Response) {
  const js = await r.json().catch(() => ({}));
  if (r.ok) return js;
  const msg = String(js?.error_description || js?.error?.message || js?.error || `HTTP ${r.status}`);
  throw new Fail("api", msg.slice(0, 240));
}

async function partnerOf(req: Request) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new Fail("auth", "Entre no Portal do Afiliado para conectar o YouTube.");
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) throw new Fail("auth", "Sessão expirada. Entre de novo no portal.");
  const { data: p } = await sb.from("partner_users").select("affiliate_email").eq("user_id", data.user.id).eq("active", true).maybeSingle();
  if (!p) throw new Fail("auth", "Só o próprio afiliado, com o login do portal, pode conectar o YouTube.");
  return { userId: data.user.id, email: String(p.affiliate_email) };
}

async function start(req: Request) {
  const cfg = config();
  const who = await partnerOf(req);
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const state = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await sb.from("youtube_connect_states").delete().lt("expires_at", new Date().toISOString());
  const { error } = await sb.from("youtube_connect_states").insert({ state, affiliate_email: who.email, user_id: who.userId });
  if (error) throw error;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", cfg.id);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("access_type", "offline");      // refresh token para ler sem o influencer por perto
  url.searchParams.set("prompt", "consent select_account"); // sempre devolve o refresh token e deixa escolher a conta do canal
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return json({ ok: true, url: url.toString() });
}

async function callback(url: URL) {
  const state = url.searchParams.get("state") ?? "";
  if (url.searchParams.get("error")) return back({ yt: "cancelado" });
  const { data: st } = await sb.from("youtube_connect_states").select("*").eq("state", state).maybeSingle();
  if (!st || Date.parse(st.expires_at) < Date.now()) return back({ yt: "erro", motivo: "O pedido de conexão expirou. Clique em Conectar YouTube de novo." });
  await sb.from("youtube_connect_states").delete().eq("state", state);
  try {
    const cfg = config();
    const tok = await readJson(await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({ code: url.searchParams.get("code") ?? "", client_id: cfg.id, client_secret: cfg.secret, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }),
    }));
    if (!tok.refresh_token) throw new Fail("api", "O Google não devolveu a autorização permanente. Tente conectar de novo.");
    const granted = String(tok.scope ?? "").split(" ").filter(Boolean);
    if (!granted.some((s) => s.endsWith("yt-analytics.readonly"))) throw new Fail("api", "Para ver o tempo assistido, marque a permissão do YouTube Analytics na tela do Google.");
    // Qual canal foi autorizado.
    const me = await readJson(await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${tok.access_token}` } }));
    const ch = me.items?.[0];
    if (!ch) throw new Fail("api", "Essa conta do Google não tem canal no YouTube. Escolha a conta (ou a conta de marca) do seu canal.");
    const now = new Date().toISOString();
    const { error } = await sb.from("youtube_connections").upsert({
      affiliate_email: st.affiliate_email, channel_id: ch.id, channel_title: ch.snippet?.title ?? null,
      refresh_token: tok.refresh_token, access_token: tok.access_token, access_expires_at: new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString(),
      scopes: granted, connected_at: now, connected_by: st.user_id, status: "ok", error: null, last_full_at: null,
    }, { onConflict: "affiliate_email" });
    if (error) throw error;
    // Sem canal na ficha: liga o canal autorizado (o youtube-sync passa a ler vídeos e inscritos dele).
    const { data: aff } = await sb.from("affiliates").select("youtube").eq("email", st.affiliate_email).maybeSingle();
    if (!String(aff?.youtube ?? "").trim()) await sb.from("affiliates").update({ youtube: `https://www.youtube.com/channel/${ch.id}` }).eq("email", st.affiliate_email);
    // Primeira leitura já agora, sem segurar a volta para o portal.
    const first = fetch(`${SUPABASE_URL}/functions/v1/yt-analytics`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ email: st.affiliate_email, full: true }),
    }).catch(() => {});
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(first);
    return back({ yt: "conectado" });
  } catch (e) {
    console.error("yt-connect callback", (e as Error)?.message);
    return back({ yt: "erro", motivo: String((e as Error)?.message ?? e).slice(0, 160) });
  }
}

async function disconnect(req: Request) {
  const who = await partnerOf(req);
  const { data: c } = await sb.from("youtube_connections").select("refresh_token").eq("affiliate_email", who.email).maybeSingle();
  if (c?.refresh_token) await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(c.refresh_token), { method: "POST" }).catch(() => {});
  await sb.from("youtube_connections").delete().eq("affiliate_email", who.email);
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
