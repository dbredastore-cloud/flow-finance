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

/* Plataformas e ferramentas que o canal divulga. Cada item: [nome, categoria, regex]. O regex roda no texto
   normalizado (título + descrição) e nos links da descrição; menção = aparece no texto, link = aparece num link.
   Categorias: aff plataforma de afiliados · mkt marketplace · net rede de afiliados · ads anúncios ·
   trk rastreamento (≈ FlowTracking) · pg páginas e funis (≈ FlowPages) · spy espionagem (≈ FlowSpy) ·
   auto automação/e-mail · host hospedagem. */
const CATALOG = [
  ["Hotmart", "aff", /hotmart|hotm\.io/], ["Kiwify", "aff", /kiwify/], ["Eduzz", "aff", /eduzz|edz\.la/],
  ["Monetizze", "aff", /monetizze/], ["Braip", "aff", /braip/], ["Ticto", "aff", /ticto\.(app|com)|\bticto\b/],
  ["PerfectPay", "aff", /perfectpay/], ["Lastlink", "aff", /lastlink/], ["ClickBank", "aff", /clickbank/],
  ["Digistore24", "aff", /digistore24/],
  ["Amazon", "mkt", /amzn\.to|amazon\.com/], ["Shopee", "mkt", /shope\.ee|shopee\./],
  ["Mercado Livre", "mkt", /mercadolivre|mercadolibre|meli\.la/], ["Magalu", "mkt", /magazinevoce|magalu/],
  ["AliExpress", "mkt", /aliexpress/],
  ["Awin", "net", /awin1|awin\.com/], ["Lomadee", "net", /lomadee/], ["Rakuten", "net", /rakuten/],
  ["Google Ads", "ads", /google ads|adwords|ads\.google\.com/], ["Meta Ads", "ads", /meta ads|facebook ads|business\.facebook\.com/],
  ["TikTok Ads", "ads", /tiktok ads|ads\.tiktok\.com/],
  ["Utmify", "trk", /utmify/], ["RedTrack", "trk", /redtrack/], ["Voluum", "trk", /voluum/], ["Keitaro", "trk", /keitaro/],
  ["ClickMagick", "trk", /clickmagick/], ["Hyros", "trk", /hyros/], ["Trackdesk", "trk", /trackdesk/],
  ["Elementor", "pg", /elementor/], ["ClickFunnels", "pg", /clickfunnels/], ["Leadpages", "pg", /leadpages/],
  ["Unbounce", "pg", /unbounce/], ["Instapage", "pg", /instapage/], ["Systeme.io", "pg", /systeme\.io/],
  ["Builderall", "pg", /builderall/], ["Wix", "pg", /wixsite|\bwix\.com|\bwix\b/], ["WordPress", "pg", /wordpress/],
  ["BigSpy", "spy", /bigspy/], ["AdSpy", "spy", /adspy/], ["PiPiAds", "spy", /pipiads/], ["Minea", "spy", /\bminea\b/],
  ["Foreplay", "spy", /foreplay/], ["SpyFu", "spy", /spyfu/], ["Semrush", "spy", /semrush/],
  ["Biblioteca de Anúncios", "spy", /ads\/library|biblioteca de anuncios/],
  ["ManyChat", "auto", /manychat/], ["ActiveCampaign", "auto", /activecampaign/], ["RD Station", "auto", /rdstation|rd station/],
  ["Mailchimp", "auto", /mailchimp/], ["Zapier", "auto", /zapier/],
  ["Hostinger", "host", /hostinger/], ["HostGator", "host", /hostgator/], ["GoDaddy", "host", /godaddy/], ["Locaweb", "host", /locaweb/],
];
const SHORTENERS = /^(bit\.ly|tinyurl\.com|goo\.gl|t\.co|lnkd\.in|is\.gd|ow\.ly|buff\.ly|cutt\.ly|rb\.gy|encr\.pw)$/;
const OWN_HOSTS = /(^|\.)(youtube\.com|youtu\.be|google\.com|googleusercontent\.com|goo\.gl)$/;

/** Conta, nos vídeos, as plataformas/ferramentas citadas e os domínios mais repetidos nos links. */
export function detectTools(vs) {
  const counts = new Map(); // nome → { c, v, l }
  const hosts = new Map();  // domínio → nº de vídeos
  for (const v of vs) {
    const text = norm(`${v.title} ${v.desc}`);
    const urls = String(v.desc ?? "").match(URL_RE) ?? [];
    const linkText = urls.join(" ").toLowerCase();
    for (const [name, cat, re] of CATALOG) {
      const mention = re.test(text), link = re.test(linkText);
      if (!mention && !link) continue;
      const e = counts.get(name) ?? { n: name, c: cat, v: 0, l: 0 };
      e.v++; if (link) e.l++;
      counts.set(name, e);
    }
    const seen = new Set();
    for (const u of urls) {
      let host = "";
      try { host = new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { continue; }
      if (!host || seen.has(host) || SOCIAL_HOST.test(host) || OWN_HOSTS.test(host) || SHORTENERS.test(host)) continue;
      if (CATALOG.some(([, , re]) => re.test(host))) continue;
      seen.add(host);
      hosts.set(host, (hosts.get(host) ?? 0) + 1);
    }
  }
  const tools = [...counts.values()].sort((a, b) => b.l * 2 + b.v - (a.l * 2 + a.v)).slice(0, 14);
  const links = [...hosts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h, n]) => ({ h: h.slice(0, 60), v: n }));
  return { tools, links };
}

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

  const { tools, links } = detectTools(vs);
  const metrics = {
    videos: n,
    tools,
    links,
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
