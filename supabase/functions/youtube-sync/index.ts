// Atualiza canais e vídeos do YouTube dos influencers que têm o link do canal
// cadastrado no painel (affiliates.youtube).
//
// Chamado pelo pg_cron (header x-cron-secret) ou pelo botão "Atualizar YouTube"
// do painel (JWT de usuário logado). Custo por canal ≈ 3 unidades da cota diária
// da YouTube Data API (10.000/dia).
//
// Secret necessário (Supabase → Edge Functions → Secrets): YOUTUBE_API_KEY
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const YT = "https://www.googleapis.com/youtube/v3";
const VIDEOS_PER_CHANNEL = 50;

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
const bestThumb = (t: any) => t?.medium?.url ?? t?.high?.url ?? t?.default?.url ?? null;

async function syncChannel(email: string, url: string, known: any) {
  const now = new Date().toISOString();
  const channelId = known?.input_url === url && known?.channel_id ? known.channel_id : await resolveChannelId(url);

  const ch = (await yt("/channels", { part: "snippet,statistics,contentDetails", id: channelId })).items?.[0];
  if (!ch) throw new Error("Canal não encontrado no YouTube");
  const st = ch.statistics ?? {};
  const row = {
    affiliate_email: email, input_url: url, channel_id: channelId,
    title: ch.snippet?.title ?? null, handle: ch.snippet?.customUrl ?? null,
    thumbnail_url: bestThumb(ch.snippet?.thumbnails), country: ch.snippet?.country ?? null,
    channel_created: ch.snippet?.publishedAt ?? null,
    subscribers: st.hiddenSubscriberCount ? null : num(st.subscriberCount), hidden_subs: !!st.hiddenSubscriberCount,
    total_views: num(st.viewCount), video_count: num(st.videoCount), fetched_at: now, error: null,
  };

  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  let videos = 0;
  if (uploads) {
    const pl = await yt("/playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: VIDEOS_PER_CHANNEL })
      .catch((e) => (String(e).includes("404") ? { items: [] } : Promise.reject(e)));
    const ids = (pl.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean);
    if (ids.length) {
      const vs = await yt("/videos", { part: "snippet,statistics,contentDetails", id: ids.join(","), maxResults: 50 });
      const rows = (vs.items ?? []).map((v: any) => ({
        video_id: v.id, channel_id: channelId, title: v.snippet?.title ?? null,
        published_at: v.snippet?.publishedAt ?? null, duration_s: durationSeconds(v.contentDetails?.duration),
        views: num(v.statistics?.viewCount), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount),
        thumbnail_url: bestThumb(v.snippet?.thumbnails), fetched_at: now,
      }));
      if (rows.length) {
        const { error } = await sb.from("youtube_videos").upsert(rows, { onConflict: "video_id" });
        if (error) throw error;
      }
      videos = rows.length;
    }
  }
  const { error } = await sb.from("youtube_channels").upsert(row, { onConflict: "affiliate_email" });
  if (error) throw error;
  return videos;
}

async function authorized(req: Request) {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    const { data } = await sb.rpc("verify_sync_secret", { secret: cronSecret });
    return data === true;
  }
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data } = await sb.auth.getUser(jwt);
  return !!data?.user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);

  const started = Date.now();
  let result: Record<string, unknown>;
  try {
    const { data: affs, error } = await sb.from("affiliates").select("email, youtube").not("youtube", "is", null);
    if (error) throw error;
    const wanted = (affs ?? []).filter((a) => (a.youtube ?? "").trim());
    const { data: existing } = await sb.from("youtube_channels").select("affiliate_email, input_url, channel_id");
    const known = new Map((existing ?? []).map((c) => [c.affiliate_email, c]));

    // Link apagado no painel → canal sai do painel do YouTube.
    const keep = new Set(wanted.map((a) => a.email));
    const stale = [...known.keys()].filter((e) => !keep.has(e));
    if (stale.length) await sb.from("youtube_channels").delete().in("affiliate_email", stale);

    let ok = 0, videos = 0;
    const errors: Record<string, string> = {};
    for (const a of wanted) {
      const url = a.youtube.trim();
      try {
        videos += await syncChannel(a.email, url, known.get(a.email));
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
    result = { ok: true, channels: ok, failed: Object.keys(errors).length, videos, errors, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    result = { ok: false, error: String((e as Error)?.message ?? e) };
  }
  await sb.from("sync_state").upsert({ key: "youtube_last_run", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() });
  return json(result, result.ok ? 200 : 500);
});
