// Radar Instagram: lê os perfis acompanhados (ig_radar_profiles) pelo Business Discovery da Graph API, com a conta
// profissional da Flow. Só contas profissionais (Empresa ou Criador) aparecem; conta pessoal fica com o aviso.
//
// Grava o perfil, os posts e reels (ig_radar_media) e a foto do dia (ig_radar_snapshots).
// Chamado pelo pg_cron a cada 6 h (header x-cron-secret) ou pelo painel (JWT de alguém da equipe).
// Corpo opcional: { username } para um perfil só (o painel chama ao adicionar, já com mais posts).
//
// Secrets: os mesmos do instagram-sync (IG_ACCESS_TOKEN, IG_BUSINESS_ID, IG_GRAPH_VERSION opcional).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const PAGE = 50, NORMAL_PAGES = 1, NEW_PAGES = 4;

class Fail extends Error { code: string; constructor(code: string, m: string) { super(m); this.code = code; } }

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
function config() {
  const token = env("IG_ACCESS_TOKEN"), id = env("IG_BUSINESS_ID");
  if (!token || !id) throw new Fail("no_config", "Instagram ainda não configurado: faltam os secrets IG_ACCESS_TOKEN e IG_BUSINESS_ID no Supabase.");
  return { token, id, ver: env("IG_GRAPH_VERSION") || "v25.0" };
}
type Cfg = ReturnType<typeof config>;

const MEDIA_FIELDS = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,view_count";
const MEDIA_FIELDS_SAFE = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count";
const USER_FIELDS = "id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count";
let useSafeFields = false;

async function graph(cfg: Cfg, fields: string) {
  const url = new URL(`https://graph.facebook.com/${cfg.ver}/${cfg.id}`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", cfg.token);
  const r = await fetch(url);
  const js = await r.json().catch(() => ({}));
  if (r.ok) return js;
  const err = js?.error ?? {};
  if (err.code === 190) throw new Fail("token", "O token do Instagram expirou ou foi revogado. Gere um novo e atualize o secret IG_ACCESS_TOKEN.");
  if ([4, 17, 32, 613].includes(err.code)) throw new Fail("rate", "Limite de chamadas da API do Instagram atingido. Tenta de novo na próxima rodada.");
  const msg = String(err.error_user_msg || err.message || `HTTP ${r.status}`);
  if (err.code === 110 || /cannot be found|does not exist|not.*business/i.test(msg)) {
    throw new Fail("not_found", "Perfil não encontrado ou não é conta profissional (Empresa/Criador). A Meta só mostra contas profissionais. [Meta: " + msg.slice(0, 160) + "]");
  }
  throw new Fail("api", msg.slice(0, 300));
}

async function discover(cfg: Cfg, handle: string, pages: number) {
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

async function syncOne(cfg: Cfg, username: string, pages: number) {
  const now = new Date().toISOString();
  const { user: u, media } = await discover(cfg, username, pages);
  const { error: e1 } = await sb.from("ig_radar_profiles").update({
    ig_user_id: u.id ?? null, name: u.name ?? null, biography: String(u.biography ?? "").slice(0, 1000) || null,
    website: u.website ?? null, profile_picture_url: u.profile_picture_url ?? null,
    followers_count: num(u.followers_count), follows_count: num(u.follows_count), media_count: num(u.media_count),
    fetched_at: now, error: null,
  }).eq("username", username);
  if (e1) throw e1;
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  await sb.from("ig_radar_snapshots").upsert({ username, day, followers_count: num(u.followers_count), media_count: num(u.media_count), taken_at: now },
    { onConflict: "username,day" });
  if (media.length) {
    const rows = media.map((m) => ({
      id: String(m.id), username, media_type: m.media_type ?? null, media_product_type: m.media_product_type ?? null,
      caption: String(m.caption ?? "").slice(0, 3000) || null, permalink: m.permalink ?? null, posted_at: m.timestamp ?? null,
      like_count: num(m.like_count), comments_count: num(m.comments_count), view_count: num(m.view_count), fetched_at: now,
    }));
    const { error: e2 } = await sb.from("ig_radar_media").upsert(rows, { onConflict: "id" });
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
  const only = typeof body?.username === "string" && body.username ? body.username.toLowerCase().replace(/^@/, "") : null;
  const started = Date.now();
  let result: Record<string, unknown>;
  try {
    const cfg = config();
    let q = sb.from("ig_radar_profiles").select("username, fetched_at");
    if (only) q = q.eq("username", only);
    const { data: profiles, error } = await q;
    if (error) throw error;
    if (only && !(profiles ?? []).length) throw new Fail("input", "Esse perfil não está no radar.");
    let ok = 0, media = 0;
    const errors: Record<string, string> = {};
    for (const p of profiles ?? []) {
      if (Date.now() - started > 120_000) { errors[p.username] = "tempo esgotado nesta rodada"; continue; }
      try { media += await syncOne(cfg, p.username, !p.fetched_at || only ? NEW_PAGES : NORMAL_PAGES); ok++; }
      catch (e) {
        if (e instanceof Fail && (e.code === "token" || e.code === "rate")) throw e;
        const msg = String((e as Error)?.message ?? e).slice(0, 300);
        errors[p.username] = msg;
        await sb.from("ig_radar_profiles").update({ error: msg, fetched_at: new Date().toISOString() }).eq("username", p.username);
      }
    }
    result = { ok: true, profiles: ok, failed: Object.keys(errors).length, media, errors, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    result = { ok: false, code: e instanceof Fail ? e.code : "internal", error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  if (!only) await sb.from("sync_state").upsert({ key: "ig_radar_last_run", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() });
  return json(result, result.ok ? 200 : (result.code === "no_config" ? 200 : (result.code === "input" ? 400 : 500)));
});
