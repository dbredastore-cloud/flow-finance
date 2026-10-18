// Lê o Instagram dos influencers que têm o perfil na ficha (affiliates.instagram).
//
// Fase 1 — Business Discovery (Graph API, login com Facebook): com a conta profissional do Instagram da Flow,
// lê dados públicos de outras contas profissionais (Comercial ou Criador): seguidores, posts, reels, carrosséis,
// curtidas, comentários, visualizações e legendas. Stories, alcance, salvamentos e compartilhamentos só na fase 2
// (o influencer conecta o próprio Instagram pelo Portal do Afiliado).
//
// Chamado pelo pg_cron (header x-cron-secret, a cada 6 h) ou pelo painel (JWT de alguém da equipe).
// Corpo opcional: { email } para um influencer só; { deep: true } para voltar mais posts (até 500).
//
// Secrets (Supabase → Edge Functions → Secrets):
//   IG_ACCESS_TOKEN   token de usuário do sistema (Business Manager) ou token longo do Facebook com
//                     instagram_basic, instagram_manage_insights, pages_read_engagement, pages_show_list
//   IG_BUSINESS_ID    ID da conta profissional do Instagram da Flow (17841…)
//   IG_GRAPH_VERSION  opcional; padrão v25.0
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const PAGE = 50, NORMAL_PAGES = 1, DEEP_PAGES = 10;

class Fail extends Error { code: string; constructor(code: string, m: string) { super(m); this.code = code; } }

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
function config() {
  const token = env("IG_ACCESS_TOKEN"), id = env("IG_BUSINESS_ID");
  if (!token || !id) throw new Fail("no_config", "Instagram ainda não configurado: faltam os secrets IG_ACCESS_TOKEN e IG_BUSINESS_ID no Supabase.");
  return { token, id, ver: env("IG_GRAPH_VERSION") || "v25.0" };
}

