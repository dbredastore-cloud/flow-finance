// Instagram dos influencers conectados (fase 2): lê com o token de cada um (instagram_connections, gravado pela ig-connect).
//
// De hora em hora: os stories no ar, com alcance, visualizações, respostas, compartilhamentos e navegação
// (instagram_stories; o story que sai do ar fica com a última leitura como final).
// A cada 6 h (ou { full: true }): perfil e foto do dia, posts e reels com as métricas privadas (alcance, salvamentos,
// compartilhamentos, tempo assistido) em instagram_media, resumo diário da conta (instagram_account_daily) e público
// por cidade, país, idade e gênero (instagram_audience). Renova o token quando faltam menos de 15 dias para vencer.
//
// Chamado pelo pg_cron (x-cron-secret), pela ig-connect logo após conectar (chave de serviço) ou pelo painel (JWT da equipe).
// Corpo opcional: { email } para um influencer só; { full: true } para forçar a leitura completa.
// Secrets: IG_GRAPH_VERSION opcional (padrão v25.0). O token de cada influencer fica no banco.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const VER = (Deno.env.get("IG_GRAPH_VERSION") ?? "").trim() || "v25.0";
const FULL_EVERY_MS = 6 * 3600e3;
const FLOW_RE = /flow[\s\-_.]*(pages?|track(ing)?|spy)|@useaflow/i;

class Fail extends Error { code: string; constructor(code: string, m: string) { super(m); this.code = code; } }

