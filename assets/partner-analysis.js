/* Sua análise (Portal do Afiliado, topo de Resultados).
   Texto escrito pelo Claude para cada influencer contratado (tarefa agendada "Análise e Avisos FlowFinance", tabela
   partner_analyses) + números de agora calculados pelo banco (influencer_analysis_facts): vendas e comissão do mês,
   meta do bônus, entregas do contrato, YouTube e Instagram. Tudo vem da função portal_analysis, que descobre o
   afiliado pelo login. Usa as classes visuais de fin-analysis.css (mesma leitura em camadas da Home do Financeiro).
   Uso: PartnerAnalysis.show({ root, load: fn() → {text, created_at, facts} }); */
window.PartnerAnalysis = (function () {
  "use strict";
  var S = { root: null, data: null, open: false };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function brl(v) { return v == null || isNaN(v) ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v); }
  function int(v) { return v == null || isNaN(v) ? "—" : new Intl.NumberFormat("pt-BR").format(v); }
  function when(iso) { return iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : ""; }
  function pill(a, b, invert) {
    if (a == null || b == null || !b) return '<span class="fa-pill flat">sem base</span>';
    var d = a / b - 1, flat = Math.abs(d) < 0.005, good = invert ? d < 0 : d > 0;
    return '<span class="fa-pill ' + (flat ? "flat" : good ? "up" : "down") + '">' + (flat ? "＝" : d > 0 ? "▲" : "▼") + " " + (d > 0 ? "+" : "") + (d * 100).toFixed(1).replace(".", ",") + "%</span>";
  }
  function rich(s) {
    return esc(s)
      .replace(/(-?R\$\s?-?[\d.]+(?:,\d{1,2})?)/g, '<b class="fa-money">$1</b>')
      .replace(/([+\-−]?\d+(?:,\d+)?%)/g, function (m) { return '<span class="fa-num ' + (/^[+]/.test(m) ? "up" : /^[-−]/.test(m) ? "down" : "") + '">' + m + "</span>"; });
  }
  function sections(text) {
    var out = [], cur = null;
    String(text || "").split(/\r?\n/).forEach(function (raw) {
      var l = raw.trim(); if (!l) return;
      var letters = l.replace(/[^A-Za-zÀ-ÿ]/g, "");
      if (!/^[•\-–]/.test(l) && letters.length > 3 && letters === letters.toUpperCase()) { cur = { title: l.replace(/:$/, ""), items: [] }; out.push(cur); return; }
      if (!cur) { cur = { title: "", items: [] }; out.push(cur); }
      cur.items.push(l.replace(/^[•\-–]\s*/, ""));
    });
    return out;
  }
  function starts(s, w) { return s.title.toUpperCase().indexOf(w) === 0; }
  // Barra de progresso com marca opcional (ritmo esperado).
  function bar(done, need, expected, cls) {
    var max = Math.max(need || 0, done || 0, 1), w = Math.min(100, (done || 0) / max * 100);
    var mark = expected != null && expected < need ? '<i class="pa-exp" style="left:' + (expected / max * 100).toFixed(1) + '%" title="esperado até hoje: ' + expected + '"></i>' : "";
    return '<div class="pa-bar ' + (cls || "") + '"><span style="width:' + w.toFixed(1) + '%"></span>' + mark + "</div>";
  }

  function hero(secs, f) {
    var r = secs.filter(function (s) { return starts(s, "RESUMO"); })[0];
    var items = r && r.items.length ? r.items.map(rich) : null;
    if (!items) {
      var v = (f.vendas || {}).mes_atual || {}, p = (f.vendas || {}).mes_anterior_mesmo_ponto || {};
      items = [esc(v.label || "Este mês") + ": " + int(v.vendas) + " vendas e <b class=\"fa-money\">" + brl(v.comissao) + "</b> de comissão " + pill(v.vendas, p.vendas) + " contra " + esc(p.label || "o mês anterior") + "."];
    }
    return '<div class="fa-hero"><div class="fa-kicker">Seu resumo</div><ul class="fa-head-list">' + items.map(function (t) { return "<li>" + t + "</li>"; }).join("") + "</ul></div>";
  }

  function cardSales(f) {
    var V = f.vendas || {}, a = V.mes_atual || {}, b = V.mes_anterior_mesmo_ponto || {};
    return '<article class="fa-card"><div class="fa-card-t">Suas vendas no mês</div><div class="fa-card-p">' + esc(a.label) + "</div>" +
      '<div class="fa-card-v"><b>' + int(a.vendas) + "</b>" + pill(a.vendas, b.vendas) + "</div>" +
      '<div class="fa-card-vs">vs ' + int(b.vendas) + " em " + esc(b.label) + "</div>" +
      '<dl class="fa-mini"><div><dt>Comissão</dt><dd>' + brl(a.comissao) + " " + pill(a.comissao, b.comissao) + "</dd></div>" +
      "<div><dt>Últimos 7 dias</dt><dd>" + int(V.ultimos_7_dias) + " " + pill(V.ultimos_7_dias, V["7_dias_anteriores"]) + "</dd></div>" +
      "<div><dt>Reembolsos</dt><dd>" + int(a.reembolsos) + "</dd></div></dl></article>";
  }
  function cardBonus(f) {
    var c = f.contrato;
    if (!c) return "";
    var pct = c.meta_bonus_vendas ? Math.min(100, c.vendas_no_contrato / c.meta_bonus_vendas * 100) : 0;
    var onTrack = c.projecao_vendas_ate_o_fim != null && c.projecao_vendas_ate_o_fim >= c.meta_bonus_vendas;
    return '<article class="fa-card"><div class="fa-card-t">Meta do bônus</div><div class="fa-card-p">' + int(c.meta_bonus_vendas) + " vendas no contrato = " + brl(c.bonus) + "</div>" +
      '<div class="fa-card-v"><b>' + int(c.vendas_no_contrato) + '</b><span class="pa-of">de ' + int(c.meta_bonus_vendas) + "</span></div>" +
      '<div class="pa-bar big ' + (onTrack ? "ok" : "") + '"><span style="width:' + pct.toFixed(1) + '%"></span></div>' +
      '<dl class="fa-mini"><div><dt>Faltam</dt><dd>' + int(c.falta_para_bonus) + " vendas</dd></div>" +
      (c.dias_restantes != null ? "<div><dt>Dias de contrato</dt><dd>" + int(c.dias_restantes) + " restantes</dd></div>" : "") +
      (c.vendas_por_dia_necessarias != null ? "<div><dt>Ritmo necessário</dt><dd>" + String(c.vendas_por_dia_necessarias).replace(".", ",") + " vendas/dia</dd></div>" : "") +
      (c.projecao_vendas_ate_o_fim != null ? "<div><dt>No ritmo atual</dt><dd>" + int(c.projecao_vendas_ate_o_fim) + ' vendas <span class="fa-pill ' + (onTrack ? "up" : "down") + '">' + (onTrack ? "bate a meta" : "abaixo da meta") + "</span></dd></div>" : "") +
      "</dl></article>";
  }
  function cardDeliv(f) {
    var d = (f.entregas || [])[0];
    if (!d) return "";
    var row = function (lab, done, need, exp) {
      var ok = done >= need;
      return '<div class="pa-dl"><div class="pa-dl-h"><span>' + lab + '</span><b class="' + (ok ? "ok" : "") + '">' + int(done) + "/" + int(need) + (ok ? " ✓" : "") + "</b></div>" + bar(done, need, exp, ok ? "ok" : "") + "</div>";
    };
    return '<article class="fa-card"><div class="fa-card-t">Entregas de ' + esc(d.mes) + '</div><div class="fa-card-p">' +
      (d.fechado ? "mês fechado" : "faltam " + d.dias_restantes + (d.dias_restantes === 1 ? " dia" : " dias") + " para fechar") + "</div>" +
      (d.meta_stories ? row("Stories", d.stories, d.meta_stories, d.fechado ? null : d.stories_esperados_ate_hoje) : "") +
      (d.meta_reels ? row("Reels", d.reels, d.meta_reels) : "") +
      (d.meta_youtube ? row("Vídeo no YouTube", d.youtube, d.meta_youtube) : "") +
      (!d.fechado && d.meta_stories ? '<p class="pa-note">A marca na barra dos stories é o ritmo esperado até hoje (' + int(d.stories_esperados_ate_hoje) + ").</p>" : "") + "</article>";
  }
  function cardChannels(f) {
    var y = f.youtube, g = f.instagram;
    if (!y && !g) return "";
    var gr = function (now, before) { return before ? " " + pill(now, before) : ""; };
    return '<article class="fa-card"><div class="fa-card-t">Seus canais</div><div class="fa-card-p">últimos 30 dias × 30 anteriores</div>' +
      (y ? '<div class="pa-ch"><span class="pa-ch-n yt">▶ YouTube</span><dl class="fa-mini">' +
        "<div><dt>Inscritos</dt><dd>" + int(y.inscritos) + gr(y.inscritos, y.inscritos_30_dias_atras) + "</dd></div>" +
        "<div><dt>Vídeos novos</dt><dd>" + int(y.videos_ultimos_30_dias) + " " + pill(y.videos_ultimos_30_dias, y.videos_30_dias_anteriores) + "</dd></div>" +
        "<div><dt>Views dos vídeos novos</dt><dd>" + int(y.views_dos_videos_ultimos_30_dias) + "</dd></div></dl></div>" : "") +
      (g ? '<div class="pa-ch"><span class="pa-ch-n ig">◎ Instagram</span><dl class="fa-mini">' +
        "<div><dt>Seguidores</dt><dd>" + int(g.seguidores) + gr(g.seguidores, g.seguidores_30_dias_atras) + "</dd></div>" +
        "<div><dt>Posts / reels</dt><dd>" + int((g.ultimos_30_dias || {}).posts) + " / " + int((g.ultimos_30_dias || {}).reels) + "</dd></div>" +
        "<div><dt>Média de views por reel</dt><dd>" + int((g.ultimos_30_dias || {}).media_views_reels) + " " + pill((g.ultimos_30_dias || {}).media_views_reels, (g["30_dias_anteriores"] || {}).media_views_reels) + "</dd></div></dl></div>" : "") +
      "</article>";
  }

  function highlights(f) {
    var y = (f.youtube || {}).video_destaque_30_dias, g = (f.instagram || {}).post_destaque_30_dias, out = "";
    if (y) out += '<div class="pa-hl"><span class="pa-ch-n yt">▶ Vídeo destaque</span><b>' + esc(y.titulo) + "</b><small>" + int(y.views) + " views · " + int(y.curtidas) + " curtidas · " + int(y.comentarios) + " comentários</small></div>";
    if (g) out += '<div class="pa-hl"><span class="pa-ch-n ig">◎ Post destaque</span><b>' + esc(g.legenda || "(sem legenda)") + "</b><small>" + (g.views != null ? int(g.views) + " views · " : "") + int(g.curtidas) + " curtidas · " + int(g.comentarios) + " comentários</small></div>";
    var flow = [];
    if (f.youtube) flow.push(int(f.youtube.videos_sobre_flow_no_contrato) + " vídeo(s) sobre a Flow no contrato (" + int(f.youtube.views_videos_sobre_flow) + " views)");
    if (f.instagram) flow.push(int((f.instagram.ultimos_30_dias || {}).posts_sobre_flow) + " post(s) sobre a Flow em 30 dias");
    if (!out && !flow.length) return "";
    return '<section class="fa-block"><div class="fa-block-h"><h4>Destaques do seu conteúdo</h4></div>' + out +
      (flow.length ? '<p class="pa-note">Conteúdo sobre a Flow: ' + esc(flow.join(" · ")) + ".</p>" : "") + "</section>";
  }
  function actions(secs) {
    var s = secs.filter(function (x) { return starts(x, "O QUE FAZER") || starts(x, "PRÓXIMOS PASSOS"); })[0];
    if (!s || !s.items.length) return "";
    return '<section class="fa-actions"><div class="fa-block-h"><h4>' + esc(s.title) + "</h4></div><ol>" +
      s.items.map(function (t, i) { return '<li><span class="fa-step">' + (i + 1) + "</span><p>" + rich(t) + "</p></li>"; }).join("") + "</ol></section>";
  }
  function details(secs) {
    var rest = secs.filter(function (s) { return s.title && !starts(s, "RESUMO") && !starts(s, "O QUE FAZER") && !starts(s, "PRÓXIMOS PASSOS"); });
    if (!rest.length) return "";
    var t = '<button type="button" class="fa-more" data-pa="toggle">' + (S.open ? "Recolher análise ▴" : "Ler análise completa · " + rest.length + " seções ▾") + "</button>";
    if (!S.open) return t;
    return t + '<div class="fa-secs">' + rest.map(function (s) {
      return '<article class="fa-sec"><h5><span class="fa-ico" aria-hidden="true">◆</span>' + esc(s.title) + "</h5><ul>" + s.items.map(function (x) { return "<li>" + rich(x) + "</li>"; }).join("") + "</ul></article>";
    }).join("") + "</div>";
  }

  function render() {
    var d = S.data, root = S.root;
    if (!d || !d.facts) { root.hidden = true; return; }
    var f = d.facts, secs = sections(d.text);
    root.hidden = false;
    root.innerHTML = '<div class="fa-top"><div class="fa-title"><span class="fa-spark" aria-hidden="true">✦</span><div><h3>Sua análise</h3><p class="fa-sub">' +
      (d.text ? "Escrita pelo Claude em " + esc(when(d.created_at)) + " · números atualizados agora" : "Números atualizados agora · o texto da análise chega na próxima rodada diária") + "</p></div></div></div>" +
      hero(secs, f) +
      '<div class="fa-cards">' + cardSales(f) + cardBonus(f) + cardDeliv(f) + cardChannels(f) + "</div>" +
      '<div class="fa-grid">' + actions(secs) + highlights(f) + "</div>" +
      details(secs) +
      '<p class="fa-foot">' + (f.notas || []).map(esc).join(" ") + "</p>";
  }

  return {
    show: async function (opts) {
      if (!S.root) {
        S.root = opts.root;
        S.root.addEventListener("click", function (e) { if (e.target.closest("[data-pa=toggle]")) { S.open = !S.open; render(); } });
      }
      try { S.data = await opts.load(); } catch (e) { S.data = null; }
      render();
    }
  };
})();
