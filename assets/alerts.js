/* Avisos: o que está acontecendo no negócio (faturamento, reembolsos, afiliados, influencers, Instagram, sincronizações).
   Dados: public.alerts (regras SQL em generate_alerts, a cada 30 min pelo pg_cron) e public.alert_digests (resumo da IA,
   Edge Function alerts-digest, todo dia às 8h com envio no Telegram). Menu fin.avisos.
   Usa o kit visual do painel (flow-theme.css) e as classes de alerts.css. */
window.FlowAlerts = (function () {
  "use strict";
  var A = null, S = { alerts: [], digest: null, cat: "all", showSeen: true, busy: false, loaded: false };
  var CATS = [
    ["faturamento", "Faturamento"], ["reembolsos", "Reembolsos"], ["afiliados", "Afiliados"],
    ["influencers", "Influencers"], ["instagram", "Instagram"], ["sistema", "Sistema"]
  ];
  var SEV = { critical: ["Crítico", 0], warning: ["Atenção", 1], good: ["Bom", 2], info: ["Info", 3] };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function when(iso) { return iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"; }
  function catLabel(c) { var x = CATS.filter(function (k) { return k[0] === c; })[0]; return x ? x[1] : c; }

  /* ---------------- tela ---------------- */
  function render() {
    var root = A.root;
    var open = S.alerts;
    var count = function (sev) { return open.filter(function (a) { return a.severity === sev; }).length; };
    var unseen = open.filter(function (a) { return !a.seen_at; }).length;

    var head = '<div class="av-head"><div><div class="av-sub">Regras recalculadas a cada 30 minutos com os dados da Kiwify, dos contratos e do Instagram. ' +
      'O resumo da IA sai todo dia às 8h e vai também para o Telegram.</div></div>' +
      '<div class="av-acts"><button class="btn" type="button" data-av="refresh">↻ Recalcular agora</button>' +
      '<button class="btn btn-primary" type="button" data-av="digest">Gerar resumo da IA</button></div></div>';

    var kpis = '<div class="av-kpis">' +
      kpi("Críticos", count("critical"), "critical") + kpi("Atenção", count("warning"), "warning") +
      kpi("Boas notícias", count("good"), "good") + kpi("Não vistos", unseen, "") + "</div>";

    var dg = S.digest;
    var digest = '<section class="panel av-digest"><header class="av-ph"><div><h3>Resumo da IA</h3><p>' +
      (dg ? (dg.source === "ai" ? "Escrito por " + esc(dg.model || "IA") : "Montado pelas regras (sem IA)") + " em " + esc(when(dg.created_at)) +
        (dg.telegram ? " · enviado no Telegram" : "") : "Ainda não há resumo.") + "</p></div></header>" +
      (dg ? '<div class="av-digest-t">' + esc(dg.text) + "</div>" + (dg.note ? '<div class="av-note">' + esc(dg.note) + "</div>" : "") :
        '<div class="av-note">Clique em <b>Gerar resumo da IA</b> para criar o primeiro.</div>') + "</section>";

    var chips = '<div class="av-filters">' + chip("all", "Todos", open.length) +
      CATS.map(function (c) { var n = open.filter(function (a) { return a.category === c[0]; }).length; return n ? chip(c[0], c[1], n) : ""; }).join("") +
      '<label class="av-toggle"><input type="checkbox" data-av="seen"' + (S.showSeen ? " checked" : "") + "> Mostrar já vistos</label></div>";

    var list = open.filter(function (a) { return (S.cat === "all" || a.category === S.cat) && (S.showSeen || !a.seen_at); });
    var items = list.length ? list.map(item).join("") :
      '<div class="av-empty">' + (open.length ? "Nada com esse filtro." : "Nenhum aviso aberto. Tudo dentro do esperado.") + "</div>";

    root.innerHTML = head + kpis + digest + '<section class="panel av-list"><header class="av-ph"><div><h3>Avisos abertos</h3><p>Um aviso some sozinho quando deixa de valer. Se mudar de gravidade, volta como não visto.</p></div></header>' +
      chips + '<div class="av-items">' + items + "</div></section>";
  }
  function kpi(label, n, cls) {
    return '<div class="kpi av-kpi ' + cls + '"><div class="label">' + label + '</div><div class="value num">' + n + "</div></div>";
  }
  function chip(val, label, n) {
    var on = S.cat === val;
    return '<button type="button" class="pay-chip' + (on ? " on" : "") + '" data-av-cat="' + esc(val) + '" aria-pressed="' + on + '">' + esc(label) + " <b>" + n + "</b></button>";
  }
  function item(a) {
    var link = a.data && a.data.permalink && /^https:\/\//.test(a.data.permalink) ? ' <a href="' + esc(a.data.permalink) + '" target="_blank" rel="noopener noreferrer">Abrir ↗</a>' : "";
    return '<article class="av-item sev-' + esc(a.severity) + (a.seen_at ? " seen" : "") + '">' +
      '<div class="av-item-top"><span class="av-badge sev-' + esc(a.severity) + '">' + (SEV[a.severity] ? SEV[a.severity][0] : esc(a.severity)) + "</span>" +
      '<span class="av-cat">' + esc(catLabel(a.category)) + "</span>" +
      '<span class="av-when">desde ' + esc(when(a.first_seen_at)) + (a.updated_at !== a.first_seen_at ? " · atualizado " + esc(when(a.updated_at)) : "") + "</span>" +
      '<button type="button" class="av-seen" data-av-seen="' + esc(a.id) + '" data-v="' + (a.seen_at ? "0" : "1") + '">' + (a.seen_at ? "Marcar como não visto" : "Marcar como visto") + "</button></div>" +
      '<h4 class="av-title">' + esc(a.title) + "</h4>" + (a.body ? '<p class="av-body">' + esc(a.body) + link + "</p>" : "") + "</article>";
  }

  /* ---------------- dados ---------------- */
  async function load() {
    var r = await Promise.all([
      A.sb.from("alerts").select("id, category, severity, title, body, data, sort, first_seen_at, updated_at, seen_at").is("resolved_at", null),
      A.sb.from("alert_digests").select("created_at, text, source, model, telegram, note, alerts_count").order("created_at", { ascending: false }).limit(1).maybeSingle()
    ]);
    if (r[0].error) { A.toast("Erro ao ler os avisos: " + r[0].error.message, true); return; }
    S.alerts = (r[0].data || []).sort(function (x, y) { return (SEV[x.severity] || [, 9])[1] - (SEV[y.severity] || [, 9])[1] || x.sort - y.sort; });
    S.digest = r[1].data || null;
    S.loaded = true;
    render();
  }
  async function refresh() {
    if (S.busy) return;
    S.busy = true; busy("refresh", "Recalculando…");
    var r = await A.sb.rpc("generate_alerts");
    S.busy = false;
    if (r.error) { A.toast("Erro ao recalcular: " + r.error.message, true); render(); return; }
    A.toast("Avisos recalculados.");
    await load();
  }
  async function digest() {
    if (S.busy) return;
    S.busy = true; busy("digest", "Escrevendo o resumo…");
    var res = await A.sb.functions.invoke("alerts-digest", { body: { telegram: false } }), data = res.data || {};
    if (res.error && !data.error) { try { data = await res.error.context.json(); } catch (e) { data = { error: res.error.message }; } }
    S.busy = false;
    if (!data.ok) { A.toast("Não foi possível gerar o resumo: " + (data.error || "erro desconhecido"), true); render(); return; }
    A.toast(data.source === "ai" ? "Resumo da IA pronto." : "Resumo montado pelas regras (" + (data.note || "sem IA") + ")");
    await load();
  }
  function busy(which, label) { var b = A.root.querySelector('[data-av="' + which + '"]'); if (b) { b.disabled = true; b.textContent = label; } }
  async function setSeen(id, seen) {
    var r = await A.sb.rpc("alert_set_seen", { p_id: id, p_seen: seen });
    if (r.error) { A.toast("Erro: " + r.error.message, true); return; }
    S.alerts.forEach(function (a) { if (a.id === id) a.seen_at = r.data || null; });
    render();
  }

  function bind() {
    A.root.addEventListener("click", function (e) {
      var b = e.target.closest("[data-av]");
      if (b && b.dataset.av === "refresh") return refresh();
      if (b && b.dataset.av === "digest") return digest();
      var c = e.target.closest("[data-av-cat]");
      if (c) { S.cat = c.dataset.avCat; render(); return; }
      var s = e.target.closest("[data-av-seen]");
      if (s) setSeen(s.dataset.avSeen, s.dataset.v === "1");
    });
    A.root.addEventListener("change", function (e) { if (e.target.dataset.av === "seen") { S.showSeen = e.target.checked; render(); } });
  }

  return {
    init: function (deps) { A = deps; bind(); },
    show: function () { A.root.hidden = false; if (!S.loaded) A.root.innerHTML = '<div class="av-empty">Carregando avisos…</div>'; return load(); },
    hide: function () { A.root.hidden = true; }
  };
})();
