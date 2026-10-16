// Tela "Equipe": quem tem acesso aos painéis (tabela app_admins) e as contas de login.
//
// Só o perfil admin pode chamar. Usa a chave de serviço para
// criar/excluir contas e trocar senhas, coisa que o navegador não pode fazer sozinho.
// Funciona com o cadastro público desligado: criar conta pelo painel não depende dele.
//
// Ações: list · create (envia o acesso por e-mail pelo Gmail da Flow) · grant · revoke · delete_user · reset_password
//        set_access (perfil admin ou personalizado + menus liberados)
// Só o perfil admin (app_admins.role = 'admin') usa esta função; acesso personalizado não gerencia a equipe.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { accessEmail, mailConfigured, PANEL_URL, sendMail } from "./mail.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

class Fail extends Error {
  code: string;
  constructor(code: string, msg: string) { super(msg); this.code = code; }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Mesmas chaves da migration 20261015_menu_access.sql e de assets/flow-access.js.
const MENUS = new Set([
  "fin.financeiro", "fin.health", "fin.clients", "fin.hours", "fin.trello", "fin.instagram",
  "af.overview", "af.base", "af.flowinf", "af.products", "af.youtube", "af.mercado", "af.favoritos",
]);

function access(body: any): { role: "admin" | "custom"; menus: string[] } {
  const role = body.role === "custom" ? "custom" : "admin";
  const menus = role === "custom" && Array.isArray(body.menus) ? [...new Set(body.menus.map(String))].filter((m) => MENUS.has(m)) : [];
  if (role === "custom" && !menus.length) throw new Fail("input", "Escolha pelo menos um menu para o acesso personalizado.");
  return { role, menus };
}
const MIN_PASSWORD = 10;

// Senha provisória sem caracteres confundíveis (0/O, 1/l/I).
function genPassword(len = 14): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join("");
}

async function caller(req: Request): Promise<{ id: string; email: string } | null> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: admin } = await sb.from("app_admins").select("user_id").eq("user_id", data.user.id).eq("role", "admin").maybeSingle();
  return admin ? { id: data.user.id, email: data.user.email ?? "" } : null;
}

async function allUsers() {
  const out: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    out.push(...(data?.users ?? []));
    if ((data?.users ?? []).length < 200) break;
  }
  return out;
}

const view = (u: any, a?: any) => ({
  user_id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at ?? null,
  confirmed: !!u.email_confirmed_at, access_since: a?.created_at ?? null,
  role: a?.role ?? null, menus: a?.menus ?? [],
});

async function list(me: { id: string }) {
  const [users, adm] = await Promise.all([allUsers(), sb.from("app_admins").select("user_id, created_at, role, menus")]);
  if (adm.error) throw adm.error;
  const since = new Map((adm.data ?? []).map((a) => [a.user_id, a]));
  const members = users.filter((u) => since.has(u.id)).map((u) => view(u, since.get(u.id)))
    .sort((a, b) => String(a.email).localeCompare(String(b.email)));
  const others = users.filter((u) => !since.has(u.id)).map((u) => view(u))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { ok: true, me: me.id, members, others };
}

// Quantos perfis admin existem (precisa sobrar pelo menos um para gerenciar a equipe).
async function adminCount(): Promise<number> {
  const { count } = await sb.from("app_admins").select("user_id", { count: "exact", head: true }).eq("role", "admin");
  return count ?? 0;
}

async function isAdminRole(id: string) {
  const { data } = await sb.from("app_admins").select("role").eq("user_id", id).maybeSingle();
  return data?.role === "admin";
}

