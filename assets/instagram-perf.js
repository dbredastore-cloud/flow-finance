/* @useaflow — abas Desempenho, Stories, Comentários e Direct do menu @useaflow do Financeiro (assets/useaflow.js).
   Dados lidos pela API da Meta e gravados no Supabase:
   - ig_account_daily, ig_media, ig_comments: Edge Function instagram-own (a cada 6 h);
   - ig_stories: Edge Function instagram-stories (de hora em hora; a Meta só entrega um story nas 24 h em que está no ar);
   - ig_conversations, ig_messages: Edge Function instagram-dm (de hora em hora; respostas e menções em stories incluídas).
   O botão "Atualizar agora" chama a função na hora (só quem está em app_admins).
   Uso: InstagramPerf.init({ root, sb, toast, url }); InstagramPerf.show("desempenho" | "stories" | "comentarios" | "direct"); */
(function () {
  "use strict";

  var A = null;
  var S = { ready: false, tab: "desempenho", days: [], media: [], stories: [], comments: [], convs: [], msgs: [], runs: {}, sort: "recentes", q: "", dq: "", dfilter: "", openConv: null, busy: false };

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var nf = new Intl.NumberFormat("pt-BR");
  function n(v) { return v == null ? "—" : nf.format(Math.round(Number(v))); }
  function pct(v) { return v == null || !isFinite(v) ? "—" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%"; }
  function dt(iso, withTime) {
    if (!iso) return "";
    var o = { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit" };
    if (withTime) { o.hour = "2-digit"; o.minute = "2-digit"; }
    return new Date(iso).toLocaleString("pt-BR", o);
  }
  function sum(rows, k) { return rows.reduce(function (s, r) { return s + (Number(r[k]) || 0); }, 0); }
  function first(line) { return String(line || "").split("\n")[0]; }
  function kind(m) { return m.media_product_type === "REELS" ? "Reel" : m.media_type === "CAROUSEL_ALBUM" ? "Carrossel" : m.media_type === "VIDEO" ? "Vídeo" : "Imagem"; }
  function eng(m) { var r = Number(m.reach) || 0; return r ? ((Number(m.like_count) || 0) + (Number(m.comments_count) || 0) + (Number(m.shares) || 0) + (Number(m.saved) || 0)) / r * 100 : null; }

  /* ---------------- dados ---------------- */
  function cacheKey() { return "flow_igperf_cache_v1:" + ((window.FlowAccess && window.FlowAccess.email()) || ""); }
  function cacheRead() { try { return JSON.parse(sessionStorage.getItem(cacheKey()) || "null"); } catch (e) { return null; } }
  // O Direct não vai para o cache da aba (mensagens pessoais ficam só na memória da página).
  function cacheWrite() { try { sessionStorage.setItem(cacheKey(), JSON.stringify({ days: S.days, media: S.media, stories: S.stories, comments: S.comments, runs: S.runs })); } catch (e) {} }

  async function load() {
    var r = await Promise.all([
      A.sb.from("ig_account_daily").select("*").order("day", { ascending: true }).limit(400),
      A.sb.from("ig_media").select("id, media_type, media_product_type, caption, permalink, posted_at, like_count, comments_count, reach, views, saved, shares, total_interactions, follows, profile_visits, avg_watch_ms, skip_rate, insights_note").order("posted_at", { ascending: false }).limit(1000),
      A.sb.from("ig_stories").select("*").order("posted_at", { ascending: false }).limit(1000),
      A.sb.from("ig_comments").select("id, media_id, parent_id, username, text, like_count, posted_at").order("posted_at", { ascending: false }).limit(2000),
      A.sb.from("sync_state").select("key, value").in("key", ["instagram_own_last_run", "instagram_stories_last_run", "instagram_dm_last_run"]),
      A.sb.from("ig_conversations").select("id, username, updated_at").order("updated_at", { ascending: false }).limit(2000),
      A.sb.from("ig_messages").select("id, conversation_id, from_username, from_business, text, story_url, attachment, created_at").order("created_at", { ascending: false }).limit(10000)
    ]);
    r.forEach(function (x) { if (x.error) throw x.error; });
    S.days = r[0].data || []; S.media = r[1].data || []; S.stories = r[2].data || []; S.comments = r[3].data || [];
    S.runs = {};
    (r[4].data || []).forEach(function (x) { S.runs[x.key] = x.value; });
    S.convs = r[5].data || []; S.msgs = r[6].data || [];
  }

  async function refresh(fn) {
    if (S.busy) return;
    S.busy = true; render();
    try {
      var sess = await A.sb.auth.getSession();
      var token = sess && sess.data && sess.data.session && sess.data.session.access_token;
      var res = await fetch(A.url + "/functions/v1/" + fn, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: "{}" });
      var js = await res.json().catch(function () { return {}; });
      if (!res.ok || js.ok === false) throw new Error(js.error || ("HTTP " + res.status));
      await load(); cacheWrite();
      A.toast(fn === "instagram-stories" ? "Stories atualizados: " + (js.live || 0) + " no ar."
        : fn === "instagram-dm" ? "Direct atualizado: " + (js.conversations || 0) + " conversas."
        : "Instagram atualizado: " + (js.media || 0) + " posts e reels.");
    } catch (e) {
      A.toast("Não foi possível atualizar: " + (e.message || e), true);
    }
    S.busy = false; render();
  }

  /* ---------------- desenho ---------------- */
  function render() {
    var root = A.root;
    var body = S.tab === "stories" ? viewStories() : S.tab === "comentarios" ? viewComments() : S.tab === "direct" ? viewDirect() : viewPerf();
    root.innerHTML = body;
  }

  function runLine(key, fn, label) {
    var r = S.runs[key];
    var when = r && r.at ? "Última leitura da Meta: " + dt(r.at, true) : "Ainda sem leitura da Meta.";
    var err = r && r.ok === false ? ' <span class="ip-err">' + esc(r.error || "falhou") + "</span>" : "";
    return '<div class="ip-run"><span>' + esc(when) + err + '</span><button type="button" class="btn" data-perf="refresh" data-fn="' + fn + '"' + (S.busy ? " disabled" : "") + ">" +
      (S.busy ? "Atualizando…" : esc(label)) + "</button></div>";
  }
  function tile(lbl, val, sub, cls) { return '<div class="ig-tile ip-tile' + (cls ? " " + cls : "") + '"><small>' + esc(lbl) + '</small><b class="num">' + val + "</b><span>" + sub + "</span></div>"; }
  function delta(cur, prev) {
    if (!prev) return "";
    var d = (cur - prev) / prev * 100;
    return '<em class="' + (d >= 0 ? "up" : "down") + '">' + (d >= 0 ? "+" : "") + d.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + "%</em> vs 7 dias antes";
  }

  function viewPerf() {
    var days = S.days, last = days.slice(-7), prev = days.slice(-14, -7);
    var withFollowers = days.filter(function (d) { return d.followers_count != null; });
    var followers = withFollowers.length ? withFollowers[withFollowers.length - 1].followers_count : null;
    var newF = sum(days.slice(-30), "new_followers");
    var head = '<div class="ip-head"><div><div class="ch-kicker">Desempenho</div><h3 class="ch-title">@useaflow</h3>' +
      '<p class="ch-sub">Alcance, visualizações e interações da conta por dia, e cada post e reel com as métricas que a Meta entrega.</p></div>' + runLine("instagram_own_last_run", "instagram-own", "Atualizar agora") + "</div>";
    var tiles = '<div class="ig-tiles">' +
      tile("Seguidores", n(followers), newF ? "+" + n(newF) + " novos em 30 dias" : "foto da última leitura") +
      tile("Alcance · 7 dias", n(sum(last, "reach")), delta(sum(last, "reach"), sum(prev, "reach")) || "soma das contas alcançadas por dia") +
      tile("Visualizações · 7 dias", n(sum(last, "views")), delta(sum(last, "views"), sum(prev, "views")) || "posts, reels e stories") +
      tile("Interações · 7 dias", n(sum(last, "total_interactions")), delta(sum(last, "total_interactions"), sum(prev, "total_interactions")) || "curtidas, comentários, salvos…") +
      tile("Respostas a stories · 7 dias", n(sum(last, "replies")), "mensagens e reações no Direct") + "</div>";
    var chart = '<section class="panel ip-card"><div class="ip-card-h"><h4>Alcance por dia</h4><span>Últimos ' + Math.min(days.length, 30) + " dias · passe o mouse para ver o dia</span></div>" + bars(days.slice(-30)) + "</section>";
    return head + tiles + chart + mediaTable();
  }

  function bars(days) {
    if (!days.length) return '<p class="ig-empty">Sem dados da conta ainda.</p>';
    var max = Math.max.apply(null, days.map(function (d) { return Number(d.reach) || 0; })) || 1;
    return '<div class="ip-bars">' + days.map(function (d) {
      var h = Math.round((Number(d.reach) || 0) / max * 100);
      var label = new Date(d.day + "T12:00:00Z").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
      return '<div class="ip-bar" title="' + esc(label + " · alcance " + n(d.reach) + " · views " + n(d.views) + " · interações " + n(d.total_interactions)) + '"><i style="height:' + Math.max(h, 2) + '%"></i><span>' + label.slice(0, 2) + "</span></div>";
    }).join("") + "</div>";
  }

  function mediaTable() {
    var list = S.media.slice();
    var by = { alcance: "reach", views: "views", engaj: null, seguidores: "follows" }[S.sort];
    if (S.sort === "engaj") list.sort(function (a, b) { return (eng(b) || 0) - (eng(a) || 0); });
    else if (by) list.sort(function (a, b) { return (Number(b[by]) || 0) - (Number(a[by]) || 0); });
    var sorts = [["recentes", "Mais recentes"], ["alcance", "Maior alcance"], ["views", "Mais views"], ["engaj", "Maior engajamento"], ["seguidores", "Mais seguidores"]];
    var rows = list.map(function (m) {
      return "<tr><td>" + esc(dt(m.posted_at)) + "</td><td>" + esc(kind(m)) + '</td><td class="ip-txt">' +
        (m.permalink ? '<a href="' + esc(m.permalink) + '" target="_blank" rel="noopener">' + esc(first(m.caption).slice(0, 90) || "(sem legenda)") + "</a>" : esc(first(m.caption).slice(0, 90))) + "</td>" +
        '<td class="n">' + n(m.reach) + '</td><td class="n">' + n(m.views) + '</td><td class="n">' + n(m.like_count) + '</td><td class="n">' + n(m.comments_count) +
        '</td><td class="n">' + n(m.shares) + '</td><td class="n">' + n(m.saved) + '</td><td class="n">' + pct(eng(m)) + '</td><td class="n">' + n(m.follows) +
        '</td><td class="n">' + n(m.profile_visits) + '</td><td class="n">' + (m.avg_watch_ms == null ? "—" : (m.avg_watch_ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " s") +
        '</td><td class="n">' + (m.skip_rate == null ? "—" : pct(m.skip_rate * 100)) + "</td></tr>";
    }).join("");
    return '<section class="panel ip-card"><div class="ip-card-h"><h4>Posts e reels</h4><span>' + S.media.length + " publicações. Engajamento = curtidas + comentários + compartilhamentos + salvos ÷ alcance. Seguidores e visitas ao perfil a Meta só mede no feed; tempo assistido e pulos nos 3 primeiros segundos, só em reels.</span></div>" +
      '<div class="ip-sorts">' + sorts.map(function (s) { return '<button type="button" class="btn' + (S.sort === s[0] ? " btn-primary" : "") + '" data-perf="sort" data-v="' + s[0] + '">' + esc(s[1]) + "</button>"; }).join("") + "</div>" +
      '<div class="table-scroll ip-scroll"><table class="ip-table"><thead><tr><th>Data</th><th>Tipo</th><th>Legenda</th><th class="n">Alcance</th><th class="n">Views</th><th class="n">Curtidas</th><th class="n">Coment.</th><th class="n">Compart.</th><th class="n">Salvos</th><th class="n">Engaj.</th><th class="n">Seguidores</th><th class="n">Visitas</th><th class="n">Tempo médio</th><th class="n">Pulou 3s</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="14" class="ig-empty">Nenhuma publicação lida ainda.</td></tr>') + "</tbody></table></div></section>";
  }

  function viewStories() {
    var st = S.stories, done = st.filter(function (s) { return s.final; });
    var base = done.length ? done : st;
    var avg = function (k) { return base.length ? sum(base, k) / base.length : null; };
    var exitPct = sum(base, "views") ? sum(base, "exits") / sum(base, "views") * 100 : null;
    var head = '<div class="ip-head"><div><div class="ch-kicker">Stories</div><h3 class="ch-title">Histórico de stories</h3>' +
      '<p class="ch-sub">A Meta só entrega um story nas 24 horas em que ele está no ar. O painel lê de hora em hora e, quando o story sai do ar, a última leitura fica como a final. Votos de enquete e perguntas da caixinha não saem pela API: veja no app.</p></div>' +
      runLine("instagram_stories_last_run", "instagram-stories", "Atualizar stories") + "</div>";
    var tiles = '<div class="ig-tiles">' +
      tile("Stories guardados", n(st.length), st.length - done.length ? n(st.length - done.length) + " ainda no ar" : "todos com leitura final") +
      tile("Alcance médio", n(avg("reach")), done.length ? "por story finalizado" : "por story") +
      tile("Views médias", n(avg("views")), "por story") +
      tile("Saídas", pct(exitPct), "das visualizações terminaram em saída") +
      tile("Respostas", n(sum(st, "replies")), "no total") + "</div>";
    var rows = st.map(function (s) {
      var v = Number(s.views) || 0;
      return "<tr><td>" + (s.permalink ? '<a href="' + esc(s.permalink) + '" target="_blank" rel="noopener">' + esc(dt(s.posted_at, true)) + "</a>" : esc(dt(s.posted_at, true))) +
        (s.caption ? '<span class="ip-cap">' + esc(first(s.caption).slice(0, 80)) + "</span>" : "") + "</td><td>" +
        (s.media_type === "VIDEO" ? "Vídeo" : "Imagem") + '</td><td class="n">' + n(s.reach) + '</td><td class="n">' + n(s.views) + '</td><td class="n">' + n(s.replies) +
        '</td><td class="n">' + n(s.shares) + '</td><td class="n">' + n(s.total_interactions) + '</td><td class="n">' + n(s.taps_forward) + '</td><td class="n">' + n(s.taps_back) +
        '</td><td class="n">' + n(s.exits) + '</td><td class="n">' + n(s.swipes_forward) + '</td><td class="n">' + n(s.follows) + '</td><td class="n">' + n(s.profile_visits) +
        '</td><td class="n">' + (v && s.exits != null ? pct(s.exits / v * 100) : "—") + '</td><td><span class="ip-pill' + (s.final ? "" : " live") + '">' + (s.final ? "Final" : "No ar") + "</span>" +
        (s.insights_note ? '<div class="ip-note">' + esc(s.insights_note) + "</div>" : "") + "</td></tr>";
    }).join("");
    return head + tiles + '<section class="panel ip-card"><div class="table-scroll ip-scroll"><table class="ip-table"><thead><tr><th>Publicado</th><th>Tipo</th><th class="n">Alcance</th><th class="n">Views</th><th class="n">Respostas</th><th class="n">Compart.</th><th class="n">Interações</th><th class="n">Avançou</th><th class="n">Voltou</th><th class="n">Saiu</th><th class="n">Pulou conta</th><th class="n">Seguidores</th><th class="n">Visitas</th><th class="n">Saídas</th><th>Situação</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="15" class="ig-empty">Nenhum story guardado ainda.</td></tr>') + "</tbody></table></div></section>";
  }

  function viewComments() {
    var cap = {};
    S.media.forEach(function (m) { cap[m.id] = m; });
    var q = S.q.trim().toLowerCase();
    var list = S.comments.filter(function (c) { return !q || (String(c.text || "") + " " + (c.username || "")).toLowerCase().indexOf(q) >= 0; });
    var head = '<div class="ip-head"><div><div class="ch-kicker">Comentários</div><h3 class="ch-title">O que estão dizendo</h3>' +
      '<p class="ch-sub">Todos os comentários e respostas dos posts e reels, do mais recente ao mais antigo. Pedidos e dúvidas sobre as ferramentas também vão para o menu Ideias Usuários.</p></div>' +
      runLine("instagram_own_last_run", "instagram-own", "Atualizar agora") + "</div>";
    var items = list.map(function (c) {
      var m = cap[c.media_id];
      return '<article class="ip-comment' + (c.parent_id ? " reply" : "") + '"><div class="ip-c-top"><b>' + esc(c.username ? "@" + c.username : "Alguém") + "</b><span>" + esc(dt(c.posted_at, true)) +
        (c.like_count ? " · " + n(c.like_count) + " curtida" + (c.like_count > 1 ? "s" : "") : "") + "</span></div><p>" + esc(c.text) + "</p>" +
        (m ? '<div class="ip-c-post">em ' + (m.permalink ? '<a href="' + esc(m.permalink) + '" target="_blank" rel="noopener">' : "") + esc(kind(m) + " de " + dt(m.posted_at) + ": " + first(m.caption).slice(0, 70)) + (m.permalink ? "</a>" : "") + "</div>" : "") + "</article>";
    }).join("");
    return head + '<div class="ip-row"><input type="search" id="ip-q" placeholder="Buscar comentário ou @…" aria-label="Buscar comentário" value="' + esc(S.q) + '"><span>' + n(list.length) + " de " + n(S.comments.length) + " comentários</span></div>" +
      '<div class="ip-comments">' + (items || '<div class="panel ig-empty">Nenhum comentário lido ainda.</div>') + "</div>";
  }

  function viewDirect() {
    var run = S.runs.instagram_dm_last_run;
    var head = '<div class="ip-head"><div><div class="ch-kicker">Direct</div><h3 class="ch-title">Conversas do @useaflow</h3>' +
      '<p class="ch-sub">Mensagens, respostas aos stories e menções ao @useaflow em stories de outras contas (é assim que aparece quando um influencer marca a Flow). A Meta só entrega as mensagens mais recentes de cada conversa; o painel guarda tudo o que já leu. Pedidos e ideias daqui também vão para a aba Ideias dos usuários.</p></div>' +
      runLine("instagram_dm_last_run", "instagram-dm", "Atualizar Direct") + "</div>";
    if (run && run.ok === false && run.code === "permission" && !S.convs.length) {
      return head + '<div class="panel ip-card ip-setup"><h4>Falta liberar a leitura do Direct</h4><p>' + esc(run.error) + "</p>" +
        "<ol><li>No app do Instagram do @useaflow: Configurações → Mensagens e respostas a stories → Ferramentas conectadas → ligue <b>Permitir acesso a mensagens</b>.</li>" +
        "<li>Ligue o Instagram à Página <b>Flow Tools</b> (Página no Facebook → Configurações → Contas vinculadas → Instagram).</li>" +
        "<li>Gere o token do usuário do sistema de novo incluindo <b>instagram_manage_messages</b> e <b>pages_manage_metadata</b>, e troque o secret IG_ACCESS_TOKEN no Supabase.</li></ol></div>";
    }
    var byConv = {};
    S.msgs.forEach(function (m) { (byConv[m.conversation_id] = byConv[m.conversation_id] || []).push(m); });
    var rows = S.convs.map(function (c) {
      var ms = (byConv[c.id] || []).slice().sort(function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); });
      var last = ms[0];
      return { c: c, ms: ms, last: last,
        replies: ms.filter(function (m) { return m.attachment === "story_reply"; }).length,
        mentions: ms.filter(function (m) { return m.attachment === "story_mention"; }).length,
        waiting: last && !last.from_business };
    });
    var received = S.msgs.filter(function (m) { return !m.from_business; }).length;
    var tiles = '<div class="ig-tiles">' +
      tile("Conversas", n(S.convs.length), "com mensagens lidas") +
      tile("Mensagens recebidas", n(received), "de " + n(S.msgs.length) + " no total") +
      tile("Respostas a stories", n(sum(rows, "replies")), "mensagens que responderam um story") +
      tile("Menções em stories", n(sum(rows, "mentions")), "outras contas marcando o @useaflow") +
      tile("Sem resposta", n(rows.filter(function (r) { return r.waiting; }).length), "a última mensagem é de quem escreveu", "") + "</div>";
    var q = S.dq.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (S.dfilter === "replies" && !r.replies) return false;
      if (S.dfilter === "mentions" && !r.mentions) return false;
      if (S.dfilter === "waiting" && !r.waiting) return false;
      if (q && ((r.c.username || "") + " " + r.ms.map(function (m) { return m.text || ""; }).join(" ")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var filters = [["", "Todas"], ["waiting", "Sem resposta"], ["replies", "Respostas a stories"], ["mentions", "Menções em stories"]];
    var bar = '<div class="ip-row"><div class="ch-tabs ip-dfilters">' + filters.map(function (f) {
      return '<button type="button" class="btn' + (S.dfilter === f[0] ? " btn-primary" : "") + '" data-perf="dfilter" data-v="' + f[0] + '">' + esc(f[1]) + "</button>";
    }).join("") + '</div><input type="search" id="ip-dq" placeholder="Buscar @ ou mensagem…" aria-label="Buscar no Direct" value="' + esc(S.dq) + '"><span>' + n(list.length) + " conversas</span></div>";
    var items = list.map(function (r) {
      var open = S.openConv === r.c.id;
      var badge = (r.mentions ? '<span class="ip-pill live">menção em story</span>' : "") + (r.replies ? '<span class="ip-pill">resposta a story</span>' : "") + (r.waiting ? '<span class="ip-pill wait">sem resposta</span>' : "");
      var lastTxt = r.last ? (r.last.from_business ? "Você: " : "") + (r.last.text || label(r.last.attachment)) : "";
      return '<article class="ip-conv' + (open ? " open" : "") + '"><button type="button" class="ip-conv-h" data-perf="conv" data-id="' + esc(r.c.id) + '" aria-expanded="' + open + '">' +
        '<b>' + esc(r.c.username ? "@" + r.c.username : "Conta sem @") + "</b>" + badge + '<span class="ip-conv-last">' + esc(String(lastTxt).slice(0, 120)) + "</span>" +
        '<span class="ip-conv-d">' + esc(dt(r.c.updated_at || (r.last && r.last.created_at), true)) + "</span></button>" +
        (open ? '<div class="ip-thread">' + r.ms.slice().reverse().map(function (m) {
          return '<div class="ip-msg' + (m.from_business ? " me" : "") + '"><p>' + esc(m.text || label(m.attachment)) + "</p>" +
            (m.story_url ? '<a href="' + esc(m.story_url) + '" target="_blank" rel="noopener noreferrer">' + (m.attachment === "story_mention" ? "ver o story que marcou a Flow" : "ver o story respondido") + " ↗</a>" : "") +
            "<small>" + esc(dt(m.created_at, true)) + "</small></div>";
        }).join("") + "</div>" : "") + "</article>";
    }).join("");
    return head + tiles + bar + '<div class="ip-convs">' + (items || '<div class="panel ig-empty">' + (S.convs.length ? "Nada com esses filtros." : "Nenhuma conversa lida ainda.") + "</div>") + "</div>";
  }
  function label(att) {
    return { story_mention: "(marcou o @useaflow num story)", story_reply: "(respondeu um story)", image: "(imagem)", video: "(vídeo)", audio: "(áudio)", file: "(arquivo)", share: "(compartilhou uma publicação)", unsupported: "(mensagem que a API não mostra)" }[att] || "(sem texto)";
  }

  /* ---------------- eventos ---------------- */
  function onClick(e) {
    var el = e.target.closest("[data-perf]");
    if (!el) return;
    var act = el.getAttribute("data-perf");
    if (act === "refresh") refresh(el.getAttribute("data-fn"));
    else if (act === "sort") { S.sort = el.getAttribute("data-v"); render(); }
    else if (act === "dfilter") { S.dfilter = el.getAttribute("data-v"); render(); }
    else if (act === "conv") { var id = el.getAttribute("data-id"); S.openConv = S.openConv === id ? null : id; render(); }
  }
  function onInput(e) {
    var id = e.target.id;
    if (id !== "ip-q" && id !== "ip-dq") return;
    if (id === "ip-q") S.q = e.target.value; else S.dq = e.target.value;
    var pos = e.target.selectionStart;
    render();
    var q = $(id); if (q) { q.focus(); q.setSelectionRange(pos, pos); }
  }

  /* ---------------- API pública ---------------- */
  async function show(tab) {
    if (!A) return;
    S.tab = tab || S.tab;
    try {
      if (!S.ready) {
        S.ready = true;
        var c = cacheRead();
        if (c) { S.days = c.days || []; S.media = c.media || []; S.stories = c.stories || []; S.comments = c.comments || []; S.runs = c.runs || {}; render(); }
        else A.root.innerHTML = '<div class="panel ig-empty">Carregando…</div>';
        await load(); cacheWrite();
      }
      render();
    } catch (e) {
      console.warn("Instagram desempenho:", e);
      A.toast("Não foi possível carregar o desempenho do Instagram: " + (e.message || e), true);
    }
  }
  window.InstagramPerf = {
    init: function (opts) { A = opts; A.root.addEventListener("click", onClick); A.root.addEventListener("input", onInput); },
    show: show,
    reload: async function () { if (A && S.ready) { await load(); cacheWrite(); render(); } }
  };
})();
