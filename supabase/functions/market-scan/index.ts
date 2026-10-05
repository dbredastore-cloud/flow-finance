// Rastrear Mercado: varre o YouTube por palavras-chave e analisa os canais que falam do assunto.
//
// Duas fases, orquestradas pelo painel (assim o progresso é real e nenhuma chamada estoura o tempo):
//   discover → busca vídeos por palavra-chave, junta os canais, lê estatísticas e grava a varredura.
//   analyze  → para até 8 canais por chamada, lê os últimos 50 envios e calcula as métricas.
//   finish   → fecha a varredura.
//
// Cota da YouTube Data API (10.000/dia, compartilhada com o youtube-sync):
//   search.list = 100 · channels/playlistItems/videos = 1.
// Há um teto diário só para varreduras de mercado, para não faltar cota ao sync dos influencers.
//
// Secret: YOUTUBE_API_KEY (o mesmo do youtube-sync). Só administradores (app_admins).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { analyzeVideos, buildMatcher, durationSeconds, extractContacts } from "./analysis.js";

const YT = "https://www.googleapis.com/youtube/v3";
const DAILY_CAP = 6000;           // unidades/dia para varreduras de mercado
const MAX_KEYWORDS = 5;
const ANALYZE_BATCH = 8;
const CHANNEL_RE = /^UC[\w-]{20,24}$/;

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

class Fail extends Error {
  code: string;
  constructor(code: string, msg: string) { super(msg); this.code = code; }
}

let spent = 0; // unidades gastas nesta requisição

async function yt(path: string, params: Record<string, string | number>, cost: number) {
  const key = (Deno.env.get("YOUTUBE_API_KEY") ?? "").trim();
  if (!key) throw new Fail("no_key", "Secret YOUTUBE_API_KEY não configurado no Supabase.");
  const url = new URL(YT + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("key", key);
  const r = await fetch(url);
  const js = await r.json().catch(() => ({}));
  if (r.ok) { spent += cost; return js; }
  const reason = js?.error?.errors?.[0]?.reason ?? "";
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "rateLimitExceeded") {
    throw new Fail("quota", "A cota diária da YouTube Data API acabou. Ela renova à meia-noite (horário do Pacífico).");
  }
  throw new Fail("youtube", `YouTube ${path} → ${r.status}: ${js?.error?.message ?? ""}`.slice(0, 300));
}

const bestThumb = (t: any) => t?.medium?.url ?? t?.high?.url ?? t?.default?.url ?? null;
const num = (v: unknown) => (v == null ? null : Number(v));

// Meia-noite no Pacífico (quando a cota do YouTube renova).
function ptMidnight(): Date {
  const now = new Date();
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return new Date(now.getTime() - (((g("hour") % 24) * 3600 + g("minute") * 60 + g("second")) * 1000));
}

async function quotaToday(): Promise<number> {
  const { data } = await sb.from("market_scans").select("quota_units").gte("created_at", ptMidnight().toISOString());
  return (data ?? []).reduce((s, r) => s + (r.quota_units ?? 0), 0);
}

async function addQuota(scanId: string) {
  if (!spent) return;
  const { data } = await sb.from("market_scans").select("quota_units").eq("id", scanId).single();
  await sb.from("market_scans").update({ quota_units: (data?.quota_units ?? 0) + spent }).eq("id", scanId);
}

async function adminUser(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: admin } = await sb.from("app_admins").select("user_id").eq("user_id", data.user.id).maybeSingle();
  return admin ? data.user.id : null;
}

const LANGS: Record<string, { lang: string; region: string }> = {
  pt: { lang: "pt", region: "BR" },
  en: { lang: "en", region: "US" },
  es: { lang: "es", region: "" },
  any: { lang: "", region: "" },
};
const SINCE_DAYS: Record<string, number> = { "90d": 90, "1y": 365, any: 0 };

