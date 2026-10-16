// Atualiza canais e vídeos do YouTube dos influencers que têm o link do canal
// cadastrado no painel (affiliates.youtube) e dos Canais favoritos (yt_favorites).
// Ações extras do painel: fav_add (favoritar pelo link) e fav_sync (atualizar um favorito).
//
// Chamado pelo pg_cron (header x-cron-secret) ou pelo botão "Atualizar YouTube"
// do painel (JWT de usuário logado). Custo por canal ≈ 5 unidades da cota diária
// da YouTube Data API (10.000/dia).
//
// Secret necessário (Supabase → Edge Functions → Secrets): YOUTUBE_API_KEY
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const YT = "https://www.googleapis.com/youtube/v3";
const VIDEOS_PER_CHANNEL = 100;
const SHORT_MAX_S = 180; // Shorts têm no máximo 3 min; acima disso nem precisa checar

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

async function yt(path: string, params: Record<string, string | number>) {
  const key = (Deno.env.get("YOUTUBE_API_KEY") ?? "").trim();
  if (!key) throw new Error("Secret YOUTUBE_API_KEY não configurado no Supabase.");
  const url = new URL(YT + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("key", key);
  const r = await fetch(url);
  const js = await r.json();
  if (!r.ok) throw new Error(`YouTube ${path} → ${r.status}: ${js?.error?.message ?? ""}`.slice(0, 300));
  return js;
}

// Aceita /channel/UC…, /@handle (com sufixos como /videos), /user/nome, /c/nome ou só @handle.
function parseChannelRef(raw: string): { id?: string; handle?: string; user?: string; custom?: string } | null {
  let s = raw.trim();
  try { s = decodeURIComponent(s); } catch { /* mantém como veio */ }
  let m = s.match(/\/channel\/(UC[\w-]{20,})/);
  if (m) return { id: m[1] };
  m = s.match(/@([^/?#\s]+)/);
  if (m) return { handle: m[1] };
  m = s.match(/\/user\/([^/?#\s]+)/);
  if (m) return { user: m[1] };
  m = s.match(/\/c\/([^/?#\s]+)/);
  if (m) return { custom: m[1] };
  m = s.match(/^(UC[\w-]{20,})$/);
  if (m) return { id: m[1] };
  if (/^[\w.\-À-ÿ]+$/.test(s)) return { handle: s };
  return null;
}

async function resolveChannelId(url: string): Promise<string> {
  const ref = parseChannelRef(url);
  if (!ref) throw new Error("Link do canal não reconhecido");
  if (ref.id) return ref.id;
  let js;
  if (ref.handle) js = await yt("/channels", { part: "id", forHandle: "@" + ref.handle });
  else if (ref.user) js = await yt("/channels", { part: "id", forUsername: ref.user });
  else js = await yt("/search", { part: "snippet", type: "channel", q: ref.custom!, maxResults: 1 });
  const id = js.items?.[0]?.id?.channelId ?? js.items?.[0]?.id;
  if (!id || typeof id !== "string") throw new Error("Canal não encontrado no YouTube");
  return id;
}

// ISO 8601 (PT1H2M3S) → segundos
function durationSeconds(iso: string | undefined) {
  const m = (iso ?? "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const [, d, h, mi, s] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + mi * 60 + s;
}
const num = (v: unknown) => (v == null ? null : Number(v));

// A API não informa se o vídeo é Short. youtube.com/shorts/ID responde 200 para
// Shorts e redireciona (303) para /watch nos demais. Sem resposta clara, fica null
// e o painel cai na regra da duração.
async function checkShort(id: string): Promise<boolean | null> {
  try {
    const r = await fetch(`https://www.youtube.com/shorts/${id}`, { method: "HEAD", redirect: "manual" });
    await r.body?.cancel();
    if (r.status === 200) return true;
    if (r.status >= 300 && r.status < 400) return false;
  } catch { /* rede */ }
  return null;
}

async function classifyShorts(rows: { video_id: string; duration_s: number | null; is_short?: boolean | null }[]) {
  const ids = rows.map((r) => r.video_id);
  const { data } = await sb.from("youtube_videos").select("video_id, is_short").in("video_id", ids);
  const known = new Map((data ?? []).filter((r) => r.is_short != null).map((r) => [r.video_id, r.is_short]));
  const pending: typeof rows = [];
  for (const r of rows) {
    if (known.has(r.video_id)) r.is_short = known.get(r.video_id);
    else if (r.duration_s != null && r.duration_s > SHORT_MAX_S) r.is_short = false;
    else pending.push(r);
  }
  for (let i = 0; i < pending.length; i += 10) {
    await Promise.all(pending.slice(i, i + 10).map(async (r) => { r.is_short = await checkShort(r.video_id); }));
  }
}
const bestThumb = (t: any) => t?.medium?.url ?? t?.high?.url ?? t?.default?.url ?? null;

// Busca mais antiga: `since` (YYYY-MM-DD) faz o sync voltar até essa data (máx. MAX_DEEP vídeos),
// usado pelo botão "Buscar histórico do contrato" do dashboard do influencer.
const MAX_DEEP = 500;
type SyncOpts = { since?: string };

async function syncChannel(email: string, url: string, known: any, opts: SyncOpts = {}) {
  const channelId = known?.input_url === url && known?.channel_id ? known.channel_id : await resolveChannelId(url);
  const { meta, videos } = await syncById(channelId, opts);
  const { error } = await sb.from("youtube_channels").upsert({ affiliate_email: email, input_url: url, ...meta }, { onConflict: "affiliate_email" });
  if (error) throw error;
  return videos;
}

// Lê o canal, grava a foto do dia e os vídeos (youtube_videos). Devolve os dados do canal para quem chamou gravar.
async function syncById(channelId: string, opts: SyncOpts = {}) {
  const now = new Date().toISOString();
  const ch = (await yt("/channels", { part: "snippet,statistics,contentDetails,brandingSettings", id: channelId })).items?.[0];
  if (!ch) throw new Error("Canal não encontrado no YouTube");
  const st = ch.statistics ?? {};
  const row = {
    channel_id: channelId,
    title: ch.snippet?.title ?? null, handle: ch.snippet?.customUrl ?? null,
    thumbnail_url: bestThumb(ch.snippet?.thumbnails), country: ch.snippet?.country ?? null,
    channel_created: ch.snippet?.publishedAt ?? null,
    subscribers: st.hiddenSubscriberCount ? null : num(st.subscriberCount), hidden_subs: !!st.hiddenSubscriberCount,
    total_views: num(st.viewCount), video_count: num(st.videoCount), fetched_at: now, error: null,
    description: String(ch.snippet?.description ?? "").slice(0, 2000) || null,
    banner_url: ch.brandingSettings?.image?.bannerExternalUrl ?? null,
    keywords: String(ch.brandingSettings?.channel?.keywords ?? "").slice(0, 500) || null,
  };

  // Foto do dia (fuso de Brasília): permite mostrar o crescimento do canal durante o contrato.
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  await sb.from("youtube_channel_snapshots").upsert(
    { channel_id: channelId, day, subscribers: row.subscribers, total_views: row.total_views, video_count: row.video_count, taken_at: now },
    { onConflict: "channel_id,day" },
  );

  const sinceMs = opts.since ? Date.parse(opts.since + "T00:00:00-03:00") : NaN;
  const limit = Number.isFinite(sinceMs) ? MAX_DEEP : VIDEOS_PER_CHANNEL;
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  let videos = 0;
  if (uploads) {
    const ids: string[] = [];
    let pageToken = "";
    while (ids.length < limit) {
      const params: Record<string, string | number> = { part: "contentDetails", playlistId: uploads, maxResults: 50 };
      if (pageToken) params.pageToken = pageToken;
      const pl = await yt("/playlistItems", params)
        .catch((e) => (String(e).includes("404") ? { items: [] } : Promise.reject(e)));
      ids.push(...(pl.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean));
      pageToken = pl.nextPageToken ?? "";
      if (!pageToken) break;
      // A lista vem do mais novo para o mais antigo: para quando já passou da data pedida.
      const lastAt = Date.parse((pl.items ?? []).at(-1)?.contentDetails?.videoPublishedAt ?? "");
      if (Number.isFinite(sinceMs) && Number.isFinite(lastAt) && lastAt < sinceMs) break;
    }
    ids.splice(limit);
    if (ids.length) {
      const items: any[] = [];
      for (let i = 0; i < ids.length; i += 50) {
        const vs = await yt("/videos", { part: "snippet,statistics,contentDetails", id: ids.slice(i, i + 50).join(","), maxResults: 50 });
        items.push(...(vs.items ?? []));
      }
      const rows = items.map((v: any) => ({
        video_id: v.id, channel_id: channelId, title: v.snippet?.title ?? null,
        published_at: v.snippet?.publishedAt ?? null, duration_s: durationSeconds(v.contentDetails?.duration),
        views: num(v.statistics?.viewCount), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount),
        thumbnail_url: bestThumb(v.snippet?.thumbnails), fetched_at: now, is_short: null as boolean | null,
        description: String(v.snippet?.description ?? "").slice(0, 3000) || null,
        tags: Array.isArray(v.snippet?.tags) ? v.snippet.tags.slice(0, 30).map((t: unknown) => String(t).slice(0, 60)) : null,
      }));
      await classifyShorts(rows);
      if (rows.length) {
        const { error } = await sb.from("youtube_videos").upsert(rows, { onConflict: "video_id" });
        if (error) throw error;
      }
      videos = rows.length;
    }
  }
  return { meta: row, videos };
}

/* ---------------- Canais favoritos (menu Afiliados → Canais favoritos) ---------------- */
// Ao favoritar, volta 12 meses (ou até a data do acesso, se for mais antiga) para mostrar se o canal já
// falava da Flow antes da liberação.
function favSince(accessAt: string | null) {
  const year = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  return accessAt && accessAt < year ? accessAt : year;
}
const FAV_COLS = ["channel_id", "title", "handle", "thumbnail_url", "banner_url", "country", "description", "channel_created",
  "subscribers", "hidden_subs", "total_views", "video_count", "fetched_at", "error"] as const;
function favMeta(meta: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of FAV_COLS) if (k in meta) out[k] = meta[k];
  return out;
}

async function syncFavorite(channelId: string, opts: SyncOpts = {}) {
  try {
    const { meta, videos } = await syncById(channelId, opts);
    const { error } = await sb.from("yt_favorites").update(favMeta(meta)).eq("channel_id", channelId);
    if (error) throw error;
    return videos;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (!msg.includes("YOUTUBE_API_KEY")) await sb.from("yt_favorites").update({ error: msg.slice(0, 300), fetched_at: new Date().toISOString() }).eq("channel_id", channelId);
    throw e;
  }
}

// Favoritar pelo link, @usuario ou ID do canal (o painel também grava a estrela direto na tabela e chama fav_sync).
async function favAdd(body: any, userId: string | null) {
  const ref = String(body.ref ?? "").trim().slice(0, 300);
  if (!ref) throw new Error("Cole o link do canal, o @usuario ou o ID.");
  const channelId = await resolveChannelId(ref);
  const accessAt = typeof body.access_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.access_at) ? body.access_at : null;
  const { data: existing } = await sb.from("yt_favorites").select("channel_id, access_at").eq("channel_id", channelId).maybeSingle();
  if (!existing) {
    const { error } = await sb.from("yt_favorites").insert({ channel_id: channelId, source: "manual", access_at: accessAt, added_by: userId });
    if (error) throw error;
  } else if (accessAt && !existing.access_at) {
    await sb.from("yt_favorites").update({ access_at: accessAt }).eq("channel_id", channelId);
  }
  const videos = await syncFavorite(channelId, { since: favSince(accessAt ?? existing?.access_at ?? null) });
  return { ok: true, channelId, existed: !!existing, videos };
}

async function favSync(body: any) {
  const id = String(body.channelId ?? "");
  if (!/^UC[\w-]{20,24}$/.test(id)) throw new Error("Canal inválido.");
  const { data: fav } = await sb.from("yt_favorites").select("channel_id, access_at").eq("channel_id", id).maybeSingle();
  if (!fav) throw new Error("Canal não está nos favoritos.");
  const videos = await syncFavorite(id, body.deep ? { since: favSince(fav.access_at) } : {});
  return { ok: true, channelId: id, videos };
}

// Rodada do cron: todos os favoritos (cerca de 3 unidades da cota por canal).
async function syncAllFavorites() {
  const { data } = await sb.from("yt_favorites").select("channel_id, fetched_at");
  let ok = 0, videos = 0;
  const errors: Record<string, string> = {};
  for (const f of data ?? []) {
    try {
      // Favorito novo que ainda não foi lido: já busca o histórico.
      videos += await syncFavorite(f.channel_id, f.fetched_at ? {} : { since: favSince(null) });
      ok++;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes("YOUTUBE_API_KEY")) throw e;
      errors[f.channel_id] = msg;
    }
  }
  return { ok, videos, failed: Object.keys(errors).length, errors };
}

// Quem pode mexer nos favoritos: perfil admin ou com algum destes menus.
async function canFavorite(userId: string) {
  const { data } = await sb.from("app_admins").select("role, menus").eq("user_id", userId).maybeSingle();
  if (!data) return false;
  return data.role === "admin" || (data.menus ?? []).some((m: string) => ["af.favoritos", "af.youtube", "af.mercado"].includes(m));
}

// null = sem permissão; "cron" = pg_cron; senão o id do usuário do painel.
async function caller(req: Request): Promise<string | null> {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    const { data } = await sb.rpc("verify_sync_secret", { secret: cronSecret });
    return data === true ? "cron" : null;
  }
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) return null;
  // Só a equipe (app_admins) pode disparar a sincronização pelo painel.
  const { data: admin } = await sb.from("app_admins").select("user_id").eq("user_id", data.user.id).maybeSingle();
  return admin ? data.user.id : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  const who = await caller(req);
  if (!who) return json({ error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* corpo vazio (cron) */ }

  // Canais favoritos: { action: "fav_add", ref, access_at? } ou { action: "fav_sync", channelId, deep? }.
  if (body?.action === "fav_add" || body?.action === "fav_sync") {
    if (who !== "cron" && !(await canFavorite(who))) return json({ ok: false, error: "Sem acesso aos canais favoritos." }, 403);
    try {
      return json(body.action === "fav_add" ? await favAdd(body, who === "cron" ? null : who) : await favSync(body));
    } catch (e) {
      return json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  // { email, since } = atualizar só um influencer, voltando até a data (histórico do contrato).
  const only = typeof body?.email === "string" && body.email ? body.email.toLowerCase() : null;
  const opts: SyncOpts = typeof body?.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.since) ? { since: body.since } : {};

  const started = Date.now();
  let result: Record<string, unknown>;
  try {
    const { data: affs, error } = await sb.from("affiliates").select("email, youtube").not("youtube", "is", null);
    if (error) throw error;
    const all = (affs ?? []).filter((a) => (a.youtube ?? "").trim());
    const wanted = only ? all.filter((a) => a.email.toLowerCase() === only) : all;
    const { data: existing } = await sb.from("youtube_channels").select("affiliate_email, input_url, channel_id");
    const known = new Map((existing ?? []).map((c) => [c.affiliate_email, c]));

    // Link apagado no painel → canal sai do painel do YouTube.
    if (!only) {
      const keep = new Set(all.map((a) => a.email));
      const stale = [...known.keys()].filter((e) => !keep.has(e));
      if (stale.length) await sb.from("youtube_channels").delete().in("affiliate_email", stale);
    }

    let ok = 0, videos = 0;
    const errors: Record<string, string> = {};
    for (const a of wanted) {
      const url = a.youtube.trim();
      try {
        videos += await syncChannel(a.email, url, known.get(a.email), opts);
        ok++;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (msg.includes("YOUTUBE_API_KEY")) throw e;
        errors[a.email] = msg;
        await sb.from("youtube_channels").upsert(
          { affiliate_email: a.email, input_url: url, error: msg, fetched_at: new Date().toISOString() },
          { onConflict: "affiliate_email" },
        );
      }
    }
    let favorites: Record<string, unknown> | undefined;
    if (!only) favorites = await syncAllFavorites();
    result = { ok: true, channels: ok, failed: Object.keys(errors).length, videos, errors, favorites, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    result = { ok: false, error: String((e as Error)?.message ?? e) };
  }
  if (!only) await sb.from("sync_state").upsert({ key: "youtube_last_run", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() });
  return json(result, result.ok ? 200 : 500);
});
