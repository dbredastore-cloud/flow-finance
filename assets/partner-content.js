/* Portal do Afiliado · aba Conteúdo.
   O influencer marca quais ferramentas Flow (FlowPages, FlowTracking, FlowSpy) aparecem em cada vídeo do YouTube,
   post do Instagram e story. Só conta como entrega o conteúdo com pelo menos uma ferramenta marcada; vídeos longos,
   reels e stories contam para a meta do ciclo; Shorts, feed e carrossel são extras, fora da meta.
   Stories: o influencer sobe o print das métricas (bucket story-prints, pasta dele), a tarefa agendada do Claude lê os
   números e ele confere e confirma aqui. Tudo passa pelas funções portal_content / portal_tag_content /
   portal_story_create / portal_story_confirm / portal_story_delete, que descobrem o afiliado pelo login. */
(function () {
  "use strict";
  var DAY = 86400000;
  var C = { sb: null, rpc: null, toast: null, root: null, preview: false, onConnect: null, data: null, view: "youtube", cycle: null, busy: {}, urls: {} };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function int(v) { return v == null || isNaN(v) ? "—" : new Intl.NumberFormat("pt-BR").format(Math.round(v)); }
  function short(v) {
    if (v == null || isNaN(v)) return "—";
    var a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(1).replace(".", ",").replace(",0", "") + " mi";
    if (a >= 1e4) return Math.round(v / 1e3) + " mil";
    return int(v);
  }
  function dmy(d) { return d ? d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4) : "—"; }
  function ddmm(d) { return d ? d.slice(8, 10) + "/" + d.slice(5, 7) : "—"; }
  // Data de Brasília (AAAA-MM-DD) de um instante.
  function localDay(iso) { return new Date(Date.parse(iso) - 3 * 3600000).toISOString().slice(0, 10); }
  function today() { return localDay(new Date().toISOString()); }

  /* ---------------- dados ---------------- */
  async function load() {
    C.data = await C.rpc("portal_content");
    var cyc = (C.data && C.data.cycles) || [];
    if (!C.cycle || !cyc.some(function (x) { return x.cycle_start === C.cycle; })) {
      var cur = cyc.filter(function (x) { return x.is_current; })[0] || cyc[0];
      C.cycle = cur ? cur.cycle_start : "all";
    }
    render();
  }
  function curCycle() { return ((C.data && C.data.cycles) || []).filter(function (x) { return x.cycle_start === C.cycle; })[0] || null; }
  // Conteúdo dentro do ciclo escolhido (ou todos).
  function inCycle(day) {
    var c = curCycle();
    if (!c) return true;
    return day >= c.cycle_start && day <= c.cycle_end;
  }

  /* ---------------- ações ---------------- */
  async function setTools(kind, id, tools) {
    var r = await C.sb.rpc("portal_tag_content", { p_kind: kind, p_id: id, p_tools: tools });
    if (r.error) throw r.error;
    return r.data;
  }
  function itemsOf(kind) { return kind === "youtube" ? C.data.youtube : kind === "ig_media" ? C.data.media : C.data.stories; }
  async function onToggle(input) {
    var row = input.closest("[data-item]"), kind = row.getAttribute("data-kind"), id = row.getAttribute("data-item");
    var tools = Array.prototype.slice.call(row.querySelectorAll("input[data-tool]:checked")).map(function (x) { return x.getAttribute("data-tool"); });
    row.classList.add("pc-saving");
    try {
      var saved = await setTools(kind, id, tools);
      var it = itemsOf(kind).filter(function (x) { return x.id === id; })[0];
      if (it) it.tools = saved;
      row.classList.toggle("on", saved.length > 0);
      C.toast(saved.length ? "Marcado: conta como entrega." : "Sem ferramenta marcada: não conta como entrega.");
      // Recalcula o progresso do ciclo.
      var fresh = await C.rpc("portal_content");
      if (fresh) { C.data.cycles = fresh.cycles; renderProgress(); }
    } catch (e) {
      input.checked = !input.checked;
      C.toast(e.message || String(e), true);
    } finally { row.classList.remove("pc-saving"); }
  }

  // Reduz o print (até 1600 px, JPEG) antes de subir; se o navegador não abrir o formato (ex.: HEIC), sobe o original.
  function shrink(file) {
    return new Promise(function (resolve) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { resolve(file); return; }
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var k = Math.min(1, 1600 / Math.max(img.width, img.height));
        var cv = document.createElement("canvas");
        cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob(function (b) { resolve(b && b.size < file.size ? b : file); }, "image/jpeg", 0.88);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  async function submitStory(form) {
    var day = form.querySelector("[name=day]").value, file = form.querySelector("[name=print]").files[0];
    var tools = Array.prototype.slice.call(form.querySelectorAll("input[data-tool]:checked")).map(function (x) { return x.getAttribute("data-tool"); });
    var msg = form.querySelector(".pc-msg");
    var fail = function (t) { msg.className = "pc-msg msg error"; msg.textContent = t; };
    if (!day) return fail("Informe o dia em que o story foi postado.");
    if (day > today()) return fail("O dia do story não pode ser no futuro.");
    if (!file) return fail("Anexe o print das métricas do story.");
    if (!tools.length) return fail("Marque pelo menos uma ferramenta que aparece no story.");
    var btn = form.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "Enviando…"; msg.className = "pc-msg"; msg.textContent = "";
    try {
      var f = await C.sb.rpc("portal_story_folder");
      if (f.error || !f.data) throw new Error("Seu login não está ligado a um afiliado.");
      var blob = await shrink(file);
      var ext = blob.type === "image/jpeg" ? "jpg" : (file.name.split(".").pop() || "img").toLowerCase().replace(/[^a-z0-9]/g, "");
      var path = f.data + "/" + day + "-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)) + "." + ext;
      var up = await C.sb.storage.from("story-prints").upload(path, blob, { contentType: blob.type || file.type, upsert: false });
      if (up.error) throw up.error;
      var r = await C.sb.rpc("portal_story_create", { p_day: day, p_path: path, p_tools: tools });
      if (r.error) { await C.sb.storage.from("story-prints").remove([path]); throw r.error; }
      C.toast("Story enviado! A leitura do print sai em até 1 dia; depois é só conferir os números aqui.");
      form.reset();
      await load();
    } catch (e) {
      fail(e.message || String(e));
    } finally { btn.disabled = false; btn.textContent = "Enviar story"; }
  }
  async function confirmStory(box) {
    var id = box.getAttribute("data-story"), val = function (n) { var v = box.querySelector("[name=" + n + "]").value.trim(); return v === "" ? null : Math.max(0, parseInt(v.replace(/\D/g, ""), 10) || 0); };
    var day = box.querySelector("[name=sday]").value;
    var btn = box.querySelector("[data-act=confirm]");
    btn.disabled = true;
    try {
      var r = await C.sb.rpc("portal_story_confirm", { p_id: id, p_day: day, p_reach: val("reach"), p_views: val("views"), p_replies: val("replies"), p_shares: val("shares"), p_link_taps: val("link_taps") });
      if (r.error) throw r.error;
      C.toast("Números confirmados.");
      await load();
    } catch (e) { C.toast(e.message || String(e), true); btn.disabled = false; }
  }
  async function deleteStory(id) {
    if (!window.confirm("Apagar este story? O print e as marcações saem do sistema.")) return;
    var r = await C.sb.rpc("portal_story_delete", { p_id: id });
    if (r.error) { C.toast(r.error.message, true); return; }
    if (r.data && r.data.image_path) await C.sb.storage.from("story-prints").remove([r.data.image_path]);
    C.toast("Story apagado.");
    await load();
  }
  async function showPrint(btn, path) {
    var holder = btn.closest("[data-story]").querySelector(".pc-print");
    if (!holder.hidden) { holder.hidden = true; btn.textContent = "Ver print"; return; }
    if (!C.urls[path]) {
      var s = await C.sb.storage.from("story-prints").createSignedUrl(path, 600);
      if (s.error) { C.toast(s.error.message, true); return; }
      C.urls[path] = s.data.signedUrl;
      setTimeout(function () { delete C.urls[path]; }, 540000);
    }
    holder.innerHTML = '<a href="' + esc(C.urls[path]) + '" target="_blank" rel="noopener noreferrer"><img src="' + esc(C.urls[path]) + '" alt="Print das métricas do story"></a>';
    holder.hidden = false; btn.textContent = "Esconder print";
  }

  /* ---------------- telas ---------------- */
  function toolBoxes(tools, sel, disabled) {
    return '<div class="pc-tools">' + (C.data.tools || []).map(function (t) {
      return '<label class="pc-tool"><input type="checkbox" data-tool="' + esc(t.slug) + '"' + (sel.indexOf(t.slug) >= 0 ? " checked" : "") + (disabled ? " disabled" : "") + "> " + esc(t.name) + "</label>";
    }).join("") + "</div>";
  }
  function badge(meta, label) { return '<span class="pp-st mini' + (meta ? " ok" : "") + '">' + label + "</span>"; }

  function renderProgress() {
    var el = C.root.querySelector("#pc-progress");
    if (!el) return;
    var c = curCycle(), k = C.data.contract;
    if (!c) { el.innerHTML = '<p class="muted pp-hint">O contrato ainda não começou.</p>'; return; }
    var left = Math.round((Date.parse(c.cycle_end + "T23:59:59-03:00") - Date.now()) / DAY);
    var bar = function (label, done, goal) {
      var p = goal ? Math.min(1, done / goal) : 1, falta = Math.max(0, goal - done);
      return '<div class="pc-goal"><div class="pc-goal-t"><b>' + label + '</b><span class="num">' + int(done) + " / " + int(goal) + "</span></div>" +
        '<div class="pp-bar-track"><i style="width:' + (p * 100).toFixed(1) + '%"></i></div>' +
        '<span class="muted">' + (falta ? "falta" + (falta > 1 ? "m " : " ") + int(falta) : "meta batida ✓") + "</span></div>";
    };
    var tools = C.data.tools || [], bt = c.by_tool || {};
    el.innerHTML =
      '<div class="pp-head"><h2>Entregas do ' + c.cycle_no + "º ciclo</h2><span class=\"muted\">" + ddmm(c.cycle_start) + " a " + ddmm(c.cycle_end) +
        (c.is_current ? " · " + (left > 0 ? "faltam " + left + (left === 1 ? " dia" : " dias") : "último dia") : c.closed ? " · fechado" : "") + "</span></div>" +
      '<div class="pc-goals">' + bar("Stories", c.stories, k.stories_per_month) + bar("Reels", c.reels, k.reels_per_month) + bar("YouTube", c.youtube, k.youtube_per_month) + "</div>" +
      '<p class="muted pp-hint">Extras (fora da meta): ' + int(c.feed_extra) + " post(s) de feed/carrossel e " + int(c.shorts_extra) + " Short(s)." +
        (c.story_reach ? " Alcance dos stories confirmados: <b>" + short(c.story_reach) + "</b>." : "") +
        (c.stories_adj || c.reels_adj || c.youtube_adj ? " Inclui ajuste da equipe Flow." : "") + "</p>" +
      '<div class="table-scroll"><table class="pp-table pc-bytool"><thead><tr><th class="l">Ferramenta</th><th>Stories</th><th>Reels</th><th>YouTube</th><th>Feed/carrossel</th><th>Shorts</th><th>Alcance stories</th></tr></thead><tbody>' +
        tools.map(function (t) {
          var x = bt[t.slug] || {};
          return '<tr><td class="l">' + esc(t.name) + "</td><td>" + int(x.stories || 0) + "</td><td>" + int(x.reels || 0) + "</td><td>" + int(x.youtube || 0) +
            "</td><td>" + int(x.feed || 0) + "</td><td>" + int(x.shorts || 0) + "</td><td>" + short(x.story_reach || 0) + "</td></tr>";
        }).join("") + "</tbody></table></div>" +
      '<p class="muted pp-hint">Um conteúdo com duas ferramentas conta 1 vez na meta e aparece nas duas linhas.</p>';
  }

  function igNotice() {
    var ig = C.data.ig || {};
    if (ig.connected) return "";
    var expired = ig.connection_status === "expired";
    var txt = expired ? "A autorização do seu Instagram venceu. Conecte de novo para a Flow voltar a ver o alcance dos seus posts."
      : ig.has_account
        ? "Seus reels e posts do feed aparecem aqui pelo seu perfil público, mas sem conectar a conta a Flow não vê o alcance nem os stories. Os stories você envia por print, na aba Stories."
        : "Ainda não encontramos o seu perfil. Sem conectar a conta (ou sem perfil profissional cadastrado), seus reels e posts do feed não entram sozinhos e não dá para marcar as ferramentas neles.";
    return '<div class="pp-igc warn"><div><b>' + (expired ? "Instagram desconectado" : "Seu Instagram não está conectado") + "</b><span>" + txt + "</span></div>" +
      (C.preview ? "" : '<button type="button" class="btn btn-primary" data-pc="connect">Conectar Instagram</button>') + "</div>";
  }

  function renderYoutube() {
    if (!C.data.has_channel) return '<p class="empty">Seu canal do YouTube ainda não está cadastrado. Fale com a equipe Flow para ligar o canal ao seu cadastro.</p>';
    var list = (C.data.youtube || []).filter(function (v) { return inCycle(localDay(v.published_at)); });
    if (!list.length) return '<p class="empty">Nenhum vídeo publicado neste período.</p>';
    return '<div class="pc-list">' + list.map(function (v) {
      var url = "https://www.youtube.com/" + (v.is_short ? "shorts/" : "watch?v=") + encodeURIComponent(v.id);
      return '<div class="pc-item' + (v.tools.length ? " on" : "") + '" data-kind="youtube" data-item="' + esc(v.id) + '">' +
        '<a class="pc-thumb" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + (v.thumbnail_url ? '<img src="' + esc(v.thumbnail_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : "") + "</a>" +
        '<div class="pc-body"><a class="pc-title" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(v.title) + "</a>" +
          '<div class="pc-meta">' + dmy(localDay(v.published_at)) + " · " + short(v.views) + " views · " + (v.is_short ? badge(false, "Short · extra") : badge(true, "vídeo · conta na meta")) + "</div>" +
          toolBoxes(C.data.tools, v.tools, C.preview) + "</div></div>";
    }).join("") + "</div>";
  }

  function renderInstagram() {
    var list = (C.data.media || []).filter(function (m) { return inCycle(localDay(m.posted_at)); });
    var reels = list.filter(function (m) { return m.media_product_type === "REELS"; }), extra = list.filter(function (m) { return m.media_product_type !== "REELS"; });
    var row = function (m) {
      var reel = m.media_product_type === "REELS", kind = reel ? "Reels" : m.media_type === "CAROUSEL_ALBUM" ? "Carrossel" : "Feed";
      return '<div class="pc-item' + (m.tools.length ? " on" : "") + '" data-kind="ig_media" data-item="' + esc(m.id) + '">' +
        '<a class="pc-thumb sq" href="' + esc(m.permalink || "#") + '" target="_blank" rel="noopener noreferrer">' + (m.thumbnail_url ? '<img src="' + esc(m.thumbnail_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : "") + "</a>" +
        '<div class="pc-body"><div class="pc-title">' + esc((m.caption || "(sem legenda)").slice(0, 140)) + "</div>" +
          '<div class="pc-meta">' + dmy(localDay(m.posted_at)) + " · " + badge(reel, kind + (reel ? " · conta na meta" : " · extra")) +
            " · ♥ " + short(m.like_count) + (m.view_count != null ? " · ▶ " + short(m.view_count) : "") + (m.reach != null ? " · alcance " + short(m.reach) : "") + "</div>" +
          toolBoxes(C.data.tools, m.tools, C.preview) + "</div></div>";
    };
    return igNotice() +
      '<h3 class="pp-h3">Reels <small class="muted">contam para a meta</small></h3>' +
      (reels.length ? '<div class="pc-list">' + reels.map(row).join("") + "</div>" : '<p class="empty">Nenhum reels neste período.</p>') +
      '<h3 class="pp-h3">Extras: feed e carrossel <small class="muted">aparecem nos relatórios, fora da meta</small></h3>' +
      (extra.length ? '<div class="pc-list">' + extra.map(row).join("") + "</div>" : '<p class="empty">Nenhum post de feed ou carrossel neste período.</p>');
  }

  var ST = { reading: ["wait", "aguardando leitura do print"], review: ["wait", "confira os números"], confirmed: ["ok", "confirmado"] };
  function renderStories() {
    var form = C.preview ? "" :
      '<form class="pc-form" id="pc-story-form">' +
        "<h3 class=\"pp-h3\">Enviar story</h3>" +
        '<p class="muted pp-hint">Espere as 24 horas do story, abra o histórico de stories no Instagram, toque no story e em "Atividade" e tire um print das métricas. Um print por story.</p>' +
        '<div class="pc-form-row"><label class="field"><span>Dia em que o story foi postado</span><input type="date" name="day" max="' + today() + '" required></label>' +
          '<label class="field"><span>Print das métricas</span><input type="file" name="print" accept="image/*" required></label></div>' +
        '<div class="field"><span class="pc-lbl">Ferramentas que aparecem no story</span>' + toolBoxes(C.data.tools, [], false) + "</div>" +
        '<button type="submit" class="btn btn-primary">Enviar story</button><div class="pc-msg"></div>' +
      "</form>";
    var list = (C.data.stories || []).filter(function (s) { return inCycle(s.day); });
    var num = function (n, label, v, sug) {
      return '<label class="pc-num"><span>' + label + '</span><input inputmode="numeric" name="' + n + '" value="' + (v != null ? v : sug != null ? sug : "") + '"' + (C.preview ? " disabled" : "") + ">" +
        (sug != null && v == null ? "<small>lido do print</small>" : "") + "</label>";
    };
    var rows = list.map(function (s) {
      var st = ST[s.status] || ST.confirmed, a = s.ai_read || {}, print = s.source === "print", edit = print && s.status !== "confirmed";
      var nums = print
        ? '<div class="pc-nums">' + num("reach", "Alcance", s.reach, a.reach) + num("views", "Visualizações", s.views, a.views) + num("replies", "Respostas", s.replies, a.replies) +
            num("shares", "Compartilhamentos", s.shares, a.shares) + num("link_taps", "Toques no link", s.link_taps, a.link_taps) +
            '<label class="pc-num"><span>Dia</span><input type="date" name="sday" value="' + esc(s.day) + '" max="' + today() + '"' + (C.preview ? " disabled" : "") + "></label></div>"
        : '<div class="pc-meta">Alcance ' + short(s.reach) + " · " + short(s.views) + " visualizações · " + int(s.replies) + " respostas · " + int(s.shares) + " compartilhamentos</div>";
      var note = s.status === "reading" ? "O print ainda vai ser lido (em até 1 dia). Se preferir, digite os números e confirme agora."
        : s.status === "review" ? "Confira os números lidos do print, corrija o que estiver errado e confirme." + (a.note ? " Observação da leitura: " + esc(a.note) : "") : "";
      return '<div class="pc-item pc-story' + (s.tools.length ? " on" : "") + '" data-kind="ig_story" data-item="' + esc(s.id) + '" data-story="' + esc(s.id) + '">' +
        '<div class="pc-body"><div class="pc-title">Story de ' + dmy(s.day) + " " + '<span class="pp-st mini ' + st[0] + '">' + st[1] + "</span>" +
          (print ? ' <span class="muted">· enviado por print</span>' : ' <span class="muted">· lido do Instagram conectado</span>') + "</div>" +
          (note ? '<p class="muted pp-hint">' + note + "</p>" : "") + nums +
          toolBoxes(C.data.tools, s.tools, C.preview) +
          (print ? '<div class="pc-acts">' + (s.image_path ? '<button type="button" class="btn btn-ghost" data-act="print" data-path="' + esc(s.image_path) + '">Ver print</button>' : "") +
            (C.preview ? "" : (edit ? '<button type="button" class="btn btn-primary" data-act="confirm">Confirmar números</button>' : '<button type="button" class="btn btn-ghost" data-act="confirm">Salvar correção</button>') +
              '<button type="button" class="btn btn-ghost pc-del" data-act="delete">Apagar</button>') + "</div>" : "") +
          '<div class="pc-print" hidden></div>' +
        "</div></div>";
    }).join("");
    return form + '<h3 class="pp-h3">Seus stories</h3>' + (rows ? '<div class="pc-list">' + rows + "</div>" : '<p class="empty">Nenhum story neste período.</p>') +
      '<p class="muted pp-hint">O story conta na meta assim que é enviado com uma ferramenta marcada. O alcance entra nos relatórios depois que você confirma os números.</p>';
  }

  function render() {
    var root = C.root;
    if (!C.data || !C.data.contract) {
      root.innerHTML = '<section class="panel pp-panel"><p class="empty">Você ainda não tem um contrato de Influencer Flow. Quando tiver, suas entregas aparecem aqui.</p></section>';
      return;
    }
    var cyc = C.data.cycles || [];
    var counts = {
      youtube: (C.data.youtube || []).filter(function (v) { return inCycle(localDay(v.published_at)) && !v.tools.length; }).length,
      instagram: (C.data.media || []).filter(function (m) { return inCycle(localDay(m.posted_at)) && !m.tools.length; }).length,
      stories: (C.data.stories || []).filter(function (s) { return inCycle(s.day) && s.status === "review"; }).length
    };
    var tab = function (k, label, n, hint) { return '<button type="button" class="pp-chip' + (C.view === k ? " on" : "") + '" data-view="' + k + '">' + label + (n ? " <small>" + n + " " + hint + "</small>" : "") + "</button>"; };
    root.innerHTML =
      '<section class="panel pp-panel" id="pc-progress"></section>' +
      '<section class="panel pp-panel">' +
        '<div class="pp-head"><h2>Seu conteúdo</h2>' +
          '<label class="pc-cycle muted">Período <select id="pc-cycle">' + cyc.map(function (x) {
            return '<option value="' + x.cycle_start + '"' + (x.cycle_start === C.cycle ? " selected" : "") + ">" + x.cycle_no + "º ciclo · " + ddmm(x.cycle_start) + " a " + ddmm(x.cycle_end) + (x.is_current ? " (atual)" : "") + "</option>";
          }).join("") + '<option value="all"' + (C.cycle === "all" ? " selected" : "") + ">Todo o contrato</option></select></label></div>" +
        '<p class="muted pp-hint">Marque as ferramentas Flow que aparecem em cada conteúdo. Só conta como entrega o que tem pelo menos uma ferramenta marcada.' + (C.preview ? " <b>Na visão da equipe as marcações ficam travadas.</b>" : "") + "</p>" +
        '<div class="pp-chips pc-tabs">' + tab("youtube", "YouTube", counts.youtube, "sem marcar") + tab("instagram", "Instagram", counts.instagram, "sem marcar") + tab("stories", "Stories", counts.stories, "para conferir") + "</div>" +
        '<div id="pc-view">' + (C.view === "youtube" ? renderYoutube() : C.view === "instagram" ? renderInstagram() : renderStories()) + "</div>" +
      "</section>";
    renderProgress();
  }

  function wire() {
    var root = C.root;
    root.addEventListener("change", function (e) {
      if (e.target.id === "pc-cycle") { C.cycle = e.target.value; render(); return; }
      var t = e.target.closest("input[data-tool]");
      if (t && !t.closest("#pc-story-form")) onToggle(t);
    });
    root.addEventListener("click", function (e) {
      var v = e.target.closest("[data-view]");
      if (v) { C.view = v.getAttribute("data-view"); render(); return; }
      var c = e.target.closest("[data-pc=connect]");
      if (c && C.onConnect) { C.onConnect(c); return; }
      var a = e.target.closest("[data-act]");
      if (!a) return;
      var box = a.closest("[data-story]"), act = a.getAttribute("data-act");
      if (act === "print") showPrint(a, a.getAttribute("data-path"));
      else if (act === "confirm") confirmStory(box);
      else if (act === "delete") deleteStory(box.getAttribute("data-story"));
    });
    root.addEventListener("submit", function (e) {
      if (e.target.id === "pc-story-form") { e.preventDefault(); submitStory(e.target); }
    });
  }

  var wired = false;
  window.PartnerContent = {
    // opts: { sb, rpc, toast, root, preview, onConnect }
    show: async function (opts) {
      Object.assign(C, opts);
      if (!wired) { wire(); wired = true; }
      if (!C.data) C.root.innerHTML = '<section class="panel pp-panel"><p class="muted">Carregando seu conteúdo…</p></section>';
      try { await load(); } catch (e) { C.root.innerHTML = '<section class="panel pp-panel"><p class="msg error">Não foi possível carregar: ' + esc(e.message || String(e)) + "</p></section>"; }
    },
    // Quantos itens pedem atenção (sem marcar no ciclo atual + stories para conferir), para a bolinha do menu.
    // d = resultado de portal_content.
    pending: function (d) {
      if (!d || !d.contract) return null;
      var cur = (d.cycles || []).filter(function (x) { return x.is_current; })[0];
      if (!cur) return 0;
      var inC = function (day) { return day >= cur.cycle_start && day <= cur.cycle_end; };
      return (d.stories || []).filter(function (s) { return s.status === "review"; }).length +
        (d.youtube || []).filter(function (v) { return inC(localDay(v.published_at)) && !v.tools.length; }).length +
        (d.media || []).filter(function (m) { return inC(localDay(m.posted_at)) && !m.tools.length; }).length;
    }
  };
})();
