/* Análise da IA (topo da Home do Financeiro).
   Texto escrito pelo Claude (tarefa agendada "Análise e Avisos FlowFinance", ou pela API se houver chave) a partir dos
   números de public.fin_analysis_facts(): mês atual × mês anterior × mesmo mês do ano passado, mês fechado × ano passado,
   ano × ano, reembolsos, afiliados, despesas, série mensal e projeção. Dados: tabela fin_analyses.

   Leitura em camadas:
     1. manchete (seção RESUMO do texto)            → o que importa em 10 segundos
     2. 4 cartões de comparação (números do banco)  → líquido, variação, vendas, ticket, reembolso
     3. projeção do mês + 12 meses + ferramentas    → ritmo e quem puxa
     4. "O que fazer agora" em cartões numerados
     5. análise detalhada (demais seções), aberta sob demanda
   Os cartões e gráficos usam só os números (facts); funcionam mesmo sem texto da IA.
   Uso: FinAnalysis.init({ root, sb, toast }); FinAnalysis.show(); */
window.FinAnalysis = (function () {
  "use strict";
  var A = null, S = { row: null, open: false, busy: false, loaded: false };
  var MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  var CARDS = [
    { k: "mes_atual", c: "mes_anterior_mesmo_ponto", t: "Mês atual × mês anterior" },
    { k: "mes_atual", c: "mes_atual_ano_passado", t: "Mês atual × ano passado" },
    { k: "mes_anterior_fechado", c: "mes_anterior_ano_passado", t: "Mês fechado × ano passado", res: ["mes_anterior_fechado", "mes_anterior_ano_passado"] },
    { k: "ano_atual", c: "ano_passado_mesmo_ponto", t: "Ano × ano", res: ["ano_atual_meses_fechados", "ano_passado_mesmos_meses"] }
  ];
  var TOOL_COLOR = { FlowTracking: "var(--c-tracking, var(--accent-3))", FlowPages: "var(--c-pages, var(--accent))", FlowSpy: "var(--c-spy, var(--accent-2))" };

  /* ---------------- formatação ---------------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function brl(v, short) {
    if (v == null || isNaN(v)) return "—";
    if (short && Math.abs(v) >= 1e3) {
      var a = Math.abs(v), s = a >= 1e6 ? (a / 1e6).toFixed(2).replace(".", ",") + " mi" : (a / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(".", ",") + " mil";
      return (v < 0 ? "-" : "") + "R$ " + s;
    }
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);
  }
  function int(v) { return v == null ? "—" : new Intl.NumberFormat("pt-BR").format(v); }
  function pct1(v) { return (v * 100).toFixed(1).replace(".", ","); }
  function when(iso) { return iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"; }
  function shortLabel(l) { return String(l || "").replace(/ \(.*\)$/, ""); }
  // Variação a/b como pílula. invert = menor é melhor (reembolsos, chargebacks).
  function pill(a, b, invert, big) {
    if (a == null || b == null || !b) return '<span class="fa-pill flat' + (big ? " big" : "") + '">sem base</span>';
    var d = a / b - 1, flat = Math.abs(d) < 0.005, good = invert ? d < 0 : d > 0;
    return '<span class="fa-pill ' + (flat ? "flat" : good ? "up" : "down") + (big ? " big" : "") + '">' + (flat ? "＝" : d > 0 ? "▲" : "▼") + " " + (d > 0 ? "+" : "") + pct1(d) + "%</span>";
  }
  // Diferença em pontos percentuais (taxa de reembolso).
  function pp(a, b) {
    if (a == null || b == null) return "";
    var d = (a - b) * 100, good = d < 0;
    return '<span class="fa-pp ' + (Math.abs(d) < 0.05 ? "" : good ? "up" : "down") + '">' + (d > 0 ? "+" : "") + d.toFixed(1).replace(".", ",") + " p.p.</span>";
  }
  // Destaca valores e percentuais no texto da IA (depois de escapar).
  function rich(s) {
    return esc(s)
      .replace(/(-?R\$\s?-?[\d.]+(?:,\d{1,2})?(?:\s?(?:mil|mi))?)/g, '<b class="fa-money">$1</b>')
      .replace(/([+\-−]?\d+(?:,\d+)?%)/g, function (m) {
        var cls = /^[+]/.test(m) ? "up" : /^[-−]/.test(m) ? "down" : "";
        return '<span class="fa-num ' + cls + '">' + m + "</span>";
      });
  }

  /* ---------------- texto da IA em seções ---------------- */
  function sections(text) {
    var out = [], cur = null;
    String(text || "").split(/\r?\n/).forEach(function (raw) {
      var l = raw.trim();
      if (!l) return;
      var letters = l.replace(/[^A-Za-zÀ-ÿ]/g, "");
      if (!/^[•\-–]/.test(l) && letters.length > 3 && letters === letters.toUpperCase()) { cur = { title: l.replace(/:$/, ""), items: [] }; out.push(cur); return; }
      if (!cur) { cur = { title: "", items: [] }; out.push(cur); }
      cur.items.push(l.replace(/^[•\-–]\s*/, ""));
    });
    return out;
  }
  function isTitle(s, word) { return s.title.toUpperCase().indexOf(word) === 0; }
  var ICON = [["MÊS ATUAL × MÊS", "↗"], ["MÊS ATUAL × MESMO", "↺"], ["MÊS FECHADO", "▣"], ["ANO", "◷"], ["REEMBOLSO", "↩"], ["AFILIADO", "◎"], ["PROJE", "➚"]];
  function iconFor(t) { var u = t.toUpperCase(); for (var i = 0; i < ICON.length; i++) if (u.indexOf(ICON[i][0]) === 0) return ICON[i][1]; return "◆"; }

  /* ---------------- blocos ---------------- */
  function headline(secs, f) {
    var res = secs.filter(function (s) { return isTitle(s, "RESUMO"); })[0];
    if (res && res.items.length) {
      return '<div class="fa-hero"><div class="fa-kicker">Em 10 segundos</div><ul class="fa-head-list">' +
        res.items.map(function (t) { return "<li>" + rich(t) + "</li>"; }).join("") + "</ul></div>";
    }
    // Sem texto: uma manchete montada com os números.
    var V = f.vendas || {}, a = ((V.mes_atual || {}).Total) || {}, b = ((V.mes_anterior_mesmo_ponto || {}).Total) || {};
    if (!a.liquido) return "";
    return '<div class="fa-hero"><div class="fa-kicker">Em 10 segundos</div><ul class="fa-head-list"><li>' +
      esc(shortLabel((f.periodos.mes_atual || {}).label)) + " até agora: <b class=\"fa-money\">" + brl(a.liquido) + "</b> de líquido " + pill(a.liquido, b.liquido) +
      " contra o mesmo ponto de " + esc(shortLabel((f.periodos.mes_anterior_mesmo_ponto || {}).label)) + ".</li></ul>" +
      '<p class="fa-hint">O texto completo é escrito todo dia antes das 8h pela tarefa agendada do Claude.</p></div>';
  }

  function cards(f) {
    var P = f.periodos || {}, V = f.vendas || {}, D = f.despesas || {};
    return '<div class="fa-cards">' + CARDS.map(function (c) {
      var a = (V[c.k] || {}).Total || {}, b = (V[c.c] || {}).Total || {};
      var resRow = "";
      if (c.res && D[c.res[0]] && D[c.res[1]]) {
        var ra = a.liquido - (D[c.res[0]].Total || 0), rb = b.liquido - (D[c.res[1]].Total || 0);
        if (c.k === "ano_atual") { // ano: resultado só dos meses fechados (o mês atual ainda não tem despesas)
          var ms = f.meses || [], y = new Date().getFullYear(), sum = function (yr) { return ms.filter(function (m) { return +m.mes.slice(0, 4) === yr; }).reduce(function (t, m) { return t + (+m.liquido) - (+m.despesas); }, 0); };
          ra = sum(y); rb = sum(y - 1);
        }
        resRow = '<div class="fa-res ' + (ra < 0 ? "neg" : "") + '"><span>Resultado' + (c.k === "ano_atual" ? " (meses fechados)" : "") + "</span><b>" + brl(ra, true) + "</b><em>vs " + brl(rb, true) + "</em></div>";
      }
      return '<article class="fa-card">' +
        '<div class="fa-card-t">' + esc(c.t) + "</div>" +
        '<div class="fa-card-p">' + esc((P[c.k] || {}).label) + "</div>" +
        '<div class="fa-card-v"><b>' + brl(a.liquido, true) + "</b>" + pill(a.liquido, b.liquido, false, true) + "</div>" +
        '<div class="fa-card-vs">vs ' + brl(b.liquido, true) + " em " + esc((P[c.c] || {}).label) + "</div>" +
        '<dl class="fa-mini">' +
          "<div><dt>Vendas</dt><dd>" + int(a.vendas) + " " + pill(a.vendas, b.vendas) + "</dd></div>" +
          "<div><dt>Ticket médio</dt><dd>" + brl(a.ticket_medio) + " " + pill(a.ticket_medio, b.ticket_medio) + "</dd></div>" +
          "<div><dt>Reembolso</dt><dd>" + (a.taxa_reembolso == null ? "—" : pct1(a.taxa_reembolso) + "%") + " " + pp(a.taxa_reembolso, b.taxa_reembolso) + "</dd></div>" +
        "</dl>" + resRow + "</article>";
    }).join("") + "</div>";
  }

  // Projeção: realizado + ritmo até o fim do mês, com marcas do mês anterior e do mesmo mês do ano passado.
  function projection(f) {
    var V = f.vendas || {}, P = f.periodos || {}, pj = (f.projecao_mes_atual || {}).Total, cur = ((V.mes_atual || {}).Total || {}).liquido;
    if (!pj || cur == null) return "";
    var prev = ((V.mes_anterior_fechado || {}).Total || {}).liquido;
    var now = new Date(), lyKey = (now.getFullYear() - 1) + "-" + String(now.getMonth() + 1).padStart(2, "0");
    var ly = ((f.meses || []).filter(function (m) { return m.mes === lyKey; })[0] || {}).liquido;
    ly = ly == null ? null : +ly;
    var max = Math.max(pj.liquido, prev || 0, ly || 0) * 1.08 || 1;
    var w = function (v) { return Math.max(0, Math.min(100, v / max * 100)).toFixed(2) + "%"; };
    var mark = function (v, lab, cls) { return v ? '<i class="fa-mark ' + cls + '" style="left:' + w(v) + '"><span>' + esc(lab) + "<b>" + brl(v, true) + "</b></span></i>" : ""; };
    var day = f.dia_do_mes, days = f.dias_no_mes;
    return '<section class="fa-block fa-proj"><div class="fa-block-h"><h4>Projeção de ' + esc(shortLabel((P.mes_atual || {}).label)) + "</h4>" +
      '<span class="fa-block-s">dia ' + day + " de " + days + " · no ritmo atual</span></div>" +
      '<div class="fa-proj-n"><div><small>Realizado</small><b>' + brl(cur) + '</b></div><div class="fa-arrow">→</div><div><small>Deve fechar em</small><b class="fa-accent">' + brl(pj.liquido) + "</b>" +
        (prev ? '<span class="fa-proj-vs">' + pill(pj.liquido, prev) + " vs " + esc(shortLabel((P.mes_anterior_fechado || {}).label)) + "</span>" : "") + "</div></div>" +
      '<div class="fa-track"><div class="fa-fill-proj" style="width:' + w(pj.liquido) + '"></div><div class="fa-fill" style="width:' + w(cur) + '"></div>' +
        mark(prev, shortLabel((P.mes_anterior_fechado || {}).label), "m-prev") + mark(ly, shortLabel((P.mes_atual_ano_passado || {}).label), "m-ly") + "</div>" +
      '<div class="fa-legend"><span><i class="lg-fill"></i>realizado</span><span><i class="lg-proj"></i>projeção</span><span><i class="lg-mark"></i>meses de comparação (fechados)</span></div></section>';
  }

  // 12 meses: líquido (barra) e despesas (traço), com o mês atual projetado.
  function trend(f) {
    var ms = (f.meses || []).filter(function (m) { return +m.liquido > 0 || +m.despesas > 0; }).slice(-12);
    var pj = (f.projecao_mes_atual || {}).Total, cur = (((f.vendas || {}).mes_atual || {}).Total || {}).liquido;
    if (!ms.length) return "";
    var all = ms.map(function (m) { return { mes: m.mes, liq: +m.liquido, desp: +m.despesas }; });
    var now = new Date();
    if (pj) all.push({ mes: now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0"), liq: cur, proj: pj.liquido, desp: null, cur: true });
    var max = Math.max.apply(null, all.map(function (x) { return Math.max(x.liq || 0, x.proj || 0, x.desp || 0); })) || 1;
    var W = 640, H = 170, pad = 22, bw = (W - 8) / all.length, y = function (v) { return H - pad - (v / max) * (H - pad - 14); };
    var bars = all.map(function (x, i) {
      var x0 = 4 + i * bw + bw * 0.18, ww = bw * 0.64, mm = +x.mes.slice(5, 7) - 1, lab = MES[mm] + (mm === 0 ? "/" + x.mes.slice(2, 4) : "");
      var neg = x.desp != null && x.desp > x.liq;
      var tip = MES[mm] + "/" + x.mes.slice(0, 4) + ": líquido " + brl(x.liq) + (x.proj ? " (projeção " + brl(x.proj) + ")" : "") + (x.desp != null ? " · despesas " + brl(x.desp) : "");
      return "<g><title>" + esc(tip) + "</title>" +
        (x.proj ? '<rect x="' + x0 + '" y="' + y(x.proj) + '" width="' + ww + '" height="' + (H - pad - y(x.proj)) + '" rx="3" class="tb-proj"/>' : "") +
        '<rect x="' + x0 + '" y="' + y(x.liq) + '" width="' + ww + '" height="' + Math.max(0, H - pad - y(x.liq)) + '" rx="3" class="' + (x.cur ? "tb-cur" : neg ? "tb-neg" : "tb-liq") + '"/>' +
        (x.desp != null ? '<line x1="' + (x0 - 2) + '" x2="' + (x0 + ww + 2) + '" y1="' + y(x.desp) + '" y2="' + y(x.desp) + '" class="tb-desp"/>' : "") +
        '<text x="' + (x0 + ww / 2) + '" y="' + (H - 6) + '" class="tb-lab' + (x.cur ? " cur" : "") + '">' + lab + "</text></g>";
    }).join("");
    return '<section class="fa-block"><div class="fa-block-h"><h4>Últimos meses</h4><span class="fa-block-s">líquido de vendas e despesas</span></div>' +
      '<svg class="fa-trend" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Líquido e despesas por mês">' + bars + "</svg>" +
      '<div class="fa-legend"><span><i class="lg-fill"></i>líquido</span><span><i class="lg-neg"></i>despesas acima do líquido</span><span><i class="lg-desp"></i>despesas</span><span><i class="lg-proj"></i>mês atual projetado</span></div></section>';
  }

  // Ferramentas: mês atual × mês anterior no mesmo ponto.
  function tools(f) {
    var V = f.vendas || {}, a = V.mes_atual || {}, b = V.mes_anterior_mesmo_ponto || {}, P = f.periodos || {};
    var names = Object.keys(a).filter(function (t) { return t !== "Total" && ((a[t] || {}).liquido || (b[t] || {}).liquido); })
      .sort(function (x, y) { return (a[y].liquido || 0) - (a[x].liquido || 0); });
    if (!names.length) return "";
    var max = Math.max.apply(null, names.map(function (t) { return Math.max(a[t].liquido || 0, (b[t] || {}).liquido || 0); })) || 1;
    return '<section class="fa-block"><div class="fa-block-h"><h4>Por ferramenta</h4><span class="fa-block-s">' + esc(shortLabel((P.mes_atual || {}).label)) + " × " + esc(shortLabel((P.mes_anterior_mesmo_ponto || {}).label)) + ", até o mesmo dia</span></div>" +
      names.map(function (t) {
        var x = a[t] || {}, y = b[t] || {}, col = TOOL_COLOR[t] || "var(--accent)";
        return '<div class="fa-tool" style="--tc:' + col + '"><div class="fa-tool-h"><b>' + esc(t) + "</b><span>" + brl(x.liquido) + " " + pill(x.liquido, y.liquido) + "</span></div>" +
          '<div class="fa-tbar"><i style="width:' + ((x.liquido || 0) / max * 100).toFixed(1) + '%"></i></div>' +
          '<div class="fa-tbar prev"><i style="width:' + ((y.liquido || 0) / max * 100).toFixed(1) + '%"></i></div>' +
          '<div class="fa-tool-s">' + int(x.vendas) + " vendas · reembolso " + (x.taxa_reembolso == null ? "—" : pct1(x.taxa_reembolso) + "%") + " · mês anterior " + brl(y.liquido) + "</div></div>";
      }).join("") + "</section>";
  }

  function actions(secs) {
    var s = secs.filter(function (x) { return isTitle(x, "O QUE FAZER"); })[0];
    if (!s || !s.items.length) return "";
    return '<section class="fa-actions"><div class="fa-block-h"><h4>O que fazer agora</h4></div><ol>' +
      s.items.map(function (t, i) { return '<li><span class="fa-step">' + (i + 1) + "</span><p>" + rich(t) + "</p></li>"; }).join("") + "</ol></section>";
  }

  function details(secs) {
    var rest = secs.filter(function (s) { return s.title && !isTitle(s, "RESUMO") && !isTitle(s, "O QUE FAZER"); });
    if (!rest.length) return "";
    var toggle = '<button type="button" class="fa-more" data-fa="toggle" aria-expanded="' + S.open + '">' +
      (S.open ? "Recolher análise detalhada ▴" : "Ler análise detalhada · " + rest.length + " seções ▾") + "</button>";
    if (!S.open) return toggle;
    return toggle + '<div class="fa-secs">' + rest.map(function (s) {
      return '<article class="fa-sec"><h5><span class="fa-ico" aria-hidden="true">' + iconFor(s.title) + "</span>" + esc(s.title) + "</h5><ul>" +
        s.items.map(function (t) { return "<li>" + rich(t) + "</li>"; }).join("") + "</ul></article>";
    }).join("") + "</div>";
  }

  /* ---------------- tela ---------------- */
  function render() {
    var r = S.row, root = A.root;
    var by = r ? (r.source === "claude" ? "Escrita pelo Claude" : r.source === "ai" ? "Escrita por " + esc(r.model || "IA") : "Só números (sem texto da IA)") : "";
    var head = '<div class="fa-top"><div class="fa-title"><span class="fa-spark" aria-hidden="true">✦</span><div><h3>Análise da IA</h3>' +
      '<p class="fa-sub">' + (r ? by + " · " + esc(when(r.created_at)) + " · reescrita todo dia antes das 8h" : "Ainda não há análise.") + "</p></div></div>" +
      '<button type="button" class="btn fa-btn" data-fa="run"' + (S.busy ? " disabled" : "") + ' title="Recalcula os números agora; o texto é reescrito pela tarefa diária do Claude">' + (S.busy ? "Calculando…" : "↻ Atualizar números") + "</button></div>";
    if (!r) { root.innerHTML = head + '<p class="fa-hint">Clique em <b>Atualizar números</b> para a primeira análise.</p>'; return; }
    var f = r.facts || {}, secs = sections(r.text);
    root.innerHTML = head + headline(secs, f) + cards(f) +
      '<div class="fa-grid">' + projection(f) + trend(f) + "</div>" +
      '<div class="fa-grid">' + tools(f) + actions(secs) + "</div>" +
      details(secs) +
      '<p class="fa-foot">' + (f.notas || []).map(esc).join(" ") + "</p>";
  }

  async function load() {
    var r = await A.sb.from("fin_analyses").select("created_at, text, source, model, facts, note").order("created_at", { ascending: false }).limit(10);
    if (r.error) { A.root.hidden = true; return; }
    // O texto escrito (pela tarefa agendada do Claude ou pela API) das últimas 36 h vale mais que uma linha mais nova só com números.
    var rows = r.data || [], limit = Date.now() - 36 * 3600e3;
    S.row = rows.filter(function (x) { return x.text && Date.parse(x.created_at) > limit; })[0] || rows[0] || null;
    S.loaded = true;
    render();
  }
  async function run() {
    if (S.busy) return;
    S.busy = true; render();
    var res = await A.sb.functions.invoke("fin-analysis", { body: {} }), data = res.data || {};
    if (res.error && !data.error) { try { data = await res.error.context.json(); } catch (e) { data = { error: res.error.message }; } }
    S.busy = false;
    if (!data.ok) { A.toast("Não foi possível atualizar: " + (data.error || "erro desconhecido"), true); render(); return; }
    A.toast(data.source === "ai" ? "Análise atualizada." : "Números atualizados. O texto é reescrito pela tarefa diária do Claude.");
    await load();
  }

  return {
    init: function (deps) {
      A = deps;
      A.root.addEventListener("click", function (e) {
        var b = e.target.closest("[data-fa]");
        if (!b) return;
        if (b.dataset.fa === "run") run();
        else if (b.dataset.fa === "toggle") { S.open = !S.open; render(); }
      });
    },
    show: function () { A.root.hidden = false; if (!S.loaded) A.root.innerHTML = '<div class="fa-top"><div class="fa-title"><span class="fa-spark">✦</span><h3>Análise da IA</h3></div></div><p class="fa-hint">Carregando…</p>'; return load(); }
  };
})();
