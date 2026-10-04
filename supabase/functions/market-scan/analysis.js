// Cálculo das métricas de um canal a partir dos vídeos recentes. Código puro (sem rede),
// separado da Edge Function para poder ser testado isoladamente.

const DAY = 86400000;
const SHORT_MAX_S = 180;
const STOP = new Set(["para", "como", "com", "uma", "uns", "que", "dos", "das", "nos", "nas", "the", "and", "for", "with", "from"]);

// Links de plataformas de afiliação / marketplaces.
const AFF_LINK = /(hotmart|hotm\.io|kiwify|monetizze|eduzz|braip|ticto\.|perfectpay|lastlink|clickbank|amzn\.to|shope\.ee|shopee\.com|lomadee|awin1|go\.hotmart|mercadolivre\.com\/sec)/;
// Assuntos de anúncio pago.
const ADS_TERM = /(google ads|adwords|trafego pago|gestor de trafego|campanha(s)? de (anuncio|trafego)|anuncio(s)? no google|youtube ads|meta ads|facebook ads)/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s)<>"']+/g;
const SOCIAL_HOST = /(^|\.)(instagram\.com|t\.me|telegram\.me|wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|linktr\.ee|bio\.link|beacons\.ai|tiktok\.com|facebook\.com|x\.com|twitter\.com|linkedin\.com|kwai\.com)$/;

export const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Devolve uma função texto → boolean: o texto fala de alguma das palavras-chave? */
export function buildMatcher(keywords) {
  const groups = keywords
    .map((k) => norm(k).trim())
    .filter(Boolean)
    .map((phrase) => ({
      phrase,
      tokens: phrase.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)),
    }));
  return (text) => {
    const t = norm(text);
    return groups.some((g) => t.includes(g.phrase) || (g.tokens.length > 1 && g.tokens.every((x) => t.includes(x))));
  };
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const r3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

/** Contatos públicos que o canal deixou na descrição (e-mail comercial e redes). */
export function extractContacts(description) {
  const text = String(description ?? "");
  const emails = [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))].slice(0, 3);
  const links = [];
  for (const u of text.match(URL_RE) ?? []) {
    let host = "";
    try { host = new URL(u).hostname.toLowerCase(); } catch { continue; }
    if (SOCIAL_HOST.test(host) && !links.includes(u)) links.push(u.replace(/[.,;]+$/, "").slice(0, 160));
    if (links.length >= 6) break;
  }
  return { emails, links };
}

/**
 * videos: [{ id, title, ms (publicação, epoch), dur (s), views, likes, comments, desc }]
 * match:  buildMatcher(keywords)
 */
export function analyzeVideos(videos, match, now = Date.now()) {
  const vs = videos.filter((v) => Number.isFinite(v.ms)).sort((a, b) => b.ms - a.ms);
  const n = vs.length;
  if (!n) return { metrics: { videos: 0 }, top: [] };
  const age = (v) => Math.max((now - v.ms) / DAY, 0);

  // Frequência: janela de 90 dias; se os 50 últimos vídeos cobrem menos que isso, usa o período real.
  const oldest = age(vs[n - 1]);
  const windowDays = oldest < 90 ? Math.max(oldest, 7) : 90;
  const inWindow = vs.filter((v) => age(v) <= windowDays).length;
  const perWeek = inWindow / (windowDays / 7);
  const in30 = vs.filter((v) => age(v) <= 30).length;

  const recent = vs.slice(0, 10);
  const views = recent.map((v) => v.views ?? 0);
  const totViews = views.reduce((s, x) => s + x, 0);
  const totInter = recent.reduce((s, v) => s + (v.likes ?? 0) + (v.comments ?? 0), 0);

  const isShort = (v) => v.dur != null && v.dur > 0 && v.dur <= SHORT_MAX_S;
  const longs = vs.filter((v) => !isShort(v));

  const topicVideos = vs.filter((v) => match(`${v.title} ${v.desc}`));
  const titleHits = vs.filter((v) => match(v.title)).length;
  const topicViews = topicVideos.map((v) => v.views ?? 0);
  const topicViewsSum = topicViews.reduce((s, x) => s + x, 0);
  const topicInter = topicVideos.reduce((s, v) => s + (v.likes ?? 0) + (v.comments ?? 0), 0);

  const aff = vs.filter((v) => AFF_LINK.test(String(v.desc ?? "").toLowerCase())).length;
  const ads = vs.filter((v) => ADS_TERM.test(norm(`${v.title} ${v.desc}`))).length;

  // Momentum: views/dia dos 5 vídeos mais novos ÷ views/dia dos 5 anteriores.
  let momentum = null;
  if (n >= 10) {
    const vpd = (v) => (v.views ?? 0) / Math.max(age(v), 2);
    const a = median(vs.slice(0, 5).map(vpd)), b = median(vs.slice(5, 10).map(vpd));
    if (b > 0) momentum = a / b;
  }

  // Regularidade: posts por semana nas últimas 12 semanas (índice 11 = semana atual).
  const weekly = new Array(12).fill(0);
  for (const v of vs) {
    const w = Math.floor(age(v) / 7);
    if (w < 12) weekly[11 - w]++;
  }

  const metrics = {
    videos: n,
    perWeek: r1(perWeek),
    in30,
    lastDays: Math.floor(age(vs[0])),
    avgViews: Math.round(avg(views)),
    medianViews: Math.round(median(views)),
    engagement: totViews ? r3(totInter / totViews) : null,
    shortsPct: r3((n - longs.length) / n),
    avgDurMin: longs.length ? r1(avg(longs.map((v) => v.dur ?? 0)) / 60) : null,
    topicShare: r3(topicVideos.length / n),
    topicTitleShare: r3(titleHits / n),
    topicCount: topicVideos.length,
    topicAvgViews: topicVideos.length ? Math.round(avg(topicViews)) : null,
    topicEngagement: topicViewsSum ? r3(topicInter / topicViewsSum) : null,
    affShare: r3(aff / n),
    adsShare: r3(ads / n),
    momentum: r3(momentum),
    weekly,
    activeWeeks: weekly.filter((c) => c > 0).length,
  };

  const pool = topicVideos.length ? topicVideos : vs;
  const top = pool
    .slice()
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
    .slice(0, 5)
    .map((v) => ({
      id: v.id, title: String(v.title ?? "").slice(0, 140), ms: v.ms, dur: v.dur ?? null,
      views: v.views ?? 0, likes: v.likes ?? null, comments: v.comments ?? null,
      topic: topicVideos.includes(v),
    }));
  return { metrics, top };
}

/** ISO 8601 (PT1H2M3S) → segundos */
export function durationSeconds(iso) {
  const m = String(iso ?? "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const [, d, h, mi, s] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + mi * 60 + s;
}
