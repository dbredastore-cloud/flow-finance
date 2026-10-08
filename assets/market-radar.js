/* Rastrear Mercado (menu do painel de afiliados).
   Varre o YouTube por palavras-chave (Edge Function market-scan), analisa os canais encontrados e mostra
   ranking, comparação e leitura automática de quem tem mais potencial de parceria com as ferramentas Flow.
   Uso: MarketRadar.init({ root, sb, userId, toast, partnerIds }); MarketRadar.show(); */
(function () {
  "use strict";

  var DAILY_CAP = 6000;
  var PRESETS = ["afiliado google ads", "tráfego pago afiliado", "como ser afiliado", "hotmart afiliado", "kiwify afiliado",
    "gestor de tráfego", "renda extra afiliado", "dropshipping google ads"];
  var DEPTH = {
    quick: { pages: 1, maxChannels: 25, label: "Rápida · 1 página por termo · até 25 canais" },
    deep: { pages: 2, maxChannels: 40, label: "Profunda · 2 páginas por termo · até 40 canais" },
    max: { pages: 3, maxChannels: 60, label: "Máxima · 3 páginas por termo · até 60 canais" }
  };
  var AXES = [
    { key: "reach", label: "Alcance", tip: "Views médias dos últimos 10 vídeos, em escala logarítmica: 1 mil = 0, 1 milhão = 100." },
    { key: "eng", label: "Engajamento", short: "Engajam.", tip: "(Curtidas + comentários) ÷ views dos últimos 10 vídeos. 0% = 0, 6% ou mais = 100." },
    { key: "freq", label: "Recorrência", tip: "60% pela média de posts por semana (3 por semana = 100) + 40% por quantas das últimas 12 semanas tiveram vídeo novo." },
    { key: "topic", label: "Aderência ao tema", short: "Tema", tip: "Parte dos últimos 50 envios (título ou descrição) que fala das suas palavras-chave. 60% ou mais = 100." },
    { key: "aff", label: "Afinidade c/ afiliados", short: "Afiliados", tip: "Mistura de: descrições com links de plataformas de afiliado (Hotmart, Kiwify, Eduzz…) e vídeos sobre Google Ads/tráfego pago. 50% = 100." },
    { key: "mom", label: "Momentum", tip: "Views/dia dos 5 vídeos mais novos ÷ os 5 anteriores. 0,5× = 0, 1× = 50, 2× ou mais = 100. Sem dados suficientes = 50." }
  ];
  var DEFAULT_W = { reach: 20, eng: 20, freq: 15, topic: 25, aff: 15, mom: 5 };
  var STATUS = [["novo", "Novo"], ["prospectar", "Prospectar"], ["contatado", "Contatado"], ["parceiro", "Parceiro"], ["descartado", "Descartado"]];
  var COLORS = ["var(--accent)", "var(--accent-3)", "var(--warning)", "var(--accent-2)"];
  var WEIGHTS_KEY = "market_weights";
  var CHANNEL_COLS = "scan_id, channel_id, title, handle, thumbnail_url, country, description, channel_created, subscribers, hidden_subs, total_views, video_count, topic_hits, hit_keywords, sample_videos, metrics, top_videos, contacts, analyzed_at, error";
  // Categorias de plataformas/ferramentas detectadas nas descrições (ver CATALOG em market-scan/analysis.js).
  var TOOL_CATS = [
    ["aff", "Plataformas de afiliados"], ["mkt", "Marketplaces"], ["net", "Redes de afiliados"],
    ["trk", "Rastreamento"], ["pg", "Páginas e funis"], ["spy", "Espionagem de anúncios"],
    ["auto", "Automação e e-mail"], ["host", "Hospedagem"], ["ads", "Tráfego e anúncios (só citados)"]
  ];
  var FLOW_LIKE = { trk: "FlowTracking", pg: "FlowPages", spy: "FlowSpy" }; // categorias parecidas com as ferramentas Flow
  var PLATFORM_CATS = ["aff", "mkt", "net"];

  var A = null; // dependências do painel
  var S = {
    ready: false, loading: false, running: false,
    scans: [], scan: null, channels: [], targets: {}, weights: Object.assign({}, DEFAULT_W),
    quotaUsed: 0, sort: { key: "score", dir: -1 }, compare: [],
    filter: { text: "", minSubs: 0, hidePartners: false, onlyContact: false, status: "", tool: "" }
  };
  var logCount = 0, weightsTimer = null, resizeTimer = null;

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function median(arr) {
    var v = arr.filter(function (x) { return x != null && isFinite(x); }).sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  function fmtN(n) {
    if (n == null || !isFinite(n)) return "—";
    n = Number(n);
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".", ",") + " mi";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(".", ",") + " mil";
    return String(Math.round(n));
  }
  function fmtInt(n) { return n == null ? "—" : Number(n).toLocaleString("pt-BR"); }
  function pct(x, d) { return x == null ? "—" : (x * 100).toFixed(d == null ? 1 : d).replace(".", ",") + "%"; }
  function dec(x, d) { return x == null ? "—" : Number(x).toFixed(d == null ? 1 : d).replace(".", ","); }
  function fmtDate(ms) { return new Date(ms).toLocaleDateString("pt-BR"); }
  function fmtDateTime(iso) { var d = new Date(iso); return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }
  function chUrl(id) { return "https://www.youtube.com/channel/" + encodeURIComponent(id); }
  function vidUrl(id) { return "https://www.youtube.com/watch?v=" + encodeURIComponent(id); }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function ptMidnight() {
    var now = new Date();
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now);
    var g = function (t) { var p = parts.filter(function (x) { return x.type === t; })[0]; return p ? Number(p.value) : 0; };
    return new Date(now.getTime() - ((g("hour") % 24) * 3600 + g("minute") * 60 + g("second")) * 1000);
  }
  function parseKeywords(raw) {
    var seen = {}, out = [];
    String(raw || "").split(/[,;\n]+/).forEach(function (k) {
      k = k.trim().replace(/\s+/g, " ").slice(0, 80);
      var key = k.toLowerCase();
      if (k && !seen[key]) { seen[key] = 1; out.push(k); }
    });
    return out.slice(0, 5);
  }
  function estimate(nKw, o) { return nKw * o.pages * 100 + Math.ceil(o.maxChannels / 50) + o.maxChannels * 2; }

  /* ---------------- pontuação ---------------- */
  function axisValues(ch) {
    var m = ch.metrics;
    if (!m || !m.videos) return null;
    var momentum = m.momentum;
    return {
      reach: clamp(((Math.log(Math.max(m.avgViews || 1, 1)) / Math.LN10) - 3) / 3 * 100, 0, 100),
      eng: clamp((m.engagement || 0) / 0.06 * 100, 0, 100),
      freq: clamp((0.6 * Math.min((m.perWeek || 0) / 3, 1) + 0.4 * ((m.activeWeeks || 0) / 12)) * 100, 0, 100),
      topic: clamp((m.topicShare || 0) / 0.6 * 100, 0, 100),
      aff: clamp((((m.affShare || 0) * 0.6 + (m.adsShare || 0) * 0.4) / 0.5) * 100, 0, 100),
      mom: momentum == null ? 50 : clamp(50 + 50 * (Math.log(Math.max(momentum, 0.01)) / Math.LN2), 0, 100)
    };
  }
  function scoreOf(ax, w) {
    var tot = 0, sum = 0;
    AXES.forEach(function (a) { tot += w[a.key]; sum += w[a.key] * ax[a.key]; });
    return tot ? sum / tot : 0;
  }
  function prepare() {
    S.channels.forEach(function (c) {
      c.ax = axisValues(c);
      c.ok = !!c.ax;
    });
    rescore();
  }
  function rescore() {
    S.channels.forEach(function (c) { c.score = c.ok ? Math.round(scoreOf(c.ax, S.weights)) : null; });
  }
  function analyzed() { return S.channels.filter(function (c) { return c.ok; }); }

  /* ---- plataformas e ferramentas que o canal divulga ---- */
  // null = varredura anterior a este recurso (sem o dado).
  function toolsOf(c) { return c.metrics && Array.isArray(c.metrics.tools) ? c.metrics.tools : null; }
  // "Divulga" = tem link ou aparece em 2+ vídeos; plataformas de anúncio entram só como assunto citado.
  function promoted(c) {
    return (toolsOf(c) || []).filter(function (t) { return t.c !== "ads" && (t.l > 0 || t.v >= 2); });
  }
  function toolList(arr, max) {
    var shown = arr.slice(0, max).map(function (t) { return "<b>" + esc(t.n) + "</b> (" + t.v + " víd." + (t.l ? ", " + t.l + " com link" : "") + ")"; });
    return shown.join(", ") + (arr.length > max ? " e mais " + (arr.length - max) : "");
  }
  // Quantos canais divulgam cada ferramenta nesta varredura.
  function toolMarket() {
    var agg = {};
    analyzed().forEach(function (c) {
      promoted(c).forEach(function (t) { var e = agg[t.n] = agg[t.n] || { n: t.n, c: t.c, ch: 0 }; e.ch++; });
    });
    return Object.keys(agg).map(function (k) { return agg[k]; }).sort(function (a, b) { return b.ch - a.ch || (a.n < b.n ? -1 : 1); });
  }
  function isPartner(c) { return !!(A.partnerIds && A.partnerIds().has(c.channel_id)); }
  function statusOf(c) { return (S.targets[c.channel_id] || {}).status || "novo"; }

  /* ---------------- chamadas ---------------- */
  async function call(body) {
    var res = await A.sb.functions.invoke("market-scan", { body: body });
    var data = res.data;
    if (res.error && !(data && data.error)) {
      try { data = await res.error.context.json(); } catch (e) { data = { ok: false, error: res.error.message || "falha na chamada" }; }
    }
    return data || { ok: false, error: "sem resposta" };
  }
  async function loadScans() {
    var r = await A.sb.from("market_scans").select("id, created_at, keywords, options, status, candidates, analyzed, quota_units, error").order("created_at", { ascending: false }).limit(30);
    if (r.error) throw r.error;
    var all = r.data || [];
    var since = ptMidnight().getTime();
    S.quotaUsed = all.reduce(function (s, x) { return s + (Date.parse(x.created_at) >= since ? (x.quota_units || 0) : 0); }, 0);
    // "lookup" = só a busca do nome do canal (existe para contar a cota); não é uma varredura para abrir.
    S.scans = all.filter(function (x) { return !(x.options && x.options.mode === "lookup"); });
  }
  async function loadTargets() {
    var r = await A.sb.from("market_targets").select("channel_id, status");
    if (r.error) throw r.error;
    S.targets = {};
    (r.data || []).forEach(function (t) { S.targets[t.channel_id] = t; });
  }
  async function loadWeights() {
    var local = null;
    try { local = JSON.parse(safeGet("mr_weights")); } catch (e) {}
    if (local) S.weights = cleanWeights(local);
    var r = await A.sb.from("ui_prefs").select("value").eq("key", WEIGHTS_KEY).maybeSingle();
    if (!r.error && r.data && !weightsTimer) { S.weights = cleanWeights(r.data.value); safeSet("mr_weights", JSON.stringify(S.weights)); }
  }
  function cleanWeights(raw) {
    var w = {};
    AXES.forEach(function (a) { var n = Number(raw && raw[a.key]); w[a.key] = isFinite(n) ? clamp(Math.round(n), 0, 40) : DEFAULT_W[a.key]; });
    if (!AXES.some(function (a) { return w[a.key] > 0; })) return Object.assign({}, DEFAULT_W);
    return w;
  }
  function saveWeights() {
    safeSet("mr_weights", JSON.stringify(S.weights));
    clearTimeout(weightsTimer);
    weightsTimer = setTimeout(async function () {
      weightsTimer = null;
      var r = await A.sb.from("ui_prefs").upsert({ user_id: A.userId(), key: WEIGHTS_KEY, value: S.weights, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
      if (r.error) console.warn("market_weights:", r.error);
    }, 700);
  }
  async function openScan(id) {
    // Sem recent_videos (pesado): ele só é lido ao expandir um canal.
    var r = await A.sb.from("market_channels").select(CHANNEL_COLS).eq("scan_id", id);
    if (r.error) throw r.error;
    S.scan = S.scans.filter(function (s) { return s.id === id; })[0] || null;
    S.channels = r.data || [];
    S.compare = [];
    safeSet("mr_last_scan", id);
    prepare();
    renderResults();
  }

  /* ---------------- esqueleto ---------------- */
  function build(root) {
    root.innerHTML =
      '<section class="mr-hero" aria-label="Painel de comando do radar">' +
        '<div class="mr-scanlines"></div>' +
        '<div class="mr-radar" id="mr-radar" aria-hidden="true"><i></i><i></i><i></i></div>' +
        '<div class="mr-hero-main">' +
          '<div class="mr-kicker"><span>Radar de mercado · YouTube</span><span class="mr-online">Sistema online</span></div>' +
          '<div class="mr-title">Rastrear Mercado<small>espionagem de concorrência e parceiros</small></div>' +
          '<form class="mr-cmd" id="mr-form" autocomplete="off">' +
            '<label class="mr-input"><span class="mr-prompt">&gt;_</span>' +
              '<input id="mr-q" type="text" maxlength="400" placeholder="palavras-chave separadas por vírgula · ex: afiliado google ads, tráfego pago" aria-label="Palavras-chave para rastrear"></label>' +
            '<button class="btn btn-primary mr-go" id="mr-go" type="submit">Iniciar varredura</button>' +
          '</form>' +
          '<div class="mr-chips" id="mr-chips" aria-label="Sugestões de busca"></div>' +
          '<div class="mr-opts">' +
            '<label>Profundidade <select id="mr-depth">' + Object.keys(DEPTH).map(function (k) { return '<option value="' + k + '">' + esc(DEPTH[k].label) + "</option>"; }).join("") + "</select></label>" +
            '<label>Idioma <select id="mr-lang"><option value="pt">Português (Brasil)</option><option value="en">Inglês</option><option value="es">Espanhol</option><option value="any">Qualquer</option></select></label>' +
            '<label>Vídeos publicados <select id="mr-since"><option value="90d">nos últimos 90 dias</option><option value="1y" selected>no último ano</option><option value="any">em qualquer época</option></select></label>' +
            '<span class="mr-est" id="mr-est"></span>' +
          "</div>" +
          '<form class="mr-solo" id="mr-solo" autocomplete="off">' +
            '<span class="mr-solo-lbl">Ou pesquise um youtuber específico</span>' +
            '<label class="mr-input"><span class="mr-prompt">@</span>' +
              '<input id="mr-yt-q" type="text" maxlength="200" placeholder="nome do canal, @usuario ou link (youtube.com/@canal)" aria-label="Nome ou link do canal do YouTube"></label>' +
            '<button class="btn mr-solo-go" id="mr-yt-go" type="submit">Pesquisar canal</button>' +
            '<span class="mr-est" id="mr-solo-est">Link ou @usuario: ~4 unidades · só o nome: ~105 (precisa buscar)</span>' +
          "</form>" +
          '<div class="mr-pick" id="mr-pick" hidden></div>' +
        "</div>" +
        '<div class="mr-gauge" id="mr-gauge"></div>' +
      "</section>" +
      '<section class="mr-console" id="mr-console" hidden>' +
        '<div class="mr-console-head"><span>Terminal de varredura</span><span class="mr-pct" id="mr-pct">0%</span></div>' +
        '<div class="mr-progress"><i id="mr-prog"></i></div>' +
        '<div class="mr-log" id="mr-log" role="log" aria-live="polite"></div>' +
      "</section>" +
      '<div id="mr-empty" class="mr-empty"><b>Aguardando alvo</b>Digite palavras-chave (ou clique numa sugestão) e inicie a varredura.<br>O radar encontra canais que falam do assunto, mede alcance, engajamento, recorrência e afinidade com afiliados, e ranqueia quem tem mais potencial de parceria.</div>' +
      '<div id="mr-results" hidden>' +
        '<div class="mr-bar-top"><select id="mr-scan-sel" class="grow" aria-label="Varredura"></select>' +
          '<button class="btn" id="mr-csv" type="button">Exportar CSV</button><button class="btn" id="mr-del" type="button">Apagar varredura</button></div>' +
        '<div class="mr-kpis" id="mr-kpis"></div>' +
        '<section class="panel"><div class="panel-head"><h3>Veredito do radar</h3><span class="muted" style="font-size:12px;">Análise automática dos dados coletados</span></div>' +
          '<p class="mr-read" id="mr-read"></p><div class="mr-cards" id="mr-cards"></div></section>' +
        '<div class="mr-grid">' +
          '<section class="panel"><div class="panel-head"><h3>Mapa do mercado</h3></div>' +
            '<p class="mr-hint">Cada bolha é um canal: quanto mais à direita, mais inscritos; quanto mais acima, mais engajamento; o tamanho é a média de views. Passe o mouse para detalhes, clique para abrir a análise.</p>' +
            '<div class="mr-chart" id="mr-bubbles"></div>' +
            '<div class="mr-legend"><span><i style="background:var(--accent)"></i>Canal do mercado</span><span><i style="background:var(--accent-3)"></i>Já é parceiro</span><span><i style="background:var(--warning)"></i>Selecionado p/ comparar</span></div></section>' +
          '<section class="panel"><div class="panel-head"><h3>Radar de comparação</h3></div>' +
            '<p class="mr-hint" id="mr-radar-hint"></p><div class="mr-chart" id="mr-radar-cmp"></div><div class="mr-legend" id="mr-radar-leg"></div></section>' +
        "</div>" +
        '<details class="mr-cal" id="mr-cal"><summary>Calibrar critérios do score<span>Mude os pesos e o ranking se recalcula na hora</span></summary><div class="mr-cal-body" id="mr-cal-body"></div></details>' +
        '<section class="panel" id="mr-cmp-panel" hidden><div class="panel-head"><h3>Comparação direta</h3><button class="btn" id="mr-cmp-clear" type="button">Limpar seleção</button></div><div class="mr-cmp-grid"><div id="mr-cmp-radar" class="mr-chart"></div><div class="table-scroll" id="mr-cmp-table"></div></div></section>' +
        '<section class="panel"><div class="panel-head"><h3>Ranking de parceiros em potencial</h3><span class="muted" style="font-size:12px;" id="mr-count"></span></div>' +
          '<div class="mr-tools">' +
            '<input type="search" id="mr-f-text" placeholder="Filtrar por nome…" aria-label="Filtrar por nome">' +
            '<select id="mr-f-subs" aria-label="Inscritos mínimos"><option value="0">Qualquer tamanho</option><option value="1000">1 mil+ inscritos</option><option value="10000">10 mil+</option><option value="50000">50 mil+</option><option value="100000">100 mil+</option><option value="500000">500 mil+</option></select>' +
            '<select id="mr-f-status" aria-label="Etapa do funil"><option value="">Todas as etapas</option>' + STATUS.map(function (s) { return '<option value="' + s[0] + '">' + s[1] + "</option>"; }).join("") + "</select>" +
            '<select id="mr-f-tool" aria-label="Filtrar por ferramenta divulgada" hidden></select>' +
            '<label class="ck"><input type="checkbox" id="mr-f-partners"> Ocultar quem já é parceiro</label>' +
            '<label class="ck"><input type="checkbox" id="mr-f-contact"> Só com contato público</label>' +
          "</div>" +
          '<div class="mr-dock" id="mr-dock"></div>' +
          '<div class="table-scroll"><table class="mr-table"><thead id="mr-head"></thead><tbody id="mr-body"></tbody></table></div></section>' +
      "</div>";

    var tip = document.createElement("div");
    tip.className = "mr-tip"; tip.id = "mr-tip";
    root.appendChild(tip);

    if (!$("mr-drawer")) {
      var scrim = document.createElement("div"); scrim.id = "mr-scrim";
      var dr = document.createElement("aside"); dr.id = "mr-drawer"; dr.setAttribute("role", "dialog"); dr.setAttribute("aria-label", "Análise do canal"); dr.setAttribute("aria-hidden", "true");
      document.body.appendChild(scrim); document.body.appendChild(dr);
      scrim.addEventListener("click", closeDrawer);
    }
    if (!$("mr-full")) {
      var full = document.createElement("div");
      full.id = "mr-full"; full.hidden = true; full.setAttribute("role", "dialog"); full.setAttribute("aria-modal", "true"); full.setAttribute("aria-label", "Pesquisa completa do canal");
      full.innerHTML = '<div class="mr-full-bar"><button class="btn" id="mr-full-back" type="button">← Voltar ao radar</button><span class="mr-full-title" id="mr-full-title"></span><div class="mr-full-acts" id="mr-full-acts"></div></div>' +
        '<div class="mr-full-body" id="mr-full-body"></div><div class="mr-tip" id="mr-full-tip"></div>';
      document.body.appendChild(full);
    }
    $("mr-chips").innerHTML = PRESETS.map(function (p) { return '<button type="button" class="mr-chip" data-kw="' + esc(p) + '">' + esc(p) + "</button>"; }).join("");
    $("mr-depth").value = "quick";
    bind();
    renderGauge();
    renderEstimate();
  }

  /* ---------------- topo: sugestões, custo, cota ---------------- */
  function readOpts() {
    var d = DEPTH[$("mr-depth").value] || DEPTH.quick;
    return { pages: d.pages, maxChannels: d.maxChannels, language: $("mr-lang").value, since: $("mr-since").value };
  }
  function renderEstimate() {
    var kws = parseKeywords($("mr-q").value), o = readOpts(), n = Math.max(kws.length, 1), est = estimate(n, o);
    var over = S.quotaUsed + est > DAILY_CAP;
    var el = $("mr-est");
    el.className = "mr-est" + (over ? " warn" : "");
    el.innerHTML = "Custo estimado: <b>~" + fmtInt(est) + "</b> unidades da cota" + (over ? " · passa do teto diário" : "");
    document.querySelectorAll("#mr-chips .mr-chip").forEach(function (b) {
      b.classList.toggle("on", kws.some(function (k) { return k.toLowerCase() === b.dataset.kw.toLowerCase(); }));
    });
  }
  function renderGauge() {
    var p = clamp(S.quotaUsed / DAILY_CAP * 100, 0, 100);
    $("mr-gauge").innerHTML =
      '<div class="mr-ring ' + (p >= 90 ? "crit" : p >= 65 ? "warn" : "") + '" style="--p:' + p.toFixed(1) + '"><div><b>' + Math.round(p) + '%</b><span>COTA HOJE</span></div></div>' +
      "<small>" + fmtInt(S.quotaUsed) + " de " + fmtInt(DAILY_CAP) + " unidades usadas por varreduras de mercado hoje. O resto da cota diária do YouTube (10 mil) fica para o sync dos influencers.</small>";
  }

  /* ---------------- terminal ---------------- */
  function logLine(text, cls) {
    var box = $("mr-log");
    box.querySelectorAll(".cur").forEach(function (e) { e.classList.remove("cur"); });
    var d = document.createElement("div");
    if (cls) d.className = cls;
    var t = document.createElement("span"); t.className = "t"; t.textContent = new Date().toLocaleTimeString("pt-BR");
    d.appendChild(t); d.appendChild(document.createTextNode(text));
    box.appendChild(d);
    if (++logCount > 200) { box.removeChild(box.firstChild); logCount--; }
    box.scrollTop = box.scrollHeight;
  }
  function setProgress(p) { $("mr-prog").style.width = p + "%"; $("mr-pct").textContent = Math.round(p) + "%"; }
  function setBusy(b) {
    S.running = b;
    $("mr-go").disabled = b; $("mr-go").textContent = b ? "Varrendo…" : "Iniciar varredura";
    $("mr-yt-go").disabled = b;
    $("mr-radar").classList.toggle("busy", b);
  }

  async function runScan() {
    if (S.running) return;
    var kws = parseKeywords($("mr-q").value);
    if (!kws.length) { A.toast("Digite ao menos uma palavra-chave.", true); $("mr-q").focus(); return; }
    var o = readOpts(), est = estimate(kws.length, o);
    if (S.quotaUsed + est > DAILY_CAP) { A.toast("Essa busca passaria do teto diário de varreduras. Reduza a profundidade ou os termos.", true); return; }

    setBusy(true);
    $("mr-console").hidden = false; $("mr-log").innerHTML = ""; logCount = 0; setProgress(2);
    logLine("Iniciando varredura · " + kws.length + " termo(s): " + kws.join(" | "));
    logLine("Consultando o YouTube (" + o.pages + " página(s) por termo)…", "cur");
    var d = await call({ action: "discover", keywords: kws, pages: o.pages, maxChannels: o.maxChannels, language: o.language, since: o.since });
    if (!d.ok) return endScan(d.error || "falha na busca", true);
    var ids = d.channelIds || [];
    logLine(ids.length + " canais mapeados · " + d.spent + " unidades de cota", "ok");
    setProgress(15);
    var stopped = null;
    for (var i = 0; i < ids.length; i += 8) {
      var batch = ids.slice(i, i + 8);
      logLine("Analisando canais " + (i + 1) + "–" + (i + batch.length) + " de " + ids.length + "…", "cur");
      var r = await call({ action: "analyze", scanId: d.scanId, channelIds: batch });
      if (!r.ok) { logLine("Falha: " + r.error, "bad"); if (r.code === "quota") { stopped = r.error; break; } }
      else {
        var failed = Object.keys(r.failed || {}).length;
        logLine(r.done + " canais analisados" + (failed ? " · " + failed + " com erro" : ""), failed ? "bad" : "ok");
      }
      setProgress(15 + 80 * Math.min(i + batch.length, ids.length) / ids.length);
    }
    await call({ action: "finish", scanId: d.scanId });
    setProgress(100);
    try { await loadScans(); renderGauge(); renderEstimate(); await openScan(d.scanId); }
    catch (e) { return endScan("Varredura salva, mas não foi possível carregar o resultado: " + (e.message || e), true); }
    endScan(stopped ? "Varredura parcial: " + stopped : (ids.length ? "Varredura concluída." : "Nenhum canal encontrado para esses termos."), !!stopped);
  }
  /* ---------------- youtuber específico ---------------- */
  function openConsole() {
    $("mr-console").hidden = false; $("mr-log").innerHTML = ""; logCount = 0; setProgress(2);
  }
  async function runSolo() {
    if (S.running) return;
    var q = $("mr-yt-q").value.trim();
    if (!q) { A.toast("Digite o nome ou o link do canal.", true); $("mr-yt-q").focus(); return; }
    $("mr-pick").hidden = true; $("mr-pick").innerHTML = "";
    setBusy(true); openConsole();
    logLine("Procurando o canal “" + q + "” no YouTube…", "cur");
    var d = await call({ action: "find", query: q });
    if (!d.ok) return endScan(d.error || "falha ao procurar o canal", true);
    var cands = d.candidates || [];
    if (!cands.length) return endScan("Nenhum canal encontrado para “" + q + "”. Confira o nome ou cole o link do canal.", true);
    if (d.exact && cands.length === 1) { logLine("Canal localizado: " + cands[0].title, "ok"); return scanSolo(cands[0]); }
    logLine(cands.length + " canais parecidos · " + d.spent + " unidades de cota. Escolha o certo abaixo.", "ok");
    setProgress(0); setBusy(false);
    renderPick(cands);
  }
  function renderPick(cands) {
    var box = $("mr-pick");
    box.hidden = false;
    box.innerHTML = '<div class="mr-pick-h">Qual destes é o canal?</div>' + cands.map(function (c, i) {
      return '<button type="button" class="mr-pick-i" data-pick="' + i + '">' +
        (c.thumbnail_url ? '<img src="' + esc(c.thumbnail_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="mr-pick-ph"></span>') +
        '<span class="mr-pick-t"><b>' + esc(c.title || "Sem nome") + "</b><small>" + esc((c.handle || "") + (c.handle ? " · " : "") +
          (c.subscribers == null ? "inscritos ocultos" : fmtInt(c.subscribers) + " inscritos") + " · " + fmtInt(c.video_count || 0) + " vídeos") + "</small>" +
          (c.description ? "<em>" + esc(c.description) + "</em>" : "") + "</span></button>";
    }).join("");
    S.picks = cands;
  }
  async function scanSolo(cand) {
    try {
      $("mr-pick").hidden = true;
      setBusy(true); if ($("mr-console").hidden) openConsole();
      var kws = parseKeywords($("mr-q").value);
      logLine("Lendo dados e até 50 vídeos de " + cand.title + "…", "cur"); setProgress(20);
      var a = await call({ action: "add_channel", channelId: cand.channel_id, keywords: kws });
      if (!a.ok) return endScan(a.error || "falha ao registrar o canal", true);
      setProgress(45);
      var r = await call({ action: "analyze", scanId: a.scanId, channelIds: [cand.channel_id] });
      if (!r.ok) return endScan(r.error || "falha ao analisar o canal", true);
      var failed = Object.keys(r.failed || {});
      await call({ action: "finish", scanId: a.scanId });
      setProgress(100);
      if (failed.length) logLine("Falha na análise: " + r.failed[failed[0]], "bad");
      else logLine("Canal analisado.", "ok");
      await loadScans(); renderGauge(); renderEstimate();
      await openScan(a.scanId);
      endScan(failed.length ? "Canal salvo, mas a análise dos vídeos falhou." : "Pesquisa concluída: " + cand.title, !!failed.length);
      if (!failed.length) openFull(cand.channel_id);
    } catch (e) {
      endScan("Erro: " + (e.message || e), true);
    }
  }
  function endScan(msg, bad) {
    logLine(msg, bad ? "bad" : "ok");
    setBusy(false);
    if (bad) A.toast(msg, true);
    else if ($("mr-results") && !$("mr-results").hidden) $("mr-results").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------------- resultados ---------------- */
  function renderResults() {
    var has = !!S.scan;
    $("mr-empty").hidden = has && S.channels.length > 0;
    $("mr-results").hidden = !has || !S.channels.length;
    $("mr-scan-sel").innerHTML = S.scans.map(function (s) {
      var solo = s.options && s.options.mode === "channel";
      var what = solo ? "Canal: " + (s.options.channel_title || (s.keywords || []).join(", ")) : (s.keywords || []).join(", ") + " · " + (s.analyzed || 0) + " canais";
      return '<option value="' + esc(s.id) + '"' + (S.scan && s.id === S.scan.id ? " selected" : "") + ">" + esc(fmtDateTime(s.created_at) + " · " + what) + "</option>";
    }).join("");
    if (!has) return;
    if (!S.channels.length) {
      $("mr-empty").innerHTML = "<b>Nada encontrado</b>Nenhum canal apareceu para " + esc((S.scan.keywords || []).join(", ")) + ". Tente outras palavras, amplie o período ou escolha \"Qualquer\" idioma.";
      return;
    }
    $("mr-empty").hidden = true;
    renderCalibration();
    renderAnalysis();
  }
  // Tudo que depende dos pesos/filtros/seleção.
  function renderAnalysis() {
    renderKpis(); renderInsights(); renderCharts(); renderCompare(); renderToolFilter(); renderHead(); renderTable();
  }

  function renderKpis() {
    var L = analyzed();
    var subs = L.reduce(function (s, c) { return s + (c.subscribers || 0); }, 0);
    var best = L.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); })[0];
    var engMed = median(L.map(function (c) { return c.metrics.engagement; }));
    var weekly = L.filter(function (c) { return c.metrics.perWeek >= 1; }).length;
    var partners = S.channels.filter(isPartner).length;
    var failed = S.channels.length - L.length;
    var k = function (label, value, sub, tip) {
      return '<div class="kpi"><div class="label"' + (tip ? ' title="' + esc(tip) + '"' : "") + ">" + label + '</div><div class="value num">' + value + "</div>" + (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>";
    };
    $("mr-kpis").innerHTML =
      k("Canais mapeados", fmtInt(L.length), failed ? failed + " sem dados" : "todos analisados") +
      k("Alcance somado", fmtN(subs), "inscritos nos canais", "Soma dos inscritos de todos os canais analisados.") +
      k("Melhor score", best ? best.score : "—", best ? esc(best.title) : "", "Maior nota de potencial de parceria, com os pesos atuais.") +
      k("Engajamento mediano", pct(engMed), "últimos 10 vídeos de cada canal", "Mediana de (curtidas + comentários) ÷ views.") +
      k("Postam toda semana", fmtInt(weekly), "de " + fmtInt(L.length) + " canais", "Média de pelo menos 1 vídeo por semana nos últimos 90 dias.") +
      k("Já são parceiros", fmtInt(partners), "canais já cadastrados no painel");
  }

  /* ---- insights automáticos ---- */
  function pick(pool, fn, used) {
    var best = null, bv = -Infinity;
    pool.forEach(function (c) {
      var v = fn(c);
      if (v == null || !isFinite(v)) return;
      var penal = used[c.channel_id] ? -1e6 : 0;
      if (v + penal > bv) { bv = v + penal; best = c; }
    });
    return best;
  }
  function buildInsights() {
    var L = analyzed();
    var pool = L.filter(function (c) { return !isPartner(c) && statusOf(c) !== "descartado"; });
    if (!pool.length) pool = L;
    var used = {}, out = [];
    var subsMed = median(pool.map(function (c) { return c.subscribers; }));
    var engMed = median(L.map(function (c) { return c.metrics.engagement; })) || 0;
    function add(tag, ch, text) { if (ch) { used[ch.channel_id] = 1; out.push({ tag: tag, ch: ch, text: text }); } }
    var top = pick(pool, function (c) { return c.score; }, used);
    if (top) { var m = top.metrics; add("Melhor aposta", top, "Nota " + top.score + "/100. " + fmtN(m.avgViews) + " views por vídeo, " + pct(m.engagement) + " de engajamento, " + dec(m.perWeek) + " posts/semana e " + pct(m.topicShare, 0) + " do conteúdo sobre o tema."); }
    var gem = pick(pool.filter(function (c) { return c.subscribers != null && c.subscribers < (subsMed || 0) && c.ax.topic >= 30; }), function (c) { return c.ax.eng; }, used);
    if (gem) add("Gema escondida", gem, "Só " + fmtN(gem.subscribers) + " inscritos, mas " + pct(gem.metrics.engagement) + " de engajamento" + (engMed ? " (" + dec(gem.metrics.engagement / engMed) + "× a mediana)" : "") + ": audiência pequena e muito ativa, tende a sair mais barata.");
    var mach = pick(pool.filter(function (c) { return c.metrics.activeWeeks >= 8; }), function (c) { return c.metrics.perWeek + c.ax.topic / 100; }, used);
    if (mach) add("Máquina de postar", mach, dec(mach.metrics.perWeek) + " posts por semana e vídeo novo em " + mach.metrics.activeWeeks + " das últimas 12 semanas. Quem posta sempre mantém a ferramenta em evidência.");
    var rise = pick(pool.filter(function (c) { return c.metrics.momentum != null && c.metrics.momentum >= 1.25; }), function (c) { return c.metrics.momentum; }, used);
    if (rise) add("Em ascensão", rise, "Os vídeos mais novos rendem " + dec(rise.metrics.momentum) + "× mais views por dia que os anteriores. Entrar agora é pegar o canal em alta.");
    var spec = pick(pool.filter(function (c) { return c.metrics.topicCount >= 4; }), function (c) { return c.metrics.topicShare; }, used);
    if (spec) add("Especialista no tema", spec, pct(spec.metrics.topicShare, 0) + " dos últimos " + spec.metrics.videos + " vídeos tratam das suas palavras-chave (" + spec.metrics.topicCount + " vídeos, " + fmtN(spec.metrics.topicAvgViews) + " views em média).");
    var aff = pick(pool.filter(function (c) { return c.metrics.affShare >= 0.25; }), function (c) { return c.metrics.affShare; }, used);
    if (aff) add("Já divulga afiliado", aff, pct(aff.metrics.affShare, 0) + " das descrições têm links de plataformas de afiliado: já tem o hábito de divulgar produto de terceiros.");
    return out;
  }
  function avHtml(c, cls) {
    return c.thumbnail_url
      ? '<img class="mr-av ' + (cls || "") + '" src="' + esc(c.thumbnail_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : '<span class="mr-av ' + (cls || "") + '">YT</span>';
  }
  function renderInsights() {
    var L = analyzed();
    var subsMed = median(L.map(function (c) { return c.subscribers; }));
    var engMed = median(L.map(function (c) { return c.metrics.engagement; }));
    var views = median(L.map(function (c) { return c.metrics.avgViews; }));
    var weekly = L.filter(function (c) { return c.metrics.perWeek >= 1; }).length;
    var affN = L.filter(function (c) { return c.metrics.affShare >= 0.2; }).length;
    var kws = S.scan ? (S.scan.keywords || []).map(function (k) { return "<b>" + esc(k) + "</b>"; }).join(", ") : "";
    var read = "Para " + kws + ", o radar analisou <b>" + L.length + " canais</b>. Mediana de <b>" + fmtN(subsMed) + "</b> inscritos, <b>" + fmtN(views) + "</b> views por vídeo e <b>" + pct(engMed) + "</b> de engajamento. " +
      "<b>" + weekly + "</b> postam toda semana e <b>" + affN + "</b> já colocam links de afiliado em pelo menos 20% dos vídeos.";
    if (L.some(function (c) { return toolsOf(c); })) {
      var market = toolMarket();
      var plats = market.filter(function (t) { return PLATFORM_CATS.indexOf(t.c) >= 0; }).slice(0, 4);
      var like = market.filter(function (t) { return FLOW_LIKE[t.c]; }).slice(0, 4);
      if (plats.length) read += " Plataformas mais divulgadas: " + plats.map(function (t) { return "<b>" + esc(t.n) + "</b> (" + t.ch + (t.ch === 1 ? " canal" : " canais") + ")"; }).join(", ") + ".";
      if (like.length) read += " Ferramentas parecidas com as da Flow aparecem em " + like.map(function (t) { return "<b>" + esc(t.n) + "</b> (" + FLOW_LIKE[t.c] + ", " + t.ch + (t.ch === 1 ? " canal" : " canais") + ")"; }).join(", ") + ".";
    }
    $("mr-read").innerHTML = read;
    var cards = buildInsights();
    $("mr-cards").innerHTML = cards.map(function (x) {
      return '<div class="mr-card"><div class="tag">' + x.tag + '</div><div class="who">' + avHtml(x.ch) + "<b>" + esc(x.ch.title) + "</b></div><p>" + x.text + '</p><div class="acts">' +
        '<button class="btn" type="button" data-open="' + esc(x.ch.channel_id) + '">Ver análise</button>' +
        '<button class="btn" type="button" data-cmp-add="' + esc(x.ch.channel_id) + '">Comparar</button></div></div>';
    }).join("") || '<span class="muted">Dados insuficientes para gerar conclusões.</span>';
  }

  /* ---- calibragem ---- */
  function renderCalibration() {
    var tot = AXES.reduce(function (s, a) { return s + S.weights[a.key]; }, 0) || 1;
    $("mr-cal-body").innerHTML = AXES.map(function (a) {
      return '<div class="mr-sl"><label for="mr-w-' + a.key + '"><span>' + a.label + '</span><b id="mr-wv-' + a.key + '">' + Math.round(S.weights[a.key] / tot * 100) + '%</b></label>' +
        '<input type="range" id="mr-w-' + a.key + '" data-w="' + a.key + '" min="0" max="40" step="1" value="' + S.weights[a.key] + '"><small>' + esc(a.tip) + "</small></div>";
    }).join("") + '<div class="mr-cal-foot"><button class="btn" id="mr-w-reset" type="button">Voltar ao padrão</button><span>Os pesos ficam salvos na sua conta.</span></div>';
  }
  function refreshWeightLabels() {
    var tot = AXES.reduce(function (s, a) { return s + S.weights[a.key]; }, 0) || 1;
    AXES.forEach(function (a) { var e = $("mr-wv-" + a.key); if (e) e.textContent = Math.round(S.weights[a.key] / tot * 100) + "%"; });
  }

  /* ---- gráficos ---- */
  function drawBubbles() {
    var el = $("mr-bubbles");
    var L = analyzed().filter(function (c) { return c.subscribers > 0 && c.metrics.engagement != null; });
    if (!L.length) { el.innerHTML = '<p class="muted">Sem canais com inscritos públicos para desenhar.</p>'; return; }
    var W = Math.max(el.clientWidth || 640, 300), H = W < 480 ? 300 : 360;
    var m = { l: 50, r: 16, t: 16, b: 42 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
    var xs = L.map(function (c) { return Math.log(c.subscribers) / Math.LN10; });
    var xMin = Math.min.apply(null, xs) - 0.15, xMax = Math.max.apply(null, xs) + 0.15;
    if (xMax - xMin < 0.8) { var mid = (xMax + xMin) / 2; xMin = mid - 0.4; xMax = mid + 0.4; }
    var yMax = Math.max(0.04, Math.max.apply(null, L.map(function (c) { return c.metrics.engagement; })) * 1.15);
    var maxV = Math.max.apply(null, L.map(function (c) { return c.metrics.avgViews || 1; }));
    var X = function (v) { return m.l + (v - xMin) / (xMax - xMin) * iw; };
    var Y = function (v) { return m.t + ih - v / yMax * ih; };
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Mapa de canais: inscritos contra engajamento">';
    for (var t = 0; t <= 4; t++) {
      var yv = yMax * t / 4;
      s += '<line class="gridl" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(yv) + '" y2="' + Y(yv) + '"/><text x="' + (m.l - 8) + '" y="' + (Y(yv) + 3) + '" text-anchor="end">' + pct(yv, yv < 0.1 ? 1 : 0) + "</text>";
    }
    for (var e = Math.ceil(xMin); e <= Math.floor(xMax); e++) {
      s += '<line class="gridl" y1="' + m.t + '" y2="' + (H - m.b) + '" x1="' + X(e) + '" x2="' + X(e) + '"/><text x="' + X(e) + '" y="' + (H - m.b + 16) + '" text-anchor="middle">' + fmtN(Math.pow(10, e)) + "</text>";
    }
    s += '<line class="ax" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + (H - m.b) + '" y2="' + (H - m.b) + '"/><line class="ax" x1="' + m.l + '" x2="' + m.l + '" y1="' + m.t + '" y2="' + (H - m.b) + '"/>';
    s += '<text x="' + (m.l + iw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">INSCRITOS →</text>';
    s += '<text transform="translate(12 ' + (m.t + ih / 2) + ') rotate(-90)" text-anchor="middle">ENGAJAMENTO →</text>';
    var xm = median(xs), ym = median(L.map(function (c) { return c.metrics.engagement; }));
    s += '<line class="med" x1="' + X(xm) + '" x2="' + X(xm) + '" y1="' + m.t + '" y2="' + (H - m.b) + '"/><line class="med" y1="' + Y(ym) + '" y2="' + Y(ym) + '" x1="' + m.l + '" x2="' + (W - m.r) + '"/>';
    s += '<text class="quad" x="' + (m.l + 8) + '" y="' + (m.t + 12) + '">gemas</text><text class="quad" x="' + (W - m.r - 8) + '" y="' + (m.t + 12) + '" text-anchor="end">estrelas</text>';
    var sorted = L.slice().sort(function (a, b) { return b.metrics.avgViews - a.metrics.avgViews; }); // grandes atrás
    sorted.forEach(function (c) {
      var r = 5 + 17 * Math.sqrt((c.metrics.avgViews || 0) / maxV);
      var cls = "mr-bub" + (isPartner(c) ? " partner" : "") + (S.compare.indexOf(c.channel_id) >= 0 ? " sel" : "");
      s += '<circle class="' + cls + '" data-id="' + esc(c.channel_id) + '" cx="' + X(Math.log(c.subscribers) / Math.LN10).toFixed(1) + '" cy="' + Y(c.metrics.engagement).toFixed(1) + '" r="' + r.toFixed(1) + '" style="--o:' + (0.12 + (c.score || 0) / 100 * 0.6).toFixed(2) + '"/>';
    });
    L.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 5).forEach(function (c, rank) {
      var x = X(Math.log(c.subscribers) / Math.LN10), y = Y(c.metrics.engagement), left = x > W * 0.72;
      // Anel de mira nos 5 melhores; o primeiro pulsa.
      var rr = 5 + 17 * Math.sqrt((c.metrics.avgViews || 0) / maxV) + 6;
      s += '<circle class="' + (rank === 0 ? "hud-pulse" : "") + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + rr.toFixed(1) + '" fill="none" style="stroke:var(--accent);pointer-events:none" stroke-opacity="' + (rank === 0 ? 0.9 : 0.35) + '" stroke-width="1.2" stroke-dasharray="' + (rank === 0 ? "none" : "3 4") + '"/>';
      s += '<text x="' + (left ? x - 12 : x + 12) + '" y="' + (y - 10) + '" text-anchor="' + (left ? "end" : "start") + '" style="fill:var(--text);font-size:11px;pointer-events:none">' + esc(String(c.title).slice(0, 18)) + "</text>";
    });
    el.innerHTML = s + "</svg>";
  }

  function radarSvg(list, size) {
    var W = size, H = size, cx = W / 2, cy = H / 2 + 4, R = size / 2 - 52, n = AXES.length;
    var P = function (i, v) { var a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * R * v / 100, cy + Math.sin(a) * R * v / 100]; };
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Comparação por critério">';
    // "Dial" externo: marcas ao redor do radar, maiores a cada 5.
    for (var tk = 0; tk < 72; tk++) {
      var ta = tk * 2 * Math.PI / 72, big = tk % 6 === 0, r0 = R * 1.045, r1 = R * (big ? 1.1 : 1.075);
      s += '<line x1="' + (cx + Math.cos(ta) * r0).toFixed(1) + '" y1="' + (cy + Math.sin(ta) * r0).toFixed(1) + '" x2="' + (cx + Math.cos(ta) * r1).toFixed(1) + '" y2="' + (cy + Math.sin(ta) * r1).toFixed(1) + '" style="stroke:var(--border-strong)" stroke-width="' + (big ? 1.4 : 1) + '"/>';
    }
    [25, 50, 75, 100].forEach(function (lv) {
      s += '<polygon points="' + AXES.map(function (a, i) { return P(i, lv).map(function (v) { return v.toFixed(1); }).join(","); }).join(" ") + '" style="fill:none;stroke:var(--border-strong);stroke-width:1;' + (lv < 100 ? "stroke-dasharray:2 4;" : "") + '"/>';
    });
    AXES.forEach(function (a, i) {
      var p = P(i, 100), q = P(i, 118), anchor = q[0] < cx - 6 ? "end" : q[0] > cx + 6 ? "start" : "middle";
      s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + p[0].toFixed(1) + '" y2="' + p[1].toFixed(1) + '" class="ax"/><text x="' + q[0].toFixed(1) + '" y="' + (q[1] + 3).toFixed(1) + '" text-anchor="' + anchor + '" style="font-size:10px">' + esc(a.short || a.label) + "</text>";
    });
    list.forEach(function (c, k) {
      var pts = AXES.map(function (a, i) { return P(i, c.ax[a.key]).map(function (v) { return v.toFixed(1); }).join(","); }).join(" ");
      s += '<polygon class="hud-glow" points="' + pts + '" style="color:' + COLORS[k % 4] + ";fill:" + COLORS[k % 4] + ";fill-opacity:.16;stroke:" + COLORS[k % 4] + ';stroke-width:2;stroke-linejoin:round"/>';
      AXES.forEach(function (a, i) { var p = P(i, c.ax[a.key]); s += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="5.5" fill="none" style="stroke:' + COLORS[k % 4] + '" stroke-opacity=".3"/><circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2.8" style="fill:' + COLORS[k % 4] + '"/>'; });
    });
    return s + "</svg>";
  }
  function radarTargets() {
    var sel = S.compare.map(function (id) { return S.channels.filter(function (c) { return c.channel_id === id; })[0]; }).filter(function (c) { return c && c.ok; });
    if (sel.length) return { list: sel, auto: false };
    var top = analyzed().slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 3);
    return { list: top, auto: true };
  }
  function drawRadar() {
    var t = radarTargets(), el = $("mr-radar-cmp");
    var size = clamp(($("mr-radar-cmp").clientWidth || 380), 300, 420);
    el.innerHTML = radarSvg(t.list, size);
    $("mr-radar-hint").textContent = t.auto ? "Mostrando os 3 melhores do ranking. Marque canais na tabela (até 4) para comparar quem você escolher." : "Comparação dos canais selecionados na tabela.";
    $("mr-radar-leg").innerHTML = t.list.map(function (c, k) { return '<span><i style="background:' + COLORS[k % 4] + '"></i>' + esc(String(c.title).slice(0, 26)) + " · " + c.score + "</span>"; }).join("");
  }
  function renderCharts() { drawBubbles(); drawRadar(); }

  /* ---- comparação direta ---- */
  var CMP_ROWS = [
    { label: "Score", get: function (c) { return c.score; }, fmt: function (v) { return v; }, hi: true },
    { label: "Inscritos", get: function (c) { return c.subscribers; }, fmt: fmtN, hi: true },
    { label: "Views médias (10 últimos)", get: function (c) { return c.metrics.avgViews; }, fmt: fmtN, hi: true },
    { label: "Mediana de views", get: function (c) { return c.metrics.medianViews; }, fmt: fmtN, hi: true },
    { label: "Engajamento", get: function (c) { return c.metrics.engagement; }, fmt: function (v) { return pct(v); }, hi: true },
    { label: "Posts por semana", get: function (c) { return c.metrics.perWeek; }, fmt: function (v) { return dec(v); }, hi: true },
    { label: "Semanas ativas (de 12)", get: function (c) { return c.metrics.activeWeeks; }, fmt: function (v) { return v; }, hi: true },
    { label: "Vídeos em 30 dias", get: function (c) { return c.metrics.in30; }, fmt: function (v) { return v; }, hi: true },
    { label: "Último vídeo (dias)", get: function (c) { return c.metrics.lastDays; }, fmt: function (v) { return v === 0 ? "hoje" : v; }, hi: false },
    { label: "Conteúdo sobre o tema", get: function (c) { return c.metrics.topicShare; }, fmt: function (v) { return pct(v, 0); }, hi: true },
    { label: "Views nos vídeos do tema", get: function (c) { return c.metrics.topicAvgViews; }, fmt: fmtN, hi: true },
    { label: "Links de afiliado nos vídeos", get: function (c) { return c.metrics.affShare; }, fmt: function (v) { return pct(v, 0); }, hi: true },
    { label: "Momentum", get: function (c) { return c.metrics.momentum; }, fmt: function (v) { return v == null ? "—" : dec(v) + "×"; }, hi: true },
    { label: "Shorts", get: function (c) { return c.metrics.shortsPct; }, fmt: function (v) { return pct(v, 0); }, hi: null },
    { label: "Duração média (vídeos longos)", get: function (c) { return c.metrics.avgDurMin; }, fmt: function (v) { return v == null ? "—" : dec(v) + " min"; }, hi: null }
  ];
  function renderCompare() {
    var sel = S.compare.map(function (id) { return S.channels.filter(function (c) { return c.channel_id === id; })[0]; }).filter(function (c) { return c && c.ok; });
    var panel = $("mr-cmp-panel");
    panel.hidden = sel.length < 2;
    if (sel.length < 2) return;
    $("mr-cmp-radar").innerHTML = radarSvg(sel, 340);
    var th = '<tr><th class="l">Métrica</th>' + sel.map(function (c, k) {
      return '<th class="l" style="color:' + COLORS[k % 4] + '">' + esc(String(c.title).slice(0, 28)) + "</th>";
    }).join("") + "</tr>";
    var body = CMP_ROWS.map(function (r) {
      var vals = sel.map(r.get), best = null;
      if (r.hi !== null) {
        var nums = vals.filter(function (v) { return v != null && isFinite(v); });
        if (nums.length > 1) best = r.hi ? Math.max.apply(null, nums) : Math.min.apply(null, nums);
        if (nums.length > 1 && nums.every(function (v) { return v === nums[0]; })) best = null;
      }
      return '<tr><td class="l muted">' + r.label + "</td>" + vals.map(function (v) {
        return '<td class="num' + (best != null && v === best ? " best" : "") + '">' + (v == null ? "—" : r.fmt(v)) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    $("mr-cmp-table").innerHTML = '<table class="mr-cmp"><thead>' + th + "</thead><tbody>" + body + "</tbody></table>";
  }

  /* ---- tabela ---- */
  var COLS = [
    { key: "cmp", label: "", cls: "mr-chk" },
    { key: "rank", label: "#", cls: "" },
    { key: "title", label: "Canal", cls: "l", sort: true },
    { key: "score", label: "Score", sort: true, tip: "Nota de 0 a 100 do potencial de parceria: média ponderada dos 6 critérios (ajuste os pesos em \"Calibrar critérios\")." },
    { key: "subs", label: "Inscritos", sort: true, tip: "Inscritos do canal." },
    { key: "avgViews", label: "Views médias", sort: true, tip: "Média de views dos últimos 10 vídeos." },
    { key: "eng", label: "Engaj.", sort: true, tip: "(Curtidas + comentários) ÷ views dos últimos 10 vídeos." },
    { key: "perWeek", label: "Posts/sem", sort: true, tip: "Posts por semana nos últimos 90 dias." },
    { key: "weeks", label: "12 semanas", sort: true, tip: "Uma barra por semana (da mais antiga à atual): altura = vídeos postados. Ordena por semanas com vídeo novo." },
    { key: "topic", label: "Tema", sort: true, tip: "Parte dos últimos 50 envios que fala das suas palavras-chave." },
    { key: "aff", label: "Afiliado", sort: true, tip: "Parte dos vídeos com links de plataformas de afiliado na descrição." },
    { key: "mom", label: "Momentum", sort: true, tip: "Views/dia dos 5 vídeos mais novos ÷ os 5 anteriores." },
    { key: "shorts", label: "Shorts", sort: true, tip: "Parte dos envios que são Shorts (até 3 min)." },
    { key: "tools", label: "Divulga", cls: "l", tip: "Plataformas e ferramentas mais citadas nas descrições dos vídeos (com link ou em 2+ vídeos). Abra o canal para ver tudo." },
    { key: "contact", label: "Contato", tip: "E-mail ou redes que o canal deixou públicos na descrição." },
    { key: "status", label: "Funil", tip: "Em que etapa da prospecção este canal está." }
  ];
  function sortVal(c, key) {
    var m = c.metrics || {};
    switch (key) {
      case "title": return String(c.title || "").toLowerCase();
      case "score": return c.score;
      case "subs": return c.subscribers;
      case "avgViews": return m.avgViews;
      case "eng": return m.engagement;
      case "perWeek": return m.perWeek;
      case "weeks": return m.activeWeeks;
      case "topic": return m.topicShare;
      case "aff": return m.affShare;
      case "mom": return m.momentum;
      case "shorts": return m.shortsPct;
    }
    return null;
  }
  function renderHead() {
    $("mr-head").innerHTML = "<tr>" + COLS.map(function (c) {
      var arrow = S.sort.key === c.key ? ' <span class="arrow">' + (S.sort.dir < 0 ? "↓" : "↑") + "</span>" : "";
      return '<th class="' + (c.sort ? "sortable " : "") + (c.cls || "") + '"' + (c.sort ? ' data-key="' + c.key + '"' : "") + (c.tip ? ' title="' + esc(c.tip) + '"' : "") + ">" + c.label + arrow + "</th>";
    }).join("") + "</tr>";
  }
  function spark(weekly) {
    var max = Math.max.apply(null, weekly.concat([1]));
    return '<svg class="mr-spark" width="64" height="20" viewBox="0 0 64 20" aria-hidden="true">' + weekly.map(function (v, i) {
      var h = v ? Math.max(3, v / max * 18) : 2;
      return '<rect class="' + (v ? "" : "z") + '" x="' + (i * 5.4).toFixed(1) + '" y="' + (20 - h).toFixed(1) + '" width="4" height="' + h.toFixed(1) + '" rx="1"/>';
    }).join("") + "</svg>";
  }
  function divulgaCell(c) {
    if (toolsOf(c) === null) return '<span class="muted" title="Varredura anterior ao rastreio de ferramentas">—</span>';
    var p = promoted(c);
    if (!p.length) return '<span class="muted">—</span>';
    var full = p.map(function (t) { return t.n + " (" + t.v + (t.l ? ", " + t.l + " com link" : "") + ")"; }).join(" · ");
    return '<span title="' + esc(full) + '">' + p.slice(0, 2).map(function (t) { return '<span class="mr-tool mini' + (FLOW_LIKE[t.c] ? " like" : "") + '">' + esc(t.n) + "</span>"; }).join("") +
      (p.length > 2 ? ' <span class="muted">+' + (p.length - 2) + "</span>" : "") + "</span>";
  }
  // Opções do filtro "divulga a ferramenta…", com quantos canais divulgam cada uma.
  function renderToolFilter() {
    var sel = $("mr-f-tool"), market = toolMarket();
    if (S.filter.tool && !market.some(function (t) { return t.n === S.filter.tool; })) S.filter.tool = "";
    sel.innerHTML = '<option value="">Divulga qualquer coisa</option>' + market.map(function (t) {
      return '<option value="' + esc(t.n) + '"' + (t.n === S.filter.tool ? " selected" : "") + ">Divulga " + esc(t.n) + " (" + t.ch + ")</option>";
    }).join("");
    sel.hidden = !market.length;
  }
  function visibleRows() {
    var f = S.filter, txt = f.text.trim().toLowerCase();
    var rows = analyzed().filter(function (c) {
      if (txt && String(c.title || "").toLowerCase().indexOf(txt) < 0 && String(c.handle || "").toLowerCase().indexOf(txt) < 0) return false;
      if (f.minSubs && !(c.subscribers >= f.minSubs)) return false;
      if (f.hidePartners && isPartner(c)) return false;
      if (f.onlyContact && !(c.contacts && ((c.contacts.emails || []).length || (c.contacts.links || []).length))) return false;
      if (f.status && statusOf(c) !== f.status) return false;
      if (f.tool && !promoted(c).some(function (t) { return t.n === f.tool; })) return false;
      return true;
    });
    var k = S.sort.key, d = S.sort.dir;
    rows.sort(function (a, b) {
      var x = sortVal(a, k), y = sortVal(b, k);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return x < y ? -d : x > y ? d : 0;
    });
    return rows;
  }
  function renderTable() {
    var rows = visibleRows(), total = analyzed().length;
    $("mr-count").textContent = rows.length === total ? total + " canais" : rows.length + " de " + total + " canais";
    var failed = S.channels.length - total;
    $("mr-body").innerHTML = rows.length ? rows.map(function (c, i) {
      var m = c.metrics, st = statusOf(c), hasMail = c.contacts && (c.contacts.emails || []).length, hasLink = c.contacts && (c.contacts.links || []).length;
      var cls = c.score >= 65 ? "" : c.score >= 45 ? " mid" : " low";
      var mom = m.momentum == null ? '<span class="mr-flat">—</span>' : m.momentum >= 1.1 ? '<span class="mr-up">▲ ' + dec(m.momentum) + "×</span>" : m.momentum <= 0.9 ? '<span class="mr-down">▼ ' + dec(m.momentum) + "×</span>" : '<span class="mr-flat">● ' + dec(m.momentum) + "×</span>";
      return '<tr class="mr-row' + (S.compare.indexOf(c.channel_id) >= 0 ? " sel" : "") + (st === "descartado" ? " dim" : "") + '" data-id="' + esc(c.channel_id) + '">' +
        '<td class="mr-chk"><input type="checkbox" data-cmp="' + esc(c.channel_id) + '"' + (S.compare.indexOf(c.channel_id) >= 0 ? " checked" : "") + ' aria-label="Comparar ' + esc(c.title) + '"></td>' +
        '<td class="num muted">' + (i + 1) + "</td>" +
        '<td class="l"><div class="mr-ch">' + avHtml(c) + '<div><div class="nm">' + esc(c.title) + (isPartner(c) ? '<span class="mr-badge p">parceiro</span>' : "") + '</div><div class="hd">' + esc(c.handle || "") + (c.country ? " · " + esc(c.country) : "") + "</div></div></div></td>" +
        '<td><div class="mr-score' + cls + '"><b>' + c.score + '</b><span class="mr-bar"><i style="width:' + c.score + '%"></i></span></div></td>' +
        '<td class="num">' + (c.hidden_subs ? '<span class="muted" title="O canal oculta os inscritos">oculto</span>' : fmtN(c.subscribers)) + "</td>" +
        '<td class="num">' + fmtN(m.avgViews) + "</td>" +
        '<td class="num">' + pct(m.engagement) + "</td>" +
        '<td class="num">' + dec(m.perWeek) + "</td>" +
        "<td>" + spark(m.weekly || []) + "</td>" +
        '<td class="num">' + pct(m.topicShare, 0) + "</td>" +
        '<td class="num">' + pct(m.affShare, 0) + "</td>" +
        '<td class="num">' + mom + "</td>" +
        '<td class="num">' + pct(m.shortsPct, 0) + "</td>" +
        '<td class="l mr-divulga">' + divulgaCell(c) + "</td>" +
        '<td class="num">' + (hasMail ? '<span title="E-mail público na descrição" class="mr-up">✉</span> ' : "") + (hasLink ? '<span title="Redes/links na descrição" class="muted">⌁</span>' : "") + (!hasMail && !hasLink ? '<span class="muted">—</span>' : "") + "</td>" +
        '<td><select class="mr-funnel s-' + st + '" data-status="' + esc(c.channel_id) + '" aria-label="Etapa do funil de ' + esc(c.title) + '">' + STATUS.map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === st ? " selected" : "") + ">" + s[1] + "</option>"; }).join("") + "</select></td></tr>";
    }).join("") : '<tr><td colspan="' + COLS.length + '" class="empty">Nenhum canal com esses filtros.</td></tr>';
    if (failed) $("mr-count").textContent += " · " + failed + " sem dados (erro na leitura)";
    renderDock();
  }
  function renderDock() {
    var sel = S.compare.map(function (id) { return S.channels.filter(function (c) { return c.channel_id === id; })[0]; }).filter(Boolean);
    $("mr-dock").innerHTML = sel.length
      ? "Comparando: " + sel.map(function (c, k) { return '<span class="mr-pill"><i style="background:' + COLORS[k % 4] + '"></i>' + esc(String(c.title).slice(0, 24)) + '<button type="button" data-cmp-del="' + esc(c.channel_id) + '" aria-label="Remover da comparação">×</button></span>'; }).join("") + (sel.length < 2 ? ' <span class="muted">(marque mais um para abrir a comparação direta)</span>' : "")
      : '<span class="muted">Marque até 4 canais na primeira coluna para compará-los lado a lado.</span>';
  }

  /* ---------------- seleção / funil ---------------- */
  function toggleCompare(id, on) {
    var i = S.compare.indexOf(id);
    if (on === undefined) on = i < 0;
    if (on && i < 0) {
      if (S.compare.length >= 4) { A.toast("Compare no máximo 4 canais por vez.", true); return false; }
      S.compare.push(id);
    } else if (!on && i >= 0) S.compare.splice(i, 1);
    renderCharts(); renderCompare(); renderDock();
    // Só marca a linha (redesenhar a tabela tiraria o foco do checkbox).
    document.querySelectorAll("#mr-body tr[data-id]").forEach(function (tr) {
      var on = S.compare.indexOf(tr.dataset.id) >= 0;
      tr.classList.toggle("sel", on);
      var cb = tr.querySelector("input[data-cmp]");
      if (cb) cb.checked = on;
    });
    return true;
  }
  async function setStatus(id, status) {
    var ch = S.channels.filter(function (c) { return c.channel_id === id; })[0];
    var prev = S.targets[id];
    var r;
    if (status === "novo") { delete S.targets[id]; r = await A.sb.from("market_targets").delete().eq("channel_id", id); }
    else { S.targets[id] = { channel_id: id, status: status }; r = await A.sb.from("market_targets").upsert({ channel_id: id, title: ch ? String(ch.title).slice(0, 200) : null, status: status, updated_at: new Date().toISOString() }, { onConflict: "channel_id" }); }
    if (r.error) {
      if (prev) S.targets[id] = prev; else delete S.targets[id];
      A.toast("Não foi possível salvar a etapa: " + r.error.message, true);
    }
    renderInsights(); renderTable();
    if (S.openId === id) renderDrawer(id);
  }

  /* ---------------- gaveta de detalhes ---------------- */
  function readout(c) {
    var m = c.metrics, L = analyzed(), items = [];
    var engMed = median(L.map(function (x) { return x.metrics.engagement; }));
    var tier = c.score >= 70 ? "Prioridade alta: bom em quase todos os critérios." : c.score >= 50 ? "Vale prospectar: pontos fortes claros, com algumas lacunas." : "Aderência baixa para parceria neste momento.";
    items.push({ t: tier });
    items.push({ t: "Média de <b>" + fmtInt(m.avgViews) + "</b> views nos últimos 10 vídeos" + (c.subscribers ? " (" + dec(m.avgViews / c.subscribers * 100, 1) + "% da base inscrita assiste)" : "") + "." });
    items.push({ t: "Engajamento de <b>" + pct(m.engagement) + "</b>" + (engMed ? ", " + dec(m.engagement / engMed) + "× a mediana desta varredura" : "") + "." });
    items.push({ t: "Posta <b>" + dec(m.perWeek) + "×</b> por semana e teve vídeo novo em <b>" + m.activeWeeks + " das últimas 12 semanas</b>." });
    items.push({ t: "<b>" + pct(m.topicShare, 0) + "</b> dos últimos " + m.videos + " vídeos falam das suas palavras-chave (" + m.topicCount + " vídeos" + (m.topicAvgViews != null ? ", média de " + fmtN(m.topicAvgViews) + " views neles" : "") + ")." });
    if (m.affShare > 0) items.push({ t: "<b>" + pct(m.affShare, 0) + "</b> das descrições têm links de plataformas de afiliado: já divulga produtos de terceiros." });
    if (m.adsShare > 0) items.push({ t: "<b>" + pct(m.adsShare, 0) + "</b> dos vídeos tratam de Google Ads / tráfego pago." });
    var T = toolsOf(c);
    if (T === null) items.push({ t: "Esta varredura é anterior ao rastreio de plataformas e ferramentas. Rode uma nova varredura para ver o que o canal divulga." });
    else {
      var prom = promoted(c);
      var plat = prom.filter(function (t) { return PLATFORM_CATS.indexOf(t.c) >= 0; });
      var sim = prom.filter(function (t) { return FLOW_LIKE[t.c]; });
      var other = prom.filter(function (t) { return PLATFORM_CATS.indexOf(t.c) < 0 && !FLOW_LIKE[t.c]; });
      if (plat.length) items.push({ t: "Divulga as plataformas " + toolList(plat, 4) + "." });
      if (other.length) items.push({ t: "Também indica ferramentas como " + toolList(other, 4) + "." });
      if (sim.length) items.push({ t: "Já divulga ferramentas parecidas com as da Flow: " + sim.slice(0, 4).map(function (t) { return "<b>" + esc(t.n) + "</b> (" + FLOW_LIKE[t.c] + ")"; }).join(", ") + ". Vale confirmar exclusividade antes de propor parceria.", warn: true });
      if (!prom.length) items.push({ t: "Não encontrei links nem menções repetidas a plataformas de afiliados ou ferramentas nas descrições dos vídeos recentes." });
    }
    if (m.momentum != null) items.push({ t: m.momentum >= 1.1 ? "Em alta: vídeos novos rendem <b>" + dec(m.momentum) + "×</b> mais views/dia que os anteriores." : m.momentum <= 0.9 ? "Em queda: vídeos novos rendem <b>" + dec(m.momentum) + "×</b> das views/dia dos anteriores." : "Desempenho estável nos vídeos recentes.", warn: m.momentum <= 0.9 });
    if (m.lastDays > 30) items.push({ t: "Atenção: o último vídeo saiu há <b>" + m.lastDays + " dias</b>.", warn: true });
    if (m.engagement != null && m.engagement < 0.01) items.push({ t: "Atenção: engajamento abaixo de 1%.", warn: true });
    if (c.hidden_subs) items.push({ t: "O canal oculta o número de inscritos.", warn: true });
    return items;
  }
  // Chips das plataformas/ferramentas citadas, por categoria. Número = vídeos que citam; 🔗 = com link.
  function toolsSection(c) {
    var T = toolsOf(c);
    if (T === null) return "";
    var body = "";
    TOOL_CATS.forEach(function (cat) {
      var items = T.filter(function (t) { return t.c === cat[0]; });
      if (!items.length) return;
      body += '<div class="mr-tgrp"><span class="mr-tcat">' + esc(cat[1]) + (FLOW_LIKE[cat[0]] ? " · parecido com " + FLOW_LIKE[cat[0]] : "") + "</span>" +
        items.map(function (t) {
          return '<span class="mr-tool' + (FLOW_LIKE[t.c] ? " like" : "") + (t.c === "ads" ? " soft" : "") + '" title="' + esc(t.n) + ": citado em " + t.v + " de " + c.metrics.videos + " vídeos" + (t.l ? ", com link em " + t.l : ", sem link") + '">' +
            esc(t.n) + " <small>" + t.v + (t.l ? " · " + t.l + " 🔗" : "") + "</small></span>";
        }).join("") + "</div>";
    });
    var links = (c.metrics.links || []).map(function (l) { return '<span class="mr-tool soft" title="Domínio que aparece em ' + l.v + ' vídeos">' + esc(l.h) + " <small>" + l.v + "</small></span>"; }).join("");
    if (links) body += '<div class="mr-tgrp"><span class="mr-tcat">Outros links frequentes</span>' + links + "</div>";
    if (!body) body = '<span class="muted" style="font-size:12.5px;">Nenhuma plataforma ou ferramenta conhecida nas descrições dos últimos ' + c.metrics.videos + " vídeos.</span>";
    return '<div class="mr-d-sec"><h4>Ferramentas e parceiros que divulga</h4>' + body +
      '<p class="mr-hint" style="margin:8px 0 0;">Lido das descrições e títulos dos últimos ' + c.metrics.videos + " vídeos. Só aparece o que está na lista de plataformas conhecidas e nos links; menção falada no vídeo não é detectada.</p></div>";
  }

  function openDrawer(id) {
    var c = S.channels.filter(function (x) { return x.channel_id === id; })[0];
    if (!c || !c.ok) return;
    S.openId = id;
    renderDrawer(id);
    $("mr-drawer").classList.add("on"); $("mr-scrim").classList.add("on"); $("mr-drawer").setAttribute("aria-hidden", "false");
  }
  function closeDrawer() {
    S.openId = null;
    if ($("mr-drawer")) { $("mr-drawer").classList.remove("on"); $("mr-drawer").setAttribute("aria-hidden", "true"); }
    if ($("mr-scrim")) $("mr-scrim").classList.remove("on");
  }
  function renderDrawer(id) {
    var c = S.channels.filter(function (x) { return x.channel_id === id; })[0];
    if (!c) return;
    var m = c.metrics, st = statusOf(c), ct = c.contacts || {};
    var cls = c.score >= 65 ? "" : c.score >= 45 ? "warn" : "crit";
    var stat = function (label, v) { return "<div><small>" + label + "</small><b>" + v + "</b></div>"; };
    var vids = (c.top_videos || []).map(function (v) {
      return '<div class="mr-vid"><a href="' + vidUrl(v.id) + '" target="_blank" rel="noopener noreferrer">' + esc(v.title) + "</a><span>" + fmtN(v.views) + " · " + fmtDate(v.ms) + "</span></div>";
    }).join("");
    var found = (c.sample_videos || []).map(function (v) {
      return '<div class="mr-vid"><a href="' + vidUrl(v.id) + '" target="_blank" rel="noopener noreferrer">' + esc(v.title) + "</a></div>";
    }).join("");
    var links = (ct.links || []).filter(function (u) { return /^https:\/\//i.test(u); }).map(function (u) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u.replace(/^https:\/\/(www\.)?/, "")) + "</a>"; }).join("");
    var mails = (ct.emails || []).map(function (e) { return '<a href="mailto:' + esc(e) + '">' + esc(e) + "</a>"; }).join("");
    $("mr-drawer").innerHTML =
      '<div class="mr-d-top"><button class="btn btn-primary" type="button" data-expand="' + esc(c.channel_id) + '" title="Abre uma tela completa com todas as informações e os últimos vídeos deste canal">⤢ Expandir pesquisa</button><button class="btn btn-ghost mr-d-close" id="mr-d-close" type="button" aria-label="Fechar">✕</button></div>' +
      '<div class="mr-d-head">' + avHtml(c) + '<div><h3>' + esc(c.title) + (isPartner(c) ? '<span class="mr-badge p">parceiro</span>' : "") + '</h3><div class="sub">' + esc(c.handle || "") + (c.country ? " · " + esc(c.country) : "") + (c.channel_created ? " · desde " + new Date(c.channel_created).getFullYear() : "") + "</div></div></div>" +
      '<div class="mr-d-score"><div class="mr-ring ' + cls + '" style="--p:' + c.score + '"><div><b>' + c.score + "</b><span>SCORE</span></div></div><div class=\"mr-d-axes\">" +
        AXES.map(function (a) { return '<div title="' + esc(a.tip) + '"><span>' + a.label + '</span><span class="mr-bar"><i style="width:' + Math.round(c.ax[a.key]) + '%"></i></span><b>' + Math.round(c.ax[a.key]) + "</b></div>"; }).join("") + "</div></div>" +
      '<div class="mr-d-stats">' + stat("Inscritos", c.hidden_subs ? "oculto" : fmtN(c.subscribers)) + stat("Views médias", fmtN(m.avgViews)) + stat("Engajamento", pct(m.engagement)) +
        stat("Posts/semana", dec(m.perWeek)) + stat("Vídeos em 30 d", m.in30) + stat("Shorts", pct(m.shortsPct, 0)) + "</div>" +
      '<div class="mr-d-sec"><h4>Leitura do radar</h4><ul class="mr-d-list">' + readout(c).map(function (i) { return "<li" + (i.warn ? ' class="warn"' : "") + ">" + i.t + "</li>"; }).join("") + "</ul></div>" +
      toolsSection(c) +
      '<div class="mr-d-sec"><h4>Etapa do funil</h4><select class="mr-funnel s-' + st + '" data-status="' + esc(c.channel_id) + '" aria-label="Etapa do funil">' + STATUS.map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === st ? " selected" : "") + ">" + s[1] + "</option>"; }).join("") + "</select> " +
        '<button class="btn" type="button" data-cmp-add="' + esc(c.channel_id) + '">' + (S.compare.indexOf(c.channel_id) >= 0 ? "Remover da comparação" : "Adicionar à comparação") + "</button> " +
        '<a class="btn" href="' + chUrl(c.channel_id) + '" target="_blank" rel="noopener noreferrer">Abrir canal ↗</a></div>' +
      (mails || links ? '<div class="mr-d-sec"><h4>Contato público</h4><div class="mr-links">' + mails + links + "</div></div>" : "") +
      (vids ? '<div class="mr-d-sec"><h4>' + (c.top_videos[0] && c.top_videos[0].topic ? "Vídeos de destaque sobre o tema" : "Vídeos mais vistos") + "</h4>" + vids + "</div>" : "") +
      (found ? '<div class="mr-d-sec"><h4>Apareceu na busca por: ' + esc((c.hit_keywords || []).join(", ")) + "</h4>" + found + "</div>" : "") +
      (c.description ? '<div class="mr-d-sec"><h4>Descrição do canal</h4><div class="mr-desc">' + esc(c.description.slice(0, 500)) + "</div></div>" : "");
  }

  /* ---------------- CSV ---------------- */
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function exportCsv() {
    var rows = visibleRows();
    var head = ["Canal", "Handle", "URL", "Score", "Inscritos", "Views médias", "Engajamento", "Posts por semana", "Semanas ativas", "% sobre o tema", "% links de afiliado", "Momentum", "% Shorts", "Último vídeo (dias)", "Divulga", "E-mail", "Etapa"];
    var out = [head.map(csvCell).join(",")];
    rows.forEach(function (c) {
      var m = c.metrics;
      out.push([c.title, c.handle, chUrl(c.channel_id), c.score, c.subscribers, m.avgViews, m.engagement, m.perWeek, m.activeWeeks, m.topicShare, m.affShare, m.momentum, m.shortsPct, m.lastDays, promoted(c).map(function (t) { return t.n; }).join("; "), ((c.contacts || {}).emails || []).join(" "), statusOf(c)].map(csvCell).join(","));
    });
    var blob = new Blob(["﻿" + out.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "radar-de-mercado.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* ---------------- eventos ---------------- */
  function bind() {
    $("mr-form").addEventListener("submit", function (e) { e.preventDefault(); runScan(); });
    $("mr-solo").addEventListener("submit", function (e) { e.preventDefault(); runSolo(); });
    $("mr-pick").addEventListener("click", function (e) {
      var b = e.target.closest("[data-pick]");
      if (!b || S.running || !S.picks) return;
      var c = S.picks[Number(b.dataset.pick)];
      if (c) scanSolo(c);
    });
    $("mr-q").addEventListener("input", renderEstimate);
    ["mr-depth", "mr-lang", "mr-since"].forEach(function (id) { $(id).addEventListener("change", renderEstimate); });
    $("mr-chips").addEventListener("click", function (e) {
      var b = e.target.closest(".mr-chip");
      if (!b) return;
      var kws = parseKeywords($("mr-q").value), key = b.dataset.kw.toLowerCase();
      var has = kws.some(function (k) { return k.toLowerCase() === key; });
      kws = has ? kws.filter(function (k) { return k.toLowerCase() !== key; }) : kws.concat([b.dataset.kw]).slice(0, 5);
      $("mr-q").value = kws.join(", ");
      renderEstimate();
    });
    $("mr-scan-sel").addEventListener("change", function () {
      openScan(this.value).catch(function (e) { A.toast("Erro ao abrir varredura: " + (e.message || e), true); });
    });
    $("mr-csv").addEventListener("click", exportCsv);
    $("mr-del").addEventListener("click", async function () {
      if (!S.scan || !confirm("Apagar esta varredura e seus resultados? A etapa do funil de cada canal é mantida.")) return;
      var r = await A.sb.from("market_scans").delete().eq("id", S.scan.id);
      if (r.error) { A.toast("Não foi possível apagar: " + r.error.message, true); return; }
      await loadScans(); renderGauge(); renderEstimate();
      S.scan = null; S.channels = []; S.compare = [];
      if (S.scans.length) await openScan(S.scans[0].id);
      else { $("mr-empty").hidden = false; $("mr-results").hidden = true; renderResults(); }
    });
    $("mr-cmp-clear").addEventListener("click", function () { S.compare = []; renderCharts(); renderCompare(); renderTable(); });

    $("mr-cal-body").addEventListener("input", function (e) {
      var k = e.target.dataset.w;
      if (!k) return;
      S.weights[k] = Number(e.target.value);
      if (!AXES.some(function (a) { return S.weights[a.key] > 0; })) { S.weights[k] = 1; e.target.value = 1; }
      rescore(); refreshWeightLabels(); saveWeights(); renderAnalysis();
    });
    $("mr-cal-body").addEventListener("click", function (e) {
      if (e.target.id !== "mr-w-reset") return;
      S.weights = Object.assign({}, DEFAULT_W); saveWeights(); rescore(); renderCalibration(); renderAnalysis();
    });

    $("mr-f-text").addEventListener("input", function () { S.filter.text = this.value; renderTable(); });
    $("mr-f-subs").addEventListener("change", function () { S.filter.minSubs = Number(this.value); renderTable(); });
    $("mr-f-status").addEventListener("change", function () { S.filter.status = this.value; renderTable(); });
    $("mr-f-tool").addEventListener("change", function () { S.filter.tool = this.value; renderTable(); });
    $("mr-f-partners").addEventListener("change", function () { S.filter.hidePartners = this.checked; renderTable(); });
    $("mr-f-contact").addEventListener("change", function () { S.filter.onlyContact = this.checked; renderTable(); });

    $("mr-head").addEventListener("click", function (e) {
      var th = e.target.closest("th.sortable");
      if (!th) return;
      var k = th.dataset.key;
      S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === "title" ? 1 : -1) };
      renderHead(); renderTable();
    });
    $("mr-body").addEventListener("click", function (e) {
      if (e.target.closest("select")) return;
      var cb = e.target.closest("input[data-cmp]");
      if (cb) { if (!toggleCompare(cb.dataset.cmp, cb.checked)) cb.checked = false; return; }
      var tr = e.target.closest("tr[data-id]");
      if (tr) openDrawer(tr.dataset.id);
    });
    $("mr-body").addEventListener("change", function (e) {
      var sel = e.target.closest("select[data-status]");
      if (sel) setStatus(sel.dataset.status, sel.value);
    });
    $("mr-body").addEventListener("mouseover", function (e) {
      var tr = e.target.closest("tr[data-id]");
      document.querySelectorAll(".mr-bub.hl").forEach(function (b) { b.classList.remove("hl"); });
      if (!tr) return;
      var b = document.querySelector('.mr-bub[data-id="' + tr.dataset.id + '"]');
      if (b) b.classList.add("hl");
    });

    $("mr-cards").addEventListener("click", function (e) {
      var o = e.target.closest("[data-open]");
      if (o) return openDrawer(o.dataset.open);
      var c = e.target.closest("[data-cmp-add]");
      if (c) toggleCompare(c.dataset.cmpAdd, true);
    });
    var drawer = $("mr-drawer");
    drawer.addEventListener("click", function (e) {
      if (e.target.closest("#mr-d-close")) return closeDrawer();
      var ex = e.target.closest("[data-expand]");
      if (ex) return openFull(ex.dataset.expand);
      var c = e.target.closest("[data-cmp-add]");
      if (c) { toggleCompare(c.dataset.cmpAdd); renderDrawer(c.dataset.cmpAdd); }
    });
    drawer.addEventListener("change", function (e) {
      var sel = e.target.closest("select[data-status]");
      if (sel) setStatus(sel.dataset.status, sel.value);
    });
    $("mr-dock").addEventListener("click", function (e) {
      var d = e.target.closest("[data-cmp-del]");
      if (d) toggleCompare(d.dataset.cmpDel, false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (S.full) closeFull(); else if (S.openId) closeDrawer();
    });
    bindFull();

    var tip = $("mr-tip"), bub = $("mr-bubbles");
    bub.addEventListener("mousemove", function (e) {
      var circ = e.target.closest("circle[data-id]");
      if (!circ) { tip.style.display = "none"; return; }
      var c = S.channels.filter(function (x) { return x.channel_id === circ.dataset.id; })[0];
      if (!c) return;
      var m = c.metrics, box = $("view-mercado").getBoundingClientRect();
      tip.innerHTML = "<b>" + esc(c.title) + "</b><div><span>Score</span>" + c.score + "</div><div><span>Inscritos</span>" + fmtN(c.subscribers) + "</div><div><span>Views médias</span>" + fmtN(m.avgViews) + "</div><div><span>Engajamento</span>" + pct(m.engagement) + "</div><div><span>Posts/semana</span>" + dec(m.perWeek) + "</div>";
      tip.style.display = "block";
      var x = e.clientX - box.left + 14, y = e.clientY - box.top + 14;
      if (x + 270 > box.width) x = e.clientX - box.left - 270;
      tip.style.left = Math.max(x, 4) + "px"; tip.style.top = y + "px";
    });
    bub.addEventListener("mouseleave", function () { tip.style.display = "none"; });
    bub.addEventListener("click", function (e) {
      var circ = e.target.closest("circle[data-id]");
      if (circ) openDrawer(circ.dataset.id);
    });

    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (visible() && S.channels.length) renderCharts(); }, 150);
    });
    window.addEventListener("flow-theme-change", function () { if (visible() && S.channels.length) { renderCharts(); renderCompare(); } });
  }
  function visible() { return A && A.root && !A.root.hidden; }

  /* ---------------- Tela completa ("Expandir pesquisa") ---------------- */
  var DAY_MS = 86400000;
  var DOW = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  var VIDEO_FILTERS = [["all", "Todos"], ["long", "Vídeos"], ["short", "Shorts"], ["topic", "Sobre o tema"], ["tools", "Divulgam algo"]];
  function chById(id) { return S.channels.filter(function (c) { return c.channel_id === id; })[0]; }
  function fullChannel() { return S.full ? chById(S.full.id) : null; }

  // Vídeos da tela completa, com os números de cada um (views por dia, engajamento, tipo).
  function fullVideos(c) {
    var now = Date.now();
    return (c.recent || []).map(function (v) {
      var age = Math.max((now - v.ms) / DAY_MS, 0), short = v.dur != null && v.dur > 0 && v.dur <= 180;
      var eng = v.views > 0 && v.likes != null ? ((v.likes || 0) + (v.comments || 0)) / v.views : null;
      return Object.assign({}, v, { age: age, short: short, eng: eng, vpd: v.views / Math.max(age, 1) });
    });
  }
  function fmtDur(s) {
    if (s == null) return "—";
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60, p = function (n) { return n < 10 ? "0" + n : n; };
    return h ? h + ":" + p(m) + ":" + p(sec) : m + ":" + p(sec);
  }
  function ago(days) { return days < 1 ? "hoje" : Math.floor(days) === 1 ? "há 1 dia" : "há " + fmtInt(Math.floor(days)) + " dias"; }
  function sumOf(arr, fn) { return arr.reduce(function (s, x) { return s + (fn(x) || 0); }, 0); }
  function aggVideos(list) {
    var views = sumOf(list, function (v) { return v.views; }), inter = sumOf(list, function (v) { return (v.likes || 0) + (v.comments || 0); });
    return { n: list.length, avgViews: list.length ? views / list.length : null, avgLikes: list.length ? sumOf(list, function (v) { return v.likes; }) / list.length : null,
      avgComments: list.length ? sumOf(list, function (v) { return v.comments; }) / list.length : null, eng: views ? inter / views : null };
  }

  async function openFull(id) {
    var c = chById(id);
    if (!c || !c.ok) return;
    closeDrawer();
    S.full = { id: id, filter: "all", sort: { key: "date", dir: -1 }, text: "" };
    $("mr-full").hidden = false;
    document.body.classList.add("mr-noscroll");
    $("mr-full").scrollTop = 0;
    renderFullBar(c);
    $("mr-full-body").innerHTML = '<p class="mr-hint" style="padding:30px 0;text-align:center">Carregando os vídeos do canal…</p>';
    if (!c.recent) {
      try {
        var r = await A.sb.from("market_channels").select("recent_videos").eq("scan_id", c.scan_id).eq("channel_id", id).maybeSingle();
        c.recent = (r.data && r.data.recent_videos) || [];
      } catch (e) { c.recent = []; }
    }
    if (S.full && S.full.id === id) renderFull(c);
  }
  function closeFull() {
    S.full = null;
    if ($("mr-full")) $("mr-full").hidden = true;
    document.body.classList.remove("mr-noscroll");
  }

  function renderFullBar(c) {
    $("mr-full-title").textContent = c.title;
    var inCmp = S.compare.indexOf(c.channel_id) >= 0, st = statusOf(c);
    $("mr-full-acts").innerHTML =
      '<select class="mr-funnel s-' + st + '" data-status="' + esc(c.channel_id) + '" aria-label="Etapa do funil">' + STATUS.map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === st ? " selected" : "") + ">" + s[1] + "</option>"; }).join("") + "</select>" +
      '<button class="btn" type="button" data-full-cmp="' + esc(c.channel_id) + '">' + (inCmp ? "✓ Na comparação" : "Comparar") + "</button>" +
      '<button class="btn" type="button" data-full-csv="1">Exportar vídeos (CSV)</button>' +
      '<button class="btn" type="button" data-full-refresh="1" title="Relê o canal e os últimos 50 vídeos no YouTube (gasta cerca de 3 unidades da cota)">↻ Atualizar dados</button>' +
      '<a class="btn btn-primary" href="' + chUrl(c.channel_id) + '" target="_blank" rel="noopener noreferrer">Abrir no YouTube ↗</a>';
  }

  function marketMedianAx() {
    var med = {};
    AXES.forEach(function (a) { med[a.key] = median(analyzed().map(function (c) { return c.ax[a.key]; })); });
    return med;
  }
  // Posição do canal entre os analisados nesta varredura (1 = melhor).
  function rankOf(c, get, higher) {
    var vals = analyzed().map(get).filter(function (v) { return v != null && isFinite(v); });
    var mine = get(c);
    if (mine == null || !isFinite(mine)) return null;
    var better = vals.filter(function (v) { return higher ? v > mine : v < mine; }).length;
    return { rank: better + 1, of: vals.length, median: median(vals) };
  }
  var FULL_CMP = [
    { label: "Score de parceria", get: function (c) { return c.score; }, fmt: function (v) { return fmtInt(v); }, hi: true },
    { label: "Inscritos", get: function (c) { return c.subscribers; }, fmt: fmtN, hi: true },
    { label: "Views médias (10 últimos)", get: function (c) { return c.metrics.avgViews; }, fmt: fmtN, hi: true },
    { label: "Engajamento", get: function (c) { return c.metrics.engagement; }, fmt: function (v) { return pct(v); }, hi: true },
    { label: "Posts por semana", get: function (c) { return c.metrics.perWeek; }, fmt: function (v) { return dec(v); }, hi: true },
    { label: "Semanas ativas (de 12)", get: function (c) { return c.metrics.activeWeeks; }, fmt: function (v) { return fmtInt(v); }, hi: true },
    { label: "Conteúdo sobre o tema", get: function (c) { return c.metrics.topicShare; }, fmt: function (v) { return pct(v, 0); }, hi: true },
    { label: "Vídeos com link de afiliado", get: function (c) { return c.metrics.affShare; }, fmt: function (v) { return pct(v, 0); }, hi: true },
    { label: "Momentum", get: function (c) { return c.metrics.momentum; }, fmt: function (v) { return dec(v) + "×"; }, hi: true },
    { label: "Último vídeo (dias atrás)", get: function (c) { return c.metrics.lastDays; }, fmt: function (v) { return v === 0 ? "hoje" : fmtInt(v); }, hi: false }
  ];

  function kpiF(label, value, sub, tip) {
    return '<div class="mr-fk"' + (tip ? ' title="' + esc(tip) + '"' : "") + "><small>" + label + '</small><b class="num">' + value + "</b>" + (sub ? "<span>" + sub + "</span>" : "") + "</div>";
  }

  function renderFull(c) {
    var m = c.metrics, vids = fullVideos(c), hasVids = vids.length > 0, st = statusOf(c);
    renderFullBar(c);
    var cls = c.score >= 65 ? "" : c.score >= 45 ? "warn" : "crit";
    var age = c.channel_created ? Math.max(0, Math.floor((Date.now() - Date.parse(c.channel_created)) / DAY_MS / 365.25 * 10) / 10) : null;
    var viewsPerSub = c.subscribers ? m.avgViews / c.subscribers : null;

    var hero =
      '<section class="mr-fsec mr-fhero">' + avHtml(c, "lg") +
        '<div class="mr-fhero-main"><h2>' + esc(c.title) + (isPartner(c) ? '<span class="mr-badge p">parceiro</span>' : "") + (st !== "novo" ? '<span class="mr-badge k">' + esc(STATUS.filter(function (s) { return s[0] === st; })[0][1]) + "</span>" : "") + "</h2>" +
          '<div class="sub">' + esc(c.handle || "") + (c.country ? " · " + esc(c.country) : "") + (c.channel_created ? " · no YouTube desde " + new Date(c.channel_created).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }) + (age != null ? " (" + dec(age) + " anos)" : "") : "") + "</div>" +
          '<div class="sub">Dados lidos em ' + (c.analyzed_at ? esc(fmtDateTime(c.analyzed_at)) : "—") + " · aparece na busca por: " + esc((c.hit_keywords || []).join(", ") || "—") + "</div></div>" +
        '<div class="mr-fhero-score"><div class="mr-ring ' + cls + '" style="--p:' + c.score + '"><div><b>' + c.score + "</b><span>SCORE</span></div></div></div>" +
      "</section>";

    var kpis = '<section class="mr-fsec"><h3>Números do canal</h3><div class="mr-fkpis">' +
      kpiF("Inscritos", c.hidden_subs ? "oculto" : fmtInt(c.subscribers), c.subscribers ? fmtN(c.subscribers) : "", "Inscritos do canal.") +
      kpiF("Views do canal", fmtN(c.total_views), fmtInt(c.total_views), "Visualizações de todos os vídeos desde a criação.") +
      kpiF("Vídeos publicados", fmtInt(c.video_count), "no canal todo") +
      kpiF("Views por inscrito", viewsPerSub == null ? "—" : dec(viewsPerSub * 100, 1) + "%", "views médias ÷ inscritos", "Quanto da base inscrita assiste cada vídeo recente.") +
      kpiF("Views médias", fmtInt(m.avgViews), "últimos 10 vídeos") +
      kpiF("Mediana de views", fmtInt(m.medianViews), "últimos 10 vídeos", "Não se distorce quando um vídeo viraliza.") +
      kpiF("Engajamento", pct(m.engagement), "(curtidas + comentários) ÷ views") +
      kpiF("Posts por semana", dec(m.perWeek), m.in30 + " nos últimos 30 dias") +
      kpiF("Semanas com vídeo", m.activeWeeks + " de 12", "regularidade") +
      kpiF("Último vídeo", m.lastDays === 0 ? "hoje" : m.lastDays + " dias", "atrás") +
      kpiF("Shorts", pct(m.shortsPct, 0), "dos últimos " + m.videos + " envios") +
      kpiF("Duração média", m.avgDurMin == null ? "—" : dec(m.avgDurMin) + " min", "vídeos longos") +
      kpiF("Momentum", m.momentum == null ? "—" : dec(m.momentum) + "×", "views/dia recentes vs. anteriores", "Views por dia dos 5 vídeos mais novos ÷ os 5 anteriores.") +
      kpiF("Sobre o tema", pct(m.topicShare, 0), m.topicCount + " de " + m.videos + " vídeos") +
      kpiF("Views no tema", m.topicAvgViews == null ? "—" : fmtN(m.topicAvgViews), "média dos vídeos do tema") +
      kpiF("Engajamento no tema", pct(m.topicEngagement), "só nos vídeos do tema") +
      kpiF("Links de afiliado", pct(m.affShare, 0), "dos vídeos") +
      kpiF("Fala de anúncios", pct(m.adsShare, 0), "Google Ads / tráfego pago") +
      "</div></section>";

    var med = marketMedianAx();
    var read =
      '<div class="mr-f2"><section class="mr-fsec"><h3>Leitura do radar</h3><ul class="mr-d-list">' + readout(c).map(function (i) { return "<li" + (i.warn ? ' class="warn"' : "") + ">" + i.t + "</li>"; }).join("") + "</ul>" +
        '<div class="mr-d-axes" style="margin-top:14px">' + AXES.map(function (a) { return '<div title="' + esc(a.tip) + '"><span>' + a.label + '</span><span class="mr-bar"><i style="width:' + Math.round(c.ax[a.key]) + '%"></i></span><b>' + Math.round(c.ax[a.key]) + "</b></div>"; }).join("") + "</div></section>" +
      '<section class="mr-fsec"><h3>Canal × mediana do mercado</h3><p class="mr-hint">Verde: este canal. Azul: a mediana dos canais desta varredura em cada critério.</p><div class="mr-chart" id="mr-full-radar"></div>' +
        '<div class="mr-legend"><span><i style="background:var(--accent)"></i>' + esc(String(c.title).slice(0, 30)) + '</span><span><i style="background:var(--accent-3)"></i>Mediana do mercado</span></div></section></div>';

    var cmp = '<section class="mr-fsec"><h3>Posição na varredura <small class="muted">(' + analyzed().length + " canais)</small></h3><div class=\"table-scroll\"><table class=\"mr-cmp\"><thead><tr><th class=\"l\">Métrica</th><th>Este canal</th><th>Mediana do mercado</th><th class=\"l\">Posição</th></tr></thead><tbody>" +
      FULL_CMP.map(function (r) {
        var rk = rankOf(c, r.get, r.hi), mine = r.get(c);
        if (!rk) return '<tr><td class="l muted">' + r.label + '</td><td class="num">—</td><td class="num">—</td><td class="l">—</td></tr>';
        var pctPos = rk.of > 1 ? (rk.of - rk.rank) / (rk.of - 1) * 100 : 100;
        return '<tr><td class="l muted">' + r.label + '</td><td class="num">' + r.fmt(mine) + '</td><td class="num">' + (rk.median == null ? "—" : r.fmt(rk.median)) + '</td><td class="l"><span class="mr-rank"><span class="mr-bar"><i style="width:' + pctPos.toFixed(0) + '%"></i></span><b>' + rk.rank + "º de " + rk.of + "</b></span></td></tr>";
      }).join("") + "</tbody></table></div></section>";

    var noVids = '<div class="mr-fnote">Esta varredura é anterior ao detalhamento por vídeo. Clique em <b>↻ Atualizar dados</b> (cerca de 3 unidades da cota) para carregar os últimos 50 vídeos deste canal com as métricas de cada um.</div>';
    var charts = '<section class="mr-fsec"><h3>Desempenho dos últimos ' + vids.length + ' vídeos</h3>' + (hasVids ?
      '<p class="mr-hint">Cada barra é um vídeo, do mais antigo (esquerda) ao mais novo. Verde: fala do tema; cinza: outros assuntos; barras mais claras são Shorts. A linha pontilhada é a mediana de views. Clique numa barra para abrir o vídeo.</p><div class="mr-chart mr-vchart" id="mr-full-views"></div>' : noVids) + "</section>";

    var cadence = '<div class="mr-f2"><section class="mr-fsec"><h3>Cadência de postagem</h3>' + (hasVids ? '<p class="mr-hint">Vídeos por semana nas últimas 12 semanas (a última barra é a semana atual).</p><div class="mr-chart" id="mr-full-weekly"></div>' : noVids) + "</section>" +
      '<section class="mr-fsec"><h3>Dia da semana que publica</h3>' + (hasVids ? '<p class="mr-hint">Nos últimos ' + vids.length + ' vídeos, horário de Brasília.</p><div class="mr-chart" id="mr-full-dow"></div>' : noVids) + "</section></div>";

    var groups = "";
    if (hasVids) {
      var longs = vids.filter(function (v) { return !v.short; }), shorts = vids.filter(function (v) { return v.short; });
      var topics = vids.filter(function (v) { return v.topic; }), others = vids.filter(function (v) { return !v.topic; });
      var row = function (label, a) {
        return "<tr><td class=\"l\">" + label + '</td><td class="num">' + a.n + '</td><td class="num">' + (a.avgViews == null ? "—" : fmtN(a.avgViews)) + '</td><td class="num">' + (a.avgLikes == null ? "—" : fmtN(a.avgLikes)) + '</td><td class="num">' + (a.avgComments == null ? "—" : fmtN(a.avgComments)) + '</td><td class="num">' + pct(a.eng) + "</td></tr>";
      };
      groups = '<section class="mr-fsec"><h3>Comparativos entre os vídeos</h3><div class="table-scroll"><table class="mr-cmp"><thead><tr><th class="l">Grupo</th><th>Vídeos</th><th>Views médias</th><th>Curtidas médias</th><th>Comentários médios</th><th>Engajamento</th></tr></thead><tbody>' +
        row("Vídeos longos", aggVideos(longs)) + row("Shorts", aggVideos(shorts)) + row("Falam do tema", aggVideos(topics)) + row("Outros assuntos", aggVideos(others)) + row("Todos", aggVideos(vids)) + "</tbody></table></div></section>";
    }

    var best = "";
    if (hasVids) {
      var byViews = vids.slice().sort(function (a, b) { return b.views - a.views; }).slice(0, 4);
      var byEng = vids.filter(function (v) { return v.eng != null && v.views >= 100; }).sort(function (a, b) { return b.eng - a.eng; }).slice(0, 4);
      var card = function (v, metric) {
        return '<a class="mr-vcard" href="' + vidUrl(v.id) + '" target="_blank" rel="noopener noreferrer"><img src="https://i.ytimg.com/vi/' + encodeURIComponent(v.id) + '/mqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer"><div><b>' + esc(v.title) + '</b><span>' + metric + " · " + fmtDate(v.ms) + (v.short ? " · Short" : "") + "</span></div></a>";
      };
      best = '<div class="mr-f2"><section class="mr-fsec"><h3>Mais vistos</h3><div class="mr-vcards">' + byViews.map(function (v) { return card(v, fmtInt(v.views) + " views"); }).join("") + "</div></section>" +
        '<section class="mr-fsec"><h3>Maior engajamento</h3><div class="mr-vcards">' + (byEng.map(function (v) { return card(v, pct(v.eng) + " · " + fmtInt(v.views) + " views"); }).join("") || '<span class="muted">Sem vídeos com dados suficientes.</span>') + "</div></section></div>";
    }

    var table = '<section class="mr-fsec"><h3>Últimos vídeos postados</h3>' + (hasVids ?
      '<div class="mr-tools" id="mr-full-vtools"></div><div class="table-scroll"><table class="mr-table mr-vtable"><thead id="mr-full-vhead"></thead><tbody id="mr-full-vbody"></tbody></table></div><p class="mr-hint" id="mr-full-vcount"></p>' : noVids) + "</section>";

    var ct = c.contacts || {};
    var mails = (ct.emails || []).map(function (e) { return '<a href="mailto:' + esc(e) + '">' + esc(e) + "</a>"; }).join("");
    var links = (ct.links || []).filter(function (u) { return /^https:\/\//i.test(u); }).map(function (u) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u.replace(/^https:\/\/(www\.)?/, "")) + "</a>"; }).join("");
    var found = (c.sample_videos || []).map(function (v) { return '<div class="mr-vid"><a href="' + vidUrl(v.id) + '" target="_blank" rel="noopener noreferrer">' + esc(v.title) + "</a></div>"; }).join("");
    var about = '<div class="mr-f2"><section class="mr-fsec">' + (toolsSection(c) || '<h3>Ferramentas e parceiros que divulga</h3><p class="mr-hint">Sem dados nesta varredura.</p>') + "</section>" +
      '<section class="mr-fsec"><h3>Contato e sobre o canal</h3>' + (mails || links ? '<div class="mr-links" style="margin-bottom:12px">' + mails + links + "</div>" : '<p class="mr-hint">Nenhum contato público na descrição.</p>') +
        (c.description ? '<div class="mr-desc mr-desc-full">' + esc(c.description) + "</div>" : "") +
        (found ? '<h4 class="mr-sub-h">Apareceu na busca com estes vídeos</h4>' + found : "") + "</section></div>";

    $("mr-full-body").innerHTML = hero + kpis + read + cmp + charts + cadence + groups + best + table + about +
      '<p class="mr-hint" style="text-align:center">Dados da YouTube Data API: estatísticas públicas do canal e dos últimos 50 vídeos. "Divulga" é lido de títulos, descrições e links, e não de falas dentro dos vídeos.</p>';

    $("mr-full-radar").innerHTML = radarSvg([c, { ax: med }], clamp($("mr-full-radar").clientWidth || 380, 300, 460));
    if (hasVids) { drawFullViews(c, vids); drawFullWeekly(m.weekly || []); drawFullDow(vids); renderFullVideoTools(c); renderFullVideoTable(c); }
  }

  /* gráficos da tela completa */
  function drawFullViews(c, vids) {
    var el = $("mr-full-views"), list = vids.slice().reverse(); // antigo → novo
    var W = Math.max(el.clientWidth || 800, 320), H = 250, mg = { l: 50, r: 12, t: 12, b: 30 }, iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    var max = Math.max.apply(null, list.map(function (v) { return v.views; }).concat([1])) * 1.08;
    var medV = median(list.map(function (v) { return v.views; }));
    var bw = iw / list.length, Y = function (v) { return mg.t + ih - v / max * ih; };
    var accC = FlowHud.tok("--accent"), mutC = FlowHud.tok("--text-muted");
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Views de cada vídeo"><defs>' + FlowHud.seg("vseg", W, H, mg.t + ih) + FlowHud.vgrad("vgT", accC, 1, 0.5) + FlowHud.vgrad("vgO", mutC, 0.95, 0.4) + "</defs>";
    for (var t = 0; t <= 4; t++) { var yv = max * t / 4; s += '<line class="gridl" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + Y(yv) + '" y2="' + Y(yv) + '"/><text x="' + (mg.l - 8) + '" y="' + (Y(yv) + 3) + '" text-anchor="end">' + fmtN(yv) + "</text>"; }
    s += '<line class="ax" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + (H - mg.b) + '" y2="' + (H - mg.b) + '"/>' + FlowHud.ruler(mg.l + bw / 2, W - mg.r - bw / 2, H - mg.b + 1, Math.max(list.length - 1, 1), 5, mutC);
    var bodies = "", tops = "";
    list.forEach(function (v, i) {
      var h = Math.max(1.5, v.views / max * ih), x = mg.l + i * bw + bw * 0.14, w = Math.max(2, bw * 0.72);
      bodies += '<rect class="mr-vbar' + (v.topic ? " topic" : "") + (v.short ? " short" : "") + '" data-i="' + i + '" x="' + x.toFixed(1) + '" y="' + (mg.t + ih - h).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="url(#' + (v.topic ? "vgT" : "vgO") + ')"/>';
      tops += '<rect class="hud-glow" style="color:' + (v.topic ? accC : mutC) + ';pointer-events:none;opacity:' + (v.short ? 0.55 : 1) + '" x="' + x.toFixed(1) + '" y="' + (mg.t + ih - h).toFixed(1) + '" width="' + w.toFixed(1) + '" height="2" rx="1" fill="' + (v.topic ? accC : mutC) + '"/>';
    });
    s += '<g mask="url(#vseg)">' + bodies + "</g>" + tops;
    if (medV != null) s += '<line class="med" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + Y(medV) + '" y2="' + Y(medV) + '"/><text x="' + (W - mg.r) + '" y="' + (Y(medV) - 5) + '" text-anchor="end" style="fill:var(--text-dim)">mediana ' + fmtN(medV) + "</text>";
    [0, Math.floor((list.length - 1) / 2), list.length - 1].forEach(function (i, k) {
      if (!list[i]) return;
      s += '<text x="' + (mg.l + i * bw + bw / 2) + '" y="' + (H - 10) + '" text-anchor="' + (k === 0 ? "start" : k === 2 ? "end" : "middle") + '">' + new Date(list[i].ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + "</text>";
    });
    el.innerHTML = s + "</svg>";
    el._list = list;
  }
  function barChart(el, labels, values, opts) {
    opts = opts || {};
    var W = Math.max(el.clientWidth || 420, 280), H = 190, mg = { l: 30, r: 8, t: 14, b: 26 }, iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    var max = Math.max.apply(null, values.concat([1])), bw = iw / values.length, top = values.indexOf(max);
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(opts.label || "") + '">';
    for (var t = 0; t <= 2; t++) { var yv = Math.round(max * t / 2), y = mg.t + ih - yv / max * ih; s += '<line class="gridl" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + y + '" y2="' + y + '"/><text x="' + (mg.l - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + yv + "</text>"; }
    var accC = FlowHud.tok("--accent");
    // Matriz de pontos (um ponto por unidade), como nos painéis de referência; o dia mais cheio fica em destaque.
    var d = Math.max(3.5, Math.min(bw * 0.62, ih / max - 2.4, 15));
    values.forEach(function (v, i) {
      var cx = mg.l + i * bw + bw / 2, isTop = !opts.highlight || i === top, baseY = mg.t + ih, topY = baseY;
      for (var k = 0; k < v; k++) {
        var cy = baseY - d / 2 - 2 - k * (d + 2.4);
        topY = cy - d / 2;
        s += '<circle class="mr-dot' + (isTop ? "" : " soft") + (k === v - 1 ? " hud-glow" : "") + '" style="color:' + accC + '" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (d / 2).toFixed(1) + '"/>';
      }
      if (!v) s += '<line x1="' + (cx - d / 2).toFixed(1) + '" x2="' + (cx + d / 2).toFixed(1) + '" y1="' + (baseY - 1.5) + '" y2="' + (baseY - 1.5) + '" style="stroke:var(--border-strong)" stroke-width="2" stroke-linecap="round"/>';
      else s += '<text x="' + cx.toFixed(1) + '" y="' + (topY - 6).toFixed(1) + '" text-anchor="middle" style="fill:var(--text-dim)">' + v + "</text>";
      s += '<title>' + esc(labels[i] + ": " + v) + "</title>";
      s += '<text x="' + cx.toFixed(1) + '" y="' + (H - 9) + '" text-anchor="middle">' + esc(labels[i]) + "</text>";
    });
    el.innerHTML = s + "</svg>";
  }
  function drawFullWeekly(weekly) {
    var labels = weekly.map(function (_, i) { return i === weekly.length - 1 ? "atual" : "-" + (weekly.length - 1 - i); });
    barChart($("mr-full-weekly"), labels, weekly, { label: "Vídeos por semana" });
  }
  function drawFullDow(vids) {
    var counts = [0, 0, 0, 0, 0, 0, 0];
    vids.forEach(function (v) { counts[new Date(v.ms - 3 * 3600000).getUTCDay()]++; });
    barChart($("mr-full-dow"), DOW, counts, { label: "Vídeos por dia da semana", highlight: true });
  }

  /* tabela de vídeos */
  function renderFullVideoTools(c) {
    var f = S.full;
    $("mr-full-vtools").innerHTML = '<input type="search" id="mr-full-q" placeholder="Buscar no título…" aria-label="Buscar no título" value="' + esc(f.text) + '">' +
      VIDEO_FILTERS.map(function (x) { return '<button type="button" class="pay-chip' + (f.filter === x[0] ? " on" : "") + '" data-vf="' + x[0] + '" aria-pressed="' + (f.filter === x[0]) + '">' + x[1] + "</button>"; }).join("");
  }
  var VCOLS = [
    ["title", "Vídeo", "l"], ["date", "Publicado", "l"], ["dur", "Duração", ""], ["views", "Views", ""], ["likes", "Curtidas", ""],
    ["comments", "Comentários", ""], ["eng", "Engaj.", ""], ["vpd", "Views/dia", ""], ["tools", "Divulga", "l"]
  ];
  function renderFullVideoTable(c) {
    var f = S.full, q = f.text.trim().toLowerCase();
    var list = fullVideos(c).filter(function (v) {
      if (q && String(v.title).toLowerCase().indexOf(q) < 0) return false;
      if (f.filter === "long") return !v.short;
      if (f.filter === "short") return v.short;
      if (f.filter === "topic") return v.topic;
      if (f.filter === "tools") return (v.tools || []).some(function (t) { return t.c !== "ads"; });
      return true;
    });
    var key = f.sort.key, dir = f.sort.dir;
    var val = function (v) { return key === "date" ? v.ms : key === "title" ? String(v.title).toLowerCase() : key === "tools" ? (v.tools || []).filter(function (t) { return t.c !== "ads"; }).length : v[key]; };
    list.sort(function (a, b) {
      var x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return x < y ? -dir : x > y ? dir : 0;
    });
    $("mr-full-vhead").innerHTML = "<tr>" + VCOLS.map(function (col) {
      var arrow = f.sort.key === col[0] ? ' <span class="arrow">' + (dir < 0 ? "↓" : "↑") + "</span>" : "";
      return '<th class="sortable ' + col[2] + '" data-vs="' + col[0] + '">' + col[1] + arrow + "</th>";
    }).join("") + "</tr>";
    $("mr-full-vbody").innerHTML = list.length ? list.map(function (v) {
      var tools = (v.tools || []).filter(function (t) { return t.c !== "ads"; });
      return "<tr><td class=\"l\"><div class=\"mr-vt\"><img src=\"https://i.ytimg.com/vi/" + encodeURIComponent(v.id) + "/mqdefault.jpg\" alt=\"\" loading=\"lazy\" referrerpolicy=\"no-referrer\"><div><a href=\"" + vidUrl(v.id) + "\" target=\"_blank\" rel=\"noopener noreferrer\">" + esc(v.title) + "</a><div>" +
        (v.short ? '<span class="mr-badge k">Short</span>' : "") + (v.topic ? '<span class="mr-badge p">tema</span>' : "") + "</div></div></div></td>" +
        '<td class="l num">' + fmtDate(v.ms) + '<div class="muted" style="font-family:inherit;font-size:11px">' + ago(v.age) + "</div></td>" +
        '<td class="num">' + fmtDur(v.dur) + '</td><td class="num">' + fmtInt(v.views) + '</td><td class="num">' + (v.likes == null ? "—" : fmtInt(v.likes)) + '</td><td class="num">' + (v.comments == null ? "—" : fmtInt(v.comments)) + '</td><td class="num">' + pct(v.eng) + '</td><td class="num">' + fmtN(v.vpd) + "</td>" +
        '<td class="l mr-divulga">' + (tools.length ? tools.slice(0, 4).map(function (t) { return '<span class="mr-tool mini' + (FLOW_LIKE[t.c] ? " like" : "") + '" title="' + (t.l ? "com link" : "só mencionado") + '">' + esc(t.n) + (t.l ? " 🔗" : "") + "</span>"; }).join("") : '<span class="muted">—</span>') + "</td></tr>";
    }).join("") : '<tr><td colspan="' + VCOLS.length + '" class="empty">Nenhum vídeo com esses filtros.</td></tr>';
    $("mr-full-vcount").textContent = list.length + " de " + (c.recent || []).length + " vídeos";
  }

  async function refreshFull() {
    var c = fullChannel();
    if (!c) return;
    var btn = document.querySelector("[data-full-refresh]");
    btn.disabled = true; btn.textContent = "Atualizando…";
    var r = await call({ action: "analyze", scanId: c.scan_id, channelIds: [c.channel_id], refresh: true });
    btn.disabled = false; btn.textContent = "↻ Atualizar dados";
    if (!r.ok) { A.toast("Não foi possível atualizar: " + (r.error || "erro"), true); return; }
    if (r.failed && r.failed[c.channel_id]) { A.toast("O YouTube recusou a leitura: " + r.failed[c.channel_id], true); return; }
    var fresh = await A.sb.from("market_channels").select(CHANNEL_COLS + ", recent_videos").eq("scan_id", c.scan_id).eq("channel_id", c.channel_id).maybeSingle();
    if (fresh.error || !fresh.data) { A.toast("Atualizado, mas não foi possível reler o canal.", true); return; }
    var rv = fresh.data.recent_videos || [];
    delete fresh.data.recent_videos;
    Object.assign(c, fresh.data);
    c.recent = rv;
    prepare();
    renderAnalysis();
    var keep = $("mr-full").scrollTop;
    renderFull(c);
    $("mr-full").scrollTop = keep;
    loadScans().then(renderGauge).catch(function () {});
    A.toast("Dados atualizados (" + (r.spent || 0) + " unidades de cota).");
  }

  function exportFullCsv() {
    var c = fullChannel();
    if (!c) return;
    var rows = [["Título", "URL", "Publicado", "Duração (s)", "Tipo", "Views", "Curtidas", "Comentários", "Engajamento", "Views por dia", "Sobre o tema", "Divulga"].map(csvCell).join(",")];
    fullVideos(c).forEach(function (v) {
      rows.push([v.title, vidUrl(v.id), new Date(v.ms).toISOString().slice(0, 10), v.dur, v.short ? "Short" : "Vídeo", v.views, v.likes, v.comments, v.eng == null ? "" : v.eng.toFixed(4), Math.round(v.vpd), v.topic ? "sim" : "não",
        (v.tools || []).filter(function (t) { return t.c !== "ads"; }).map(function (t) { return t.n + (t.l ? " (link)" : ""); }).join("; ")].map(csvCell).join(","));
    });
    var blob = new Blob(["﻿" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "videos-" + String(c.title).replace(/[^\w\-]+/g, "_").slice(0, 40) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function bindFull() {
    var box = $("mr-full");
    box.addEventListener("click", function (e) {
      if (e.target.closest("#mr-full-back")) return closeFull();
      var c = fullChannel();
      if (!c) return;
      var cmp = e.target.closest("[data-full-cmp]");
      if (cmp) { toggleCompare(c.channel_id); renderFullBar(c); return; }
      if (e.target.closest("[data-full-refresh]")) return refreshFull();
      if (e.target.closest("[data-full-csv]")) return exportFullCsv();
      var vf = e.target.closest("[data-vf]");
      if (vf) { S.full.filter = vf.dataset.vf; renderFullVideoTools(c); renderFullVideoTable(c); return; }
      var vs = e.target.closest("th[data-vs]");
      if (vs) { var k = vs.dataset.vs; S.full.sort = { key: k, dir: S.full.sort.key === k ? -S.full.sort.dir : (k === "title" ? 1 : -1) }; renderFullVideoTable(c); return; }
      var bar = e.target.closest(".mr-vbar[data-i]");
      if (bar) { var list = $("mr-full-views")._list, v = list && list[+bar.dataset.i]; if (v) window.open(vidUrl(v.id), "_blank", "noopener"); }
    });
    box.addEventListener("input", function (e) {
      if (e.target.id !== "mr-full-q" || !S.full) return;
      S.full.text = e.target.value;
      var c = fullChannel();
      if (c) renderFullVideoTable(c);
    });
    box.addEventListener("change", function (e) {
      var sel = e.target.closest("select[data-status]");
      if (!sel) return;
      sel.className = "mr-funnel s-" + sel.value;
      setStatus(sel.dataset.status, sel.value);
    });
    var tip = $("mr-full-tip");
    box.addEventListener("mousemove", function (e) {
      var bar = e.target.closest ? e.target.closest(".mr-vbar[data-i]") : null;
      if (!bar || !S.full) { tip.style.display = "none"; return; }
      var list = $("mr-full-views")._list, v = list && list[+bar.dataset.i];
      if (!v) return;
      tip.innerHTML = "<b>" + esc(v.title) + "</b><div><span>Publicado</span>" + fmtDate(v.ms) + "</div><div><span>Views</span>" + fmtInt(v.views) + "</div><div><span>Curtidas</span>" + (v.likes == null ? "—" : fmtInt(v.likes)) + "</div><div><span>Comentários</span>" + (v.comments == null ? "—" : fmtInt(v.comments)) + "</div><div><span>Engajamento</span>" + pct(v.eng) + "</div><div><span>Tipo</span>" + (v.short ? "Short" : "Vídeo") + (v.topic ? " · tema" : "") + "</div>";
      tip.style.display = "block";
      var x = e.clientX + 14, y = e.clientY + 14;
      if (x + 270 > window.innerWidth) x = e.clientX - 270;
      if (y + 190 > window.innerHeight) y = e.clientY - 190;
      tip.style.left = Math.max(x, 4) + "px"; tip.style.top = Math.max(y, 4) + "px";
    });
    box.addEventListener("mouseleave", function () { tip.style.display = "none"; });
    window.addEventListener("resize", function () {
      var c = fullChannel();
      if (!c || !c.recent || !c.recent.length || $("mr-full").hidden) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { var v = fullVideos(c); drawFullViews(c, v); drawFullWeekly(c.metrics.weekly || []); drawFullDow(v); $("mr-full-radar").innerHTML = radarSvg([c, { ax: marketMedianAx() }], clamp($("mr-full-radar").clientWidth || 380, 300, 460)); }, 150);
    });
    window.addEventListener("flow-theme-change", function () {
      var c = fullChannel();
      if (c && !$("mr-full").hidden) { var keep = $("mr-full").scrollTop; renderFull(c); $("mr-full").scrollTop = keep; }
    });
  }

  /* ---------------- API pública ---------------- */
  async function show() {
    if (!A) return;
    if (S.ready) { if (S.channels.length) renderCharts(); return; }
    if (S.loading) return;
    S.loading = true;
    try {
      await Promise.all([
        loadScans().catch(function (e) { console.warn("market_scans:", e); }),
        loadTargets().catch(function (e) { console.warn("market_targets:", e); }),
        loadWeights().catch(function (e) { console.warn("pesos:", e); })
      ]);
      renderGauge(); renderEstimate();
      var last = safeGet("mr_last_scan");
      var target = S.scans.filter(function (s) { return s.id === last; })[0] || S.scans.filter(function (s) { return s.status === "done"; })[0];
      if (target) await openScan(target.id);
      S.ready = true;
    } catch (e) {
      console.warn("Rastrear Mercado:", e);
      A.toast("Não foi possível carregar o histórico do radar: " + (e.message || e), true);
    } finally { S.loading = false; }
  }
  window.MarketRadar = {
    init: function (opts) { A = opts; build(opts.root); },
    show: show,
    hide: closeDrawer,
    refresh: function () { if (S.channels.length) renderAnalysis(); }
  };
})();
