/* Horas de desenvolvimento (Financeiro, abaixo de Ferramentas): quanto foi gasto em cada ferramenta a cada mês,
   contra as horas contratadas, e o que foi desenvolvido com essas horas (os cards do Trello de cada demanda).
   Dados: foto da planilha "Controle de horas Flow" (tabela dev_hours_snapshot), atualizada sozinha pela função hours-sync,
   e os cards do Trello já guardados em trello_cards (visão trello_cards_list), ligados pelo link de cada demanda.
   O mês escolhido no topo vale para a tela toda. Usa o kit visual do painel (flow-theme.css) e as classes de dev-hours.css. */
window.DevHours = (function () {
  "use strict";
  var A = null, S = { snap: null, cards: {}, month: null, tool: "all", q: "", loading: false };
  var TOOL_COLOR = { "Flow Tracking": "var(--c-tracking)", "Flow Pages": "var(--c-pages)", "Flow Spy": "var(--c-spy)", "Flow Safe": "var(--warning)" };
  var FALLBACK = ["var(--accent)", "var(--accent-3)", "var(--warning)", "var(--accent-2)"];
  var STAGE = { producao: "Em produção", teste_cliente: "Testes do cliente" };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function nf(v, d) { return v == null || isNaN(v) ? "—" : new Intl.NumberFormat("pt-BR", { minimumFractionDigits: d == null ? 0 : d, maximumFractionDigits: d == null ? 1 : d }).format(v); }
  function brl(v) { return v == null || isNaN(v) ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v); }
  function pct(v) { return v == null || !isFinite(v) ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%"; }
  function color(p, i) { return TOOL_COLOR[p] || FALLBACK[i % FALLBACK.length]; }
  function fmtDate(iso) { return iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "—"; }
  function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  // "https://trello.com/c/j4Vz1HWN/123-nome" → "j4Vz1HWN"
  function shortLink(url) { var m = /trello\.com\/c\/([A-Za-z0-9]+)/.exec(url || ""); return m ? m[1] : null; }
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------------- cálculo ---------------- */
  function model() {
    var d = S.snap.data || {}, projects = d.projects || [], sprints = d.sprints || [], deliveries = d.deliveries || [], contract = d.contract || [];
    var rate = d.rate || 0, sprintOf = {};
    sprints.forEach(function (s) { sprintOf[s.name] = s; });
    var months = contract.map(function (c) { return c.month; });
    deliveries.forEach(function (x) {
      var s = sprintOf[x.sprint] || {};
      x.month = s.month || ""; x.start = s.start || null; x.end = s.end || null;
      x.cost = x.value || x.hours * rate;
      x.card = S.cards[shortLink(x.trello)] || null;
      if (x.month && months.indexOf(x.month) < 0) months.push(x.month);
    });
    var rows = months.map(function (m) {
      var c = contract.filter(function (k) { return k.month === m; })[0] || { contracted: 0, carry: 0 };
      var by = {}, cost = {}, n = {}, spent = 0;
      projects.forEach(function (p) { by[p] = 0; cost[p] = 0; n[p] = 0; });
      deliveries.forEach(function (x) { if (x.month === m) { by[x.project] = (by[x.project] || 0) + x.hours; cost[x.project] = (cost[x.project] || 0) + x.cost; n[x.project] = (n[x.project] || 0) + 1; spent += x.hours; } });
      var avail = (c.contracted || 0) + (c.carry || 0);
      return { month: m, contracted: c.contracted || 0, carry: c.carry || 0, avail: avail, by: by, cost: cost, n: n, spent: spent, balance: avail - spent, use: avail ? spent / avail : null };
    });
    var noMonth = { by: {}, cost: {}, n: {}, spent: 0 };
    deliveries.forEach(function (x) { if (!x.month) { noMonth.by[x.project] = (noMonth.by[x.project] || 0) + x.hours; noMonth.cost[x.project] = (noMonth.cost[x.project] || 0) + x.cost; noMonth.n[x.project] = (noMonth.n[x.project] || 0) + 1; noMonth.spent += x.hours; } });
    var tot = { month: "all", contracted: 0, carry: 0, avail: 0, spent: noMonth.spent, by: {}, cost: {}, n: {} };
    rows.concat([noMonth]).forEach(function (r) {
      if (r !== noMonth) { tot.contracted += r.contracted; tot.carry += r.carry; tot.avail += r.avail; tot.spent += r.spent; }
      projects.forEach(function (p) { tot.by[p] = (tot.by[p] || 0) + (r.by[p] || 0); tot.cost[p] = (tot.cost[p] || 0) + (r.cost[p] || 0); tot.n[p] = (tot.n[p] || 0) + (r.n[p] || 0); });
    });
    tot.balance = tot.avail - tot.spent; tot.use = tot.avail ? tot.spent / tot.avail : null;
    var sprintRows = sprints.map(function (s) {
      var by = {}, spent = 0;
      projects.forEach(function (p) { by[p] = 0; });
      deliveries.forEach(function (x) { if (x.sprint === s.name) { by[x.project] = (by[x.project] || 0) + x.hours; spent += x.hours; } });
      return { name: s.name, start: s.start, end: s.end, month: s.month, by: by, spent: spent };
    });
    // Mês aberto: o escolhido; sem escolha, o último mês com horas lançadas (ou todos, se nenhum tiver).
    if (S.month == null || (S.month !== "all" && months.indexOf(S.month) < 0)) {
      var withHours = rows.filter(function (r) { return r.spent > 0; });
      S.month = withHours.length ? withHours[withHours.length - 1].month : "all";
    }
    var sel = S.month === "all" ? tot : rows.filter(function (r) { return r.month === S.month; })[0];
    return { projects: projects, months: months, rows: rows, tot: tot, sel: sel, rate: rate, noMonth: noMonth, sprintRows: sprintRows, deliveries: deliveries };
  }

  /* ---------------- tela ---------------- */
  function kpi(label, value, sub, cls) {
    return '<div class="kpi"><div class="label">' + label + '</div><div class="value num ' + (cls || "") + '">' + value + "</div>" + (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>";
  }
  /* cabeçalho de cada bloco: título + frase de apoio, com linha de separação abaixo */
  function ph(title, sub, extra) {
    return '<header class="dh-ph"><div><h3>' + title + "</h3>" + (sub ? "<p>" + sub + "</p>" : "") + "</div>" + (extra || "") + "</header>";
  }
  function stat(label, value, sub, cls) {
    return '<div class="dh-stat"><div class="dh-stat-l">' + label + '</div><div class="dh-stat-v num ' + (cls || "") + '">' + value + "</div>" + (sub ? '<div class="dh-stat-s">' + sub + "</div>" : "") + "</div>";
  }
  function chip(kind, val, label, on) {
    return '<button type="button" class="pay-chip' + (on ? " on" : "") + '" data-dh-f="' + kind + '" data-v="' + esc(val) + '" aria-pressed="' + on + '">' + esc(label) + "</button>";
  }
  function monthLabel() { return S.month === "all" ? "todo o período" : S.month; }

  function render() {
    var root = A.root;
    if (!S.snap) {
      root.innerHTML = '<section class="panel dh-empty"><h3>Horas de desenvolvimento</h3><p>Ainda não há dados da planilha. Clique em <b>Atualizar agora</b> para buscar.</p><button class="btn btn-primary" data-dh="sync" type="button">Atualizar agora</button></section>';
      return;
    }
    var m = model(), snap = S.snap;
    var when = new Date(snap.synced_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    var ageH = (Date.now() - new Date(snap.synced_at).getTime()) / 3600000;
    var url = "https://docs.google.com/spreadsheets/d/" + esc(snap.sheet_id) + "/edit";
    var head = '<div class="dh-head"><div><div class="dh-sub">Planilha <b>' + esc(snap.sheet_title || "controle de horas") + '</b> · última leitura ' + (snap.source === "sheet" ? "automática" : "manual (carga inicial)") + ' em ' + esc(when) + '</div>' +
      '<div class="dh-sub muted">A cada 30 minutos o painel relê a planilha sozinho. Os cards vêm dos boards do Trello pelo link de cada demanda.</div></div>' +
      '<div class="dh-acts"><button class="btn" type="button" data-dh="sync" id="dh-sync">↻ Atualizar agora</button><a class="btn" href="' + url + '" target="_blank" rel="noopener noreferrer">Abrir a planilha ↗</a></div></div>' +
      '<div id="dh-alert">' + (ageH > 2 ? '<div class="dh-warn"><b>Os dados podem estar desatualizados:</b> a última leitura da planilha foi em ' + esc(when) + '. Clique em <b>Atualizar agora</b> para ver o motivo.</div>' : "") + "</div>" +
      '<div class="dh-months" id="dh-months" role="group" aria-label="Mês"></div>';

    root.innerHTML = head + '<div id="dh-month-body"></div>' + renderFixed(m);
    renderMonth(m);
    drawChart(m); drawShare(m);
  }

  /* Blocos que mudam com o mês escolhido: números, ferramentas e o que foi desenvolvido. */
  function renderMonth(m) {
    var P = m.projects, sel = m.sel, rate = m.rate;
    document.getElementById("dh-months").innerHTML = m.months.map(function (x) { return chip("month", x, x, S.month === x); }).join("") + chip("month", "all", "Todo o período", S.month === "all");
    var spentCost = P.reduce(function (s, p) { return s + (sel.cost[p] || 0); }, 0);

    var kpis = '<div class="kpi-row dh-kpis" style="--n:5">' +
      kpi("Horas disponíveis", nf(sel.avail), nf(sel.contracted) + " contratadas" + (sel.carry ? " + " + nf(sel.carry) + " de saldo anterior" : "")) +
      kpi("Horas gastas", nf(sel.spent), "nas demandas de " + esc(monthLabel())) +
      kpi("Saldo de horas", nf(sel.balance), "disponível menos gasto", sel.balance < 0 ? "bad" : "good") +
      kpi("Consumo", pct(sel.use), "das horas disponíveis") +
      kpi("Valor das horas gastas", brl(spentCost), rate ? "média de " + brl(rate) + " por hora" : "") + "</div>";

    var tools = '<section class="panel">' + ph("Horas gastas por ferramenta · " + esc(monthLabel()), "Clique numa ferramenta para ver o que foi desenvolvido nela.") +
      '<div class="dh-tcards">' + P.map(function (p, i) {
        var h = sel.by[p] || 0, n = sel.n[p] || 0, share = sel.spent ? h / sel.spent : 0;
        return '<button type="button" class="dh-tcard' + (S.tool === p ? " on" : "") + '" data-dh-f="tool" data-v="' + esc(p) + '" style="--c:' + color(p, i) + '" aria-pressed="' + (S.tool === p) + '">' +
          '<span class="dh-tcard-n"><span class="dh-dot" style="background:' + color(p, i) + '"></span>' + esc(p) + "</span>" +
          '<span class="dh-tcard-v num">' + nf(h) + " h</span>" +
          '<span class="dh-tcard-bar"><i style="width:' + (share * 100).toFixed(1) + '%"></i></span>' +
          '<span class="dh-tcard-s">' + (h ? pct(share) + " das horas · " + brl(sel.cost[p] || 0) : "sem horas lançadas") + "</span>" +
          '<span class="dh-tcard-s">' + n + (n === 1 ? " demanda" : " demandas") + "</span></button>";
      }).join("") + "</div></section>";

    var dev = '<section class="panel">' + ph("O que foi desenvolvido · " + esc(monthLabel()), "Cada demanda da planilha com as horas, o valor e o card do Trello: o que é, em que lista está e o link.", '<span class="dh-count" id="dh-count"></span>') +
      '<div class="dh-tools"><input type="search" id="dh-q" placeholder="Buscar na demanda…" aria-label="Buscar nas demandas" value="' + esc(S.q) + '">' +
      chip("tool", "all", "Todas as ferramentas", S.tool === "all") + P.map(function (p) { return chip("tool", p, p, S.tool === p); }).join("") + "</div>" +
      '<div id="dh-dev"></div></section>';

    document.getElementById("dh-month-body").innerHTML = kpis + tools + dev;
    renderDev(m);
  }

  function renderDev(m) {
    var el = document.getElementById("dh-dev"); if (!el) return;
    var q = norm(S.q.trim()), P = m.projects;
    var list = m.deliveries.filter(function (x) {
      if (S.month !== "all" && x.month !== S.month) return false;
      if (S.tool !== "all" && x.project !== S.tool) return false;
      var c = x.card, ai = c && c.ai;
      return !q || norm(x.demand + " " + x.sprint + " " + x.project + " " + (c ? c.name : "") + " " + (ai ? ai.titulo : "")).indexOf(q) >= 0;
    });
    var sum = list.reduce(function (s, x) { return s + x.hours; }, 0), cost = list.reduce(function (s, x) { return s + x.cost; }, 0);
    var cnt = document.getElementById("dh-count");
    if (cnt) cnt.innerHTML = list.length + (list.length === 1 ? " demanda" : " demandas") + " · <b>" + nf(sum) + " h</b> · " + brl(cost);
    if (!list.length) { el.innerHTML = '<p class="dh-note">Nenhuma demanda lançada com esses filtros.</p>'; return; }
    el.innerHTML = P.concat(list.map(function (x) { return x.project; }).filter(function (p, i, a) { return P.indexOf(p) < 0 && a.indexOf(p) === i; })).map(function (p, i) {
      var items = list.filter(function (x) { return x.project === p; }).sort(function (a, b) { return b.hours - a.hours; });
      if (!items.length) return "";
      var h = items.reduce(function (s, x) { return s + x.hours; }, 0), v = items.reduce(function (s, x) { return s + x.cost; }, 0);
      return '<div class="dh-group"><div class="dh-group-h" style="--c:' + color(p, i) + '"><span class="dh-dot" style="background:' + color(p, i) + '"></span><b>' + esc(p) + '</b><span class="muted">' + items.length + (items.length === 1 ? " demanda" : " demandas") + " · " + nf(h) + " h · " + brl(v) + "</span></div>" +
        '<div class="dh-cards">' + items.map(function (x) { return devCard(x, color(p, i)); }).join("") + "</div></div>";
    }).join("");
  }

  function devCard(x, c) {
    var card = x.card, ai = card && card.ai, link = x.trello && /^https:\/\//.test(x.trello) ? x.trello : null;
    var title = ai && ai.titulo ? ai.titulo : card ? card.name : x.demand;
    var what = ai && ai.resumo ? ai.resumo.o_que_e : card && card.description ? card.description : "";
    var stage = card ? '<span class="dh-stage s-' + esc(card.stage) + '">' + esc(STAGE[card.stage] || card.list_name) + "</span>" : link ? '<span class="dh-stage">Card fora das listas acompanhadas</span>' : '<span class="dh-stage">Sem card no Trello</span>';
    return '<article class="dh-card" style="--c:' + c + '">' +
      '<div class="dh-card-top"><span class="dh-card-sprint">' + esc(x.sprint) + (x.start ? " · " + fmtDate(x.start).slice(0, 5) + " a " + fmtDate(x.end).slice(0, 5) : "") + "</span>" + stage + (ai && ai.tipo ? '<span class="dh-type">' + esc(ai.tipo) + "</span>" : "") + "</div>" +
      "<h4>" + esc(title) + "</h4>" +
      (title !== x.demand ? '<div class="dh-card-dem">Na planilha: ' + esc(x.demand) + "</div>" : "") +
      (what ? '<p class="dh-card-sum">' + esc(what.length > 260 ? what.slice(0, 260) + "…" : what) + "</p>" : "") +
      (ai && ai.resumo && ai.resumo.beneficio ? '<p class="dh-card-ben"><b>Benefício:</b> ' + esc(ai.resumo.beneficio) + "</p>" : "") +
      '<div class="dh-card-foot"><span class="num"><b>' + nf(x.hours) + " h</b></span><span class=\"num muted\">" + brl(x.cost) + "</span>" +
      (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Abrir no Trello ↗</a>' : "") + "</div></article>";
  }

  /* Blocos de referência (não mudam com o mês): mês a mês, gráficos, sprints e contratos. */
  function renderFixed(m) {
    var P = m.projects, snap = S.snap;
    var table = '<section class="panel">' + ph("Horas por ferramenta em cada mês", "Horas gastas em cada ferramenta contra o que estava disponível no mês.") + '<div class="table-scroll"><table class="dh-table"><thead><tr><th class="l">Mês</th>' +
      P.map(function (p, i) { return '<th class="nw"><span class="dh-dot" style="background:' + color(p, i) + '"></span>' + esc(p) + "</th>"; }).join("") +
      "<th>Gastas</th><th>Contratado</th><th>Saldo anterior</th><th>Disponível</th><th>Saldo do mês</th><th>% consumo</th></tr></thead><tbody>" +
      m.rows.map(function (r) {
        return '<tr><td class="l">' + esc(r.month) + "</td>" + P.map(function (p) { return '<td class="num">' + nf(r.by[p] || 0) + "</td>"; }).join("") +
          '<td class="num"><b>' + nf(r.spent) + '</b></td><td class="num">' + nf(r.contracted) + '</td><td class="num">' + nf(r.carry) + '</td><td class="num">' + nf(r.avail) + '</td><td class="num ' + (r.balance < 0 ? "bad" : "") + '">' + nf(r.balance) + '</td><td class="num">' +
          '<span class="dh-use"><i style="width:' + Math.min(100, (r.use || 0) * 100).toFixed(1) + '%"></i></span> ' + pct(r.use) + "</td></tr>";
      }).join("") +
      '<tr class="dh-total"><td class="l">Total</td>' + P.map(function (p) { return '<td class="num">' + nf(m.tot.by[p] || 0) + "</td>"; }).join("") +
      '<td class="num"><b>' + nf(m.tot.spent) + '</b></td><td class="num">' + nf(m.tot.contracted) + '</td><td class="num">' + nf(m.tot.carry) + '</td><td class="num">' + nf(m.tot.avail) + '</td><td class="num">' + nf(m.tot.balance) + '</td><td class="num">' + pct(m.tot.use) + "</td></tr>" +
      "</tbody></table></div>" + (m.noMonth.spent ? '<p class="dh-note">' + nf(m.noMonth.spent) + ' h lançadas em sprints sem mês de referência na planilha: contam no total, mas não aparecem em nenhum mês.</p>' : "") + "</section>";

    var legend = '<div class="legend dh-legend">' +
      P.map(function (p, i) { return '<span><span class="dot" style="background:' + color(p, i) + '"></span>' + esc(p) + "</span>"; }).join("") + '<span><span class="dot dh-ghost"></span>Disponível</span></div>';
    var charts = '<div class="dh-grid"><section class="panel">' + ph("Horas gastas por mês", "Barras tracejadas mostram as horas disponíveis.") + legend + '<div class="chart-wrap"><div id="dh-chart"></div><div id="dh-tip" class="tooltip"></div></div></section>' +
      '<section class="panel">' + ph("Quem consumiu as horas", "Participação de cada ferramenta no total gasto do período.") + '<div id="dh-share"></div></section></div>';

    var sprints = '<section class="panel">' + ph("Horas por sprint", "Período de cada sprint e o mês em que as horas contam.") + '<div class="table-scroll"><table class="dh-table"><thead><tr><th class="l">Sprint</th><th class="l">Período</th><th class="l">Mês de referência</th>' +
      P.map(function (p) { return "<th>" + esc(p) + "</th>"; }).join("") + "<th>Total</th></tr></thead><tbody>" +
      (m.sprintRows.length ? m.sprintRows.map(function (s) {
        return '<tr><td class="l">' + esc(s.name) + '</td><td class="l num">' + fmtDate(s.start) + " a " + fmtDate(s.end) + '</td><td class="l">' + esc(s.month || "—") + "</td>" +
          P.map(function (p) { return '<td class="num">' + nf(s.by[p] || 0) + "</td>"; }).join("") + '<td class="num"><b>' + nf(s.spent) + "</b></td></tr>";
      }).join("") : '<tr><td colspan="' + (P.length + 4) + '" class="empty">Nenhuma sprint cadastrada na planilha.</td></tr>') + "</tbody></table></div></section>";

    var D = snap.data || {}, CT = D.contracts || [], AV = D.contractAvg || null, contractSec = "";
    if (CT.length) {
      var money = function (v) { return v == null ? "—" : brl(v); };
      /* Recorrência: contrato mensal fixo. Na planilha ficam em branco o valor pago e as horas do contrato; valem os dados informados (R$ 48.000,00 por mês, 360 h). Se a planilha passar a trazer, ela prevalece. */
      var FIXED = { recorrencia: { paid: 48000, hours: 360 } };
      CT.forEach(function (c) {
        var f = FIXED[norm(c.name).split(/[^a-z]/)[0]];
        c.recurring = !!f || c.hours == null;
        if (f) { if (c.paid == null) c.paid = f.paid; if (c.hours == null) c.hours = f.hours; }
      });
      var h = function (v) { return v == null ? "—" : nf(v); };
      var sumMonthly = CT.reduce(function (s, c) { return s + (c.monthly || 0); }, 0);
      var rateMax = Math.max.apply(null, CT.map(function (c) { return c.rate; }).concat([AV ? AV.rate : 0, 1]));
      contractSec = '<section class="panel">' + ph("Contratos e valor por hora", "Quanto está contratado por mês e quanto custa cada hora.") +
        '<div class="dh-stats">' +
        stat("Horas contratadas por mês", nf(AV ? AV.hoursMonth : CT.reduce(function (s, c) { return s + c.hoursMonth; }, 0)), "soma dos " + CT.length + " contratos") +
        stat("Total contratado no período", nf(m.tot.contracted), m.rows.length + " meses · " + nf(m.tot.avail) + " h com o saldo anterior") +
        stat("Valor médio por hora", brl(AV ? AV.rate : D.rate), "média ponderada dos contratos") +
        stat("Valor mensal dos contratos", brl(AV && AV.monthly ? AV.monthly : sumMonthly), "horas por mês vezes o valor da hora") + "</div>" +
        '<div class="table-scroll"><table class="dh-table"><thead><tr><th class="l">Contrato</th><th>Horas por mês</th><th>Horas do contrato</th><th>Valor pago</th><th>Valor da hora</th><th>Valor mensal</th><th class="l">Comparar</th></tr></thead><tbody>' +
        CT.map(function (c) {
          return '<tr><td class="l">' + esc(c.name) + '</td><td class="num">' + nf(c.hoursMonth) + '</td><td class="num">' + h(c.hours) + '</td><td class="num">' + money(c.paid) + (c.recurring && c.paid != null ? ' <span class="muted">/mês</span>' : "") + '</td><td class="num"><b>' + brl(c.rate) + '</b></td><td class="num">' + money(c.monthly) + '</td>' +
            '<td class="l"><span class="dh-use" style="width:110px"><i style="width:' + (c.rate / rateMax * 100).toFixed(1) + '%"></i></span></td></tr>';
        }).join("") + "</tbody>" +
        (AV ? '<tfoot><tr class="dh-foot"><td class="l">Total / média ponderada</td><td class="num">' + nf(AV.hoursMonth) + '</td><td class="num">—</td><td class="num">' + money(AV.paid) + '</td><td class="num">' + brl(AV.rate) + '</td><td class="num">' + money(AV.monthly || sumMonthly) + '</td><td class="l"><span class="dh-use" style="width:110px"><i style="width:' + (AV.rate / rateMax * 100).toFixed(1) + '%"></i></span></td></tr></tfoot>' : "") +
        "</table></div>" + (CT.some(function (c) { return c.recurring && c.paid != null; }) ? '<p class="dh-note">Na recorrência o valor pago é mensal. Nos demais contratos é o valor total, e o total do rodapé soma só esses contratos fechados, como na planilha.</p>' : "") + "</section>";
    }
    return table + charts + sprints + contractSec;
  }

  function drawChart(m) {
    var el = document.getElementById("dh-chart"); if (!el) return;
    var P = m.projects, rows = m.rows, W = Math.max(el.clientWidth || 520, 300), H = 250, mg = { l: 46, r: 10, t: 14, b: 28 }, iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    var max = Math.max.apply(null, rows.map(function (r) { return Math.max(r.avail, r.spent); }).concat([1])) * 1.08;
    var Y = function (v) { return mg.t + ih - v / max * ih; }, slot = iw / Math.max(rows.length, 1), bw = Math.min(64, slot * 0.5);
    var grid = FlowHud.tok("--chart-grid"), muted = FlowHud.tok("--text-muted"), border = FlowHud.tok("--border-strong");
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Horas gastas por mês e por ferramenta" style="width:100%;height:auto;display:block">';
    for (var t = 0; t <= 4; t++) { var v = max * t / 4; s += '<line x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="' + grid + '"/><text x="' + (mg.l - 8) + '" y="' + (Y(v) + 3) + '" text-anchor="end" font-size="9.5" fill="' + muted + '" font-family="JetBrains Mono, monospace">' + Math.round(v) + "</text>"; }
    rows.forEach(function (r, i) {
      var cx = mg.l + slot * (i + 0.5), x = cx - bw / 2;
      s += '<rect x="' + x + '" y="' + Y(r.avail) + '" width="' + bw + '" height="' + (mg.t + ih - Y(r.avail)) + '" rx="6" fill="none" stroke="' + border + '" stroke-dasharray="4 4"><title>' + esc(r.month + ": " + nf(r.avail) + " h disponíveis") + "</title></rect>";
      var acc = 0;
      P.forEach(function (p, pi) {
        var h = (r.by[p] || 0) / max * ih; if (!h) return;
        var top = Y(acc + (r.by[p] || 0));
        s += '<rect x="' + x + '" y="' + top + '" width="' + bw + '" height="' + Math.max(h, 1) + '" rx="' + (acc + (r.by[p] || 0) >= r.spent - 0.001 ? 5 : 0) + '" fill="' + color(p, pi) + '" fill-opacity="0.92"><title>' + esc(r.month + " · " + p + ": " + nf(r.by[p]) + " h") + "</title></rect>";
        acc += r.by[p] || 0;
      });
      s += '<text x="' + cx + '" y="' + (Y(Math.max(r.spent, 0)) - 6) + '" text-anchor="middle" font-size="11" font-weight="600" fill="' + FlowHud.tok("--text") + '" font-family="JetBrains Mono, monospace">' + (r.spent ? nf(r.spent) : "") + "</text>";
      s += '<text x="' + cx + '" y="' + (H - 9) + '" text-anchor="middle" font-size="10.5" fill="' + muted + '" font-family="JetBrains Mono, monospace">' + esc(r.month.slice(0, 3).toUpperCase()) + "</text>";
    });
    el.innerHTML = s + "</svg>";
  }

  function drawShare(m) {
    var el = document.getElementById("dh-share"); if (!el) return;
    var P = m.projects, tot = m.tot.spent;
    if (!tot) { el.innerHTML = '<p class="dh-note">Nenhuma hora lançada ainda.</p>'; return; }
    var bar = '<div class="dh-stack">' + P.map(function (p, i) { var v = m.tot.by[p] || 0; return v ? '<i style="width:' + (v / tot * 100).toFixed(2) + "%;background:" + color(p, i) + '" title="' + esc(p + ": " + nf(v) + " h") + '"></i>' : ""; }).join("") + "</div>";
    el.innerHTML = bar + '<ul class="dh-list">' + P.map(function (p, i) {
      var v = m.tot.by[p] || 0;
      return '<li><span class="dh-dot" style="background:' + color(p, i) + '"></span><span class="n">' + esc(p) + '</span><span class="num">' + nf(v) + ' h</span><span class="muted num">' + pct(v / tot) + "</span></li>";
    }).join("") + "</ul>";
  }

  /* ---------------- dados ---------------- */
  // Cards do Trello das demandas, pelo código curto do link. Sem acesso ou sem o card guardado, a demanda aparece só com o link.
  async function loadCards(snap) {
    var codes = ((snap && snap.data && snap.data.deliveries) || []).map(function (x) { return shortLink(x.trello); }).filter(function (c, i, a) { return c && a.indexOf(c) === i && !S.cards[c]; });
    for (var i = 0; i < codes.length; i += 40) {
      var part = codes.slice(i, i + 40);
      var r = await A.sb.from("trello_cards_list").select("id, url, name, list_name, stage, board_name, ai, description").or(part.map(function (c) { return "url.like.*/c/" + c + "*"; }).join(","));
      if (r.error) return;
      (r.data || []).forEach(function (c) { var k = shortLink(c.url); if (k) S.cards[k] = c; });
    }
  }
  async function load() {
    var r = await A.sb.from("dev_hours_snapshot").select("sheet_id, sheet_title, data, source, synced_at").eq("id", 1).maybeSingle();
    if (r.error) { A.toast("Erro ao ler as horas: " + r.error.message, true); return; }
    S.snap = r.data || null;
    if (S.snap) render(); // mostra as horas na hora; os cards completam a seção logo depois
    await loadCards(S.snap).catch(function () {});
    render();
  }
  async function syncNow() {
    if (S.loading) return;
    S.loading = true;
    var btn = document.getElementById("dh-sync"); if (btn) { btn.disabled = true; btn.textContent = "Atualizando…"; }
    var res = await A.sb.functions.invoke("hours-sync", { body: {} }), data = res.data || {};
    if (res.error && !data.error) { try { data = await res.error.context.json(); } catch (e) { data = { error: res.error.message }; } }
    S.loading = false;
    if (data.ok) { A.toast("Planilha lida: " + data.deliveries + " demandas, " + nf(data.hours) + " horas."); await load(); return; }
    await load();
    var al = document.getElementById("dh-alert");
    var msg = data.code === "sheet_private"
      ? "<b>A planilha está privada, então o painel não consegue ler sozinho.</b> No Google Sheets: Compartilhar → Acesso geral → <b>Qualquer pessoa com o link</b> → <b>Leitor</b>. Depois clique em Atualizar agora. Enquanto isso, o painel mostra a última foto que temos."
      : "Não foi possível atualizar: " + esc(data.error || "erro desconhecido");
    if (al) al.innerHTML = '<div class="dh-warn">' + msg + "</div>";
    else A.toast(String(data.error || "Erro ao atualizar."), true);
  }

  function bind() {
    A.root.addEventListener("click", function (e) {
      if (e.target.closest("[data-dh=sync]")) return syncNow();
      var f = e.target.closest("[data-dh-f]");
      if (!f) return;
      var k = f.dataset.dhF, v = f.dataset.v;
      if (k === "tool" && S.tool === v && f.classList.contains("dh-tcard")) v = "all"; // clicar de novo no card da ferramenta tira o filtro
      S[k] = v;
      if (k === "month") safeSet("flow_dh_month", v);
      renderMonth(model());
    });
    A.root.addEventListener("input", function (e) { if (e.target.id === "dh-q") { S.q = e.target.value; renderDev(model()); } });
  }

  return {
    init: function (deps) { A = deps; S.month = safeGet("flow_dh_month"); bind(); },
    show: function () { A.root.hidden = false; return load(); },
    hide: function () { A.root.hidden = true; },
    redraw: function () { if (S.snap && !A.root.hidden) { var m = model(); drawChart(m); } }
  };
})();
