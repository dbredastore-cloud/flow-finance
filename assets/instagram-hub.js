/* Instagram (menu do Financeiro).
   Painel de conteúdo a partir das entregas do Trello: só melhorias e funcionalidades (bugs ficam de fora, coluna
   is_bug). Para cada card: o que foi feito, os textos de Cards Trello (Para mim e Slack) e o pacote de Instagram
   (ganchos, roteiro de Reels cena a cena, carrossel, stories, legenda e hashtags).
   Marcações compartilhadas pela equipe — Lido, Interessante e Conteúdo feito — ligam e desligam pela função
   trello_ig_flag. Dados: tabela trello_cards (coluna ig, escrita pelo Claude como os demais textos).
   Uso: InstagramHub.init({ root, sb, toast }); InstagramHub.show(); */
(function () {
  "use strict";

  var TOOLS = ["FlowPages", "FlowTracking", "FlowSpy"];
  var STATUS = [
    ["", "Todos"], ["unread", "Não lidos"], ["fav", "Interessantes"], ["todo", "A produzir"], ["used", "Conteúdo feito"]
  ];
  var TABS = [["geral", "Visão geral"], ["reels", "Reels"], ["carrossel", "Carrossel"], ["stories", "Stories"], ["legenda", "Legenda e hashtags"], ["textos", "Para mim e Slack"]];
  var FLAGS = {
    read: { on: "Lido", off: "Marcar como lido", at: "ig_read_at", by: "ig_read_by", icon: "◉" },
    fav: { on: "Interessante", off: "Interessante", at: "ig_fav_at", by: "ig_fav_by", icon: "★" },
    used: { on: "Conteúdo feito", off: "Conteúdo feito", at: "ig_used_at", by: "ig_used_by", icon: "✓" }
  };
  var COLS = "id, tool, board_name, list_name, stage, name, url, due, entered_list_at, last_activity, ai, ig, ig_hash, content_hash, " +
    "ig_read_at, ig_read_by, ig_fav_at, ig_fav_by, ig_used_at, ig_used_by";

  var A = null;
  var S = { ready: false, cards: [], status: "", tool: "", tipo: "", q: "", openId: null, tab: "geral", busy: {} };

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : ""; }
  function fmtDateTime(iso) { return iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : ""; }
  function since(c) { return Date.parse(c.entered_list_at || c.last_activity || 0) || 0; }
  function byId(id) { return S.cards.filter(function (c) { return c.id === id; })[0]; }
  function title(c) { return (c.ai && c.ai.titulo) || c.name; }
  function tipo(c) { return (c.ai && c.ai.tipo) || "Atualização"; }
  function arr(a) { return Array.isArray(a) ? a : []; }

  // Pacote de Instagram: o novo (coluna ig) ou, enquanto não existe, o básico dos Cards Trello.
  function pack(c) {
    if (c.ig) return c.ig;
    var o = (c.ai && c.ai.instagram) || {};
    return {
      fallback: true,
      publico: c.ai && c.ai.resumo ? c.ai.resumo.o_que_e : "",
      ganchos: arr(o.ganchos),
      reels: o.reels ? { gancho: o.reels.gancho, cenas: arr(o.reels.roteiro).map(function (t, i) { return { tempo: "Cena " + (i + 1), visual: t }; }), legenda: o.reels.legenda } : null,
      carrossel: o.carrossel ? { slides: arr(o.carrossel.slides).map(function (t) { return { titulo: t }; }), legenda: o.carrossel.legenda } : null,
      stories: arr(o.story && o.story.telas).map(function (t) { return { texto: t }; }).concat(o.story && o.story.cta ? [{ texto: o.story.cta, interacao: "CTA" }] : []),
      hashtags: []
    };
  }

  /* ---------------- dados ---------------- */
  async function load() {
    var r = await A.sb.from("trello_cards").select(COLS).eq("active", true).eq("is_bug", false).not("ai", "is", null);
    if (r.error) throw r.error;
    S.cards = (r.data || []).sort(function (a, b) {
      if (a.stage !== b.stage) return a.stage === "teste_cliente" ? -1 : 1;
      return since(b) - since(a);
    });
  }

  function match(c) {
    if (S.tool && c.tool !== S.tool) return false;
    if (S.tipo && tipo(c) !== S.tipo) return false;
    if (S.status === "unread" && c.ig_read_at) return false;
    if (S.status === "fav" && !c.ig_fav_at) return false;
    if (S.status === "todo" && c.ig_used_at) return false;
    if (S.status === "used" && !c.ig_used_at) return false;
    var q = S.q.trim().toLowerCase();
    if (q && (title(c) + " " + c.name + " " + (c.tool || "")).toLowerCase().indexOf(q) < 0) return false;
    return true;
  }

  /* ---------------- esqueleto ---------------- */
  function build(root) {
    root.innerHTML =
      '<section class="ch-hero ig-hero">' +
        '<div class="ch-hero-main"><div class="ch-kicker">Instagram</div><h3 class="ch-title">Conteúdo das atualizações Flow</h3>' +
          '<p class="ch-sub">Cada melhoria e funcionalidade nova das ferramentas vira pauta: o que foi feito, roteiro de Reels cena a cena, carrossel, stories, legenda e hashtags. Correções de bug ficam de fora. Marque o que já leu, o que achou interessante e o que já virou conteúdo; a equipe toda vê as marcações.</p></div>' +
      "</section>" +
      '<div class="ig-tiles" id="ig-tiles"></div>' +
      '<div class="ig-filters">' +
        '<div class="ch-tabs" id="ig-status" role="tablist" aria-label="Situação"></div>' +
        '<div class="ig-row"><div class="ch-tabs" id="ig-tool" role="tablist" aria-label="Ferramenta"></div>' +
        '<select id="ig-tipo" aria-label="Tipo de atualização"></select>' +
        '<input type="search" id="ig-q" placeholder="Buscar atualização…" aria-label="Buscar atualização"></div>' +
      "</div>" +
      '<div class="ig-grid" id="ig-grid"></div>' +
      '<div class="ig-drawer-back" id="ig-back" hidden></div>' +
      '<aside class="ig-drawer" id="ig-drawer" hidden aria-label="Conteúdo da atualização"></aside>';

    $("ig-q").addEventListener("input", function (e) { S.q = e.target.value; renderGrid(); });
    $("ig-tipo").addEventListener("change", function (e) { S.tipo = e.target.value; render(); });
    $("ig-back").addEventListener("click", closeDrawer);
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", function (e) {
      var card = e.target.classList && e.target.classList.contains("ig-card") ? e.target : null;
      if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDrawer(card.getAttribute("data-id")); }
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.openId) closeDrawer(); });
  }

  function onClick(e) {
    var el = e.target.closest("[data-act]");
    if (!el) return;
    var act = el.getAttribute("data-act"), id = el.getAttribute("data-id"), v = el.getAttribute("data-v");
    if (act === "status") { S.status = v; render(); }
    else if (act === "tool") { S.tool = v; render(); }
    else if (act === "open") openDrawer(id);
    else if (act === "close") closeDrawer();
    else if (act === "tab") { S.tab = v; renderDrawer(); }
    else if (act === "flag") { e.stopPropagation(); toggle(id, v); }
    else if (act === "copy") copy(id, v);
  }

  /* ---------------- desenho ---------------- */
  function render() { renderTop(); renderGrid(); if (S.openId) renderDrawer(); }

  function renderTop() {
    var all = S.cards, n = function (f) { return all.filter(f).length; };
    var unread = n(function (c) { return !c.ig_read_at; }), fav = n(function (c) { return !!c.ig_fav_at; }),
      used = n(function (c) { return !!c.ig_used_at; }), feat = n(function (c) { return tipo(c) === "Nova funcionalidade"; });
    var pct = all.length ? Math.round(used / all.length * 100) : 0;
    $("ig-tiles").innerHTML =
      tile("Atualizações", all.length, feat + " funcionalidades novas", "") +
      tile("Não lidas", unread, unread ? "ainda ninguém marcou como lido" : "tudo lido", "unread") +
      tile("Interessantes", fav, "marcadas com ★", "fav") +
      tile("A produzir", all.length - used, "sem conteúdo feito", "todo") +
      '<button type="button" class="ig-tile ig-progress' + (S.status === "used" ? " on" : "") + '" data-act="status" data-v="used">' +
        "<small>Conteúdo feito</small><b class=\"num\">" + used + '<span> / ' + all.length + "</span></b>" +
        '<div class="ig-bar"><i style="width:' + pct + '%"></i></div><span>' + pct + "% das atualizações já viraram conteúdo</span></button>";

    var counts = { "": all.length, unread: unread, fav: fav, todo: all.length - used, used: used };
    $("ig-status").innerHTML = STATUS.map(function (s) {
      return '<button type="button" class="btn' + (S.status === s[0] ? " btn-primary" : "") + '" data-act="status" data-v="' + s[0] + '">' + esc(s[1]) + " · " + counts[s[0]] + "</button>";
    }).join("");
    $("ig-tool").innerHTML = [""].concat(TOOLS).map(function (t) {
      return '<button type="button" class="btn' + (S.tool === t ? " btn-primary" : "") + '" data-act="tool" data-v="' + t + '">' + esc(t || "Todas") + "</button>";
    }).join("");
    var tipos = {};
    all.forEach(function (c) { tipos[tipo(c)] = (tipos[tipo(c)] || 0) + 1; });
    $("ig-tipo").innerHTML = '<option value="">Todos os tipos</option>' + Object.keys(tipos).sort().map(function (t) {
      return '<option value="' + esc(t) + '"' + (S.tipo === t ? " selected" : "") + ">" + esc(t) + " (" + tipos[t] + ")</option>";
    }).join("");
  }
  function tile(label, value, sub, status) {
    var clickable = status !== "";
    return '<button type="button" class="ig-tile' + (clickable && S.status === status ? " on" : "") + '"' + (clickable ? ' data-act="status" data-v="' + status + '"' : " disabled") + ">" +
      "<small>" + esc(label) + '</small><b class="num">' + value + "</b><span>" + esc(sub) + "</span></button>";
  }

  function flagBtn(c, f, compact) {
    var F = FLAGS[f], on = !!c[F.at], busy = S.busy[c.id + f];
    var tip = on ? F.on + " por " + (c[F.by] || "alguém") + " em " + fmtDateTime(c[F.at]) + ". Clique para desmarcar." : "Marcar: " + F.on;
    return '<button type="button" class="ig-flag f-' + f + (on ? " on" : "") + '" data-act="flag" data-id="' + c.id + '" data-v="' + f + '" aria-pressed="' + on + '" title="' + esc(tip) + '"' + (busy ? " disabled" : "") + ">" +
      '<span aria-hidden="true">' + F.icon + "</span>" + (compact ? "" : "<em>" + esc(on ? F.on : F.off) + "</em>") + "</button>";
  }

  function renderGrid() {
    var list = S.cards.filter(match);
    if (!S.cards.length) { $("ig-grid").innerHTML = '<div class="panel ig-empty">Nenhuma atualização com textos ainda. Os cards aparecem aqui assim que os textos dos Cards Trello forem gerados.</div>'; return; }
    if (!list.length) { $("ig-grid").innerHTML = '<div class="panel ig-empty">Nada com esses filtros.</div>'; return; }
    $("ig-grid").innerHTML = list.map(function (c) {
      var p = pack(c), fmt = p.formato_ideal;
      return '<article class="ig-card' + (c.ig_used_at ? " used" : "") + (c.ig_read_at ? " read" : "") + '" data-act="open" data-id="' + c.id + '" tabindex="0">' +
        '<div class="ig-card-top"><span class="ig-tool">' + esc(c.tool || c.board_name) + '</span><span class="ig-type">' + esc(tipo(c)) + "</span>" +
          (fmt ? '<span class="ig-fmt">' + esc(fmt) + "</span>" : "") + (!c.ig ? '<span class="ig-wait">roteiro completo a caminho</span>' : "") + "</div>" +
        "<h4>" + esc(title(c)) + "</h4>" +
        '<p class="ig-pub">' + esc(p.publico || "") + "</p>" +
        (arr(p.ganchos)[0] ? '<p class="ig-hook">“' + esc(p.ganchos[0]) + '”</p>' : "") +
        '<div class="ig-card-foot"><div class="ig-flags">' + flagBtn(c, "read", true) + flagBtn(c, "fav", true) + flagBtn(c, "used", true) + "</div>" +
          '<span class="ig-meta">' + esc(c.list_name) + (since(c) ? " · " + fmtDate(c.entered_list_at || c.last_activity) : "") + "</span></div>" +
        "</article>";
    }).join("");
  }

  /* ---------------- detalhe ---------------- */
  function openDrawer(id) { S.openId = id; S.tab = "geral"; renderDrawer(); $("ig-drawer").hidden = false; $("ig-back").hidden = false; $("ig-drawer").scrollTop = 0; }
  function closeDrawer() { S.openId = null; $("ig-drawer").hidden = true; $("ig-back").hidden = true; }

  function renderDrawer() {
    var c = byId(S.openId);
    if (!c) { closeDrawer(); return; }
    var p = pack(c);
    var body = ({ geral: tabGeral, reels: tabReels, carrossel: tabCarrossel, stories: tabStories, legenda: tabLegenda, textos: tabTextos }[S.tab] || tabGeral)(c, p);
    $("ig-drawer").innerHTML =
      '<div class="ig-d-head">' +
        '<div><div class="ig-card-top"><span class="ig-tool">' + esc(c.tool || c.board_name) + '</span><span class="ig-type">' + esc(tipo(c)) + "</span>" +
          (p.formato_ideal ? '<span class="ig-fmt">Formato ideal: ' + esc(p.formato_ideal) + "</span>" : "") + "</div>" +
          "<h3>" + esc(title(c)) + '</h3><div class="ig-orig">Card: ' + esc(c.name) + (c.url ? ' · <a href="' + esc(c.url) + '" target="_blank" rel="noopener">abrir no Trello ↗</a>' : "") + "</div></div>" +
        '<button type="button" class="btn btn-ghost ig-x" data-act="close" aria-label="Fechar">✕</button>' +
      "</div>" +
      '<div class="ig-flags big">' + flagBtn(c, "read") + flagBtn(c, "fav") + flagBtn(c, "used") + "</div>" +
      (p.fallback ? '<div class="ig-note">O roteiro completo desta atualização ainda está sendo escrito. Por enquanto aparecem as ideias básicas.</div>' : "") +
      '<div class="ig-tabs">' + TABS.map(function (t) {
        return '<button type="button" class="btn' + (S.tab === t[0] ? " btn-primary" : "") + '" data-act="tab" data-v="' + t[0] + '">' + esc(t[1]) + "</button>";
      }).join("") + "</div>" +
      '<div class="ig-d-body">' + body + "</div>";
  }
  function copyBtn(c, what, label) { return '<button type="button" class="btn ig-copy" data-act="copy" data-id="' + c.id + '" data-v="' + what + '">' + esc(label || "Copiar") + "</button>"; }
  function section(t, html, extra) { return '<section class="ig-sec"><div class="ig-sec-h"><h5>' + esc(t) + "</h5>" + (extra || "") + "</div>" + html + "</section>"; }

  function tabGeral(c, p) {
    return section("O que foi feito", '<p class="ig-lead">' + esc(p.publico || "") + "</p>", copyBtn(c, "publico")) +
      (p.angulo ? section("Ângulo do conteúdo", "<p>" + esc(p.angulo) + "</p>") : "") +
      (arr(p.ganchos).length ? section("Ganchos para abrir o conteúdo", '<ol class="ig-hooks">' + p.ganchos.map(function (g) { return "<li>" + esc(g) + "</li>"; }).join("") + "</ol>", copyBtn(c, "ganchos")) : "") +
      (p.dica ? section("Dica de gravação", '<p class="ig-tip">' + esc(p.dica) + "</p>") : "") +
      section("Pacote", '<div class="ig-pack">' +
        packItem("Reels", p.reels ? (p.reels.duracao || arr(p.reels.cenas).length + " cenas") : "—", "reels") +
        packItem("Carrossel", p.carrossel ? arr(p.carrossel.slides).length + " slides" : "—", "carrossel") +
        packItem("Stories", arr(p.stories).length ? arr(p.stories).length + " telas" : "—", "stories") +
        packItem("Hashtags", arr(p.hashtags).length || "—", "legenda") + "</div>");
  }
  function packItem(t, v, tab) { return '<button type="button" class="ig-pack-i" data-act="tab" data-v="' + tab + '"><small>' + esc(t) + "</small><b>" + esc(v) + "</b></button>"; }

  function tabReels(c, p) {
    var r = p.reels;
    if (!r) return '<p class="ig-empty">Sem roteiro de Reels.</p>';
    var meta = [r.estilo, r.duracao, r.audio ? "Áudio: " + r.audio : ""].filter(Boolean);
    return (r.titulo ? '<h4 class="ig-h">' + esc(r.titulo) + "</h4>" : "") +
      (meta.length ? '<div class="ig-meta-row">' + meta.map(function (m) { return "<span>" + esc(m) + "</span>"; }).join("") + "</div>" : "") +
      (r.gancho ? section("Gancho (primeiros 3 segundos)", '<p class="ig-lead">' + esc(r.gancho) + "</p>") : "") +
      section("Roteiro cena a cena", '<div class="ig-scenes">' + arr(r.cenas).map(function (s, i) {
        return '<div class="ig-scene"><div class="ig-scene-t">' + esc(s.tempo || "Cena " + (i + 1)) + "</div><div>" +
          (s.visual ? '<p><b>Imagem:</b> ' + esc(s.visual) + "</p>" : "") +
          (s.fala ? '<p><b>Fala:</b> “' + esc(s.fala) + '”</p>' : "") +
          (s.texto ? '<p><b>Texto na tela:</b> ' + esc(s.texto) + "</p>" : "") + "</div></div>";
      }).join("") + "</div>", copyBtn(c, "reels", "Copiar roteiro")) +
      (r.cta ? section("Chamada final", "<p>" + esc(r.cta) + "</p>") : "") +
      (r.legenda ? section("Legenda do Reels", '<div class="ig-text">' + esc(r.legenda) + "</div>", copyBtn(c, "reels_legenda")) : "");
  }

  function tabCarrossel(c, p) {
    var k = p.carrossel;
    if (!k) return '<p class="ig-empty">Sem carrossel.</p>';
    return (k.titulo ? '<h4 class="ig-h">' + esc(k.titulo) + "</h4>" : "") +
      section("Slides", '<div class="ig-slides">' + arr(k.slides).map(function (s, i) {
        return '<div class="ig-slide"><span class="ig-slide-n">' + (i + 1) + "/" + k.slides.length + "</span><b>" + esc(s.titulo || "") + "</b>" + (s.texto ? "<p>" + esc(s.texto) + "</p>" : "") + "</div>";
      }).join("") + "</div>", copyBtn(c, "carrossel", "Copiar slides")) +
      (k.legenda ? section("Legenda do carrossel", '<div class="ig-text">' + esc(k.legenda) + "</div>", copyBtn(c, "carrossel_legenda")) : "");
  }

  function tabStories(c, p) {
    var st = arr(p.stories);
    if (!st.length) return '<p class="ig-empty">Sem sequência de stories.</p>';
    return section("Sequência", '<div class="ig-stories">' + st.map(function (s, i) {
      return '<div class="ig-story"><span class="ig-slide-n">Tela ' + (i + 1) + "</span><p>" + esc(s.texto || "") + "</p>" + (s.interacao ? '<em>' + esc(s.interacao) + "</em>" : "") + "</div>";
    }).join("") + "</div>", copyBtn(c, "stories", "Copiar stories"));
  }

  function tabLegenda(c, p) {
    var leg = (p.reels && p.reels.legenda) || (p.carrossel && p.carrossel.legenda) || "";
    return (leg ? section("Legenda principal", '<div class="ig-text">' + esc(leg) + "</div>", copyBtn(c, "legenda")) : "") +
      (arr(p.hashtags).length ? section("Hashtags", '<div class="ig-tags">' + p.hashtags.map(function (h) { return "<span>" + esc(h) + "</span>"; }).join("") + "</div>", copyBtn(c, "hashtags")) : "") +
      (arr(p.ganchos).length ? section("Ganchos alternativos", '<ol class="ig-hooks">' + p.ganchos.map(function (g) { return "<li>" + esc(g) + "</li>"; }).join("") + "</ol>", copyBtn(c, "ganchos")) : "");
  }

  function tabTextos(c) {
    var ai = c.ai || {}, r = ai.resumo || {};
    return section("Para mim", '<dl class="ig-dl"><dt>O que é</dt><dd>' + esc(r.o_que_e) + "</dd>" +
        (r.como_funciona ? "<dt>Como funciona</dt><dd>" + esc(r.como_funciona) + "</dd>" : "") +
        "<dt>O que beneficia</dt><dd>" + esc(r.beneficio) + "</dd><dt>Para quem</dt><dd>" + esc(r.para_quem) + "</dd></dl>", copyBtn(c, "resumo")) +
      (ai.slack ? section("Slack da TB", '<div class="ig-text">' + esc(ai.slack) + "</div>", copyBtn(c, "slack")) : "");
  }

  /* ---------------- copiar ---------------- */
  function plain(c, what) {
    var p = pack(c), ai = c.ai || {}, r = ai.resumo || {}, nl = "\n";
    var num = function (a) { return arr(a).map(function (x, i) { return (i + 1) + ". " + x; }).join(nl); };
    switch (what) {
      case "publico": return p.publico || "";
      case "ganchos": return num(p.ganchos);
      case "reels":
        var rr = p.reels || {};
        return [rr.titulo, rr.estilo && "Estilo: " + rr.estilo, rr.duracao && "Duração: " + rr.duracao, rr.audio && "Áudio: " + rr.audio, rr.gancho && nl + "GANCHO: " + rr.gancho, nl + "ROTEIRO"]
          .filter(Boolean).join(nl) + nl + arr(rr.cenas).map(function (s, i) {
            return "[" + (s.tempo || "Cena " + (i + 1)) + "]" + (s.visual ? nl + "Imagem: " + s.visual : "") + (s.fala ? nl + "Fala: " + s.fala : "") + (s.texto ? nl + "Texto na tela: " + s.texto : "");
          }).join(nl + nl) + (rr.cta ? nl + nl + "CTA: " + rr.cta : "");
      case "reels_legenda": return (p.reels && p.reels.legenda) || "";
      case "carrossel": return arr(p.carrossel && p.carrossel.slides).map(function (s, i) { return "Slide " + (i + 1) + ": " + (s.titulo || "") + (s.texto ? nl + s.texto : ""); }).join(nl + nl);
      case "carrossel_legenda": return (p.carrossel && p.carrossel.legenda) || "";
      case "stories": return arr(p.stories).map(function (s, i) { return "Tela " + (i + 1) + ": " + (s.texto || "") + (s.interacao ? " [" + s.interacao + "]" : ""); }).join(nl);
      case "legenda": return ((p.reels && p.reels.legenda) || (p.carrossel && p.carrossel.legenda) || "") + (arr(p.hashtags).length ? nl + nl + p.hashtags.join(" ") : "");
      case "hashtags": return arr(p.hashtags).join(" ");
      case "resumo": return title(c) + " (" + tipo(c) + ")" + nl + nl + "O que é: " + (r.o_que_e || "") + (r.como_funciona ? nl + nl + "Como funciona: " + r.como_funciona : "") +
        nl + nl + "O que beneficia: " + (r.beneficio || "") + nl + nl + "Para quem: " + (r.para_quem || "");
      case "slack": return ai.slack || "";
    }
    return "";
  }
  async function copy(id, what) {
    var c = byId(id);
    if (!c) return;
    try { await navigator.clipboard.writeText(plain(c, what)); A.toast("Copiado."); }
    catch (e) { A.toast("Não foi possível copiar: " + (e.message || e), true); }
  }

  /* ---------------- marcações ---------------- */
  async function toggle(id, f) {
    var c = byId(id), F = FLAGS[f];
    if (!c || !F || S.busy[id + f]) return;
    var on = !c[F.at], before = { at: c[F.at], by: c[F.by], rat: c.ig_read_at, rby: c.ig_read_by };
    c[F.at] = on ? new Date().toISOString() : null; // otimista
    c[F.by] = on ? "você" : null;
    if (f === "used" && on && !c.ig_read_at) { c.ig_read_at = c[F.at]; c.ig_read_by = "você"; }
    S.busy[id + f] = true; render();
    var r = await A.sb.rpc("trello_ig_flag", { p_id: id, p_flag: f, p_on: on });
    delete S.busy[id + f];
    if (r.error) {
      c[F.at] = before.at; c[F.by] = before.by; c.ig_read_at = before.rat; c.ig_read_by = before.rby;
      render(); A.toast("Não foi possível salvar: " + r.error.message, true); return;
    }
    Object.assign(c, r.data || {});
    render();
  }

  /* ---------------- API pública ---------------- */
  async function show() {
    if (!A) return;
    try {
      if (!S.ready) { S.ready = true; $("ig-grid").innerHTML = '<div class="panel ig-empty">Carregando…</div>'; }
      await load();
      render();
    } catch (e) {
      console.warn("Instagram:", e);
      A.toast("Não foi possível carregar o Instagram: " + (e.message || e), true);
    }
  }
  window.InstagramHub = {
    init: function (opts) { A = opts; build(opts.root); },
    show: show,
    hide: closeDrawer
  };
})();
