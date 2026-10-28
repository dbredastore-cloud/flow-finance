/* Insights da IA no topo de cada menu (Financeiro e Afiliados).
   Um texto curto por tela (tabela menu_insights, o mais recente de cada chave), escrito todo dia pela tarefa agendada
   do Claude "Análise e Avisos FlowFinance". Um único bloco fica entre o título e as telas e troca de conteúdo junto com
   o menu. Sem texto para a tela, o bloco some. Recolher/abrir fica guardado no navegador.
   Uso: AiInsights.init({ root, sb }); AiInsights.show("fin.clients"); AiInsights.show(null) esconde. */
window.AiInsights = (function () {
  "use strict";
  var A = null, cache = {}, fetched = {}, cur = null, seq = 0;
  var KEY_COLLAPSED = "flow_aii_collapsed";

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso), h = (Date.now() - d) / 3600e3;
    return h < 20 ? "hoje, " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }
  function rich(s) {
    return esc(s)
      .replace(/(-?R\$\s?-?[\d.]+(?:,\d{1,2})?(?:\s?(?:mil|mi))?)/g, '<b class="aii-money">$1</b>')
      .replace(/([+\-−]?\d+(?:,\d+)?%)/g, function (m) { return '<span class="aii-num ' + (/^[+]/.test(m) ? "up" : /^[-−]/.test(m) ? "down" : "") + '">' + m + "</span>"; });
  }
  function collapsed() { try { return localStorage.getItem(KEY_COLLAPSED) === "1"; } catch (e) { return false; } }
  function setCollapsed(v) { try { localStorage.setItem(KEY_COLLAPSED, v ? "1" : "0"); } catch (e) {} }

  // Primeira linha sem "•" vira a manchete; as linhas com "•" viram a lista. "AÇÃO:" no começo destaca a sugestão.
  function body(text) {
    var head = "", items = [];
    String(text || "").split(/\r?\n/).forEach(function (raw) {
      var l = raw.trim(); if (!l) return;
      if (/^[•\-–]/.test(l)) items.push(l.replace(/^[•\-–]\s*/, ""));
      else if (!head && !items.length) head = l;
      else items.push(l);
    });
    return (head ? '<p class="aii-head">' + rich(head) + "</p>" : "") +
      (items.length ? "<ul>" + items.map(function (t) {
        var act = /^(ação|sugestão|fazer)\s*:/i.test(t);
        return '<li class="' + (act ? "act" : "") + '">' + rich(act ? t.replace(/^(ação|sugestão|fazer)\s*:\s*/i, "") : t) + "</li>";
      }).join("") + "</ul>" : "");
  }

  function render(row) {
    var root = A.root;
    if (!row) { root.hidden = true; root.innerHTML = ""; return; }
    var c = collapsed();
    root.hidden = false;
    root.className = "aii" + (c ? " collapsed" : "");
    root.innerHTML = '<button type="button" class="aii-top" data-aii="toggle" aria-expanded="' + !c + '">' +
      '<span class="aii-spark" aria-hidden="true">✦</span><span class="aii-t">Insights da IA</span>' +
      '<span class="aii-when">escritos pelo Claude · ' + esc(when(row.created_at)) + "</span>" +
      '<span class="aii-chev">' + (c ? "Abrir ▾" : "Recolher ▴") + "</span></button>" +
      (c ? "" : '<div class="aii-body">' + body(row.text) + "</div>");
  }

  async function show(key) {
    cur = key || null;
    if (!A) return;
    if (!cur) { render(null); return; }
    if (cache[cur] !== undefined) {
      render(cache[cur]);
      if (Date.now() - (fetched[cur] || 0) < 5 * 60e3) return; // o texto muda uma vez por dia: não relê a cada clique
    }
    var mine = ++seq;
    fetched[cur] = Date.now();
    var r = await A.sb.from("menu_insights").select("key, text, created_at").eq("key", cur).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (mine !== seq) return;
    cache[cur] = r.error ? null : (r.data || null);
    render(cache[cur]);
  }

  return {
    init: function (deps) {
      A = deps;
      A.root.addEventListener("click", function (e) {
        if (!e.target.closest("[data-aii=toggle]")) return;
        setCollapsed(!collapsed());
        render(cache[cur] || null);
      });
    },
    show: show
  };
})();
