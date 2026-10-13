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