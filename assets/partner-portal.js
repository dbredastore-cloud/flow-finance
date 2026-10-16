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
  var S = { me: null, sales: [], period: "month", from: null, to: null, filter: "all", text: "", sort: { key: "at", dir: -1 },
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
  }

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
  function renderSales() {
    var all = S.sales, by = {};
    GROUPS.forEach(function (g) { by[g[0]] = all.filter(function (s) { return groupOf(s.status) === g[0]; }); });
    var ok = by.ok, total = all.length;
    var comm = sum(ok, function (s) { return s.commission; }), amount = sum(ok, function (s) { return s.amount; });
    var pcts = ok.map(function (s) { return s.pct; }).filter(function (x) { return x != null; });
    var avgPct = pcts.length ? pcts.reduce(function (a, b) { return a + b; }, 0) / pcts.length : null;
    var tile = function (k, label, value, sub, cls) {
      return '<button type="button" class="pp-kpi' + (cls ? " " + cls : "") + (S.filter === k ? " on" : "") + '" data-filter="' + k + '"><small>' + label + '</small><b class="num">' + value + "</b><span>" + sub + "</span></button>";
    };
    $("kpis").innerHTML =
      tile("ok", "Vendas aprovadas", int(ok.length), total ? pct(ok.length / total) + " de todas as tentativas" : "nenhuma venda no período", "good big") +
      tile("ok", "Faturamento", brl(amount), "valor pago pelos clientes", "big") +
      tile("ok", "Sua comissão", brl(comm), avgPct != null ? "média de " + Math.round(avgPct) + "% por venda" : "nas vendas aprovadas", "accent big") +
      tile("wait", "Pendentes", int(by.wait.length), by.wait.length ? brl(sum(by.wait, function (s) { return s.commission; })) + " de comissão a confirmar" : "nada aguardando", "warn sm") +
      tile("refused", "Recusadas", int(by.refused.length), by.refused.length ? "clientes que tentaram comprar" : "nenhuma recusa", "bad sm") +
      tile("refund", "Reembolsos", int(by.refund.length), by.refund.length ? brl(sum(by.refund, function (s) { return s.amount; })) + " devolvidos" : "nenhum reembolso", "sm") +
      tile("cb", "Chargebacks", int(by.cb.length), by.cb.length ? "contestações no cartão" : "nenhum chargeback", "sm");

    $("status-chips").innerHTML = [["all", "Todas", total]].concat(GROUPS.map(function (g) { return [g[0], g[1], by[g[0]].length]; })).map(function (c) {
      return '<button type="button" class="pp-chip' + (S.filter === c[0] ? " on" : "") + '" data-filter="' + c[0] + '">' + c[1] + " <small>" + c[2] + "</small></button>";
    }).join("");

    renderChart(ok);
    renderProducts(ok);
    renderTable();
  }
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

  var COLS = [["at", "Data", "l"], ["customer", "Cliente", "l"], ["phone", "WhatsApp", "l"], ["product", "Produto", "l"], ["method", "Pagamento", "l"],
    ["status", "Situação", "l"], ["amount", "Valor", ""], ["commission", "Comissão", ""], ["pct", "%", ""]];
  function cols() { return COLS.filter(function (c) { return c[0] !== "phone" || contactOn(); }); }
  function filtered() {
    var q = S.text.trim().toLowerCase();
    return S.sales.filter(function (s) {
      if (S.filter !== "all" && groupOf(s.status) !== S.filter) return false;
      if (q && [s.customer, s.customer_email, s.product, s.customer_phone].join(" ").toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function renderTable() {
    var list = filtered(), k = S.sort.key, dir = S.sort.dir;
    var val = function (s) { return k === "at" ? Date.parse(s.at) : k === "amount" || k === "commission" || k === "pct" ? Number(s[k]) || 0 : String(s[k === "phone" ? "customer_phone" : k] || "").toLowerCase(); };
    list.sort(function (a, b) { var x = val(a), y = val(b); return x < y ? -dir : x > y ? dir : 0; });
    var cs = cols();
    $("sales-head").innerHTML = "<tr>" + cs.map(function (c) {
      return '<th class="sortable ' + c[2] + '" data-sort="' + c[0] + '">' + c[1] + (S.sort.key === c[0] ? ' <span class="arrow">' + (dir < 0 ? "↓" : "↑") + "</span>" : "") + "</th>";
    }).join("") + "</tr>";
    $("contact-hint").textContent = contactOn()
      ? "Clique no WhatsApp para abrir a conversa com uma mensagem pronta (recusadas e pendentes são ótimas para recuperar a venda)."
      : "Os contatos dos clientes não estão liberados no seu portal.";
    $("sales-body").innerHTML = list.length ? list.slice(0, 1000).map(function (s) {
      var g = groupOf(s.status);
      var cell = {
        at: '<td class="l num">' + dtt(s.at) + "</td>",
        customer: '<td class="l"><b>' + esc(s.customer || "—") + "</b>" + (contactOn() && s.customer_email ? '<div class="pp-sub"><a href="mailto:' + esc(s.customer_email) + '">' + esc(s.customer_email) + "</a></div>" : "") + "</td>",
        phone: '<td class="l">' + (s.customer_phone ? '<a class="pp-wa" href="https://wa.me/' + esc(String(s.customer_phone).replace(/\D/g, "")) + "?text=" + encodeURIComponent(waText(s)) + '" target="_blank" rel="noopener noreferrer" title="Abrir conversa no WhatsApp">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm0 18.2a8.2 8.2 0 01-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1112 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 01-3.3-2.9c-.2-.4.3-.4.8-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 00-.7.3 3 3 0 00-.9 2.2 5.2 5.2 0 001.1 2.7 11.9 11.9 0 004.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 001.9-1.3 2.3 2.3 0 00.2-1.3c-.1-.1-.3-.2-.5-.3z"/></svg>' +
          esc(phoneFmt(s.customer_phone)) + "</a>" : '<span class="muted">—</span>') + "</td>",
        product: '<td class="l">' + esc(s.product || "—") + (s.tool ? '<div class="pp-sub">' + esc(s.tool) + "</div>" : "") + "</td>",
        method: '<td class="l">' + esc(METHOD[s.method] || s.method || "—") + "</td>",
        status: '<td class="l"><span class="pp-st ' + g + '">' + esc(STATUS_LABEL[s.status] || s.status || "—") + "</span>" + (s.refunded_at ? '<div class="pp-sub">em ' + dt(s.refunded_at) + "</div>" : "") + "</td>",
        amount: '<td class="num">' + brl(s.amount) + "</td>",
        commission: '<td class="num' + (g === "ok" ? " pp-good" : g === "refund" || g === "cb" || g === "refused" ? " pp-strike" : "") + '">' + brl(s.commission) + "</td>",
        pct: '<td class="num">' + (s.pct != null ? s.pct + "%" : "—") + "</td>"
      };
      return '<tr class="pp-row ' + g + '">' + cs.map(function (c) { return cell[c[0]]; }).join("") + "</tr>";
    }).join("") : '<tr><td colspan="' + cs.length + '" class="empty">Nenhuma venda com esse filtro no período.</td></tr>';
    $("sales-count").textContent = list.length + " de " + S.sales.length + " vendas no período" + (list.length > 1000 ? " (mostrando as 1.000 primeiras; use a busca ou exporte o CSV)" : "") + ".";
  }
  $("sales-head").addEventListener("click", function (e) {
    var th = e.target.closest("th[data-sort]");
    if (!th) return;
    var k = th.dataset.sort;
    S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === "customer" || k === "product" ? 1 : -1) };
    renderTable();
  });
  $("sales-q").addEventListener("input", function (e) { S.text = e.target.value; renderTable(); });
  $("sales-csv").addEventListener("click", function () {
    var c = function (v) { var s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var head = ["Data", "Cliente"].concat(contactOn() ? ["E-mail do cliente", "WhatsApp"] : []).concat(["Produto", "Pagamento", "Situação", "Valor", "Comissão", "% comissão"]);
    var rows = [head.map(c).join(",")].concat(filtered().map(function (s) {
      return [dtt(s.at), s.customer].concat(contactOn() ? [s.customer_email, s.customer_phone ? "+" + s.customer_phone : ""] : [])
        .concat([s.product, METHOD[s.method] || s.method, STATUS_LABEL[s.status] || s.status, Number(s.amount || 0).toFixed(2).replace(".", ","), Number(s.commission || 0).toFixed(2).replace(".", ","), s.pct != null ? s.pct + "%" : ""]).map(c).join(",");
    }));
    var blob = new Blob(["﻿" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "minhas-vendas-" + ymd(S.from) + "-a-" + ymd(new Date(S.to.getTime() - DAY)) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });

  /* ---------------- contrato e canal ---------------- */
  async function loadExtras() {
    var me = S.me;
    var r = await Promise.all([
      me.has_contract ? rpc("portal_contract").catch(function () { return null; }) : Promise.resolve(null),
      me.has_channel ? rpc("portal_youtube").catch(function () { return null; }) : Promise.resolve(null)
    ]);
    S.contract = r[0]; S.yt = r[1]; S.extrasLoaded = true;
    renderContract(); renderChannel();
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
      channel: { c: ch, long: { avgViews: null } }, instagram: null, hideInsta: true, readOnly: true,
      socials: esc(S.me.name || ""), heroNote: "Seu canal no YouTube",
      sales: { count: ok.length, amount: sum(ok, function (s) { return s.amount; }), commission: sum(ok, function (s) { return s.commission; }), label: periodLabel() },
      backLabel: "← Voltar ao portal",
      load: function () { return Promise.resolve({ videos: S.yt.videos || [], snaps: S.yt.snaps || [] }); }
    });
  }
  window.InfluencerDash.init({
    sb: sb, toast: toast,
    channelUrl: function (c) { return c.channel_id ? "https://www.youtube.com/channel/" + c.channel_id : "#"; }
  });

  sb.auth.onAuthStateChange(function (ev) { if (ev === "SIGNED_OUT" && !$("app").hidden) show("login-screen"); });
  boot();
})();
