/* Análise da IA (topo da Home do Financeiro).
   Texto escrito pelo Claude (Haiku) a partir dos números de public.fin_analysis_facts(): mês atual × mês anterior ×
   mesmo mês do ano passado, mês fechado × ano passado, ano × ano, reembolsos, afiliados, despesas e projeção.
   Dados: tabela fin_analyses (a última linha), gravada pela Edge Function fin-analysis todo dia às 8h10 ou pelo botão.
   Sem a chave da IA, mostra só a tabela de comparativos (os números são os mesmos que a IA recebe).
   Uso: FinAnalysis.init({ root, sb, toast }); FinAnalysis.show(); */
window.FinAnalysis = (function () {
  "use strict";
  var A = null, S = { row: null, open: false, busy: false, loaded: false };
  // Linhas da tabela: [período, período de comparação]
  var COMPARE = [
    ["mes_atual", "mes_anterior_mesmo_ponto"],
    ["mes_atual", "mes_atual_ano_passado"],
    ["mes_anterior_fechado", "mes_anterior_ano_passado"],
    ["ano_atual", "ano_passado_mesmo_ponto"]
  ];

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function brl(v) { return v == null ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v); }
  function int(v) { return v == null ? "—" : new Intl.NumberFormat("pt-BR").format(v); }
  function pctv(v) { return v == null ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%"; }
  function when(iso) { return iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"; }
  function delta(cur, prev, invert) {
    if (cur == null || prev == null || !prev) return '<span class="fa-d">sem base</span>';
    var d = cur / prev - 1, good = invert ? d < 0 : d > 0;
    return '<span class="fa-d ' + (Math.abs(d) < 0.005 ? "" : good ? "up" : "down") + '">' + (d >= 0 ? "+" : "") + (d * 100).toFixed(1).replace(".", ",") + "%</span>";
  }

  /* Texto da IA: títulos em MAIÚSCULAS viram cabeçalho, linhas com "•" viram lista. */
  function prose(text) {
    var out = [], list = [];
    function flush() { if (list.length) { out.push("<ul>" + list.join("") + "</ul>"); list = []; } }
    String(text || "").split(/\r?\n/).forEach(function (raw) {
      var l = raw.trim();
      if (!l) { flush(); return; }
      if (/^[•\-–]\s*/.test(l)) { list.push("<li>" + esc(l.replace(/^[•\-–]\s*/, "")) + "</li>"); return; }
      flush();
      var letters = l.replace(/[^A-Za-zÀ-ÿ]/g, "");
      if (letters.length > 3 && letters === letters.toUpperCase()) out.push("<h4>" + esc(l.replace(/:$/, "")) + "</h4>");
      else out.push("<p>" + esc(l) + "</p>");
    });
    flush();
    return out.join("");
  }
  // Primeira seção (RESUMO) para a versão recolhida.
  function summary(html) {
    var parts = html.split("<h4>");
    return parts.length > 2 ? parts[0] + "<h4>" + parts[1] : html;
  }

  function table(f) {
    var P = f.periodos || {}, V = f.vendas || {};
    var rows = COMPARE.map(function (c) {
      var a = (V[c[0]] || {}).Total || {}, b = (V[c[1]] || {}).Total || {};
      return "<tr><th class=\"l\">" + esc((P[c[0]] || {}).label) + ' <span class="fa-vs">vs. ' + esc((P[c[1]] || {}).label) + "</span></th>" +
        "<td>" + brl(a.liquido) + delta(a.liquido, b.liquido) + "</td>" +
        "<td>" + int(a.vendas) + delta(a.vendas, b.vendas) + "</td>" +
        "<td>" + brl(a.ticket_medio) + delta(a.ticket_medio, b.ticket_medio) + "</td>" +
        "<td>" + int(a.reembolsos) + delta(a.reembolsos, b.reembolsos, true) + "</td>" +
        "<td>" + pctv(a.taxa_reembolso) + "</td>" +
        "<td>" + int(a.chargebacks) + delta(a.chargebacks, b.chargebacks, true) + "</td></tr>";
    }).join("");
    var pj = (f.projecao_mes_atual || {}).Total, prevFull = ((V.mes_anterior_fechado || {}).Total || {}).liquido;
    return '<div class="table-scroll"><table class="fa-table"><thead><tr><th class="l">Comparativo (todas as ferramentas)</th><th>Líquido</th><th>Vendas</th><th>Ticket médio</th><th>Reembolsos</th><th>Taxa de reembolso</th><th>Chargebacks</th></tr></thead><tbody>' +
      rows + "</tbody></table></div>" +
      (pj ? '<p class="fa-proj">Projeção de ' + esc(((P.mes_atual || {}).label || "").replace(/ \(.*/, "")) + " no ritmo atual: <b>" + brl(pj.liquido) + "</b> e " + int(pj.vendas) + " vendas" +
        (prevFull ? " (" + delta(pj.liquido, prevFull) + " sobre " + esc(((P.mes_anterior_fechado || {}).label || "").replace(/ \(.*/, "")) + " fechado)" : "") + ".</p>" : "") +
      '<p class="fa-foot">' + (f.notas || []).map(esc).join(" ") + "</p>";
  }

  function render() {
    var r = S.row, root = A.root;
    var head = '<div class="panel-head fa-head"><div><h3>Análise da IA</h3><p class="fa-sub">' +
      (r ? (r.source === "claude" ? "Escrita pelo Claude (tarefa agendada)" : r.source === "ai" ? "Escrita por " + esc(r.model || "IA") : "Só os números (sem IA)") + " em " + esc(when(r.created_at)) + " · o Claude reescreve todo dia antes das 8h" : "Ainda não há análise.") +
      '</p></div><button type="button" class="btn" data-fa="run"' + (S.busy ? " disabled" : "") + ' title="Recalcula os números agora; o texto é reescrito pela tarefa diária do Claude">' + (S.busy ? "Calculando…" : "↻ Atualizar números") + "</button></div>";
    if (!r) { root.innerHTML = head + '<p class="fa-empty">Clique em <b>Gerar análise agora</b> para a primeira análise.</p>'; return; }
    var body = "";
    if (r.text) {
      var html = prose(r.text);
      body = '<div class="fa-text">' + (S.open ? html : summary(html)) + "</div>" +
        '<button type="button" class="fa-more" data-fa="toggle">' + (S.open ? "Recolher análise" : "Ver análise completa") + "</button>" +
        (S.open ? '<details class="fa-nums"><summary>Números usados pela IA</summary>' + table(r.facts || {}) + "</details>" : "");
    } else {
      body = '<p class="fa-note">O texto da análise é escrito todo dia antes das 8h pela tarefa agendada do Claude (precisa do computador ligado com o app do Claude aberto). Enquanto isso, os números:</p>' + table(r.facts || {});
    }
    root.innerHTML = head + body;
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
    if (!data.ok) { A.toast("Não foi possível gerar a análise: " + (data.error || "erro desconhecido"), true); render(); return; }
    A.toast(data.source === "ai" ? "Análise atualizada." : "Números atualizados (" + (data.note || "sem IA") + ")");
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
    show: function () { A.root.hidden = false; if (!S.loaded) A.root.innerHTML = '<div class="panel-head"><h3>Análise da IA</h3></div><p class="fa-empty">Carregando…</p>'; return load(); }
  };
})();
