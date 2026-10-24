/* Ideias Usuários (menu do Financeiro).
   O que o público pede, sugere ou pergunta sobre as ferramentas Flow, para a equipe decidir o que entra nelas.
   Comentários do Instagram entram importados (ig_comment_id); caixinha de perguntas, Direct e enquetes não saem
   pela API do Instagram, então a equipe registra à mão pelo botão "Registrar pedido".
   Cada pedido tem ferramenta, tipo e status (Novo → Em análise → No roadmap → Entregue, ou Descartado), que a
   equipe muda direto no card. Dados: tabela user_ideas (migration 20261024_user_ideas.sql).
   Uso: UserIdeas.init({ root, sb, toast }); UserIdeas.show(); */
(function () {
  "use strict";

  var TOOLS = [["FlowSpy", "FlowSpy"], ["FlowPages", "FlowPages"], ["FlowTracking", "FlowTracking"], ["Geral", "Geral"]];
  var KINDS = [["ideia", "Ideia ou pedido"], ["duvida", "Dúvida"], ["compra", "Compra"], ["problema", "Problema"]];
  var STATUS = [["novo", "Novo"], ["analise", "Em análise"], ["roadmap", "No roadmap"], ["entregue", "Entregue"], ["descartado", "Descartado"]];
  var SOURCES = [["caixinha", "Caixinha"], ["comentario", "Comentário"], ["direct", "Direct"], ["enquete", "Enquete"], ["outro", "Outro"]];
  var COLS = "id, source, tool, kind, status, text, author, note, said_at, ig_permalink, created_at, created_by, updated_at, updated_by";

  var A = null;
  var S = { ready: false, rows: [], status: "", tool: "", kind: "", q: "", edit: null, busy: {} };

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function label(list, v) { for (var i = 0; i < list.length; i++) if (list[i][0] === v) return list[i][1]; return v || ""; }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }) : ""; }
  function fmtDateTime(iso) { return iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : ""; }
  function today() { return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }); }
  function byId(id) { return S.rows.filter(function (r) { return r.id === id; })[0]; }
  function options(list, sel) { return list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === sel ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join(""); }

  /* ---------------- dados ---------------- */
  // Cache da aba: ao voltar para a tela mostra na hora o que já tinha e atualiza por trás.
  function cacheKey() { return "flow_ideas_cache_v1:" + ((window.FlowAccess && window.FlowAccess.email()) || ""); }
  function cacheRead() { try { return JSON.parse(sessionStorage.getItem(cacheKey()) || "null"); } catch (e) { return null; } }
  function cacheWrite() { try { sessionStorage.setItem(cacheKey(), JSON.stringify(S.rows)); } catch (e) {} }

  async function load() {
    var r = await A.sb.from("user_ideas").select(COLS).order("said_at", { ascending: false }).limit(2000);
    if (r.error) throw r.error;
    S.rows = r.data || [];
  }

  function match(r) {
    if (S.status && r.status !== S.status) return false;
    if (S.tool && r.tool !== S.tool) return false;
    if (S.kind && r.kind !== S.kind) return false;
    var q = S.q.trim().toLowerCase();
    if (q && (r.text + " " + (r.author || "") + " " + (r.note || "")).toLowerCase().indexOf(q) < 0) return false;
    return true;
  }

  /* ---------------- esqueleto ---------------- */
  function build(root) {
    root.innerHTML =
      '<section class="ch-hero ui-hero">' +
        '<div class="ch-hero-main"><div class="ch-kicker">Ideias Usuários</div><h3 class="ch-title">O que o público pede para as ferramentas</h3>' +
          '<p class="ch-sub">Pedidos, sugestões e dúvidas sobre FlowSpy, FlowPages e FlowTracking, para decidir o que entra nas ferramentas. Comentários do Instagram entram sozinhos; respostas da caixinha, do Direct e de enquetes são registradas aqui pela equipe. Mude o status de cada pedido conforme ele avança.</p></div>' +
        '<div class="ch-hero-acts"><button type="button" class="btn btn-primary" data-act="new">+ Registrar pedido</button></div>' +
      "</section>" +
      '<div class="ui-tiles" id="ui-tiles"></div>' +
      '<div class="ui-filters">' +
        '<div class="ch-tabs" id="ui-status" role="tablist" aria-label="Status"></div>' +
        '<div class="ui-row"><div class="ch-tabs" id="ui-tool" role="tablist" aria-label="Ferramenta"></div>' +
        '<select id="ui-kind" aria-label="Tipo"></select>' +
        '<input type="search" id="ui-q" placeholder="Buscar pedido…" aria-label="Buscar pedido"></div>' +
      "</div>" +
      '<div class="ui-list" id="ui-list"></div>' +
      '<div class="ig-drawer-back" id="ui-back" hidden></div>' +
      '<aside class="ig-drawer ui-drawer" id="ui-drawer" hidden aria-label="Pedido"></aside>';

    $("ui-q").addEventListener("input", function (e) { S.q = e.target.value; renderList(); });
    $("ui-kind").addEventListener("change", function (e) { S.kind = e.target.value; render(); });
    $("ui-back").addEventListener("click", closeDrawer);
    root.addEventListener("click", onClick);
    root.addEventListener("change", function (e) {
      var sel = e.target.closest("select[data-quick]");
      if (sel) quick(sel.getAttribute("data-id"), sel.getAttribute("data-quick"), sel.value);
    });
    root.addEventListener("submit", function (e) { if (e.target.id === "ui-form") { e.preventDefault(); save(); } });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.edit) closeDrawer(); });
  }

  function onClick(e) {
    var el = e.target.closest("[data-act]");
    if (!el) return;
    var act = el.getAttribute("data-act"), id = el.getAttribute("data-id"), v = el.getAttribute("data-v");
    if (act === "status") { S.status = v; render(); }
    else if (act === "tool") { S.tool = v; render(); }
    else if (act === "new") openDrawer(null);
    else if (act === "edit") openDrawer(id);
    else if (act === "close") closeDrawer();
    else if (act === "delete") remove(id);
  }

  /* ---------------- desenho ---------------- */
  function render() { renderTop(); renderList(); }

  function renderTop() {
    var all = S.rows, n = function (f) { return all.filter(f).length; };
    var st = function (s) { return n(function (r) { return r.status === s; }); };
    var ideas = n(function (r) { return r.kind === "ideia"; });
    var month = n(function (r) { return Date.now() - Date.parse(r.said_at) < 30 * 864e5; });
    $("ui-tiles").innerHTML =
      tile("Pedidos", all.length, ideas + " ideias de recurso · " + month + " nos últimos 30 dias", "") +
      tile("Novos", st("novo"), st("novo") ? "ainda ninguém analisou" : "tudo analisado", "novo") +
      tile("Em análise", st("analise"), "sendo avaliados", "analise") +
      tile("No roadmap", st("roadmap"), "vão entrar nas ferramentas", "roadmap") +
      tile("Entregues", st("entregue"), "já estão nas ferramentas", "entregue");

    var counts = { "": all.length };
    STATUS.forEach(function (s) { counts[s[0]] = st(s[0]); });
    $("ui-status").innerHTML = [["", "Todos"]].concat(STATUS).map(function (s) {
      return '<button type="button" class="btn' + (S.status === s[0] ? " btn-primary" : "") + '" data-act="status" data-v="' + s[0] + '">' + esc(s[1]) + " · " + counts[s[0]] + "</button>";
    }).join("");
    $("ui-tool").innerHTML = [["", "Todas"]].concat(TOOLS).map(function (t) {
      var c = t[0] ? n(function (r) { return r.tool === t[0]; }) : all.length;
      return '<button type="button" class="btn' + (S.tool === t[0] ? " btn-primary" : "") + '" data-act="tool" data-v="' + t[0] + '">' + esc(t[1]) + " · " + c + "</button>";
    }).join("");
    $("ui-kind").innerHTML = '<option value="">Todos os tipos</option>' + KINDS.map(function (k) {
      return '<option value="' + k[0] + '"' + (S.kind === k[0] ? " selected" : "") + ">" + esc(k[1]) + " (" + n(function (r) { return r.kind === k[0]; }) + ")</option>";
    }).join("");
  }
  function tile(lbl, value, sub, status) {
    var clickable = status !== "";
    return '<button type="button" class="ig-tile' + (clickable && S.status === status ? " on" : "") + '"' + (clickable ? ' data-act="status" data-v="' + status + '"' : " disabled") + ">" +
      "<small>" + esc(lbl) + '</small><b class="num">' + value + "</b><span>" + esc(sub) + "</span></button>";
  }

  function renderList() {
    var list = S.rows.filter(match);
    if (!S.rows.length) { $("ui-list").innerHTML = '<div class="panel ig-empty">Nenhum pedido ainda. Use <b>+ Registrar pedido</b> para anotar o que chegou pela caixinha ou pelo Direct.</div>'; return; }
    if (!list.length) { $("ui-list").innerHTML = '<div class="panel ig-empty">Nada com esses filtros.</div>'; return; }
    $("ui-list").innerHTML = list.map(function (r) {
      var busy = S.busy[r.id];
      return '<article class="ui-card st-' + r.status + '">' +
        '<div class="ui-card-main">' +
          '<div class="ig-card-top"><span class="ig-tool">' + esc(r.tool) + '</span><span class="ig-type k-' + r.kind + '">' + esc(label(KINDS, r.kind)) + "</span>" +
            '<span class="ui-src">' + esc(label(SOURCES, r.source)) + "</span></div>" +
          '<p class="ui-text">' + esc(r.text) + "</p>" +
          (r.note ? '<p class="ui-note"><b>Equipe:</b> ' + esc(r.note) + "</p>" : "") +
          '<div class="ui-meta">' + esc(fmtDate(r.said_at)) + (r.author ? " · " + esc(r.author) : "") +
            (r.ig_permalink ? ' · <a href="' + esc(r.ig_permalink) + '" target="_blank" rel="noopener">ver no Instagram ↗</a>' : "") + "</div>" +
        "</div>" +
        '<div class="ui-card-side">' +
          '<select class="ui-status-sel s-' + r.status + '" data-quick="status" data-id="' + r.id + '" aria-label="Status do pedido"' + (busy ? " disabled" : "") + ">" + options(STATUS, r.status) + "</select>" +
          '<button type="button" class="btn btn-ghost ui-edit" data-act="edit" data-id="' + r.id + '">Editar</button>' +
        "</div>" +
      "</article>";
    }).join("");
  }

  /* ---------------- formulário ---------------- */
  function openDrawer(id) {
    var r = id ? byId(id) : null;
    S.edit = id || "new";
    var d = r ? new Date(r.said_at).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }) : today();
    $("ui-drawer").innerHTML =
      '<div class="ig-d-head"><div><div class="ch-kicker">' + (r ? "Editar pedido" : "Registrar pedido") + "</div>" +
        "<h3>" + (r ? "Pedido de " + esc(fmtDate(r.said_at)) : "O que o público pediu?") + "</h3>" +
        (r ? '<div class="ig-orig">Registrado por ' + esc(r.created_by || "—") + " em " + esc(fmtDateTime(r.created_at)) +
          (r.updated_at ? " · alterado por " + esc(r.updated_by || "—") + " em " + esc(fmtDateTime(r.updated_at)) : "") + "</div>" : "") + "</div>" +
        '<button type="button" class="btn btn-ghost ig-x" data-act="close" aria-label="Fechar">✕</button></div>' +
      '<form id="ui-form" class="ui-form">' +
        '<label class="ui-full">Pedido, ideia ou dúvida<textarea id="ui-f-text" rows="5" required maxlength="4000" placeholder="Cole aqui o que a pessoa escreveu">' + esc(r ? r.text : "") + "</textarea></label>" +
        '<label>Ferramenta<select id="ui-f-tool">' + options(TOOLS, r ? r.tool : "Geral") + "</select></label>" +
        '<label>Tipo<select id="ui-f-kind">' + options(KINDS, r ? r.kind : "ideia") + "</select></label>" +
        '<label>Origem<select id="ui-f-source">' + options(SOURCES, r ? r.source : "caixinha") + "</select></label>" +
        '<label>Status<select id="ui-f-status">' + options(STATUS, r ? r.status : "novo") + "</select></label>" +
        '<label>Quem pediu (opcional)<input id="ui-f-author" maxlength="120" placeholder="@usuario" value="' + esc(r ? r.author || "" : "") + '"></label>' +
        '<label>Data do pedido<input type="date" id="ui-f-date" required value="' + d + '" max="' + today() + '"></label>' +
        '<label class="ui-full">Observação da equipe (opcional)<textarea id="ui-f-note" rows="3" maxlength="2000" placeholder="Ex.: já está no card X do Trello; combinar com a Biancode">' + esc(r ? r.note || "" : "") + "</textarea></label>" +
        '<div class="ui-full ui-form-acts">' +
          (r ? '<button type="button" class="btn btn-ghost ui-del" data-act="delete" data-id="' + r.id + '">Excluir pedido</button>' : "<span></span>") +
          '<div><button type="button" class="btn" data-act="close">Cancelar</button> <button type="submit" class="btn btn-primary" id="ui-save">' + (r ? "Salvar" : "Registrar") + "</button></div>" +
        "</div>" +
      "</form>";
    $("ui-drawer").hidden = false; $("ui-back").hidden = false;
    $("ui-f-text").focus();
  }
  function closeDrawer() { S.edit = null; if ($("ui-drawer")) { $("ui-drawer").hidden = true; $("ui-back").hidden = true; } }

  async function save() {
    var text = $("ui-f-text").value.trim();
    if (!text) { A.toast("Escreva o pedido.", true); return; }
    var date = $("ui-f-date").value;
    var row = {
      text: text, tool: $("ui-f-tool").value, kind: $("ui-f-kind").value, source: $("ui-f-source").value, status: $("ui-f-status").value,
      author: $("ui-f-author").value.trim() || null, note: $("ui-f-note").value.trim() || null,
      said_at: date ? new Date(date + "T12:00:00-03:00").toISOString() : new Date().toISOString()
    };
    var id = S.edit !== "new" ? S.edit : null;
    if (id) { var old = byId(id); if (old && fmtDate(old.said_at) === fmtDate(row.said_at)) row.said_at = old.said_at; }
    $("ui-save").disabled = true;
    var r = id ? await A.sb.from("user_ideas").update(row).eq("id", id).select(COLS).single()
               : await A.sb.from("user_ideas").insert(row).select(COLS).single();
    if (r.error) { $("ui-save").disabled = false; A.toast("Não foi possível salvar: " + r.error.message, true); return; }
    if (id) S.rows = S.rows.map(function (x) { return x.id === id ? r.data : x; });
    else S.rows.unshift(r.data);
    S.rows.sort(function (a, b) { return Date.parse(b.said_at) - Date.parse(a.said_at); });
    closeDrawer(); render(); cacheWrite();
    A.toast(id ? "Pedido salvo." : "Pedido registrado.");
  }

  async function quick(id, field, value) {
    var r = byId(id);
    if (!r || S.busy[id]) return;
    var before = r[field];
    r[field] = value; S.busy[id] = true; render(); // otimista
    var res = await A.sb.from("user_ideas").update({ [field]: value }).eq("id", id).select(COLS).single();
    delete S.busy[id];
    if (res.error) { r[field] = before; render(); A.toast("Não foi possível salvar: " + res.error.message, true); return; }
    Object.assign(r, res.data); render(); cacheWrite();
    A.toast("Status: " + label(STATUS, value) + ".");
  }

  async function remove(id) {
    var r = byId(id);
    if (!r || !window.confirm("Excluir este pedido? Não dá para desfazer.")) return;
    var res = await A.sb.from("user_ideas").delete().eq("id", id);
    if (res.error) { A.toast("Não foi possível excluir: " + res.error.message, true); return; }
    S.rows = S.rows.filter(function (x) { return x.id !== id; });
    closeDrawer(); render(); cacheWrite();
    A.toast("Pedido excluído.");
  }

  /* ---------------- API pública ---------------- */
  async function show() {
    if (!A) return;
    try {
      if (!S.ready) {
        S.ready = true;
        var cached = cacheRead();
        if (Array.isArray(cached)) { S.rows = cached; render(); }
        else $("ui-list").innerHTML = '<div class="panel ig-empty">Carregando…</div>';
      }
      await load();
      render();
      cacheWrite();
    } catch (e) {
      console.warn("Ideias Usuários:", e);
      A.toast("Não foi possível carregar as ideias: " + (e.message || e), true);
    }
  }
  window.UserIdeas = {
    init: function (opts) { A = opts; build(opts.root); },
    show: show,
    hide: closeDrawer
  };
})();
