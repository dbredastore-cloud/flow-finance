/* fetch do cliente Supabase com nova tentativa automática (createClient(url, key, { global: { fetch: window.flowFetch } })).
   O banco cancela consultas que passam do limite de tempo (erro 57014) quando está ocupado com as rotinas de sync;
   antes isso virava erro na tela. Agora:
   - 57014 (consulta cancelada por tempo): o banco desfez tudo, então é seguro repetir qualquer chamada;
   - 502/503/504 ou queda de rede: só repete leituras (GET), para nunca gravar duas vezes.
   Até 2 novas tentativas, com espera crescente (1,2 s e 3 s). */
window.flowFetch = (function () {
  var WAITS = [1200, 3000];
  function sleep(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  async function isTimeout(res) {
    if (res.status !== 500) return false;
    try { var b = await res.clone().json(); return !!b && b.code === "57014"; } catch (e) { return false; }
  }
  return async function (input, init) {
    var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    var read = method === "GET" || method === "HEAD";
    for (var i = 0; ; i++) {
      var res;
      try { res = await fetch(input, init); }
      catch (e) {
        if (!read || i >= WAITS.length || (init && init.signal && init.signal.aborted)) throw e;
        await sleep(WAITS[i]);
        continue;
      }
      if (i >= WAITS.length) return res;
      var retry = (read && (res.status === 502 || res.status === 503 || res.status === 504)) || await isTimeout(res);
      if (!retry) return res;
      await sleep(WAITS[i]);
    }
  };
})();

/* Cache persistente das telas (localStorage): a tela abre na hora com a última leitura e atualiza por trás.
   Só para resumos/agregados — nunca listas com e-mails de clientes.
   bind(uid) apaga tudo quando quem está logado muda; clear() no logout. Entradas com mais de 7 dias são ignoradas. */
window.flowCache = (function () {
  var P = "flowc:", MAX_AGE = 7 * 864e5;
  function keys() { var out = []; try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(P) === 0) out.push(k); } } catch (e) {} return out; }
  function clear() { keys().forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} }); }
  function get(key) {
    try {
      var o = JSON.parse(localStorage.getItem(P + key) || "null");
      return o && Date.now() - o.t < MAX_AGE ? o.v : null;
    } catch (e) { return null; }
  }
  function set(key, v) {
    var s;
    try { s = JSON.stringify({ t: Date.now(), v: v }); } catch (e) { return; }
    try { localStorage.setItem(P + key, s); }
    catch (e) { // cheio: recomeça do zero (mantendo o dono)
      var owner = null;
      try { owner = localStorage.getItem(P + "owner"); } catch (e1) {}
      clear();
      try { if (owner !== null) localStorage.setItem(P + "owner", owner); localStorage.setItem(P + key, s); } catch (e2) {}
    }
  }
  function bind(uid) {
    var owner = null;
    try { owner = localStorage.getItem(P + "owner"); } catch (e) {}
    if (owner === String(uid || "")) { // mesmo usuário: só tira o que já venceu
      keys().forEach(function (k) {
        if (k === P + "owner") return;
        try { var o = JSON.parse(localStorage.getItem(k) || "null"); if (!o || !(Date.now() - o.t < MAX_AGE)) localStorage.removeItem(k); } catch (e) {}
      });
      return;
    }
    clear();
    try { localStorage.setItem(P + "owner", String(uid || "")); } catch (e) {}
  }
  return { get: get, set: set, bind: bind, clear: clear };
})();

/* Mensagem de erro legível para a tela (em vez do texto técnico do banco). */
window.flowErrMsg = function (err) {
  var code = err && err.code, msg = (err && err.message) || String(err || "");
  if (code === "57014" || /statement timeout/i.test(msg)) return "O banco está ocupado com uma atualização automática e não respondeu a tempo. Tente de novo em alguns segundos.";
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return "Sem conexão com o servidor. Confira a internet e tente de novo.";
  if (/jwt expired|invalid jwt/i.test(msg)) return "Sua sessão expirou. Recarregue a página e entre de novo.";
  return msg;
};

/* Login do painel pela Edge Function auth-login (registro de tentativas, bloqueio por
   força bruta e aviso no Telegram), em vez de chamar o Supabase Auth direto.
   Devolve o mesmo formato de sb.auth.signInWithPassword: { data, error }. */
window.flowSecureLogin = async function (sb, supabaseUrl, anonKey, email, password) {
  var res;
  try {
    res = await fetch(supabaseUrl + "/functions/v1/auth-login", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey },
      body: JSON.stringify({ email: email, password: password })
    });
  } catch (e) {
    return { data: null, error: { message: "Sem conexão com o servidor. Tente de novo." } };
  }
  var body = {};
  try { body = await res.json(); } catch (e) {}
  if (!res.ok || !body.access_token) {
    return { data: null, error: { message: body.error || "E-mail ou senha incorretos." } };
  }
  return sb.auth.setSession({ access_token: body.access_token, refresh_token: body.refresh_token });
};

/* Recuperação de senha: pede à função auth-mail para enviar o link de redefinição pelo Gmail da Flow.
   Se o Gmail ainda não estiver configurado (ou a função falhar), usa o envio padrão do Supabase para não deixar ninguém sem saída.
   Devolve { ok, message } (mensagem pronta para mostrar na tela). */
window.flowRecoverPassword = async function (sb, supabaseUrl, anonKey, email, redirectTo) {
  var sent = '<div class="msg ok">Se essa conta existir, enviamos o link de redefinição de senha para ' + email.replace(/[<>&"]/g, "") + ". Confira também a caixa de spam.</div>";
  var body = null;
  try {
    var res = await fetch(supabaseUrl + "/functions/v1/auth-mail", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey },
      body: JSON.stringify({ action: "recover", email: email, redirectTo: redirectTo })
    });
    body = await res.json().catch(function () { return null; });
  } catch (e) { body = null; }
  if (body && body.ok) return { ok: true, message: sent };
  if (body && (body.code === "input" || body.code === "rate")) return { ok: false, message: '<div class="msg error">' + body.error + "</div>" };
  // mail_not_configured, falha de envio ou sem resposta: envio padrão do Supabase.
  var fb = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectTo });
  if (fb.error) return { ok: false, message: '<div class="msg error">' + fb.error.message + "</div>" };
  return { ok: true, message: sent };
};