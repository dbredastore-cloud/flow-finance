/* Kit visual HUD (futurista) para os gráficos de /financeiro/ e /afiliados/.
   Só gera pedaços de SVG; cada gráfico decide onde usar. Cores vêm dos tokens do tema (flow-theme.css),
   então vale para o modo escuro e o claro. Estilos: assets/flow-hud.css. */
window.FlowHud = (function () {
  var seq = 0;
  function tok(k) { return getComputedStyle(document.documentElement).getPropertyValue(k).trim(); }
  function id(prefix) { return prefix + (++seq); }
  function n1(v) { return Math.round(v * 10) / 10; }

  /* Estilo minimalista: linhas suaves, áreas em degradê leve, grade fina e barras arredondadas.
     seg/hatch/ruler existem só por compatibilidade com os gráficos antigos e agora não desenham nada visível. */

  // Máscara neutra (tudo visível): as barras deixam de ser empilhadas em blocos.
  function seg(maskId, W, H) {
    return '<mask id="' + maskId + '" maskUnits="userSpaceOnUse" x="0" y="0" width="' + W + '" height="' + H + '"><rect width="' + W + '" height="' + H + '" fill="#fff"/></mask>';
  }

  // Sem hachura.
  function hatch(patId) {
    return '<pattern id="' + patId + '" width="4" height="4" patternUnits="userSpaceOnUse"/>';
  }

  /* Degradê vertical suave (barras: cor firme no alto, um pouco mais leve embaixo). */
  function vgrad(gradId, color, topOpacity, bottomOpacity) {
    var top = topOpacity == null ? 1 : topOpacity, bottom = bottomOpacity == null ? 0.55 : bottomOpacity;
    return '<linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + color + '" stop-opacity="' + Math.min(top, 0.95) + '"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="' + Math.max(bottom, 0.6) + '"/></linearGradient>';
  }

  /* Área sob a linha: a cor some devagar até o fundo (como nos painéis de referência). */
  function area(gradId, color, topOpacity) {
    return '<linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + color + '" stop-opacity="' + (topOpacity == null ? 0.2 : topOpacity) + '"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient>';
  }

  /* Curva suave passando pelos pontos [[x, y], …] (Catmull-Rom → Bézier). */
  function smooth(pts) {
    if (!pts.length) return "";
    var d = "M" + n1(pts[0][0]) + "," + n1(pts[0][1]);
    if (pts.length === 1) return d;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      // A altura dos pontos de controle fica entre os dois pontos vizinhos: a curva não "passa" do valor máximo/mínimo (nem abaixo do zero).
      var lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]);
      var c1y = Math.max(lo, Math.min(hi, p1[1] + (p2[1] - p0[1]) / 6)), c2y = Math.max(lo, Math.min(hi, p2[1] - (p3[1] - p1[1]) / 6));
      d += " C" + n1(p1[0] + (p2[0] - p0[0]) / 6) + "," + n1(c1y) + " " + n1(p2[0] - (p3[0] - p1[0]) / 6) + "," + n1(c2y) + " " + n1(p2[0]) + "," + n1(p2[1]);
    }
    return d;
  }

  /* Sem régua no eixo. */
  function ruler() { return ""; }
  /* Gauge circular: anel de marcas + arco de progresso com brilho + valor no centro.
     opts: { pct 0–100, color, size, label, text } */
  function ring(opts) {
    var s = opts.size || 92, c = s / 2, pct = Math.max(0, Math.min(100, Number(opts.pct) || 0));
    var color = opts.color || tok("--accent"), ticks = opts.ticks || 44;
    var rOut = c - 1.5, rIn = c - 6.5, r = c - 14.5, circ = 2 * Math.PI * r;
    var out = '<svg class="hud-ring" width="' + s + '" height="' + s + '" viewBox="0 0 ' + s + " " + s + '" role="img" aria-label="' + String(opts.label || "") + " " + Math.round(pct) + '%">';
    for (var i = 0; i < ticks; i++) {
      var a = (-90 + (i * 360) / ticks) * Math.PI / 180, on = ((i + 0.5) / ticks) * 100 <= pct;
      out += '<line x1="' + n1(c + Math.cos(a) * rIn) + '" y1="' + n1(c + Math.sin(a) * rIn) + '" x2="' + n1(c + Math.cos(a) * rOut) + '" y2="' + n1(c + Math.sin(a) * rOut) + '" ' +
        (on ? 'stroke="' + color + '" stroke-width="2"' : 'style="stroke:var(--border-strong)" stroke-width="1.4"') + ' stroke-linecap="round"/>';
    }
    out += '<circle cx="' + c + '" cy="' + c + '" r="' + n1(r) + '" fill="none" style="stroke:var(--track-bg)" stroke-width="5"/>';
    if (pct > 0) out += '<circle class="hud-glow" cx="' + c + '" cy="' + c + '" r="' + n1(r) + '" fill="none" stroke="' + color + '" style="color:' + color + '" stroke-width="5" stroke-linecap="round" stroke-dasharray="' + n1(circ * pct / 100) + " " + n1(circ) + '" transform="rotate(-90 ' + c + " " + c + ')"/>';
    out += '<text class="hud-ring-v" x="' + c + '" y="' + (c + (opts.sub ? 1 : 5)) + '" text-anchor="middle">' + (opts.text != null ? opts.text : Math.round(pct) + "%") + "</text>";
    if (opts.sub) out += '<text class="hud-ring-s" x="' + c + '" y="' + (c + 14) + '" text-anchor="middle">' + opts.sub + "</text>";
    return out + "</svg>";
  }

  return { tok: tok, id: id, seg: seg, hatch: hatch, vgrad: vgrad, area: area, smooth: smooth, ruler: ruler, ring: ring };
})();
