/* Canais favoritos (Afiliados → Canais favoritos).
   Youtubers marcados com ★ no YouTube ou no Rastrear Mercado (ou colados pelo link) para acompanhar de perto,
   com a data em que a Flow liberou o acesso às ferramentas. A lista mostra, desde essa data, quantos vídeos o
   canal publicou e quantos citam FlowPages, FlowTracking ou FlowSpy (visão yt_favorites_summary); o painel
   completo de cada canal reaproveita o dashboard do influencer (InfluencerDash.openCtx).
   Coleta: Edge Function youtube-sync (cron a cada 6 h; ao favoritar busca 12 meses de vídeos).
   Uso: YtFavorites.init({ root, sb, toast, dash, channelUrl }); YtFavorites.show();
        YtFavorites.star({ channel_id, title, handle, thumbnail_url, source, affiliate_email }) → HTML do botão ★. */
window.YtFavorites = (function () {
  "use strict";
  var A = null;
  var DAY = 86400000;
  var ids = {};          // channel_id → true (estrelas)
  var rows = null;       // linhas da visão de resumo
  var loading = null;
  var syncing = {};      // channel_id → true enquanto busca no YouTube
  var F = { status: "all", text: "", sort: "added" };
  var COLS = "channel_id, title, handle, thumbnail_url, banner_url, country, channel_created, subscribers, hidden_subs, total_views, video_count, source, affiliate_email, access_at, notes, added_at, fetched_at, error, " +
    "videos_after, shorts_after, views_after, flow_after, pages_after, tracking_after, spy_after, flow_views_after, flow_before, videos_total, last_video_at, last_flow_at, oldest_video_at, first_subscribers, first_snapshot_day";

  /* ---------------- utilidades ---------------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmtInt(v) { return v == null || isNaN(v) ? "—" : new Intl.NumberFormat("pt-BR").format(Math.round(v)); }
  function fmtN(v) {
    if (v == null || isNaN(v)) return "—";
    var a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(1).replace(".", ",") + " mi";
    if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(".", ",") + " mil";
    return String(Math.round(v));
  }
  function day(iso) { return iso ? new Date(String(iso).length === 10 ? iso + "T12:00:00" : iso).toLocaleDateString("pt-BR") : "—"; }
  function daysSince(iso) { return iso ? Math.max(0, Math.floor((Date.now() - Date.parse(String(iso).length === 10 ? iso + "T00:00:00-03:00" : iso)) / DAY)) : null; }
  function ago(iso) {
    var d = daysSince(iso);
    return d == null ? "—" : d === 0 ? "hoje" : d === 1 ? "há 1 dia" : "há " + fmtInt(d) + " dias";
  }
  function today() { return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }); }
  function canUse() { return !!(window.FlowAccess && window.FlowAccess.can("af.favoritos")); }
  function errText(res) {
    var d = res && res.data;
    if (d && d.error) return d.error;
    if (res && res.error) return res.error.message || String(res.error);
    return "erro desconhecido";
  }
  async function invoke(body) {
    var res = await A.sb.functions.invoke("youtube-sync", { body: body }), data = res.data;
    if (res.error && !data) { try { data = await res.error.context.json(); } catch (e) { data = { ok: false, error: res.error.message }; } }
    return data || { ok: false, error: "sem resposta" };
  }

  /* ---------------- estrela (YouTube, Rastrear Mercado, painel) ---------------- */
  function star(info) {
    if (!canUse() || !info || !/^UC[\w-]{20,24}$/.test(info.channel_id || "")) return "";
    var on = !!ids[info.channel_id];
    return '<button type="button" class="yf-star' + (on ? " on" : "") + '" data-yf-star="' + esc(info.channel_id) + '"' +
      ' data-yf-title="' + esc(info.title || "") + '" data-yf-handle="' + esc(info.handle || "") + '" data-yf-thumb="' + esc(info.thumbnail_url || "") + '"' +
      ' data-yf-src="' + esc(info.source || "manual") + '" data-yf-email="' + esc(info.affiliate_email || "") + '"' +
      ' aria-pressed="' + on + '" title="' + (on ? "Nos Canais favoritos (clique para remover)" : "Favoritar e acompanhar este canal") + '">' + (on ? "★" : "☆") + "</button>";
  }
  function paintStars() {
    document.querySelectorAll("[data-yf-star]").forEach(function (b) {
      var on = !!ids[b.dataset.yfStar];
      b.classList.toggle("on", on);
      b.textContent = on ? "★" : "☆";
      b.setAttribute("aria-pressed", on);
      b.title = on ? "Nos Canais favoritos (clique para remover)" : "Favoritar e acompanhar este canal";
    });
  }
  async function loadIds() {
    if (!canUse()) return;
    var r = await A.sb.from("yt_favorites").select("channel_id");
    if (r.error) return;
    ids = {};
    (r.data || []).forEach(function (x) { ids[x.channel_id] = true; });
    paintStars();
  }

  async function add(info) {
    var id = info.channel_id;
    ids[id] = true; paintStars();
    var r = await A.sb.from("yt_favorites").upsert({
      channel_id: id, title: info.title || null, handle: info.handle || null, thumbnail_url: info.thumbnail_url || null,
      source: info.source === "youtube" || info.source === "mercado" ? info.source : "manual", affiliate_email: info.affiliate_email || null
    }, { onConflict: "channel_id", ignoreDuplicates: true });
    if (r.error) { delete ids[id]; paintStars(); A.toast("Não foi possível favoritar: " + r.error.message, true); return; }
    A.toast("★ " + (info.title || "Canal") + " está nos Canais favoritos. Buscando 12 meses de vídeos; depois informe lá a data em que liberou o acesso.");
    rows = null;
    syncOne(id, true, true);
  }
  async function remove(id, title) {
    if (!confirm("Tirar " + (title || "este canal") + " dos Canais favoritos?\nA data de acesso e as observações deste canal serão apagadas.")) return false;
    var r = await A.sb.from("yt_favorites").delete().eq("channel_id", id);
    if (r.error) { A.toast("Não foi possível remover: " + r.error.message, true); return false; }
    delete ids[id]; paintStars();
    if (rows) rows = rows.filter(function (x) { return x.channel_id !== id; });
    A.toast("Canal removido dos favoritos.");
    if (visible()) render();
    return true;
  }
  async function syncOne(id, deep, quiet) {
    if (syncing[id]) return;
    syncing[id] = true; if (visible()) render();
    var data = await invoke({ action: "fav_sync", channelId: id, deep: !!deep });
    delete syncing[id];
    if (!data.ok) A.toast("YouTube: " + (data.error || "erro ao atualizar o canal"), true);
    else if (!quiet) A.toast("Canal atualizado: " + fmtInt(data.videos) + " vídeos lidos.");
    else A.toast("Dados do canal carregados: " + fmtInt(data.videos) + " vídeos.");
    if (visible()) { await load(true); render(); } else rows = null;
  }

  /* ---------------- dados ---------------- */
  async function load(force) {
    if (rows && !force) return rows;
    if (loading) return loading;
    loading = A.sb.from("yt_favorites_summary").select(COLS).then(function (r) {
      loading = null;
      if (r.error) throw r.error;
      rows = r.data || [];
      ids = {};
      rows.forEach(function (x) { ids[x.channel_id] = true; });
      paintStars();
      return rows;
    }, function (e) { loading = null; throw e; });
    return loading;
  }
  function byId(id) { return (rows || []).filter(function (x) { return x.channel_id === id; })[0] || null; }

  // Situação do canal desde a liberação do acesso.
  function statusOf(f) {
    if (!f.access_at) return { k: "nodate", label: "Sem data de acesso", cls: "" };
    if (f.flow_after > 0) return { k: "yes", label: "Divulgou a Flow", cls: "good" };
    var d = daysSince(f.access_at);
    return { k: "no", label: "Ainda não divulgou", cls: d >= 14 ? "bad" : "wait" };
  }

  /* ---------------- tela ---------------- */
  function visible() { return !!(A && A.root && !A.root.hidden && A.root.offsetParent !== null); }

  function show() {
    if (!A) return;
    if (!A.root.dataset.built) build();
    if (rows) render(); else A.root.querySelector("#yf-grid").innerHTML = '<p class="yf-empty">Carregando os canais…</p>';
    load(true).then(render).catch(function (e) {
      A.root.querySelector("#yf-grid").innerHTML = '<p class="yf-empty">Erro ao ler os favoritos: ' + esc(e.message || e) + "</p>";
    });
  }

  function build() {
    A.root.dataset.built = "1";
    A.root.innerHTML =
      '<p class="muted yf-intro">Canais que você marcou com <b class="yf-inline-star">★</b> no <b>YouTube</b> ou no <b>Rastrear Mercado</b> (ou colou o link aqui). Informe a <b>data em que liberou o acesso</b> às ferramentas: a partir dela o painel conta os vídeos que o canal publicou e quais citam <b>FlowPages</b>, <b>FlowTracking</b> ou <b>FlowSpy</b> no título ou na descrição. Os canais são relidos no YouTube a cada 6 horas.</p>' +
      '<form class="yf-add" id="yf-add" autocomplete="off">' +
        '<div class="field"><label for="yf-ref">Canal do YouTube</label><input id="yf-ref" type="text" placeholder="Link do canal, @usuario ou ID (UC…)" required></div>' +
        '<div class="field"><label for="yf-date">Acesso liberado em</label><input id="yf-date" type="date"></div>' +
        '<button class="btn btn-primary" type="submit" id="yf-add-btn">☆ Favoritar canal</button>' +
      "</form>" +
      '<div class="yf-tiles" id="yf-tiles"></div>' +
      '<div class="yf-filters"><div class="yf-chips" id="yf-chips" role="group" aria-label="Filtrar canais"></div>' +
        '<select id="yf-sort" aria-label="Ordenar"><option value="added">Favoritados por último</option><option value="flow">Mais vídeos citando a Flow</option><option value="waiting">Há mais tempo sem divulgar</option><option value="subs">Mais inscritos</option><option value="last">Postou por último</option></select>' +
        '<input type="search" id="yf-q" placeholder="Buscar canal…" aria-label="Buscar canal"></div>' +
      '<div class="yf-grid" id="yf-grid"></div>';
    var root = A.root;
    root.querySelector("#yf-sort").value = F.sort;
    root.querySelector("#yf-add").addEventListener("submit", async function (e) {
      e.preventDefault();
      var ref = root.querySelector("#yf-ref").value.trim(), date = root.querySelector("#yf-date").value, btn = root.querySelector("#yf-add-btn");
      if (!ref) return;
      btn.disabled = true; btn.textContent = "Buscando no YouTube…";
      var data = await invoke({ action: "fav_add", ref: ref, access_at: date || null });
      btn.disabled = false; btn.textContent = "☆ Favoritar canal";
      if (!data.ok) { A.toast("Não foi possível favoritar: " + (data.error || "erro"), true); return; }
      root.querySelector("#yf-ref").value = ""; root.querySelector("#yf-date").value = "";
      A.toast(data.existed ? "Esse canal já estava nos favoritos; dados atualizados." : "★ Canal favoritado: " + fmtInt(data.videos) + " vídeos lidos.");
      await load(true); render();
    });
    root.querySelector("#yf-sort").addEventListener("change", function (e) { F.sort = e.target.value; render(); });
    root.querySelector("#yf-q").addEventListener("input", function (e) { F.text = e.target.value; render(); });
    root.querySelector("#yf-chips").addEventListener("click", function (e) {
      var b = e.target.closest("[data-yf-f]");
      if (b) { F.status = b.dataset.yfF; render(); }
    });
    root.querySelector("#yf-tiles").addEventListener("click", function (e) {
      var b = e.target.closest("[data-yf-f]");
      if (b) { F.status = b.dataset.yfF; render(); }
    });
    var grid = root.querySelector("#yf-grid");
    grid.addEventListener("click", function (e) {
      var act = e.target.closest("[data-yf-act]");
      if (act) {
        var id = act.dataset.id, k = act.dataset.yfAct;
        if (k === "open") return openDash(id);
        if (k === "sync") return syncOne(id, false);
        if (k === "deep") return syncOne(id, true);
        if (k === "remove") { var f = byId(id); return remove(id, f && f.title); }
        if (k === "today") return setAccess(id, today());
        return;
      }
      if (e.target.closest("a, input, textarea, button, label")) return;
      var card = e.target.closest(".yf-card[data-id]");
      if (card) openDash(card.dataset.id);
    });
    grid.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches(".yf-card[data-id]")) { e.preventDefault(); openDash(e.target.dataset.id); }
    });
    grid.addEventListener("change", function (e) {
      var inp = e.target.closest("input[data-yf-access]");
      if (inp) setAccess(inp.dataset.yfAccess, inp.value || null);
    });
    grid.addEventListener("focusout", function (e) {
      var ta = e.target.closest("textarea[data-yf-notes]");
      if (ta) setNotes(ta.dataset.yfNotes, ta.value);
    });
  }

  async function setAccess(id, date) {
    var f = byId(id);
    if (!f || (f.access_at || null) === (date || null)) return;
    var r = await A.sb.from("yt_favorites").update({ access_at: date || null }).eq("channel_id", id);
    if (r.error) { A.toast("Não foi possível salvar a data: " + r.error.message, true); render(); return; }
    A.toast(date ? "Acesso liberado em " + day(date) + ": contando os vídeos a partir dessa data." : "Data de acesso apagada.");
    // Data mais antiga que os vídeos baixados: busca o histórico até ela.
    if (date && f.oldest_video_at && Date.parse(date + "T00:00:00-03:00") < Date.parse(f.oldest_video_at) && f.videos_total < (f.video_count || 0)) syncOne(id, true, true);
    await load(true); render();
  }
  async function setNotes(id, text) {
    var f = byId(id), v = String(text || "").trim().slice(0, 2000) || null;
    if (!f || (f.notes || null) === v) return;
    var r = await A.sb.from("yt_favorites").update({ notes: v }).eq("channel_id", id);
    if (r.error) { A.toast("Não foi possível salvar a observação: " + r.error.message, true); return; }
    f.notes = v;
    A.toast("Observação salva.");
  }

  function render() {
    if (!A || !A.root.dataset.built || !rows) return;
    var root = A.root, all = rows;
    var withDate = all.filter(function (f) { return f.access_at; });
    var yes = withDate.filter(function (f) { return f.flow_after > 0; }), no = withDate.filter(function (f) { return !(f.flow_after > 0); });
    var vids = all.reduce(function (s, f) { return s + (f.flow_after || 0); }, 0), views = all.reduce(function (s, f) { return s + (Number(f.flow_views_after) || 0); }, 0);
    var tile = function (k, label, val, sub, on) {
      return '<button type="button" class="yf-tile' + (on ? " on" : "") + '" data-yf-f="' + k + '" aria-pressed="' + !!on + '"><small>' + label + "</small><b class=\"num\">" + val + "</b><span>" + sub + "</span></button>";
    };
    root.querySelector("#yf-tiles").innerHTML =
      tile("all", "Canais acompanhados", fmtInt(all.length), withDate.length + " com data de acesso", F.status === "all") +
      tile("yes", "Já divulgaram", fmtInt(yes.length) + (withDate.length ? " <span>de " + withDate.length + "</span>" : ""), withDate.length ? Math.round(yes.length / withDate.length * 100) + "% dos que têm acesso" : "informe as datas de acesso", F.status === "yes") +
      tile("no", "Aguardando divulgação", fmtInt(no.length), no.length ? "com acesso e sem citar a Flow" : "ninguém pendente", F.status === "no") +
      tile("yes", "Vídeos citando a Flow", fmtInt(vids), vids ? fmtN(views) + " views nesses vídeos" : "desde as datas de acesso", false) +
      tile("nodate", "Sem data de acesso", fmtInt(all.length - withDate.length), "informe para começar a contar", F.status === "nodate");

    var CH = [["all", "Todos"], ["yes", "Divulgaram a Flow"], ["no", "Ainda não divulgaram"], ["nodate", "Sem data de acesso"]];
    root.querySelector("#yf-chips").innerHTML = CH.map(function (c) {
      var n = c[0] === "all" ? all.length : c[0] === "yes" ? yes.length : c[0] === "no" ? no.length : all.length - withDate.length;
      return '<button type="button" class="pay-chip' + (F.status === c[0] ? " on" : "") + '" data-yf-f="' + c[0] + '" aria-pressed="' + (F.status === c[0]) + '">' + c[1] + " <small>" + n + "</small></button>";
    }).join("");

    var q = F.text.trim().toLowerCase();
    var list = all.filter(function (f) {
      if (F.status !== "all" && statusOf(f).k !== F.status) return false;
      if (q && (String(f.title || "") + " " + String(f.handle || "") + " " + String(f.notes || "")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = {
      added: function (f) { return Date.parse(f.added_at) || 0; },
      flow: function (f) { return (f.flow_after || 0) * 1e12 + (Number(f.flow_views_after) || 0); },
      waiting: function (f) { return f.access_at && !(f.flow_after > 0) ? daysSince(f.access_at) : -1; },
      subs: function (f) { return Number(f.subscribers) || 0; },
      last: function (f) { return Date.parse(f.last_video_at) || 0; }
    }[F.sort] || function () { return 0; };
    list.sort(function (a, b) { return key(b) - key(a); });

    var grid = root.querySelector("#yf-grid");
    if (!all.length) {
      grid.innerHTML = '<div class="yf-empty"><b>Nenhum canal favoritado ainda.</b><br>Clique na ☆ ao lado de um canal no <b>YouTube</b> ou no <b>Rastrear Mercado</b>, ou cole o link do canal acima.</div>';
      return;
    }
    grid.innerHTML = list.length ? list.map(card).join("") : '<p class="yf-empty">Nenhum canal com esse filtro.</p>';
  }

  function card(f) {
    var st = statusOf(f), d = daysSince(f.access_at), busy = !!syncing[f.channel_id];
    var thumb = f.thumbnail_url ? '<img class="yf-av" src="' + esc(f.thumbnail_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="yf-av ph">YT</span>';
    var growth = "";
    if (f.first_subscribers != null && f.subscribers != null && f.first_snapshot_day) {
      var g = f.subscribers - f.first_subscribers;
      if (daysSince(f.first_snapshot_day) >= 1) growth = '<span class="' + (g >= 0 ? "good" : "bad") + '">' + (g >= 0 ? "+" : "") + fmtInt(g) + "</span> desde " + day(f.first_snapshot_day);
    }
    var tools = [["FlowPages", f.pages_after], ["FlowTracking", f.tracking_after], ["FlowSpy", f.spy_after]].map(function (t) {
      return '<span class="yf-tool' + (t[1] ? " on" : "") + '">' + (t[1] ? "✓ " : "") + t[0] + (t[1] ? " <b>" + t[1] + "</b>" : "") + "</span>";
    }).join("");
    var period = f.access_at ? "desde " + day(f.access_at) : "desde que favoritou (" + day(f.added_at) + ")";
    var loadingNote = !f.fetched_at ? '<p class="yf-note">Buscando os dados no YouTube… (pode levar alguns segundos; recarregue a lista)</p>' :
      f.error ? '<p class="yf-note bad">O YouTube recusou a leitura: ' + esc(f.error) + "</p>" : "";
    var verdict = !f.access_at ? "Informe a data em que liberou o acesso para começar a contar." :
      f.flow_after > 0 ? "<b>" + f.flow_after + (f.flow_after === 1 ? " vídeo citou" : " vídeos citaram") + "</b> a Flow nos " + fmtInt(d) + " dias desde o acesso" + (f.last_flow_at ? " · último " + ago(f.last_flow_at) : "") + "." :
      "<b>Nenhuma citação</b> em " + fmtInt(d) + " dias desde o acesso (" + fmtInt(f.videos_after) + " vídeo(s) publicados no período).";
    return '<article class="yf-card st-' + st.k + '" data-id="' + esc(f.channel_id) + '" tabindex="0" aria-label="Abrir o painel de ' + esc(f.title || f.channel_id) + '">' +
      '<div class="yf-head">' + thumb + '<div class="yf-who"><h4>' + esc(f.title || f.handle || f.channel_id) + "</h4>" +
        '<div class="yf-sub">' + esc(f.handle || "") + (f.country ? " · " + esc(f.country) : "") + (f.source === "mercado" ? " · do Rastrear Mercado" : f.source === "youtube" ? " · influencer da base" : "") + "</div></div>" +
        star({ channel_id: f.channel_id, title: f.title }) + "</div>" +
      '<div class="yf-status"><span class="yf-pill ' + st.cls + '">' + st.label + "</span>" +
        (f.flow_before > 0 ? '<span class="yf-pill soft" title="Vídeos de antes da data de acesso que já citavam FlowPages, FlowTracking ou FlowSpy">já citava antes: ' + f.flow_before + "</span>" : "") + "</div>" +
      '<p class="yf-verdict">' + verdict + "</p>" +
      '<div class="yf-tools">' + tools + "</div>" +
      '<div class="yf-stats">' +
        '<div><small>Inscritos</small><b class="num">' + (f.hidden_subs ? "oculto" : fmtN(f.subscribers)) + "</b><span>" + (growth || "&nbsp;") + "</span></div>" +
        '<div><small>Vídeos ' + esc(period) + '</small><b class="num">' + fmtInt(f.videos_after) + "</b><span>" + fmtInt(f.shorts_after) + " Shorts · " + fmtN(Number(f.views_after)) + " views</span></div>" +
        '<div><small>Último vídeo</small><b class="num">' + (f.last_video_at ? ago(f.last_video_at).replace("há ", "") : "—") + "</b><span>" + (f.last_video_at ? day(f.last_video_at) : "&nbsp;") + "</span></div>" +
      "</div>" +
      '<div class="yf-access"><label>Acesso liberado em <input type="date" data-yf-access="' + esc(f.channel_id) + '" value="' + esc(f.access_at || "") + '" max="' + today() + '"></label>' +
        (f.access_at ? '<span class="muted">' + (d === 0 ? "hoje" : "há " + fmtInt(d) + (d === 1 ? " dia" : " dias")) + "</span>" : '<button type="button" class="btn btn-ghost yf-mini" data-yf-act="today" data-id="' + esc(f.channel_id) + '">Liberei hoje</button>') + "</div>" +
      '<textarea class="yf-notes" data-yf-notes="' + esc(f.channel_id) + '" rows="1" placeholder="Observações (contato, combinado, ferramentas liberadas…)" aria-label="Observações">' + esc(f.notes || "") + "</textarea>" +
      loadingNote +
      '<div class="yf-acts">' +
        '<button type="button" class="btn btn-primary" data-yf-act="open" data-id="' + esc(f.channel_id) + '">⤢ Abrir painel do canal</button>' +
        '<button type="button" class="btn" data-yf-act="sync" data-id="' + esc(f.channel_id) + '"' + (busy ? " disabled" : "") + ' title="Relê o canal e os últimos 100 vídeos (cerca de 5 unidades da cota do YouTube)">' + (busy ? "Atualizando…" : "↻ Atualizar") + "</button>" +
        '<a class="btn" href="' + esc(A.channelUrl(f)) + '" target="_blank" rel="noopener noreferrer">YouTube ↗</a>' +
        '<button type="button" class="btn btn-ghost yf-rm" data-yf-act="remove" data-id="' + esc(f.channel_id) + '" title="Tirar dos favoritos">Remover</button>' +
      "</div></article>";
  }

  /* ---------------- painel completo do canal ---------------- */
  function ctxFor(id) {
    var f = byId(id);
    if (!f) return null;
    var d = daysSince(f.access_at);
    return {
      a: { name: f.title || f.handle || id, email: "" }, c: null, info: null, noContract: true, since: f.access_at || null,
      channel: { c: f, long: { avgViews: null } }, instagram: null, hideInsta: true,
      socials: "★ Favoritado em " + day(f.added_at) + (f.notes ? " · " + esc(String(f.notes).slice(0, 140)) : ""),
      heroNote: f.access_at ? "Acesso às ferramentas Flow liberado em <b>" + day(f.access_at) + "</b> · " + (d === 0 ? "hoje" : "há " + fmtInt(d) + (d === 1 ? " dia" : " dias")) :
        "Sem data de acesso cadastrada: informe na lista de Canais favoritos para separar o antes e o depois.",
      backLabel: "← Voltar aos favoritos",
      sync: function (deep) { return { action: "fav_sync", channelId: id, deep: !!deep }; },
      refetch: async function () { await load(true); if (visible()) render(); return ctxFor(id); }
    };
  }
  function openDash(id) {
    var ctx = ctxFor(id);
    if (!ctx || !A.dash) return;
    A.dash.openCtx(ctx);
  }

  /* ---------------- clique na estrela em qualquer tela ---------------- */
  // Fase de captura: a estrela fica dentro de linhas clicáveis (tabela do YouTube e do radar), que não devem abrir.
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-yf-star]");
    if (!b || !A) return;
    e.preventDefault(); e.stopPropagation();
    var id = b.dataset.yfStar;
    if (ids[id]) remove(id, b.dataset.yfTitle);
    else add({ channel_id: id, title: b.dataset.yfTitle, handle: b.dataset.yfHandle, thumbnail_url: b.dataset.yfThumb, source: b.dataset.yfSrc, affiliate_email: b.dataset.yfEmail });
  }, true);

  return {
    init: function (deps) { A = deps; loadIds().catch(function () {}); },
    show: show,
    star: star,
    isFav: function (id) { return !!ids[id]; },
    paint: paintStars
  };
})();
