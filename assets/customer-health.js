/* Saúde dos clientes (menu do Financeiro).
   Dados vindos do banco: situação da assinatura por software (Kiwify) e, quando a Biancode enviar, uso dos softwares
   (tabela usage_daily). Funções SQL: health_summary, health_customers, health_customer.
   Uso: CustomerHealth.init({ root, sb, url, toast, userId }); CustomerHealth.show(); */
(function () {
  "use strict";

  var SW = { flowpages: "Flow Pages", flowtracking: "Flow Tracking", flowspy: "Flow Spy" };
  var ASS = [
    ["ativo", "Assinatura em dia", "Cobertura vigente e faltam mais de 30 dias para vencer.", "--accent"],
    ["vence_30", "Vence em 30 dias", "Cobertura vigente, mas vence em até 30 dias: hora de trabalhar a renovação.", "--warning"],
    ["carencia", "Em carência", "Venceu há até 15 dias e ainda pode renovar.", "--accent-2"],
    ["cancelou", "Cancelou", "Venceu há mais de 15 dias sem nova compra.", "--critical"]
  ];
  var ASS_EXTRA = [["renovou", "Renovaram (2+ pagamentos)"], ["multi", "Usam 2+ softwares"], ["reembolso", "Reembolsaram ou chargeback"]];
  var USO = [
    ["muito_engajado", "Muito engajados", "Acessam em vários dias da semana.", "--accent"],
    ["engajado", "Engajados", "Acessaram pelo menos uma vez nos últimos 7 dias.", "--chart-hi"],
    ["moderado", "Moderadamente ativos", "Acessaram no mês, mas sem frequência semanal.", "--accent-3"],
    ["baixo", "Baixo engajamento", "Perto de completar 30 dias sem acesso.", "--warning"],
    ["inativo", "Inativos", "Mais de 30 dias sem acessar.", "--critical"],
    ["nunca", "Nunca acessaram", "Compraram, mas não têm nenhum acesso registrado.", "--text-muted"]
  ];
  var DEFAULT_CRIT = { high: 3, low: 21, inactive: 30 };
  var CRIT_KEY = "health_criteria";
  var PAGE = 50;

  var A = null;
  var S = {
    ready: false, loading: false, sum: null, crit: Object.assign({}, DEFAULT_CRIT),
    sw: "all", f: { ass: "", uso: "", ultimo: "", freq: "", plano: "", q: "" },
    page: 0, order: "ultima_compra", desc: true, list: { total: 0, rows: [] }, listSeq: 0, qTimer: null, critTimer: null
  };

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmtInt(n) { return n == null ? "—" : Number(n).toLocaleString("pt-BR"); }
  function fmtBRL(n) { return n == null ? "—" : Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  function pct(a, b, d) { return b > 0 ? (a / b * 100).toFixed(d == null ? 0 : d).replace(".", ",") + "%" : "—"; }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString("pt-BR") : "—"; }
  function fmtDateTime(iso) { return iso ? new Date(iso).toLocaleDateString("pt-BR") + " " + new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—"; }
  function rel(days) {
    if (days == null) return "—";
    if (days < 1) return "hoje";
    var d = Math.floor(days);
    return d === 1 ? "há 1 dia" : "há " + fmtInt(d) + " dias";
  }
  function tok(k) { return getComputedStyle(document.documentElement).getPropertyValue(k).trim(); }
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function assInfo(k) { return ASS.filter(function (a) { return a[0] === k; })[0]; }
  function usoInfo(k) { return USO.filter(function (a) { return a[0] === k; })[0]; }
  function hasUsage() { return !!(S.sum && S.sum.uso && S.sum.uso.eventos > 0); }

  /* ---------------- dados ---------------- */
  function critParams() { return { p_high: S.crit.high, p_low: S.crit.low, p_inactive: S.crit.inactive }; }
  async function loadSummary() {
    var r = await A.sb.rpc("health_summary", critParams());
    if (r.error) throw r.error;
    S.sum = r.data;
  }
  function listParams(extra) {
    var f = S.f, p = Object.assign({
      p_software: S.sw === "all" ? null : S.sw, p_ass: f.ass || null, p_uso: f.uso || null, p_ultimo: f.ultimo || null,
      p_freq_min: f.freq ? Number(f.freq) : null, p_plano: f.plano || null, p_q: f.q.trim() || null,
      p_order: S.order, p_desc: S.desc, p_limit: PAGE, p_offset: S.page * PAGE
    }, critParams());
    return Object.assign(p, extra || {});
  }
  async function loadList() {
    var seq = ++S.listSeq;
    $("ch-body").style.opacity = ".55";
    var r = await A.sb.rpc("health_customers", listParams());
    if (seq !== S.listSeq) return; // chegou uma consulta mais nova
    $("ch-body").style.opacity = "";
    if (r.error) { A.toast("Erro ao carregar a lista: " + r.error.message, true); return; }
    S.list = r.data || { total: 0, rows: [] };
    renderList();
  }
  async function loadCriteria() {
    var local = null;
    try { local = JSON.parse(safeGet("ch_criteria")); } catch (e) {}
    if (local) S.crit = cleanCrit(local);
    var r = await A.sb.from("ui_prefs").select("value").eq("key", CRIT_KEY).maybeSingle();
    if (!r.error && r.data && !S.critTimer) { S.crit = cleanCrit(r.data.value); safeSet("ch_criteria", JSON.stringify(S.crit)); }
  }
  function cleanCrit(raw) {
    var c = {};
    Object.keys(DEFAULT_CRIT).forEach(function (k) { var n = Math.round(Number(raw && raw[k])); c[k] = isFinite(n) && n > 0 ? Math.min(n, 365) : DEFAULT_CRIT[k]; });
    if (c.low >= c.inactive) c.low = Math.max(1, c.inactive - 1);
    return c;
  }
  async function refreshAll() {
    S.loading = true;
    try {
      await loadSummary();
      renderTop();
      await loadList();
    } catch (e) {
      console.warn("Saúde dos clientes:", e);
      A.toast("Não foi possível carregar a saúde dos clientes: " + (e.message || e), true);
    } finally { S.loading = false; }
  }

  /* ---------------- agregação do software escolhido ---------------- */
  var NUM_KEYS = ["clientes", "ass_ativo", "ass_vence_30", "ass_carencia", "ass_cancelou", "reembolsaram", "renovaram", "multi_produto", "com_uso", "hoje", "d7", "d30",
    "inativos", "nunca", "seg_muito", "seg_engajado", "seg_moderado", "seg_baixo", "vencem_90", "vencem_90_sem_uso"];
  function selStats() {
    var list = (S.sum && S.sum.softwares) || [];
    if (S.sw !== "all") return list.filter(function (s) { return s.software === S.sw; })[0] || null;
    if (!list.length) return null;
    var tot = { software: "all", tool: "Todos os softwares", vencimentos: {}, planos: [] }, plan = {};
    NUM_KEYS.forEach(function (k) { tot[k] = list.reduce(function (a, s) { return a + (Number(s[k]) || 0); }, 0); });
    list.forEach(function (s) {
      Object.keys(s.vencimentos || {}).forEach(function (w) { tot.vencimentos[w] = (tot.vencimentos[w] || 0) + s.vencimentos[w]; });
      (s.planos || []).forEach(function (p) { plan[p.plano] = (plan[p.plano] || 0) + p.n; });
    });
    tot.planos = Object.keys(plan).map(function (k) { return { plano: k, n: plan[k] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 15);
    return tot;
  }

  /* ---------------- esqueleto ---------------- */
  function build(root) {
    root.innerHTML =
      '<section class="ch-hero">' +
        '<div class="ch-hero-main"><div class="ch-kicker">Saúde dos clientes</div><h3 class="ch-title">Engajamento por software</h3>' +
          '<p class="ch-sub">Quem está usando o Flow Pages, o Flow Tracking e o Flow Spy, e quem está perto de sair. A parte de assinatura já vem da Kiwify; o uso dos softwares aparece assim que a Biancode enviar os acessos.</p>' +
          '<div class="ch-sources" id="ch-sources"></div></div>' +
        '<div class="ch-hero-acts"><button class="btn" id="ch-crit" type="button">Critérios</button><button class="btn" id="ch-import" type="button">Importar acessos (CSV)</button><button class="btn btn-primary" id="ch-integ" type="button">Integração (Biancode)</button></div>' +
      "</section>" +
      '<div class="ch-cards" id="ch-cards"></div>' +
      '<div class="ch-tabs" id="ch-tabs" role="tablist" aria-label="Software"></div>' +
      '<div id="ch-detail"></div>' +
      '<section class="panel" id="ch-list-panel">' +
        '<div class="panel-head"><h3>Clientes</h3><div class="tools"><span class="muted" id="ch-count" style="font-size:12px"></span><button class="btn" id="ch-csv" type="button">Exportar CSV</button></div></div>' +
        '<div class="ch-filters">' +
          '<input type="search" id="ch-f-q" placeholder="Buscar por e-mail ou nome…" aria-label="Buscar por e-mail ou nome">' +
          '<select id="ch-f-ass" aria-label="Situação da assinatura"></select>' +
          '<select id="ch-f-uso" aria-label="Engajamento"></select>' +
          '<select id="ch-f-ultimo" aria-label="Último acesso"><option value="">Último acesso: qualquer</option><option value="hoje">Acessou hoje</option><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option><option value="mais30">Mais de 30 dias sem acessar</option><option value="nunca">Nunca acessou</option></select>' +
          '<select id="ch-f-freq" aria-label="Frequência"><option value="">Frequência: qualquer</option><option value="1">1+ dia com acesso (30 dias)</option><option value="4">4+ dias</option><option value="8">8+ dias</option><option value="15">15+ dias</option></select>' +
          '<select id="ch-f-plano" aria-label="Plano"></select>' +
          '<button class="btn btn-ghost" id="ch-f-clear" type="button">Limpar filtros</button>' +
        "</div>" +
        '<div class="table-scroll"><table class="health-table ch-table"><thead id="ch-head"></thead><tbody id="ch-body"></tbody></table></div>' +
        '<div class="ch-pager" id="ch-pager"></div>' +
      "</section>";

    var modal = document.createElement("div");
    modal.id = "ch-modal"; modal.hidden = true;
    modal.innerHTML = '<div class="ch-modal-box" role="dialog" aria-modal="true" id="ch-modal-box"></div>';
    document.body.appendChild(modal);
    var scrim = document.createElement("div"); scrim.id = "ch-scrim";
    var dr = document.createElement("aside"); dr.id = "ch-drawer"; dr.setAttribute("role", "dialog"); dr.setAttribute("aria-label", "Histórico do cliente"); dr.setAttribute("aria-hidden", "true");
    document.body.appendChild(scrim); document.body.appendChild(dr);
    bind(root);
  }

  /* ---------------- topo: fontes, cards, abas ---------------- */
  function renderTop() {
    renderSources(); renderCards(); renderTabs(); renderDetail(); renderFilters();
  }
  function renderSources() {
    var u = S.sum.uso, total = (S.sum.softwares || []).reduce(function (a, s) { return a + s.clientes; }, 0);
    $("ch-sources").innerHTML =
      '<span class="ch-src ok"><i></i>Assinaturas (Kiwify): ' + fmtInt(total) + " cadastros de cliente por software</span>" +
      (u.eventos > 0
        ? '<span class="ch-src ok"><i></i>Uso dos softwares: ' + fmtInt(u.dias) + " dia(s) de histórico · último acesso registrado em " + esc(fmtDateTime(u.ultimo)) + "</span>"
        : '<span class="ch-src wait"><i></i>Uso dos softwares: aguardando os acessos da Biancode</span>');
  }
  function renderCards() {
    var list = S.sum.softwares || [];
    $("ch-cards").innerHTML = list.map(function (s) {
      var ok = s.ass_ativo + s.ass_vence_30, share = s.clientes ? ok / s.clientes * 100 : 0;
      return '<button type="button" class="ch-card' + (S.sw === s.software ? " on" : "") + '" data-sw="' + esc(s.software) + '">' +
        '<div class="ch-card-ring">' + FlowHud.ring({ pct: share, color: tok("--accent"), size: 78, ticks: 36, label: s.tool }) + "</div>" +
        '<div class="ch-card-t"><b>' + esc(s.tool) + "</b><strong class=\"num\">" + fmtInt(s.clientes) + '</strong><span>clientes · ' + pct(ok, s.clientes) + " com assinatura vigente</span>" +
        '<small>' + fmtInt(s.ass_vence_30) + " vencem em 30 dias · " + fmtInt(s.ass_cancelou) + " cancelaram" +
        (s.com_uso > 0 ? " · " + fmtInt(s.d7) + " acessaram em 7 dias" : "") + "</small></div></button>";
    }).join("") || '<p class="muted">Nenhum cliente encontrado.</p>';
  }
  function renderTabs() {
    var list = S.sum.softwares || [];
    var tabs = [["all", "Todos os softwares"]].concat(list.map(function (s) { return [s.software, s.tool]; }));
    $("ch-tabs").innerHTML = tabs.map(function (t) {
      return '<button type="button" role="tab" class="pay-chip' + (S.sw === t[0] ? " on" : "") + '" data-tab="' + esc(t[0]) + '" aria-selected="' + (S.sw === t[0]) + '">' + esc(t[1]) + "</button>";
    }).join("");
  }

  /* ---------------- detalhe do software escolhido ---------------- */
  function tile(label, value, sub, flt, tip) {
    var on = flt && ((flt.indexOf("ass:") === 0 && S.f.ass === flt.slice(4)) || (flt.indexOf("uso:") === 0 && S.f.uso === flt.slice(4)));
    return '<button type="button" class="ch-tile' + (on ? " on" : "") + '"' + (flt ? ' data-flt="' + flt + '"' : " disabled") + (tip ? ' title="' + esc(tip) + '"' : "") + "><small>" + label + '</small><b class="num">' + value + "</b>" + (sub ? "<span>" + sub + "</span>" : "") + "</button>";
  }
  function propBar(parts, total) {
    if (!total) return "";
    return '<div class="ch-prop" role="img" aria-label="Distribuição">' + parts.filter(function (p) { return p.n > 0; }).map(function (p) {
      var w = p.n / total * 100;
      return '<button type="button" class="ch-prop-seg" data-flt="' + p.flt + '" style="width:' + w.toFixed(2) + "%;background:" + p.color + '" title="' + esc(p.label + ": " + fmtInt(p.n) + " (" + pct(p.n, total) + ")") + '">' + (w >= 9 ? esc(pct(p.n, total)) : "") + "</button>";
    }).join("") + "</div>" +
      '<div class="ch-legend">' + parts.map(function (p) { return '<span><i style="background:' + p.color + '"></i>' + esc(p.label) + " · " + fmtInt(p.n) + "</span>"; }).join("") + "</div>";
  }
  function renderDetail() {
    var s = selStats();
    var el = $("ch-detail");
    if (!s) { el.innerHTML = ""; return; }
    var name = s.software === "all" ? "todos os softwares" : s.tool;
    var assParts = ASS.map(function (a) { return { label: a[1], n: s["ass_" + a[0]], color: tok(a[3]), flt: "ass:" + a[0] }; });

    var assSec = '<section class="panel ch-sec"><div class="panel-head"><h3>Assinatura · ' + esc(s.tool) + '</h3><span class="muted" style="font-size:12px">Dados da Kiwify. Clique para ver os clientes.</span></div>' +
      '<div class="ch-tiles">' +
        tile("Clientes", fmtInt(s.clientes), "com pelo menos 1 pagamento", "") +
        tile("Assinatura em dia", fmtInt(s.ass_ativo), pct(s.ass_ativo, s.clientes) + " da base", "ass:ativo", ASS[0][2]) +
        tile("Vencem em 30 dias", fmtInt(s.ass_vence_30), pct(s.ass_vence_30, s.clientes) + " da base", "ass:vence_30", ASS[1][2]) +
        tile("Em carência", fmtInt(s.ass_carencia), "venceram há até 15 dias", "ass:carencia", ASS[2][2]) +
        tile("Cancelaram", fmtInt(s.ass_cancelou), pct(s.ass_cancelou, s.clientes) + " da base", "ass:cancelou", ASS[3][2]) +
        tile("Renovaram", fmtInt(s.renovaram), "2 ou mais pagamentos", "ass:renovou", "Clientes com mais de um pagamento neste software.") +
        tile("Usam 2+ softwares", fmtInt(s.multi_produto), pct(s.multi_produto, s.clientes) + " da base", "ass:multi", "Clientes que pagaram por mais de um software Flow.") +
        tile("Reembolsaram", fmtInt(s.reembolsaram), "reembolso ou chargeback", "ass:reembolso") +
      "</div>" + propBar(assParts, s.clientes) + "</section>";

    var usoSec;
    if (s.com_uso > 0 || (s.software === "all" && hasUsage())) {
      var usoParts = USO.filter(function (u) { return u[0] !== "nunca"; }).map(function (u) { return { label: u[1], n: s[{ muito_engajado: "seg_muito", engajado: "seg_engajado", moderado: "seg_moderado", baixo: "seg_baixo", inativo: "inativos" }[u[0]]], color: tok(u[3]), flt: "uso:" + u[0] }; });
      usoParts.push({ label: "Nunca acessaram", n: s.nunca, color: tok("--text-muted"), flt: "uso:nunca" });
      usoSec = '<section class="panel ch-sec"><div class="panel-head"><h3>Uso do software · ' + esc(s.tool) + '</h3><span class="muted" style="font-size:12px">Muito engajado = ' + S.crit.high + "+ dias com acesso na semana · baixo = " + S.crit.low + " a " + S.crit.inactive + " dias sem acessar · inativo = mais de " + S.crit.inactive + " dias.</span></div>" +
        '<div class="ch-tiles">' +
          tile("Acessaram hoje", fmtInt(s.hoje), pct(s.hoje, s.clientes) + " da base", "uso:hoje") +
          tile("Últimos 7 dias", fmtInt(s.d7), pct(s.d7, s.clientes) + " da base", "uso:d7") +
          tile("Últimos 30 dias", fmtInt(s.d30), pct(s.d30, s.clientes) + " da base", "uso:d30") +
          tile("Inativos (+" + S.crit.inactive + " dias)", fmtInt(s.inativos), pct(s.inativos, s.clientes) + " da base", "uso:inativo", USO[4][2]) +
          tile("Nunca acessaram", fmtInt(s.nunca), pct(s.nunca, s.clientes) + " da base", "uso:nunca", USO[5][2]) +
        "</div>" + propBar(usoParts, s.clientes) +
        '<div class="ch-segs">' + USO.map(function (u) {
          var n = s[{ muito_engajado: "seg_muito", engajado: "seg_engajado", moderado: "seg_moderado", baixo: "seg_baixo", inativo: "inativos", nunca: "nunca" }[u[0]]];
          return '<button type="button" class="ch-seg' + (S.f.uso === u[0] ? " on" : "") + '" data-flt="uso:' + u[0] + '"><i style="background:' + tok(u[3]) + '"></i><div><b>' + u[1] + "</b><span>" + u[2] + '</span></div><strong class="num">' + fmtInt(n) + "</strong></button>";
        }).join("") + "</div></section>";
    } else {
      usoSec = '<section class="panel ch-sec ch-empty-uso"><div class="panel-head"><h3>Uso do software · ' + esc(s.tool) + '</h3></div>' +
        '<div class="ch-wait"><div class="ch-wait-ring" aria-hidden="true"></div><div><b>Aguardando os acessos da Biancode</b>' +
        "<p>Ainda não há acessos registrados. Quando a Biancode enviar, esta parte mostra quem acessou hoje, em 7 e em 30 dias, quem está inativo e as faixas de engajamento, sempre separado por software.</p>" +
        '<div class="ch-wait-acts"><button class="btn btn-primary" type="button" data-act="integ">Ver como integrar</button><button class="btn" type="button" data-act="import">Importar CSV de acessos</button></div></div></div></section>';
    }

    var venc = '<section class="panel ch-sec"><div class="panel-head"><h3>Assinaturas que vencem nas próximas 12 semanas</h3>' +
      '<span class="muted" style="font-size:12px">' + fmtInt(s.vencem_90) + " cliente(s) vencem em até 90 dias" + (s.com_uso > 0 || hasUsage() ? ", " + fmtInt(s.vencem_90_sem_uso) + " deles sem uso recente (candidatos a reativação)" : "") + "</span></div>" +
      '<div class="chart-wrap"><div id="ch-expiry"></div></div></section>';

    el.innerHTML = assSec + usoSec + venc;
    drawExpiry(s.vencimentos || {});
  }

  function drawExpiry(venc) {
    var el = $("ch-expiry");
    if (!el) return;
    var vals = [], i;
    for (i = 0; i < 12; i++) vals.push(Number(venc[String(i)]) || 0);
    var W = Math.max(el.clientWidth || 720, 320), H = 230, mg = { l: 44, r: 10, t: 14, b: 32 }, iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    var max = Math.max.apply(null, vals.concat([1])), bw = iw / 12, base = mg.t + ih;
    var acc = tok("--accent"), warn = tok("--warning"), mut = tok("--text-muted");
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" style="width:100%;height:auto;display:block" role="img" aria-label="Vencimentos por semana"><defs>' + FlowHud.seg("exseg", W, H, base) + FlowHud.vgrad("exg", acc, 1, 0.45) + FlowHud.vgrad("exw", warn, 1, 0.45) + "</defs>";
    for (var t = 0; t <= 4; t++) { var v = max * t / 4, y = base - v / max * ih; s += '<line x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" style="stroke:var(--grid)" stroke-dasharray="2 5"/><text x="' + (mg.l - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" style="fill:var(--text-muted);font-family:var(--font-mono);font-size:9px">' + fmtInt(Math.round(v)) + "</text>"; }
    var bodies = "", caps = "", labels = "";
    vals.forEach(function (n, k) {
      var h = n ? Math.max(2, n / max * ih) : 0, x = mg.l + k * bw + bw * 0.16, w = bw * 0.68, c = k < 4 ? warn : acc;
      if (h) {
        bodies += '<rect x="' + x.toFixed(1) + '" y="' + (base - h).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="url(#' + (k < 4 ? "exw" : "exg") + ')"><title>' + (k === 0 ? "esta semana" : "daqui a " + k + " semana(s)") + ": " + fmtInt(n) + " vencimento(s)</title></rect>";
        caps += '<rect class="hud-glow" style="color:' + c + '" x="' + x.toFixed(1) + '" y="' + (base - h).toFixed(1) + '" width="' + w.toFixed(1) + '" height="2" rx="1" fill="' + c + '"/><text x="' + (x + w / 2).toFixed(1) + '" y="' + (base - h - 6).toFixed(1) + '" text-anchor="middle" style="fill:var(--text-dim);font-family:var(--font-mono);font-size:10px">' + fmtInt(n) + "</text>";
      }
      labels += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" style="fill:var(--text-muted);font-family:var(--font-mono);font-size:9px">' + (k === 0 ? "esta sem." : "+" + k) + "</text>";
    });
    s += '<line x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + base + '" y2="' + base + '" style="stroke:var(--border-strong)"/>' + '<g mask="url(#exseg)">' + bodies + "</g>" + caps + labels + FlowHud.ruler(mg.l + bw / 2, W - mg.r - bw / 2, base + 1, 11, 1, mut) + "</svg>";
    el.innerHTML = s;
  }

  /* ---------------- filtros e lista ---------------- */
  function renderFilters() {
    var s = selStats(), usage = hasUsage();
    $("ch-f-ass").innerHTML = '<option value="">Assinatura: qualquer</option>' + ASS.map(function (a) { return '<option value="' + a[0] + '">' + esc(a[1]) + "</option>"; }).join("") +
      ASS_EXTRA.map(function (a) { return '<option value="' + a[0] + '">' + esc(a[1]) + "</option>"; }).join("");
    $("ch-f-uso").innerHTML = '<option value="">Engajamento: qualquer</option>' + USO.map(function (u) { return '<option value="' + u[0] + '">' + esc(u[1]) + "</option>"; }).join("") +
      '<option value="hoje">Acessaram hoje</option><option value="d7">Acessaram em 7 dias</option><option value="d30">Acessaram em 30 dias</option>';
    $("ch-f-plano").innerHTML = '<option value="">Plano: todos</option>' + ((s && s.planos) || []).map(function (p) { return '<option value="' + esc(p.plano) + '">' + esc(p.plano) + " (" + fmtInt(p.n) + ")</option>"; }).join("");
    $("ch-f-ass").value = S.f.ass; $("ch-f-uso").value = S.f.uso; $("ch-f-ultimo").value = S.f.ultimo; $("ch-f-freq").value = S.f.freq; $("ch-f-plano").value = S.f.plano; $("ch-f-q").value = S.f.q;
    ["ch-f-uso", "ch-f-ultimo", "ch-f-freq"].forEach(function (id) {
      var sel = $(id);
      sel.disabled = !usage;
      sel.title = usage ? "" : "Disponível quando a Biancode enviar os acessos.";
    });
  }
  var COLS = [
    ["nome", "Cliente", "l", true], ["software", "Software", "l", false], ["plano", "Plano", "l", false], ["pagamentos", "Pagam.", "", true],
    ["ultima_compra", "Última compra", "", true], ["dias_para_vencer", "Vence", "", true], ["ass", "Assinatura", "l", false],
    ["ultimo_acesso", "Último acesso", "", true], ["acessos_7", "Acessos 7d", "", true], ["acessos_30", "Acessos 30d", "", true], ["dias_30", "Dias ativos 30d", "", true],
    ["uso", "Engajamento", "l", false], ["liquido_total", "Receita", "", true]
  ];
  var ORDER_MAP = { nome: "nome", pagamentos: "pagamentos", ultima_compra: "ultima_compra", dias_para_vencer: "dias_para_vencer", ultimo_acesso: "ultimo_acesso", acessos_7: "acessos_7", acessos_30: "acessos_30", dias_30: "dias_30", liquido_total: "liquido_total" };
  function venceTxt(r) {
    var d = r.dias_para_vencer;
    if (d == null) return "—";
    if (d >= 0) return "em " + Math.ceil(d) + " d";
    return "há " + Math.floor(-d) + " d";
  }
  function renderList() {
    var rows = S.list.rows || [], usage = hasUsage();
    $("ch-head").innerHTML = "<tr>" + COLS.map(function (c) {
      if (c[0] === "software" && S.sw !== "all") return "";
      var arrow = S.order === ORDER_MAP[c[0]] ? ' <span class="arrow">' + (S.desc ? "↓" : "↑") + "</span>" : "";
      return "<th" + (c[3] ? ' class="sortable ' + c[2] + '" data-ord="' + ORDER_MAP[c[0]] + '"' : ' class="' + c[2] + '"') + ">" + c[1] + arrow + "</th>";
    }).join("") + "</tr>";
    $("ch-body").innerHTML = rows.length ? rows.map(function (r) {
      var a = assInfo(r.ass_seg), u = r.uso_seg ? usoInfo(r.uso_seg) : null;
      return '<tr class="ch-row" data-email="' + esc(r.email) + '"><td class="l"><div class="ch-who"><b>' + esc(r.nome || r.email) + "</b><span>" + esc(r.email) + (r.n_produtos > 1 ? ' · <em class="ch-multi">' + r.n_produtos + " softwares</em>" : "") + "</span></div></td>" +
        (S.sw === "all" ? '<td class="l">' + esc(SW[r.software] || r.tool) + "</td>" : "") +
        '<td class="l">' + esc(r.plano) + '</td><td class="num">' + fmtInt(r.pagamentos) + '</td><td class="num">' + fmtDate(r.ultima_compra) + '</td><td class="num ' + (r.dias_para_vencer != null && r.dias_para_vencer < 0 ? "neg" : r.dias_para_vencer <= 30 ? "warn" : "") + '">' + venceTxt(r) + "</td>" +
        '<td class="l"><span class="ch-badge" style="--c:' + tok(a ? a[3] : "--text-muted") + '">' + esc(a ? a[1] : r.ass_seg) + "</span></td>" +
        '<td class="num">' + (r.tem_uso ? rel(r.dias_sem_acesso) : '<span class="muted">—</span>') + '</td><td class="num">' + (usage ? fmtInt(r.acessos_7) : "—") + '</td><td class="num">' + (usage ? fmtInt(r.acessos_30) : "—") + '</td><td class="num">' + (usage ? fmtInt(r.dias_30) : "—") + "</td>" +
        '<td class="l">' + (u ? '<span class="ch-badge" style="--c:' + tok(u[3]) + '">' + esc(u[1]) + "</span>" : '<span class="muted">' + (usage ? "—" : "sem dados de uso") + "</span>") + '</td><td class="num">' + fmtBRL(r.liquido_total) + "</td></tr>";
    }).join("") : '<tr><td colspan="' + COLS.length + '" class="empty">Nenhum cliente com esses filtros.</td></tr>';
    var from = S.list.total ? S.page * PAGE + 1 : 0, to = Math.min((S.page + 1) * PAGE, S.list.total);
    $("ch-count").textContent = fmtInt(S.list.total) + " cliente(s)";
    $("ch-pager").innerHTML = '<span class="muted">' + fmtInt(from) + "–" + fmtInt(to) + " de " + fmtInt(S.list.total) + '</span><div><button class="btn" id="ch-prev" type="button"' + (S.page === 0 ? " disabled" : "") + '>← Anterior</button> <button class="btn" id="ch-next" type="button"' + (to >= S.list.total ? " disabled" : "") + ">Próxima →</button></div>";
  }
  function setFilter(key, value, scroll) {
    S.f[key] = value; S.page = 0;
    renderDetail(); renderFilters();
    loadList().then(function () { if (scroll) $("ch-list-panel").scrollIntoView({ behavior: "smooth", block: "start" }); });
  }
  function applyTile(flt) {
    var kind = flt.split(":")[0], val = flt.split(":")[1];
    var cur = kind === "ass" ? S.f.ass : S.f.uso;
    S[kind === "ass" ? "f" : "f"][kind] = cur === val ? "" : val;
    S.page = 0;
    renderDetail(); renderFilters();
    loadList().then(function () { if (S.f[kind]) $("ch-list-panel").scrollIntoView({ behavior: "smooth", block: "start" }); });
  }

  /* ---------------- histórico individual ---------------- */
  async function openCustomer(email) {
    var dr = $("ch-drawer");
    dr.innerHTML = '<p class="muted" style="padding:20px">Carregando…</p>';
    dr.classList.add("on"); $("ch-scrim").classList.add("on"); dr.setAttribute("aria-hidden", "false");
    var r = await A.sb.rpc("health_customer", Object.assign({ p_email: email }, critParams()));
    if (r.error) { dr.innerHTML = '<p class="muted" style="padding:20px">Erro: ' + esc(r.error.message) + "</p>"; return; }
    renderCustomer(r.data);
  }
  function closeDrawer() {
    var dr = $("ch-drawer");
    if (dr) { dr.classList.remove("on"); dr.setAttribute("aria-hidden", "true"); }
    if ($("ch-scrim")) $("ch-scrim").classList.remove("on");
  }
  function activityStrip(rows, software) {
    var map = {}, max = 1;
    rows.filter(function (x) { return x.software === software; }).forEach(function (x) { map[x.day] = x.hits; max = Math.max(max, x.hits); });
    var out = '<svg class="ch-strip" viewBox="0 0 600 16" role="img" aria-label="Acessos nos últimos 60 dias">', today = new Date();
    for (var i = 59; i >= 0; i--) {
      var d = new Date(today.getTime() - i * 86400000), key = d.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }), h = map[key] || 0;
      out += '<rect x="' + ((59 - i) * 10) + '" y="2" width="8" height="12" rx="2" ' + (h ? 'style="fill:var(--accent);fill-opacity:' + (0.35 + 0.65 * h / max).toFixed(2) + '"' : 'style="fill:var(--track-bg)"') + "><title>" + key + ": " + (h ? h + " acesso(s)" : "sem acesso") + "</title></rect>";
    }
    return out + "</svg>";
  }
  function renderCustomer(c) {
    var usage = hasUsage();
    var cards = (c.softwares || []).map(function (s) {
      var a = assInfo(s.ass_seg), u = s.uso_seg ? usoInfo(s.uso_seg) : null;
      return '<div class="ch-dsw"><div class="ch-dsw-h"><b>' + esc(s.tool) + '</b><span class="ch-badge" style="--c:' + tok(a ? a[3] : "--text-muted") + '">' + esc(a ? a[1] : s.ass_seg) + "</span></div>" +
        '<div class="ch-dgrid">' +
          "<div><small>Plano</small><b>" + esc(s.plano) + "</b></div><div><small>Pagamentos</small><b class=\"num\">" + fmtInt(s.pagamentos) + "</b></div>" +
          "<div><small>Primeira compra</small><b class=\"num\">" + fmtDate(s.primeira_compra) + "</b></div><div><small>Última compra</small><b class=\"num\">" + fmtDate(s.ultima_compra) + "</b></div>" +
          "<div><small>Cobertura até</small><b class=\"num\">" + fmtDate(s.cobre_ate) + "</b></div><div><small>Receita</small><b class=\"num\">" + fmtBRL(s.liquido_total) + "</b></div>" +
        "</div>" + (s.reembolsou || s.chargeback ? '<p class="ch-warn">Teve ' + (s.chargeback ? "chargeback" : "reembolso") + " neste software.</p>" : "") +
        '<div class="ch-duse"><h5>Uso</h5>' + (s.tem_uso
          ? '<div class="ch-dgrid"><div><small>Último acesso</small><b class="num">' + esc(fmtDate(s.ultimo_acesso)) + " (" + rel(s.dias_sem_acesso) + ')</b></div><div><small>Acessos 7 dias</small><b class="num">' + fmtInt(s.acessos_7) + '</b></div><div><small>Acessos 30 dias</small><b class="num">' + fmtInt(s.acessos_30) + '</b></div><div><small>Dias ativos (30)</small><b class="num">' + fmtInt(s.dias_30) + "</b></div></div>" +
            (s.dias_sem_acesso > S.crit.inactive ? '<p class="ch-warn">Mais de ' + S.crit.inactive + " dias sem acessar.</p>" : "") +
            (u ? '<p><span class="ch-badge" style="--c:' + tok(u[3]) + '">' + esc(u[1]) + "</span></p>" : "") + activityStrip(c.acessos || [], s.software)
          : '<p class="muted" style="font-size:12.5px">' + (usage ? "Nenhum acesso registrado neste software." : "Sem dados de uso ainda (aguardando a Biancode).") + "</p>") + "</div></div>";
    }).join("") || '<p class="muted">Este e-mail não tem pagamentos nos softwares Flow.</p>';
    var compras = (c.compras || []).map(function (x) {
      return "<tr><td>" + fmtDate(x.data) + "</td><td>" + esc(x.tool) + "</td><td>" + esc(x.plano) + "</td><td>" + esc(x.status) + '</td><td class="num">' + fmtBRL(x.valor) + "</td></tr>";
    }).join("");
    $("ch-drawer").innerHTML =
      '<div class="ch-d-top"><div><h3>' + esc(c.nome || c.email) + "</h3><span>" + esc(c.email) + '</span></div><div class="ch-d-acts"><button class="btn" type="button" data-copy="' + esc(c.email) + '">Copiar e-mail</button><button class="btn btn-ghost" id="ch-d-close" type="button" aria-label="Fechar">✕</button></div></div>' +
      cards + '<h4 class="ch-d-h">Compras</h4><div class="table-scroll"><table class="health-table"><thead><tr><th>Data</th><th>Software</th><th>Plano</th><th>Status</th><th>Valor</th></tr></thead><tbody>' + (compras || '<tr><td colspan="5" class="empty">Sem compras.</td></tr>') + "</tbody></table></div>";
  }

  /* ---------------- janelas (critérios, importação, integração) ---------------- */
  function openModal(html) { $("ch-modal-box").innerHTML = html; $("ch-modal").hidden = false; document.body.classList.add("ch-noscroll"); }
  function closeModal() { $("ch-modal").hidden = true; document.body.classList.remove("ch-noscroll"); }

  function openCriteria() {
    var c = S.crit;
    openModal('<div class="ch-m-head"><h3>Critérios de engajamento</h3><button class="btn btn-ghost" data-m-close type="button" aria-label="Fechar">✕</button></div>' +
      '<p class="muted">Ajuste como os clientes são classificados. A mudança vale na hora e fica salva na sua conta.</p>' +
      '<div class="ch-crit"><label>Muito engajado: dias diferentes com acesso nos últimos 7 dias, no mínimo<input type="number" id="ch-c-high" min="1" max="7" value="' + c.high + '"></label>' +
      '<label>Baixo engajamento: a partir de quantos dias sem acessar<input type="number" id="ch-c-low" min="1" max="365" value="' + c.low + '"></label>' +
      '<label>Inativo: mais de quantos dias sem acessar<input type="number" id="ch-c-inactive" min="2" max="365" value="' + c.inactive + '"></label></div>' +
      '<p class="muted" style="font-size:12px">Engajado = acessou pelo menos 1 dia nos últimos 7. Moderadamente ativo = acessou no mês, sem frequência semanal.</p>' +
      '<div class="ch-m-acts"><button class="btn" id="ch-c-reset" type="button">Voltar ao padrão</button><button class="btn btn-primary" id="ch-c-save" type="button">Salvar</button></div>');
  }
  async function saveCriteria(next) {
    S.crit = cleanCrit(next);
    safeSet("ch_criteria", JSON.stringify(S.crit));
    clearTimeout(S.critTimer);
    S.critTimer = setTimeout(async function () {
      S.critTimer = null;
      var r = await A.sb.from("ui_prefs").upsert({ user_id: A.userId(), key: CRIT_KEY, value: S.crit, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
      if (r.error) console.warn("health_criteria:", r.error);
    }, 400);
    closeModal();
    await refreshAll();
  }

  /* CSV de acessos */
  function parseCsv(text) {
    text = text.replace(/^﻿/, "");
    var first = text.split(/\r?\n/, 1)[0] || "";
    var delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : first.indexOf("\t") >= 0 ? "\t" : ",";
    var rows = [], row = [], cell = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some(function (x) { return x.trim() !== ""; })) rows.push(row); row = []; }
      else cell += ch;
    }
    row.push(cell); if (row.some(function (x) { return x.trim() !== ""; })) rows.push(row);
    return rows;
  }
  function normSoftware(s) {
    var t = String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
    if (t.indexOf("page") >= 0) return "flowpages";
    if (t.indexOf("track") >= 0) return "flowtracking";
    if (t.indexOf("spy") >= 0) return "flowspy";
    return null;
  }
  function parseWhen(s) {
    s = String(s || "").trim();
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s), out = null;
    if (m) {
      var tz = m[7] ? (m[7] === "Z" ? "Z" : m[7].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")) : "-03:00";
      out = m[1] + "-" + m[2] + "-" + m[3] + "T" + (m[4] || "12") + ":" + (m[5] || "00") + ":" + (m[6] || "00") + tz;
    } else if ((m = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s))) {
      out = m[3] + "-" + m[2] + "-" + m[1] + "T" + (m[4] || "12") + ":" + (m[5] || "00") + ":" + (m[6] || "00") + "-03:00";
    }
    return out && !isNaN(Date.parse(out)) ? out : null;
  }
  function toEvents(rows) {
    var head = rows[0] ? rows[0].join(" ") : "", hasHeader = head.indexOf("@") < 0, idx = { software: 0, email: 1, at: 2, hits: 3 };
    if (hasHeader) {
      rows[0].forEach(function (h, i) {
        var t = String(h).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
        if (/^(software|produto|ferramenta)/.test(t)) idx.software = i;
        else if (/^(email|usuario|user|cliente)/.test(t)) idx.email = i;
        else if (/^(acessos|hits|qtd|quantidade|total)$/.test(t)) idx.hits = i; // "acessos" (plural) = quantidade
        else if (/^(data|date|at|dataacesso|acesso|ultimoacesso|quando)/.test(t)) idx.at = i;
      });
    }
    var ev = [], bad = 0;
    rows.slice(hasHeader ? 1 : 0).forEach(function (r) {
      var sw = normSoftware(r[idx.software]), em = String(r[idx.email] || "").trim().toLowerCase(), at = parseWhen(r[idx.at]);
      var hits = Math.max(1, Math.round(Number(String(r[idx.hits] || "1").replace(",", ".")) || 1));
      if (!sw || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) || !at) { bad++; return; }
      ev.push({ software: sw, email: em, at: at, hits: hits });
    });
    return { events: ev, bad: bad };
  }
  function openImport() {
    openModal('<div class="ch-m-head"><h3>Importar acessos (CSV)</h3><button class="btn btn-ghost" data-m-close type="button" aria-label="Fechar">✕</button></div>' +
      '<p class="muted">Use isto para carregar um histórico que a Biancode mandar em planilha. Colunas: <b>software, e-mail, data, acessos</b> (acessos é opcional). Software pode ser "Flow Pages", "Flow Tracking" ou "Flow Spy". Datas: 2026-10-04 14:30 ou 04/10/2026 14:30 (horário de Brasília).</p>' +
      '<div class="ch-warnbox">Importar o mesmo arquivo duas vezes soma os acessos duas vezes. Cada acesso do arquivo vira 1 acesso (ou o número da coluna "acessos").</div>' +
      '<input type="file" id="ch-file" accept=".csv,text/csv,text/plain">' +
      '<textarea id="ch-paste" rows="5" placeholder="…ou cole aqui as linhas do CSV"></textarea>' +
      '<p class="muted" id="ch-prev-info"></p><div class="ch-progress" id="ch-prog" hidden><i id="ch-prog-i"></i></div>' +
      '<div class="ch-m-acts"><button class="btn" id="ch-tpl" type="button">Baixar modelo</button><button class="btn btn-primary" id="ch-go-import" type="button" disabled>Importar</button></div>');
  }
  var importEvents = [];
  function previewImport(text) {
    var info = $("ch-prev-info"), btn = $("ch-go-import");
    if (!text.trim()) { importEvents = []; info.textContent = ""; btn.disabled = true; return; }
    var rows = parseCsv(text), r = toEvents(rows);
    importEvents = r.events;
    var by = {};
    r.events.forEach(function (e) { by[e.software] = (by[e.software] || 0) + 1; });
    info.innerHTML = "<b>" + fmtInt(r.events.length) + "</b> acesso(s) válido(s)" + (r.events.length ? " (" + Object.keys(by).map(function (k) { return SW[k] + ": " + fmtInt(by[k]); }).join(", ") + ")" : "") + (r.bad ? ' · <span class="ch-bad">' + fmtInt(r.bad) + " linha(s) ignorada(s) (software, e-mail ou data inválidos)</span>" : "") + ".";
    btn.disabled = !r.events.length;
  }
  async function runImport() {
    var btn = $("ch-go-import"), prog = $("ch-prog"), bar = $("ch-prog-i"), total = importEvents.length, done = 0, saved = 0;
    btn.disabled = true; prog.hidden = false;
    try {
      for (var i = 0; i < total; i += 2000) {
        var chunk = importEvents.slice(i, i + 2000);
        var r = await A.sb.rpc("usage_import", { p_events: chunk });
        if (r.error) throw r.error;
        saved += r.data || 0; done += chunk.length;
        bar.style.width = (done / total * 100).toFixed(0) + "%";
      }
      A.toast("Importado: " + fmtInt(done) + " acesso(s), " + fmtInt(saved) + " linha(s) de usuário/dia.");
      closeModal();
      await refreshAll();
    } catch (e) {
      A.toast("Falha na importação: " + (e.message || e), true);
      btn.disabled = false;
    }
  }

  /* Integração: endpoint e chaves de API */
  async function sha256Hex(text) {
    var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  async function openIntegration(newKey) {
    var url = (A.url || "") + "/functions/v1/usage-ingest";
    var keysRes = await A.sb.from("usage_api_keys").select("id, name, created_at, last_used_at, revoked_at").order("created_at", { ascending: false });
    var keys = keysRes.data || [];
    var example = '{\n  "events": [\n    { "software": "flowpages", "email": "cliente@exemplo.com", "at": "2026-10-04T14:30:00-03:00" },\n    { "software": "flowtracking", "email": "cliente@exemplo.com", "at": "2026-10-04T15:02:00-03:00", "hits": 3 }\n  ]\n}';
    var curl = 'curl -X POST "' + url + '" \\\n  -H "x-api-key: SUA_CHAVE" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"events":[{"software":"flowpages","email":"cliente@exemplo.com"}]}\'';
    openModal('<div class="ch-m-head"><h3>Integração com a Biancode</h3><button class="btn btn-ghost" data-m-close type="button" aria-label="Fechar">✕</button></div>' +
      '<p class="muted">A Biancode envia cada acesso (ou um resumo por usuário) para o endereço abaixo, com uma chave. Os acessos são somados por usuário, software e dia.</p>' +
      (newKey ? '<div class="ch-newkey"><b>Chave criada. Copie agora: ela não será mostrada de novo.</b><code id="ch-key-val">' + esc(newKey) + '</code><button class="btn btn-primary" type="button" data-copy="' + esc(newKey) + '">Copiar chave</button></div>' : "") +
      '<h4 class="ch-d-h">Endereço</h4><div class="ch-code"><code>POST ' + esc(url) + '</code><button class="btn" type="button" data-copy="' + esc(url) + '">Copiar</button></div>' +
      '<h4 class="ch-d-h">Formato</h4><pre class="ch-pre">' + esc(example) + '</pre><button class="btn" type="button" data-copy="' + esc(example) + '">Copiar exemplo</button>' +
      '<ul class="ch-rules"><li><b>software</b>: flowpages, flowtracking ou flowspy.</li><li><b>email</b>: o mesmo e-mail da compra na Kiwify (é o que cruza os dados).</li><li><b>at</b> (opcional): data/hora do acesso, com fuso (ISO 8601). Sem ela vale o momento do envio.</li><li><b>hits</b> (opcional): quantos acessos aquele evento representa (padrão 1).</li><li>Até 5.000 eventos por chamada. Mande no login ou numa ação de uso de verdade, não só na página inicial.</li></ul>' +
      '<h4 class="ch-d-h">Teste rápido (terminal)</h4><pre class="ch-pre">' + esc(curl) + "</pre>" +
      '<h4 class="ch-d-h">Chaves</h4><div class="ch-keys">' + (keys.length ? keys.map(function (k) {
        return '<div class="ch-key' + (k.revoked_at ? " off" : "") + '"><div><b>' + esc(k.name) + "</b><span>criada em " + esc(fmtDate(k.created_at)) + " · " + (k.last_used_at ? "último uso " + esc(fmtDateTime(k.last_used_at)) : "nunca usada") + (k.revoked_at ? " · revogada" : "") + "</span></div>" +
          (k.revoked_at ? "" : '<button class="btn" type="button" data-revoke="' + esc(k.id) + '">Revogar</button>') + "</div>";
      }).join("") : '<p class="muted">Nenhuma chave criada ainda.</p>') + "</div>" +
      '<div class="ch-newkey-form"><input type="text" id="ch-key-name" maxlength="80" placeholder="Nome da chave (ex.: Biancode produção)"><button class="btn btn-primary" id="ch-key-create" type="button">Gerar nova chave</button></div>');
  }
  async function createKey() {
    var name = $("ch-key-name").value.trim();
    if (!name) { A.toast("Dê um nome para a chave.", true); $("ch-key-name").focus(); return; }
    var bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
    var key = "fu_" + Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    var r = await A.sb.from("usage_api_keys").insert({ name: name, key_hash: await sha256Hex(key), created_by: A.userId() });
    if (r.error) { A.toast("Não foi possível criar a chave: " + r.error.message, true); return; }
    await openIntegration(key);
  }
  async function revokeKey(id) {
    if (!window.confirm("Revogar esta chave? Quem usa ela deixa de conseguir enviar acessos.")) return;
    var r = await A.sb.from("usage_api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (r.error) { A.toast("Não foi possível revogar: " + r.error.message, true); return; }
    A.toast("Chave revogada.");
    await openIntegration();
  }
  function copy(text) {
    var done = function () { A.toast("Copiado."); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { A.toast("Não foi possível copiar.", true); });
    else { var t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); done(); } catch (e) {} t.remove(); }
  }

  /* CSV da lista atual (até 5.000 linhas) */
  function csvCell(v) { var s = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }
  async function exportList() {
    var btn = $("ch-csv"); btn.disabled = true; btn.textContent = "Gerando…";
    try {
      var out = [["Nome", "E-mail", "Software", "Plano", "Pagamentos", "Última compra", "Cobertura até", "Situação da assinatura", "Receita líquida", "Softwares do cliente", "Último acesso", "Acessos 7d", "Acessos 30d", "Dias ativos 30d", "Engajamento"].map(csvCell).join(",")];
      for (var off = 0; off < 5000; off += 500) {
        var r = await A.sb.rpc("health_customers", listParams({ p_limit: 500, p_offset: off }));
        if (r.error) throw r.error;
        (r.data.rows || []).forEach(function (x) {
          var a = assInfo(x.ass_seg), u = x.uso_seg ? usoInfo(x.uso_seg) : null;
          out.push([x.nome, x.email, SW[x.software] || x.tool, x.plano, x.pagamentos, x.ultima_compra ? x.ultima_compra.slice(0, 10) : "", x.cobre_ate ? x.cobre_ate.slice(0, 10) : "", a ? a[1] : x.ass_seg, x.liquido_total,
            x.n_produtos, x.ultimo_acesso ? x.ultimo_acesso.slice(0, 10) : "", x.acessos_7, x.acessos_30, x.dias_30, u ? u[1] : ""].map(csvCell).join(","));
        });
        if ((r.data.rows || []).length < 500) break;
      }
      var blob = new Blob(["﻿" + out.join("\r\n")], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "saude-dos-clientes.csv";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    } catch (e) { A.toast("Não foi possível exportar: " + (e.message || e), true); }
    btn.disabled = false; btn.textContent = "Exportar CSV";
  }

  /* ---------------- eventos ---------------- */
  function bind(root) {
    root.addEventListener("click", function (e) {
      var card = e.target.closest("[data-sw]");
      if (card) { S.sw = card.dataset.sw === S.sw ? "all" : card.dataset.sw; S.f.plano = ""; S.page = 0; renderCards(); renderTabs(); renderDetail(); renderFilters(); loadList(); return; }
      var tab = e.target.closest("[data-tab]");
      if (tab) { S.sw = tab.dataset.tab; S.f.plano = ""; S.page = 0; renderCards(); renderTabs(); renderDetail(); renderFilters(); loadList(); return; }
      var flt = e.target.closest("[data-flt]");
      if (flt && !flt.disabled) return applyTile(flt.dataset.flt);
      var act = e.target.closest("[data-act]");
      if (act) return act.dataset.act === "integ" ? openIntegration() : openImport();
      if (e.target.closest("#ch-crit")) return openCriteria();
      if (e.target.closest("#ch-import")) return openImport();
      if (e.target.closest("#ch-integ")) return openIntegration();
      if (e.target.closest("#ch-csv")) return exportList();
      if (e.target.closest("#ch-f-clear")) { S.f = { ass: "", uso: "", ultimo: "", freq: "", plano: "", q: "" }; S.page = 0; renderDetail(); renderFilters(); loadList(); return; }
      if (e.target.closest("#ch-prev")) { S.page = Math.max(0, S.page - 1); loadList(); return; }
      if (e.target.closest("#ch-next")) { S.page++; loadList(); return; }
      var th = e.target.closest("th[data-ord]");
      if (th) { S.desc = S.order === th.dataset.ord ? !S.desc : true; S.order = th.dataset.ord; S.page = 0; loadList(); return; }
      var row = e.target.closest("tr[data-email]");
      if (row) openCustomer(row.dataset.email);
    });
    var map = { "ch-f-ass": "ass", "ch-f-uso": "uso", "ch-f-ultimo": "ultimo", "ch-f-freq": "freq", "ch-f-plano": "plano" };
    root.addEventListener("change", function (e) {
      var k = map[e.target.id];
      if (k) { S.f[k] = e.target.value; S.page = 0; renderDetail(); loadList(); }
    });
    root.addEventListener("input", function (e) {
      if (e.target.id !== "ch-f-q") return;
      S.f.q = e.target.value;
      clearTimeout(S.qTimer);
      S.qTimer = setTimeout(function () { S.page = 0; loadList(); }, 350);
    });

    $("ch-drawer").addEventListener("click", function (e) {
      if (e.target.closest("#ch-d-close")) return closeDrawer();
      var cp = e.target.closest("[data-copy]");
      if (cp) copy(cp.dataset.copy);
    });
    $("ch-scrim").addEventListener("click", closeDrawer);
    $("ch-modal").addEventListener("click", function (e) {
      if (e.target.id === "ch-modal" || e.target.closest("[data-m-close]")) return closeModal();
      var cp = e.target.closest("[data-copy]");
      if (cp) return copy(cp.dataset.copy);
      var rv = e.target.closest("[data-revoke]");
      if (rv) return revokeKey(rv.dataset.revoke);
      if (e.target.closest("#ch-key-create")) return createKey();
      if (e.target.closest("#ch-go-import")) return runImport();
      if (e.target.closest("#ch-tpl")) {
        var blob = new Blob(["﻿software,email,data,acessos\r\nflowpages,cliente@exemplo.com,2026-10-04 14:30,3\r\nflowtracking,cliente@exemplo.com,04/10/2026 15:02,1\r\nflowspy,outro@exemplo.com,2026-10-01,2\r\n"], { type: "text/csv;charset=utf-8" });
        var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "modelo-acessos.csv"; document.body.appendChild(a); a.click(); a.remove();
        return;
      }
      if (e.target.closest("#ch-c-save")) return saveCriteria({ high: $("ch-c-high").value, low: $("ch-c-low").value, inactive: $("ch-c-inactive").value });
      if (e.target.closest("#ch-c-reset")) return saveCriteria(DEFAULT_CRIT);
    });
    $("ch-modal").addEventListener("change", function (e) {
      if (e.target.id === "ch-file" && e.target.files && e.target.files[0]) {
        var f = e.target.files[0];
        if (f.size > 25 * 1024 * 1024) { A.toast("Arquivo grande demais (máximo 25 MB).", true); return; }
        var rd = new FileReader();
        rd.onload = function () { $("ch-paste").value = String(rd.result).slice(0, 5000000); previewImport($("ch-paste").value); };
        rd.readAsText(f, "utf-8");
      }
    });
    $("ch-modal").addEventListener("input", function (e) { if (e.target.id === "ch-paste") previewImport(e.target.value); });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!$("ch-modal").hidden) closeModal(); else closeDrawer();
    });
    window.addEventListener("resize", function () { if (S.sum && A.root && !A.root.hidden) drawExpiry((selStats() || {}).vencimentos || {}); });
  }

  /* ---------------- API pública ---------------- */
  async function show() {
    if (!A) return;
    if (!S.ready) { S.ready = true; await loadCriteria().catch(function () {}); }
    await refreshAll();
  }
  window.CustomerHealth = {
    init: function (opts) { A = opts; build(opts.root); },
    show: show,
    hide: function () { closeDrawer(); if ($("ch-modal")) closeModal(); },
    redraw: function () { if (S.sum) { renderTop(); renderList(); } }
  };
})();
