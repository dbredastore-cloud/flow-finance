/* Horas de desenvolvimento: quanto foi gasto em cada ferramenta a cada mês, contra as horas contratadas.
   Dados: foto da planilha "controle-horas-flow" (tabela dev_hours_snapshot), atualizada sozinha pela função hours-sync.
   Usa o kit visual do painel (flow-theme.css) e as classes de dev-hours.css. */
window.DevHours = (function () {
  "use strict";
  var A = null, S = { snap: null, month: "all", tool: "all", q: "", loading: false };
  var TOOL_COLOR = { "Flow Tracking": "var(--c-tracking)", "Flow Pages": "var(--c-pages)", "Flow Spy": "var(--c-spy)" };
  var FALLBACK = ["var(--accent)", "var(--accent-3)", "var(--warning)", "var(--accent-2)"];

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function nf(v, d) { return v == null || isNaN(v) ? "—" : new Intl.NumberFormat("pt-BR", { minimumFractionDigits: d == null ? 0 : d, maximumFractionDigits: d == null ? 1 : d }).format(v); }
  function pct(v) { return v == null || !isFinite(v) ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%"; }
  function color(p, i) { return TOOL_COLOR[p] || FALLBACK[i % FALLBACK.length]; }
  function fmtDate(iso) { return iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "—"; }
  function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

  /* ---------------- cálculo ---------------- */
  function model() {
    var d = S.snap.data || {}, projects = d.projects || [], sprints = d.sprints || [], deliveries = d.deliveries || [], contract = d.contract || [];
    var monthOfSprint = {};
    sprints.forEach(function (s) { monthOfSprint[s.name] = s.month || ""; });
    var months = contract.map(function (c) { return c.month; });
    deliveries.forEach(function (x) { x.month = monthOfSprint[x.sprint] || ""; if (x.month && months.indexOf(x.month) < 0) months.push(x.month); });
    var rows = months.map(function (m) {
      var c = contract.filter(function (k) { return k.month === m; })[0] || { contracted: 0, carry: 0 };
      var by = {}, spent = 0;
      projects.forEach(function (p) { by[p] = 0; });
      deliveries.forEach(function (x) { if (x.month === m) { by[x.project] = (by[x.project] || 0) + x.hours; spent += x.hours; } });
      var avail = (c.contracted || 0) + (c.carry || 0);
      return { month: m, contracted: c.contracted || 0, carry: c.carry || 0, avail: avail, by: by, spent: spent, balance: avail - spent, use: avail ? spent / avail : null };
    });
    var noMonth = { by: {}, spent: 0 };
    deliveries.forEach(function (x) { if (!x.month) { noMonth.by[x.project] = (noMonth.by[x.project] || 0) + x.hours; noMonth.spent += x.hours; } });
    var tot = rows.reduce(function (t, r) { t.contracted += r.contracted; t.carry += r.carry; t.avail += r.avail; t.spent += r.spent; projects.forEach(function (p) { t.by[p] = (t.by[p] || 0) + (r.by[p] || 0); }); return t; },
      { contracted: 0, carry: 0, avail: 0, spent: noMonth.spent, by: {} });
    projects.forEach(function (p) { tot.by[p] = (tot.by[p] || 0) + (noMonth.by[p] || 0); });
    tot.balance = tot.avail - tot.spent; tot.use = tot.avail ? tot.spent / tot.avail : null;
    var sprintRows = sprints.map(function (s) {
      var by = {}, spent = 0;
      projects.forEach(function (p) { by[p] = 0; });
      deliveries.forEach(function (x) { if (x.sprint === s.name) { by[x.project] = (by[x.project] || 0) + x.hours; spent += x.hours; } });
      return { name: s.name, start: s.start, end: s.end, month: s.month, by: by, spent: spent };
    });
    return { projects: projects, months: months, rows: rows, tot: tot, noMonth: noMonth, sprintRows: sprintRows, deliveries: deliveries };
  }

  /* ---------------- tela ---------------- */
  function kpi(label, value, sub, cls) {
    return '<div class="kpi"><div class="label">' + label + '</div><div class="value num ' + (cls || "") + '">' + value + "</div>" + (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>";
  }

  function render() {
    var root = A.root;
    if (!S.snap) {
      root.innerHTML = '<section class="panel dh-empty"><h3>Horas de desenvolvimento</h3><p>Ainda não há dados da planilha. Clique em <b>Atualizar agora</b> para buscar.</p><button class="btn btn-primary" data-dh="sync" type="button">Atualizar agora</button></section>';
      return;
    }
    var m = model(), P = m.projects, snap = S.snap;
    var when = new Date(snap.synced_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    var url = "https://docs.google.com/spreadsheets/d/" + esc(snap.sheet_id) + "/edit";
    var head = '<div class="dh-head"><div><div class="dh-sub">Planilha <b>' + esc(snap.sheet_title || "controle de horas") + '</b> · atualizada ' + (snap.source === "sheet" ? "automaticamente" : "manualmente (carga inicial)") + ' em ' + esc(when) + '</div>' +
      '<div class="dh-sub muted">A cada 30 minutos o painel relê a planilha sozinho.</div></div>' +
      '<div class="dh-acts"><button class="btn" type="button" data-dh="sync" id="dh-sync">↻ Atualizar agora</button><a class="btn" href="' + url + '" target="_blank" rel="noopener noreferrer">Abrir a planilha ↗</a></div></div>' +
      '<div id="dh-alert"></div>';

    var kpis = '<div class="kpi-row dh-kpis">' +
      kpi("Horas disponíveis", nf(m.tot.avail), nf(m.tot.contracted) + " contratadas" + (m.tot.carry ? " + " + nf(m.tot.carry) + " de saldo anterior" : "")) +
      kpi("Horas gastas", nf(m.tot.spent), "soma de todas as demandas lançadas") +
      kpi("Saldo de horas", nf(m.tot.balance), "disponível menos gasto", m.tot.balance < 0 ? "bad" : "good") +
      kpi("Consumo do total", pct(m.tot.use), "das horas disponíveis") +
      P.map(function (p, i) { return kpi(esc(p), nf(m.tot.by[p] || 0), m.tot.spent ? pct((m.tot.by[p] || 0) / m.tot.spent) + " das horas gastas" : "sem horas lançadas"); }).join("") + "</div>";

    var table = '<section class="panel"><div class="panel-head"><h3>Horas por ferramenta em cada mês</h3></div><div class="table-scroll"><table class="dh-table"><thead><tr><th class="l">Mês</th>' +
      P.map(function (p, i) { return '<th><span class="dh-dot" style="background:' + color(p, i) + '"></span>' + esc(p) + "</th>"; }).join("") +
      "<th>Gastas</th><th>Contratado</th><th>Saldo anterior</th><th>Disponível</th><th>Saldo do mês</th><th>% consumo</th></tr></thead><tbody>" +
      m.rows.map(function (r) {
        return '<tr><td class="l">' + esc(r.month) + "</td>" + P.map(function (p) { return '<td class="num">' + nf(r.by[p] || 0) + "</td>"; }).join("") +
          '<td class="num"><b>' + nf(r.spent) + '</b></td><td class="num">' + nf(r.contracted) + '</td><td class="num">' + nf(r.carry) + '</td><td class="num">' + nf(r.avail) + '</td><td class="num ' + (r.balance < 0 ? "bad" : "") + '">' + nf(r.balance) + '</td><td class="num">' +
          '<span class="dh-use"><i style="width:' + Math.min(100, (r.use || 0) * 100).toFixed(1) + '%"></i></span> ' + pct(r.use) + "</td></tr>";
      }).join("") +
      '<tr class="dh-total"><td class="l">Total</td>' + P.map(function (p) { return '<td class="num">' + nf(m.tot.by[p] || 0) + "</td>"; }).join("") +
      '<td class="num"><b>' + nf(m.tot.spent) + '</b></td><td class="num">' + nf(m.tot.contracted) + '</td><td class="num">' + nf(m.tot.carry) + '</td><td class="num">' + nf(m.tot.avail) + '</td><td class="num">' + nf(m.tot.balance) + '</td><td class="num">' + pct(m.tot.use) + "</td></tr>" +
      "</tbody></table></div>" + (m.noMonth.spent ? '<p class="dh-note">' + nf(m.noMonth.spent) + ' h lançadas em sprints sem mês de referência na planilha: contam no total, mas não aparecem em nenhum mês.</p>' : "") + "</section>";

    var charts = '<div class="dh-grid"><section class="panel"><div class="panel-head"><h3>Horas gastas por mês</h3><div class="legend">' +
      P.map(function (p, i) { return '<span><span class="dot" style="background:' + color(p, i) + '"></span>' + esc(p) + "</span>"; }).join("") + '<span><span class="dot dh-ghost"></span>Disponível</span></div></div><div class="chart-wrap"><div id="dh-chart"></div><div id="dh-tip" class="tooltip"></div></div></section>' +
      '<section class="panel"><div class="panel-head"><h3>Quem consumiu as horas</h3></div><div id="dh-share"></div></section></div>';

    var sprints = '<section class="panel"><div class="panel-head"><h3>Horas por sprint</h3></div><div class="table-scroll"><table class="dh-table"><thead><tr><th class="l">Sprint</th><th class="l">Período</th><th class="l">Mês de referência</th>' +
      P.map(function (p) { return "<th>" + esc(p) + "</th>"; }).join("") + "<th>Total</th></tr></thead><tbody>" +
      (m.sprintRows.length ? m.sprintRows.map(function (s) {
        return '<tr><td class="l">' + esc(s.name) + '</td><td class="l num">' + fmtDate(s.start) + " a " + fmtDate(s.end) + '</td><td class="l">' + esc(s.month || "—") + "</td>" +
          P.map(function (p) { return '<td class="num">' + nf(s.by[p] || 0) + "</td>"; }).join("") + '<td class="num"><b>' + nf(s.spent) + "</b></td></tr>";
      }).join("") : '<tr><td colspan="' + (P.length + 4) + '" class="empty">Nenhuma sprint cadastrada na planilha.</td></tr>') + "</tbody></table></div></section>";

    var deliv = '<section class="panel"><div class="panel-head"><h3>Demandas lançadas</h3><span class="muted" id="dh-count"></span></div><div class="mr-tools dh-tools" id="dh-tools"></div>' +
      '<div class="table-scroll"><table class="dh-table dh-deliv"><thead><tr><th class="l">Sprint</th><th class="l">Demanda</th><th class="l">Ferramenta</th><th>Horas</th><th class="l">Trello</th></tr></thead><tbody id="dh-body"></tbody></table></div></section>';

    root.innerHTML = head + kpis + table + charts + sprints + deliv;
    drawChart(m); drawShare(m); renderTools(m); renderDeliveries(m);
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

  function renderTools(m) {
    var el = document.getElementById("dh-tools"); if (!el) return;
    var chip = function (kind, val, label, on) { return '<button type="button" class="pay-chip' + (on ? " on" : "") + '" data-dh-f="' + kind + '" data-v="' + esc(val) + '" aria-pressed="' + on + '">' + esc(label) + "</button>"; };
    el.innerHTML = '<input type="search" id="dh-q" placeholder="Buscar na demanda…" aria-label="Buscar nas demandas" value="' + esc(S.q) + '">' +
      chip("month", "all", "Todos os meses", S.month === "all") + m.months.map(function (x) { return chip("month", x, x, S.month === x); }).join("") +
      '<span class="muted" style="margin:0 4px">|</span>' + chip("tool", "all", "Todas as ferramentas", S.tool === "all") + m.projects.map(function (p) { return chip("tool", p, p, S.tool === p); }).join("");
  }

  function renderDeliveries(m) {
    var body = document.getElementById("dh-body"); if (!body) return;
    var q = norm(S.q.trim()), P = m.projects;
    var list = m.deliveries.filter(function (x) {
      if (S.month !== "all" && x.month !== S.month) return false;
      if (S.tool !== "all" && x.project !== S.tool) return false;
      return !q || norm(x.demand + " " + x.sprint + " " + x.project).indexOf(q) >= 0;
    });
    var sum = list.reduce(function (s, x) { return s + x.hours; }, 0);
    body.innerHTML = list.length ? list.map(function (x) {
      var i = Math.max(0, P.indexOf(x.project));
      return '<tr><td class="l">' + esc(x.sprint) + '</td><td class="l dh-demand">' + esc(x.demand) + '</td><td class="l"><span class="dh-chip" style="--c:' + color(x.project, i) + '">' + esc(x.project) + '</span></td><td class="num"><b>' + nf(x.hours) + '</b></td><td class="l">' +
        (x.trello && /^https:\/\//.test(x.trello) ? '<a href="' + esc(x.trello) + '" target="_blank" rel="noopener noreferrer">Abrir no Trello ↗</a>' : '<span class="muted">—</span>') + "</td></tr>";
    }).join("") : '<tr><td colspan="5" class="empty">Nenhuma demanda com esses filtros.</td></tr>';
    var c = document.getElementById("dh-count");
    if (c) c.innerHTML = list.length + " de " + m.deliveries.length + " demandas · <b>" + nf(sum) + " h</b>";
  }

  /* ---------------- dados ---------------- */
  async function load() {
    var r = await A.sb.from("dev_hours_snapshot").select("sheet_id, sheet_title, data, source, synced_at").eq("id", 1).maybeSingle();
    if (r.error) { A.toast("Erro ao ler as horas: " + r.error.message, true); return; }
    S.snap = r.data || null;
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
      ? "<b>A planilha ainda está privada, então o painel não consegue ler sozinho.</b> No Google Sheets: Compartilhar → Acesso geral → <b>Qualquer pessoa com o link</b> → <b>Leitor</b>. Depois clique em Atualizar agora. Enquanto isso, o painel mostra a última foto que temos."
      : "Não foi possível atualizar: " + esc(data.error || "erro desconhecido");
    if (al) al.innerHTML = '<div class="mr-fnote">' + msg + "</div>";
    else A.toast(String(data.error || "Erro ao atualizar."), true);
  }

  function bind() {
    A.root.addEventListener("click", function (e) {
      if (e.target.closest("[data-dh=sync]")) return syncNow();
      var f = e.target.closest("[data-dh-f]");
      if (f) { S[f.dataset.dhF] = f.dataset.v; var m = model(); renderTools(m); renderDeliveries(m); }
    });
    A.root.addEventListener("input", function (e) { if (e.target.id === "dh-q") { S.q = e.target.value; renderDeliveries(model()); } });
  }

  return {
    init: function (deps) { A = deps; bind(); },
    show: function () { A.root.hidden = false; return load(); },
    hide: function () { A.root.hidden = true; },
    redraw: function () { if (S.snap && !A.root.hidden) { var m = model(); drawChart(m); } }
  };
})();