// ---------------------------------------------------------------- discover
async function discover(body: any, userId: string) {
  const keywords: string[] = [...new Set(
    (Array.isArray(body.keywords) ? body.keywords : [])
      .map((k: unknown) => String(k ?? "").trim().replace(/\s+/g, " ").slice(0, 80))
      .filter(Boolean),
  )].slice(0, MAX_KEYWORDS) as string[];
  if (!keywords.length) throw new Fail("input", "Informe pelo menos uma palavra-chave.");

  const pages = Math.min(3, Math.max(1, Number(body.pages) || 1));
  const maxChannels = Math.min(60, Math.max(5, Number(body.maxChannels) || 25));
  const langKey = LANGS[body.language] ? body.language : "pt";
  const sinceKey = body.since in SINCE_DAYS ? body.since : "1y";
  const { lang, region } = LANGS[langKey];

  const estimate = keywords.length * pages * 100 + Math.ceil(maxChannels / 50) + maxChannels * 2;
  const used = await quotaToday();
  if (used + estimate > DAILY_CAP) {
    throw new Fail("cap", `Teto diário de varreduras atingido: ${used} usados hoje + ${estimate} desta busca passaria de ${DAILY_CAP}. Reduza a profundidade ou tente amanhã.`);
  }

  const { data: scan, error: scanErr } = await sb.from("market_scans").insert({
    created_by: userId, keywords,
    options: { pages, maxChannels, language: langKey, since: sinceKey },
  }).select("id").single();
  if (scanErr) throw scanErr;
  const scanId = scan.id as string;

  try {
    const publishedAfter = SINCE_DAYS[sinceKey] ? new Date(Date.now() - SINCE_DAYS[sinceKey] * 86400000).toISOString() : "";

    // Uma busca por palavra-chave (em paralelo); cada uma percorre até `pages` páginas.
    const perKeyword = await Promise.all(keywords.map(async (q) => {
      const items: any[] = [];
      let pageToken = "";
      for (let p = 0; p < pages; p++) {
        const params: Record<string, string | number> = { part: "snippet", type: "video", q, maxResults: 50, order: "relevance", safeSearch: "none" };
        if (lang) params.relevanceLanguage = lang;
        if (region) params.regionCode = region;
        if (publishedAfter) params.publishedAfter = publishedAfter;
        if (pageToken) params.pageToken = pageToken;
        const js = await yt("/search", params, 100);
        items.push(...(js.items ?? []));
        pageToken = js.nextPageToken ?? "";
        if (!pageToken) break;
      }
      return { q, items };
    }));

    type Cand = { hits: number; kws: Set<string>; videos: { id: string; title: string }[] };
    const cands = new Map<string, Cand>();
    for (const { q, items } of perKeyword) {
      for (const it of items) {
        const cid = it?.snippet?.channelId, vid = it?.id?.videoId;
        if (!cid || !CHANNEL_RE.test(cid)) continue;
        const c = cands.get(cid) ?? { hits: 0, kws: new Set<string>(), videos: [] };
        c.hits++; c.kws.add(q);
        if (vid && c.videos.length < 4) c.videos.push({ id: vid, title: String(it.snippet?.title ?? "").slice(0, 140) });
        cands.set(cid, c);
      }
    }
    const ranked = [...cands.entries()]
      .sort((a, b) => b[1].kws.size - a[1].kws.size || b[1].hits - a[1].hits)
      .slice(0, maxChannels);
    if (!ranked.length) {
      await sb.from("market_scans").update({ status: "done", candidates: 0 }).eq("id", scanId);
      await addQuota(scanId);
      return { ok: true, scanId, channelIds: [], spent, keywords };
    }

    // Estatísticas dos canais (50 por chamada, 1 unidade).
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < ranked.length; i += 50) {
      const slice = ranked.slice(i, i + 50);
      const js = await yt("/channels", { part: "snippet,statistics", id: slice.map(([id]) => id).join(","), maxResults: 50 }, 1);
      for (const ch of js.items ?? []) {
        const c = cands.get(ch.id)!;
        const st = ch.statistics ?? {};
        rows.push({
          scan_id: scanId, channel_id: ch.id,
          title: ch.snippet?.title ?? null, handle: ch.snippet?.customUrl ?? null,
          thumbnail_url: bestThumb(ch.snippet?.thumbnails), country: ch.snippet?.country ?? null,
          description: String(ch.snippet?.description ?? "").slice(0, 1500),
          channel_created: ch.snippet?.publishedAt ?? null,
          subscribers: st.hiddenSubscriberCount ? null : num(st.subscriberCount),
          hidden_subs: !!st.hiddenSubscriberCount,
          total_views: num(st.viewCount), video_count: num(st.videoCount),
          topic_hits: c.hits, hit_keywords: [...c.kws], sample_videos: c.videos,
          contacts: extractContacts(ch.snippet?.description),
        });
      }
    }
    if (rows.length) {
      const { error } = await sb.from("market_channels").upsert(rows, { onConflict: "scan_id,channel_id" });
      if (error) throw error;
    }
    await sb.from("market_scans").update({ candidates: rows.length }).eq("id", scanId);
    await addQuota(scanId);
    return { ok: true, scanId, channelIds: rows.map((r) => r.channel_id), spent, keywords };
  } catch (e) {
    await sb.from("market_scans").update({ status: "error", error: String((e as Error).message ?? e).slice(0, 300) }).eq("id", scanId);
    await addQuota(scanId);
    throw e;
  }
}

