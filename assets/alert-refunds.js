/* Avisos → "Ver reembolsos e chargebacks": a lista por trás dos avisos de reembolso, pico de 24 h e chargeback.
   Dados: public.alert_refunds(de, até), pela data em que o reembolso/contestação aconteceu (mesma regra dos avisos).
   Abre dentro da tela Avisos (troca o conteúdo) e volta com "← Voltar aos avisos".
   Uso: AlertRefunds.open({ root, sb, toast, preset: "24h"|"mes"|"mes_passado"|"30d"|"90d", tipo: "todos"|"reembolso"|"chargeback", back: fn }) */
window.AlertRefunds = (function () {
  "use strict";
  var A = null, S = { rows: [], preset: "mes", tipo: "todos", tool: "", q: "", seq: 0 };
  var PRESETS = [["24h", "Últimas 24 h"], ["7d", "7 dias"], ["mes", "Este mês"], ["mes_passado", "Mês passado"], ["30d", "30 dias"], ["90d", "90 dias"]];
  var PAY = { credit_card: "Cartão", pix: "Pix", boleto: "Boleto", bank_slip: "Boleto", paypal: "PayPal" };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function brl(v) { return v == null || isNaN(v) ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v); }
  function dt(iso) { return iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"; }
  function day(iso) { return iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "—"; }
  function range(p) {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth();
    if (p === "24h") return [new Date(now - 864e5), now];
    if (p === "7d") return [new Date(now - 7 * 864e5), now];
    if (p === "30d") return [new Date(now - 30 * 864e5), now];
    if (p === "90d") return [new Date(now - 90 * 864e5), now];
    if (p === "mes_passado") return [new Date(y, m - 1, 1), new Date(y, m, 1)];
    return [new Date(y, m, 1), now];
  }
  function filtered() {
    var q = S.q.trim().toLowerCase();
    return S.rows.filter(function (r) {
      if (S.tipo !== "todos" && r.tipo !== S.tipo) return false;
      if (S.tool && r.ferramenta !== S.tool) return false;
      return !q || [r.cliente, r.email, r.produto, r.afiliado, r.ferramenta].join(" ").toLowerCase().indexOf(q) >= 0;
    });
  }

  /* ---------------- tela ---------------- */
  function shell() {
    A.root.innerHTML =
      '<div class="ar-top"><button type="button" class="btn btn-ghost ar-back" data-ar="back">← Voltar aos avisos</button>' +
        '<div><h3 class="ar-title">Reembolsos e chargebacks</h3><p class="ar-sub">Pela data em que o reembolso ou a contestação aconteceu, das ferramentas Flow. Os números batem com os avisos.</p></div>' +
        '<button type="button" class="btn ar-csv" data-ar="csv">Exportar CSV</button></div>' +
      '<div class="ar-filters"><div class="ar-chips" id="ar-period"></div><div class="ar-chips" id="ar-tipo"></div><div class="ar-chips" id="ar-tool"></div>' +
        '<input type="search" id="ar-q" placeholder="Buscar cliente, e-mail, produto ou afiliado…" aria-label="Buscar"></div>' +
      '<div id="ar-body"><div class="av-empty">Carregando…</div></div>';
    document.getElementById("ar-q").addEventListener("input", function (e) { S.q = e.target.value; renderBody(); });
  }
  function chips() {
    var c = function (kind, v, label, on, n) { return '<button type="button" class="pay-chip' + (on ? " on" : "") + '" data-ar-f="' + kind + '" data-v="' + esc(v) + '" aria-pressed="' + on + '">' + esc(label) + (n != null ? " <b>" + n + "</b>" : "") + "</button>"; };
    document.getElementById("ar-period").innerHTML = PRESETS.map(function (p) { return c("preset", p[0], p[1], S.preset === p[0]); }).join("");
    var nr = S.rows.filter(function (r) { return r.tipo === "reembolso"; }).length, nc = S.rows.length - nr;
    document.getElementById("ar-tipo").innerHTML = c("tipo", "todos", "Todos", S.tipo === "todos", S.rows.length) + c("tipo", "reembolso", "Reembolsos", S.tipo === "reembolso", nr) + c("tipo", "chargeback", "Chargebacks", S.tipo === "chargeback", nc);
    var tools = {};
    S.rows.forEach(function (r) { tools[r.ferramenta] = (tools[r.ferramenta] || 0) + 1; });
    document.getElementById("ar-tool").innerHTML = c("tool", "", "Todas as ferramentas", !S.tool) + Object.keys(tools).sort().map(function (t) { return c("tool", t, t, S.tool === t, tools[t]); }).join("");
  }

  function bars(title, sub, pairs, max) {
    if (!pairs.length) return "";
    return '<section class="ar-card"><div class="ar-card-h"><h4>' + esc(title) + "</h4><span>" + esc(sub) + "</span></div>" +
      pairs.map(function (p) {
        return '<div class="ar-bar"><span class="ar-bar-l">' + esc(p[0]) + '</span><span class="ar-bar-t"><i style="width:' + (p[1] / max * 100).toFixed(1) + '%"></i></span><b>' + p[1] + "</b></div>";
      }).join("") + "</section>";
  }

  function renderBody() {
    var list = filtered(), body = document.getElementById("ar-body");
    if (!body) return;
    if (!S.rows.length) { body.innerHTML = '<div class="av-empty">Nenhum reembolso ou chargeback nesse período.</div>'; return; }
    var ref = list.filter(function (r) { return r.tipo === "reembolso"; }), cb = list.filter(function (r) { return r.tipo === "chargeback"; });
    var sum = function (a) { return a.reduce(function (t, r) { return t + (+r.valor || 0); }, 0); };
    var days = list.map(function (r) { return +r.dias_ate_reembolso; }).filter(function (x) { return !isNaN(x); }).sort(function (a, b) { return a - b; });
    var median = days.length ? days[Math.floor(days.length / 2)] : null;
    var within7 = days.filter(function (d) { return d <= 7; }).length;

    // Agrupamentos: dia da venda (mostra concentração, ex.: vendas de um mesmo dia), ferramenta e afiliado.
    var group = function (key) {
      var g = {};
      list.forEach(function (r) { var k = key(r); if (k) g[k] = (g[k] || 0) + 1; });
      return Object.keys(g).map(function (k) { return [k, g[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    };
    var bySale = group(function (r) { return r.venda_em ? day(r.venda_em) : ""; }).slice(0, 8);
    var byTool = group(function (r) { return r.ferramenta; });
    var byAff = group(function (r) { return r.afiliado || "Venda direta (sem afiliado)"; }).slice(0, 6);
    var maxOf = function (a) { return Math.max.apply(null, a.map(function (x) { return x[1]; }).concat([1])); };

    var top = bySale[0] && list.length >= 4 && bySale[0][1] / list.length >= 0.3
      ? '<div class="ar-alert">⚠ ' + bySale[0][1] + " de " + list.length + " (" + Math.round(bySale[0][1] / list.length * 100) + "%) são de vendas feitas em <b>" + esc(bySale[0][0]) + "</b>. Vale ver o que aconteceu nesse dia (campanha, oferta, cobrança).</div>" : "";

    body.innerHTML =
      '<div class="av-kpis ar-kpis">' +
        kpi("Reembolsos", ref.length, brl(sum(ref)) + " devolvidos", "warning") +
        kpi("Chargebacks", cb.length, brl(sum(cb)) + " contestados", "critical") +
        kpi("Tempo até o reembolso", median == null ? "—" : String(median).replace(".", ",") + " dias", "mediana entre a venda e o reembolso", "") +
        kpi("Dentro de 7 dias", days.length ? Math.round(within7 / days.length * 100) + "%" : "—", "dos casos (prazo de garantia)", "") +
      "</div>" + top +
      '<div class="ar-grid">' + bars("Por dia da venda", "quando a venda reembolsada foi feita", bySale, maxOf(bySale)) +
        bars("Por ferramenta", "", byTool, maxOf(byTool)) + bars("Por afiliado", "quem trouxe a venda", byAff, maxOf(byAff)) + "</div>" +
      '<section class="ar-card"><div class="ar-card-h"><h4>Casos</h4><span>' + list.length + " de " + S.rows.length + "</span></div>" +
      '<div class="table-scroll"><table class="ar-table"><thead><tr><th class="l">Quando</th><th class="l">Tipo</th><th class="l">Ferramenta / produto</th><th class="l">Cliente</th><th>Valor</th><th class="l">Pagamento</th><th class="l">Venda</th><th class="l">Afiliado</th></tr></thead><tbody>' +
      (list.length ? list.map(function (r) {
        return "<tr><td class=\"l\">" + esc(dt(r.quando)) + '</td><td class="l"><span class="ar-tag ' + (r.tipo === "chargeback" ? "cb" : "") + '">' + (r.tipo === "chargeback" ? "Chargeback" : "Reembolso") + "</span></td>" +
          '<td class="l"><b>' + esc(r.ferramenta) + "</b><small>" + esc(r.produto) + "</small></td>" +
          '<td class="l">' + esc(r.cliente || "—") + "<small>" + esc(r.email || "") + "</small></td>" +
          "<td>" + brl(r.valor) + "</td><td class=\"l\">" + esc(PAY[r.pagamento] || r.pagamento || "—") + "</td>" +
          '<td class="l">' + esc(day(r.venda_em)) + (r.dias_ate_reembolso != null ? "<small>" + String(r.dias_ate_reembolso).replace(".", ",") + " dias antes</small>" : "") + "</td>" +
          '<td class="l">' + esc(r.afiliado || "—") + "</td></tr>";
      }).join("") : '<tr><td colspan="8" class="empty">Nada com esses filtros.</td></tr>') +
      "</tbody></table></div></section>";
  }
  function kpi(label, v, sub, cls) {
    return '<div class="kpi av-kpi ' + cls + '"><div class="label">' + esc(label) + '</div><div class="value num">' + esc(v) + '</div><div class="sub">' + esc(sub) + "</div></div>";
  }

  async function load() {
    var seq = ++S.seq, r = range(S.preset);
    document.getElementById("ar-body").innerHTML = '<div class="av-empty">Carregando…</div>';
    var res = await A.sb.rpc("alert_refunds", { p_from: r[0].toISOString(), p_to: r[1].toISOString() });
    if (seq !== S.seq) return;
    if (res.error) { A.toast("Erro ao ler os reembolsos: " + res.error.message, true); S.rows = []; }
    else S.rows = res.data || [];
    if (S.tool && !S.rows.some(function (x) { return x.ferramenta === S.tool; })) S.tool = "";
    chips(); renderBody();
  }
  function csv() {
    var list = filtered(), q = function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; };
    var lines = [["quando", "tipo", "ferramenta", "produto", "cliente", "email", "valor", "pagamento", "venda_em", "dias_ate_reembolso", "afiliado"].join(";")]
      .concat(list.map(function (r) { return [dt(r.quando), r.tipo, r.ferramenta, r.produto, r.cliente, r.email, String(r.valor).replace(".", ","), PAY[r.pagamento] || r.pagamento, dt(r.venda_em), String(r.dias_ate_reembolso).replace(".", ","), r.afiliado].map(q).join(";"); }));
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    a.download = "reembolsos-chargebacks-" + S.preset + ".csv";
    a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function onClick(e) {
    var b = e.target.closest("[data-ar]");
    if (b && b.dataset.ar === "back") { A.root.removeEventListener("click", onClick); A.back(); return; }
    if (b && b.dataset.ar === "csv") { csv(); return; }
    var f = e.target.closest("[data-ar-f]");
    if (!f) return;
    var kind = f.dataset.arF, v = f.dataset.v;
    if (kind === "preset") { S.preset = v; load(); }
    else { S[kind] = v; chips(); renderBody(); }
  }

  return {
    open: function (opts) {
      A = opts; S.preset = opts.preset || "mes"; S.tipo = opts.tipo || "todos"; S.tool = ""; S.q = ""; S.rows = [];
      shell(); chips();
      A.root.addEventListener("click", onClick);
      window.scrollTo(0, 0);
      return load();
    }
  };
})();
