/* Acesso por menu (Financeiro, Afiliados e Equipe).
   Perfil de quem está logado vem de public.my_access(): role "admin" (tudo + Equipe) ou "custom" (só os menus
   liberados). As regras do banco (migration 20261015_menu_access.sql) garantem o mesmo nos dados; aqui o painel
   só esconde o que a pessoa não pode abrir.
   Marcação no HTML: data-menu="fin.health" (item de menu), data-page="afiliados" (link para outro painel),
   data-admin-only (só perfil admin).
   Uso: await FlowAccess.load(sb); FlowAccess.apply(); FlowAccess.can("fin.trello"); */
window.FlowAccess = (function () {
  "use strict";

  // Mesmas chaves da migration e da Edge Function team-admin.
  var CATALOG = [
    { page: "financeiro", label: "Financeiro", href: "../financeiro/", menus: [
      ["fin.financeiro", "Home e ferramentas"],
      ["fin.health", "Flow Health"],
      ["fin.clients", "Saúde dos clientes"],
      ["fin.hours", "Horas de dev."],
      ["fin.trello", "Cards Trello"]
    ] },
    { page: "afiliados", label: "Afiliados", href: "../afiliados/", menus: [
      ["af.overview", "Visão geral"],
      ["af.base", "Influencers"],
      ["af.flowinf", "Influencers Flow"],
      ["af.products", "Produtos"],
      ["af.youtube", "YouTube"],
      ["af.mercado", "Rastrear Mercado"]
    ] }
  ];

  var me = null; // { role, menus, email }

  async function load(sb) {
    var r = await sb.rpc("my_access");
    if (r.error) throw r.error;
    me = r.data || null; // null = conta sem acesso aos painéis
    return me;
  }
  function has() { return !!me; }
  function isAdmin() { return !!me && me.role === "admin"; }
  function can(key) { return !!me && (me.role === "admin" || (me.menus || []).indexOf(key) >= 0); }
  function pageOf(page) { return CATALOG.filter(function (p) { return p.page === page; })[0]; }
  function allowed(page) { var p = pageOf(page); return p ? p.menus.filter(function (m) { return can(m[0]); }).map(function (m) { return m[0]; }) : []; }
  function canPage(page) { return allowed(page).length > 0; }
  // Primeiro painel liberado (para mandar a pessoa para onde ela pode entrar).
  function firstHref() {
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
    root.querySelectorAll("[data-page]").forEach(function (el) { el.hidden = !canPage(el.getAttribute("data-page")); });
    root.querySelectorAll("[data-admin-only]").forEach(function (el) { el.hidden = !isAdmin(); });
    // Título de grupo do menu sem nenhum item visível some junto.
    root.querySelectorAll(".fnav-group").forEach(function (g) {
      var n = g.nextElementSibling, any = false;
      while (n && !n.classList.contains("fnav-group")) { if (!n.hidden) { any = true; break; } n = n.nextElementSibling; }
      g.hidden = !any;
    });
  }

  return { CATALOG: CATALOG, load: load, has: has, isAdmin: isAdmin, can: can, canPage: canPage, allowed: allowed, firstHref: firstHref, label: label, apply: apply };
})();