async function setAccess(body: any, me: { id: string }) {
  const id = String(body.userId ?? "");
  const acc = access(body);
  if (id === me.id && acc.role !== "admin") throw new Fail("input", "Você não pode tirar o seu próprio perfil de admin.");
  if (acc.role !== "admin" && (await isAdminRole(id)) && (await adminCount()) <= 1) throw new Fail("input", "Precisa sobrar pelo menos um admin.");
  const { data, error } = await sb.from("app_admins").update(acc).eq("user_id", id).select("user_id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Fail("input", "Essa pessoa não tem acesso aos painéis.");
  return { ok: true, ...acc };
}

async function create(body: any) {
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) throw new Fail("input", "Informe um e-mail válido.");
  const acc = access(body);
  let password = String(body.password ?? "");
  const generated = !password;
  if (generated) password = genPassword();
  else if (password.length < MIN_PASSWORD) throw new Fail("input", `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);

  let userId = "", existed = false;
  const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) {
    if (!/already|registered|exists/i.test(error.message)) throw new Fail("auth", error.message);
    const found = (await allUsers()).find((u) => String(u.email).toLowerCase() === email);
    if (!found) throw new Fail("auth", error.message);
    userId = found.id; existed = true;
  } else userId = data.user.id;

  const { error: e2 } = await sb.from("app_admins").upsert({ user_id: userId, email, ...acc }, { onConflict: "user_id" });
  if (e2) throw e2;
  // Envia o acesso por e-mail (Gmail da Flow): endereço do painel, login e um link para a pessoa definir a própria senha.
  let mailed = false, mailNote: string | null = null;
  if (body.sendEmail !== false) {
    if (!mailConfigured()) mailNote = "Envio de e-mail ainda não configurado (falta o secret GMAIL_APP_PASSWORD).";
    else {
      try {
        const { data: ld, error: le } = await sb.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: PANEL_URL } });
        const th = ld?.properties?.hashed_token;
        const link = th ? `${PANEL_URL}?token_hash=${encodeURIComponent(th)}&type=recovery` : "";
        if (le || !link) throw new Error(le?.message ?? "sem link");
        await sendMail({ to: email, ...accessEmail(email, link) });
        mailed = true;
      } catch (e) {
        mailNote = "O acesso foi criado, mas o e-mail não foi enviado: " + String((e as Error)?.message ?? e).slice(0, 120);
      }
    }
  }
  return { ok: true, user_id: userId, email, existed, password: existed ? null : password, generated, mailed, mailNote };
}

async function grant(body: any) {
  const id = String(body.userId ?? "");
  const { data, error } = await sb.auth.admin.getUserById(id);
  if (error || !data?.user) throw new Fail("input", "Conta não encontrada.");
  const acc = access(body);
  const { error: e2 } = await sb.from("app_admins").upsert({ user_id: id, email: data.user.email ?? "", ...acc }, { onConflict: "user_id" });
  if (e2) throw e2;
  return { ok: true };
}

async function revoke(body: any, me: { id: string }) {
  const id = String(body.userId ?? "");
  if (id === me.id) throw new Fail("input", "Você não pode remover o seu próprio acesso.");
  if ((await isAdminRole(id)) && (await adminCount()) <= 1) throw new Fail("input", "Precisa sobrar pelo menos um admin.");
  const { error } = await sb.from("app_admins").delete().eq("user_id", id);
  if (error) throw error;
  return { ok: true };
}

async function deleteUser(body: any, me: { id: string }) {
  const id = String(body.userId ?? "");
  if (id === me.id) throw new Fail("input", "Você não pode excluir a sua própria conta.");
  if ((await isAdminRole(id)) && (await adminCount()) <= 1) throw new Fail("input", "Precisa sobrar pelo menos um admin.");
  const { error } = await sb.auth.admin.deleteUser(id);
  if (error) throw new Fail("auth", error.message);
  return { ok: true };
}

async function resetPassword(body: any) {
  const id = String(body.userId ?? "");
  let password = String(body.password ?? "");
  const generated = !password;
  if (generated) password = genPassword();
  else if (password.length < MIN_PASSWORD) throw new Fail("input", `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
  const { error } = await sb.auth.admin.updateUserById(id, { password });
  if (error) throw new Fail("auth", error.message);
  return { ok: true, password, generated };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const me = await caller(req);
  if (!me) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* corpo vazio */ }
  try {
    switch (body.action) {
      case "list": return json(await list(me));
      case "create": return json(await create(body));
      case "grant": return json(await grant(body));
      case "revoke": return json(await revoke(body, me));
      case "delete_user": return json(await deleteUser(body, me));
      case "reset_password": return json(await resetPassword(body));
      case "set_access": return json(await setAccess(body, me));
      default: return json({ ok: false, code: "input", error: "Ação desconhecida." }, 400);
    }
  } catch (e) {
    const code = e instanceof Fail ? e.code : "internal";
    console.error("team-admin", body?.action, code, (e as Error)?.message);
    return json({ ok: false, code, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
});