// ---------------------------------------------------------------- analyze
async function analyzeOne(scanId: string, channelId: string, match: (t: string) => boolean, refresh = false) {
  // "Atualizar dados deste canal": também relê inscritos, views e descrição do canal (1 unidade).
  if (refresh) {
    const js = await yt("/channels", { part: "snippet,statistics", id: channelId }, 1);
    const ch = js.items?.[0];
    if (ch) {
      const st = ch.statistics ?? {};
      await sb.from("market_channels").update({
        title: ch.snippet?.title ?? null, handle: ch.snippet?.customUrl ?? null,
        thumbnail_url: bestThumb(ch.snippet?.thumbnails), country: ch.snippet?.country ?? null,
        description: String(ch.snippet?.description ?? "").slice(0, 1500),
        subscribers: st.hiddenSubscriberCount ? null : num(st.subscriberCount), hidden_subs: !!st.hiddenSubscriberCount,
        total_views: num(st.viewCount), video_count: num(st.videoCount),
        contacts: extractContacts(ch.snippet?.description),
      }).eq("scan_id", scanId).eq("channel_id", channelId);
    }
  }
  const uploads = "UU" + channelId.slice(2); // playlist de envios = "UU" + resto do ID do canal
  let ids: string[] = [];
  try {
    const pl = await yt("/playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: 50 }, 1);
    ids = (pl.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean);
  } catch (e) {
    if (e instanceof Fail && e.code === "quota") throw e;
    if (!String((e as Error).message).includes("404")) throw e; // 404 = canal sem envios públicos
  }
  if (!ids.length) {
    await sb.from("market_channels").update({ metrics: { videos: 0 }, top_videos: [], recent_videos: [], analyzed_at: new Date().toISOString() })
      .eq("scan_id", scanId).eq("channel_id", channelId);
    return;
  }
  const vs = await yt("/videos", { part: "snippet,statistics,contentDetails", id: ids.join(","), maxResults: 50 }, 1);
  const videos = (vs.items ?? []).map((v: any) => ({
    id: v.id, title: v.snippet?.title ?? "", desc: v.snippet?.description ?? "",
    ms: Date.parse(v.snippet?.publishedAt ?? ""), dur: durationSeconds(v.contentDetails?.duration),
    views: num(v.statistics?.viewCount), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount),
  }));
  const { metrics, top, recent } = analyzeVideos(videos, match);
  const { error } = await sb.from("market_channels")
    .update({ metrics, top_videos: top, recent_videos: recent, analyzed_at: new Date().toISOString(), error: null })
    .eq("scan_id", scanId).eq("channel_id", channelId);
  if (error) throw error;
}

async function analyze(body: any) {
  const scanId = String(body.scanId ?? "");
  const channelIds: string[] = (Array.isArray(body.channelIds) ? body.channelIds : [])
    .map(String).filter((c: string) => CHANNEL_RE.test(c)).slice(0, ANALYZE_BATCH);
  if (!scanId || !channelIds.length) throw new Fail("input", "Varredura ou canais inválidos.");
  const { data: scan } = await sb.from("market_scans").select("keywords").eq("id", scanId).maybeSingle();
  if (!scan) throw new Fail("input", "Varredura não encontrada.");
  const match = buildMatcher(scan.keywords ?? []);

  const failed: Record<string, string> = {};
  let quotaStop: Fail | null = null;
  await Promise.all(channelIds.map(async (id) => {
    try { await analyzeOne(scanId, id, match, body.refresh === true); }
    catch (e) {
      if (e instanceof Fail && e.code === "quota") { quotaStop = e; return; }
      const msg = String((e as Error)?.message ?? e).slice(0, 250);
      failed[id] = msg;
      await sb.from("market_channels").update({ error: msg, analyzed_at: new Date().toISOString() })
        .eq("scan_id", scanId).eq("channel_id", id);
    }
  }));
  await addQuota(scanId);
  if (quotaStop) throw quotaStop;
  return { ok: true, done: channelIds.length - Object.keys(failed).length, failed, spent };
}

async function finish(body: any) {
  const scanId = String(body.scanId ?? "");
  if (!scanId) throw new Fail("input", "Varredura inválida.");
  const { count } = await sb.from("market_channels").select("channel_id", { count: "exact", head: true })
    .eq("scan_id", scanId).not("metrics", "is", null);
  await sb.from("market_scans").update({ status: "done", analyzed: count ?? 0 }).eq("id", scanId);
  return { ok: true, analyzed: count ?? 0 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const userId = await adminUser(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* corpo vazio */ }
  try {
    switch (body.action) {
      case "discover": return json(await discover(body, userId));
      case "analyze": return json(await analyze(body));
      case "finish": return json(await finish(body));
      case "quota": return json({ ok: true, used: await quotaToday(), cap: DAILY_CAP });
      default: return json({ ok: false, code: "input", error: "Ação desconhecida." }, 400);
    }
  } catch (e) {
    const code = e instanceof Fail ? e.code : "internal";
    console.error("market-scan", code, (e as Error)?.message);
    return json({ ok: false, code, error: String((e as Error)?.message ?? e).slice(0, 400) });
  }
});
