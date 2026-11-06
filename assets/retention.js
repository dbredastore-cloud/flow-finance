/* Retenção e Monetização (menu Análises do Financeiro).
   Dados: função SQL rm_dashboard(p_ini, p_fim, p_plano), que lê o cache rm_* atualizado pelo pg_cron a cada 30 min
   (migrations 20261104_retention_cache.sql e 20261104_retention_dashboard.sql). Nada é calculado com dado fictício:
   sem base para a conta, o card mostra "Dados insuficientes".
   Escopos: "all" (consolidado por cliente) e cada ferramenta (flowtracking, flowpages, flowspy).
   Uso: RetentionDash.init({ root, sb, toast }); RetentionDash.show(); RetentionDash.hide(); RetentionDash.redraw(); */
(function () {
  "use strict";

  var TOOLS = [["flowtracking", "Flow Tracking"], ["flowpages", "Flow Pages"], ["flowspy", "Flow Spy"]];
  var SCOPES = [["all", "Consolidado"]].concat(TOOLS);
  var TOOL_NAME = { all: "Consolidado", flowtracking: "Flow Tracking", flowpages: "Flow Pages", flowspy: "Flow Spy" };
  var PERIODS = [["30", "30 dias"], ["90", "90 dias"], ["180", "180 dias"], ["365", "365 dias"], ["ano", "Este ano"], ["mes", "Mês atual"], ["mes_ant", "Mês anterior"], ["total", "Período total"], ["custom", "Personalizado"]];
  // 1ª venda paga (fora teste/cortesia): o "Período total" começa aqui. A data real vem do banco (periodo.<escopo>.primeira_venda);
  // esta só é usada antes da 1ª resposta. Cada ferramenta só tem dados a partir da própria 1ª venda.
  var PRIMEIRA_VENDA = "2025-06-16";
  var PLANS = [["todos", "Todos os planos"], ["mensal", "Mensal"], ["anual", "Anual"], ["semestral", "Semestral/trimestral"], ["vitalicio", "Vitalício"]];
  var PLAN_LABEL = { todos: "todos os planos", mensal: "mensal", anual: "anual", semestral: "semestral/trimestral", vitalicio: "vitalício" };
  var MARCOS = [["1", "D30"], ["3", "D90"], ["6", "D180"], ["12", "D365"]];
  var COMBOS = [
    ["flowtracking", "Só Flow Tracking"], ["flowpages", "Só Flow Pages"], ["flowspy", "Só Flow Spy"],
    ["flowpages+flowtracking", "Flow Tracking + Flow Pages"], ["flowspy+flowtracking", "Flow Tracking + Flow Spy"],
    ["flowpages+flowspy", "Flow Pages + Flow Spy"], ["flowpages+flowspy+flowtracking", "As três ferramentas"]
  ];
  var INSUF = "Dados insuficientes";
  var PREF = "flow_rm_prefs";
  var CACHE = "flow_rm_cache:";

  var A = null;
  var S = { period: "90", from: "", to: "", plano: "todos", scope: "all", data: null, loading: false, seq: 0, timer: null, visible: false };

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmtInt(n) { return n == null ? "—" : Math.round(Number(n)).toLocaleString("pt-BR"); }
  function fmtBRL(n, d) { return n == null || !isFinite(n) ? "—" : Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: d == null ? 2 : d, minimumFractionDigits: d == null ? 2 : d }); }
  function fmtPct(v, d) { return v == null || !isFinite(v) ? "—" : (v * 100).toFixed(d == null ? 1 : d).replace(".", ",") + "%"; }
  function fmtX(v) { return v == null || !isFinite(v) ? "—" : v.toFixed(1).replace(".", ",") + "x"; }
  function fmtDec(v, d) { return v == null || !isFinite(v) ? "—" : Number(v).toFixed(d == null ? 1 : d).replace(".", ","); }
  function ratio(a, b) { return b > 0 ? a / b : null; }
  function tok(k) { return getComputedStyle(document.documentElement).getPropertyValue(k).trim(); }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseIso(s) { var p = String(s).slice(0, 10).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmtDay(s) { return s ? parseIso(s).toLocaleDateString("pt-BR") : "—"; }
  function fmtDateTime(s) { if (!s) return "—"; var d = new Date(s); return d.toLocaleDateString("pt-BR") + " às " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }
  var MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  function fmtMes(s) { var d = parseIso(s); return MES[d.getMonth()] + "/" + String(d.getFullYear()).slice(2); }
  function safeGet(k, store) { try { return (store || localStorage).getItem(k); } catch (e) { return null; } }
  function safeSet(k, v, store) { try { (store || localStorage).setItem(k, v); } catch (e) {} }

  /* ---------------- período ---------------- */
  function range() {
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var ini, fim = new Date(today);
    if (S.period === "mes") ini = new Date(today.getFullYear(), today.getMonth(), 1);
    else if (S.period === "ano") ini = new Date(today.getFullYear(), 0, 1);
    else if (S.period === "total") {
      var pv = S.data && S.data.periodo && S.data.periodo.all && S.data.periodo.all.primeira_venda;
      ini = parseIso(pv ? iso(new Date(pv)) : PRIMEIRA_VENDA);
    }
    else if (S.period === "mes_ant") { ini = new Date(today.getFullYear(), today.getMonth() - 1, 1); fim = new Date(today.getFullYear(), today.getMonth(), 0); }
    else if (S.period === "custom") {
      ini = S.from ? parseIso(S.from) : new Date(today.getFullYear(), today.getMonth() - 2, 1);
      fim = S.to ? parseIso(S.to) : today;
      if (fim > today) fim = today;
      if (ini > fim) { var t = ini; ini = fim; fim = t; }
    } else { ini = new Date(today); ini.setDate(ini.getDate() - (Number(S.period) - 1)); }
    return { ini: iso(ini), fim: iso(fim) };
  }
  function cacheKey() { var r = range(); return CACHE + r.ini + ":" + r.fim + ":" + S.plano; }

  /* ---------------- dados ---------------- */
  async function load() {
    var seq = ++S.seq, r = range(), key = cacheKey();
    var cached = null;
    try { cached = JSON.parse(safeGet(key, sessionStorage) || "null"); } catch (e) {}
    if (cached) { S.data = cached; render(); }
    S.loading = true; renderStatus();
    var res = await A.sb.rpc("rm_dashboard", { p_ini: r.ini, p_fim: r.fim, p_plano: S.plano });
    if (res.error) { await new Promise(function (ok) { setTimeout(ok, 900); }); res = await A.sb.rpc("rm_dashboard", { p_ini: r.ini, p_fim: r.fim, p_plano: S.plano }); }
    if (seq !== S.seq) return;
    S.loading = false;
    if (res.error) { renderStatus(res.error.message); if (!cached) A.toast("Erro ao carregar Retenção e Monetização: " + res.error.message, true); return; }
    S.data = res.data;
    safeSet(key, JSON.stringify(res.data), sessionStorage);
    render();
  }
  function per(scope) { return (S.data && S.data.periodo && S.data.periodo[scope || S.scope]) || null; }
  function hist(scope) { var h = S.data && S.data.historico && S.data.historico.escopos; return (h && h[scope || S.scope]) || null; }
  function churnRow(list, plano) { return (list || []).filter(function (c) { return c.plano === plano; })[0] || null; }
  function lastSerie(scope) {
    var h = hist(scope), f = S.data && S.data.filtro;
    if (!h || !f) return null;
    // Mês do último dia do período (fim_efetivo é exclusivo: meia-noite seguinte ou agora).
    var d = new Date(new Date(f.fim_efetivo).getTime() - 1000), key = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-01";
    return (h.serie || []).filter(function (x) { return x.mes === key; })[0] || null;
  }

  // Churn mensal médio nos meses do período: Σ clientes que saíram ÷ Σ base que podia sair no início de cada mês.
  // (Dividir o churn de um período longo pela base do 1º dia passa de 100%, porque a base cresce no caminho.)
  // Mês só em parte dentro do período (o 1º, o último ou o mês corrente) entra na proporção dos dias cobertos:
  // wb = fração do mês exposta (base × meses); wc = fração dos dias já observados no mês (no mês corrente o churn
  // do histórico só cobre os dias que passaram).
  var MOTIVOS = ["voluntario", "chargeback", "involuntario", "nao_identificado"];
  function monthlyChurn(h, planoKey) {
    var r = range(), mIni = r.ini.slice(0, 7) + "-01", mFim = r.fim.slice(0, 7) + "-01", dIni = parseIso(r.ini), dFim = parseIso(r.fim);
    var hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    var cm = { total: 0, base: 0, meses: 0, voluntario: 0, chargeback: 0, involuntario: 0, nao_identificado: 0 };
    ((h && h.churn_mes) || []).forEach(function (x) {
      if (x.plano !== planoKey || x.mes < mIni || x.mes > mFim) return;
      var m0 = parseIso(x.mes), m1 = new Date(m0.getFullYear(), m0.getMonth() + 1, 0), dias = m1.getDate();
      var a = dIni > m0 ? dIni : m0, z = dFim < m1 ? dFim : m1, cob = Math.max(0, Math.round((z - a) / 864e5) + 1);
      var obs = Math.round(((hoje < m1 ? hoje : m1) - m0) / 864e5) + 1, wb = cob / dias, wc = obs > 0 ? Math.min(1, cob / obs) : 0;
      cm.total += num(x.total) * wc; cm.base += num(x.base_ini) * wb; cm.meses += wb;
      MOTIVOS.forEach(function (k) { cm[k] += num(x[k]) * wc; });
    });
    return cm;
  }

  // Indicadores derivados de um escopo (usado nos cards e na comparação entre ferramentas).
  function metrics(scope) {
    var p = per(scope), h = hist(scope);
    if (!p) return null;
    var b = p.base || {}, plano = S.plano;
    var ren = (p.renovacao || []).filter(function (r) { return r.plano === "anual"; })[0] || { devidas: 0, renovadas: 0 };
    var ch = churnRow(p.churn, plano === "todos" ? "todos" : plano) || { base_ini: 0, total: 0, voluntario: 0, chargeback: 0, involuntario: 0, nao_identificado: 0 };
    var sr = lastSerie(scope) || {};
    var arpu = b.pagantes > 0 ? num(b.mrr) / b.pagantes : null;
    var margem = sr.margem != null ? Number(sr.margem) : null;
    var perm = sr.permanencia != null ? Number(sr.permanencia) : null;
    var ltv = arpu != null && margem != null && perm != null ? arpu * margem * perm : null;
    var custos = num(p.comissao) + num(p.marketing);
    var temCusto = p.marketing != null || num(p.comissao) > 0;
    var cac = temCusto && p.novos_todos > 0 ? custos / p.novos_todos : null;
    var ret = {};
    MARCOS.forEach(function (m) {
      var tot = 0, ok = 0, n = 0;
      ((h && h.coortes) || []).forEach(function (c) { if (c.marcos && c.marcos[m[0]] != null) { tot += c.clientes; ok += c.marcos[m[0]]; n++; } });
      ret[m[0]] = { taxa: ratio(ok, tot), clientes: tot, coortes: n };
    });
    var mix = p.mix || { clientes: 0, por_qtd: {}, combos: {} };
    var cm = monthlyChurn(h, plano === "todos" ? "todos" : plano);
    return {
      p: p, b: b, ren: ren, renTaxa: ratio(ren.renovadas, ren.devidas), ch: ch, cm: cm, churnTaxa: ratio(cm.total, cm.base),
      arpu: arpu, margem: margem, perm: perm, churnMedio: sr.churn_medio != null ? Number(sr.churn_medio) : null, ltv: ltv,
      cac: cac, custos: custos, temCusto: temCusto, ltvCac: ltv != null && cac ? ltv / cac : null, ret: ret, mix: mix, serieMes: sr.mes
    };
  }

  /* ---------------- estrutura ---------------- */
  function build(root) {
    root.innerHTML =
      '<section class="rm-hero">' +
        '<div class="rm-hero-main"><div class="rm-kicker">Análises</div><h3 class="rm-title">Retenção e Monetização</h3>' +
          '<p class="rm-sub">Acompanhe a retenção, renovação e monetização da base de clientes das ferramentas Flow.</p>' +
          '<div class="rm-sources" id="rm-sources"></div></div>' +
      "</section>" +
      '<div class="rm-filters panel">' +
        '<div class="rm-frow"><span class="rm-flabel">Período</span><div class="rm-pills" id="rm-periods" role="group" aria-label="Período"></div>' +
          '<div class="rm-custom" id="rm-custom" hidden><label>De <input type="date" id="rm-from"></label><label>Até <input type="date" id="rm-to"></label></div></div>' +
        '<div class="rm-frow"><span class="rm-flabel">Plano</span><div class="rm-pills" id="rm-plans" role="group" aria-label="Plano"></div></div>' +
        '<div class="rm-frow"><span class="rm-flabel">Ferramenta</span><div class="rm-pills" id="rm-scopes" role="group" aria-label="Ferramenta"></div></div>' +
        '<p class="rm-fnote" id="rm-fnote"></p>' +
      "</div>" +
      '<div id="rm-body"></div>';
    root.addEventListener("click", onClick);
    root.addEventListener("change", function (e) {
      if (e.target.id === "rm-from" || e.target.id === "rm-to") {
        S.from = $("rm-from").value; S.to = $("rm-to").value; savePrefs(); renderFilters(); load();
      }
    });
    window.addEventListener("resize", function () { if (S.visible && S.data) { clearTimeout(S.rz); S.rz = setTimeout(renderBody, 150); } });
  }
  function onClick(e) {
    var b = e.target.closest("[data-rm]");
    if (!b) return;
    var kv = b.getAttribute("data-rm").split(":");
    if (kv[0] === "period") { S.period = kv[1]; savePrefs(); renderFilters(); if (S.period !== "custom" || (S.from && S.to)) load(); }
    else if (kv[0] === "plan") { S.plano = kv[1]; savePrefs(); renderFilters(); load(); }
    else if (kv[0] === "scope") { S.scope = kv[1]; savePrefs(); renderFilters(); renderBody(); }
  }
  function savePrefs() { safeSet(PREF, JSON.stringify({ period: S.period, from: S.from, to: S.to, plano: S.plano, scope: S.scope })); }
  function loadPrefs() {
    try {
      var p = JSON.parse(safeGet(PREF) || "null");
      if (!p) return;
      if (PERIODS.some(function (x) { return x[0] === p.period; })) S.period = p.period;
      if (PLANS.some(function (x) { return x[0] === p.plano; })) S.plano = p.plano;
      if (SCOPES.some(function (x) { return x[0] === p.scope; })) S.scope = p.scope;
      S.from = p.from || ""; S.to = p.to || "";
    } catch (e) {}
  }
  function pills(list, kind, cur) {
    return list.map(function (x) { return '<button type="button" class="btn' + (x[0] === cur ? " on" : "") + '" data-rm="' + kind + ":" + x[0] + '" aria-pressed="' + (x[0] === cur) + '">' + esc(x[1]) + "</button>"; }).join("");
  }
  function renderFilters() {
    $("rm-periods").innerHTML = pills(PERIODS, "period", S.period);
    $("rm-plans").innerHTML = pills(PLANS, "plan", S.plano);
    $("rm-scopes").innerHTML = pills(SCOPES, "scope", S.scope);
    $("rm-custom").hidden = S.period !== "custom";
    if (S.period === "custom") { $("rm-from").value = S.from || ""; $("rm-to").value = S.to || ""; }
    var r = range();
    $("rm-fnote").innerHTML = "Período: <b>" + fmtDay(r.ini) + " a " + fmtDay(r.fim) + "</b> · " + esc(PLAN_LABEL[S.plano]) + " · " + esc(TOOL_NAME[S.scope]) +
      '. Cards do período usam a situação de cada cliente na data (início e fim do período), não a de hoje. Gráficos mostram o histórico mês a mês desde jun/2025.' +
      (S.period === "total" ? " <b>Período total</b>: desde a 1ª venda paga — " + TOOLS.concat([["all", "consolidado"]]).map(function (t) {
        var pv = S.data && S.data.periodo && S.data.periodo[t[0]] && S.data.periodo[t[0]].primeira_venda;
        return esc(t[1]) + " " + (pv ? new Date(pv).toLocaleDateString("pt-BR") : "—");
      }).join(" · ") + ". Cada ferramenta só tem dados a partir da própria 1ª venda." : "");
  }
  function renderStatus(err) {
    var el = $("rm-sources");
    if (!el) return;
    var d = S.data;
    el.innerHTML =
      '<span class="rm-src' + (err ? " bad" : S.loading ? " wait" : "") + '"><i></i>' +
        (err ? "Erro ao atualizar: " + esc(err) : d && d.atualizado_em ? "Dados atualizados em " + esc(fmtDateTime(d.atualizado_em)) + " · atualização automática a cada 30 min" : "Carregando…") + "</span>" +
      '<span class="rm-src"><i></i>Assinaturas: Kiwify (cobranças pagas)</span>' +
      '<span class="rm-src"><i></i>Combo vitalício: Kiwify, TMB e Hotmart</span>' +
      '<span class="rm-src"><i></i>Custos: despesas do Financeiro + comissão de afiliados</span>';
  }

  /* ---------------- pedaços visuais ---------------- */
  function card(label, value, sub, how, cls) {
    return '<div class="rm-card' + (cls ? " " + cls : "") + '"><small>' + esc(label) + "</small><b class=\"num\">" + value + "</b>" +
      (sub ? "<span>" + sub + "</span>" : "") + (how ? '<details class="rm-how"><summary>Como é calculado</summary><p>' + how + "</p></details>" : "") + "</div>";
  }
  function insuf(msg) { return '<span class="rm-insuf">' + esc(msg || INSUF) + "</span>"; }
  function section(id, n, title, sub, body) {
    return '<section class="rm-block panel" id="' + id + '"><div class="rm-bhead"><span class="rm-bn">' + n + '</span><div><h3>' + esc(title) + "</h3><p class=\"muted\">" + sub + "</p></div></div>" + body + "</section>";
  }
  function chartBox(title, note, svg, legend) {
    return '<div class="rm-chart"><div class="rm-chart-h"><h4>' + esc(title) + "</h4>" + (note ? '<span class="muted">' + note + "</span>" : "") + "</div>" +
      (svg || '<div class="rm-empty">' + INSUF + "</div>") + (legend ? '<div class="rm-legend">' + legend + "</div>" : "") + "</div>";
  }
  function legend(items) { return items.map(function (i) { return '<span><i style="background:' + i[1] + '"></i>' + esc(i[0]) + "</span>"; }).join(""); }

  // Gráfico de barras empilhadas (com linha opcional em eixo próprio, à direita).
  function bars(labels, stacks, opts) {
    opts = opts || {};
    if (!labels.length) return null;
    var W = 720, H = opts.h || 220, mg = { l: 44, r: opts.line ? 44 : 12, t: 12, b: 26 };
    var iw = W - mg.l - mg.r, ih = H - mg.t - mg.b, n = labels.length, bw = iw / n;
    var tot = labels.map(function (_, i) { return stacks.reduce(function (s, st) { return s + num(st.values[i]); }, 0); });
    var max = opts.max || Math.max.apply(null, tot.concat([1]));
    var y = function (v) { return mg.t + ih - (v / max) * ih; };
    var out = '<svg viewBox="0 0 ' + W + " " + H + '" class="rm-svg" role="img" aria-label="' + esc(opts.label || "") + '">';
    for (var g = 0; g <= 4; g++) {
      var gv = max * g / 4, gy = y(gv);
      out += '<line x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + gy + '" y2="' + gy + '" class="rm-grid"/>' +
        '<text x="' + (mg.l - 6) + '" y="' + (gy + 4) + '" class="rm-ax" text-anchor="end">' + esc((opts.fmt || fmtInt)(gv)) + "</text>";
    }
    labels.forEach(function (lb, i) {
      var x = mg.l + i * bw + bw * 0.18, w = bw * 0.64, acc = 0;
      var tip = [lb].concat(stacks.map(function (st) { return st.name + ": " + (opts.fmt || fmtInt)(num(st.values[i])); }));
      stacks.forEach(function (st) {
        var v = num(st.values[i]);
        if (v <= 0) return;
        var y1 = y(acc + v), y0 = y(acc);
        out += '<rect x="' + x.toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(0.5, y0 - y1).toFixed(1) + '" rx="2" fill="' + st.color + '"><title>' + esc(tip.join("\n")) + "</title></rect>";
        acc += v;
      });
      if (n <= 24 && (n <= 12 || i % 2 === 0)) out += '<text x="' + (mg.l + i * bw + bw / 2) + '" y="' + (H - 8) + '" class="rm-ax" text-anchor="middle">' + esc(lb) + "</text>";
    });
    if (opts.line) {
      var L = opts.line, vals = L.values, lmax = L.max || Math.max.apply(null, vals.filter(function (v) { return v != null; }).concat([0.0001]));
      var ly = function (v) { return mg.t + ih - (v / lmax) * ih; }, pts = [];
      vals.forEach(function (v, i) { if (v != null) pts.push([mg.l + i * bw + bw / 2, ly(v), v, i]); });
      if (pts.length) out += '<polyline fill="none" stroke="' + L.color + '" stroke-width="2" points="' + pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ") + '"/>';
      pts.forEach(function (p) { out += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3" fill="' + L.color + '"><title>' + esc(labels[p[3]] + " · " + L.name + ": " + L.fmt(p[2])) + "</title></circle>"; });
      for (var k = 0; k <= 4; k++) out += '<text x="' + (W - mg.r + 6) + '" y="' + (ly(lmax * k / 4) + 4) + '" class="rm-ax">' + esc(L.fmt(lmax * k / 4)) + "</text>";
    }
    return out + "</svg>";
  }
  // Linhas (cada série no mesmo eixo; null = sem ponto).
  function lines(labels, series, opts) {
    opts = opts || {};
    var all = []; series.forEach(function (s) { s.values.forEach(function (v) { if (v != null && isFinite(v)) all.push(v); }); });
    if (!labels.length || !all.length) return null;
    var W = 720, H = opts.h || 220, mg = { l: 56, r: 12, t: 12, b: 26 }, iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    var max = Math.max.apply(null, all.concat([0])), min = Math.min.apply(null, all.concat([0]));
    if (max === min) max = min + 1;
    var n = labels.length, x = function (i) { return mg.l + (n === 1 ? iw / 2 : i * iw / (n - 1)); }, y = function (v) { return mg.t + ih - (v - min) / (max - min) * ih; };
    var out = '<svg viewBox="0 0 ' + W + " " + H + '" class="rm-svg" role="img" aria-label="' + esc(opts.label || "") + '">';
    for (var g = 0; g <= 4; g++) {
      var gv = min + (max - min) * g / 4;
      out += '<line x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + y(gv) + '" y2="' + y(gv) + '" class="rm-grid"/><text x="' + (mg.l - 6) + '" y="' + (y(gv) + 4) + '" class="rm-ax" text-anchor="end">' + esc((opts.fmt || fmtInt)(gv)) + "</text>";
    }
    labels.forEach(function (lb, i) { if (n <= 12 || i % 2 === 0) out += '<text x="' + x(i) + '" y="' + (H - 8) + '" class="rm-ax" text-anchor="middle">' + esc(lb) + "</text>"; });
    series.forEach(function (s) {
      var seg = [], segs = [];
      s.values.forEach(function (v, i) { if (v == null || !isFinite(v)) { if (seg.length) segs.push(seg); seg = []; } else seg.push([x(i), y(v), v, i]); });
      if (seg.length) segs.push(seg);
      segs.forEach(function (sg) { out += '<polyline fill="none" stroke="' + s.color + '" stroke-width="2.2"' + (s.dash ? ' stroke-dasharray="5 4"' : "") + ' points="' + sg.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ") + '"/>'; });
      segs.forEach(function (sg) { sg.forEach(function (p) { out += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3" fill="' + s.color + '"><title>' + esc(labels[p[3]] + " · " + s.name + ": " + (s.fmt || opts.fmt || fmtInt)(p[2])) + "</title></circle>"; }); });
    });
    return out + "</svg>";
  }
  function colors() {
    return { a: tok("--accent"), b: tok("--accent-3"), c: tok("--warning"), d: tok("--accent-2"), crit: tok("--critical"), mut: tok("--text-muted"), hi: tok("--chart-hi") };
  }
  function toolColor(t) { var c = colors(); return { flowtracking: c.b, flowpages: c.a, flowspy: c.c, all: c.hi }[t]; }

  /* ---------------- render ---------------- */
  function render() { renderStatus(); renderFilters(); renderBody(); }
  function renderBody() {
    var body = $("rm-body");
    if (!body) return;
    if (!S.data) { body.innerHTML = '<div class="rm-empty panel">Carregando…</div>'; return; }
    if (!S.data.historico) { body.innerHTML = '<div class="rm-empty panel">O cache ainda não foi gerado. Ele é atualizado automaticamente a cada 30 minutos.</div>'; return; }
    var m = metrics(S.scope);
    body.innerHTML = blockChurn(m) + blockBase(m) + blockMix(m) + blockValue(m) + blockCompare();
  }

  // ---------- 1. Renovação e churn ----------
  function blockChurn(m) {
    var c = colors(), h = hist(), ch = m.ch, isVit = S.plano === "vitalicio";
    var ren = m.ren, renHow = "Só planos anuais. Conta cada assinatura anual que venceu no período e verifica se houve nova cobrança <b>paga</b> da mesma ferramenta entre 45 dias antes e 3 dias depois do vencimento (carência). Compra depois disso é nova assinatura, não renovação. Ficam fora: compras repetidas/upgrade antes da janela e quem entrou no combo vitalício antes de vencer. " +
      "Enquanto alguma assinatura vencida ainda está na carência, a taxa é <b>parcial</b>: as que ainda podem renovar contam no total como não renovadas até pagarem. A taxa fica final quando a última carência termina.";
    var renCard = !ren.devidas
      ? card("Taxa de renovação anual", insuf("Ainda sem histórico de renovação anual"), "Nenhuma assinatura anual venceu neste período.",
          "Só planos anuais e só renovações confirmadas (nova cobrança paga). Sem assinaturas elegíveis o indicador não é calculado — nunca aparece como 0%.")
      : ren.pendentes > 0
        ? card("Taxa de renovação anual", fmtPct(m.renTaxa) + ' <em class="rm-parcial">parcial</em>',
            fmtInt(ren.renovadas) + " de " + fmtInt(ren.devidas) + " já renovaram até agora · <b>" + fmtInt(ren.pendentes) + " ainda em carência</b>" +
            (ren.fecha_em ? " · taxa final por volta de " + esc(new Date(ren.fecha_em).toLocaleDateString("pt-BR")) : "") +
            (ren.fechadas > 0 ? " · com a carência já encerrada: " + fmtPct(ren.renovadas_fechadas / ren.fechadas) + " (" + fmtInt(ren.renovadas_fechadas) + " de " + fmtInt(ren.fechadas) + ")" : ""),
            renHow, "hl")
        : card("Taxa de renovação anual", fmtPct(m.renTaxa), fmtInt(ren.renovadas) + " de " + fmtInt(ren.devidas) + " assinaturas anuais que venceram no período (carência encerrada)", renHow);
    var total = ch.total, cm = m.cm, base = cm.base;
    var how = "Cliente que tinha acesso pago e perdeu no período. A perda conta na data do <b>fim da vigência</b> (cancelamento agendado só vira churn quando o plano acaba) e só depois dos 3 dias de tolerância sem renovar. " +
      (S.scope === "all" ? "No consolidado o cliente só conta quando perde <b>todas</b> as ferramentas. " : "") +
      "Taxa = <b>churn mensal médio</b> nos meses do período: Σ clientes que saíram em cada mês ÷ Σ clientes ativos sem vitalício no início de cada mês" + (S.plano !== "todos" ? " (plano " + PLAN_LABEL[S.plano] + ")" : "") +
      ". Meses que caem só em parte no período (o primeiro, o último e o mês corrente) entram na proporção dos dias cobertos. O número de clientes que saíram é o do período exato (datas do filtro).";
    var churnCards = isVit
      ? card("Churn", insuf("Não se aplica"), "O combo vitalício não vence, então não tem churn.", "")
      : card("Churn total (média mensal)", base > 0 ? fmtPct(m.churnTaxa, 2) : insuf(), fmtInt(total) + " clientes saíram no período · média de " + fmtDec(cm.meses, 1) + " mês(es)", how, "hl") +
        card("Voluntário (reembolso)", fmtInt(ch.voluntario), base > 0 ? fmtPct(ratio(cm.voluntario, base), 2) + " ao mês · " + fmtPct(ratio(ch.voluntario, total)) + " do churn" : "",
          "O cliente pediu reembolso da ferramenta entre 45 dias antes e 3 dias depois do fim da vigência.") +
        card("Chargeback", fmtInt(ch.chargeback || 0), base > 0 ? fmtPct(ratio(cm.chargeback, base), 2) + " ao mês · " + fmtPct(ratio(ch.chargeback || 0, total)) + " do churn" : "",
          "O cliente contestou a cobrança no cartão (chargeback) entre 45 dias antes e 3 dias depois do fim da vigência. Se também pediu reembolso, conta como voluntário.") +
        card("Involuntário (falha de pagamento)", fmtInt(ch.involuntario), base > 0 ? fmtPct(ratio(cm.involuntario, base), 2) + " ao mês · " + fmtPct(ratio(ch.involuntario, total)) + " do churn" : "",
          "Houve tentativa de cobrança da renovação que foi recusada ou ficou sem pagamento (cartão recusado, boleto/Pix não pago) entre 10 dias antes e 3 dias depois do vencimento.") +
        card("Motivo não identificado", fmtInt(ch.nao_identificado), base > 0 ? fmtPct(ratio(cm.nao_identificado, base), 2) + " ao mês · " + fmtPct(ratio(ch.nao_identificado, total)) + " do churn" : "",
          "Nenhuma tentativa de cobrança nem reembolso perto do vencimento: o cliente desligou a renovação ou o plano não era recorrente. A Kiwify não informa o pedido de cancelamento, então o motivo não é inventado.") +
        card("Em carência agora", fmtInt(m.b.em_carencia), "venceram há até 3 dias e ainda podem renovar", "Ainda não contam como ativos nem como churn. Se renovarem em até 3 dias depois do vencimento, continuam no mesmo período; depois disso viram churn na data do vencimento.");
    var soma = ch.voluntario + (ch.chargeback || 0) + ch.involuntario + ch.nao_identificado;
    var check = isVit ? "" : '<p class="rm-check' + (soma === total ? " ok" : " bad") + '">Conferência: voluntário ' + fmtInt(ch.voluntario) + " + chargeback " + fmtInt(ch.chargeback || 0) + " + involuntário " + fmtInt(ch.involuntario) +
      " + não identificado " + fmtInt(ch.nao_identificado) + " = " + fmtInt(soma) + " · churn total " + fmtInt(total) + "</p>";
    // Gráfico: churn por motivo, mês a mês (plano do filtro).
    var cmRows = (h.churn_mes || []).filter(function (r) { return r.plano === (S.plano === "todos" ? "todos" : S.plano); });
    var meses = (h.serie || []).map(function (s) { return s.mes; });
    var byMes = {}; cmRows.forEach(function (r) { byMes[r.mes] = r; });
    var lbl = meses.map(fmtMes);
    var g1 = isVit ? null : bars(lbl, [
      { name: "Voluntário (reembolso)", color: c.d, values: meses.map(function (k) { return (byMes[k] || {}).voluntario || 0; }) },
      { name: "Chargeback", color: c.b, values: meses.map(function (k) { return (byMes[k] || {}).chargeback || 0; }) },
      { name: "Involuntário", color: c.c, values: meses.map(function (k) { return (byMes[k] || {}).involuntario || 0; }) },
      { name: "Não identificado", color: c.mut, values: meses.map(function (k) { return (byMes[k] || {}).nao_identificado || 0; }) }
    ], { label: "Churn por mês", line: { name: "Taxa de churn", color: c.crit, fmt: function (v) { return fmtPct(v); }, values: meses.map(function (k) { var r = byMes[k]; return r && r.base_ini > 0 ? r.total / r.base_ini : null; }) } });
    // Tabela mensal × planos.
    var planCols = [["mensal", "Mensal"], ["anual", "Anual"], ["semestral", "Semestral/trim."], ["todos", "Total"]];
    var rows = meses.slice().reverse().slice(0, 12).map(function (k) {
      return "<tr><td>" + esc(fmtMes(k)) + "</td>" + planCols.map(function (pc) {
        var r = (h.churn_mes || []).filter(function (x) { return x.mes === k && x.plano === pc[0]; })[0];
        if (!r || (!r.base_ini && !r.total)) return '<td class="num muted">—</td>';
        return '<td class="num" title="' + esc("Saíram " + r.total + " de " + r.base_ini + " · reembolso " + r.voluntario + " · chargeback " + (r.chargeback || 0) + " · falha " + r.involuntario + " · não ident. " + r.nao_identificado) + '">' +
          (r.base_ini > 0 ? fmtPct(r.total / r.base_ini) : "—") + ' <small class="muted">' + fmtInt(r.total) + "/" + fmtInt(r.base_ini) + "</small></td>";
      }).join("") + "</tr>";
    }).join("");
    var tab = '<div class="rm-chart"><div class="rm-chart-h"><h4>Churn mensal por tipo de plano</h4><span class="muted">saíram ÷ base no início do mês · ' + (S.plano === "todos" ? "" : "filtro de plano não se aplica a esta tabela · ") + "últimos 12 meses</span></div>" +
      '<div class="table-scroll"><table class="rm-table"><thead><tr><th>Mês</th>' + planCols.map(function (pc) { return "<th>" + pc[1] + "</th>"; }).join("") + "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
    // Renovação anual mês a mês.
    var rv = (h.renov_mes || []).filter(function (r) { return r.plano === "anual"; }), rvM = {}; rv.forEach(function (r) { rvM[r.mes] = r; });
    var g2 = rv.length ? bars(lbl, [
      { name: "Renovaram", color: c.a, values: meses.map(function (k) { return (rvM[k] || {}).renovadas || 0; }) },
      { name: "Não renovaram", color: c.mut, values: meses.map(function (k) { var r = rvM[k]; return r ? r.devidas - r.renovadas - num(r.pendentes) : 0; }) },
      { name: "Em carência", color: c.c, values: meses.map(function (k) { return num((rvM[k] || {}).pendentes); }) }
    ], { label: "Renovação anual", line: { name: "Taxa de renovação", color: c.b, max: 1, fmt: function (v) { return fmtPct(v, 0); }, values: meses.map(function (k) { var r = rvM[k]; return r && r.devidas ? r.renovadas / r.devidas : null; }) } }) : null;
    return section("rm-b1", "1", "Renovação e churn", "Quem renovou o plano anual e quem saiu, mês a mês, separado por motivo e por plano.",
      '<div class="rm-cards">' + renCard + churnCards + "</div>" + check +
      '<div class="rm-grid2">' +
        chartBox("Churn por motivo, mês a mês", "barras: clientes que saíram · linha: taxa de churn", g1, g1 ? legend([["Voluntário (reembolso)", c.d], ["Chargeback", c.b], ["Involuntário", c.c], ["Não identificado", c.mut], ["Taxa de churn", c.crit]]) : "") +
        chartBox("Renovação anual, mês do vencimento", "barras: assinaturas anuais vencidas · linha: % renovadas", g2 || '<div class="rm-empty">Ainda sem histórico de renovação anual</div>', g2 ? legend([["Renovaram", c.a], ["Não renovaram", c.mut], ["Em carência (ainda podem renovar)", c.c], ["Taxa de renovação (parcial nos meses com carência)", c.b]]) : "") +
      "</div>" + periodicityTable() + tab);
  }

  // Renovação e churn lado a lado por periodicidade (mensal, semestral, anual), em cada ferramenta e no consolidado.
  // Não depende do filtro de plano: mostra os três de uma vez, no período escolhido.
  function periodicityTable() {
    var PER = [["mensal", "Mensal"], ["semestral", "Semestral/trim."], ["anual", "Anual"], ["todos", "Total"]];
    var body = SCOPES.map(function (sc) {
      var p = per(sc[0]), h = hist(sc[0]);
      if (!p) return "";
      var rows = PER.map(function (pp) {
        var rv = pp[0] === "todos"
          ? (p.renovacao || []).reduce(function (a, r) { a.fechadas += num(r.fechadas); a.renovadas_fechadas += num(r.renovadas_fechadas); a.pendentes += num(r.pendentes); return a; }, { fechadas: 0, renovadas_fechadas: 0, pendentes: 0 })
          : (p.renovacao || []).filter(function (r) { return r.plano === pp[0]; })[0] || { fechadas: 0, renovadas_fechadas: 0, pendentes: 0 };
        var ch = churnRow(p.churn, pp[0]) || { total: 0, voluntario: 0, chargeback: 0, involuntario: 0, nao_identificado: 0 };
        var cm = monthlyChurn(h, pp[0]);
        if (!num(rv.fechadas) && !num(rv.pendentes) && !ch.total && !cm.base) return "";
        var cnt = function (k) { return '<td class="num">' + fmtInt(ch[k] || 0) + (ch.total ? ' <small class="muted">' + fmtPct((ch[k] || 0) / ch.total, 0) + "</small>" : "") + "</td>"; };
        return "<tr" + (pp[0] === "todos" ? ' class="rm-tot"' : "") + "><td>" + pp[1] + "</td>" +
          '<td class="num">' + (num(rv.fechadas) ? fmtPct(rv.renovadas_fechadas / rv.fechadas) + ' <small class="muted">' + fmtInt(rv.renovadas_fechadas) + "/" + fmtInt(rv.fechadas) + "</small>" : '<span class="muted">—</span>') +
            (num(rv.pendentes) ? ' <small class="rm-warn">+' + fmtInt(rv.pendentes) + " em carência</small>" : "") + "</td>" +
          '<td class="num">' + (cm.base > 0 ? fmtPct(cm.total / cm.base, 2) : "—") + "</td>" +
          '<td class="num">' + fmtInt(ch.total) + "</td>" + cnt("voluntario") + cnt("chargeback") + cnt("involuntario") + cnt("nao_identificado") + "</tr>";
      }).join("");
      var head = '<tr class="rm-grp"><td colspan="8"><span class="rm-dot" style="background:' + toolColor(sc[0]) + '"></span>' + esc(sc[1]) + "</td></tr>";
      return rows ? head + rows : head + '<tr><td colspan="8" class="muted">' + INSUF + " no período</td></tr>";
    }).join("");
    return '<div class="rm-chart"><div class="rm-chart-h"><h4>Renovação e churn por periodicidade</h4><span class="muted">no período escolhido · os planos lado a lado (o filtro de plano não se aplica)</span></div>' +
      '<div class="table-scroll"><table class="rm-table rm-per"><thead><tr><th>Plano</th>' +
      '<th title="Renovadas ÷ oportunidades com os 3 dias de tolerância já encerrados (vencimentos do período)">Renovação</th>' +
      '<th title="Σ clientes que saíram ÷ Σ base no início de cada mês do período">Churn mensal médio</th><th>Saíram</th>' +
      '<th title="Reembolso pedido pelo cliente">Voluntário</th><th title="Contestação no cartão">Chargeback</th><th title="Cobrança recusada ou não paga">Involuntário</th><th>Não identificado</th></tr></thead><tbody>' +
      body + "</tbody></table></div>" +
      '<p class="rm-fnote">Renovação = renovadas ÷ oportunidades encerradas: assinaturas que venceram no período e já passaram dos 3 dias de tolerância. As que ainda estão na carência aparecem à parte. ' +
      "Churn por plano = plano da última cobrança antes de sair; no consolidado, o cliente só conta quando perde todas as ferramentas. Percentuais pequenos = parte do churn daquela linha.</p></div>";
  }

  // ---------- 2. Base ativa e retenção ----------
  function blockBase(m) {
    var c = colors(), h = hist(), b = m.b, all = per("all").base || {};
    var growth = b.clientes_ini > 0 ? (b.clientes - b.clientes_ini) / b.clientes_ini : null;
    var pf = all.por_ferramenta || {};
    var cards =
      card("Clientes únicos ativos", fmtInt(b.clientes), (growth != null ? (growth >= 0 ? "+" : "") + fmtPct(growth) + " desde o início do período (" + fmtInt(b.clientes_ini) + ")" : "") ,
        "E-mails com pelo menos uma assinatura vigente e paga (ou o combo vitalício) no último dia do período. Cada cliente conta uma vez, mesmo com várias ferramentas. Não usa login nem uso das ferramentas e não conta testes/cortesias (plano Teste ou menos de R$ 5).", "hl") +
      card("Assinaturas ativas", fmtInt(b.assinaturas), "cliente × ferramenta · " + fmtDec(ratio(b.assinaturas, b.clientes), 2) + " por cliente",
        "Soma das ferramentas ativas de cada cliente. No consolidado é igual à soma dos ativos de cada ferramenta.") +
      card("Pagantes recorrentes", fmtInt(b.pagantes), "com assinatura (fora quem só tem o vitalício)", "Clientes com assinatura vigente. Base do ARPU e do churn.") +
      card("Combo vitalício", fmtInt((b.por_plano || {}).vitalicio || 0), "clientes com acesso sem vencimento", "Combo Vitalício 2026 pago (Kiwify, TMB ou Hotmart). Libera as três ferramentas e não entra no churn.") +
      (S.scope === "all" ? TOOLS.map(function (t) { return card(t[1], fmtInt(pf[t[0]] || 0), "clientes ativos", ""); }).join("") : "");
    var meses = (h.serie || []).map(function (s) { return s.mes; }), lbl = meses.map(fmtMes);
    var g1 = lines(lbl, [
      { name: "Clientes únicos", color: c.a, values: (h.serie || []).map(function (s) { return s.clientes; }) },
      { name: "Assinaturas", color: c.b, values: (h.serie || []).map(function (s) { return s.assinaturas; }), dash: true },
      { name: "Pagantes", color: c.c, values: (h.serie || []).map(function (s) { return s.pagantes; }) }
    ], { label: "Evolução da base" });
    // Por ferramenta (consolidado): ativos de cada ferramenta mês a mês.
    var g2 = null;
    if (S.scope === "all") {
      g2 = lines(lbl, TOOLS.map(function (t) { var hh = hist(t[0]) || { serie: [] }; return { name: t[1], color: toolColor(t[0]), values: hh.serie.map(function (s) { return s.clientes; }) }; }), { label: "Ativos por ferramenta" });
    }
    // Retenção por coorte.
    var isVit = S.plano === "vitalicio";
    var retCards = MARCOS.map(function (mk) {
      var r = m.ret[mk[0]];
      return card("Retenção " + mk[1], !isVit && r.clientes > 0 ? fmtPct(r.taxa) : insuf(), !isVit && r.clientes > 0 ? fmtInt(r.clientes) + " clientes em " + fmtInt(r.coortes) + " coorte(s) completa(s)" : "nenhuma coorte completou o marco",
        "Clientes que ainda tinham acesso " + { "1": "1 mês", "3": "3 meses", "6": "6 meses", "12": "12 meses" }[mk[0]] + " depois da 1ª compra paga (mesmo dia do mês), ÷ clientes da coorte. Só entram coortes (mês da 1ª compra) que já completaram o marco + 3 dias de carência." +
        (S.plano !== "todos" ? " Plano da 1ª compra: " + PLAN_LABEL[S.plano] + "." : ""));
    }).join("");
    var coortes = (h.coortes || []).slice().reverse();
    var heat = coortes.length && !isVit ? '<div class="table-scroll"><table class="rm-table rm-heat"><thead><tr><th>Coorte (1ª compra)</th><th>Clientes</th>' + MARCOS.map(function (mk) { return "<th>" + mk[1] + "</th>"; }).join("") + "</tr></thead><tbody>" +
      coortes.map(function (co) {
        return "<tr><td>" + esc(fmtMes(co.coorte)) + '</td><td class="num">' + fmtInt(co.clientes) + "</td>" + MARCOS.map(function (mk) {
          var v = co.marcos && co.marcos[mk[0]];
          if (v == null) return '<td class="num muted" title="Coorte ainda não completou o marco">·</td>';
          var t = co.clientes ? v / co.clientes : 0;
          return '<td class="num" style="background:rgba(var(--accent-rgb),' + (0.08 + t * 0.55).toFixed(2) + ')" title="' + esc(fmtInt(v) + " de " + fmtInt(co.clientes)) + '">' + fmtPct(t, 0) + "</td>";
        }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>" : '<div class="rm-empty">' + (isVit ? "Retenção não se aplica ao vitalício (não vence)." : INSUF) + "</div>";
    return section("rm-b2", "2", "Base ativa e retenção", "Ativo = assinatura vigente e paga (ou combo vitalício). Sem login/uso e sem testes grátis.",
      '<div class="rm-cards">' + cards + "</div>" +
      '<div class="rm-grid2">' +
        chartBox("Evolução da base", "fim de cada mês (no mês atual, hoje)", g1, g1 ? legend([["Clientes únicos", c.a], ["Assinaturas", c.b], ["Pagantes", c.c]]) : "") +
        (g2 ? chartBox("Ativos por ferramenta", "clientes com a ferramenta ativa no fim do mês", g2, legend(TOOLS.map(function (t) { return [t[1], toolColor(t[0])]; }))) :
          chartBox("Novos clientes por mês", "1ª compra paga de assinatura", bars(lbl, [{ name: "Novos", color: c.a, values: (h.serie || []).map(function (s) { return s.novos; }) }], { label: "Novos clientes" }), "")) +
      "</div>" +
      '<h4 class="rm-sub-h">Retenção por coorte da primeira compra paga</h4>' +
      '<div class="rm-cards">' + retCards + "</div>" +
      '<div class="rm-explain"><b>Retenção de assinatura × renovação anual.</b> A retenção olha o cliente: ele ainda tem acesso N meses depois da 1ª compra? ' +
        "Num plano anual, D30, D90 e D180 ficam perto de 100% porque o plano já está pago até o fim do ano; só o D365 mostra quem renovou. " +
        "A renovação anual olha a assinatura: das anuais que venceram, quantas tiveram nova cobrança paga. Por isso compare D30/D90 com o plano mensal e use a renovação anual para o anual. " +
        "Use o filtro de plano para separar mensal e anual (plano da 1ª compra).</div>" +
      chartBox("Coortes: % de clientes com acesso em cada marco", "linhas: mês da 1ª compra · · = coorte ainda não completou o marco", heat, ""));
  }

  // ---------- 3. Monetização ----------
  function blockMix(m) {
    var c = colors(), mix = m.mix, tot = mix.clientes || 0, q = mix.por_qtd || {}, isAll = S.scope === "all";
    var den = isAll ? fmtInt(tot) + " clientes únicos ativos" : fmtInt(tot) + " clientes que têm " + TOOL_NAME[S.scope] + " ativo";
    var qcards = ["1", "2", "3"].map(function (k) {
      var v = num(q[k]);
      return card(k + (k === "1" ? " ferramenta" : " ferramentas"), tot ? fmtPct(v / tot) : insuf(), fmtInt(v) + " de " + den,
        "Clientes ativos no fim do período com " + k + " ferramenta(s) ativa(s) ÷ " + (isAll ? "todos os clientes ativos" : "clientes ativos que têm " + TOOL_NAME[S.scope]) + ". 1 + 2 + 3 = 100%.");
    }).join("");
    var sum = num(q["1"]) + num(q["2"]) + num(q["3"]);
    var combos = COMBOS.filter(function (cb) { return isAll || cb[0].split("+").indexOf(S.scope) >= 0; });
    var maxC = Math.max.apply(null, combos.map(function (cb) { return num((mix.combos || {})[cb[0]]); }).concat([1]));
    var ctab = '<table class="rm-table"><thead><tr><th>Combinação</th><th>Clientes</th><th>%</th><th></th></tr></thead><tbody>' + combos.map(function (cb) {
      var v = num((mix.combos || {})[cb[0]]);
      return "<tr><td>" + esc(cb[1]) + '</td><td class="num">' + fmtInt(v) + '</td><td class="num">' + (tot ? fmtPct(v / tot) : "—") + '</td><td class="rm-bar-td"><i style="width:' + (v / maxC * 100).toFixed(1) + '%"></i></td></tr>';
    }).join("") + '</tbody><tfoot><tr><td>Total</td><td class="num">' + fmtInt(combos.reduce(function (s, cb) { return s + num((mix.combos || {})[cb[0]]); }, 0)) + '</td><td class="num">' + (tot ? "100%" : "—") + "</td><td></td></tr></tfoot></table>";
    var dist = tot ? '<div class="rm-dist" role="img" aria-label="Distribuição por quantidade de ferramentas">' + ["1", "2", "3"].map(function (k, i) {
      var v = num(q[k]); return v ? '<i style="width:' + (v / tot * 100).toFixed(2) + "%;background:" + [c.mut, c.b, c.a][i] + '" title="' + k + " ferramenta(s): " + fmtInt(v) + " (" + fmtPct(v / tot) + ')"></i>' : "";
    }).join("") + "</div>" : "";
    var h = hist(), mm = (h.mix_mes || []), meses = (h.serie || []).map(function (s) { return s.mes; });
    var byM = {}; mm.forEach(function (r) { (byM[r.mes] = byM[r.mes] || {})[r.n] = r.clientes; });
    var share = function (k) { return meses.map(function (mes) { var r = byM[mes] || {}, t = num(r[1]) + num(r[2]) + num(r[3]); return t ? num(r[k]) / t : 0; }); };
    var g = mm.length ? bars(meses.map(fmtMes), [
      { name: "1 ferramenta", color: c.mut, values: share(1) }, { name: "2 ferramentas", color: c.b, values: share(2) }, { name: "3 ferramentas", color: c.a, values: share(3) }
    ], { max: 1, fmt: function (v) { return fmtPct(v, 0); }, label: "Distribuição por quantidade de ferramentas" }) : null;
    return section("rm-b3", "3", "Monetização da base", "Quantas e quais ferramentas cada cliente ativo tem. Denominador: <b>" + esc(den) + "</b>.",
      '<div class="rm-cards">' + qcards + "</div>" + dist +
      '<p class="rm-check' + (sum === tot ? " ok" : " bad") + '">Conferência: ' + fmtInt(q["1"] || 0) + " + " + fmtInt(q["2"] || 0) + " + " + fmtInt(q["3"] || 0) + " = " + fmtInt(sum) + " · " + den + "</p>" +
      '<div class="rm-grid2">' +
        '<div class="rm-chart"><div class="rm-chart-h"><h4>Combinações de ferramentas</h4><span class="muted">' + (isAll ? "as 7 combinações possíveis" : "combinações que incluem " + esc(TOOL_NAME[S.scope])) + "</span></div>" + (tot ? ctab : '<div class="rm-empty">' + INSUF + "</div>") + "</div>" +
        chartBox("Evolução da distribuição", "% dos clientes ativos no fim de cada mês" + (isAll ? "" : " que têm " + esc(TOOL_NAME[S.scope])), g, g ? legend([["1 ferramenta", c.mut], ["2 ferramentas", c.b], ["3 ferramentas", c.a]]) : "") +
      "</div>");
  }

  // ---------- 4. Valor do cliente ----------
  function blockValue(m) {
    var c = colors(), p = m.p, h = hist(), isVit = S.plano === "vitalicio";
    var mesRef = m.serieMes ? fmtMes(m.serieMes) : "—";
    var mktFalta = p.marketing == null ? "sem despesas de Marketing lançadas no período" : (p.marketing_meses < (S.data.filtro.meses_periodo || 1) ? "Marketing lançado em " + p.marketing_meses + " de " + S.data.filtro.meses_periodo + " mês(es) do período" : "");
    var cards =
      card("Receita média mensal (ARPU)", m.arpu != null ? fmtBRL(m.arpu) : insuf(), m.arpu != null ? "MRR " + fmtBRL(num(m.b.mrr), 0) + " ÷ " + fmtInt(m.b.pagantes) + " pagantes" : "",
        "Soma do valor mensal das assinaturas ativas no fim do período ÷ clientes pagantes. Valor mensal = líquido da cobrança (já sem cupom, taxa e comissão da Kiwify; reembolsos e chargebacks ficam fora) ÷ meses do plano: o anual vira 1/12.") +
      card("Margem bruta", m.margem != null ? fmtPct(m.margem) : insuf(), m.margem != null ? "12 meses até " + mesRef : "sem despesas de Infraestrutura/Suporte lançadas",
        "1 − (despesas de Infraestrutura + Suporte no Financeiro) ÷ receita reconhecida, nos 12 meses até o mês do fim do período (só meses com despesa lançada). Receita reconhecida = líquido de cada cobrança espalhado pelos meses que ela cobre.") +
      card("Permanência média", m.perm != null ? fmtDec(m.perm, 1) + " meses" : insuf(), m.churnMedio != null ? "churn mensal médio " + fmtPct(m.churnMedio, 2) + " (12 meses até " + mesRef + ")" : "",
        "1 ÷ churn mensal médio dos 12 meses até o mês do fim do período (Σ clientes que saíram ÷ Σ base no início de cada mês). Sem churn observado, não é estimável.") +
      card("LTV", !isVit && m.ltv != null ? fmtBRL(m.ltv, 0) : insuf("LTV ainda não estimável"), !isVit && m.ltv != null ? fmtBRL(m.arpu) + " × " + fmtPct(m.margem) + " × " + fmtDec(m.perm, 1) + " meses" : "falta ARPU, margem ou permanência",
        "LTV = receita média mensal (ARPU) × margem bruta × permanência média (meses).", "hl") +
      card("CAC", m.cac != null ? fmtBRL(m.cac, 0) : insuf("CAC não disponível"), m.cac != null ? fmtBRL(m.custos, 0) + " ÷ " + fmtInt(p.novos_todos) + " clientes novos" + (mktFalta ? ' · <span class="rm-warn">' + esc(mktFalta) + "</span>" : "") : (p.novos_todos ? "sem custos de aquisição no período" : "nenhum cliente novo no período"),
        "Custos reais de aquisição no período ÷ clientes novos (1ª compra paga de assinatura" + (S.scope === "all" ? " de qualquer ferramenta, cliente único" : "") + "). Custos = comissão paga a afiliados nas primeiras compras + despesas do grupo Marketing no Financeiro (cada mês entra na proporção dos dias que caem no período). Mesmo cálculo do Flow Health. Usa todos os planos: custos não se separam por plano.") +
      card("LTV/CAC", m.ltvCac != null && !isVit ? fmtX(m.ltvCac) : insuf(), m.ltvCac != null && !isVit ? (m.ltvCac >= 3 ? "acima de 3x: saudável" : "abaixo de 3x") : "precisa de LTV e CAC", "LTV ÷ CAC. Acima de 3x costuma ser considerado saudável.", m.ltvCac != null && !isVit ? (m.ltvCac >= 3 ? "good" : "bad") : "");
    var s = h.serie || [], lbl = s.map(function (x) { return fmtMes(x.mes); });
    var ltvS = s.map(function (x) { return x.arpu != null && x.margem != null && x.permanencia != null ? x.arpu * x.margem * x.permanencia : null; });
    var cacS = s.map(function (x) { return x.cac; });
    var g1 = lines(lbl, [{ name: "LTV", color: c.a, values: ltvS }, { name: "CAC", color: c.d, values: cacS }], { fmt: function (v) { return fmtBRL(v, 0); }, label: "LTV e CAC" });
    var g2 = lines(lbl, [{ name: "LTV/CAC", color: c.b, values: s.map(function (x, i) { return ltvS[i] != null && cacS[i] ? ltvS[i] / cacS[i] : null; }), fmt: fmtX }], { fmt: fmtX, label: "LTV/CAC" });
    return section("rm-b4", "4", "Valor do cliente", "LTV, CAC e a relação entre eles. CAC mensal só aparece nos meses com custos lançados.",
      '<div class="rm-cards">' + cards + "</div>" +
      '<div class="rm-explain"><b>Metodologia.</b> Receita líquida = valor que a Kiwify repassa (sem cupom, taxa e comissão), sem as cobranças reembolsadas ou com chargeback. Planos anuais e semestrais são normalizados para valor mensal (÷ 12, ÷ 6). ' +
        "O combo vitalício não gera receita recorrente: fica fora do ARPU, do churn e do LTV, mas conta como cliente ativo. Margem e permanência usam janela de 12 meses para não oscilar com um mês atípico.</div>" +
      '<div class="rm-grid2">' +
        chartBox("Evolução do LTV e do CAC", "por mês · CAC só nos meses com custos", g1, g1 ? legend([["LTV", c.a], ["CAC", c.d]]) : "") +
        chartBox("Evolução do LTV/CAC", "por mês", g2, "") +
      "</div>");
  }

  // ---------- Comparação entre ferramentas ----------
  function blockCompare() {
    var rows = SCOPES.map(function (sc) { return [sc, metrics(sc[0])]; });
    var sumAss = TOOLS.reduce(function (s, t) { var m = metrics(t[0]); return s + (m ? num(m.b.assinaturas) : 0); }, 0);
    var allAss = num((metrics("all") || { b: {} }).b.assinaturas);
    var td = function (v) { return '<td class="num">' + v + "</td>"; };
    return '<section class="rm-block panel"><div class="rm-bhead"><span class="rm-bn">≡</span><div><h3>Comparação entre ferramentas</h3><p class="muted">Mesmo período e plano. O consolidado conta cada cliente uma vez; assinaturas somam as ferramentas.</p></div></div>' +
      '<div class="table-scroll"><table class="rm-table rm-cmp"><thead><tr><th>Ferramenta</th><th>Clientes ativos</th><th>Assinaturas</th><th>Renovação anual</th><th>Churn mensal médio</th><th>D90</th><th>D365</th><th>ARPU</th><th>LTV</th><th>CAC</th><th>LTV/CAC</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var m = r[1];
        if (!m) return "";
        return '<tr class="' + (r[0][0] === S.scope ? "on" : "") + '"><td><span class="rm-dot" style="background:' + toolColor(r[0][0]) + '"></span>' + esc(r[0][1]) + "</td>" +
          td(fmtInt(m.b.clientes)) + td(fmtInt(m.b.assinaturas)) +
          td(m.ren.devidas ? fmtPct(m.renTaxa) + (m.ren.pendentes > 0 ? ' <em class="rm-parcial">parcial</em>' : "") + ' <small class="muted">' + fmtInt(m.ren.renovadas) + "/" + fmtInt(m.ren.devidas) +
            (m.ren.pendentes > 0 ? " · " + fmtInt(m.ren.pendentes) + " em carência" : "") + "</small>" : '<span class="muted">sem histórico</span>') +
          td(m.cm.base ? fmtPct(m.churnTaxa, 2) + ' <small class="muted">' + fmtInt(m.ch.total) + "</small>" : "—") +
          td(m.ret["3"].clientes ? fmtPct(m.ret["3"].taxa, 0) : "—") + td(m.ret["12"].clientes ? fmtPct(m.ret["12"].taxa, 0) : "—") +
          td(m.arpu != null ? fmtBRL(m.arpu, 0) : "—") + td(m.ltv != null ? fmtBRL(m.ltv, 0) : "—") + td(m.cac != null ? fmtBRL(m.cac, 0) : "—") + td(m.ltvCac != null ? fmtX(m.ltvCac) : "—") + "</tr>";
      }).join("") + "</tbody></table></div>" +
      '<p class="rm-check' + (sumAss === allAss ? " ok" : " bad") + '">Conferência: assinaturas Flow Tracking + Flow Pages + Flow Spy = ' + fmtInt(sumAss) + " · consolidado " + fmtInt(allAss) + "</p></section>";
  }

  /* ---------------- API pública ---------------- */
  window.RetentionDash = {
    init: function (opts) { A = opts; loadPrefs(); build(opts.root); renderFilters(); renderStatus(); },
    show: async function () {
      S.visible = true;
      clearInterval(S.timer);
      // Enquanto a tela está aberta, relê a cada 10 min (o cache no banco atualiza a cada 30).
      S.timer = setInterval(function () { if (S.visible && !document.hidden) load(); }, 10 * 60 * 1000);
      await load();
    },
    hide: function () { S.visible = false; clearInterval(S.timer); },
    redraw: function () { if (S.data) renderBody(); },
    _metrics: metrics, _state: S, _range: range
  };
})();
