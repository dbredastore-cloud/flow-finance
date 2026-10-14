/* Cards Trello (menu do Financeiro).
   Cards das listas "Testes do cliente" e "Em produção" dos boards Flow, com a data de entrega e, para cada card,
   o tipo de atualização e três textos gerados pelo Claude: resumo, mensagem para o Slack e ideias para o Instagram.
   Dados: tabela trello_cards, preenchida pela Edge Function trello-cards (a cada 30 min ou pelo botão).
   Uso: TrelloCards.init({ root, sb, toast }); TrelloCards.show(); */
(function () {
  "use strict";

  var STAGES = [["", "Todos"], ["teste_cliente", "Testes do cliente"], ["producao", "Em produção"]];
  var TOOLS = ["FlowPages", "FlowTracking", "FlowSpy"];
  var TABS = [["resumo", "Para mim"], ["slack", "Slack da TB"], ["instagram", "Instagram"]];

  var A = null;
  var S = { ready: false, cards: [], last: null, stage: "", tool: "", q: "", open: {}, tab: {}, busy: {}, bulk: false };

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"; }
  function fmtDateTime(iso) { return iso ? fmtDate(iso) + " " + new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—"; }
  function weekday(iso) { return new Date(iso).toLocaleDateString("pt-BR", { weekday: "long" }); }
  function daysFromToday(iso) {
    var d = new Date(iso), t = new Date();
    var a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()), b = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
    return Math.round((a - b) / 86400000);
  }
  function stageName(k) { return (STAGES.filter(function (s) { return s[0] === k; })[0] || [k, k])[1]; }
  function stale(c) { return !c.ai || c.ai_hash !== c.content_hash; }

  async function call(body) {
    var res = await A.sb.functions.invoke("trello-cards", { body: body });
    var data = res.data;
    if (res.error && !(data && data.error)) {
      try { data = await res.error.context.json(); } catch (e) { data = { ok: false, error: res.error.message || "falha na chamada" }; }
    }
    return data || { ok: false, error: "sem resposta" };
  }

  /* ---------------- dados ---------------- */
  async function load() {
    var r = await Promise.all([
      A.sb.from("trello_cards").select("*").eq("active", true),
      A.sb.from("sync_state").select("value").eq("key", "trello_last_run").maybeSingle()
    ]);
    if (r[0].error) throw r[0].error;
    S.cards = r[0].data || [];
    S.last = r[1].data ? r[1].data.value : null;
  }

  // Com data de entrega primeiro (mais próxima antes); sem data, pela entrada na lista (mais recente antes).
  function visible() {
    var q = S.q.trim().toLowerCase();
    return S.cards.filter(function (c) {
      if (S.stage && c.stage !== S.stage) return false;
      if (S.tool && c.tool !== S.tool) return false;
      if (q && (c.name + " " + (c.ai && c.ai.titulo || "") + " " + c.board_name).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) {
      if (a.due && b.due) return Date.parse(a.due) - Date.parse(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      return Date.parse(b.entered_list_at || b.last_activity || 0) - Date.parse(a.entered_list_at || a.last_activity || 0);
    });
  }

  /* ---------------- esqueleto ---------------- */
  function build(root) {
    root.innerHTML =
      '<section class="ch-hero">' +
        '<div class="ch-hero-main"><div class="ch-kicker">Cards Trello</div><h3 class="ch-title">Entregas das ferramentas Flow</h3>' +
          '<p class="ch-sub">Cards em <b>Testes do cliente</b> e <b>Em produção</b> nos boards do Trello, com a data de entrega. Para cada um: o tipo de atualização, um resumo para você, a mensagem para o Slack da TB e ideias de conteúdo para o Instagram.</p>' +
          '<div class="ch-sources" id="tc-sources"></div></div>' +
        '<div class="ch-hero-acts"><button class="btn" id="tc-gen-all" type="button">Gerar textos pendentes</button><button class="btn btn-primary" id="tc-sync" type="button">Atualizar do Trello</button></div>' +
      "</section>" +
      '<div class="ch-tiles" id="tc-tiles"></div>' +
      '<div class="tc-filters">' +
        '<div class="ch-tabs" id="tc-stage" role="tablist" aria-label="Lista"></div>' +
        '<div class="ch-tabs" id="tc-tool" role="tablist" aria-label="Ferramenta"></div>' +
        '<input type="search" id="tc-q" placeholder="Buscar card…" aria-label="Buscar card">' +
      "</div>" +
      '<div id="tc-list" class="tc-list"></div>';

    $("tc-sync").addEventListener("click", syncNow);
    $("tc-gen-all").addEventListener("click", generatePending);
    $("tc-q").addEventListener("input", function (e) { S.q = e.target.value; renderList(); });
    root.addEventListener("click", onClick);
  }

  function onClick(e) {
    var el = e.target.closest("[data-act]");
    if (!el) return;
    var act = el.getAttribute("data-act"), id = el.getAttribute("data-id");
    if (act === "stage") { S.stage = el.getAttribute("data-v"); render(); }
    else if (act === "tool") { S.tool = el.getAttribute("data-v"); render(); }
    else if (act === "toggle") { S.open[id] = !S.open[id]; renderList(); }
    else if (act === "tab") { S.tab[id] = el.getAttribute("data-v"); S.open[id] = true; renderList(); }
    else if (act === "gen") generateCard(id, el.getAttribute("data-force") === "1");
    else if (act === "copy") copyText(id, el.getAttribute("data-v"));
  }

  /* ---------------- desenho ---------------- */
  function render() { renderTop(); renderList(); }

  function renderTop() {
    var l = S.last, src;
    if (!l) src = '<span class="ch-src wait"><i></i>Ainda não sincronizado — configure os secrets do Trello e clique em Atualizar</span>';
    else if (l.ok === false) src = '<span class="ch-src wait tc-err"><i></i>Última tentativa falhou (' + esc(fmtDateTime(l.at)) + "): " + esc(l.error) + "</span>";
    else src = '<span class="ch-src"><i></i>Trello atualizado em ' + esc(fmtDateTime(l.at)) + "</span>" +
      (l.boards ? '<span class="ch-src">Boards: ' + esc(l.boards.join(", ")) + "</span>" : "");
    $("tc-sources").innerHTML = src;

    var n = function (f) { return S.cards.filter(f).length; };
    var late = n(function (c) { return c.due && !c.due_complete && daysFromToday(c.due) < 0; });
    var week = n(function (c) { return c.due && !c.due_complete && daysFromToday(c.due) >= 0 && daysFromToday(c.due) <= 7; });
    var pend = n(stale);
    $("tc-tiles").innerHTML = [
      ["Testes do cliente", n(function (c) { return c.stage === "teste_cliente"; }), "aguardando validação"],
      ["Em produção", n(function (c) { return c.stage === "producao"; }), "cards na lista"],
      ["Entregas em 7 dias", week, "com data no card"],
      ["Atrasados", late, "data de entrega já passou"],
      ["Sem textos", pend, pend ? "clique em Gerar textos pendentes" : "tudo gerado"]
    ].map(function (t) {
      return '<div class="ch-tile" role="group"><small>' + esc(t[0]) + '</small><b class="num">' + t[1] + "</b><span>" + esc(t[2]) + "</span></div>";
    }).join("");

    $("tc-stage").innerHTML = STAGES.map(function (s) {
      var count = s[0] ? n(function (c) { return c.stage === s[0]; }) : S.cards.length;
      return '<button type="button" class="btn' + (S.stage === s[0] ? " btn-primary" : "") + '" data-act="stage" data-v="' + s[0] + '">' + esc(s[1]) + " · " + count + "</button>";
    }).join("");
    $("tc-tool").innerHTML = [""].concat(TOOLS).map(function (t) {
      return '<button type="button" class="btn' + (S.tool === t ? " btn-primary" : "") + '" data-act="tool" data-v="' + t + '">' + esc(t || "Todas") + "</button>";
    }).join("");
    $("tc-gen-all").disabled = S.bulk || !pend;
    $("tc-gen-all").textContent = S.bulk ? "Gerando…" : "Gerar textos pendentes" + (pend ? " (" + pend + ")" : "");
  }

  function dueHtml(c) {
    if (!c.due) {
      return '<div class="tc-due none"><small>Data de entrega</small><b>Sem data no card</b><span>' +
        (c.entered_list_at ? "entrou em " + esc(stageName(c.stage)) + " em " + esc(fmtDate(c.entered_list_at)) : "defina a data no Trello") + "</span></div>";
    }
    var d = daysFromToday(c.due), cls, rel;
    if (c.due_complete) { cls = "done"; rel = "✓ marcada como concluída"; }
    else if (d < 0) { cls = "late"; rel = "atrasado " + (-d) + (d === -1 ? " dia" : " dias"); }
    else if (d === 0) { cls = "soon"; rel = "hoje"; }
    else if (d <= 7) { cls = "soon"; rel = d === 1 ? "amanhã" : "em " + d + " dias"; }
    else { cls = ""; rel = "em " + d + " dias"; }
    return '<div class="tc-due ' + cls + '"><small>Data de entrega</small><b class="num">' + esc(fmtDate(c.due)) + "</b><span>" + esc(weekday(c.due)) + " · " + esc(rel) + "</span></div>";
  }

  function renderList() {
    var list = visible();
    if (!S.cards.length) {
      $("tc-list").innerHTML = '<div class="panel tc-empty">Nenhum card em Testes do cliente ou Em produção ainda. Clique em <b>Atualizar do Trello</b>.</div>';
      return;
    }
    if (!list.length) { $("tc-list").innerHTML = '<div class="panel tc-empty">Nenhum card com esses filtros.</div>'; return; }
    $("tc-list").innerHTML = list.map(cardHtml).join("");
  }

  function cardHtml(c) {
    var ai = c.ai, busy = S.busy[c.id], open = S.open[c.id];
    var labels = (c.labels || []).filter(function (l) { return l.name; }).map(function (l) { return '<span class="tc-label">' + esc(l.name) + "</span>"; }).join("");
    var genBtn = busy ? '<button class="btn" type="button" disabled>Gerando…</button>'
      : !ai ? '<button class="btn btn-primary" type="button" data-act="gen" data-id="' + c.id + '">Gerar textos</button>'
      : '<button class="btn" type="button" data-act="toggle" data-id="' + c.id + '">' + (open ? "Fechar textos" : "Ver textos") + "</button>" +
        '<button class="btn btn-ghost" type="button" data-act="gen" data-id="' + c.id + '" data-force="1" title="Gerar de novo">↻ Refazer</button>';
    return '<article class="tc-card' + (open ? " open" : "") + '">' +
      '<div class="tc-head">' +
        '<div class="tc-main">' +
          '<div class="tc-tags"><span class="tc-tool">' + esc(c.tool || c.board_name) + '</span><span class="tc-stage s-' + c.stage + '">' + esc(c.list_name) + "</span>" +
            (ai ? '<span class="tc-type">' + esc(ai.tipo) + "</span>" : "") + labels + "</div>" +
          "<h4>" + esc(ai ? ai.titulo : c.name) + "</h4>" +
          (ai ? '<div class="tc-orig">Card: ' + esc(c.name) + "</div>" : "") +
          (ai ? '<p class="tc-sum">' + esc(ai.resumo.o_que_e) + "</p>" : c.description ? '<p class="tc-sum">' + esc(c.description.slice(0, 220)) + (c.description.length > 220 ? "…" : "") + "</p>" : "") +
          (ai && stale(c) ? '<div class="tc-warn">O card mudou no Trello depois que os textos foram gerados. Clique em Refazer.</div>' : "") +
          (c.ai_error && !busy ? '<div class="tc-warn">Erro ao gerar: ' + esc(c.ai_error) + "</div>" : "") +
        "</div>" +
        dueHtml(c) +
      "</div>" +
      '<div class="tc-acts">' + genBtn + (c.url ? '<a class="btn btn-ghost" href="' + esc(c.url) + '" target="_blank" rel="noopener">Abrir no Trello ↗</a>' : "") +
        (c.members && c.members.length ? '<span class="tc-members">' + esc(c.members.join(", ")) + "</span>" : "") + "</div>" +
      (ai && open ? textsHtml(c) : "") +
      "</article>";
  }

  function textsHtml(c) {
    var tab = S.tab[c.id] || "resumo", ai = c.ai, body;
    if (tab === "resumo") {
      body = '<dl class="tc-dl"><dt>Tipo</dt><dd>' + esc(ai.tipo) + "</dd><dt>O que é</dt><dd>" + esc(ai.resumo.o_que_e) + "</dd><dt>O que beneficia</dt><dd>" + esc(ai.resumo.beneficio) +
        "</dd><dt>Para quem</dt><dd>" + esc(ai.resumo.para_quem) + "</dd></dl>";
    } else if (tab === "slack") {
      body = '<div class="tc-text">' + esc(ai.slack) + "</div>";
    } else {
      var ig = ai.instagram;
      body = '<div class="tc-ig">' +
        igBlock("Ganchos fortes", ol(ig.ganchos)) +
        igBlock("Reels", "<p><b>Gancho:</b> " + esc(ig.reels.gancho) + "</p>" + ol(ig.reels.roteiro) + '<p class="tc-cap"><b>Legenda:</b> ' + esc(ig.reels.legenda) + "</p>") +
        igBlock("Stories", ol(ig.story.telas) + "<p><b>CTA:</b> " + esc(ig.story.cta) + "</p>") +
        igBlock("Carrossel", ol(ig.carrossel.slides) + '<p class="tc-cap"><b>Legenda:</b> ' + esc(ig.carrossel.legenda) + "</p>") +
        igBlock("Outros formatos", ul(ig.outros)) +
        "</div>";
    }
    return '<div class="tc-texts">' +
      '<div class="tc-tabbar">' + TABS.map(function (t) {
        return '<button type="button" class="btn' + (tab === t[0] ? " btn-primary" : "") + '" data-act="tab" data-id="' + c.id + '" data-v="' + t[0] + '">' + esc(t[1]) + "</button>";
      }).join("") + '<button type="button" class="btn tc-copy" data-act="copy" data-id="' + c.id + '" data-v="' + tab + '">Copiar</button></div>' +
      body + "</div>";
  }
  function igBlock(t, html) { return '<section><h5>' + esc(t) + "</h5>" + html + "</section>"; }
  function ol(a) { return "<ol>" + (a || []).map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ol>"; }
  function ul(a) { return "<ul>" + (a || []).map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>"; }

  /* ---------------- texto para copiar ---------------- */
  function plain(c, tab) {
    var ai = c.ai, num = function (a) { return (a || []).map(function (x, i) { return (i + 1) + ". " + x; }).join("\n"); };
    var due = c.due ? "Entrega: " + fmtDate(c.due) : "Entrega: sem data no card";
    if (tab === "resumo") {
      return ai.titulo + " (" + ai.tipo + ")\n" + (c.tool || c.board_name) + " · " + c.list_name + " · " + due + "\n\n" +
        "O que é: " + ai.resumo.o_que_e + "\n\nO que beneficia: " + ai.resumo.beneficio + "\n\nPara quem: " + ai.resumo.para_quem;
    }
    if (tab === "slack") return ai.slack;
    var ig = ai.instagram;
    return "INSTAGRAM — " + ai.titulo + "\n\nGANCHOS\n" + num(ig.ganchos) +
      "\n\nREELS\nGancho: " + ig.reels.gancho + "\n" + num(ig.reels.roteiro) + "\nLegenda: " + ig.reels.legenda +
      "\n\nSTORIES\n" + num(ig.story.telas) + "\nCTA: " + ig.story.cta +
      "\n\nCARROSSEL\n" + num(ig.carrossel.slides) + "\nLegenda: " + ig.carrossel.legenda +
      "\n\nOUTROS FORMATOS\n" + (ig.outros || []).map(function (x) { return "- " + x; }).join("\n");
  }
  async function copyText(id, tab) {
    var c = S.cards.filter(function (x) { return x.id === id; })[0];
    if (!c || !c.ai) return;
    try { await navigator.clipboard.writeText(plain(c, tab)); A.toast("Texto copiado."); }
    catch (e) { A.toast("Não foi possível copiar: " + (e.message || e), true); }
  }

  /* ---------------- ações ---------------- */
  async function syncNow() {
    var b = $("tc-sync");
    b.disabled = true; b.textContent = "Lendo o Trello…";
    try {
      var r = await call({ action: "sync" });
      if (!r.ok) A.toast("Erro ao ler o Trello: " + (r.error || "falha"), true);
      else A.toast(r.cards + (r.cards === 1 ? " card encontrado." : " cards encontrados."));
      await load();
      render();
    } catch (e) { A.toast("Erro: " + (e.message || e), true); }
    finally { b.disabled = false; b.textContent = "Atualizar do Trello"; }
  }

  async function generateCard(id, force) {
    if (S.busy[id]) return;
    S.busy[id] = true; renderList();
    var r = await call({ action: "generate", id: id, force: !!force });
    delete S.busy[id];
    var c = S.cards.filter(function (x) { return x.id === id; })[0];
    if (c) {
      if (r.ok) { c.ai = r.ai; c.ai_hash = c.content_hash; c.ai_error = null; S.open[id] = true; }
      else { c.ai_error = r.error || "falha"; A.toast("Erro ao gerar os textos: " + c.ai_error, true); }
    }
    render();
    return r.ok;
  }

  // Um card por vez (cada geração leva alguns segundos).
  async function generatePending() {
    if (S.bulk) return;
    var todo = visible().filter(stale).map(function (c) { return c.id; });
    if (!todo.length) todo = S.cards.filter(stale).map(function (c) { return c.id; });
    S.bulk = true; renderTop();
    var ok = 0;
    for (var i = 0; i < todo.length; i++) { if (await generateCard(todo[i], true)) ok++; }
    S.bulk = false; renderTop();
    A.toast(ok + " de " + todo.length + " cards com textos gerados.", ok < todo.length);
  }

  /* ---------------- API pública ---------------- */
  async function show() {
    if (!A) return;
    try {
      if (!S.ready) { S.ready = true; $("tc-list").innerHTML = '<div class="panel tc-empty">Carregando…</div>'; }
      await load();
      render();
    } catch (e) {
      console.warn("Cards Trello:", e);
      A.toast("Não foi possível carregar os cards do Trello: " + (e.message || e), true);
    }
  }
  window.TrelloCards = {
    init: function (opts) { A = opts; build(opts.root); },
    show: show
  };
})();
