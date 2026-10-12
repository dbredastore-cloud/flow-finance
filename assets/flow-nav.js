/* Menu lateral padrão dos painéis (Financeiro, Afiliados e Equipe).
   - Troca <i data-ic="nome"> pelo ícone em SVG (mesmo traço em todas as telas).
   - Mostra a inicial do e-mail no avatar do rodapé (acompanha o texto de #user-email).
   Estilos: assets/flow-nav.css. */
window.FlowNav = (function () {
  var P = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14.5c2.6.2 4.5 2.4 4.5 5"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8z"/>',
    box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    play: '<rect x="3" y="5" width="18" height="14" rx="4"/><path d="M10 9.5v5l4.5-2.5z"/>',
    radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l6-6"/>',
    wallet: '<path d="M4 7a2 2 0 012-2h12v3"/><rect x="3" y="7" width="18" height="13" rx="2.5"/><circle cx="16.5" cy="13.5" r="1.2"/>',
    chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 15l3.5-4 3 2.5L19 8"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    heart: '<path d="M12 20s-8-5-8-11a4.5 4.5 0 018-2.5A4.5 4.5 0 0120 9c0 6-8 11-8 11z"/>',
    logout: '<path d="M9 4H5a2 2 0 00-2 2v12a2 2 0 002 2h4"/><path d="M16 8l4 4-4 4M20 12H9"/>'
  };
  function icon(name) {
    return '<svg class="fnav-svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || "") + "</svg>";
  }
  function hydrate(root) {
    (root || document).querySelectorAll("i[data-ic]").forEach(function (el) {
      el.outerHTML = '<span class="fnav-ic">' + icon(el.getAttribute("data-ic")) + "</span>";
    });
  }
  function watchUser() {
    var email = document.getElementById("user-email"), av = document.getElementById("user-avatar");
    if (!email || !av) return;
    function sync() { var t = (email.textContent || "").trim(); av.textContent = t ? t.charAt(0).toUpperCase() : "·"; }
    sync();
    new MutationObserver(sync).observe(email, { childList: true, characterData: true, subtree: true });
  }
  function init() { hydrate(); watchUser(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  return { icon: icon, hydrate: hydrate };
})();
