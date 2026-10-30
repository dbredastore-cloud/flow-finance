/* Acesso por menu (Financeiro, Afiliados e Equipe).
   Perfil de quem está logado vem de public.my_access(): role "admin" (tudo + Equipe), "partner" (login de afiliado:
   só o Portal do afiliado em /parceiro/) ou "custom" (só os menus
   liberados). As regras do banco (migration 20261015_menu_access.sql) garantem o mesmo nos dados; aqui o painel
   só esconde o que a pessoa não pode abrir.
   Marcação no HTML: data-menu="fin.health" (item de menu), data-page="afiliados" (link para outro painel),
   data-admin-only (só perfil admin).
   Uso: await FlowAccess.load(sb); FlowAccess.apply(); FlowAccess.can("fin.trello"); */
window.FlowAccess = (function () {
  "use strict";

  // Mesmas chaves da migration e da Edge Function team-admin. Uma chave pode ficar em outro painel que
  // não o do prefixo (ex.: fin.hours está no Biancode, fin.instagram nos Afiliados): o prefixo só nomeia.
  var CATALOG = [
    { page: "financeiro", label: "Financeiro", href: "../financeiro/", menus: [
      ["fin.financeiro", "Home e ferramentas"],
      ["fin.avisos", "Avisos (alertas e resumo da IA)"],
      ["fin.health", "Flow Health"],
      ["fin.clients", "Saúde dos clientes"]
    ] },
    { page: "afiliados", label: "Afiliados", href: "../afiliados/", menus: [
      ["af.overview", "Visão geral"],
      ["af.base", "Afiliados"],
      ["af.flowinf", "Influencers Flow"],
      ["af.products", "Produtos"],
      ["af.youtube", "YouTube"],
      ["af.mercado", "Rastrear Mercado"],
      ["af.favoritos", "Canais favoritos"],
      ["fin.instagram", "Instagram (@useaflow, pautas e radar)"],
      ["fin.ideias", "Ideias dos usuários (aba do @useaflow)"]
    ] },
    { page: "biancode", label: "Biancode", href: "../biancode/", menus: [
      ["fin.hours", "Horas de dev."],
      ["fin.trello", "Cards Trello"]
    ] }
  ];

  var me = null; // { role, menus, email }

  // Com o perfil já guardado nesta aba (mesmo usuário), a página abre sem esperar a consulta; o perfil é
  // conferido por trás e, se mudou (ex.: admin alterou os menus), a página recarrega. A proteção dos dados
  // não depende disso: as regras do banco valem sempre.
  async function load(sb, uid) {
    var key = "flow_access_v1:" + (uid || "");
    var cached = null;
    try { cached = uid ? JSON.parse(sessionStorage.getItem(key) || "null") : null; } catch (e) {}
    var fresh = sb.rpc("my_access").then(function (r) {
      if (r.error) throw r.error;
      var v = r.data || null; // null = conta sem acesso aos painéis
      try { if (uid) sessionStorage.setItem(key, JSON.stringify({ v: v })); } catch (e) {}
      return v;
    });
    if (cached && cached.v) {
      me = cached.v;
      fresh.then(function (v) { if (JSON.stringify(v) !== JSON.stringify(me)) location.reload(); }).catch(function () {});
      return me;
    }
    me = await fresh;
    return me;
  }
  function email() { return me ? me.email : null; }
  function has() { return !!me; }
  function isAdmin() { return !!me && me.role === "admin"; }
  function isPartner() { return !!me && me.role === "partner"; }
  function can(key) { return !!me && (me.role === "admin" || (me.menus || []).indexOf(key) >= 0); }
  function pageOf(page) { return CATALOG.filter(function (p) { return p.page === page; })[0]; }
  function allowed(page) { var p = pageOf(page); return p ? p.menus.filter(function (m) { return can(m[0]); }).map(function (m) { return m[0]; }) : []; }
  function canPage(page) { return allowed(page).length > 0; }
  // Primeiro painel liberado (para mandar a pessoa para onde ela pode entrar).
  function firstHref() {
    if (isPartner()) return "../parceiro/"; // login de afiliado: só o Portal do afiliado
    var p = CATALOG.filter(function (x) { return canPage(x.page); })[0];
    return p ? p.href : null;
  }
  function label(key) {
    for (var i = 0; i < CATALOG.length; i++) for (var j = 0; j < CATALOG[i].menus.length; j++) if (CATALOG[i].menus[j][0] === key) return CATALOG[i].menus[j][1];
    return key;
  }

  function apply(root) {
    root = root || document;
    root.querySelectorAll("[data-menu]").forEach(function (el) { el.hidden = !can(el.getAttribute("data-menu")); });
    // data-menu-any="a,b": aparece para quem tem qualquer um dos menus.
    root.querySelectorAll("[data-menu-any]").forEach(function (el) { el.hidden = !el.getAttribute("data-menu-any").split(",").some(can); });
    root.querySelectorAll("[data-page]").forEach(function (el) { el.hidden = !canPage(el.getAttribute("data-page")); });
    root.querySelectorAll("[data-admin-only]").forEach(function (el) { el.hidden = !isAdmin(); });
    // Título de grupo do menu sem nenhum item visível some junto.
    root.querySelectorAll(".fnav-group").forEach(function (g) {
      var n = g.nextElementSibling, any = false;
      while (n && !n.classList.contains("fnav-group")) { if (!n.hidden) { any = true; break; } n = n.nextElementSibling; }
      g.hidden = !any;
    });
  }

  return { CATALOG: CATALOG, load: load, email: email, has: has, isAdmin: isAdmin, isPartner: isPartner, can: can, canPage: canPage, allowed: allowed, firstHref: firstHref, label: label, apply: apply };
})();
