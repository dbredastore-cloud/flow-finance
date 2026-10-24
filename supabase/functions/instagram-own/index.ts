// Lê o Instagram da Flow (@useaflow) pela Graph API (login com Facebook): todos os posts e reels com as métricas,
// os comentários e o resumo diário da conta. Os stories ficam com a função instagram-stories (de hora em hora).
//
// Grava em ig_media, ig_comments e ig_account_daily. Chamado pelo pg_cron a cada 6 h (header x-cron-secret) ou pelo
// painel (JWT de alguém da equipe). Corpo opcional: { days: N } para reler o resumo diário dos últimos N dias (padrão:
// 30 na primeira vez, 3 depois).
//
// Secrets (Supabase → Edge Functions → Secrets), os mesmos do instagram-sync e do instagram-stories:
//   IG_ACCESS_TOKEN, IG_BUSINESS_ID, IG_GRAPH_VERSION (opcional; padrão v25.0)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

class Fail extends Error { code: string; constructor(code: string, m: string) { super(m); this.code = code; } }

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
function config() {
  const token = env("IG_ACCESS_TOKEN"), id = env("IG_BUSINESS_ID");
  if (!token || !id) throw new Fail("no_config", "Instagram ainda não configurado: faltam os secrets IG_ACCESS_TOKEN e IG_BUSINESS_ID no Supabase.");
  return { token, id, ver: env("IG_GRAPH_VERSION") || "v25.0" };
}
type Cfg = ReturnType<typeof config>;

