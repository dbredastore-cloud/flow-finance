/* Dashboard do influencer (Influencers Flow): tela cheia com tudo do YouTube na vigência do contrato.
   Usa as classes visuais do radar (market-radar.css) e o kit HUD (flow-hud.js).
   Dados: contrato/vendas vêm do painel (getCtx); vídeos completos (com descrição) e a evolução diária do canal
   são lidos aqui, só ao abrir. */
window.InfluencerDash = (function () {
  "use strict";
  var A = null, S = null, bound = false;
  var DAY = 86400000, SHORT_MAX = 180;
  var MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  var DOW = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  // Mesma lista do radar (market-scan/analysis.js): FlowPages / FlowTracking / FlowSpy.
  var FLOW = [
    ["FlowPages", /\bflow[\s\-_.]*pages?(?![a-z])/i],
    ["FlowTracking", /\bflow[\s\-_.]*track(?:ing)?(?![a-z])/i],
    ["FlowSpy", /\bflow[\s\-_.]*spy(?![a-z])/i]
  ];
  var FLOW_HL = /\bflow[\s\-_.]*(?:pages?|track(?:ing)?|spy)(?![a-z])/gi;
  var URL_RE = /https?:\/\/[^\s)<>"']+/g;

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function sum(arr, fn) { return arr.reduce(function (s, x) { return s + (Number(fn(x)) || 0); }, 0); }
  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; }), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function fmtInt(v) { return v == null || isNaN(v) ? "—" : new Intl.NumberFormat("pt-BR").format(Math.round(v)); }
  function fmtN(v) {
    if (v == null || isNaN(v)) return "—";
    var a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(1).replace(".", ",") + " mi";
    if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(".", ",") + " mil";
    return String(Math.round(v));
  }
  function fmtBRL(v) { return v == null || isNaN(v) ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v); }
  function fmtDate(ms) { return ms ? new Date(ms).toLocaleDateString("pt-BR") : "—"; }
  function dec(v, d) { return v == null || isNaN(v) ? "—" : v.toFixed(d == null ? 1 : d).replace(".", ","); }
  function pct(v, d) { return v == null || isNaN(v) ? "—" : (v * 100).toFixed(d == null ? 1 : d).replace(".", ",") + "%"; }
  function ago(days) { return days < 1 ? "hoje" : Math.floor(days) === 1 ? "há 1 dia" : "há " + fmtInt(Math.floor(days)) + " dias"; }
  function fmtDur(s) {
    if (s == null) return "—";
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60, p = function (n) { return n < 10 ? "0" + n : n; };
    return h ? h + ":" + p(m) + ":" + p(sec) : m + ":" + p(sec);
  }
  function vidUrl(v) { return "https://www.youtube.com/" + (v.short ? "shorts/" : "watch?v=") + encodeURIComponent(v.video_id); }
  function kf(label, value, sub, tip) {
    return '<div class="mr-fk"' + (tip ? ' title="' + esc(tip) + '"' : "") + "><small>" + label + '</small><b class="num">' + value + "</b>" + (sub ? "<span>" + sub + "</span>" : "") + "</div>";
  }
  function hlFlow(text) { return esc(text).replace(FLOW_HL, function (m) { return "<mark>" + m + "</mark>"; }); }

  /* ---------------- modelo: vídeos na vigência ---------------- */
  function excerpt(text, re) {
    var m = re.exec(text);
    if (!m) return null;
    var a = Math.max(0, m.index - 80), b = Math.min(text.length, m.index + m[0].length + 110);
    return (a > 0 ? "…" : "") + text.slice(a, b).replace(/\s+/g, " ").trim() + (b < text.length ? "…" : "");
  }
  function flowOf(v) {
    var desc = String(v.description || ""), title = String(v.title || ""), urls = desc.match(URL_RE) || [], out = [];
    FLOW.forEach(function (f) {
      var d = excerpt(desc, f[1]), t = excerpt(title, f[1]);
      if (d || t) out.push({ n: f[0], w: d ? "d" : "t", x: (d || t).slice(0, 280), l: urls.some(function (u) { return f[1].test(u); }) });
    });
    return out;
  }
  function domainsOf(desc) {
    var seen = {}, out = [];
    (String(desc || "").match(URL_RE) || []).forEach(function (u) {
      var h = ""; try { h = new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return; }
      if (h && !seen[h] && !/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) { seen[h] = 1; out.push(h); }
    });
    return out;
  }

  function window_() {
    var c = S.ctx.c, now = new Date();
    var start = new Date(c.start_date + "T00:00:00"), end = c.end_date ? new Date(c.end_date + "T23:59:59") : null;
    return { start: start.getTime(), end: (end && end < now ? end : now).getTime(), ended: !!(end && end < now) };
  }
  function build() {
    var w = window_(), now = Date.now(), c = S.ctx.c;
    var vids = (S.videos || []).map(function (v) {
      var ms = Date.parse(v.published_at), short = v.is_short != null ? v.is_short : (v.duration_s != null && v.duration_s <= SHORT_MAX);
      var views = Number(v.views) || 0, age = Math.max((now - ms) / DAY, 0);
      var o = Object.assign({}, v, { ms: ms, short: short, views: views, age: age, vpd: views / Math.max(age, 1),
        eng: views > 0 && v.likes != null ? ((Number(v.likes) || 0) + (Number(v.comments) || 0)) / views : null });
      o.fx = flowOf(o); o.domains = domainsOf(v.description);
      o.inC = ms >= w.start && ms <= w.end;
      return o;
    }).filter(function (v) { return isFinite(v.ms); }).sort(function (a, b) { return b.ms - a.ms; });
    var inC = vids.filter(function (v) { return v.inC; });
    var oldest = vids.length ? vids[vids.length - 1].ms : null;
    var ch = S.ctx.channel ? S.ctx.channel.c : null;
    // Pode faltar vídeo antigo: o sync normal guarda só os 100 últimos envios.
    var incomplete = !!(ch && vids.length && oldest > w.start && (ch.video_count == null || vids.length < ch.video_count));
    return { w: w, vids: vids, inC: inC, oldest: oldest, incomplete: incomplete, c: c, ch: ch };
  }
  function agg(list) {
    var views = sum(list, function (v) { return v.views; }), inter = sum(list, function (v) { return (v.likes || 0) + (v.comments || 0); });
    return { n: list.length, views: views, avg: list.length ? views / list.length : null, med: median(list.map(function (v) { return v.views; })),
      likes: sum(list, function (v) { return v.likes; }), comments: sum(list, function (v) { return v.comments; }), eng: views ? inter / views : null };
  }

  /* ---------------- abrir / fechar ---------------- */
  function ensureShell() {
    if ($("fd-full")) return;
    var el = document.createElement("div");
    el.id = "fd-full"; el.hidden = true; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "Dashboard do influencer");
    el.innerHTML = '<div class="mr-full-bar"><button class="btn" id="fd-back" type="button">← Voltar aos contratos</button><span class="mr-full-title" id="fd-title"></span><div class="mr-full-acts" id="fd-acts"></div></div>' +
      '<div class="mr-full-body" id="fd-body"></div><div class="mr-tip" id="fd-tip"></div>';
    document.body.appendChild(el);
    bind();
  }
  async function open(contractId) {
    ensureShell();
    var ctx = A.getCtx(contractId);
    if (!ctx) return;
    S = { id: contractId, ctx: ctx, videos: null, snaps: [], scope: "contract", type: "all", text: "", sort: { key: "date", dir: -1 }, open: null, busy: false };
    $("fd-full").hidden = false; document.body.classList.add("mr-noscroll"); $("fd-full").scrollTop = 0;
    renderBar();
    $("fd-body").innerHTML = '<p class="mr-hint" style="padding:40px 0;text-align:center">Carregando os dados do canal…</p>';
    await load();
  }
  function close() {
    S = null;
    if ($("fd-full")) $("fd-full").hidden = true;
    document.body.classList.remove("mr-noscroll");
  }
  async function load() {
    var my = S, ch = my.ctx.channel && my.ctx.channel.c;
    if (ch && ch.channel_id) {
      var r = await Promise.all([
        A.sb.from("youtube_videos").select("video_id, title, published_at, duration_s, views, likes, comments, thumbnail_url, is_short, description, tags")
          .eq("channel_id", ch.channel_id).order("published_at", { ascending: false }).limit(600),
        A.sb.from("youtube_channel_snapshots").select("day, subscribers, total_views, video_count").eq("channel_id", ch.channel_id).order("day")
      ]);
      if (S !== my) return;
      my.videos = r[0].error ? [] : (r[0].data || []);
      my.snaps = r[1].error ? [] : (r[1].data || []);
      if (r[0].error) A.toast("Não foi possível ler os vídeos: " + r[0].error.message, true);
    } else my.videos = [];
    render();
  }

  function renderBar() {
    var a = S.ctx.a, ch = S.ctx.channel && S.ctx.channel.c;
    $("fd-title").textContent = a.name || a.email;
    $("fd-acts").innerHTML =
      (ch ? '<button class="btn" type="button" data-fd="refresh" title="Relê o canal e os últimos 100 vídeos no YouTube (cerca de 5 unidades da cota)">↻ Atualizar canal</button>' +
        '<button class="btn" type="button" data-fd="deep" title="Volta no tempo até o início do contrato (até 500 vídeos; poucas unidades da cota)">⏪ Buscar histórico do contrato</button>' +
        '<button class="btn" type="button" data-fd="csv">Exportar vídeos (CSV)</button>' : "") +
      '<button class="btn" type="button" data-fd="edit">Editar contrato</button>' +
      (ch ? '<a class="btn btn-primary" href="' + esc(A.channelUrl(ch)) + '" target="_blank" rel="noopener noreferrer">Abrir no YouTube ↗</a>' : "");
  }

  /* ---------------- tela ---------------- */
  function render() {
    if (!S) return;
    renderBar();
    var m = build(), c = m.c, a = S.ctx.a, info = S.ctx.info, ch = m.ch;
    var months = info.months, tot = months.reduce(function (t, r) {
      t.amount += r.amount; t.net += r.net; t.commission += r.commission; t.fixed += r.fixed; t.bonus += r.bonus; t.count += r.count; return t;
    }, { amount: 0, net: 0, commission: 0, fixed: 0, bonus: 0, count: 0 });
    var cost = tot.commission + tot.fixed + tot.bonus, result = tot.net - tot.fixed - tot.bonus;
    var period = new Date(c.start_date + "T12:00:00").toLocaleDateString("pt-BR") + (c.end_date ? " a " + new Date(c.end_date + "T12:00:00").toLocaleDateString("pt-BR") : " · sem data de fim");
    var body = "";

    /* herói */
    var thumb = ch && ch.thumbnail_url ? '<img class="mr-av lg" src="' + esc(ch.thumbnail_url) + '" alt="" referrerpolicy="no-referrer">' : '<span class="mr-av lg ph">YT</span>';
    body += '<section class="mr-fsec mr-fhero">' + thumb +
      '<div class="mr-fhero-main"><h2>' + esc(a.name || a.email) + '<span class="mr-badge ' + (m.w.ended ? "k" : "p") + '">' + (m.w.ended ? "contrato encerrado" : "contrato vigente") + "</span></h2>" +
      '<div class="sub">' + esc(a.email) + " · contrato " + period + "</div>" +
      '<div class="sub">' + (ch ? esc(ch.title || "") + (ch.handle ? " · " + esc(ch.handle) : "") + (ch.country ? " · " + esc(ch.country) : "") +
        (ch.channel_created ? " · no YouTube desde " + new Date(ch.channel_created).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }) : "") : "Canal do YouTube não cadastrado na ficha do influencer") + "</div>" +
      '<div class="sub">Fixo ' + fmtBRL(c.fixed_fee) + "/mês · comissão " + Number(c.commission_pct) + "% · bônus " + fmtBRL(c.bonus_amount) + " ao bater " + fmtInt(c.bonus_sales_target) + " vendas · por mês: " +
        c.stories_per_month + " stories, " + c.reels_per_month + " reels, " + c.youtube_per_month + " vídeo(s) no YouTube</div>" +
      '<div class="sub">' + S.ctx.socials + (ch && ch.fetched_at ? ' · dados do YouTube lidos em ' + new Date(ch.fetched_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "") + "</div></div></section>";

    /* resultado comercial */
    var vf = m.inC.filter(function (v) { return v.fx.length; });
    body += '<section class="mr-fsec"><h3>Resultado do contrato <small class="muted">vendas das ferramentas Flow na vigência</small></h3><div class="mr-fkpis">' +
      kf("Vendas", fmtInt(tot.count), "ferramentas Flow") + kf("Faturamento", fmtBRL(tot.amount), "valor cobrado do cliente") +
      kf("Comissão paga", fmtBRL(tot.commission), c.commission_pct + "% combinado") + kf("Fixo + bônus", fmtBRL(tot.fixed + tot.bonus), months.length + " mês(es) de contrato") +
      kf("Custo total", fmtBRL(cost), "fixo + comissão + bônus") +
      kf("Resultado", '<span class="' + (result >= 0 ? "good" : "bad") + '">' + fmtBRL(result) + "</span>", "líquido do produtor − fixo − bônus", "Líquido do produtor (já sem taxa e comissão) − fixo − bônus.") +
      kf("Custo por venda", tot.count ? fmtBRL(cost / tot.count) : "—", "custo total ÷ vendas") +
      kf("Meta do bônus", fmtInt(info.total) + " / " + fmtInt(c.bonus_sales_target), info.bonusMonth ? "🎉 meta batida" : "faltam " + fmtInt(Math.max(0, c.bonus_sales_target - info.total)) + " vendas") +
      "</div></section>";

    if (!ch) {
      body += '<section class="mr-fsec"><div class="mr-fnote">Este influencer não tem o link do canal do YouTube na ficha. Cadastre no menu <b>Influencers</b> (clique no nome) e depois clique em <b>Atualizar YouTube</b> para trazer vídeos, views e métricas.</div></section>';
      body += instaSection();
      $("fd-body").innerHTML = body;
      return;
    }

    /* aviso de histórico incompleto */
    if (m.incomplete) {
      body += '<div class="mr-fnote"><b>Histórico possivelmente incompleto.</b> Só temos os vídeos de ' + fmtDate(m.oldest) + " em diante, e o contrato começou em " + fmtDate(m.w.start) +
        '. Clique em <b>⏪ Buscar histórico do contrato</b> para trazer tudo desde o início (poucas unidades da cota do YouTube).</div>';
    }

    /* canal */
    var grow = growth(m);
    body += '<section class="mr-fsec"><h3>Canal agora</h3><div class="mr-fkpis">' +
      kf("Inscritos", ch.hidden_subs ? "oculto" : fmtInt(ch.subscribers), grow.subs, "Inscritos hoje. A variação desde o início do contrato usa o histórico diário que o painel grava a cada atualização.") +
      kf("Views do canal", fmtN(ch.total_views), grow.views || fmtInt(ch.total_views)) +
      kf("Envios no canal", fmtInt(ch.video_count), "vídeos + Shorts no total") +
      kf("Views por inscrito", ch.subscribers && S.ctx.channel.long.avgViews != null ? dec(S.ctx.channel.long.avgViews / ch.subscribers * 100, 1) + "%" : "—", "média dos últimos vídeos ÷ inscritos") +
      "</div></section>";

    /* vigência */
    var A_ = agg(m.inC), longs = m.inC.filter(function (v) { return !v.short; }), shorts = m.inC.filter(function (v) { return v.short; });
    var metaTotal = months.length * (c.youtube_per_month || 0);
    var best = m.inC.slice().sort(function (x, y) { return y.views - x.views; })[0];
    var fAgg = agg(vf), rest = agg(m.inC.filter(function (v) { return !v.fx.length; }));
    body += '<section class="mr-fsec"><h3>Na vigência do contrato <small class="muted">' + fmtDate(m.w.start) + " a " + fmtDate(m.w.end) + "</small></h3><div class=\"mr-fkpis\">" +
      kf("Vídeos publicados", fmtInt(A_.n), fmtInt(longs.length) + " vídeos · " + fmtInt(shorts.length) + " Shorts") +
      kf("Meta do YouTube", fmtInt(longs.length) + " / " + fmtInt(metaTotal), c.youtube_per_month + " por mês × " + months.length + " mês(es)", "Vídeos longos publicados (Shorts não contam) contra a meta mensal do contrato.") +
      kf("Views nesses vídeos", fmtN(A_.views), fmtInt(A_.views) + " no total", "Views de hoje dos vídeos publicados na vigência.") +
      kf("Média de views", fmtN(A_.avg), "por vídeo publicado") + kf("Mediana de views", fmtN(A_.med), "não distorce com vídeo viral") +
      kf("Curtidas", fmtN(A_.likes), fmtN(A_.n ? A_.likes / A_.n : null) + " por vídeo") + kf("Comentários", fmtN(A_.comments), fmtN(A_.n ? A_.comments / A_.n : null) + " por vídeo") +
      kf("Engajamento", pct(A_.eng), "(curtidas + comentários) ÷ views") +
      kf("Mais visto", best ? fmtN(best.views) : "—", best ? esc(String(best.title).slice(0, 38)) : "sem vídeos") +
      kf("Mencionam a Flow", fmtInt(vf.length) + " de " + fmtInt(A_.n), vf.length ? fmtN(fAgg.views) + " views nesses vídeos" : "nenhuma menção", "Vídeos com FlowPages, FlowTracking ou FlowSpy escrito no título ou na descrição.") +
      kf("Com menção × sem", fAgg.avg && rest.avg ? dec(fAgg.avg / rest.avg) + "×" : "—", "views médias dos que citam a Flow ÷ dos demais") +
      kf("Views por venda", tot.count ? fmtInt(A_.views / tot.count) : "—", "views da vigência ÷ vendas Flow") +
      "</div></section>";

    /* gráficos */
    body += '<section class="mr-fsec"><h3>Views de cada vídeo na vigência</h3>' + (m.inC.length ?
      '<p class="mr-hint">Do mais antigo (esquerda) ao mais novo. Amarelo: menciona a Flow; verde: vídeo; barras mais claras são Shorts. A linha pontilhada é a mediana. Clique numa barra para abrir o vídeo.</p><div class="mr-chart" id="fd-views"></div>' :
      '<div class="mr-fnote">Nenhum vídeo publicado na vigência entre os dados que temos.</div>') + "</section>";
    body += '<div class="mr-f2"><section class="mr-fsec"><h3>Vídeos por mês × meta</h3><p class="mr-hint">Verde: vídeos longos; cinza: Shorts; linha tracejada: meta mensal de vídeos do contrato.</p><div class="mr-chart" id="fd-months"></div></section>' +
      '<section class="mr-fsec"><h3>Vendas Flow por mês</h3><p class="mr-hint">Número de vendas das ferramentas Flow geradas por mês de contrato.</p><div class="mr-chart" id="fd-sales"></div></section></div>';
    body += '<div class="mr-f2"><section class="mr-fsec"><h3>Evolução do canal</h3>' + growthHint(m) + '<div class="mr-chart" id="fd-growth"></div></section>' +
      '<section class="mr-fsec"><h3>Dia da semana que publica</h3><p class="mr-hint">Vídeos da vigência por dia da semana (horário de Brasília).</p><div class="mr-chart" id="fd-dow"></div></section></div>';

    /* entregas por mês */
    body += '<section class="mr-fsec"><h3>Entregas por mês</h3><div class="table-scroll"><table class="mr-cmp"><thead><tr><th class="l">Mês</th><th>Vídeos</th><th>Shorts</th><th>Citam a Flow</th><th>Meta vídeos</th><th>Stories</th><th>Reels</th><th>Vendas Flow</th><th>Custo</th></tr></thead><tbody>' +
      months.slice().reverse().map(function (r) {
        var mv = monthVids(m, r), okV = mv.longs.length >= c.youtube_per_month;
        return "<tr" + (r.current ? ' class="fi-current"' : "") + '><td class="l">' + MONTHS[r.month - 1] + "/" + String(r.year).slice(2) + (r.current ? ' <span class="muted">(em andamento)</span>' : "") + "</td>" +
          '<td class="num">' + mv.longs.length + '</td><td class="num">' + mv.shorts.length + '</td><td class="num">' + mv.flow.length + '</td>' +
          '<td class="num"><span class="status ' + (okV ? "ok" : r.current ? "wait" : "bad") + '">' + mv.longs.length + "/" + c.youtube_per_month + '</span></td>' +
          '<td class="num"><span class="status ' + (r.okStories ? "ok" : r.current ? "wait" : "bad") + '">' + r.stories + "/" + c.stories_per_month + '</span></td>' +
          '<td class="num"><span class="status ' + (r.okReels ? "ok" : r.current ? "wait" : "bad") + '">' + r.reels + "/" + c.reels_per_month + '</span></td>' +
          '<td class="num">' + fmtInt(r.count) + '</td><td class="num">' + fmtBRL(r.cost) + "</td></tr>";
      }).join("") + '</tbody></table></div><p class="mr-hint">Stories e reels são lançados à mão na tela dos contratos (o Instagram ainda não é lido automaticamente). Vídeos e Shorts vêm do YouTube.</p></section>';

    /* menções à Flow */
    body += flowSection(m, vf);

    /* tabela */
    body += '<section class="mr-fsec"><h3>Vídeos do canal</h3><div class="mr-tools" id="fd-tools"></div><div class="table-scroll"><table class="mr-table mr-vtable"><thead id="fd-vhead"></thead><tbody id="fd-vbody"></tbody></table></div><p class="mr-hint" id="fd-vcount"></p></section>';

    /* instagram */
    body += instaSection();
    if (c.notes) body += '<section class="mr-fsec"><h3>Observações do contrato</h3><p style="margin:0;white-space:pre-wrap;color:var(--text-dim)">' + esc(c.notes) + "</p></section>";
    body += '<p class="mr-hint" style="text-align:center">Dados da YouTube Data API: estatísticas públicas do canal e dos vídeos. As views são as de hoje (não por período). "Menciona a Flow" é lido de título e descrição; o que é falado dentro do vídeo não é detectado.</p>';
    $("fd-body").innerHTML = body;

    if (m.inC.length) drawViews(m);
    drawMonths(m); drawSales(); drawGrowth(m); drawDow(m);
    renderTools(); renderTable();
  }

  function monthVids(m, r) {
    var a = new Date(r.year, r.month - 1, 1).getTime(), b = new Date(r.year, r.month, 1).getTime();
    var list = m.vids.filter(function (v) { return v.ms >= a && v.ms < b; });
    return { longs: list.filter(function (v) { return !v.short; }), shorts: list.filter(function (v) { return v.short; }), flow: list.filter(function (v) { return v.fx.length; }) };
  }

  /* crescimento do canal desde o início do contrato (a partir do histórico diário) */
  function growth(m) {
    var out = { subs: "", views: "" }, sn = S.snaps || [];
    if (!sn.length) return { subs: "histórico começa a ser gravado agora", views: "" };
    var first = sn.filter(function (s) { return Date.parse(s.day + "T12:00:00") >= m.w.start - DAY; })[0] || sn[0], last = sn[sn.length - 1];
    var d = Math.round((Date.parse(last.day + "T12:00:00") - Date.parse(first.day + "T12:00:00")) / DAY);
    if (sn.length < 2 || d < 1) return { subs: "histórico começa em " + new Date(first.day + "T12:00:00").toLocaleDateString("pt-BR"), views: "" };
    var ds = first.subscribers != null && last.subscribers != null ? last.subscribers - first.subscribers : null;
    var dv = first.total_views != null && last.total_views != null ? last.total_views - first.total_views : null;
    var since = new Date(first.day + "T12:00:00").toLocaleDateString("pt-BR");
    out.subs = ds == null ? "" : '<b class="' + (ds >= 0 ? "good" : "bad") + '">' + (ds >= 0 ? "+" : "") + fmtInt(ds) + "</b> desde " + since;
    out.views = dv == null ? "" : '<b class="good">+' + fmtN(dv) + "</b> desde " + since;
    return out;
  }
  function growthHint(m) {
    var sn = S.snaps || [];
    if (sn.length < 2) return '<div class="mr-fnote">A API do YouTube só informa os inscritos de hoje. O painel passou a gravar uma foto diária do canal: o gráfico aparece quando houver pelo menos dois dias de histórico' +
      (sn.length ? " (primeiro registro em " + new Date(sn[0].day + "T12:00:00").toLocaleDateString("pt-BR") + ")." : ".") + "</div>";
    return '<p class="mr-hint">Inscritos por dia, a partir do primeiro registro do painel.</p>';
  }

  /* ---------------- menções à Flow ---------------- */
  function flowSection(m, vf) {
    var names = FLOW.map(function (f) { return f[0]; });
    var head = '<section class="mr-fsec mr-flowsec"><h3>Menções às ferramentas Flow <small class="muted">FlowPages · FlowTracking · FlowSpy</small></h3>';
    var descMissing = m.vids.length && m.vids.every(function (v) { return v.description == null; });
    if (descMissing) return head + '<div class="mr-fnote">As descrições dos vídeos ainda não foram baixadas. Clique em <b>↻ Atualizar canal</b> para ler as descrições e achar as menções.</div></section>';
    var per = '<div class="mr-fkpis" style="margin-bottom:14px">' + names.map(function (n) {
      var list = vf.filter(function (v) { return v.fx.some(function (x) { return x.n === n; }); });
      return kf(n, list.length + (list.length === 1 ? " vídeo" : " vídeos"), list.length ? fmtN(sum(list, function (v) { return v.views; })) + " views" : "sem menção na vigência");
    }).join("") + "</div>";
    if (!vf.length) return head + per + '<p class="mr-hint">Nenhum vídeo da vigência escreve FlowPages, FlowTracking ou FlowSpy no título ou na descrição.</p></section>';
    return head + per + '<div class="mr-flowlist">' + vf.map(function (v) {
      var chips = v.fx.map(function (x) { return '<span class="mr-tool mini flow" title="' + (x.w === "d" ? "Escrito na descrição" : "Escrito no título") + (x.l ? ", dentro de um link" : "") + '">✓ ' + esc(x.n) + (x.l ? " 🔗" : "") + " <small>" + (x.w === "d" ? "descrição" : "título") + "</small></span>"; }).join("");
      var ex = v.fx.map(function (x) { return '<p class="mr-flowx"><span>' + (x.w === "d" ? "Na descrição" : "No título") + ":</span> " + hlFlow(x.x) + "</p>"; }).join("");
      return '<article class="mr-flowcard"><a class="mr-flowthumb" href="' + vidUrl(v) + '" target="_blank" rel="noopener noreferrer">' + (v.thumbnail_url ? '<img src="' + esc(v.thumbnail_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : "") + "</a>" +
        '<div class="mr-flowmain"><a class="mr-flowtitle" href="' + vidUrl(v) + '" target="_blank" rel="noopener noreferrer">' + esc(v.title) + "</a>" +
        '<div class="mr-flowmeta">' + fmtDate(v.ms) + " · " + ago(v.age) + (v.short ? " · Short" : "") + " · " + fmtDur(v.duration_s) + " · <b>" + fmtInt(v.views) + "</b> views · " +
          (v.likes == null ? "—" : fmtInt(v.likes)) + " curtidas · " + (v.comments == null ? "—" : fmtInt(v.comments)) + " comentários · engaj. " + pct(v.eng) + "</div>" +
        '<div class="mr-flowchips">' + chips + "</div>" + ex + "</div></article>";
    }).join("") + "</div></section>";
  }

  /* ---------------- Instagram ---------------- */
  function instaSection() {
    var ig = S.ctx.instagram;
    return '<section class="mr-fsec"><h3>Instagram <small class="muted">stories e reels</small></h3>' +
      '<p class="mr-hint" style="margin:0 0 8px">' + (ig ? 'Perfil informado na ficha: <a href="' + esc(ig) + '" target="_blank" rel="noopener noreferrer">' + esc(ig.replace(/^https?:\/\/(www\.)?/, "")) + "</a>." : "Nenhum Instagram informado na ficha do influencer.") + "</p>" +
      '<div class="mr-fnote">O Instagram ainda <b>não é lido automaticamente</b>: stories e reels entregues são lançados à mão na tela dos contratos. Para o painel buscar sozinho (posts, reels, curtidas, alcance, stories), o influencer precisa ter conta <b>profissional</b> (Comercial ou Criador) e autorizar o acesso uma vez pela API oficial da Meta. Posts e reels públicos de contas profissionais também podem ser lidos sem autorização, mas stories e alcance só com a autorização do dono.</div></section>';
  }

  /* ---------------- gráficos ---------------- */
  function drawViews(m) {
    var el = $("fd-views"), list = m.inC.slice().reverse();
    var W = Math.max(el.clientWidth || 800, 320), H = 250, mg = { l: 50, r: 12, t: 12, b: 30 }, iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    var max = Math.max.apply(null, list.map(function (v) { return v.views; }).concat([1])) * 1.08, medV = median(list.map(function (v) { return v.views; }));
    var bw = iw / list.length, Y = function (v) { return mg.t + ih - v / max * ih; };
    var accC = FlowHud.tok("--accent"), mutC = FlowHud.tok("--text-muted"), flowC = FlowHud.tok("--warning");
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Views de cada vídeo"><defs>' + FlowHud.seg("fdseg", W, H, mg.t + ih) + FlowHud.vgrad("fdgA", accC, 1, 0.5) + FlowHud.vgrad("fdgF", flowC, 1, 0.5) + "</defs>";
    for (var t = 0; t <= 4; t++) { var yv = max * t / 4; s += '<line class="gridl" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + Y(yv) + '" y2="' + Y(yv) + '"/><text x="' + (mg.l - 8) + '" y="' + (Y(yv) + 3) + '" text-anchor="end">' + fmtN(yv) + "</text>"; }
    s += '<line class="ax" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + (H - mg.b) + '" y2="' + (H - mg.b) + '"/>';
    var bodies = "", tops = "";
    list.forEach(function (v, i) {
      var h = Math.max(1.5, v.views / max * ih), x = mg.l + i * bw + bw * 0.14, w = Math.max(2, bw * 0.72), isF = v.fx.length, col = isF ? flowC : accC;
      bodies += '<rect class="mr-vbar' + (v.short ? " short" : "") + '" data-i="' + i + '" x="' + x.toFixed(1) + '" y="' + (mg.t + ih - h).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="url(#' + (isF ? "fdgF" : "fdgA") + ')"/>';
      tops += '<rect class="hud-glow" style="color:' + col + ';pointer-events:none;opacity:' + (v.short ? 0.55 : 1) + '" x="' + x.toFixed(1) + '" y="' + (mg.t + ih - h).toFixed(1) + '" width="' + w.toFixed(1) + '" height="2" rx="1" fill="' + col + '"/>';
    });
    s += '<g mask="url(#fdseg)">' + bodies + "</g>" + tops;
    if (medV != null) s += '<line class="med" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + Y(medV) + '" y2="' + Y(medV) + '"/><text x="' + (W - mg.r) + '" y="' + (Y(medV) - 5) + '" text-anchor="end" style="fill:var(--text-dim)">mediana ' + fmtN(medV) + "</text>";
    [0, Math.floor((list.length - 1) / 2), list.length - 1].forEach(function (i, k) {
      if (!list[i]) return;
      s += '<text x="' + (mg.l + i * bw + bw / 2) + '" y="' + (H - 10) + '" text-anchor="' + (k === 0 ? "start" : k === 2 ? "end" : "middle") + '">' + new Date(list[i].ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + "</text>";
    });
    el.innerHTML = s + "</svg>"; el._list = list;
  }

  // Barras empilhadas por mês (até 2 séries) com linha de meta opcional.
  function stackedMonths(el, labels, a, b, meta, aLabel) {
    var W = Math.max(el.clientWidth || 420, 280), H = 210, mg = { l: 30, r: 8, t: 14, b: 26 }, iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    var tots = labels.map(function (_, i) { return a[i] + (b ? b[i] : 0); });
    var max = Math.max.apply(null, tots.concat([meta || 0, 1])), bw = iw / labels.length, accC = FlowHud.tok("--accent"), mutC = FlowHud.tok("--text-muted");
    var Y = function (v) { return mg.t + ih - v / max * ih; };
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(aLabel) + '"><defs>' + FlowHud.seg("fdms" + labels.length, W, H, mg.t + ih) + FlowHud.vgrad("fdma", accC, 1, 0.5) + FlowHud.vgrad("fdmb", mutC, 0.95, 0.4) + "</defs>";
    for (var t = 0; t <= 2; t++) { var yv = Math.round(max * t / 2); s += '<line class="gridl" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + Y(yv) + '" y2="' + Y(yv) + '"/><text x="' + (mg.l - 6) + '" y="' + (Y(yv) + 3) + '" text-anchor="end">' + yv + "</text>"; }
    var bodies = "";
    labels.forEach(function (lb, i) {
      var x = mg.l + i * bw + bw * 0.18, w = Math.max(3, bw * 0.64), ha = a[i] / max * ih, hb = (b ? b[i] : 0) / max * ih;
      if (a[i]) bodies += '<rect x="' + x.toFixed(1) + '" y="' + (mg.t + ih - ha).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + ha.toFixed(1) + '" fill="url(#fdma)"><title>' + esc(lb + ": " + a[i] + " " + aLabel) + "</title></rect>";
      if (b && b[i]) bodies += '<rect x="' + x.toFixed(1) + '" y="' + (mg.t + ih - ha - hb).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + hb.toFixed(1) + '" fill="url(#fdmb)"><title>' + esc(lb + ": " + b[i] + " Shorts") + "</title></rect>";
      if (tots[i]) s += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (Y(tots[i]) - 5).toFixed(1) + '" text-anchor="middle" style="fill:var(--text-dim)">' + tots[i] + "</text>";
      s += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (H - 9) + '" text-anchor="middle">' + esc(lb) + "</text>";
    });
    s += '<g mask="url(#fdms' + labels.length + ')">' + bodies + "</g>";
    s += '<line class="ax" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + (mg.t + ih) + '" y2="' + (mg.t + ih) + '"/>';
    if (meta) s += '<line class="med" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + Y(meta) + '" y2="' + Y(meta) + '"/><text x="' + (W - mg.r) + '" y="' + (Y(meta) - 5) + '" text-anchor="end" style="fill:var(--text-dim)">meta ' + meta + "</text>";
    el.innerHTML = s + "</svg>";
  }
  function drawMonths(m) {
    var months = S.ctx.info.months, labels = months.map(function (r) { return MONTHS[r.month - 1] + "/" + String(r.year).slice(2); });
    var longs = [], shorts = [];
    months.forEach(function (r) { var mv = monthVids(m, r); longs.push(mv.longs.length); shorts.push(mv.shorts.length); });
    stackedMonths($("fd-months"), labels, longs, shorts, S.ctx.c.youtube_per_month || 0, "vídeos");
  }
  function drawSales() {
    var months = S.ctx.info.months, labels = months.map(function (r) { return MONTHS[r.month - 1] + "/" + String(r.year).slice(2); });
    stackedMonths($("fd-sales"), labels, months.map(function (r) { return r.count; }), null, 0, "vendas");
  }
  function drawDow(m) {
    var counts = [0, 0, 0, 0, 0, 0, 0];
    m.inC.forEach(function (v) { counts[new Date(v.ms - 3 * 3600000).getUTCDay()]++; });
    stackedMonths($("fd-dow"), DOW, counts, null, 0, "vídeos");
  }
  function drawGrowth(m) {
    var el = $("fd-growth"), sn = (S.snaps || []).filter(function (s) { return s.subscribers != null; });
    if (sn.length < 2) { el.innerHTML = ""; return; }
    var W = Math.max(el.clientWidth || 420, 280), H = 210, mg = { l: 52, r: 10, t: 14, b: 26 }, iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    var vals = sn.map(function (s) { return Number(s.subscribers); }), lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    var pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
    var t0 = Date.parse(sn[0].day + "T12:00:00"), t1 = Date.parse(sn[sn.length - 1].day + "T12:00:00");
    var X = function (s) { return mg.l + (t1 === t0 ? iw / 2 : (Date.parse(s.day + "T12:00:00") - t0) / (t1 - t0) * iw); }, Y = function (v) { return mg.t + ih - (v - lo) / (hi - lo) * ih; };
    var accC = FlowHud.tok("--accent");
    var pts = sn.map(function (s) { return X(s).toFixed(1) + "," + Y(Number(s.subscribers)).toFixed(1); }).join(" ");
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Inscritos por dia"><defs>' + FlowHud.hatch("fdhatch", accC, 0.4) + "</defs>";
    for (var t = 0; t <= 3; t++) { var yv = lo + (hi - lo) * t / 3; s += '<line class="gridl" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + Y(yv) + '" y2="' + Y(yv) + '"/><text x="' + (mg.l - 6) + '" y="' + (Y(yv) + 3) + '" text-anchor="end">' + fmtN(yv) + "</text>"; }
    s += '<polygon points="' + X(sn[0]).toFixed(1) + "," + (mg.t + ih) + " " + pts + " " + X(sn[sn.length - 1]).toFixed(1) + "," + (mg.t + ih) + '" fill="url(#fdhatch)"/>';
    s += '<polyline class="hud-glow" style="color:' + accC + '" points="' + pts + '" fill="none" stroke="' + accC + '" stroke-width="2" stroke-linejoin="round"/>';
    // marca o início do contrato quando está dentro do intervalo
    if (m.w.start > t0 && m.w.start < t1) { var xs = mg.l + (m.w.start - t0) / (t1 - t0) * iw; s += '<line class="med" x1="' + xs + '" x2="' + xs + '" y1="' + mg.t + '" y2="' + (mg.t + ih) + '"/><text x="' + (xs + 4) + '" y="' + (mg.t + 10) + '" style="fill:var(--text-dim)">início do contrato</text>'; }
    s += '<text x="' + mg.l + '" y="' + (H - 8) + '">' + new Date(t0).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + '</text><text x="' + (W - mg.r) + '" y="' + (H - 8) + '" text-anchor="end">' + new Date(t1).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + "</text>";
    sn.forEach(function (p) { s += '<circle cx="' + X(p).toFixed(1) + '" cy="' + Y(Number(p.subscribers)).toFixed(1) + '" r="3" fill="' + accC + '"><title>' + esc(new Date(p.day + "T12:00:00").toLocaleDateString("pt-BR") + ": " + fmtInt(p.subscribers) + " inscritos") + "</title></circle>"; });
    el.innerHTML = s + "</svg>";
  }

  /* ---------------- tabela de vídeos ---------------- */
  var FILTERS = [["all", "Todos"], ["long", "Vídeos"], ["short", "Shorts"], ["flow", "Mencionam a Flow"]];
  var COLS = [["title", "Vídeo", "l"], ["date", "Publicado", "l"], ["dur", "Duração", ""], ["views", "Views", ""], ["likes", "Curtidas", ""], ["comments", "Comentários", ""], ["eng", "Engaj.", ""], ["vpd", "Views/dia", ""], ["flow", "Flow", "l"]];
  function renderTools() {
    var f = S;
    $("fd-tools").innerHTML = '<input type="search" id="fd-q" placeholder="Buscar no título ou na descrição…" aria-label="Buscar nos vídeos" value="' + esc(f.text) + '">' +
      '<button type="button" class="pay-chip' + (f.scope === "contract" ? " on" : "") + '" data-fd-scope="contract" aria-pressed="' + (f.scope === "contract") + '">Na vigência</button>' +
      '<button type="button" class="pay-chip' + (f.scope === "all" ? " on" : "") + '" data-fd-scope="all" aria-pressed="' + (f.scope === "all") + '">Todos os baixados</button>' +
      '<span class="muted" style="margin:0 4px">|</span>' +
      FILTERS.map(function (x) { return '<button type="button" class="pay-chip' + (f.type === x[0] ? " on" : "") + '" data-fd-type="' + x[0] + '" aria-pressed="' + (f.type === x[0]) + '">' + x[1] + "</button>"; }).join("");
  }
  function renderTable() {
    var m = build(), f = S, q = f.text.trim().toLowerCase();
    var pool = f.scope === "contract" ? m.inC : m.vids;
    var list = pool.filter(function (v) {
      if (q && (String(v.title).toLowerCase().indexOf(q) < 0 && String(v.description || "").toLowerCase().indexOf(q) < 0)) return false;
      if (f.type === "long") return !v.short;
      if (f.type === "short") return v.short;
      if (f.type === "flow") return v.fx.length > 0;
      return true;
    });
    var key = f.sort.key, dir = f.sort.dir;
    var val = function (v) { return key === "date" ? v.ms : key === "title" ? String(v.title).toLowerCase() : key === "dur" ? v.duration_s : key === "flow" ? v.fx.length : v[key]; };
    list.sort(function (a, b) { var x = val(a), y = val(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return x < y ? -dir : x > y ? dir : 0; });
    $("fd-vhead").innerHTML = "<tr>" + COLS.map(function (col) {
      var arrow = key === col[0] ? ' <span class="arrow">' + (dir < 0 ? "↓" : "↑") + "</span>" : "";
      return '<th class="sortable ' + col[2] + '" data-fd-sort="' + col[0] + '">' + col[1] + arrow + "</th>";
    }).join("") + "</tr>";
    $("fd-vbody").innerHTML = list.length ? list.map(function (v) {
      var open = f.open === v.video_id;
      var row = '<tr class="fd-vrow' + (open ? " open" : "") + '" data-fd-vid="' + esc(v.video_id) + '" tabindex="0" aria-expanded="' + open + '"><td class="l"><div class="mr-vt">' +
        (v.thumbnail_url ? '<img src="' + esc(v.thumbnail_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : "") + '<div><a href="' + vidUrl(v) + '" target="_blank" rel="noopener noreferrer" data-stop>' + esc(v.title) + "</a><div>" +
        (v.short ? '<span class="mr-badge k">Short</span>' : "") + (v.inC ? "" : '<span class="mr-badge">fora da vigência</span>') + "</div></div></div></td>" +
        '<td class="l num">' + fmtDate(v.ms) + '<div class="muted" style="font-family:inherit;font-size:11px">' + ago(v.age) + "</div></td>" +
        '<td class="num">' + fmtDur(v.duration_s) + '</td><td class="num">' + fmtInt(v.views) + '</td><td class="num">' + (v.likes == null ? "—" : fmtInt(v.likes)) + '</td><td class="num">' + (v.comments == null ? "—" : fmtInt(v.comments)) + '</td><td class="num">' + pct(v.eng) + '</td><td class="num">' + fmtN(v.vpd) + "</td>" +
        '<td class="l mr-divulga">' + (v.fx.length ? v.fx.map(function (x) { return '<span class="mr-tool mini flow" title="' + (x.w === "d" ? "na descrição" : "no título") + (x.l ? ", com link" : "") + '">✓ ' + esc(x.n) + (x.l ? " 🔗" : "") + "</span>"; }).join("") : '<span class="muted">—</span>') + "</td></tr>";
      if (open) row += '<tr class="fd-vdetail"><td colspan="' + COLS.length + '">' + videoDetail(v) + "</td></tr>";
      return row;
    }).join("") : '<tr><td colspan="' + COLS.length + '" class="empty">Nenhum vídeo com esses filtros.</td></tr>';
    $("fd-vcount").textContent = list.length + " de " + pool.length + " vídeos" + (f.scope === "contract" ? " na vigência" : " baixados") + ". Clique numa linha para ver a descrição, as tags e os links.";
  }
  function videoDetail(v) {
    var desc = String(v.description || "");
    var links = (desc.match(URL_RE) || []).filter(function (u, i, arr) { return arr.indexOf(u) === i; }).slice(0, 12);
    return '<div class="fd-vd">' +
      '<div><h4 class="mr-sub-h">Descrição</h4>' + (desc ? '<div class="mr-desc mr-desc-full">' + hlFlow(desc) + "</div>" : '<span class="muted">Sem descrição (ou ainda não baixada: use ↻ Atualizar canal).</span>') + "</div>" +
      '<div><h4 class="mr-sub-h">Links na descrição</h4>' + (links.length ? '<div class="mr-links">' + links.map(function (u) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70)) + "</a>"; }).join("") + "</div>" : '<span class="muted">Nenhum.</span>') +
      '<h4 class="mr-sub-h">Tags</h4>' + (v.tags && v.tags.length ? '<div class="mr-links">' + v.tags.map(function (t) { return '<span class="mr-tool soft">' + esc(t) + "</span>"; }).join("") + "</div>" : '<span class="muted">Sem tags.</span>') + "</div></div>";
  }

  /* ---------------- ações ---------------- */
  function csvCell(v) { var s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function exportCsv() {
    var m = build(), a = S.ctx.a;
    var rows = [["Título", "URL", "Publicado", "Na vigência", "Tipo", "Duração (s)", "Views", "Curtidas", "Comentários", "Engajamento", "Views por dia", "Menciona a Flow", "Links"].map(csvCell).join(",")];
    m.vids.forEach(function (v) {
      rows.push([v.title, vidUrl(v), new Date(v.ms).toISOString().slice(0, 10), v.inC ? "sim" : "não", v.short ? "Short" : "Vídeo", v.duration_s, v.views, v.likes, v.comments,
        v.eng == null ? "" : v.eng.toFixed(4), Math.round(v.vpd), v.fx.map(function (x) { return x.n; }).join("; "), (String(v.description || "").match(URL_RE) || []).slice(0, 8).join(" ")].map(csvCell).join(","));
    });
    var blob = new Blob(["﻿" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" }), el = document.createElement("a");
    el.href = URL.createObjectURL(blob); el.download = "youtube-" + String(a.name || a.email).replace(/[^\w\-]+/g, "_").slice(0, 40) + ".csv";
    document.body.appendChild(el); el.click(); el.remove();
    setTimeout(function () { URL.revokeObjectURL(el.href); }, 2000);
  }
  async function syncNow(deep) {
    if (!S || S.busy) return;
    var my = S, c = my.ctx.c;
    var btn = document.querySelector('[data-fd="' + (deep ? "deep" : "refresh") + '"]');
    my.busy = true; if (btn) { btn.disabled = true; btn.textContent = "Atualizando…"; }
    var body = { email: my.ctx.a.email };
    if (deep) body.since = c.start_date;
    var res = await A.sb.functions.invoke("youtube-sync", { body: body }), data = res.data || {};
    if (res.error && !data.error) { try { data = await res.error.context.json(); } catch (e) { data = { error: res.error.message }; } }
    my.busy = false;
    if (!data.ok) { A.toast("Erro ao atualizar o YouTube: " + (data.error || "desconhecido"), true); renderBar(); return; }
    if (data.failed) { A.toast("O YouTube recusou a leitura: " + Object.keys(data.errors || {}).map(function (k) { return data.errors[k]; })[0], true); renderBar(); return; }
    A.toast((deep ? "Histórico do contrato carregado: " : "Canal atualizado: ") + fmtInt(data.videos) + " vídeos lidos.");
    try { await A.reloadYoutube(); } catch (e) {}
    if (S !== my) return;
    var ctx = A.getCtx(my.id); if (ctx) my.ctx = ctx;
    await load();
  }

  function bind() {
    var box = $("fd-full"), tip = $("fd-tip");
    box.addEventListener("click", function (e) {
      if (e.target.closest("#fd-back")) return close();
      var act = e.target.closest("[data-fd]");
      if (act) {
        var k = act.dataset.fd;
        if (k === "refresh") return syncNow(false);
        if (k === "deep") return syncNow(true);
        if (k === "csv") return exportCsv();
        if (k === "edit") { var id = S.id; close(); A.edit(id); return; }
      }
      var sc = e.target.closest("[data-fd-scope]");
      if (sc) { S.scope = sc.dataset.fdScope; renderTools(); renderTable(); return; }
      var ty = e.target.closest("[data-fd-type]");
      if (ty) { S.type = ty.dataset.fdType; renderTools(); renderTable(); return; }
      var so = e.target.closest("[data-fd-sort]");
      if (so) { var kk = so.dataset.fdSort; S.sort = { key: kk, dir: S.sort.key === kk ? -S.sort.dir : (kk === "title" ? 1 : -1) }; renderTable(); return; }
      var bar = e.target.closest(".mr-vbar[data-i]");
      if (bar) { var list = $("fd-views")._list, v = list && list[+bar.dataset.i]; if (v) window.open(vidUrl(v), "_blank", "noopener"); return; }
      if (e.target.closest("[data-stop], a")) return;
      var tr = e.target.closest("tr[data-fd-vid]");
      if (tr) { S.open = S.open === tr.dataset.fdVid ? null : tr.dataset.fdVid; renderTable(); }
    });
    box.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("tr[data-fd-vid]")) { e.preventDefault(); e.target.click(); }
    });
    box.addEventListener("input", function (e) { if (e.target.id === "fd-q") { S.text = e.target.value; renderTable(); } });
    box.addEventListener("mousemove", function (e) {
      var bar = e.target.closest ? e.target.closest(".mr-vbar[data-i]") : null;
      if (!bar || !S) { tip.style.display = "none"; return; }
      var list = $("fd-views")._list, v = list && list[+bar.dataset.i];
      if (!v) return;
      tip.innerHTML = "<b>" + esc(v.title) + "</b><div><span>Publicado</span>" + fmtDate(v.ms) + "</div><div><span>Views</span>" + fmtInt(v.views) + "</div><div><span>Curtidas</span>" + (v.likes == null ? "—" : fmtInt(v.likes)) + "</div><div><span>Comentários</span>" + (v.comments == null ? "—" : fmtInt(v.comments)) + "</div><div><span>Engajamento</span>" + pct(v.eng) + "</div><div><span>Tipo</span>" + (v.short ? "Short" : "Vídeo") + "</div>" +
        (v.fx.length ? "<div><span>Menciona</span>" + esc(v.fx.map(function (x) { return x.n; }).join(", ")) + "</div>" : "");
      tip.style.display = "block";
      var x = e.clientX + 14, y = e.clientY + 14;
      if (x + 270 > window.innerWidth) x = e.clientX - 270;
      if (y + 190 > window.innerHeight) y = e.clientY - 190;
      tip.style.left = Math.max(x, 4) + "px"; tip.style.top = Math.max(y, 4) + "px";
    });
    box.addEventListener("mouseleave", function () { tip.style.display = "none"; });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S && !$("fd-full").hidden) close(); });
    var rt = null;
    window.addEventListener("resize", function () {
      if (!S || !S.videos || $("fd-full").hidden) return;
      clearTimeout(rt);
      rt = setTimeout(function () { var m = build(); if (m.inC.length && $("fd-views")) drawViews(m); if ($("fd-months")) { drawMonths(m); drawSales(); drawGrowth(m); drawDow(m); } }, 150);
    });
  }

  return {
    init: function (deps) { A = deps; },
    open: function (id) { return open(id); },
    close: close
  };
})();
