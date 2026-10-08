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
    S = { id: contractId, ctx: ctx, videos: null, snaps: [], scope: "contract", type: "all", text: "", sort: { key: "date", dir: -1 }, open: null, busy: false,
      range: { preset: "7d", from: null, to: null }, gran: "day", metric: "subs", qdate: "", dc: null };
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
        A.sb.from("youtube_channel_snapshots").select("day, subscribers, total_views, video_count, taken_at").eq("channel_id", ch.channel_id).order("day")
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

    /* métricas dia a dia (inscritos e alcance) */
    body += '<section class="mr-fsec" id="fd-daily"></section>';

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
    body += '<div class="fd-f3"><section class="mr-fsec"><h3>Vídeos por mês × meta</h3><p class="mr-hint">Verde: longos; cinza: Shorts; linha: meta mensal.</p><div class="mr-chart" id="fd-months"></div></section>' +
      '<section class="mr-fsec"><h3>Vendas Flow por mês</h3><p class="mr-hint">Vendas das ferramentas Flow por mês de contrato.</p><div class="mr-chart" id="fd-sales"></div></section>' +
      '<section class="mr-fsec"><h3>Dia da semana que publica</h3><p class="mr-hint">Vídeos da vigência por dia (horário de Brasília).</p><div class="mr-chart" id="fd-dow"></div></section></div>';

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
    drawMonths(m); drawSales(); drawDow(m);
    renderDaily();
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
  /* ---------------- métricas dia a dia ---------------- */
  // Trabalha com "número do dia" (dias desde 1970, UTC) para somar e subtrair datas sem fuso.
  function dn(str) { return Math.round(Date.parse(str + "T00:00:00Z") / DAY); }
  function dstr(n) { return new Date(n * DAY).toISOString().slice(0, 10); }
  function dfmt(n) { var p = dstr(n).split("-"); return p[2] + "/" + p[1] + "/" + p[0]; }
  function dshort(n) { var p = dstr(n).split("-"); return p[2] + "/" + p[1]; }
  function lerp(x, y, t) { return x == null || y == null ? null : Math.round(x + (y - x) * t); }
  function sgn(n, f) { return (n > 0 ? "+" : n < 0 ? "−" : "") + (f || fmtInt)(Math.abs(n)); }
  function brtDay(ms) { return Math.floor((ms - 3 * 3600000) / DAY); }
  // Hoje no horário de Brasília (o mesmo fuso em que o sync grava a foto do dia).
  function todayDn() { return dn(new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" })); }
  function monthStart(n, add) { var d = new Date(n * DAY); return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (add || 0), 1) / DAY); }

  // Série contínua, um ponto por dia. Dias em que o painel não gravou a foto (ex.: sem sync) são estimados em linha reta.
  function series() {
    var pts = (S.snaps || []).filter(function (s) { return s.subscribers != null || s.total_views != null; }).map(function (s) {
      return { d: dn(s.day), subs: s.subscribers == null ? null : Number(s.subscribers), views: s.total_views == null ? null : Number(s.total_views), at: s.taken_at };
    });
    if (!pts.length) return null;
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[i + 1];
      out.push({ d: a.d, subs: a.subs, views: a.views, est: false, at: a.at });
      if (b) for (var d = a.d + 1; d < b.d; d++) { var t = (d - a.d) / (b.d - a.d); out.push({ d: d, subs: lerp(a.subs, b.subs, t), views: lerp(a.views, b.views, t), est: true }); }
    }
    return out;
  }
  // Valor no fim do dia d. Fora do histórico não existe dado (não repete o último valor).
  function valueAt(ser, d, key) {
    if (d < ser[0].d || d > ser[ser.length - 1].d) return null;
    return ser[d - ser[0].d][key];
  }
  // Valor de partida para medir o ganho do dia d: fim do dia anterior; no 1º registro, ele mesmo.
  function baseAt(ser, d, key) { return d - 1 >= ser[0].d ? valueAt(ser, d - 1, key) : valueAt(ser, ser[0].d, key); }

  var PRESETS = [["today", "Hoje"], ["yesterday", "Ontem"], ["7d", "7 dias"], ["15d", "15 dias"], ["month", "Este mês"], ["lastmonth", "Mês passado"], ["custom", "Personalizado"]];
  // Janela pedida pelo filtro, sempre a partir de hoje (não do último registro).
  function requestedWindow() {
    var t = todayDn(), r = S.range;
    switch (r.preset) {
      case "today": return { from: t, to: t };
      case "yesterday": return { from: t - 1, to: t - 1 };
      case "7d": return { from: t - 6, to: t };
      case "15d": return { from: t - 14, to: t };
      case "month": return { from: monthStart(t), to: t };
      case "lastmonth": return { from: monthStart(t, -1), to: monthStart(t) - 1 };
      default:
        var f = r.from != null ? r.from : t - 29, to = r.to != null ? r.to : t;
        return { from: Math.min(f, to), to: Math.max(f, to) };
    }
  }
  // Parte da janela que tem registro.
  function effWindow(ser, req) {
    var from = Math.max(req.from, ser[0].d), to = Math.min(req.to, ser[ser.length - 1].d);
    return from > to ? null : { from: from, to: to };
  }
  // Só oferece o agrupamento que faz sentido para o tamanho do período.
  function allowedGran(days) { return { day: true, week: days >= 10, fortnight: days >= 28, month: days >= 45 }; }
  var GRAN_LABEL = { day: "dia", week: "semana", fortnight: "quinzena", month: "mês" };
  var GRAN_MIN = { week: "10 dias", fortnight: "28 dias", month: "45 dias" };

  // Agrupa os dias da janela em dia / semana (seg–dom) / quinzena (1–15 e 16–fim) / mês.
  function bucketsOf(win, gran) {
    var out = [], d = win.from;
    function span(n) {
      var dt = new Date(n * DAY), y = dt.getUTCFullYear(), mo = dt.getUTCMonth(), da = dt.getUTCDate();
      if (gran === "day") return { s: n, e: n, label: dshort(n) };
      if (gran === "week") { var dow = (dt.getUTCDay() + 6) % 7, s = n - dow; return { s: s, e: s + 6, label: dshort(s) + "–" + dshort(s + 6) }; }
      if (gran === "fortnight") {
        var s1 = Math.round(Date.UTC(y, mo, da <= 15 ? 1 : 16) / DAY), e1 = da <= 15 ? Math.round(Date.UTC(y, mo, 15) / DAY) : Math.round(Date.UTC(y, mo + 1, 0) / DAY);
        return { s: s1, e: e1, label: (da <= 15 ? "01–15" : "16–" + new Date(e1 * DAY).getUTCDate()) + "/" + String(mo + 1).padStart(2, "0") };
      }
      return { s: Math.round(Date.UTC(y, mo, 1) / DAY), e: Math.round(Date.UTC(y, mo + 1, 0) / DAY), label: MONTHS[mo] + "/" + String(y).slice(2) };
    }
    while (d <= win.to) { var sp = span(d); out.push({ s: Math.max(sp.s, win.from), e: Math.min(sp.e, win.to), label: sp.label, full: sp.s >= win.from && sp.e <= win.to }); d = sp.e + 1; }
    return out;
  }
  function bucketStats(ser, b, m, key) {
    var first = ser[0].d, single = b.s === first && b.e === first;   // o 1º registro só serve de ponto de partida
    var baseS = baseAt(ser, b.s, "subs"), baseW = baseAt(ser, b.s, "views");
    var endS = valueAt(ser, b.e, "subs"), endW = valueAt(ser, b.e, "views");
    var vids = m.vids.filter(function (v) { var x = brtDay(v.ms); return x >= b.s && x <= b.e; });
    return { label: b.label, s: b.s, e: b.e, full: b.full, endS: endS, baseS: baseS, endW: endW, vids: vids,
      gainS: single || endS == null || baseS == null ? null : endS - baseS, gainW: single || endW == null || baseW == null ? null : endW - baseW,
      est: !!(ser[b.e - first] && ser[b.e - first].est) };
  }

  function renderDaily() {
    var el = $("fd-daily");
    if (!el || !S) return;
    var head = '<h3>Métricas dia a dia <small class="muted">inscritos e alcance do canal</small></h3>';
    var ser = series();
    if (!ser) { S.dc = null; el.innerHTML = head + '<div class="mr-fnote">Ainda não há histórico. O painel grava uma foto do canal (inscritos e views) a cada atualização do YouTube, uma por dia. Clique em <b>↻ Atualizar canal</b> para gravar a primeira; os números diários aparecem a partir daí. A API do YouTube não informa o passado, então não dá para recuperar dias anteriores ao primeiro registro.</div>'; return; }
    var m = build(), first = ser[0].d, last = ser[ser.length - 1].d, today = todayDn();
    var req = requestedWindow(), reqDays = req.to - req.from + 1, eff = effWindow(ser, req);
    var allow = allowedGran(reqDays);
    if (!allow[S.gran]) S.gran = "day";
    var noSubs = ser.every(function (p) { return p.subs == null; });
    if (noSubs) S.metric = "views";
    var key = S.metric === "views" ? "views" : "subs";

    function chip(attr, val, label, on, dis, tip) { return '<button type="button" class="pay-chip' + (on ? " on" : "") + '" ' + attr + '="' + val + '" aria-pressed="' + on + '"' + (dis ? ' disabled title="' + esc(tip) + '"' : "") + ">" + label + "</button>"; }
    var custom = S.range.preset === "custom";
    var controls = '<div class="mr-tools fd-dctl"><span class="fd-dlbl">Período</span>' +
      PRESETS.map(function (p) { return chip("data-fd-range", p[0], p[1], S.range.preset === p[0]); }).join("") +
      (custom ? '<label class="fd-date">de <input type="date" id="fd-from" value="' + dstr(req.from) + '" min="' + dstr(first) + '" max="' + dstr(today) + '"></label>' +
        '<label class="fd-date">até <input type="date" id="fd-to" value="' + dstr(req.to) + '" min="' + dstr(first) + '" max="' + dstr(today) + '"></label>' : "") + "</div>" +
      '<div class="mr-tools fd-dctl"><span class="fd-dlbl">Agrupar por</span>' +
      ["day", "week", "fortnight", "month"].map(function (g) { return chip("data-fd-gran", g, { day: "Dia", week: "Semana", fortnight: "Quinzena", month: "Mês" }[g], S.gran === g, !allow[g], "Precisa de um período de pelo menos " + GRAN_MIN[g]); }).join("") +
      '<span class="muted" style="margin:0 4px">|</span><span class="fd-dlbl">Gráfico</span>' +
      (noSubs ? "" : chip("data-fd-metric", "subs", "Inscritos", key === "subs")) + chip("data-fd-metric", "views", "Alcance (views do canal)", key === "views") + "</div>";
    var showing = '<p class="fd-showing">' + (reqDays === 1 ? "Dia " + dfmt(req.from) : "De " + dfmt(req.from) + " a " + dfmt(req.to) + " (" + reqDays + " dias)") + "</p>";
    var qd = '<div class="fd-qdate"><label>Consultar uma data: <input type="date" id="fd-qdate" min="' + dstr(first) + '" max="' + dstr(last) + '" value="' + (S.qdate || "") + '"></label> <span id="fd-qres"></span></div>';

    // Sem nenhum dia gravado na janela pedida.
    if (!eff) {
      S.dc = { ser: ser };
      var why = req.to < first
        ? "O histórico do painel começa em <b>" + dfmt(first) + "</b>; não há registro de antes disso (a API do YouTube não informa o passado)."
        : "O último registro é de <b>" + dfmt(last) + "</b>. Clique em <b>↻ Atualizar canal</b> para gravar os números de hoje.";
      el.innerHTML = head + controls + showing + '<div class="mr-fnote">Sem registro neste período. ' + why + "</div>" + qd;
      updateQdate();
      return;
    }

    var s0 = baseAt(ser, eff.from, "subs"), s1 = valueAt(ser, eff.to, "subs");
    var v0 = baseAt(ser, eff.from, "views"), v1 = valueAt(ser, eff.to, "views");
    var noBase = eff.from - 1 < first, baseDay = noBase ? first : eff.from - 1;
    var effDays = eff.to - eff.from + 1, den = Math.max(noBase ? effDays - 1 : effDays, 1);
    var gs = s0 != null && s1 != null ? s1 - s0 : null, gv = v0 != null && v1 != null ? v1 - v0 : null;
    var partial = eff.from > req.from || eff.to < req.to;
    var dayGains = [];
    for (var d = Math.max(eff.from, first + 1); d <= eff.to; d++) {
      var a = valueAt(ser, d - 1, "subs"), b = valueAt(ser, d, "subs");
      if (a != null && b != null) dayGains.push({ d: d, g: b - a });
    }
    var best = dayGains.slice().sort(function (x, y) { return y.g - x.g; })[0], worst = dayGains.slice().sort(function (x, y) { return x.g - y.g; })[0];
    var inWin = m.vids.filter(function (v) { var x = brtDay(v.ms); return x >= eff.from && x <= eff.to; });
    var estCount = ser.filter(function (p) { return p.d >= eff.from && p.d <= eff.to && p.est; }).length;

    var bks = bucketsOf(eff, S.gran).map(function (b) { return bucketStats(ser, b, m, key); });
    // Períodos curtos (hoje, ontem…) ganham um gráfico com os 14 dias até a data, com o período escolhido em destaque.
    var ctxMode = effDays < 7;
    var chartWin = ctxMode ? { from: Math.max(first, eff.to - 13), to: eff.to } : eff;
    var cbks = bucketsOf(chartWin, ctxMode ? "day" : S.gran).map(function (b) { return bucketStats(ser, b, m, key); });
    S.dc = { ser: ser, key: key, win: eff, chartWin: chartWin, cbks: cbks, ctxMode: ctxMode };

    var kpis = '<div class="mr-fkpis">' +
      kf("Inscritos em " + dfmt(eff.to), noSubs ? "oculto" : fmtInt(s1), s1 != null ? fmtN(s1) : "", "Inscritos do canal no fim do período.") +
      kf("Inscritos no início", noSubs ? "—" : fmtInt(s0), noBase ? "1º registro, em " + dfmt(first) : "fim de " + dfmt(baseDay), "Inscritos no último dia antes do período. Se o período começa no 1º registro do painel, é o próprio 1º registro.") +
      kf("Inscritos ganhos", gs == null ? "—" : '<span class="' + (gs >= 0 ? "good" : "bad") + '">' + sgn(gs) + "</span>", s0 ? pct(gs / s0, 2) + (effDays > 1 ? " · " + dec(gs / den, 1) + " por dia" : "") : "", "Diferença líquida: entradas menos saídas de inscritos no período.") +
      kf("Alcance no período", gv == null ? "—" : '<span class="good">' + sgn(gv, fmtN) + "</span>", gv == null ? "" : fmtInt(gv) + " views" + (effDays > 1 ? " · " + fmtN(gv / den) + " por dia" : ""), "Alcance = visualizações novas do canal inteiro (vídeos e Shorts, antigos e novos) no período.") +
      kf("Views do canal em " + dfmt(eff.to), fmtN(v1), fmtInt(v1) + " no total") +
      (best && effDays > 1 ? kf("Melhor dia", '<span class="' + (best.g >= 0 ? "good" : "bad") + '">' + sgn(best.g) + "</span>", dfmt(best.d) + " · inscritos") : "") +
      (worst && effDays > 1 && worst.g < 0 ? kf("Pior dia", '<span class="bad">' + sgn(worst.g) + "</span>", dfmt(worst.d) + " · inscritos") : "") +
      kf("Vídeos publicados", fmtInt(inWin.length), fmtInt(inWin.filter(function (v) { return !v.short; }).length) + " vídeos · " + fmtInt(inWin.filter(function (v) { return v.short; }).length) + " Shorts") +
      "</div>";

    var warns = [];
    if (partial) warns.push("<b>Período parcial:</b> o painel tem registros de " + dfmt(first) + " a " + dfmt(last) + ", então os números cobrem " + dfmt(eff.from) + " a " + dfmt(eff.to) + " (" + effDays + " de " + reqDays + " dias).");
    if (eff.to === today && ser[ser.length - 1].at) warns.push("Hoje ainda está em andamento: números até a última atualização, às " + new Date(ser[ser.length - 1].at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) + ".");
    else if (req.to > last && last < today) warns.push("O último registro é de " + dfmt(last) + ". Clique em <b>↻ Atualizar canal</b> para trazer os números de hoje.");
    if (noBase && effDays > 1) warns.push("O primeiro dia (" + dfmt(first) + ") é só o ponto de partida: os ganhos contam a partir do dia seguinte.");
    if (estCount) warns.push(estCount + " dia(s) sem registro foram estimados em linha reta entre os dias vizinhos (marcados com ~ na tabela).");
    var note = (warns.length ? '<div class="fd-warns">' + warns.map(function (w) { return "<p>" + w + "</p>"; }).join("") + "</div>" : "") +
      '<p class="mr-hint">Histórico gravado pelo painel desde ' + dfmt(first) + ". A API do YouTube só informa o número de hoje, por isso não dá para recuperar dias anteriores ao primeiro registro.</p>";

    var rows = bks.slice().reverse().map(function (b) {
      return "<tr" + (b.full ? "" : ' class="muted-row"') + '><td class="l">' + esc(b.label) + (b.est ? ' <span class="muted" title="Dia sem registro: valor estimado entre os dias vizinhos">~</span>' : "") + (b.full ? "" : ' <span class="muted" title="Período cortado pelo filtro de datas">·</span>') + "</td>" +
        '<td class="num">' + (b.endS == null ? "—" : fmtInt(b.endS)) + '</td><td class="num">' + (b.gainS == null ? "—" : '<span class="' + (b.gainS >= 0 ? "good" : "bad") + '">' + sgn(b.gainS) + "</span>") + "</td>" +
        '<td class="num">' + (b.gainS == null || !b.baseS ? "—" : pct(b.gainS / b.baseS, 2)) + '</td><td class="num">' + (b.endW == null ? "—" : fmtInt(b.endW)) + '</td><td class="num">' + (b.gainW == null ? "—" : sgn(b.gainW)) + "</td>" +
        '<td class="num">' + b.vids.length + '</td><td class="num">' + (b.vids.length ? fmtN(sum(b.vids, function (v) { return v.views; })) : "—") + "</td></tr>";
    }).join("");
    var gl = ctxMode ? "dia" : GRAN_LABEL[S.gran];

    el.innerHTML = head + controls + showing + qd + kpis +
      '<div class="mr-f2" style="margin:14px 0 4px"><div><h4 class="mr-sub-h" style="margin-top:0">' + (key === "subs" ? "Inscritos" : "Views do canal") + (ctxMode ? " nos 14 dias até " + dshort(eff.to) : " no período") + '</h4><div class="mr-chart" id="fd-dc-line"></div></div>' +
      '<div><h4 class="mr-sub-h" style="margin-top:0">' + (key === "subs" ? "Inscritos ganhos" : "Alcance (views novas)") + " por " + gl + (ctxMode ? " · período escolhido em destaque" : "") + '</h4><div class="mr-chart" id="fd-dc-bars"></div></div></div>' +
      '<div class="table-scroll fd-dtable"><table class="mr-cmp"><thead><tr><th class="l">Período</th><th>Inscritos no fim</th><th>Ganho de inscritos</th><th>Variação</th><th>Views do canal no fim</th><th>Alcance (views novas)</th><th>Vídeos publicados</th><th>Views desses vídeos</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8" class="empty">Sem dados no período.</td></tr>') + "</tbody></table></div>" + note;
    updateQdate();
    drawDailyCharts();
  }

  function updateQdate() {
    var el = $("fd-qres"); if (!el || !S.dc) return;
    if (!S.qdate) { el.textContent = ""; return; }
    var d = dn(S.qdate), ser = S.dc.ser, last = ser[ser.length - 1];
    var s = valueAt(ser, d, "subs"), v = valueAt(ser, d, "views");
    if (s == null && v == null) { el.innerHTML = '<span class="bad">Sem registro nessa data (o histórico vai de ' + dfmt(ser[0].d) + " a " + dfmt(last.d) + ").</span>"; return; }
    var est = ser[d - ser[0].d] && ser[d - ser[0].d].est;
    el.innerHTML = "Em <b>" + dfmt(d) + "</b>: <b>" + (s == null ? "inscritos ocultos" : fmtInt(s) + " inscritos") + "</b> · <b>" + fmtInt(v) + "</b> views no canal" + (est ? ' <span class="muted">(estimado)</span>' : "") +
      (d < last.d && s != null && last.subs != null ? " · de lá até " + dfmt(last.d) + ": <b>" + sgn(last.subs - s) + "</b> inscritos" : "");
  }

  function drawDailyCharts() {
    var dc = S && S.dc;
    if (!dc || !dc.cbks || !$("fd-dc-line")) return;
    var key = dc.key, cw = dc.chartWin, sel = dc.win, pts = dc.ser.filter(function (p) { return p.d >= cw.from && p.d <= cw.to && p[key] != null; });
    var accC = FlowHud.tok("--accent"), crit = FlowHud.tok("--critical");
    var el = $("fd-dc-line");
    if (pts.length < 2) { el.innerHTML = '<p class="mr-hint">Precisa de pelo menos dois dias de histórico para desenhar a linha.</p>'; }
    else {
      var W = Math.max(el.clientWidth || 420, 280), H = 220, mg = { l: 54, r: 10, t: 14, b: 26 }, iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
      var vals = pts.map(function (p) { return p[key]; }), lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      if (hi === lo) { hi += 1; lo -= 1; }
      var pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
      var X = function (d) { return mg.l + (d - pts[0].d) / (pts[pts.length - 1].d - pts[0].d) * iw; }, Y = function (v) { return mg.t + ih - (v - lo) / (hi - lo) * ih; };
      var line = pts.map(function (p) { return X(p.d).toFixed(1) + "," + Y(p[key]).toFixed(1); }).join(" ");
      var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Evolução no período"><defs>' + FlowHud.hatch("fddh", accC, 0.4) + "</defs>";
      for (var t = 0; t <= 3; t++) { var yv = lo + (hi - lo) * t / 3; s += '<line class="gridl" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + Y(yv) + '" y2="' + Y(yv) + '"/><text x="' + (mg.l - 6) + '" y="' + (Y(yv) + 3) + '" text-anchor="end">' + fmtN(yv) + "</text>"; }
      if (dc.ctxMode) { var x0 = X(Math.max(sel.from, pts[0].d)), x1 = X(Math.min(sel.to, pts[pts.length - 1].d)); s += '<rect x="' + (x0 - 6).toFixed(1) + '" y="' + mg.t + '" width="' + Math.max(x1 - x0 + 12, 12).toFixed(1) + '" height="' + ih + '" fill="' + accC + '" opacity="0.1"/>'; }
      s += '<polygon points="' + X(pts[0].d).toFixed(1) + "," + (mg.t + ih) + " " + line + " " + X(pts[pts.length - 1].d).toFixed(1) + "," + (mg.t + ih) + '" fill="url(#fddh)"/>';
      s += '<polyline class="hud-glow" style="color:' + accC + '" points="' + line + '" fill="none" stroke="' + accC + '" stroke-width="2" stroke-linejoin="round"/>';
      var ds = brtDay(window_().start);
      if (ds > pts[0].d && ds < pts[pts.length - 1].d) { var xs = X(ds); s += '<line class="med" x1="' + xs + '" x2="' + xs + '" y1="' + mg.t + '" y2="' + (mg.t + ih) + '"/><text x="' + (xs + 4) + '" y="' + (mg.t + 10) + '" style="fill:var(--text-dim)">início do contrato</text>'; }
      s += '<text x="' + mg.l + '" y="' + (H - 8) + '">' + dshort(pts[0].d) + '</text><text x="' + (W - mg.r) + '" y="' + (H - 8) + '" text-anchor="end">' + dshort(pts[pts.length - 1].d) + "</text>";
      pts.forEach(function (p) { s += '<circle cx="' + X(p.d).toFixed(1) + '" cy="' + Y(p[key]).toFixed(1) + '" r="' + (pts.length <= 45 ? 3 : 5) + '" fill="' + (pts.length <= 45 ? (p.est ? "var(--bg)" : accC) : "transparent") + '" stroke="' + accC + '" stroke-width="' + (pts.length <= 45 ? 1.5 : 0) + '"><title>' + esc(dfmt(p.d) + ": " + fmtInt(p[key]) + (key === "subs" ? " inscritos" : " views") + (p.est ? " (estimado)" : "")) + "</title></circle>"; });
      el.innerHTML = s + "</svg>";
    }
    // barras: ganho por período (positivo verde, negativo vermelho); no modo "curto" o período escolhido fica em destaque
    var be = $("fd-dc-bars"), bks = dc.cbks, g = bks.map(function (b) { return key === "subs" ? b.gainS : b.gainW; });
    if (!bks.length || g.every(function (x) { return x == null; })) { be.innerHTML = '<p class="mr-hint">Sem ganho para mostrar: o primeiro dia de histórico é só o ponto de partida.</p>'; return; }
    var W2 = Math.max(be.clientWidth || 420, 280), H2 = 220, m2 = { l: 54, r: 10, t: 16, b: 26 }, iw2 = W2 - m2.l - m2.r, ih2 = H2 - m2.t - m2.b;
    var mx = Math.max.apply(null, g.map(function (x) { return Math.max(x || 0, 0); }).concat([0])), mn = Math.min.apply(null, g.map(function (x) { return Math.min(x || 0, 0); }).concat([0]));
    if (mx === mn) mx = mn + 1;
    var Y2 = function (v) { return m2.t + ih2 - (v - mn) / (mx - mn) * ih2; }, bw = iw2 / bks.length;
    var s2 = '<svg viewBox="0 0 ' + W2 + " " + H2 + '" role="img" aria-label="Ganho por período"><defs>' + FlowHud.vgrad("fddA", accC, 1, 0.5) + FlowHud.vgrad("fddB", crit, 1, 0.5) + "</defs>";
    for (var t2 = 0; t2 <= 3; t2++) { var yv2 = mn + (mx - mn) * t2 / 3; s2 += '<line class="gridl" x1="' + m2.l + '" x2="' + (W2 - m2.r) + '" y1="' + Y2(yv2) + '" y2="' + Y2(yv2) + '"/><text x="' + (m2.l - 6) + '" y="' + (Y2(yv2) + 3) + '" text-anchor="end">' + fmtN(yv2) + "</text>"; }
    s2 += '<line class="ax" x1="' + m2.l + '" x2="' + (W2 - m2.r) + '" y1="' + Y2(0) + '" y2="' + Y2(0) + '"/>';
    var step = Math.ceil(bks.length / 8);
    bks.forEach(function (b, i) {
      var v = g[i]; if (v == null) return;
      var inSel = !dc.ctxMode || (b.e >= sel.from && b.s <= sel.to);
      var x = m2.l + i * bw + bw * 0.15, w = Math.max(2, bw * 0.7), y0 = Y2(0), y1 = Y2(v), top = Math.min(y0, y1), h = Math.max(1.5, Math.abs(y1 - y0));
      s2 += '<rect x="' + x.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1.5" opacity="' + (inSel ? 1 : 0.35) + '" fill="url(#' + (v >= 0 ? "fddA" : "fddB") + ')"><title>' + esc(b.label + ": " + sgn(v) + (key === "subs" ? " inscritos" : " views")) + "</title></rect>";
      if (bks.length <= 20) s2 += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (v >= 0 ? top - 4 : top + h + 11).toFixed(1) + '" text-anchor="middle" style="fill:var(--text-dim)">' + (key === "subs" ? sgn(v) : sgn(v, fmtN)) + "</text>";
      if (i % step === 0) s2 += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (H2 - 8) + '" text-anchor="middle">' + esc(b.label.length > 11 ? b.label.split("–")[0] : b.label) + "</text>";
    });
    be.innerHTML = s2 + "</svg>";
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
      var rg = e.target.closest("[data-fd-range]");
      if (rg) {
        var pid = rg.dataset.fdRange;
        // "Personalizado" começa com as datas do filtro que estava ativo.
        var cur = S.range.preset === "custom" ? { from: S.range.from, to: S.range.to } : requestedWindow();
        S.range = pid === "custom" ? { preset: "custom", from: cur.from, to: cur.to } : { preset: pid, from: null, to: null };
        renderDaily(); return;
      }
      var gr = e.target.closest("[data-fd-gran]");
      if (gr) { S.gran = gr.dataset.fdGran; renderDaily(); return; }
      var mt = e.target.closest("[data-fd-metric]");
      if (mt) { S.metric = mt.dataset.fdMetric; renderDaily(); return; }
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
    box.addEventListener("change", function (e) {
      var id = e.target.id;
      if ((id === "fd-from" || id === "fd-to") && S && S.dc) {
        var f = $("fd-from").value, t = $("fd-to").value;
        if (!f || !t) return;
        var a = dn(f), b = dn(t);
        S.range = { preset: "custom", from: Math.min(a, b), to: Math.max(a, b) };
        renderDaily();
      } else if (id === "fd-qdate" && S) { S.qdate = e.target.value; updateQdate(); }
    });
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
      rt = setTimeout(function () { var m = build(); if (m.inC.length && $("fd-views")) drawViews(m); if ($("fd-months")) { drawMonths(m); drawSales(); drawDow(m); drawDailyCharts(); } }, 150);
    });
  }

  return {
    init: function (deps) { A = deps; },
    open: function (id) { return open(id); },
    close: close
  };
})();
