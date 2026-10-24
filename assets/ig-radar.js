/* Radar Instagram (menu do Financeiro).
   Acompanha perfis de concorrentes, influencers e qualquer @ do mercado: seguidores e crescimento, frequência de
   posts, médias de curtidas, comentários e views, engajamento, formato mais usado e os posts com busca por palavra.
   Só contas profissionais (Empresa ou Criador) aparecem: a Meta não mostra contas pessoais, alcance nem stories de
   outros perfis. Dados: ig_radar_profiles, ig_radar_media e ig_radar_snapshots (migration 20261024_ig_radar.sql),
   lidos pela Edge Function ig-radar a cada 6 h e na hora em que um perfil é adicionado.
   Uso: IgRadar.init({ root, sb, toast, url }); IgRadar.show(); */
(function () {
  "use strict";

  var CATS = [["concorrente", "Concorrente"], ["influencer", "Influencer"], ["mercado", "Mercado"]];
  var SORTS = [["seguidores", "Mais seguidores"], ["crescimento", "Mais crescimento"], ["engajamento", "Mais engajamento"], ["views", "Mais views"], ["frequencia", "Posta mais"]];
  var A = null;
  var S = { ready: false, profiles: [], media: {}, snaps: {}, cat: "", sort: "seguidores", open: null, q: "", adding: false, busy: {} };

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var nf = new Intl.NumberFormat("pt-BR");
  var compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
  function n(v) { return v == null || !isFinite(v) ? "—" : nf.format(Math.round(Number(v))); }
  function big(v) { return v == null ? "—" : Number(v) >= 10000 ? compact.format(Number(v)) : n(v); }
  function pct(v) { return v == null || !isFinite(v) ? "—" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%"; }
  function dt(iso) { return iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "America/Sao_Paulo" }) : "—"; }
  function label(list, v) { for (var i = 0; i < list.length; i++) if (list[i][0] === v) return list[i][1]; return v; }
  function kind(m) { return m.media_product_type === "REELS" ? "Reel" : m.media_type === "CAROUSEL_ALBUM" ? "Carrossel" : m.media_type === "VIDEO" ? "Vídeo" : "Imagem"; }
  function avg(list, k) { var v = list.map(function (x) { return x[k]; }).filter(function (x) { return x != null; }); return v.length ? v.reduce(function (s, x) { return s + Number(x); }, 0) / v.length : null; }

  // "https://www.instagram.com/fulano/", "@fulano" ou "fulano" → "fulano" (mesma regra da instagram-sync).
  function parseHandle(raw) {
    var s = String(raw || "").trim();
    try { s = decodeURIComponent(s); } catch (e) {}
    var m = s.match(/instagram\.com\/([A-Za-z0-9._]{1,30})/i);
    if (m) s = m[1];
    s = s.replace(/^@/, "").replace(/[/?#].*$/, "").trim();
    if (!/^[A-Za-z0-9._]{1,30}$/.test(s) || ["p", "reel", "reels", "stories", "explore"].indexOf(s.toLowerCase()) >= 0) return null;
    return s.toLowerCase();
  }

  // Números de cada perfil a partir dos posts lidos e das fotos diárias.
  function stats(p) {
    var media = S.media[p.username] || [], snaps = S.snaps[p.username] || [];
    var recent = media.slice(0, 12);
    var now = Date.now(), d30 = media.filter(function (m) { return now - Date.parse(m.posted_at) < 30 * 864e5; });
    var likes = avg(recent, "like_count"), comments = avg(recent, "comments_count"), views = avg(recent, "view_count");
    var eng = p.followers_count && likes != null ? (likes + (comments || 0)) / p.followers_count * 100 : null;
    var fmt = {};
    media.slice(0, 30).forEach(function (m) { var k = kind(m); fmt[k] = (fmt[k] || 0) + 1; });
    var top = Object.keys(fmt).sort(function (a, b) { return fmt[b] - fmt[a]; })[0] || null;
    function growth(days) {
      if (snaps.length < 2) return null;
      var last = snaps[snaps.length - 1], target = Date.parse(last.day) - days * 864e5, base = snaps[0];
      for (var i = snaps.length - 1; i >= 0; i--) { if (Date.parse(snaps[i].day) <= target) { base = snaps[i]; break; } }
      if (base === last || base.followers_count == null) return null;
      return { n: last.followers_count - base.followers_count, pct: base.followers_count ? (last.followers_count - base.followers_count) / base.followers_count * 100 : null, since: base.day };
    }
    return { media: media, posts30: d30.length, perWeek: d30.length / (30 / 7), likes: likes, comments: comments, views: views, eng: eng, top: top, topCount: top ? fmt[top] : 0, g7: growth(7), g30: growth(30), last: media[0] ? media[0].posted_at : null };
  }

  /* ---------------- dados ---------------- */
  function cacheKey() { return "flow_igradar_cache_v1:" + ((window.FlowAccess && window.FlowAccess.email()) || ""); }
  function cacheRead() { try { return JSON.parse(sessionStorage.getItem(cacheKey()) || "null"); } catch (e) { return null; } }
  function cacheWrite() { try { sessionStorage.setItem(cacheKey(), JSON.stringify({ profiles: S.profiles, media: S.media, snaps: S.snaps })); } catch (e) {} }

  async function load() {
    var r = await Promise.all([
      A.sb.from("ig_radar_profiles").select("*").order("added_at", { ascending: false }),
      A.sb.from("ig_radar_media").select("id, username, media_type, media_product_type, caption, permalink, posted_at, like_count, comments_count, view_count").order("posted_at", { ascending: false }).limit(10000),
      A.sb.from("ig_radar_snapshots").select("username, day, followers_count").order("day", { ascending: true }).limit(20000)
    ]);
    r.forEach(function (x) { if (x.error) throw x.error; });
    S.profiles = r[0].data || [];
    S.media = {}; (r[1].data || []).forEach(function (m) { (S.media[m.username] = S.media[m.username] || []).push(m); });
    S.snaps = {}; (r[2].data || []).forEach(function (s) { (S.snaps[s.username] = S.snaps[s.username] || []).push(s); });
  }

  async function callSync(username) {
    var sess = await A.sb.auth.getSession();
    var token = sess && sess.data && sess.data.session && sess.data.session.access_token;
    var res = await fetch(A.url + "/functions/v1/ig-radar", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(username ? { username: username } : {}) });
    var js = await res.json().catch(function () { return {}; });
    if (!res.ok || js.ok === false) throw new Error(js.error || ("HTTP " + res.status));
    return js;
  }

  /* ---------------- esqueleto ---------------- */
  function build(root) {
    root.innerHTML =
      '<section class="ch-hero rd-hero">' +
        '<div class="ch-hero-main"><div class="ch-kicker">Radar Instagram</div><h3 class="ch-title">Concorrentes e mercado</h3>' +
          '<p class="ch-sub">Cole o @ ou o link de qualquer perfil profissional (Empresa ou Criador) para acompanhar seguidores, crescimento, frequência de posts, engajamento e o que cada um publica. O painel lê todos a cada 6 horas. A Meta não mostra contas pessoais, alcance nem stories de outros perfis.</p>' +
          '<form class="rd-add" id="rd-add" autocomplete="off">' +
            '<input id="rd-handle" placeholder="@perfil ou instagram.com/perfil" aria-label="Perfil do Instagram" required>' +
            '<select id="rd-cat" aria-label="Categoria">' + CATS.map(function (c) { return '<option value="' + c[0] + '">' + esc(c[1]) + "</option>"; }).join("") + "</select>" +
            '<input id="rd-note" placeholder="Observação (opcional)" aria-label="Observação" maxlength="200">' +
            '<button type="submit" class="btn btn-primary" id="rd-add-btn">Adicionar ao radar</button>' +
          "</form></div>" +
      "</section>" +
      '<div class="rd-filters"><div class="ch-tabs" id="rd-cats" role="tablist" aria-label="Categoria"></div>' +
        '<label class="rd-sort">Ordenar <select id="rd-sort" aria-label="Ordenar por">' + SORTS.map(function (s) { return '<option value="' + s[0] + '">' + esc(s[1]) + "</option>"; }).join("") + "</select></label></div>" +
      '<div class="rd-grid" id="rd-grid"></div>' +
      '<div class="ig-drawer-back" id="rd-back" hidden></div>' +
      '<aside class="ig-drawer rd-drawer" id="rd-drawer" hidden aria-label="Perfil"></aside>';
    $("rd-add").addEventListener("submit", function (e) { e.preventDefault(); add(); });
    $("rd-sort").addEventListener("change", function (e) { S.sort = e.target.value; renderGrid(); });
    $("rd-back").addEventListener("click", closeDrawer);
    root.addEventListener("click", onClick);
    root.addEventListener("error", function (e) {
      var img = e.target;
      if (img.tagName !== "IMG" || !img.classList.contains("rd-av")) return;
      var span = document.createElement("span");
      span.className = "rd-av"; span.textContent = img.getAttribute("data-letter") || "?";
      img.replaceWith(span);
    }, true);
    root.addEventListener("keydown", function (e) {
      var card = e.target.classList && e.target.classList.contains("rd-card") ? e.target : null;
      if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDrawer(card.getAttribute("data-id")); }
    });
    root.addEventListener("input", function (e) { if (e.target.id === "rd-q") { S.q = e.target.value; renderPosts(); } });
    root.addEventListener("change", function (e) {
      if (e.target.id === "rd-edit-cat") update(S.open, { category: e.target.value });
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.open) closeDrawer(); });
  }

  function onClick(e) {
    var el = e.target.closest("[data-rd]");
    if (!el) return;
    var act = el.getAttribute("data-rd"), id = el.getAttribute("data-id");
    if (act === "cat") { S.cat = el.getAttribute("data-v"); render(); }
    else if (act === "open") openDrawer(id);
    else if (act === "close") closeDrawer();
    else if (act === "remove") remove(id);
    else if (act === "refresh") refreshOne(id);
    else if (act === "note") { var v = window.prompt("Observação sobre @" + id, (byId(id) || {}).note || ""); if (v !== null) update(id, { note: v.trim() || null }); }
  }
  function byId(u) { return S.profiles.filter(function (p) { return p.username === u; })[0]; }

  /* ---------------- desenho ---------------- */
  function render() { renderCats(); renderGrid(); if (S.open) renderDrawer(); }

  function renderCats() {
    var count = function (c) { return S.profiles.filter(function (p) { return !c || p.category === c; }).length; };
    $("rd-cats").innerHTML = [["", "Todos"]].concat(CATS).map(function (c) {
      return '<button type="button" class="btn' + (S.cat === c[0] ? " btn-primary" : "") + '" data-rd="cat" data-v="' + c[0] + '">' + esc(c[1]) + " · " + count(c[0]) + "</button>";
    }).join("");
  }

  function sortValue(p, st) {
    switch (S.sort) {
      case "crescimento": return st.g7 ? st.g7.pct : -Infinity;
      case "engajamento": return st.eng == null ? -Infinity : st.eng;
      case "views": return st.views == null ? -Infinity : st.views;
      case "frequencia": return st.posts30;
      default: return p.followers_count == null ? -Infinity : Number(p.followers_count);
    }
  }

  function renderGrid() {
    var list = S.profiles.filter(function (p) { return !S.cat || p.category === S.cat; })
      .map(function (p) { return { p: p, st: stats(p) }; })
      .sort(function (a, b) { return sortValue(b.p, b.st) - sortValue(a.p, a.st); });
    if (!S.profiles.length) { $("rd-grid").innerHTML = '<div class="panel ig-empty">Nenhum perfil no radar ainda. Cole um @ acima para começar, por exemplo um concorrente ou um influencer do nicho.</div>'; return; }
    if (!list.length) { $("rd-grid").innerHTML = '<div class="panel ig-empty">Nenhum perfil nesta categoria.</div>'; return; }
    $("rd-grid").innerHTML = list.map(function (x) {
      var p = x.p, st = x.st;
      var pending = !p.fetched_at, err = p.error;
      var g = st.g7 ? '<em class="' + (st.g7.n >= 0 ? "up" : "down") + '">' + (st.g7.n >= 0 ? "+" : "") + n(st.g7.n) + "</em> em 7 dias" : "crescimento aparece a partir do 2º dia";
      return '<article class="rd-card' + (err ? " err" : "") + '" data-rd="open" data-id="' + esc(p.username) + '" tabindex="0">' +
        '<div class="rd-top">' + avatar(p) + '<div class="rd-who"><b>' + esc(p.name || "@" + p.username) + '</b><a href="https://www.instagram.com/' + esc(p.username) + '/" target="_blank" rel="noopener">@' + esc(p.username) + "</a></div>" +
          '<span class="rd-cat c-' + p.category + '">' + esc(label(CATS, p.category)) + "</span></div>" +
        (err ? '<p class="rd-err">' + esc(err) + "</p>" : pending ? '<p class="rd-wait">Lendo o perfil na Meta…</p>' :
          '<div class="rd-stats">' +
            stat("Seguidores", big(p.followers_count), g) +
            stat("Posts / semana", st.posts30 ? (st.perWeek).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) : "0", n(st.posts30) + " nos últimos 30 dias") +
            stat("Engajamento", pct(st.eng), "curtidas + coment. ÷ seguidores") +
            stat("Média de views", big(st.views), "últimos 12 posts") +
          "</div>" +
          '<div class="rd-foot"><span>Curtidas ' + big(st.likes) + " · coment. " + big(st.comments) + (st.top ? " · mais posta " + esc(st.top) : "") + "</span><span>Último post " + esc(dt(st.last)) + "</span></div>") +
        (p.note ? '<p class="rd-note">' + esc(p.note) + "</p>" : "") +
        "</article>";
    }).join("");
  }
  function stat(l, v, s) { return '<div class="rd-stat"><small>' + esc(l) + '</small><b class="num">' + v + "</b><span>" + s + "</span></div>"; }
  function avatar(p) {
    var letter = esc((p.name || p.username || "?").charAt(0).toUpperCase());
    // A foto vem do CDN da Meta e expira; se não carregar, o listener de "error" em build() troca pela inicial.
    return p.profile_picture_url ? '<img class="rd-av" src="' + esc(p.profile_picture_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-letter="' + letter + '">'
      : '<span class="rd-av">' + letter + "</span>";
  }

  /* ---------------- detalhe ---------------- */
  function openDrawer(u) { S.open = u; S.q = ""; renderDrawer(); $("rd-drawer").hidden = false; $("rd-back").hidden = false; $("rd-drawer").scrollTop = 0; }
  function closeDrawer() { S.open = null; if ($("rd-drawer")) { $("rd-drawer").hidden = true; $("rd-back").hidden = true; } }

  function renderDrawer() {
    var p = byId(S.open);
    if (!p) { closeDrawer(); return; }
    var st = stats(p), busy = S.busy[p.username];
    $("rd-drawer").innerHTML =
      '<div class="ig-d-head"><div class="rd-top">' + avatar(p) + '<div class="rd-who"><b>' + esc(p.name || "@" + p.username) + '</b><a href="https://www.instagram.com/' + esc(p.username) + '/" target="_blank" rel="noopener">@' + esc(p.username) + " ↗</a></div></div>" +
        '<button type="button" class="btn btn-ghost ig-x" data-rd="close" aria-label="Fechar">✕</button></div>' +
      (p.biography ? '<p class="rd-bio">' + esc(p.biography) + "</p>" : "") +
      (p.website ? '<p class="rd-site"><a href="' + esc(p.website) + '" target="_blank" rel="noopener noreferrer">' + esc(p.website) + "</a></p>" : "") +
      '<div class="rd-actions"><label>Categoria <select id="rd-edit-cat">' + CATS.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === p.category ? " selected" : "") + ">" + esc(c[1]) + "</option>"; }).join("") + "</select></label>" +
        '<button type="button" class="btn" data-rd="note" data-id="' + esc(p.username) + '">' + (p.note ? "Editar observação" : "Adicionar observação") + "</button>" +
        '<button type="button" class="btn" data-rd="refresh" data-id="' + esc(p.username) + '"' + (busy ? " disabled" : "") + ">" + (busy ? "Lendo…" : "Atualizar agora") + "</button>" +
        '<button type="button" class="btn btn-ghost rd-del" data-rd="remove" data-id="' + esc(p.username) + '">Tirar do radar</button></div>' +
      (p.note ? '<p class="rd-note">' + esc(p.note) + "</p>" : "") +
      '<div class="rd-stats wide">' +
        stat("Seguidores", n(p.followers_count), st.g30 ? (st.g30.n >= 0 ? "+" : "") + n(st.g30.n) + " desde " + dt(st.g30.since) : "segue " + n(p.follows_count)) +
        stat("Posts no perfil", n(p.media_count), n(st.media.length) + " lidos pelo painel") +
        stat("Posts / semana", (st.perWeek || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 }), "últimos 30 dias") +
        stat("Engajamento", pct(st.eng), "últimos 12 posts") +
        stat("Média de curtidas", n(st.likes), "últimos 12 posts") +
        stat("Média de views", n(st.views), "últimos 12 posts") +
      "</div>" +
      '<section class="ig-sec"><div class="ig-sec-h"><h5>Seguidores por dia</h5><span class="rd-mini">desde que entrou no radar</span></div>' + followerChart(S.snaps[p.username] || []) + "</section>" +
      '<section class="ig-sec"><div class="ig-sec-h"><h5>Posts e reels</h5><input type="search" id="rd-q" placeholder="Buscar na legenda (ex.: flow, clickdefender)" aria-label="Buscar na legenda" value="' + esc(S.q) + '"></div><div id="rd-posts"></div></section>' +
      '<p class="rd-mini">Adicionado por ' + esc(p.added_by || "—") + " em " + esc(dt(p.added_at)) + ". Última leitura da Meta: " + esc(p.fetched_at ? new Date(p.fetched_at).toLocaleString("pt-BR") : "—") + ".</p>";
    renderPosts();
  }

  function followerChart(snaps) {
    var pts = snaps.filter(function (s) { return s.followers_count != null; });
    if (pts.length < 2) return '<p class="rd-mini">O gráfico aparece a partir da segunda leitura diária.</p>';
    var W = 600, H = 140, P = 6;
    var ys = pts.map(function (s) { return Number(s.followers_count); });
    var min = Math.min.apply(null, ys), max = Math.max.apply(null, ys), span = max - min || 1;
    var path = pts.map(function (s, i) {
      var x = P + i / (pts.length - 1) * (W - 2 * P), y = H - P - (Number(s.followers_count) - min) / span * (H - 2 * P);
      return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    }).join(" ");
    return '<svg class="rd-chart" viewBox="0 0 ' + W + " " + H + '" width="100%" preserveAspectRatio="none" role="img" aria-label="Seguidores por dia"><path d="' + path + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
      '<div class="rd-chart-l"><span>' + esc(dt(pts[0].day + "T12:00:00Z")) + " · " + n(min === ys[0] ? ys[0] : ys[0]) + "</span><span>" + esc(dt(pts[pts.length - 1].day + "T12:00:00Z")) + " · " + n(ys[ys.length - 1]) + "</span></div>";
  }

  function renderPosts() {
    var box = $("rd-posts");
    if (!box) return;
    var p = byId(S.open), media = (S.media[p.username] || []);
    var q = S.q.trim().toLowerCase();
    var list = q ? media.filter(function (m) { return String(m.caption || "").toLowerCase().indexOf(q) >= 0; }) : media;
    if (!list.length) { box.innerHTML = '<p class="rd-mini">' + (q ? "Nenhuma legenda com “" + esc(S.q) + "”." : "Nenhum post lido ainda.") + "</p>"; return; }
    box.innerHTML = (q ? '<p class="rd-mini">' + n(list.length) + " de " + n(media.length) + " posts citam “" + esc(S.q) + "”.</p>" : "") +
      '<div class="table-scroll"><table class="ip-table"><thead><tr><th>Data</th><th>Tipo</th><th>Legenda</th><th class="n">Curtidas</th><th class="n">Coment.</th><th class="n">Views</th></tr></thead><tbody>' +
      list.slice(0, 200).map(function (m) {
        return "<tr><td>" + esc(dt(m.posted_at)) + "</td><td>" + esc(kind(m)) + '</td><td class="ip-txt">' +
          (m.permalink ? '<a href="' + esc(m.permalink) + '" target="_blank" rel="noopener">' : "") + esc(String(m.caption || "(sem legenda)").split("\n")[0].slice(0, 120)) + (m.permalink ? "</a>" : "") +
          '</td><td class="n">' + n(m.like_count) + '</td><td class="n">' + n(m.comments_count) + '</td><td class="n">' + n(m.view_count) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  /* ---------------- ações ---------------- */
  async function add() {
    var u = parseHandle($("rd-handle").value);
    if (!u) { A.toast("Perfil não reconhecido. Use @perfil ou o link do Instagram.", true); return; }
    if (byId(u)) { A.toast("@" + u + " já está no radar."); openDrawer(u); return; }
    if (S.adding) return;
    S.adding = true; $("rd-add-btn").disabled = true;
    var r = await A.sb.from("ig_radar_profiles").insert({ username: u, category: $("rd-cat").value, note: $("rd-note").value.trim() || null }).select("*").single();
    if (r.error) { S.adding = false; $("rd-add-btn").disabled = false; A.toast("Não foi possível adicionar: " + r.error.message, true); return; }
    S.profiles.unshift(r.data);
    $("rd-handle").value = ""; $("rd-note").value = "";
    render();
    A.toast("@" + u + " adicionado. Lendo o perfil na Meta…");
    try { await callSync(u); } catch (e) { A.toast("A leitura falhou: " + (e.message || e), true); }
    S.adding = false; $("rd-add-btn").disabled = false;
    await reload();
  }

  async function refreshOne(u) {
    if (S.busy[u]) return;
    S.busy[u] = true; renderDrawer();
    try { await callSync(u); A.toast("@" + u + " atualizado."); } catch (e) { A.toast("Não foi possível atualizar: " + (e.message || e), true); }
    delete S.busy[u];
    await reload();
  }

  async function update(u, patch) {
    var r = await A.sb.from("ig_radar_profiles").update(patch).eq("username", u).select("*").single();
    if (r.error) { A.toast("Não foi possível salvar: " + r.error.message, true); return; }
    S.profiles = S.profiles.map(function (p) { return p.username === u ? r.data : p; });
    render(); cacheWrite();
    A.toast("Salvo.");
  }

  async function remove(u) {
    if (!window.confirm("Tirar @" + u + " do radar? Os posts e o histórico de seguidores dele também saem.")) return;
    var r = await A.sb.from("ig_radar_profiles").delete().eq("username", u);
    if (r.error) { A.toast("Não foi possível tirar do radar: " + r.error.message, true); return; }
    S.profiles = S.profiles.filter(function (p) { return p.username !== u; });
    delete S.media[u]; delete S.snaps[u];
    closeDrawer(); render(); cacheWrite();
    A.toast("@" + u + " saiu do radar.");
  }

  async function reload() {
    try { await load(); cacheWrite(); render(); } catch (e) { A.toast("Não foi possível carregar o radar: " + (e.message || e), true); }
  }

  /* ---------------- API pública ---------------- */
  async function show() {
    if (!A) return;
    if (!S.ready) {
      S.ready = true;
      var c = cacheRead();
      if (c) { S.profiles = c.profiles || []; S.media = c.media || {}; S.snaps = c.snaps || {}; render(); }
      else $("rd-grid").innerHTML = '<div class="panel ig-empty">Carregando…</div>';
    }
    await reload();
  }
  window.IgRadar = {
    init: function (opts) { A = opts; build(opts.root); },
    show: show,
    hide: closeDrawer
  };
})();
