/* @useaflow (menu do Financeiro): tudo da conta da Flow num lugar só.
   Abas Desempenho, Stories, Comentários e Direct (assets/instagram-perf.js, menu fin.instagram) e Ideias dos usuários
   (assets/user-ideas.js, menu fin.ideias). Cada aba só aparece para quem tem o menu dela.
   Uso: Useaflow.init({ root, sb, toast, url }); Useaflow.show(tab?); */
(function () {
  "use strict";

  var TABS = [
    ["desempenho", "Desempenho", "fin.instagram"],
    ["stories", "Stories", "fin.instagram"],
    ["comentarios", "Comentários", "fin.instagram"],
    ["direct", "Direct", "fin.instagram"],
    ["ideias", "Ideias dos usuários", "fin.ideias"]
  ];
  var A = null, current = null;

  function $(id) { return document.getElementById(id); }
  function can(key) { return !window.FlowAccess || !window.FlowAccess.can || window.FlowAccess.can(key); }
  function allowed() { return TABS.filter(function (t) { return can(t[2]); }); }
  function saved() { try { return sessionStorage.getItem("flow_useaflow_tab_v1"); } catch (e) { return null; } }

  function build(root) {
    root.innerHTML =
      '<div class="ch-tabs ig-sections" id="ua-tabs" role="tablist" aria-label="@useaflow"></div>' +
      '<div id="ua-pane-perf" hidden></div>' +
      '<div id="ua-pane-ideas" hidden></div>';
    $("ua-tabs").addEventListener("click", function (e) {
      var b = e.target.closest("[data-ua]");
      if (b) show(b.getAttribute("data-ua"));
    });
    if (window.InstagramPerf) window.InstagramPerf.init({ root: $("ua-pane-perf"), sb: A.sb, toast: A.toast, url: A.url });
    if (window.UserIdeas) window.UserIdeas.init({ root: $("ua-pane-ideas"), sb: A.sb, toast: A.toast });
  }

  function show(tab) {
    if (!A) return;
    var list = allowed();
    if (!list.length) return;
    var pick = list.filter(function (t) { return t[0] === (tab || current || saved()); })[0] || list[0];
    current = pick[0];
    try { sessionStorage.setItem("flow_useaflow_tab_v1", current); } catch (e) {}
    $("ua-tabs").innerHTML = list.map(function (t) {
      return '<button type="button" role="tab" aria-selected="' + (t[0] === current) + '" class="btn' + (t[0] === current ? " btn-primary" : "") + '" data-ua="' + t[0] + '">' + t[1] + "</button>";
    }).join("");
    var ideas = current === "ideias";
    $("ua-pane-perf").hidden = ideas;
    $("ua-pane-ideas").hidden = !ideas;
    if (ideas) { if (window.UserIdeas) window.UserIdeas.show(); }
    else { if (window.UserIdeas) window.UserIdeas.hide(); if (window.InstagramPerf) window.InstagramPerf.show(current); }
  }

  window.Useaflow = {
    init: function (opts) { A = opts; build(opts.root); },
    show: show,
    hide: function () { if (window.UserIdeas) window.UserIdeas.hide(); }
  };
})();