async function ig(token: string, path: string, params: Record<string, string> = {}) {
  const url = new URL(path.startsWith("http") ? path : `https://graph.instagram.com/${VER}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!url.searchParams.has("access_token")) url.searchParams.set("access_token", token);
  const r = await fetch(url);
  const js = await r.json().catch(() => ({}));
  if (r.ok) return js;
  const err = js?.error ?? {};
  if (err.code === 190) throw new Fail("token", "A autorização do Instagram venceu ou foi retirada. O influencer precisa conectar de novo no portal.");
  if ([4, 17, 32, 613].includes(err.code)) throw new Fail("rate", "Limite de chamadas da API do Instagram atingido.");
  throw new Fail("api", String(err.error_user_msg || err.message || `HTTP ${r.status}`).slice(0, 300));
}

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const valueOf = (m: any) => num(m?.values?.[0]?.value ?? m?.total_value?.value);

// Pede as métricas juntas; se a Meta recusar a lista (uma métrica não vale para este item), pede uma a uma.
async function metrics(token: string, path: string, names: string[], extra: Record<string, string> = {}) {
  const out: Record<string, number | null> = {};
  const skipped: string[] = [];
  try {
    const js = await ig(token, path, { metric: names.join(","), ...extra });
    for (const m of js.data ?? []) out[m.name] = valueOf(m);
  } catch (e) {
    if (!(e instanceof Fail && e.code === "api")) throw e;
    for (const n of names) {
      try { const js = await ig(token, path, { metric: n, ...extra }); out[n] = valueOf(js.data?.[0]); }
      catch (e2) { if (!(e2 instanceof Fail && e2.code === "api")) throw e2; skipped.push(n); }
    }
  }
  return { out, skipped };
}

const STORY = ["reach", "views", "replies", "shares", "total_interactions", "follows", "profile_visits"];
const NAV: Record<string, string> = { tap_forward: "taps_forward", tap_back: "taps_back", tap_exit: "exits", swipe_forward: "swipes_forward" };
const FEED = ["reach", "views", "saved", "shares", "total_interactions", "follows", "profile_visits"];
const REELS = ["reach", "views", "saved", "shares", "total_interactions", "ig_reels_avg_watch_time"];
const ACCOUNT = ["reach", "views", "accounts_engaged", "total_interactions", "likes", "comments", "shares", "saves", "replies", "profile_links_taps"];

async function refreshToken(c: any) {
  const left = Date.parse(c.token_expires_at ?? 0) - Date.now();
  const age = Date.now() - Date.parse(c.last_refresh_at ?? c.connected_at);
  if (left > 15 * 864e5 || age < 864e5) return c.access_token as string;
  const js = await ig(c.access_token, "https://graph.instagram.com/refresh_access_token", { grant_type: "ig_refresh_token" });
  const token = String(js.access_token);
  await sb.from("instagram_connections").update({
    access_token: token, token_expires_at: new Date(Date.now() + (Number(js.expires_in) || 5184000) * 1000).toISOString(), last_refresh_at: new Date().toISOString(),
  }).eq("affiliate_email", c.affiliate_email);
  return token;
}

async function syncStories(email: string, token: string) {
  const now = new Date().toISOString();
  const list = await ig(token, "me/stories", { fields: "id,media_type,caption,permalink,timestamp", limit: "100" });
  const live: any[] = list.data ?? [];
  for (const s of live) {
    let note: string | null = null;
    const { out, skipped } = await metrics(token, `${s.id}/insights`, STORY);
    if (skipped.length === STORY.length) note = "A Meta ainda não mostra as métricas deste story (menos de 5 contas viram).";
    else if (skipped.length) note = "A Meta não entregou: " + skipped.join(", ") + ".";
    try {
      const js = await ig(token, `${s.id}/insights`, { metric: "navigation", breakdown: "story_navigation_action_type" });
      for (const r of js.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? []) {
        const col = NAV[String(r.dimension_values?.[0] ?? "").toLowerCase()];
        if (col) out[col] = num(r.value);
      }
    } catch (e) { if (!(e instanceof Fail && e.code === "api")) throw e; }
    const posted = s.timestamp ? new Date(s.timestamp) : new Date();
    const { error } = await sb.from("instagram_stories").upsert({
      id: String(s.id), affiliate_email: email, media_type: s.media_type ?? null, caption: String(s.caption ?? "").slice(0, 2200) || null,
      permalink: s.permalink ?? null, posted_at: posted.toISOString(), expires_at: new Date(posted.getTime() + 864e5).toISOString(),
      reach: out.reach ?? null, views: out.views ?? null, replies: out.replies ?? null, shares: out.shares ?? null,
      total_interactions: out.total_interactions ?? null, follows: out.follows ?? null, profile_visits: out.profile_visits ?? null,
      taps_forward: out.taps_forward ?? null, taps_back: out.taps_back ?? null, exits: out.exits ?? null, swipes_forward: out.swipes_forward ?? null,
      mentions_flow: FLOW_RE.test(String(s.caption ?? "")), insights_note: note, insights_at: now, final: false,
    }, { onConflict: "id" });
    if (error) throw error;
  }
  let q = sb.from("instagram_stories").update({ final: true }).eq("affiliate_email", email).eq("final", false);
  if (live.length) q = q.not("id", "in", `(${live.map((s) => String(s.id)).join(",")})`);
  await q;
  return live.length;
}

async function syncFull(c: any, token: string) {
  const email = c.affiliate_email, now = new Date().toISOString();
  // Perfil e foto do dia
  const u = await ig(token, "me", { fields: "user_id,username,name,profile_picture_url,followers_count,follows_count,media_count" });
  await sb.from("instagram_accounts").update({
    username: u.username ?? null, name: u.name ?? null, profile_picture_url: u.profile_picture_url ?? null,
    followers_count: num(u.followers_count), follows_count: num(u.follows_count), media_count: num(u.media_count),
    source: "oauth", fetched_at: now, error: null,
  }).eq("affiliate_email", email);
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  await sb.from("instagram_snapshots").upsert({ affiliate_email: email, day, followers_count: num(u.followers_count), media_count: num(u.media_count), taken_at: now },
    { onConflict: "affiliate_email,day" });

  // Posts e reels: métricas privadas dos últimos 90 dias (os mais antigos ficam com os números públicos).
  const media: any[] = [];
  let next: string | null = "me/media";
  let params: Record<string, string> = { fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url", limit: "50" };
  const pages = c.last_full_at ? 1 : 3;
  for (let p = 0; next && p < pages; p++) {
    const js: any = await ig(token, next, params);
    media.push(...(js.data ?? []));
    next = js.paging?.next ?? null;
    params = {};
  }
  for (const m of media) {
    const row: Record<string, unknown> = {
      id: String(m.id), affiliate_email: email, username: u.username ?? null, media_type: m.media_type ?? null, media_product_type: m.media_product_type ?? null,
      caption: String(m.caption ?? "").slice(0, 3000) || null, permalink: m.permalink ?? null, posted_at: m.timestamp ?? null,
      like_count: num(m.like_count), comments_count: num(m.comments_count), thumbnail_url: m.thumbnail_url ?? m.media_url ?? null,
      source: "oauth", fetched_at: now,
    };
    if (Date.now() - Date.parse(m.timestamp) < 90 * 864e5) {
      const { out } = await metrics(token, `${m.id}/insights`, m.media_product_type === "REELS" ? REELS : FEED);
      Object.assign(row, {
        reach: out.reach ?? null, view_count: out.views ?? null, saved: out.saved ?? null, shares: out.shares ?? null,
        total_interactions: out.total_interactions ?? null, avg_watch_ms: out.ig_reels_avg_watch_time ?? null, insights_at: now,
      });
    }
    const { error } = await sb.from("instagram_media").upsert(row, { onConflict: "id" });
    if (error) throw error;
  }

  // Resumo diário da conta (30 dias na primeira vez, depois os últimos 3)
  const days = c.last_full_at ? 3 : 30;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const rows: any[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d0 = new Date(today.getTime() - i * 864e5), d1 = new Date(d0.getTime() + 864e5);
    const { out } = await metrics(token, "me/insights", ACCOUNT, { period: "day", metric_type: "total_value", since: String(d0.getTime() / 1000), until: String(d1.getTime() / 1000) });
    rows.push({ affiliate_email: email, day: d0.toISOString().slice(0, 10), ...out, fetched_at: now });
  }
  try {
    const js = await ig(token, "me/insights", { metric: "follower_count", period: "day", since: String(Math.floor((today.getTime() - Math.min(days, 30) * 864e5) / 1000)), until: String(today.getTime() / 1000) });
    for (const v of js.data?.[0]?.values ?? []) {
      const key = new Date(Date.parse(String(v.end_time ?? "").slice(0, 10)) - 864e5).toISOString().slice(0, 10);
      const r = rows.find((x) => x.day === key);
      if (r) r.new_followers = num(v.value);
    }
  } catch (e) { if (!(e instanceof Fail && e.code === "api")) throw e; }
  if (rows.length) {
    const { error } = await sb.from("instagram_account_daily").upsert(rows, { onConflict: "affiliate_email,day" });
    if (error) throw error;
  }

  // Público (só aparece com 100+ seguidores)
  for (const b of ["city", "country", "age", "gender"]) {
    let js: any = null;
    try { js = await ig(token, "me/insights", { metric: "follower_demographics", period: "lifetime", metric_type: "total_value", breakdown: b }); }
    catch (e) {
      if (!(e instanceof Fail && e.code === "api")) throw e;
      try { js = await ig(token, "me/insights", { metric: "follower_demographics", period: "lifetime", metric_type: "total_value", breakdown: b, timeframe: "this_month" }); }
      catch (e2) { if (!(e2 instanceof Fail && e2.code === "api")) throw e2; }
    }
    const results = js?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
    if (!results.length) continue;
    const top = results.map((r: any) => ({ affiliate_email: email, breakdown: b, key: String(r.dimension_values?.[0] ?? ""), value: num(r.value), fetched_at: now }))
      .filter((r: any) => r.key).sort((x: any, y: any) => (y.value ?? 0) - (x.value ?? 0)).slice(0, 50);
    await sb.from("instagram_audience").delete().eq("affiliate_email", email).eq("breakdown", b);
    await sb.from("instagram_audience").insert(top);
  }
  return media.length;
}

async function caller(req: Request): Promise<boolean> {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) { const { data } = await sb.rpc("verify_sync_secret", { secret: cronSecret }); return data === true; }
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  if (jwt === SERVICE_KEY) return true; // a ig-connect pede a primeira leitura logo após conectar
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
  let q = sb.from("instagram_connections").select("*");
  if (only) q = q.eq("affiliate_email", only);
  const { data: conns, error } = await q;
  if (error) return json({ ok: false, error: error.message }, 500);
  const result: Record<string, unknown> = {};
  let stories = 0, media = 0;
  for (const c of conns ?? []) {
    if (Date.now() - started > 120_000) { result[c.affiliate_email] = "tempo esgotado nesta rodada"; continue; }
    try {
      const token = await refreshToken(c);
      stories += await syncStories(c.affiliate_email, token);
      const due = body?.full === true || !c.last_full_at || Date.now() - Date.parse(c.last_full_at) > FULL_EVERY_MS;
      const patch: Record<string, unknown> = { last_sync_at: new Date().toISOString(), status: "ok", error: null };
      if (due) { media += await syncFull(c, token); patch.last_full_at = new Date().toISOString(); }
      await sb.from("instagram_connections").update(patch).eq("affiliate_email", c.affiliate_email);
      result[c.affiliate_email] = "ok";
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      const status = e instanceof Fail && e.code === "token" ? "expired" : "error";
      await sb.from("instagram_connections").update({ status, error: msg, last_sync_at: new Date().toISOString() }).eq("affiliate_email", c.affiliate_email);
      result[c.affiliate_email] = msg;
    }
  }
  const out = { ok: true, connections: (conns ?? []).length, stories, media, result, seconds: Math.round((Date.now() - started) / 1000) };
  if (!only) await sb.from("sync_state").upsert({ key: "ig_partners_last_run", value: { at: new Date().toISOString(), ...out }, updated_at: new Date().toISOString() });
  return json(out);
});
