// Tempo assistido do YouTube dos influencers conectados (YouTube Analytics API), com o token de cada um
// (youtube_connections, gravado pela yt-connect). A cada 6 h:
//   · canal por dia (youtube_analytics_daily): views, minutos assistidos, tempo médio, % assistido, inscritos ganhos/perdidos
//     — últimos 35 dias (365 na primeira leitura ou com { full: true });
//   · vídeo desde a publicação (youtube_video_analytics): os mesmos números + curtidas e compartilhamentos;
//   · curva de retenção (youtube_video_retention) dos vídeos dos últimos 180 dias e dos marcados com a Flow, uma vez por dia.
// O YouTube entrega só médias e totais (nunca o tempo de cada espectador), com 2 a 3 dias de atraso.
//
// Chamado pelo pg_cron (x-cron-secret), pela yt-connect logo após conectar (chave de serviço) ou pela equipe (JWT de app_admins).
// Corpo opcional: { email } para um influencer só; { full: true } para ler 365 dias e refazer todas as retenções.
// Secrets: YT_OAUTH_CLIENT_ID, YT_OAUTH_CLIENT_SECRET (os mesmos da yt-connect).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const DAY = 864e5;
const RETENTION_PER_RUN = 15;

class Fail extends Error { code: string; constructor(code: string, m: string) { super(m); this.code = code; } }
const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

async function accessToken(c: any): Promise<string> {
  if (c.access_token && Date.parse(c.access_expires_at ?? 0) - Date.now() > 5 * 60e3) return c.access_token;
  const id = env("YT_OAUTH_CLIENT_ID"), secret = env("YT_OAUTH_CLIENT_SECRET");
  if (!id || !secret) throw new Fail("config", "Faltam os secrets YT_OAUTH_CLIENT_ID e YT_OAUTH_CLIENT_SECRET.");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: c.refresh_token, grant_type: "refresh_token" }),
  });
  const js = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (js?.error === "invalid_grant") throw new Fail("token", "A autorização do YouTube venceu ou foi retirada. O influencer precisa conectar de novo no portal.");
    throw new Fail("api", String(js?.error_description || js?.error || `HTTP ${r.status}`).slice(0, 300));
  }
  const exp = new Date(Date.now() + (Number(js.expires_in) || 3600) * 1000).toISOString();
  await sb.from("youtube_connections").update({ access_token: js.access_token, access_expires_at: exp }).eq("affiliate_email", c.affiliate_email);
  c.access_token = js.access_token; c.access_expires_at = exp;
  return js.access_token;
}

