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
