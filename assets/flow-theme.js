/* Modo claro/escuro da plataforma inteira (raiz, /financeiro/ e /afiliados/).
   - Aplica a preferência salva antes da página aparecer (sem piscar).
   - Preferência guardada em localStorage["ff-theme"] ("dark" | "light"), a mesma chave em todas as páginas.
   - Botão fixo no canto inferior direito; avisa as páginas com o evento "flow-theme-change"
     para redesenharem os gráficos com as cores do novo modo. */
(function () {
  var KEY = "ff-theme";
  var root = document.documentElement;

  function stored() {
    try { var t = localStorage.getItem(KEY); return t === "light" || t === "dark" ? t : null; } catch (e) { return null; }
  }
  function current() { return root.getAttribute("data-theme") === "light" ? "light" : "dark"; }
  function apply(t) { root.setAttribute("data-theme", t); }

  apply(stored() || "dark");

  var btn = null;
  var SUN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function syncButton() {
    if (!btn) return;
    var light = current() === "light";
    // O botão mostra o modo para o qual ele vai trocar.
    btn.innerHTML = (light ? MOON : SUN) + "<span>" + (light ? "Modo escuro" : "Modo claro") + "</span>";
    btn.setAttribute("aria-label", light ? "Mudar para o modo escuro" : "Mudar para o modo claro");
    btn.title = btn.getAttribute("aria-label");
  }

  function announce(t) {
    try { window.dispatchEvent(new CustomEvent("flow-theme-change", { detail: { theme: t } })); } catch (e) {}
  }

  function set(t) {
    try { localStorage.setItem(KEY, t); } catch (e) {}
    apply(t);
    syncButton();
    announce(t);
  }

  window.flowTheme = { get: current, set: set, toggle: function () { set(current() === "light" ? "dark" : "light"); } };

  // Outra aba mudou o modo: acompanha.
  window.addEventListener("storage", function (e) {
    if (e.key === KEY && (e.newValue === "light" || e.newValue === "dark") && e.newValue !== current()) {
      apply(e.newValue); syncButton(); announce(e.newValue);
    }
  });

  var CSS =
    "#flow-theme-toggle{position:fixed;right:16px;bottom:16px;z-index:9999;display:inline-flex;align-items:center;gap:8px;" +
    "padding:9px 14px;border-radius:999px;font:600 12.5px/1 var(--font-body,Inter,system-ui,sans-serif);cursor:pointer;" +
    "background:var(--surface-solid,var(--s1,#fff));color:var(--text,#111);border:1px solid var(--border-strong,var(--line2,#888));" +
    "box-shadow:0 6px 20px -8px rgba(0,0,0,.45);transition:border-color .15s,box-shadow .15s}" +
    "#flow-theme-toggle:hover{border-color:var(--accent,var(--brand,#0a7d45))}" +
    "#flow-theme-toggle:focus-visible{outline:2px solid var(--accent,var(--brand,#0a7d45));outline-offset:2px}" +
    "#flow-theme-toggle svg{flex:none}" +
    "@media (max-width:520px){#flow-theme-toggle{right:12px;bottom:12px;padding:10px}#flow-theme-toggle span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}}";

  function build() {
    if (document.getElementById("flow-theme-toggle")) return;
    var st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
    btn = document.createElement("button");
    btn.id = "flow-theme-toggle";
    btn.type = "button";
    btn.addEventListener("click", function () { window.flowTheme.toggle(); });
    document.body.appendChild(btn);
    syncButton();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
