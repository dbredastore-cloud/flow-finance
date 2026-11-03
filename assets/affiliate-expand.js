// Ficha expandida do afiliado (Parceiros › Afiliados): vendas de cada mês por ferramenta, análise do mês
// fechado contra o anterior e uma mensagem pronta para o operador copiar e mandar ao influencer.
// Dados: rpc affiliate_tool_months (todo o histórico, não só o período filtrado na tela).
// A análise é montada aqui a partir dos números, sem API: os textos mudam conforme crescimento, queda,
// estabilidade e meses sem venda. Nada é enviado; a mensagem só é gerada para copiar.
window.AffiliateExpand = (function () {
  "use strict";

  var TOOLS = [
    // since = mês da primeira venda da ferramenta por afiliados; antes disso ela não entra na mensagem.
    { slug: "flowpages", label: "Flow Pages", cls: "fp", since: "2025-06" },
    { slug: "flowtracking", label: "Flow Tracking", cls: "ft", since: "2025-10" },
    { slug: "flowspy", label: "Flow Spy", cls: "fs", since: "2026-07" }
  ];
  var MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  var MONTHS_LONG = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

  var S = null; // { sb, email, name, el, months: [...], sel: "YYYY-MM", edited: false }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmtInt(v) { return new Intl.NumberFormat("pt-BR").format(Math.round(v || 0)); }
  function fmtBRL(v) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0); }
  function fmtPct(v) { return (Math.abs(v) < 10 && Math.round(v) !== v ? Math.abs(v).toFixed(1) : String(Math.round(Math.abs(v)))).replace(".", ",") + "%"; }
  function plural(n, one, many) { return fmtInt(n) + " " + (n === 1 ? one : many); }
  function vendas(n) { return plural(n, "venda", "vendas"); }
  function ymOf(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
  function ymParts(ym) { var p = ym.split("-"); return { y: +p[0], m: +p[1] }; }
  function ymShort(ym) { var p = ymParts(ym); return MONTHS[p.m - 1] + "/" + String(p.y).slice(2); }
  function ymLong(ym) { return MONTHS_LONG[ymParts(ym).m - 1]; }
  function ymLongYear(ym) { var p = ymParts(ym); return MONTHS_LONG[p.m - 1] + " de " + p.y; }
  function ymAdd(ym, n) { var p = ymParts(ym); return ymOf(new Date(p.y, p.m - 1 + n, 1)); }
  function nowYm() { return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(0, 7); }
  function firstName(n) { var f = String(n || "").trim().split(/\s+/)[0] || ""; return f ? f.charAt(0).toUpperCase() + f.slice(1).toLowerCase() : ""; }
  // Variação de b (anterior) para a (atual), em %. null quando não dá para calcular (anterior zerado).
  function change(a, b) { return b > 0 ? ((a - b) / b) * 100 : null; }
  function joinList(arr) { return arr.length <= 1 ? arr.join("") : arr.slice(0, -1).join(", ") + " e " + arr[arr.length - 1]; }

  function emptyMonth(ym) {
    var m = { ym: ym, total: 0, refunds: 0, amount: 0, commission: 0, by: {} };
    TOOLS.forEach(function (t) { m.by[t.slug] = 0; });
    return m;
  }
  // Do primeiro mês com venda até o mês atual, com os meses sem venda zerados.
  function buildMonths(rows) {
    var cur = nowYm(), map = {};
    rows.forEach(function (r) {
      var m = map[r.ym] || (map[r.ym] = emptyMonth(r.ym));
      m.by[r.tool] = (m.by[r.tool] || 0) + (r.vendas || 0);
      m.total += r.vendas || 0;
      m.refunds += r.reembolsos || 0;
      m.amount += Number(r.faturamento) || 0;
      m.commission += Number(r.comissao) || 0;
    });
    var keys = Object.keys(map).sort();
    if (!keys.length) return [];
    var out = [], ym = keys[0] < cur ? keys[0] : cur;
    while (ym <= cur) { out.push(map[ym] || emptyMonth(ym)); ym = ymAdd(ym, 1); }
    return out;
  }
  function monthOf(ym) {
    for (var i = 0; i < S.months.length; i++) if (S.months[i].ym === ym) return S.months[i];
    return emptyMonth(ym);
  }
  // Ferramentas com mais vendas no mês (mais de uma em caso de empate). [] se o mês não teve venda.
  function topTools(m) {
    var max = Math.max.apply(null, TOOLS.map(function (t) { return m.by[t.slug]; }));
    return max > 0 ? TOOLS.filter(function (t) { return m.by[t.slug] === max; }) : [];
  }
  function toolsLine(m) {
    return joinList(TOOLS.map(function (t) { return fmtInt(m.by[t.slug]) + " de " + t.label; }));
  }

  /* ---------------- análise ---------------- */
  function analysis(cur, prev) {
    var items = [], d = change(cur.total, prev.total), diff = cur.total - prev.total;
    var curL = ymLong(cur.ym), prevL = ymLong(prev.ym);
    // Total do mês contra o anterior
    if (!cur.total && !prev.total) items.push({ k: "flat", t: "Sem vendas de ferramentas Flow em " + curL + " nem em " + prevL + "." });
    else if (!prev.total) items.push({ k: "up", t: "Voltou a vender: " + vendas(cur.total) + " em " + curL + ", depois de " + prevL + " sem nenhuma venda." });
    else if (!cur.total) items.push({ k: "down", t: "Queda total: nenhuma venda em " + curL + ", contra " + vendas(prev.total) + " em " + prevL + "." });
    else if (!diff) items.push({ k: "flat", t: "Estável: " + vendas(cur.total) + " em " + curL + ", o mesmo número de " + prevL + "." });
    else items.push({ k: diff > 0 ? "up" : "down", t: (diff > 0 ? "Crescimento" : "Queda") + " de " + fmtPct(d) + " de " + prevL + " para " + curL + ": " +
      fmtInt(prev.total) + " → " + vendas(cur.total) + " (" + (diff > 0 ? "+" : "−") + fmtInt(Math.abs(diff)) + ")." });
    // Por ferramenta
    var per = TOOLS.filter(function (t) { return cur.by[t.slug] || prev.by[t.slug]; }).map(function (t) {
      var a = cur.by[t.slug], b = prev.by[t.slug], dd = a - b;
      return "<b>" + esc(t.label) + "</b> " + fmtInt(b) + " → " + fmtInt(a) +
        (dd ? ' <span class="' + (dd > 0 ? "up" : "down") + '">' + (dd > 0 ? "+" : "−") + fmtInt(Math.abs(dd)) + (b ? " (" + (dd > 0 ? "+" : "−") + fmtPct(change(a, b)) + ")" : "") + "</span>" : ' <span class="muted">igual</span>');
    });
    if (per.length) items.push({ k: "tools", h: "Por ferramenta: " + per.join(" · ") });
    // Mais vendida no mês e no histórico
    var top = topTools(cur);
    if (top.length === 1) items.push({ k: "top", t: "Mais vendida em " + curL + ": " + top[0].label + ", com " + vendas(cur.by[top[0].slug]) + " (" + fmtPct(cur.by[top[0].slug] / cur.total * 100) + " do mês)." });
    else if (top.length > 1) items.push({ k: "top", t: "Empate entre " + joinList(top.map(function (t) { return t.label; })) + " em " + curL + ", com " + vendas(cur.by[top[0].slug]) + " cada." });
    var all = emptyMonth("all");
    S.months.forEach(function (m) { TOOLS.forEach(function (t) { all.by[t.slug] += m.by[t.slug]; }); all.total += m.total; });
    var topAll = topTools(all);
    if (topAll.length) items.push({ k: "top", t: "No histórico (" + vendas(all.total) + " desde " + ymShort(S.months[0].ym) + "), a ferramenta mais vendida é " +
      joinList(topAll.map(function (t) { return t.label; })) + " (" + fmtPct(all.by[topAll[0].slug] / all.total * 100) + ")." });
    // Média dos 3 meses antes do mês analisado
    var back = [1, 2, 3].map(function (i) { return monthOf(ymAdd(cur.ym, -i)); }).filter(function (m) { return m.ym >= S.months[0].ym; });
    if (back.length >= 2) {
      var avg = back.reduce(function (s, m) { return s + m.total; }, 0) / back.length;
      if (avg > 0) {
        var da = change(cur.total, avg);
        items.push({ k: Math.abs(da) < 5 ? "flat" : da > 0 ? "up" : "down", t: "Média dos " + back.length + " meses anteriores: " + String(avg.toFixed(1)).replace(".", ",").replace(",0", "") + " vendas/mês; " +
          curL + " ficou " + (Math.abs(da) < 5 ? "na média" : fmtPct(da) + (da > 0 ? " acima" : " abaixo")) + "." });
      }
    }
    if (cur.total) items.push({ k: "money", t: "Faturamento " + fmtBRL(cur.amount) + " e comissão " + fmtBRL(cur.commission) + " em " + curL +
      (cur.refunds ? "; " + plural(cur.refunds, "venda do mês foi reembolsada", "vendas do mês foram reembolsadas") : "") + "." });
    // Mês atual ainda aberto
    var now = monthOf(nowYm());
    if (now.ym > cur.ym && now.ym === ymAdd(cur.ym, 1)) {
      var day = +new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(8, 10);
      items.push({ k: "now", t: "Em " + ymLong(now.ym) + " (até o dia " + day + "): " + vendas(now.total) + (now.total ? " — " + toolsLine(now) : "") + "." });
    }
    return items;
  }

  /* ---------------- mensagem ---------------- */
  // Texto formal em parágrafos, pronto para colar no WhatsApp (*negrito* vira negrito lá).
  // Estrutura: saudação · resumo do mês por ferramenta contra o anterior · comissão · destaques · fechamento
  // conforme o cenário (crescimento, queda, estável, retomada, mês sem venda).
  function message(cur, prev) {
    var name = firstName(S.name), curL = ymLong(cur.ym), curLY = ymLongYear(cur.ym), prevL = ymLong(prev.ym), nextL = ymLong(ymAdd(cur.ym, 1));
    var diff = cur.total - prev.total, d = change(cur.total, prev.total);
    var p = [];
    p.push("Olá" + (name ? ", " + name : "") + "! Tudo bem?");
    p.push("Segue o resumo dos seus resultados com as ferramentas Flow em *" + curLY + "*, comparado com " + prevL + ":");

    var live = TOOLS.filter(function (t) { return cur.ym >= t.since || cur.by[t.slug] || prev.by[t.slug]; });
    var lines = live.map(function (t) { return "• " + t.label + ": " + vendas(cur.by[t.slug]) + " (" + prevL + ": " + fmtInt(prev.by[t.slug]) + ")"; });
    var totalTxt = "*Total: " + vendas(cur.total) + "*";
    if (!cur.total && !prev.total) totalTxt += ", assim como em " + prevL + ".";
    else if (!prev.total) totalTxt += ", contra nenhuma venda em " + prevL + ".";
    else if (!cur.total) totalTxt += ", contra " + vendas(prev.total) + " em " + prevL + ".";
    else if (!diff) totalTxt += ", o mesmo resultado de " + prevL + ".";
    else totalTxt += ", contra " + fmtInt(prev.total) + " em " + prevL + " — " + (diff > 0 ? "crescimento" : "queda") + " de " + fmtPct(d) + ".";
    p.push("*Vendas no mês*\n" + lines.join("\n") + "\n" + totalTxt);

    if (cur.total || prev.total)
      p.push("*Comissão*\nSua comissão em " + curL + " foi de " + fmtBRL(cur.commission) + (prev.total ? " (" + prevL + ": " + fmtBRL(prev.commission) + ")" : "") + ".");

    var hl = [], top = topTools(cur);
    if (top.length === 1 && cur.total && cur.by[top[0].slug] === cur.total) hl.push("Todas as suas vendas no mês foram do " + top[0].label + ".");
    else if (top.length === 1 && cur.total) hl.push("A ferramenta mais vendida no mês foi o " + top[0].label + ", com " + fmtPct(cur.by[top[0].slug] / cur.total * 100) + " das suas vendas.");
    else if (top.length > 1) hl.push(joinList(top.map(function (t) { return t.label; })) + " empataram como as mais vendidas do mês.");
    TOOLS.forEach(function (t) {
      var a = cur.by[t.slug], b = prev.by[t.slug];
      if (a && b && a !== b && Math.abs(a - b) >= 2) hl.push("O " + t.label + " " + (a > b ? "cresceu" : "caiu") + " de " + fmtInt(b) + " para " + vendas(a) + " (" + (a > b ? "+" : "−") + fmtPct(change(a, b)) + ").");
    });
    var back = [1, 2, 3].map(function (i) { return monthOf(ymAdd(cur.ym, -i)); }).filter(function (m) { return m.ym >= S.months[0].ym; });
    var avg = back.length >= 2 ? back.reduce(function (s, m) { return s + m.total; }, 0) / back.length : 0;
    if (avg > 0 && cur.total) {
      var da = change(cur.total, avg), avgTxt = String(avg.toFixed(1)).replace(".", ",").replace(/,0$/, "");
      hl.push(Math.abs(da) < 5 ? curL.charAt(0).toUpperCase() + curL.slice(1) + " ficou dentro da sua média dos últimos " + back.length + " meses (" + avgTxt + " vendas/mês)."
        : curL.charAt(0).toUpperCase() + curL.slice(1) + " ficou " + fmtPct(da) + (da > 0 ? " acima" : " abaixo") + " da sua média dos últimos " + back.length + " meses (" + avgTxt + " vendas/mês).");
    }
    var zero = cur.total ? live.filter(function (t) { return !cur.by[t.slug]; }) : [];
    if (zero.length && zero.length < live.length)
      hl.push(joinList(zero.map(function (t) { return "o " + t.label; })).replace(/^o /, "O ") + (zero.length > 1 ? " não tiveram" : " não teve") + " vendas no mês — pode ser uma boa oportunidade de conteúdo.");
    if (hl.length) p.push("*Destaques*\n" + hl.map(function (x) { return "• " + x; }).join("\n"));

    var end;
    if (!cur.total && !prev.total)
      end = "Não registramos vendas pelo seu link em " + curL + " nem em " + prevL + ". Gostaríamos de entender como podemos te apoiar: se quiser, podemos planejar juntos conteúdos sobre o Flow Pages, o Flow Tracking ou o Flow Spy para " + nextL + ".";
    else if (!cur.total)
      end = "Em " + curL + " não registramos vendas pelo seu link. Se quiser, podemos analisar juntos os conteúdos do período e definir ações para retomar o ritmo de " + prevL + " já em " + nextL + ".";
    else if (!prev.total)
      end = "Depois de " + prevL + " sem vendas, " + curL + " marcou uma ótima retomada. Parabéns! Vamos manter esse ritmo em " + nextL + ".";
    else if (!diff)
      end = "Suas vendas se mantiveram estáveis em relação a " + prevL + ". Se quiser, podemos pensar juntos em ações para crescer em " + nextL + ".";
    else if (diff > 0)
      end = "Parabéns pelo resultado! O crescimento mostra que o seu conteúdo está convertendo bem. Vamos manter esse ritmo em " + nextL + ".";
    else
      end = "Houve uma redução de " + fmtPct(d) + " em relação a " + prevL + ". Se quiser, podemos analisar juntos os conteúdos do mês e definir ações para retomar o crescimento em " + nextL + ".";
    p.push(end + "\n\nQualquer dúvida, estamos à disposição.");
    p.push("Abraço,\nEquipe Flow");
    return p.join("\n\n");
  }

  /* ---------------- render ---------------- */
  function chart() {
    var list = S.months.slice(-12), W = 640, H = 190, mg = { l: 28, r: 6, t: 12, b: 22 }, iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    var max = Math.max.apply(null, list.map(function (m) { return m.total; }).concat([1])), bw = iw / list.length, cur = nowYm();
    var step = max <= 5 ? 1 : max <= 12 ? 2 : max <= 30 ? 5 : max <= 60 ? 10 : Math.ceil(max / 5 / 10) * 10;
    var top = Math.ceil(max / step) * step, svg = "";
    for (var g = 0; g <= top; g += step) {
      var gy = mg.t + ih - (g / top) * ih;
      svg += '<line class="ax-grid" x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + gy + '" y2="' + gy + '"/><text class="ax-t" x="' + (mg.l - 5) + '" y="' + (gy + 3.5) + '" text-anchor="end">' + g + "</text>";
    }
    list.forEach(function (m, i) {
      var x = mg.l + i * bw + bw * 0.18, w = bw * 0.64, y = mg.t + ih;
      TOOLS.forEach(function (t) {
        var v = m.by[t.slug];
        if (!v) return;
        var h = (v / top) * ih; y -= h;
        svg += '<rect class="bar ' + t.cls + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '"><title>' + esc(ymShort(m.ym) + " · " + t.label + ": " + vendas(v)) + "</title></rect>";
      });
      if (m.total) svg += '<text class="ax-v" x="' + (x + w / 2).toFixed(1) + '" y="' + (y - 3).toFixed(1) + '" text-anchor="middle">' + m.total + "</text>";
      svg += '<text class="ax-t' + (m.ym === S.sel ? " sel" : "") + '" x="' + (x + w / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + ymShort(m.ym) + (m.ym === cur ? "*" : "") + "</text>";
    });
    return '<svg class="ax-chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Vendas por mês e ferramenta">' + svg + "</svg>" +
      '<div class="ax-legend">' + TOOLS.map(function (t) { return '<span><i class="' + t.cls + '"></i>' + t.label + "</span>"; }).join("") + '<span class="muted">* mês em andamento</span></div>';
  }
  function table() {
    var cur = nowYm();
    var rows = S.months.slice().reverse().map(function (m) {
      var prev = monthOf(ymAdd(m.ym, -1)), d = m.ym > S.months[0].ym ? change(m.total, prev.total) : null;
      var dTxt = m.ym === S.months[0].ym || m.ym === cur ? '<span class="muted">—</span>' : d == null ? (m.total ? '<span class="up">novo</span>' : '<span class="muted">—</span>')
        : !d ? '<span class="muted">0%</span>' : '<span class="' + (d > 0 ? "up" : "down") + '">' + (d > 0 ? "+" : "−") + fmtPct(d) + "</span>";
      return '<tr class="' + (m.ym === S.sel ? "ax-sel" : "") + '"><td class="l">' + esc(ymShort(m.ym)) + (m.ym === cur ? ' <span class="muted">(em andamento)</span>' : "") + "</td>" +
        TOOLS.map(function (t) { return '<td class="num">' + (m.by[t.slug] ? fmtInt(m.by[t.slug]) : '<span class="muted">0</span>') + "</td>"; }).join("") +
        '<td class="num"><b>' + fmtInt(m.total) + '</b></td><td class="num">' + dTxt + '</td><td class="num">' + fmtBRL(m.amount) + '</td><td class="num">' + fmtBRL(m.commission) +
        '</td><td class="num">' + (m.refunds ? fmtInt(m.refunds) : '<span class="muted">0</span>') + "</td></tr>";
    }).join("");
    return '<div class="table-scroll"><table class="ax-table"><thead><tr><th class="l">Mês</th>' + TOOLS.map(function (t) { return "<th>" + t.label + "</th>"; }).join("") +
      '<th>Total</th><th title="Variação do total de vendas contra o mês anterior">vs. mês ant.</th><th>Faturamento</th><th>Comissão</th><th title="Vendas do mês que hoje estão reembolsadas ou com chargeback">Reembolsos</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
  }
  function closedMonths() { var c = nowYm(); return S.months.filter(function (m) { return m.ym < c; }).map(function (m) { return m.ym; }).reverse(); }

  function render() {
    var el = S.el;
    if (!S.months.length) {
      el.innerHTML = "<h4>Vendas por mês e ferramenta</h4>" + '<p class="muted ax-empty">Este afiliado ainda não tem vendas de Flow Pages, Flow Tracking ou Flow Spy.</p>';
      return;
    }
    var closed = closedMonths();
    if (!closed.length) { closed = [nowYm()]; }
    if (closed.indexOf(S.sel) < 0) S.sel = closed[0];
    var cur = monthOf(S.sel), prev = monthOf(ymAdd(S.sel, -1));
    var items = analysis(cur, prev);
    el.innerHTML =
      '<div class="ax-head"><h4>Vendas por mês e ferramenta</h4><label class="ax-pick">Mês analisado <select id="ax-month">' +
        closed.map(function (ym) { return '<option value="' + ym + '"' + (ym === S.sel ? " selected" : "") + ">" + esc(ymLongYear(ym)) + (ym === nowYm() ? " (em andamento)" : "") + "</option>"; }).join("") +
      "</select></label></div>" +
      chart() + table() +
      '<div class="ax-ai"><h4>Análise da IA <small class="muted">' + esc(ymLongYear(cur.ym)) + " vs. " + esc(ymLongYear(prev.ym)) + "</small></h4><ul>" +
        items.map(function (it) { return '<li class="' + it.k + '">' + (it.h || esc(it.t)) + "</li>"; }).join("") +
      '</ul><p class="muted ax-note">Gerada a partir dos números da tabela (vendas pagas ou aprovadas, pela data da venda).</p></div>' +
      '<div class="ax-msg"><h4>Mensagem para o influencer</h4>' +
        '<textarea id="ax-text" rows="18" aria-label="Mensagem para o influencer"></textarea>' +
        '<div class="ax-msg-acts"><button class="btn btn-primary btn-sm" type="button" id="ax-copy">Copiar mensagem</button>' +
        '<button class="btn btn-sm" type="button" id="ax-reset" title="Descarta as edições e gera o texto de novo com os números">Gerar de novo</button>' +
        '<span class="muted">Edite à vontade antes de copiar. Nada é enviado daqui.</span></div></div>';
    var ta = el.querySelector("#ax-text");
    ta.value = message(cur, prev);
    el.querySelector("#ax-month").addEventListener("change", function (e) { S.sel = e.target.value; render(); });
    el.querySelector("#ax-reset").addEventListener("click", function () { ta.value = message(monthOf(S.sel), monthOf(ymAdd(S.sel, -1))); });
    el.querySelector("#ax-copy").addEventListener("click", function () { copy(ta.value, el.querySelector("#ax-copy")); });
  }
  function copy(text, btn) {
    function done() { btn.textContent = "Copiado ✓"; setTimeout(function () { btn.textContent = "Copiar mensagem"; }, 1800); }
    function fallback() {
      var ta = document.getElementById("ax-text");
      ta.focus(); ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      if (ok) done(); else btn.textContent = "Texto selecionado: Ctrl+C";
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  // Monta a seção dentro de el. opts: { sb, email, name }
  async function mount(el, opts) {
    S = { sb: opts.sb, email: opts.email, name: opts.name, el: el, months: [], sel: null };
    var mine = S;
    el.innerHTML = '<h4>Vendas por mês e ferramenta</h4><p class="muted ax-empty">Carregando o histórico…</p>';
    var res = await opts.sb.rpc("affiliate_tool_months", { p_email: opts.email });
    if (S !== mine) return; // outra ficha foi aberta enquanto carregava
    if (res.error) { el.innerHTML = '<h4>Vendas por mês e ferramenta</h4><p class="ax-empty err">Erro ao carregar: ' + esc(res.error.message) + "</p>"; return; }
    S.months = buildMonths(res.data || []);
    render();
  }

  return { mount: mount };
})();