// Relatório do YouTube Analytics → lista de objetos { coluna: valor }.
async function report(token: string, params: Record<string, string>) {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const js = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = String(js?.error?.message || `HTTP ${r.status}`);
    if (r.status === 401) throw new Fail("token", "A autorização do YouTube venceu ou foi retirada. O influencer precisa conectar de novo no portal.");
    if (r.status === 429 || /quota/i.test(msg)) throw new Fail("rate", "Limite de consultas do YouTube Analytics atingido.");
    throw new Fail("api", msg.slice(0, 300));
  }
  const cols: string[] = (js.columnHeaders ?? []).map((h: any) => h.name);
  return (js.rows ?? []).map((row: any[]) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

const METRICS = "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained";

async function syncDaily(c: any, token: string, full: boolean) {
  const rows = await report(token, {
    startDate: ymd(Date.now() - (full ? 365 : 35) * DAY), endDate: ymd(Date.now()),
    metrics: METRICS + ",subscribersLost", dimensions: "day", sort: "day",
  });
  const now = new Date().toISOString();
  const up = rows.map((r: any) => ({
    channel_id: c.channel_id, day: r.day, views: num(r.views), minutes_watched: num(r.estimatedMinutesWatched),
    avg_view_s: num(r.averageViewDuration), avg_view_pct: num(r.averageViewPercentage),
    subs_gained: num(r.subscribersGained), subs_lost: num(r.subscribersLost), fetched_at: now,
  }));
  for (let i = 0; i < up.length; i += 500) {
    const { error } = await sb.from("youtube_analytics_daily").upsert(up.slice(i, i + 500), { onConflict: "channel_id,day" });
    if (error) throw error;
  }
  return up.length;
}

async function syncVideos(c: any, token: string) {
  const { data: vids } = await sb.from("youtube_videos").select("video_id").eq("channel_id", c.channel_id).order("published_at", { ascending: false }).limit(600);
  const ids = (vids ?? []).map((v: any) => v.video_id);
  const base = { startDate: "2005-02-14", endDate: ymd(Date.now()), metrics: METRICS + ",likes,shares", dimensions: "video", sort: "-views", maxResults: "200" };
  const rows: any[] = [];
  if (!ids.length) rows.push(...await report(token, base)); // vídeos ainda não lidos pelo youtube-sync: os 200 mais vistos
  for (let i = 0; i < ids.length; i += 200) rows.push(...await report(token, { ...base, filters: "video==" + ids.slice(i, i + 200).join(",") }));
  const now = new Date().toISOString();
  const up = rows.map((r) => ({
    video_id: r.video, channel_id: c.channel_id, views: num(r.views), minutes_watched: num(r.estimatedMinutesWatched),
    avg_view_s: num(r.averageViewDuration), avg_view_pct: num(r.averageViewPercentage), subs_gained: num(r.subscribersGained),
    likes: num(r.likes), shares: num(r.shares), fetched_at: now,
  }));
  for (let i = 0; i < up.length; i += 500) {
    const { error } = await sb.from("youtube_video_analytics").upsert(up.slice(i, i + 500), { onConflict: "video_id" });
    if (error) throw error;
  }
  return up.length;
}

// Retenção dos vídeos recentes (180 dias) e dos marcados com a Flow; cada vídeo no máximo 1x por dia.
async function syncRetention(c: any, token: string, full: boolean) {
  const since = new Date(Date.now() - 180 * DAY).toISOString();
  const { data: recent } = await sb.from("youtube_videos").select("video_id, published_at").eq("channel_id", c.channel_id).gte("published_at", since);
  const { data: tagged } = await sb.from("content_tool_tags").select("content_id").eq("kind", "youtube").eq("affiliate_email", c.affiliate_email);
  const want = new Set<string>([...(recent ?? []).filter((v: any) => Date.now() - Date.parse(v.published_at) > 2 * DAY).map((v: any) => v.video_id), ...(tagged ?? []).map((t: any) => t.content_id)]);
  if (!want.size) return 0;
  const { data: va } = await sb.from("youtube_video_analytics").select("video_id, views, retention_at").in("video_id", [...want]);
  const due = (va ?? []).filter((v: any) => (v.views ?? 0) > 0 && (full || !v.retention_at || Date.now() - Date.parse(v.retention_at) > DAY))
    .sort((a: any, b: any) => (a.retention_at ? Date.parse(a.retention_at) : 0) - (b.retention_at ? Date.parse(b.retention_at) : 0))
    .slice(0, RETENTION_PER_RUN);
  let n = 0;
  for (const v of due) {
    let rows: any[] = [];
    try {
      rows = await report(token, { startDate: "2005-02-14", endDate: ymd(Date.now()), metrics: "audienceWatchRatio,relativeRetentionPerformance",
        dimensions: "elapsedVideoTimeRatio", filters: `video==${v.video_id}`, sort: "elapsedVideoTimeRatio" });
    } catch (e) { if (!(e instanceof Fail && e.code === "api")) throw e; } // vídeo sem dados suficientes: tenta de novo amanhã
    if (rows.length) {
      await sb.from("youtube_video_retention").delete().eq("video_id", v.video_id);
      const { error } = await sb.from("youtube_video_retention").insert(rows.map((r) => ({
        video_id: v.video_id, x: Math.round(Number(r.elapsedVideoTimeRatio) * 100), watch_ratio: num(r.audienceWatchRatio), rel_perf: num(r.relativeRetentionPerformance),
      })));
      if (error) throw error;
      n++;
    }
    await sb.from("youtube_video_analytics").update({ retention_at: new Date().toISOString() }).eq("video_id", v.video_id);
  }
  return n;
}

async function caller(req: Request): Promise<boolean> {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) { const { data } = await sb.rpc("verify_sync_secret", { secret: cronSecret }); return data === true; }
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  if (jwt === SERVICE_KEY) return true; // a yt-connect pede a primeira leitura logo após conectar
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
  let q = sb.from("youtube_connections").select("*");
  if (only) q = q.eq("affiliate_email", only);
  const { data: conns, error } = await q;
  if (error) return json({ ok: false, error: error.message }, 500);
  const result: Record<string, unknown> = {};
  for (const c of conns ?? []) {
    if (Date.now() - started > 120_000) { result[c.affiliate_email] = "tempo esgotado nesta rodada"; continue; }
    try {
      const full = body?.full === true || !c.last_full_at;
      const token = await accessToken(c);
      const days = await syncDaily(c, token, full);
      const videos = await syncVideos(c, token);
      const retention = await syncRetention(c, token, full);
      const patch: Record<string, unknown> = { last_sync_at: new Date().toISOString(), status: "ok", error: null };
      if (full) patch.last_full_at = patch.last_sync_at;
      await sb.from("youtube_connections").update(patch).eq("affiliate_email", c.affiliate_email);
      result[c.affiliate_email] = { days, videos, retention };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      const status = e instanceof Fail && e.code === "token" ? "expired" : "error";
      await sb.from("youtube_connections").update({ status, error: msg, last_sync_at: new Date().toISOString() }).eq("affiliate_email", c.affiliate_email);
      result[c.affiliate_email] = msg;
    }
  }
  const out = { ok: true, connections: (conns ?? []).length, result, seconds: Math.round((Date.now() - started) / 1000) };
  if (!only) await sb.from("sync_state").upsert({ key: "yt_analytics_last_run", value: { at: new Date().toISOString(), ...out }, updated_at: new Date().toISOString() });
  return json(out);
});