async function graph(cfg: Cfg, path: string, params: Record<string, string> = {}) {
  const url = new URL(path.startsWith("http") ? path : `https://graph.facebook.com/${cfg.ver}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", cfg.token);
  const r = await fetch(url);
  const js = await r.json().catch(() => ({}));
  if (r.ok) return js;
  const err = js?.error ?? {};
  if (err.code === 190) throw new Fail("token", "O token do Instagram expirou ou foi revogado. Gere um novo e atualize o secret IG_ACCESS_TOKEN.");
  if ([4, 17, 32, 613].includes(err.code)) throw new Fail("rate", "Limite de chamadas da API do Instagram atingido. Tenta de novo na próxima rodada.");
  throw new Fail("api", String(err.error_user_msg || err.message || `HTTP ${r.status}`).slice(0, 300));
}

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const valueOf = (m: any) => num(m?.values?.[0]?.value ?? m?.total_value?.value);

// Pede as métricas juntas; se a Meta recusar a lista (uma métrica não vale para este item ou versão), pede uma a uma.
async function metrics(cfg: Cfg, path: string, names: string[], extra: Record<string, string> = {}) {
  const out: Record<string, number | null> = {};
  const skipped: string[] = [];
  try {
    const js = await graph(cfg, path, { metric: names.join(","), ...extra });
    for (const m of js.data ?? []) out[m.name] = valueOf(m);
  } catch (e) {
    if (!(e instanceof Fail && e.code === "api")) throw e;
    for (const n of names) {
      try { const js = await graph(cfg, path, { metric: n, ...extra }); out[n] = valueOf(js.data?.[0]); }
      catch (e2) { if (!(e2 instanceof Fail && e2.code === "api")) throw e2; skipped.push(n); }
    }
  }
  return { out, skipped };
}

const FEED = ["reach", "views", "saved", "shares", "total_interactions", "follows", "profile_visits", "profile_activity"];
const REELS = ["reach", "views", "saved", "shares", "total_interactions", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time", "reels_skip_rate"];
const ACCOUNT = ["reach", "views", "accounts_engaged", "total_interactions", "likes", "comments", "shares", "saves", "replies", "profile_links_taps"];

async function syncMedia(cfg: Cfg, notes: string[]) {
  const fields = "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count";
  const all: any[] = [];
  let next: string | null = `${cfg.id}/media`;
  let params: Record<string, string> = { fields, limit: "50" };
  for (let page = 0; next && page < 20; page++) {
    const js: any = await graph(cfg, next, params);
    all.push(...(js.data ?? []));
    next = js.paging?.next ?? null;
    params = {}; // o link "next" já traz os parâmetros
  }
  const now = new Date().toISOString();
  const skippedAll = new Set<string>();
  let comments = 0, commentsBlocked = false;
  for (const m of all) {
    const reels = m.media_product_type === "REELS";
    const { out, skipped } = await metrics(cfg, `${m.id}/insights`, reels ? REELS : FEED);
    skipped.forEach((s) => skippedAll.add(s));
    const skip = out.reels_skip_rate;
    const { error } = await sb.from("ig_media").upsert({
      id: String(m.id), media_type: m.media_type ?? null, media_product_type: m.media_product_type ?? null,
      caption: String(m.caption ?? "").slice(0, 3000) || null, permalink: m.permalink ?? null,
      thumbnail_url: m.thumbnail_url ?? m.media_url ?? null, posted_at: m.timestamp ?? null,
      like_count: num(m.like_count), comments_count: num(m.comments_count),
      reach: out.reach ?? null, views: out.views ?? null, saved: out.saved ?? null, shares: out.shares ?? null,
      total_interactions: out.total_interactions ?? null, follows: out.follows ?? null,
      profile_visits: out.profile_visits ?? null, profile_activity: out.profile_activity ?? null,
      avg_watch_ms: out.ig_reels_avg_watch_time ?? null, total_watch_ms: out.ig_reels_video_view_total_time ?? null,
      // A Meta devolve a taxa de pulos em % (0–100) em algumas versões e em fração (0–1) em outras.
      skip_rate: skip == null ? null : (skip > 1 ? skip / 100 : skip),
      insights_note: skipped.length ? "A Meta não entregou: " + skipped.join(", ") + "." : null,
      insights_at: now, fetched_at: now,
    }, { onConflict: "id" });
    if (error) throw error;

    if (!commentsBlocked && Number(m.comments_count) > 0) {
      try {
        const js = await graph(cfg, `${m.id}/comments`, {
          fields: "id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}", limit: "100",
        });
        const rows: any[] = [];
        for (const c of js.data ?? []) {
          rows.push({ id: String(c.id), media_id: String(m.id), parent_id: null, username: c.username ?? null, text: c.text ?? null, like_count: num(c.like_count), posted_at: c.timestamp ?? null, fetched_at: now });
          for (const r of c.replies?.data ?? []) {
            rows.push({ id: String(r.id), media_id: String(m.id), parent_id: String(c.id), username: r.username ?? null, text: r.text ?? null, like_count: num(r.like_count), posted_at: r.timestamp ?? null, fetched_at: now });
          }
        }
        if (rows.length) {
          const { error: ec } = await sb.from("ig_comments").upsert(rows, { onConflict: "id" });
          if (ec) throw ec;
          comments += rows.length;
        }
      } catch (e) {
        if (!(e instanceof Fail && e.code === "api")) throw e;
        // Sem a permissão de comentários no token, para de tentar nesta rodada.
        commentsBlocked = true;
        notes.push("Comentários: " + e.message);
      }
    }
  }
  if (skippedAll.size) notes.push("Métricas de mídia que a Meta não entregou: " + [...skippedAll].join(", ") + ".");
  return { media: all.length, comments };
}

async function syncAccount(cfg: Cfg, days: number, notes: string[]) {
  const u = await graph(cfg, cfg.id, { fields: "followers_count,media_count" });
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const dayStr = (d: Date) => d.toISOString().slice(0, 10);
  const rows: Record<string, any> = {};
  const skippedAll = new Set<string>();
  for (let i = days - 1; i >= 0; i--) {
    const d0 = new Date(today.getTime() - i * 864e5), d1 = new Date(d0.getTime() + 864e5);
    const { out, skipped } = await metrics(cfg, `${cfg.id}/insights`, ACCOUNT, {
      period: "day", metric_type: "total_value", since: String(d0.getTime() / 1000), until: String(d1.getTime() / 1000),
    });
    skipped.forEach((s) => skippedAll.add(s));
    rows[dayStr(d0)] = { day: dayStr(d0), ...out };
  }
  // Novos seguidores por dia (a Meta só dá os últimos 30 dias, sem o dia de hoje).
  try {
    const since = Math.floor((today.getTime() - Math.min(days, 30) * 864e5) / 1000);
    const js = await graph(cfg, `${cfg.id}/insights`, { metric: "follower_count", period: "day", since: String(since), until: String(today.getTime() / 1000) });
    for (const v of js.data?.[0]?.values ?? []) {
      const d = String(v.end_time ?? "").slice(0, 10);
      const key = d ? dayStr(new Date(Date.parse(d) - 864e5)) : "";
      if (rows[key]) rows[key].follower_count = num(v.value);
    }
  } catch (e) {
    if (!(e instanceof Fail && e.code === "api")) throw e;
    notes.push("Novos seguidores: " + e.message);
  }
  const now = new Date().toISOString();
  const list = Object.values(rows).map((r: any) => ({
    day: r.day, reach: r.reach ?? null, views: r.views ?? null, accounts_engaged: r.accounts_engaged ?? null,
    total_interactions: r.total_interactions ?? null, likes: r.likes ?? null, comments: r.comments ?? null,
    shares: r.shares ?? null, saves: r.saves ?? null, replies: r.replies ?? null, profile_links_taps: r.profile_links_taps ?? null,
    new_followers: r.follower_count ?? null, fetched_at: now,
  }));
  const { error } = await sb.from("ig_account_daily").upsert(list, { onConflict: "day" });
  if (error) throw error;
  // Seguidores e nº de posts são a foto de agora: ficam no dia de hoje.
  await sb.from("ig_account_daily").update({ followers_count: num(u.followers_count), media_count: num(u.media_count) }).eq("day", dayStr(today));
  if (skippedAll.size) notes.push("Métricas da conta que a Meta não entregou: " + [...skippedAll].join(", ") + ".");
  return { days: list.length, followers: num(u.followers_count) };
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
  const started = Date.now();
  let result: Record<string, unknown>;
  try {
    const cfg = config();
    const { count } = await sb.from("ig_account_daily").select("day", { count: "exact", head: true });
    const days = Math.max(1, Math.min(Number(body?.days) || (count ? 3 : 30), 90));
    const notes: string[] = [];
    const media = await syncMedia(cfg, notes);
    const account = await syncAccount(cfg, days, notes);
    result = { ok: true, ...media, ...account, notes, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    result = { ok: false, code: e instanceof Fail ? e.code : "internal", error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  await sb.from("sync_state").upsert({ key: "instagram_own_last_run", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() });
  return json(result, result.ok ? 200 : (result.code === "no_config" ? 200 : 500));
});