// "https://www.instagram.com/fulano/", "@fulano" ou "fulano" → "fulano"
export function parseHandle(raw: string): string | null {
  let s = String(raw ?? "").trim();
  try { s = decodeURIComponent(s); } catch { /* mantém */ }
  const m = s.match(/instagram\.com\/([A-Za-z0-9._]{1,30})/i);
  if (m) s = m[1];
  s = s.replace(/^@/, "").replace(/[/?#].*$/, "").trim();
  if (!/^[A-Za-z0-9._]{1,30}$/.test(s) || ["p", "reel", "reels", "stories", "explore"].includes(s.toLowerCase())) return null;
  return s.toLowerCase();
}

const MEDIA_FIELDS = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,view_count,thumbnail_url,media_url";
const MEDIA_FIELDS_SAFE = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url";
const USER_FIELDS = "id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count";
let useSafeFields = false;

async function graph(cfg: ReturnType<typeof config>, fields: string) {
  const url = new URL(`https://graph.facebook.com/${cfg.ver}/${cfg.id}`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", cfg.token);
  const r = await fetch(url);
  const js = await r.json().catch(() => ({}));
  if (r.ok) return js;
  const err = js?.error ?? {};
  // 190 = token inválido/expirado; 4/17/32/613 = limite de chamadas.
  if (err.code === 190) throw new Fail("token", "O token do Instagram expirou ou foi revogado. Gere um novo e atualize o secret IG_ACCESS_TOKEN.");
  if ([4, 17, 32, 613].includes(err.code)) throw new Fail("rate", "Limite de chamadas da API do Instagram atingido. Tenta de novo na próxima rodada.");
  const msg = String(err.error_user_msg || err.message || `HTTP ${r.status}`);
  // Conta pessoal, inexistente ou com restrição de idade: o Business Discovery não encontra.
  if (err.code === 110 || /cannot be found|does not exist|not.*business/i.test(msg)) throw new Fail("not_found", "Perfil não encontrado ou não é conta profissional (Comercial/Criador).");
  throw new Fail("api", msg.slice(0, 300));
}

async function discover(cfg: ReturnType<typeof config>, handle: string, pages: number) {
  const fieldsFor = (after: string | null) =>
    `business_discovery.username(${handle}){${USER_FIELDS},media${after ? `.after(${after})` : ""}.limit(${PAGE}){${useSafeFields ? MEDIA_FIELDS_SAFE : MEDIA_FIELDS}}}`;
  let js;
  try { js = await graph(cfg, fieldsFor(null)); }
  catch (e) {
    // Se a versão da API não aceitar view_count, segue sem ele.
    if (e instanceof Fail && e.code === "api" && /view_count/i.test(e.message) && !useSafeFields) { useSafeFields = true; js = await graph(cfg, fieldsFor(null)); }
    else throw e;
  }
  const bd = js.business_discovery ?? {};
  const media: any[] = [...(bd.media?.data ?? [])];
  let after = bd.media?.paging?.cursors?.after ?? null;
  for (let p = 1; p < pages && after; p++) {
    const more = (await graph(cfg, fieldsFor(after))).business_discovery?.media;
    media.push(...(more?.data ?? []));
    after = more?.paging?.cursors?.after ?? null;
  }
  return { user: bd, media };
}

const num = (v: unknown) => (v == null ? null : Number(v));

async function syncOne(cfg: ReturnType<typeof config>, email: string, raw: string, deep: boolean) {
  const handle = parseHandle(raw);
  const now = new Date().toISOString();
  if (!handle) throw new Fail("input", "Perfil do Instagram não reconhecido na ficha.");
  const { user: u, media } = await discover(cfg, handle, deep ? DEEP_PAGES : NORMAL_PAGES);
  const { error: e1 } = await sb.from("instagram_accounts").upsert({
    affiliate_email: email, input_handle: raw, username: u.username ?? handle, ig_user_id: u.id ?? null, name: u.name ?? null,
    biography: String(u.biography ?? "").slice(0, 1000) || null, website: u.website ?? null, profile_picture_url: u.profile_picture_url ?? null,
    followers_count: num(u.followers_count), follows_count: num(u.follows_count), media_count: num(u.media_count),
    fetched_at: now, error: null,
  }, { onConflict: "affiliate_email" });
  if (e1) throw e1;
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  await sb.from("instagram_snapshots").upsert({ affiliate_email: email, day, followers_count: num(u.followers_count), media_count: num(u.media_count), taken_at: now },
    { onConflict: "affiliate_email,day" });
  if (media.length) {
    const rows = media.map((m) => ({
      id: String(m.id), affiliate_email: email, username: u.username ?? handle,
      media_type: m.media_type ?? null, media_product_type: m.media_product_type ?? null,
      caption: String(m.caption ?? "").slice(0, 3000) || null, permalink: m.permalink ?? null, posted_at: m.timestamp ?? null,
      like_count: num(m.like_count), comments_count: num(m.comments_count), view_count: num(m.view_count),
      thumbnail_url: m.thumbnail_url ?? m.media_url ?? null, fetched_at: now,
    }));
    const { error: e2 } = await sb.from("instagram_media").upsert(rows, { onConflict: "id" });
    if (e2) throw e2;
  }
  return media.length;
}

async function caller(req: Request): Promise<boolean> {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) { const { data } = await sb.rpc("verify_sync_secret", { secret: cronSecret }); return data === true; }
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) return false;
  const { data: admin } = await sb.from("app_admins").select("user_id").eq("user_id", data.user.id).maybeSingle();
  return !!admin;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (!(await caller(req))) return json({ ok: false, error: "unauthorized" }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* cron */ }
  const only = typeof body?.email === "string" && body.email ? body.email.toLowerCase() : null;
  const started = Date.now();
  let result: Record<string, unknown>;
  try {
    const cfg = config();
    const { data: affs, error } = await sb.from("affiliates").select("email, instagram").not("instagram", "is", null);
    if (error) throw error;
    const all = (affs ?? []).filter((a) => String(a.instagram ?? "").trim());
    const wanted = only ? all.filter((a) => a.email.toLowerCase() === only) : all;
    // Perfil apagado da ficha → sai do painel.
    if (!only) {
      const keep = all.map((a) => a.email);
      const { data: existing } = await sb.from("instagram_accounts").select("affiliate_email");
      const stale = (existing ?? []).map((x) => x.affiliate_email).filter((e) => !keep.includes(e));
      if (stale.length) await sb.from("instagram_accounts").delete().in("affiliate_email", stale);
    }
    let ok = 0, media = 0;
    const errors: Record<string, string> = {};
    for (const a of wanted) {
      if (Date.now() - started > 120_000) { errors[a.email] = "tempo esgotado nesta rodada"; continue; }
      try { media += await syncOne(cfg, a.email, String(a.instagram).trim(), body?.deep === true); ok++; }
      catch (e) {
        if (e instanceof Fail && (e.code === "token" || e.code === "rate")) throw e;
        const msg = String((e as Error)?.message ?? e).slice(0, 300);
        errors[a.email] = msg;
        await sb.from("instagram_accounts").upsert({ affiliate_email: a.email, input_handle: String(a.instagram).trim(), error: msg, fetched_at: new Date().toISOString() },
          { onConflict: "affiliate_email" });
      }
    }
    result = { ok: true, profiles: ok, failed: Object.keys(errors).length, media, errors, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    result = { ok: false, code: e instanceof Fail ? e.code : "internal", error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  if (!only) await sb.from("sync_state").upsert({ key: "instagram_last_run", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() });
  return json(result, result.ok ? 200 : (result.code === "no_config" ? 200 : 500));
});
