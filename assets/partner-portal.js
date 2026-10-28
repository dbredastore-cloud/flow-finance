/* Portal do Afiliado (/parceiro/).
   O afiliado entra com o login criado na tela Equipe e vê SÓ os dados dele. Tudo vem das funções do banco
   portal_me / portal_sales / portal_contract / portal_youtube, que descobrem o afiliado pelo login (partner_users);
   nada é filtrado no navegador. A equipe pode abrir ?ver=<e-mail do afiliado> para ver o portal como ele vê. */
(function () {
  "use strict";
  var SUPABASE_URL = "https://jagmnogcpxeujtsrrotd.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI";
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var DAY = 86400000;
  var MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  var MONTHS_LONG = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

  // Situações da Kiwify agrupadas como o afiliado entende.
  var GROUPS = [
    ["ok", "Aprovadas", ["paid", "approved"]],
    ["wait", "Pendentes", ["waiting_payment", "pending", "processing", "authorized", "created"]],
    ["refused", "Recusadas", ["refused"]],
    ["refund", "Reembolsos", ["refunded", "refund_requested", "pending_refund"]],
    ["cb", "Chargebacks", ["chargedback"]]
  ];
  var STATUS_LABEL = {
    paid: "Paga", approved: "Aprovada", authorized: "Autorizada", pending: "Pendente", waiting_payment: "Aguardando pagamento",
    processing: "Processando", created: "Iniciada", refused: "Recusada", refunded: "Reembolsada", chargedback: "Chargeback",
    refund_requested: "Reembolso solicitado", pending_refund: "Reembolso pendente"
  };
  var METHOD = { credit_card: "Cartão", pix: "Pix", boleto: "Boleto", bank_slip: "Boleto", paypal: "PayPal", apple_pay: "Apple Pay", google_pay: "Google Pay" };
  var PRESETS = [["month", "Este mês"], ["last_month", "Mês passado"], ["30d", "Últimos 30 dias"], ["90d", "Últimos 3 meses"], ["year", "Este ano"], ["all", "Tudo"], ["custom", "Personalizado"]];

  var qs = new URLSearchParams(location.search);
  var VER = (qs.get("ver") || "").trim().toLowerCase() || null; // visão da equipe
  var S = { me: null, sales: [], clients: [], open: {}, period: "month", from: null, to: null, filter: "all", fu: "all", editing: null, text: "", sort: { key: "at", dir: -1 },
    contract: null, yt: null, extrasLoaded: false, loadSeq: 0 };

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function brl(v) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v) || 0); }
  function int(v) { return v == null || isNaN(v) ? "—" : new Intl.NumberFormat("pt-BR").format(Math.round(v)); }
  function short(v) {
    if (v == null || isNaN(v)) return "—";
    var a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(1).replace(".", ",") + " mi";
    if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(".", ",") + " mil";
    return String(Math.round(v));
  }
  function pct(v, d) { return v == null || isNaN(v) ? "—" : (v * 100).toFixed(d == null ? 0 : d).replace(".", ",") + "%"; }
  function dt(iso) { return iso ? new Date(iso).toLocaleDateString("pt-BR") : "—"; }
  function dtt(iso) { return iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"; }
  function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function groupOf(status) { for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i][2].indexOf(status) >= 0) return GROUPS[i][0]; return "wait"; }
  function sum(list, f) { return list.reduce(function (s, x) { return s + (Number(f(x)) || 0); }, 0); }
  function toast(msg, isError) {
    var el = $("toast");
    el.textContent = msg; el.className = "show" + (isError ? " err" : "");
    clearTimeout(toast._t); toast._t = setTimeout(function () { el.className = ""; }, 3600);
  }
  async function rpc(name, args) {
    var r = await sb.rpc(name, Object.assign({}, args || {}, VER ? { p_email: VER } : {}));
    if (r.error) throw r.error;
    return r.data;
  }

  /* ---------------- telas ---------------- */
  function show(id) {
    ["status-screen", "login-screen", "recovery-screen", "app"].forEach(function (s) { $(s).hidden = s !== id; });
  }
  function status(title, text, opts) {
    $("status-title").textContent = title; $("status-text").textContent = text;
    $("status-retry").hidden = !(opts && opts.retry); $("status-logout").hidden = !(opts && opts.logout);
    show("status-screen");
  }
  $("status-retry").addEventListener("click", function () { boot(); });
  $("status-logout").addEventListener("click", logout);
  $("logout-btn").addEventListener("click", logout);
  async function logout() { await sb.auth.signOut(); if (VER) location.href = "../afiliados/"; else { show("login-screen"); } }

  $("login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var btn = $("login-submit"), msg = $("login-msg");
    msg.innerHTML = ""; btn.disabled = true; btn.textContent = "Entrando…";
    var res = await window.flowSecureLogin(sb, SUPABASE_URL, SUPABASE_ANON_KEY, $("login-email").value.trim(), $("login-password").value);
    btn.disabled = false; btn.textContent = "Entrar";
    if (res.error) { msg.innerHTML = '<div class="msg error">' + esc(res.error.message) + "</div>"; return; }
    boot();
  });
  $("reset-link").addEventListener("click", async function () {
    var email = $("login-email").value.trim(), msg = $("login-msg"), btn = this;
    if (!email) { msg.innerHTML = '<div class="msg error">Digite seu e-mail acima primeiro.</div>'; return; }
    btn.disabled = true; msg.innerHTML = '<div class="msg">Enviando o link…</div>';
    var r = await window.flowRecoverPassword(sb, SUPABASE_URL, SUPABASE_ANON_KEY, email, location.origin + "/parceiro/");
    btn.disabled = false; msg.innerHTML = r.message;
  });

  // Senha nova (link do e-mail de acesso ou de "Esqueci minha senha").
  function rules(pw, pw2) {
    return { len: pw.length >= 10, upper: /[A-Z]/.test(pw), lower: /[a-z]/.test(pw), num: /[0-9]/.test(pw), sym: /[^A-Za-z0-9]/.test(pw), match: pw.length > 0 && pw === pw2 };
  }
  function checkPw() {
    var r = rules($("rec-pw").value, $("rec-pw2").value), ok = true;
    Object.keys(r).forEach(function (k) { var li = document.querySelector('#pw-checklist li[data-rule="' + k + '"]'); if (li) li.classList.toggle("ok", r[k]); if (!r[k]) ok = false; });
    $("rec-submit").disabled = !ok;
    return ok;
  }
  $("rec-pw").addEventListener("input", checkPw);
  $("rec-pw2").addEventListener("input", checkPw);
  $("recovery-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!checkPw()) return;
    var btn = $("rec-submit"); btn.disabled = true; btn.textContent = "Salvando…";
    var res = await sb.auth.updateUser({ password: $("rec-pw").value });
    btn.disabled = false; btn.textContent = "Salvar senha e entrar";
    if (res.error) { $("rec-msg").innerHTML = '<div class="msg error">' + esc(res.error.message) + "</div>"; return; }
    $("rec-msg").innerHTML = '<div class="msg ok">Senha salva! Entrando…</div>';
    setTimeout(boot, 700);
  });

  /* ---------------- início ---------------- */
  async function boot() {
    var tokenHash = qs.get("token_hash");
    if (tokenHash && qs.get("type") === "recovery") {
      status("Validando o link…", "Só um instante.");
      var v = await sb.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
      qs.delete("token_hash"); qs.delete("type");
      history.replaceState(null, "", location.pathname + (qs.toString() ? "?" + qs : ""));
      if (v.error || !v.data || !v.data.session) {
        show("login-screen");
        $("login-msg").innerHTML = '<div class="msg error">Este link é inválido ou já foi usado/expirou. Peça um novo em "Esqueci minha senha".</div>';
        return;
      }
      show("recovery-screen"); return;
    }
    status("Carregando…", "Verificando sua sessão.");
    var s = await sb.auth.getSession(), session = s.data && s.data.session;
    if (!session) { show("login-screen"); return; }
    var me;
    try { me = await rpc("portal_me"); } catch (e) { status("Não foi possível carregar", e.message || String(e), { retry: true, logout: true }); return; }
    if (!me) {
      // Conta da equipe abrindo o portal sem escolher um afiliado.
      var acc = await sb.rpc("my_access");
      if (acc.data && acc.data.role && acc.data.role !== "partner") {
        status("Esta conta é da equipe", VER ? "Afiliado não encontrado (ou seu perfil não tem o menu Afiliados)." : "Para ver o portal como um afiliado vê, use \"Ver portal\" na tela Equipe ou na ficha do afiliado.", { logout: false });
        $("status-text").insertAdjacentHTML("afterend", '<p class="sub"><a href="../afiliados/">Abrir o painel de Afiliados</a> · <a href="../equipe/">Equipe</a></p>');
        return;
      }
      status("Sem acesso ao portal", "Seu acesso está pausado ou ainda não foi liberado. Fale com a equipe Flow.", { logout: true });
      return;
    }
    S.me = me;
    $("who-name").textContent = me.name || me.email;
    $("who-sub").textContent = me.company_name && me.company_name !== me.name ? me.company_name : me.email;
    if (me.preview) {
      $("preview-bar").hidden = false;
      $("preview-bar").innerHTML = "👁 Você está vendo o portal como <b>" + esc(me.name || me.email) + "</b> (" + esc(me.email) + ") vê. Só a equipe vê esta faixa. " +
        '<a href="../afiliados/">Voltar aos Afiliados</a>';
      $("logout-btn").hidden = true;
    }
    show("app");
    renderPeriodChips();
    setPeriod(S.period);
    loadExtras();
    loadPautasCount();
    // Sua análise: texto do Claude (partner_analyses) + números de agora (influencer_analysis_facts), pela portal_analysis.
    if (window.PartnerAnalysis) window.PartnerAnalysis.show({ root: $("pp-ai"), load: function () { return rpc("portal_analysis"); } });
  }

  /* ---------------- menu: Resultados · Pautas Instagram ---------------- */
  // Pautas Instagram: os cards que a equipe liberou (portal_ig_cards), com Lido/Interessante/Conteúdo feito só deste
  // afiliado (portal_ig_flag). Usa o mesmo módulo da tela da equipe (assets/instagram-hub.js), sem o link do Trello.
  var pautasReady = false;
  function pautasInit() {
    if (pautasReady) return;
    pautasReady = true;
    window.InstagramHub.init({
      root: $("ig-view"), sb: sb, toast: toast,
      partner: {
        preview: !!(S.me && S.me.preview),
        load: function () { return rpc("portal_ig_cards"); },
        flag: function (id, flag, on) {
          if (S.me && S.me.preview) return Promise.reject(new Error("Na visão da equipe as marcações ficam travadas: cada afiliado marca as próprias."));
          return sb.rpc("portal_ig_flag", { p_id: id, p_flag: flag, p_on: on }).then(function (r) { if (r.error) throw r.error; return r.data; });
        }
      }
    });
  }
  // Quantas pautas o afiliado ainda não leu (bolinha no menu).
  async function loadPautasCount() {
    try {
      var cards = await rpc("portal_ig_cards") || [];
      var n = cards.filter(function (c) { return !c.ig_read_at; }).length;
      $("pautas-n").hidden = !n; $("pautas-n").textContent = n;
    } catch (e) { /* o menu funciona mesmo sem a contagem */ }
  }
  function openTab(tab) {
    document.querySelectorAll(".pp-nav-i").forEach(function (b) {
      var on = b.getAttribute("data-tab") === tab;
      b.classList.toggle("on", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    $("tab-results").hidden = tab !== "results";
    $("tab-pautas").hidden = tab !== "pautas";
    if (tab === "pautas") { pautasInit(); window.InstagramHub.show().then(loadPautasCount); }
    else { window.InstagramHub && pautasReady && window.InstagramHub.hide(); loadPautasCount(); }
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(".pp-nav-i").forEach(function (b) { b.addEventListener("click", function () { openTab(b.getAttribute("data-tab")); }); });

  /* ---------------- período ---------------- */
  function range(p) {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    var tomorrow = new Date(y, m, d + 1);
    if (p === "month") return [new Date(y, m, 1), tomorrow];
    if (p === "last_month") return [new Date(y, m - 1, 1), new Date(y, m, 1)];
    if (p === "30d") return [new Date(y, m, d - 29), tomorrow];
    if (p === "90d") return [new Date(y, m, d - 89), tomorrow];
    if (p === "year") return [new Date(y, 0, 1), tomorrow];
    if (p === "all") return [S.me && S.me.first_sale ? new Date(new Date(S.me.first_sale).setHours(0, 0, 0, 0)) : new Date(2020, 0, 1), tomorrow];
    var f = $("p-from").value ? new Date($("p-from").value + "T00:00:00") : new Date(y, m, 1);
    var t = $("p-to").value ? new Date($("p-to").value + "T00:00:00") : new Date(y, m, d);
    if (t < f) { var x = f; f = t; t = x; }
    return [f, new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)];
  }
  function periodLabel() {
    var a = S.from, b = new Date(S.to.getTime() - DAY);
    if (S.period === "month" || S.period === "last_month") return MONTHS_LONG[a.getMonth()] + " de " + a.getFullYear();
    return dt(a) + " a " + dt(b);
  }
  function renderPeriodChips() {
    $("period-chips").innerHTML = PRESETS.map(function (p) {
      return '<button type="button" class="pp-chip' + (S.period === p[0] ? " on" : "") + '" data-period="' + p[0] + '" aria-pressed="' + (S.period === p[0]) + '">' + p[1] + "</button>";
    }).join("");
    $("period-custom").hidden = S.period !== "custom";
  }
  $("period-chips").addEventListener("click", function (e) {
    var b = e.target.closest("[data-period]");
    if (!b) return;
    if (b.dataset.period === "custom" && !$("p-from").value) {
      var r = range(S.period); $("p-from").value = ymd(r[0]); $("p-to").value = ymd(new Date(r[1].getTime() - DAY));
    }
    setPeriod(b.dataset.period);
  });
  ["p-from", "p-to"].forEach(function (id) { $(id).addEventListener("change", function () { if (S.period === "custom") setPeriod("custom"); }); });

  async function setPeriod(p) {
    S.period = p;
    var r = range(p); S.from = r[0]; S.to = r[1];
    renderPeriodChips();
    $("period-label").textContent = periodLabel();
    var seq = ++S.loadSeq;
    $("kpis").innerHTML = '<p class="muted pp-span">Carregando as vendas…</p>';
    try {
      var data = await rpc("portal_sales", { p_from: S.from.toISOString(), p_to: S.to.toISOString() });
      if (seq !== S.loadSeq) return;
      S.sales = data || [];
    } catch (e) { if (seq === S.loadSeq) { $("kpis").innerHTML = '<p class="msg error pp-span">Não foi possível ler as vendas: ' + esc(e.message || e) + "</p>"; } return; }
    renderSales();
    if (S.extrasLoaded) renderChannel(); // o resumo do canal mostra as vendas do período
  }

  /* ---------------- vendas ---------------- */
  // Recusada/pendente "de verdade": o cliente não comprou depois a mesma ferramenta (por nenhum canal; o banco confere).
  function openTry(s) { var g = groupOf(s.status); return (g === "refused" || g === "wait") && !s.bought_later_at; }
  function recoveredTry(s) { var g = groupOf(s.status); return (g === "refused" || g === "wait") && !!s.bought_later_at; }

  // Uma linha por cliente, com todos os eventos (tentativas, pagamentos, reembolsos…) dele no período.
  function buildClients() {
    var map = {}, list = [];
    S.sales.forEach(function (s) {
      var k = s.ckey || s.id, c = map[k];
      if (!c) { c = map[k] = { key: k, events: [] }; list.push(c); }
      c.events.push(s);
    });
    list.forEach(function (c) {
      var ev = c.events.sort(function (a, b) { return Date.parse(b.at) - Date.parse(a.at); });
      var pick = function (f) { for (var i = 0; i < ev.length; i++) if (ev[i][f]) return ev[i][f]; return null; };
      c.last = ev[0]; c.name = pick("customer"); c.email = pick("customer_email"); c.phone = pick("customer_phone");
      c.paid = ev.filter(function (s) { return groupOf(s.status) === "ok"; });
      c.amount = sum(c.paid, function (s) { return s.amount; }); c.commission = sum(c.paid, function (s) { return s.commission; });
      c.refusedOpen = ev.filter(function (s) { return groupOf(s.status) === "refused" && openTry(s); });
      c.waitOpen = ev.filter(function (s) { return groupOf(s.status) === "wait" && openTry(s); });
      c.recovered = ev.filter(recoveredTry);
      c.refund = ev.filter(function (s) { return groupOf(s.status) === "refund"; });
      c.cb = ev.filter(function (s) { return groupOf(s.status) === "cb"; });
      c.st = c.refusedOpen.length ? "refused" : c.waitOpen.length ? "wait" : c.cb.length ? "cb" : c.refund.length ? "refund" : c.paid.length ? "ok" : groupOf(c.last.status);
      // Evento que puxa a conversa: a tentativa em aberto mais recente; senão o último evento.
      c.focus = c.refusedOpen[0] || c.waitOpen[0] || c.cb[0] || c.refund[0] || c.last;
      var fams = {};
      ev.forEach(function (s) { fams[s.fam_name || s.product || "—"] = 1; });
      c.fams = Object.keys(fams);
      // Acompanhamento do cliente (o banco manda o mesmo em todas as vendas dele, de qualquer período).
      c.fu = ev.filter(function (s) { return s.fu_at; }).sort(function (a, b) { return Date.parse(b.fu_at) - Date.parse(a.fu_at); })[0] || null;
      c.newAfterFu = !!(c.fu && Date.parse(c.last.at) > Date.parse(c.fu.fu_at));
      c.done = !!(c.fu && c.fu.fu_done);
    });
    return list;
  }
  var CF = { // filtros por cliente
    all: function () { return true; },
    ok: function (c) { return c.paid.length > 0; },
    refused: function (c) { return c.refusedOpen.length > 0; },
    wait: function (c) { return c.waitOpen.length > 0; },
    recovered: function (c) { return c.recovered.length > 0; },
    refund: function (c) { return c.refund.length > 0; },
    cb: function (c) { return c.cb.length > 0; }
  };

  function renderSales() {
    var all = S.sales, by = {};
    GROUPS.forEach(function (g) { by[g[0]] = all.filter(function (s) { return groupOf(s.status) === g[0]; }); });
    S.clients = buildClients();
    var cl = S.clients, cnt = function (k) { return cl.filter(CF[k]).length; };
    var ok = by.ok, total = all.length;
    var comm = sum(ok, function (s) { return s.commission; }), amount = sum(ok, function (s) { return s.amount; });
    var pcts = ok.map(function (s) { return s.pct; }).filter(function (x) { return x != null; });
    var avgPct = pcts.length ? pcts.reduce(function (a, b) { return a + b; }, 0) / pcts.length : null;
    var refRec = by.refused.filter(recoveredTry).length, waitRec = by.wait.filter(recoveredTry).length;
    var tile = function (k, label, value, sub, cls) {
      return '<button type="button" class="pp-kpi' + (cls ? " " + cls : "") + (S.filter === k ? " on" : "") + '" data-filter="' + k + '"><small>' + label + '</small><b class="num">' + value + "</b><span>" + sub + "</span></button>";
    };
    $("kpis").innerHTML =
      tile("ok", "Vendas aprovadas", int(ok.length), total ? int(cnt("ok")) + " clientes · " + pct(ok.length / total) + " das tentativas" : "nenhuma venda no período", "good big") +
      tile("ok", "Faturamento", brl(amount), "valor pago pelos clientes", "big") +
      tile("ok", "Sua comissão", brl(comm), avgPct != null ? "média de " + Math.round(avgPct) + "% por venda" : "nas vendas aprovadas", "accent big") +
      tile("wait", "Pendentes sem pagamento", int(cnt("wait")), by.wait.length ? int(by.wait.length) + " tentativas · " + int(waitRec) + " pagaram depois" : "nada aguardando", "warn sm") +
      tile("refused", "Recusadas sem compra", int(cnt("refused")), by.refused.length ? int(by.refused.length) + " tentativas · " + int(refRec) + " compraram depois" : "nenhuma recusa", "bad sm") +
      tile("refund", "Reembolsos", int(by.refund.length), by.refund.length ? brl(sum(by.refund, function (s) { return s.amount; })) + " devolvidos" : "nenhum reembolso", "sm") +
      tile("cb", "Chargebacks", int(by.cb.length), by.cb.length ? "contestações no cartão" : "nenhum chargeback", "sm");

    $("status-chips").innerHTML = [["all", "Todos os clientes"], ["ok", "Compraram"], ["refused", "Recusadas sem compra"], ["wait", "Pendentes sem pagamento"],
      ["recovered", "Recuperados"], ["refund", "Reembolsos"], ["cb", "Chargebacks"]].map(function (c) {
      return '<button type="button" class="pp-chip' + (S.filter === c[0] ? " on" : "") + '" data-filter="' + c[0] + '" title="' + esc(CHIP_TIP[c[0]]) + '">' + c[1] + " <small>" + cnt(c[0]) + "</small></button>";
    }).join("");

    renderChart(ok);
    renderProducts(ok);
    renderFuChips();
    renderTable();
  }
  var CHIP_TIP = {
    all: "Todos os clientes com algum evento no período",
    ok: "Clientes com pelo menos uma compra paga no período",
    refused: "Tiveram o pagamento recusado e NÃO compraram depois a mesma ferramenta (por nenhum canal)",
    wait: "Geraram boleto/Pix e NÃO pagaram depois a mesma ferramenta",
    recovered: "Tiveram recusa ou pendência e compraram depois",
    refund: "Clientes com reembolso no período",
    cb: "Clientes com chargeback no período"
  };
  document.addEventListener("click", function (e) {
    var f = e.target.closest("[data-filter]");
    if (!f || !S.me) return;
    S.filter = S.filter === f.dataset.filter && f.classList.contains("pp-kpi") ? "all" : f.dataset.filter;
    renderSales();
    if (f.classList.contains("pp-kpi")) $("sales-table").scrollIntoView({ behavior: "smooth", block: "start" });
  });


  function renderProducts(ok) {
    var by = {};
    ok.forEach(function (s) {
      var k = s.product || "—", r = by[k] || (by[k] = { name: k, n: 0, amount: 0, commission: 0, pcts: {} });
      r.n++; r.amount += Number(s.amount) || 0; r.commission += Number(s.commission) || 0;
      if (s.pct != null) r.pcts[s.pct] = (r.pcts[s.pct] || 0) + 1;
    });
    var rows = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.commission - a.commission; });
    $("products").innerHTML = rows.length ? rows.map(function (r) {
      var ps = Object.keys(r.pcts).sort(function (a, b) { return r.pcts[b] - r.pcts[a]; });
      return '<tr><td class="l">' + esc(r.name) + '</td><td class="num">' + int(r.n) + '</td><td class="num">' + brl(r.amount) + '</td><td class="num">' + brl(r.commission) +
        '</td><td class="num">' + (ps.length ? ps.slice(0, 2).map(function (p) { return p + "%"; }).join(" · ") : "—") + "</td></tr>";
    }).join("") : '<tr><td colspan="5" class="empty">Nenhuma venda aprovada no período.</td></tr>';
  }

  // Barras de vendas aprovadas por dia (semana ou mês em períodos longos); a altura é a comissão.
  function renderChart(ok) {
    var days = Math.round((S.to - S.from) / DAY), step = days > 400 ? "month" : days > 70 ? "week" : "day";
    var keyOf = function (d) {
      if (step === "month") return d.getFullYear() + "-" + d.getMonth();
      if (step === "week") { var w = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)); return ymd(w); }
      return ymd(d);
    };
    var buckets = [], idx = {};
    for (var d = new Date(S.from); d < S.to; d = step === "month" ? new Date(d.getFullYear(), d.getMonth() + 1, 1) : new Date(d.getFullYear(), d.getMonth(), d.getDate() + (step === "week" ? 7 : 1))) {
      var start = step === "week" ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)) : d;
      var k = keyOf(start);
      if (idx[k] != null) continue;
      idx[k] = buckets.length;
      buckets.push({ d: start, n: 0, c: 0 });
    }
    ok.forEach(function (s) { var i = idx[keyOf(new Date(s.at))]; if (i != null) { buckets[i].n++; buckets[i].c += Number(s.commission) || 0; } });
    $("chart-note").textContent = { day: "por dia", week: "por semana", month: "por mês" }[step] + " · altura = comissão · número = vendas";
    var el = $("sales-chart"), W = Math.max(el.clientWidth || 800, 320), H = 190, mg = { l: 8, r: 8, t: 18, b: 24 };
    var iw = W - mg.l - mg.r, ih = H - mg.t - mg.b, max = Math.max.apply(null, buckets.map(function (b) { return b.c; }).concat([1]));
    var bw = iw / Math.max(buckets.length, 1), gap = Math.min(6, bw * 0.25);
    var lbl = function (b) { return step === "month" ? MONTHS[b.d.getMonth()] + "/" + String(b.d.getFullYear()).slice(2) : String(b.d.getDate()).padStart(2, "0") + "/" + String(b.d.getMonth() + 1).padStart(2, "0"); };
    var every = Math.ceil(buckets.length / Math.max(1, Math.floor(iw / 46)));
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Vendas aprovadas no período">';
    s += '<line x1="' + mg.l + '" x2="' + (W - mg.r) + '" y1="' + (mg.t + ih) + '" y2="' + (mg.t + ih) + '" class="pp-axis"/>';
    buckets.forEach(function (b, i) {
      var h = b.c / max * ih, x = mg.l + i * bw + gap / 2, y = mg.t + ih - h, w = Math.max(bw - gap, 1);
      s += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(h, b.n ? 2 : 0).toFixed(1) + '" rx="2" class="pp-bar"><title>' +
        esc(lbl(b) + ": " + b.n + (b.n === 1 ? " venda" : " vendas") + " · " + brl(b.c) + " de comissão") + "</title></rect>";
      if (b.n && bw >= 16) s += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" text-anchor="middle" class="pp-val">' + b.n + "</text>";
      if (i % every === 0) s += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" class="pp-lbl">' + lbl(b) + "</text>";
    });
    el.innerHTML = s + "</svg>";
  }
  var rt = null;
  window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { if (S.me && !$("app").hidden) renderChart(S.sales.filter(function (s) { return groupOf(s.status) === "ok"; })); }, 150); });

  // Mensagem pronta para o WhatsApp do cliente, conforme a situação da venda.
  function waText(s) {
    var first = String(s.customer || "").trim().split(/\s+/)[0] || "";
    var hi = "Olá" + (first ? ", " + first : "") + "! Tudo bem? ";
    var prod = s.product || "a ferramenta";
    var g = groupOf(s.status);
    if (g === "refused") return hi + "Vi que o pagamento do " + prod + " não foi aprovado. Posso te ajudar a concluir a compra?";
    if (g === "wait") return hi + "Vi que a sua compra do " + prod + " está aguardando pagamento. Ficou alguma dúvida em que eu possa ajudar?";
    if (g === "refund" || g === "cb") return hi + "Vi que você pediu o reembolso do " + prod + ". Pode me contar o que aconteceu? Quero te ajudar.";
    return hi + "Obrigado por adquirir o " + prod + "! Se precisar de ajuda para começar, é só me chamar.";
  }
  function phoneFmt(p) {
    var d = String(p || "").replace(/\D/g, "");
    if (d.length === 13 && d.indexOf("55") === 0) return "(" + d.slice(2, 4) + ") " + d.slice(4, 9) + "-" + d.slice(9);
    if (d.length === 12 && d.indexOf("55") === 0) return "(" + d.slice(2, 4) + ") " + d.slice(4, 8) + "-" + d.slice(8);
    return "+" + d;
  }
  function contactOn() { return !!(S.me && (S.me.preview || S.me.show_contact)); }

  /* ---------------- acompanhamento de cada cliente (feito / pendente + observação) ---------------- */
  // Só o próprio afiliado grava; a equipe (?ver=) vê em modo leitura. Fica gravado no cliente (histórico inteiro).
  function canEditFu() { return !!(S.me && !S.me.preview); }
  function clientOf(key) { return (S.clients || []).filter(function (c) { return c.key === key; })[0] || null; }
  function fuCell(c) {
    var f = c.fu, note = f && f.fu_note ? '<div class="pp-fu-note" title="' + esc(f.fu_note) + '">' + esc(f.fu_note.length > 90 ? f.fu_note.slice(0, 90) + "…" : f.fu_note) + "</div>" : "";
    var when = f ? '<div class="pp-sub">' + (f.fu_done ? "feito" : "anotado") + " em " + dtt(f.fu_at) + "</div>" : "";
    var fresh = c.newAfterFu ? '<div class="pp-sub pp-fu-new" title="O cliente teve um evento depois da sua última marcação">● novo evento depois da marcação</div>' : "";
    if (!canEditFu()) {
      return (c.done ? '<span class="pp-fu done">✓ Feito</span>' : f ? '<span class="pp-fu">Pendente</span>' : '<span class="muted">—</span>') + note + when + fresh;
    }
    return '<div class="pp-fu-acts"><button type="button" class="pp-fu' + (c.done ? " done" : "") + '" data-fu-toggle="' + esc(c.key) + '" aria-pressed="' + c.done + '" title="' + (c.done ? "Marcar como pendente" : "Marcar como feito (já tratei este cliente)") + '">' +
      (c.done ? "✓ Feito" : "○ Pendente") + "</button>" +
      '<button type="button" class="pp-fu-btn" data-fu-edit="' + esc(c.key) + '" title="' + (f && f.fu_note ? "Editar a observação" : "Anotar o que foi tratado com este cliente") + '">' + (f && f.fu_note ? "✎ Editar" : "＋ Observação") + "</button></div>" + note + when + fresh;
  }
  function fuEditor(c) {
    var f = c.fu;
    return '<div class="pp-fu-box"><label for="fu-note">O que foi tratado com <b>' + esc(c.name || "este cliente") + "</b> (" + esc(c.fams.join(", ")) + ")</label>" +
      '<textarea id="fu-note" rows="3" maxlength="2000" placeholder="Ex.: chamei no WhatsApp em 16/10, cartão recusado; vai tentar no Pix amanhã.">' + esc((f && f.fu_note) || "") + "</textarea>" +
      '<div class="pp-fu-row"><label class="pp-fu-chk"><input type="checkbox" id="fu-done"' + (c.done ? " checked" : "") + "> Marcar como feito</label>" +
      '<span class="pp-fu-sp"></span><button type="button" class="btn" data-fu-cancel>Cancelar</button><button type="button" class="btn btn-primary" data-fu-save="' + esc(c.key) + '">Salvar</button></div></div>';
  }
  // O acompanhamento é do cliente: vale para o histórico inteiro dele, em qualquer período.
  async function saveFu(c, done, note) {
    var r = await sb.rpc("portal_set_client_followup", { p_ckey: c.key, p_done: !!done, p_note: note == null ? ((c.fu && c.fu.fu_note) || "") : note });
    if (r.error) { toast("Não foi possível salvar: " + r.error.message, true); return false; }
    c.events.forEach(function (s) { s.fu_done = r.data.done; s.fu_note = r.data.note; s.fu_at = r.data.updated_at; });
    return true;
  }
  $("sales-body").addEventListener("click", async function (e) {
    var t = e.target.closest("[data-fu-toggle]");
    if (t) {
      var c = clientOf(t.dataset.fuToggle);
      t.disabled = true;
      if (c && await saveFu(c, !c.done, null)) { toast(!c.done ? "Cliente marcado como feito." : "Cliente voltou para pendente."); renderSales(); }
      else t.disabled = false;
      return;
    }
    var ed = e.target.closest("[data-fu-edit]");
    if (ed) { S.editing = S.editing === ed.dataset.fuEdit ? null : ed.dataset.fuEdit; renderTable(); var ta = $("fu-note"); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } return; }
    if (e.target.closest("[data-fu-cancel]")) { S.editing = null; renderTable(); return; }
    var sv = e.target.closest("[data-fu-save]");
    if (sv) {
      var cc = clientOf(sv.dataset.fuSave);
      sv.disabled = true;
      if (cc && await saveFu(cc, $("fu-done").checked, $("fu-note").value)) { S.editing = null; toast("Observação salva."); renderSales(); }
      else sv.disabled = false;
      return;
    }
    // Clique na linha do cliente (fora de botões e links): abre/fecha os eventos dele.
    if (e.target.closest("a, button, input, textarea, label, .pp-fu-edit, .pp-events")) return;
    var tr = e.target.closest("tr[data-client]");
    if (tr) toggleClient(tr.dataset.client);
  });
  function toggleClient(key) {
    if (S.open[key]) delete S.open[key]; else S.open[key] = true;
    renderTable();
  }
  $("sales-body").addEventListener("keydown", function (e) {
    if (e.target.id === "fu-note" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { var b = document.querySelector("[data-fu-save]"); if (b) b.click(); return; }
    if (e.key === "Escape" && S.editing) { S.editing = null; renderTable(); return; }
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("tr[data-client]")) { e.preventDefault(); toggleClient(e.target.dataset.client); }
  });
  $("fu-chips").addEventListener("click", function (e) {
    var b = e.target.closest("[data-fu]");
    if (!b) return;
    S.fu = b.dataset.fu; renderSales();
  });
  function renderFuChips() {
    var all = (S.clients || []).filter(CF[S.filter] || CF.all);
    var done = all.filter(function (c) { return c.done; }).length;
    $("fu-chips").innerHTML = '<span class="muted pp-fu-lbl">Acompanhamento:</span>' + [["all", "Todos", all.length], ["pending", "A tratar", all.length - done], ["done", "Feitos", done]].map(function (c) {
      return '<button type="button" class="pp-chip' + (S.fu === c[0] ? " on" : "") + '" data-fu="' + c[0] + '" aria-pressed="' + (S.fu === c[0]) + '">' + c[1] + " <small>" + c[2] + "</small></button>";
    }).join("");
  }

  /* ---------------- tabela de clientes ---------------- */
  var WA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm0 18.2a8.2 8.2 0 01-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1112 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 01-3.3-2.9c-.2-.4.3-.4.8-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 00-.7.3 3 3 0 00-.9 2.2 5.2 5.2 0 001.1 2.7 11.9 11.9 0 004.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 001.9-1.3 2.3 2.3 0 00.2-1.3c-.1-.1-.3-.2-.5-.3z"/></svg>';
  var ST_LABEL = { ok: "Comprou", refused: "Recusada · sem compra", wait: "Pendente · sem pagamento", refund: "Reembolso", cb: "Chargeback" };
  var COLS = [["at", "Último evento", "l"], ["customer", "Cliente", "l"], ["phone", "WhatsApp", "l"], ["product", "Produto", "l"], ["events", "Eventos", "l"],
    ["status", "Situação", "l"], ["amount", "Pago", ""], ["commission", "Comissão", ""], ["fu", "Acompanhamento", "l"]];
  function cols() { return COLS.filter(function (c) { return c[0] !== "phone" || contactOn(); }); }
  function filtered() {
    var q = S.text.trim().toLowerCase(), test = CF[S.filter] || CF.all;
    return (S.clients || []).filter(function (c) {
      if (!test(c)) return false;
      if (S.fu === "done" && !c.done) return false;
      if (S.fu === "pending" && c.done) return false;
      if (q && [c.name, c.email, c.phone, c.fams.join(" "), c.events.map(function (s) { return s.product; }).join(" ")].join(" ").toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  // Pílulas com o resumo dos eventos do cliente (ex.: 2 recusadas, 1 paga).
  function eventPills(c) {
    var n = {};
    c.events.forEach(function (s) { var g = groupOf(s.status); n[g] = (n[g] || 0) + 1; });
    var lbl = { ok: ["paga", "pagas"], wait: ["pendente", "pendentes"], refused: ["recusada", "recusadas"], refund: ["reembolso", "reembolsos"], cb: ["chargeback", "chargebacks"] };
    return '<div class="pp-evp">' + ["refused", "wait", "ok", "refund", "cb"].filter(function (g) { return n[g]; }).map(function (g) {
      return '<span class="pp-st mini ' + g + '">' + n[g] + " " + lbl[g][n[g] === 1 ? 0 : 1] + "</span>";
    }).join("") + "</div>";
  }
  function eventsTable(c) {
    return '<div class="pp-events"><table><thead><tr><th class="l">Data</th><th class="l">Produto</th><th class="l">Pagamento</th><th class="l">Situação</th><th>Valor</th><th>Comissão</th><th>%</th></tr></thead><tbody>' +
      c.events.map(function (s) {
        var g = groupOf(s.status), tag = "";
        if (g === "refused" || g === "wait") tag = s.bought_later_at ? '<span class="pp-tag good">✓ ' + (g === "wait" ? "pagou" : "comprou") + " depois · " + dt(s.bought_later_at) + "</span>" : '<span class="pp-tag bad">sem compra depois</span>';
        return "<tr><td class=\"l num\">" + dtt(s.at) + '</td><td class="l">' + esc(s.product || "—") + (s.tool ? '<div class="pp-sub">' + esc(s.tool) + "</div>" : "") + "</td>" +
          '<td class="l">' + esc(METHOD[s.method] || s.method || "—") + '</td><td class="l"><span class="pp-st ' + g + '">' + esc(STATUS_LABEL[s.status] || s.status || "—") + "</span> " + tag +
          (s.refunded_at ? '<div class="pp-sub">reembolso em ' + dt(s.refunded_at) + "</div>" : "") + "</td>" +
          '<td class="num">' + brl(s.amount) + '</td><td class="num' + (g === "ok" ? " pp-good" : " pp-strike") + '">' + brl(s.commission) + '</td><td class="num">' + (s.pct != null ? s.pct + "%" : "—") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }
  function renderTable() {
    var list = filtered(), k = S.sort.key, dir = S.sort.dir;
    var rank = { refused: 5, wait: 4, cb: 3, refund: 2, ok: 1 };
    var val = function (c) {
      return k === "at" ? Date.parse(c.last.at) : k === "amount" ? c.amount : k === "commission" ? c.commission : k === "events" ? c.events.length
        : k === "status" ? rank[c.st] || 0 : k === "fu" ? (c.done ? 2 : c.fu ? 1 : 0) : k === "product" ? c.fams.join(" ").toLowerCase()
        : String((k === "phone" ? c.phone : c.name) || "").toLowerCase();
    };
    list.sort(function (a, b) { var x = val(a), y = val(b); return x < y ? -dir : x > y ? dir : 0; });
    var cs = cols();
    $("sales-head").innerHTML = "<tr>" + cs.map(function (c) {
      return '<th class="sortable ' + c[2] + '" data-sort="' + c[0] + '">' + c[1] + (S.sort.key === c[0] ? ' <span class="arrow">' + (dir < 0 ? "↓" : "↑") + "</span>" : "") + "</th>";
    }).join("") + "</tr>";
    $("contact-hint").textContent = (contactOn()
      ? "Cada linha é um cliente: clique nela para ver todos os eventos dele. \"Recusadas sem compra\" mostra só quem não comprou depois a mesma ferramenta (por nenhum canal). O WhatsApp abre a conversa com uma mensagem pronta."
      : "Cada linha é um cliente: clique nela para ver todos os eventos dele. Os contatos dos clientes não estão liberados no seu portal.") + " Em Acompanhamento, marque o cliente como feito e anote o que foi tratado.";
    $("sales-body").innerHTML = list.length ? list.slice(0, 600).map(function (c) {
      var open = !!S.open[c.key], f = c.focus;
      var cell = {
        at: '<td class="l num"><span class="pp-caret' + (open ? " open" : "") + '" aria-hidden="true">▸</span>' + dtt(c.last.at) + "</td>",
        customer: '<td class="l"><b>' + esc(c.name || "—") + "</b>" + (contactOn() && c.email ? '<div class="pp-sub"><a href="mailto:' + esc(c.email) + '">' + esc(c.email) + "</a></div>" : "") + "</td>",
        phone: '<td class="l">' + (c.phone ? '<a class="pp-wa" href="https://wa.me/' + esc(String(c.phone).replace(/\D/g, "")) + "?text=" + encodeURIComponent(waText(f)) + '" target="_blank" rel="noopener noreferrer" title="Abrir conversa no WhatsApp com mensagem pronta">' +
          WA_ICON + esc(phoneFmt(c.phone)) + "</a>" : '<span class="muted">—</span>') + "</td>",
        product: '<td class="l">' + c.fams.map(esc).join("<br>") + "</td>",
        events: '<td class="l">' + eventPills(c) + "</td>",
        status: '<td class="l"><span class="pp-st ' + c.st + '">' + esc(ST_LABEL[c.st] || "—") + "</span>" + (c.recovered.length ? '<div class="pp-sub pp-good">recuperado: comprou depois</div>' : "") + "</td>",
        amount: '<td class="num">' + (c.amount ? brl(c.amount) : '<span class="muted">—</span>') + "</td>",
        commission: '<td class="num' + (c.commission ? " pp-good" : "") + '">' + (c.commission ? brl(c.commission) : '<span class="muted">—</span>') + "</td>",
        fu: '<td class="l pp-fu-cell">' + fuCell(c) + "</td>"
      };
      var row = '<tr class="pp-row pp-client ' + c.st + (c.done ? " fu-done" : "") + (open ? " open" : "") + '" data-client="' + esc(c.key) + '" tabindex="0" aria-expanded="' + open + '">' + cs.map(function (x) { return cell[x[0]]; }).join("") + "</tr>";
      if (S.editing === c.key) row += '<tr class="pp-fu-edit"><td colspan="' + cs.length + '">' + fuEditor(c) + "</td></tr>";
      if (open) row += '<tr class="pp-ev-row"><td colspan="' + cs.length + '">' + eventsTable(c) + "</td></tr>";
      return row;
    }).join("") : '<tr><td colspan="' + cs.length + '" class="empty">Nenhum cliente com esse filtro no período.</td></tr>';
    var nEv = list.reduce(function (s, c) { return s + c.events.length; }, 0);
    $("sales-count").textContent = list.length + " de " + (S.clients || []).length + " clientes (" + nEv + " eventos)" + (list.length > 600 ? " · mostrando os 600 primeiros; use a busca ou exporte o CSV" : "") + ".";
  }
  $("sales-head").addEventListener("click", function (e) {
    var th = e.target.closest("th[data-sort]");
    if (!th) return;
    var k = th.dataset.sort;
    S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === "customer" || k === "product" ? 1 : -1) };
    renderTable();
  });
  $("sales-q").addEventListener("input", function (e) { S.text = e.target.value; renderTable(); });
  // CSV: um evento por linha (dos clientes do filtro atual), com "comprou depois" e o acompanhamento do cliente.
  $("sales-csv").addEventListener("click", function () {
    var c = function (v) { var s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var head = ["Data", "Cliente"].concat(contactOn() ? ["E-mail do cliente", "WhatsApp"] : []).concat(["Produto", "Pagamento", "Situação", "Comprou depois", "Valor", "Comissão", "% comissão", "Situação do cliente", "Acompanhamento", "Observação"]);
    var rows = [head.map(c).join(",")];
    filtered().forEach(function (cl) {
      cl.events.forEach(function (s) {
        var g = groupOf(s.status);
        rows.push([dtt(s.at), cl.name].concat(contactOn() ? [cl.email, cl.phone ? "+" + cl.phone : ""] : [])
          .concat([s.product, METHOD[s.method] || s.method, STATUS_LABEL[s.status] || s.status, g === "refused" || g === "wait" ? (s.bought_later_at ? "sim, " + dt(s.bought_later_at) : "não") : "",
            Number(s.amount || 0).toFixed(2).replace(".", ","), Number(s.commission || 0).toFixed(2).replace(".", ","), s.pct != null ? s.pct + "%" : "",
            ST_LABEL[cl.st] || "", cl.done ? "feito" : "pendente", cl.fu ? cl.fu.fu_note || "" : ""]).map(c).join(","));
      });
    });
    var blob = new Blob(["﻿" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "meus-clientes-" + ymd(S.from) + "-a-" + ymd(new Date(S.to.getTime() - DAY)) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });

  /* ---------------- contrato e canal ---------------- */
  async function loadExtras() {
    var me = S.me;
    var r = await Promise.all([
      me.has_contract ? rpc("portal_contract").catch(function () { return null; }) : Promise.resolve(null),
      me.has_channel ? rpc("portal_youtube").catch(function () { return null; }) : Promise.resolve(null),
      // Sempre: mesmo sem perfil lido, o painel mostra o botão "Conectar Instagram".
      rpc("portal_instagram").catch(function () { return null; })
    ]);
    S.contract = r[0]; S.yt = r[1]; S.ig = r[2]; S.extrasLoaded = true;
    renderContract(); renderChannel(); renderInstagram();
  }

  /* ---------------- Instagram ----------------
     Sem conexão: dados públicos do perfil (lidos com a conta da Flow) e o botão "Conectar Instagram".
     Conectado (login oficial do Instagram, Edge Function ig-connect): stories, alcance, salvamentos, compartilhamentos e
     público, lidos pela ig-partners com a autorização do próprio afiliado. */
  function igKind(p) { return p.media_product_type === "REELS" ? "reels" : p.media_product_type === "STORY" ? "story" : p.media_type === "CAROUSEL_ALBUM" ? "carousel" : "feed"; }
  async function igCall(action) {
    var s = await sb.auth.getSession(), token = s.data && s.data.session && s.data.session.access_token;
    var r = await fetch(SUPABASE_URL + "/functions/v1/ig-connect", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ action: action }) });
    var js = await r.json().catch(function () { return {}; });
    if (!r.ok || js.ok === false) throw new Error(js.error || ("HTTP " + r.status));
    return js;
  }
  async function igConnect(btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Abrindo o Instagram…"; }
    try { var js = await igCall("start"); location.href = js.url; }
    catch (e) { toast(e.message || String(e), true); if (btn) { btn.disabled = false; btn.textContent = "Conectar Instagram"; } }
  }
  async function igDisconnect(btn) {
    if (!window.confirm("Desconectar o seu Instagram? A Flow para de ler stories, alcance e público. O que já foi lido continua aqui.")) return;
    btn.disabled = true;
    try { await igCall("disconnect"); toast("Instagram desconectado."); S.ig = await rpc("portal_instagram").catch(function () { return null; }); renderInstagram(); }
    catch (e) { toast(e.message || String(e), true); btn.disabled = false; }
  }
  // Volta do login do Instagram (?ig=conectado | cancelado | erro&motivo=…).
  (function igReturn() {
    var v = qs.get("ig");
    if (!v) return;
    var motivo = qs.get("motivo");
    qs.delete("ig"); qs.delete("motivo");
    history.replaceState(null, "", location.pathname + (qs.toString() ? "?" + qs : ""));
    setTimeout(function () {
      if (v === "conectado") toast("Instagram conectado! Os primeiros números aparecem em alguns minutos.");
      else if (v === "cancelado") toast("Conexão cancelada. Você pode conectar quando quiser.");
      else toast("Não foi possível conectar o Instagram" + (motivo ? ": " + motivo : "."), true);
    }, 600);
  })();
  function igConnectCard(a) {
    var c = S.ig && S.ig.connection;
    if (VER) {
      return '<p class="muted pp-hint">' + (c ? "Instagram conectado pelo afiliado em " + dtt(c.connected_at) + "." : "O afiliado ainda não conectou o Instagram; aparecem só os dados públicos.") + "</p>";
    }
    if (c && c.status === "expired") {
      return '<div class="pp-igc warn"><div><b>A autorização do seu Instagram venceu</b><span>Conecte de novo para a Flow voltar a ler seus stories e métricas.</span></div>' +
        '<button type="button" class="btn btn-primary" data-ig="connect">Conectar de novo</button></div>';
    }
    if (c) return "";
    return '<div class="pp-igc"><div><b>' + (a ? "Veja também stories, alcance e público" : "Conecte o seu Instagram") + "</b>" +
      "<span>Conectando pelo login oficial do Instagram, você vê aqui o alcance de cada story, salvamentos, compartilhamentos e quem é o seu público. A Flow só lê os números; nunca publica nada e nunca vê a sua senha.</span></div>" +
      '<button type="button" class="btn btn-primary" data-ig="connect">Conectar Instagram</button></div>';
  }
  function renderInstagram() {
    var el = $("instagram-panel");
    if (!S.ig) { el.hidden = true; return; }
    if (!el._igWired) {
      el._igWired = true;
      el.addEventListener("click", function (e) {
        var b = e.target.closest("[data-ig]");
        if (!b) return;
        if (b.getAttribute("data-ig") === "connect") igConnect(b);
        else if (b.getAttribute("data-ig") === "disconnect") igDisconnect(b);
      });
    }
    if (!S.ig.account) {
      el.hidden = false;
      el.innerHTML = '<div class="pp-head"><h2>Seu Instagram</h2></div>' + igConnectCard(null);
      return;
    }
    var a = S.ig.account, media = S.ig.media || [], now = Date.now();
    var posts = media.filter(function (p) { return igKind(p) !== "story"; });
    var last30 = posts.filter(function (p) { return now - Date.parse(p.posted_at) <= 30 * DAY; });
    var recent = posts.slice(0, 12);
    var avg = function (list, f) { return list.length ? sum(list, f) / list.length : null; };
    var reels = recent.filter(function (p) { return igKind(p) === "reels" && p.view_count != null; });
    var avgL = avg(recent, function (p) { return p.like_count; }), avgC = avg(recent, function (p) { return p.comments_count; });
    var flowRe = /flow[\s\-_.]*(pages?|track(ing)?|spy)/i, flow90 = posts.filter(function (p) { return now - Date.parse(p.posted_at) <= 90 * DAY && flowRe.test(p.caption || ""); });
    var sn = S.ig.snaps || [], first = sn.filter(function (x) { return Date.parse(x.day + "T12:00:00") >= now - 30 * DAY; })[0];
    var growth = first && a.followers_count != null && first.followers_count != null ? a.followers_count - first.followers_count : null;
    var LBL = { reels: "Reels", feed: "Feed", carousel: "Carrossel", story: "Story" };
    var conn = S.ig.connection, linked = conn && conn.status !== "expired";
    el.hidden = false;
    el.innerHTML = '<div class="pp-head"><h2>Seu Instagram</h2><span class="muted">@' + esc(a.username) + (a.fetched_at ? " · atualizado em " + dtt(a.fetched_at) : "") + "</span>" +
        (linked ? '<span class="pp-st ok">conectado</span>' + (VER ? "" : '<button type="button" class="btn btn-ghost" data-ig="disconnect">Desconectar</button>') : "") + "</div>" +
      igConnectCard(a) + (linked ? igPrivate() : "") +
      '<div class="pp-kpis pp-kpis-sm">' +
        '<div class="pp-kpi static"><small>Seguidores</small><b class="num">' + short(a.followers_count) + "</b><span>" + (growth != null ? (growth >= 0 ? "+" : "") + int(growth) + " nos últimos 30 dias" : "&nbsp;") + "</span></div>" +
        '<div class="pp-kpi static"><small>Posts em 30 dias</small><b class="num">' + int(last30.length) + "</b><span>" + int(last30.filter(function (p) { return igKind(p) === "reels"; }).length) + " reels · " + int(last30.filter(function (p) { return igKind(p) !== "reels"; }).length) + " no feed</span></div>" +
        '<div class="pp-kpi static"><small>Curtidas médias</small><b class="num">' + short(avgL) + "</b><span>" + short(avgC) + " comentários por post</span></div>" +
        '<div class="pp-kpi static"><small>Visualizações médias</small><b class="num">' + (reels.length ? short(avg(reels, function (p) { return p.view_count; })) : "—") + "</b><span>nos reels recentes</span></div>" +
        '<div class="pp-kpi static accent"><small>Citam a Flow (90 dias)</small><b class="num">' + int(flow90.length) + "</b><span>legenda com FlowPages, FlowTracking ou FlowSpy</span></div>" +
      "</div>" +
      '<div class="fd-ig-grid">' + recent.map(function (p) {
        var k = igKind(p);
        return '<a class="fd-ig-post" href="' + esc(p.permalink || "#") + '" target="_blank" rel="noopener noreferrer" title="' + esc(String(p.caption || "").slice(0, 300)) + '">' +
          '<span class="fd-ig-thumb">' + (p.thumbnail_url ? '<img src="' + esc(p.thumbnail_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : "") +
          '<span class="fd-ig-kind ' + k + '">' + LBL[k] + "</span>" + (flowRe.test(p.caption || "") ? '<span class="fd-ig-flow">Flow</span>' : "") + "</span>" +
          '<span class="fd-ig-meta"><b>' + dt(p.posted_at) + "</b><span>♥ " + short(p.like_count) + " · 💬 " + short(p.comments_count) + (p.view_count != null ? " · ▶ " + short(p.view_count) : "") + "</span></span></a>";
      }).join("") + "</div>" +
      (linked ? "" : '<p class="muted pp-hint">Acima: dados públicos do seu perfil.</p>');
  }
  // Números que só existem com o Instagram conectado: resumo de 7 dias, stories e público.
  function igPrivate() {
    var ig = S.ig, now = Date.now(), daily = ig.daily || [], stories = ig.stories || [], aud = ig.audience || [];
    var last7 = daily.slice(-7), prev7 = daily.slice(-14, -7);
    var tot = function (list, k) { return sum(list, function (d) { return d[k]; }); };
    var delta = function (k) { var a = tot(last7, k), b = tot(prev7, k); return b ? (a - b) / b : null; };
    var dl = function (k) { var d = delta(k); return d == null ? "últimos 7 dias" : (d >= 0 ? "+" : "") + pct(d) + " vs 7 dias antes"; };
    var st30 = stories.filter(function (s) { return now - Date.parse(s.posted_at) <= 30 * DAY; });
    var avgReach = st30.length ? sum(st30, function (s) { return s.reach; }) / st30.length : null;
    var exitRate = sum(st30, function (s) { return s.views; }) ? sum(st30, function (s) { return s.exits; }) / sum(st30, function (s) { return s.views; }) : null;
    var flowSt = st30.filter(function (s) { return s.mentions_flow; }).length;
    var html = '<div class="pp-kpis pp-kpis-sm">' +
      '<div class="pp-kpi static"><small>Alcance · 7 dias</small><b class="num">' + short(tot(last7, "reach")) + "</b><span>" + dl("reach") + "</span></div>" +
      '<div class="pp-kpi static"><small>Visualizações · 7 dias</small><b class="num">' + short(tot(last7, "views")) + "</b><span>" + dl("views") + "</span></div>" +
      '<div class="pp-kpi static"><small>Interações · 7 dias</small><b class="num">' + short(tot(last7, "total_interactions")) + "</b><span>" + dl("total_interactions") + "</span></div>" +
      '<div class="pp-kpi static"><small>Stories em 30 dias</small><b class="num">' + int(st30.length) + "</b><span>alcance médio " + short(avgReach) + "</span></div>" +
      '<div class="pp-kpi static accent"><small>Stories citando a Flow</small><b class="num">' + int(flowSt) + "</b><span>em 30 dias" + (exitRate != null ? " · saídas " + pct(exitRate) : "") + "</span></div>" +
      "</div>";
    var rows = stories.slice(0, 40).map(function (s) {
      var v = Number(s.views) || 0;
      return "<tr><td class=\"l\">" + (s.permalink ? '<a href="' + esc(s.permalink) + '" target="_blank" rel="noopener noreferrer">' + dtt(s.posted_at) + "</a>" : dtt(s.posted_at)) +
        (s.mentions_flow ? ' <span class="pp-st ok mini">Flow</span>' : "") + "</td><td>" + short(s.reach) + "</td><td>" + short(s.views) + "</td><td>" + int(s.replies) + "</td><td>" + int(s.shares) +
        "</td><td>" + int(s.taps_forward) + "</td><td>" + int(s.exits) + "</td><td>" + (v && s.exits != null ? pct(s.exits / v) : "—") + '</td><td class="l"><span class="pp-st mini' + (s.final ? "" : " ok") + '">' + (s.final ? "final" : "no ar") + "</span></td></tr>";
    }).join("");
    html += '<h3 class="pp-h3">Seus stories</h3>' +
      '<p class="muted pp-hint">Lidos de hora em hora enquanto estão no ar (o Instagram só mostra um story por 24 horas). Quando o story sai do ar, fica a última leitura.</p>' +
      '<div class="table-scroll"><table class="pp-table"><thead><tr><th class="l">Publicado</th><th>Alcance</th><th>Views</th><th>Respostas</th><th>Compart.</th><th>Avançou</th><th>Saiu</th><th>Saídas</th><th class="l">Situação</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="9" class="empty">Nenhum story lido ainda. Os próximos que você postar aparecem aqui.</td></tr>') + "</tbody></table></div>";
    var byB = {};
    aud.forEach(function (x) { (byB[x.breakdown] = byB[x.breakdown] || []).push(x); });
    var LB = { city: "Cidades", age: "Idade", gender: "Gênero", country: "Países" }, GEN = { M: "Homens", F: "Mulheres", U: "Não informado" };
    var blocks = ["city", "age", "gender", "country"].filter(function (b) { return byB[b]; }).map(function (b) {
      var list = byB[b].slice(0, b === "city" || b === "country" ? 6 : 8), total = sum(byB[b], function (x) { return x.value; }) || 1;
      return '<div class="pp-aud"><h4>' + LB[b] + "</h4>" + list.map(function (x) {
        var share = (Number(x.value) || 0) / total;
        return '<div class="pp-aud-row"><span>' + esc(b === "gender" ? (GEN[x.key] || x.key) : x.key) + '</span><i style="width:' + Math.max(2, Math.round(share * 100)) + '%"></i><b>' + pct(share) + "</b></div>";
      }).join("") + "</div>";
    }).join("");
    if (blocks) html += '<h3 class="pp-h3">Seu público</h3><div class="pp-aud-grid">' + blocks + "</div>";
    return html;
  }
  function isShort(v) { return v.is_short != null ? v.is_short : (v.duration_s != null && v.duration_s <= 180); }

  function contractMonths() {
    var c = S.contract.contract, sales = S.contract.sales || [], del = {};
    (S.contract.deliverables || []).forEach(function (d) { del[d.year + "-" + d.month] = d; });
    var start = new Date(c.start_date + "T00:00:00"), end = c.end_date ? new Date(c.end_date + "T23:59:59") : null, now = new Date();
    var last = end && end < now ? end : now, months = [], cum = 0, bonusMonth = null;
    var vids = S.yt ? S.yt.videos || [] : [];
    for (var d = new Date(start.getFullYear(), start.getMonth(), 1); d <= last; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      var a = d, b = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      var ms = sales.filter(function (s) { var t = new Date(s.at); return t >= a && t < b; });
      var row = { year: d.getFullYear(), month: d.getMonth() + 1, n: ms.length, amount: sum(ms, function (s) { return s.amount; }), commission: sum(ms, function (s) { return s.commission; }) };
      var before = cum; cum += row.n; row.cum = cum;
      row.bonus = 0;
      if (!bonusMonth && before < c.bonus_sales_target && cum >= c.bonus_sales_target) { bonusMonth = row; row.bonus = Number(c.bonus_amount) || 0; }
      row.fixed = Number(c.fixed_fee) || 0;
      row.total = row.commission + row.fixed + row.bonus;
      row.current = b > now;
      var dl = del[row.year + "-" + row.month] || {};
      var yt = vids.filter(function (v) { var t = new Date(v.published_at); return t >= a && t < b && /flow/i.test(v.title || "") && !isShort(v); }).length;
      row.stories = dl.stories || 0; row.reels = dl.reels || 0; row.youtube = dl.youtube != null ? dl.youtube : yt;
      months.push(row);
    }
    return { months: months, total: cum, bonusMonth: bonusMonth };
  }
  function renderContract() {
    var el = $("contract-panel");
    if (!S.contract || !S.contract.contract) { el.hidden = true; return; }
    var c = S.contract.contract, info = contractMonths(), m = info.months;
    var tot = { n: info.total, commission: sum(m, function (r) { return r.commission; }), fixed: sum(m, function (r) { return r.fixed; }), bonus: sum(m, function (r) { return r.bonus; }), amount: sum(m, function (r) { return r.amount; }) };
    var now = new Date(), ended = c.end_date && new Date(c.end_date + "T23:59:59") < now;
    var prog = c.bonus_sales_target ? Math.min(1, info.total / c.bonus_sales_target) : 0;
    var chk = function (done, goal, current) { return '<span class="pp-st ' + (done >= goal ? "ok" : current ? "wait" : "bad") + '">' + done + "/" + goal + "</span>"; };
    el.hidden = false;
    el.innerHTML = '<div class="pp-head"><h2>Seu contrato com a Flow</h2><span class="pp-st ' + (ended || !c.active ? "" : "ok") + '">' + (ended ? "encerrado" : c.active ? "vigente" : "pausado") + "</span></div>" +
      '<p class="pp-terms">De <b>' + dt(c.start_date + "T12:00:00") + "</b> " + (c.end_date ? "a <b>" + dt(c.end_date + "T12:00:00") + "</b>" : "<b>sem data de fim</b>") +
        " · fixo de <b>" + brl(c.fixed_fee) + "</b> por mês · comissão de <b>" + Number(c.commission_pct) + "%</b> · bônus de <b>" + brl(c.bonus_amount) + "</b> ao chegar a <b>" + int(c.bonus_sales_target) + " vendas</b>" +
        " · entregas por mês: <b>" + c.stories_per_month + " stories</b>, <b>" + c.reels_per_month + " reels</b> e <b>" + c.youtube_per_month + " vídeo(s) no YouTube</b>.</p>" +
      '<div class="pp-kpis pp-kpis-sm">' +
        '<div class="pp-kpi static"><small>Vendas Flow no contrato</small><b class="num">' + int(tot.n) + "</b><span>" + brl(tot.amount) + " em vendas</span></div>" +
        '<div class="pp-kpi static accent"><small>Total do contrato</small><b class="num">' + brl(tot.commission + tot.fixed + tot.bonus) + "</b><span>comissão + fixo + bônus (com o mês atual)</span></div>" +
        '<div class="pp-kpi static"><small>Comissão</small><b class="num">' + brl(tot.commission) + "</b><span>vendas das ferramentas Flow</span></div>" +
        '<div class="pp-kpi static"><small>Fixo + bônus</small><b class="num">' + brl(tot.fixed + tot.bonus) + "</b><span>" + m.length + " mês(es) de contrato</span></div>" +
      "</div>" +
      '<div class="pp-bonus"><div class="pp-bonus-t"><b>Meta do bônus</b><span class="num">' + int(info.total) + " / " + int(c.bonus_sales_target) + " vendas</span></div>" +
        '<div class="pp-bar-track"><i style="width:' + (prog * 100).toFixed(1) + '%"></i></div>' +
        '<span class="muted">' + (info.bonusMonth ? "🎉 Meta batida em " + MONTHS_LONG[info.bonusMonth.month - 1] + "/" + info.bonusMonth.year + ": bônus de " + brl(c.bonus_amount) + "." : "Faltam " + int(Math.max(0, c.bonus_sales_target - info.total)) + " vendas para o bônus de " + brl(c.bonus_amount) + ".") + "</span></div>" +
      '<div class="table-scroll"><table class="pp-table"><thead><tr><th class="l">Mês</th><th>Vendas Flow</th><th>Comissão</th><th>Fixo</th><th>Bônus</th><th>Total</th><th>Stories</th><th>Reels</th><th>YouTube</th></tr></thead><tbody>' +
        m.slice().reverse().map(function (r) {
          return "<tr" + (r.current ? ' class="pp-cur"' : "") + '><td class="l">' + MONTHS[r.month - 1] + "/" + String(r.year).slice(2) + (r.current ? ' <span class="muted">(em andamento)</span>' : "") + "</td>" +
            '<td class="num">' + int(r.n) + '</td><td class="num">' + brl(r.commission) + '</td><td class="num">' + brl(r.fixed) + '</td><td class="num">' + (r.bonus ? brl(r.bonus) : "—") + '</td><td class="num"><b>' + brl(r.total) + "</b></td>" +
            '<td class="num">' + chk(r.stories, c.stories_per_month, r.current) + '</td><td class="num">' + chk(r.reels, c.reels_per_month, r.current) + '</td><td class="num">' + chk(r.youtube, c.youtube_per_month, r.current) + "</td></tr>";
        }).join("") + "</tbody></table></div>" +
      '<p class="muted pp-hint">Vendas e comissões das ferramentas Flow (FlowPages, FlowTracking, FlowSpy) dentro da vigência. Stories e reels são lançados pela equipe; vídeos do YouTube são contados no seu canal (vídeos com "Flow" no título).</p>';
  }

  function renderChannel() {
    var el = $("channel-panel");
    if (!S.yt || !S.yt.channel) { el.hidden = true; return; }
    var ch = S.yt.channel, vids = (S.yt.videos || []).map(function (v) { return Object.assign({}, v, { ms: Date.parse(v.published_at), short: isShort(v) }); });
    var now = Date.now(), last30 = vids.filter(function (v) { return now - v.ms <= 30 * DAY; });
    var longs = vids.filter(function (v) { return !v.short; }).slice(0, 10);
    var avg = longs.length ? sum(longs, function (v) { return v.views; }) / longs.length : null;
    var eng = (function () { var v = sum(longs, function (x) { return x.views; }); return v ? sum(longs, function (x) { return (x.likes || 0) + (x.comments || 0); }) / v : null; })();
    var flowRe = /flow[\s\-_.]*(pages?|track(ing)?|spy)/i;
    var flow90 = vids.filter(function (v) { return now - v.ms <= 90 * DAY && flowRe.test((v.title || "") + " " + (v.description || "")); });
    var sn = S.yt.snaps || [], first = sn.filter(function (x) { return Date.parse(x.day + "T12:00:00") >= now - 30 * DAY; })[0];
    var growth = first && ch.subscribers != null && first.subscribers != null ? ch.subscribers - first.subscribers : null;
    el.hidden = false;
    el.innerHTML = '<div class="pp-head"><h2>Seu canal no YouTube</h2><button class="btn btn-primary" type="button" id="open-dash">⤢ Abrir painel completo do canal</button></div>' +
      '<div class="pp-ch">' + (ch.thumbnail_url ? '<img src="' + esc(ch.thumbnail_url) + '" alt="" referrerpolicy="no-referrer">' : "") +
        "<div><b>" + esc(ch.title || "") + '</b><div class="muted">' + esc(ch.handle || "") + (ch.fetched_at ? " · atualizado em " + dtt(ch.fetched_at) : "") + "</div></div></div>" +
      '<div class="pp-kpis pp-kpis-sm">' +
        '<div class="pp-kpi static"><small>Inscritos</small><b class="num">' + (ch.hidden_subs ? "oculto" : short(ch.subscribers)) + "</b><span>" + (growth != null ? (growth >= 0 ? "+" : "") + int(growth) + " nos últimos 30 dias" : "&nbsp;") + "</span></div>" +
        '<div class="pp-kpi static"><small>Views do canal</small><b class="num">' + short(ch.total_views) + "</b><span>" + int(ch.video_count) + " envios no total</span></div>" +
        '<div class="pp-kpi static"><small>Publicados em 30 dias</small><b class="num">' + int(last30.length) + "</b><span>" + int(last30.filter(function (v) { return !v.short; }).length) + " vídeos · " + int(last30.filter(function (v) { return v.short; }).length) + " Shorts</span></div>" +
        '<div class="pp-kpi static"><small>Views médias</small><b class="num">' + short(avg) + "</b><span>últimos 10 vídeos · engajamento " + pct(eng, 1) + "</span></div>" +
        '<div class="pp-kpi static accent"><small>Citam a Flow (90 dias)</small><b class="num">' + int(flow90.length) + "</b><span>" + (flow90.length ? short(sum(flow90, function (v) { return v.views; })) + " views nesses vídeos" : "FlowPages, FlowTracking ou FlowSpy") + "</span></div>" +
      "</div>" +
      '<div class="pp-vids">' + vids.slice(0, 6).map(function (v) {
        return '<a class="pp-vid" href="https://www.youtube.com/' + (v.short ? "shorts/" : "watch?v=") + encodeURIComponent(v.video_id) + '" target="_blank" rel="noopener noreferrer">' +
          (v.thumbnail_url ? '<img src="' + esc(v.thumbnail_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : "") +
          "<b>" + esc(v.title) + "</b><span>" + short(v.views) + " views · " + dt(v.published_at) + (v.short ? " · Short" : "") + (flowRe.test((v.title || "") + " " + (v.description || "")) ? ' · <em>cita a Flow</em>' : "") + "</span></a>";
      }).join("") + "</div>";
    $("open-dash").addEventListener("click", openDash);
  }
  function openDash() {
    var ch = S.yt.channel, ok = S.sales.filter(function (s) { return groupOf(s.status) === "ok"; });
    window.InfluencerDash.openCtx({
      a: { name: ch.title || S.me.name, email: "" }, c: null, info: null, noContract: true,
      channel: { c: ch, long: { avgViews: null } }, instagram: S.me.instagram || null, hideInsta: !S.ig, readOnly: true,
      socials: esc(S.me.name || ""), heroNote: "Seu canal no YouTube",
      sales: { count: ok.length, amount: sum(ok, function (s) { return s.amount; }), commission: sum(ok, function (s) { return s.commission; }), label: periodLabel() },
      backLabel: "← Voltar ao portal",
      load: function () { return Promise.resolve({ videos: S.yt.videos || [], snaps: S.yt.snaps || [], ig: S.ig }); }
    });
  }
  window.InfluencerDash.init({
    sb: sb, toast: toast,
    channelUrl: function (c) { return c.channel_id ? "https://www.youtube.com/channel/" + c.channel_id : "#"; }
  });

  sb.auth.onAuthStateChange(function (ev) { if (ev === "SIGNED_OUT" && !$("app").hidden) show("login-screen"); });
  boot();
})();
