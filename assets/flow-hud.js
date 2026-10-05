/* Kit visual HUD (futurista) para os gráficos de /financeiro/ e /afiliados/.
   Só gera pedaços de SVG; cada gráfico decide onde usar. Cores vêm dos tokens do tema (flow-theme.css),
   então vale para o modo escuro e o claro. Estilos: assets/flow-hud.css. */
window.FlowHud = (function () {
  var seq = 0;
  function tok(k) { return getComputedStyle(document.documentElement).getPropertyValue(k).trim(); }
  function id(prefix) { return prefix + (++seq); }
  function n1(v) { return Math.round(v * 10) / 10; }

  /* Máscara de blocos: barras viram pilhas de segmentos, com frestas finas alinhadas à linha de base.
     Uso: defs += FlowHud.seg("sg1", W, H, baseY); elemento com mask="url(#sg1)". */
  function seg(maskId, W, H, baseY, size) {
    size = size || 6;
    var off = ((baseY % size) + size) % size;
    return '<pattern id="' + maskId + 'p" width="10" height="' + size + '" patternUnits="userSpaceOnUse" patternTransform="translate(0 ' + n1(off) + ')">' +
      '<rect width="10" height="' + size + '" fill="#fff"/><rect width="10" height="1.8" fill="#000"/></pattern>' +
      '<mask id="' + maskId + '" maskUnits="userSpaceOnUse" x="0" y="0" width="' + W + '" height="' + H + '"><rect width="' + W + '" height="' + H + '" fill="url(#' + maskId + 'p)"/></mask>';
  }

  /* Hachura diagonal (área sob a linha, como nas referências). */
  function hatch(patId, color, opacity) {
    return '<pattern id="' + patId + '" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<line x1="0" y1="0" x2="0" y2="7" stroke="' + color + '" stroke-width="1.3" stroke-opacity="' + (opacity == null ? 0.42 : opacity) + '"/></pattern>';
  }

  /* Degradê vertical: cor viva no alto, mais suave embaixo (mantém os blocos visíveis). */
  function vgrad(gradId, color, topOpacity, bottomOpacity) {
    return '<linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + color + '" stop-opacity="' + (topOpacity == null ? 1 : topOpacity) + '"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="' + (bottomOpacity == null ? 0.45 : bottomOpacity) + '"/></linearGradient>';
  }

  /* Régua no eixo: marcas pequenas a cada passo e maiores a cada `majorEvery`. */
  function ruler(x0, x1, y, count, majorEvery, color) {
    var out = "", step = count > 0 ? (x1 - x0) / count : 0;
    for (var i = 0; i <= count; i++) {
      var x = x0 + step * i, major = majorEvery && i % majorEvery === 0;
      out += '<line x1="' + n1(x) + '" x2="' + n1(x) + '" y1="' + y + '" y2="' + (y + (major ? 6 : 3.5)) + '" stroke="' + color + '" stroke-opacity="' + (major ? 0.9 : 0.5) + '" stroke-width="1"/>';
    }
    return out;
  }

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

  return { tok: tok, id: id, seg: seg, hatch: hatch, vgrad: vgrad, ruler: ruler, ring: ring };
})();
