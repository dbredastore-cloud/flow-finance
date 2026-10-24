// Direct do @useaflow: lê as conversas e mensagens pela API de mensagens do Instagram (Graph API, login com Facebook)
// e grava em ig_conversations e ig_messages. Respostas a stories e menções ao @useaflow em stories de outras contas
// chegam como mensagem com story_url (o link do story vale 24 h).
//
// Precisa do token com instagram_manage_messages (e a Página da Flow atribuída ao usuário do sistema) e, no app do
// Instagram, "Permitir acesso a mensagens" ligado (Configurações → Mensagens e respostas a stories → Ferramentas
// conectadas). A Meta só entrega as mensagens mais recentes de cada conversa; o painel guarda tudo o que já leu.
//
// Chamado pelo pg_cron de hora em hora (header x-cron-secret) ou pelo painel (JWT de alguém da equipe).
// Corpo opcional: { full: true } para reler todas as conversas (não só as que mudaram).
// Secrets: os mesmos do instagram-sync (IG_ACCESS_TOKEN, IG_BUSINESS_ID, IG_GRAPH_VERSION opcional).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

class Fail extends Error { code: string; constructor(code: string, m: string) { super(m); this.code = code; } }

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
function config() {
  const token = env("IG_ACCESS_TOKEN"), id = env("IG_BUSINESS_ID");
  if (!token || !id) throw new Fail("no_config", "Instagram ainda não configurado: faltam os secrets IG_ACCESS_TOKEN e IG_BUSINESS_ID no Supabase.");
  return { token, id, ver: env("IG_GRAPH_VERSION") || "v25.0" };
}
type Cfg = ReturnType<typeof config>;

async function graph(cfg: Cfg, token: string, path: string, params: Record<string, string> = {}) {
  const url = new URL(path.startsWith("http") ? path : `https://graph.facebook.com/${cfg.ver}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!url.searchParams.has("access_token")) url.searchParams.set("access_token", token);
  const r = await fetch(url);
  const js = await r.json().catch(() => ({}));
  if (r.ok) return js;
  const err = js?.error ?? {};
  if (err.code === 190) throw new Fail("token", "O token do Instagram expirou ou foi revogado. Gere um novo e atualize o secret IG_ACCESS_TOKEN.");
  if ([4, 17, 32, 613].includes(err.code)) throw new Fail("rate", "Limite de chamadas da API do Instagram atingido. Tenta de novo na próxima rodada.");
  const msg = String(err.error_user_msg || err.message || `HTTP ${r.status}`);
  if (err.code === 10 || err.code === 200 || err.code === 230 || /permission|permiss/i.test(msg)) {
    throw new Fail("permission", "Falta permissão para ler o Direct: gere o token com instagram_manage_messages e ligue \"Permitir acesso a mensagens\" no app do Instagram. [Meta: " + msg.slice(0, 200) + "]");
  }
  throw new Fail("api", msg.slice(0, 300));
}

// A API de mensagens usa o token da Página ligada ao Instagram da Flow.
async function pageToken(cfg: Cfg) {
  const js = await graph(cfg, cfg.token, "me/accounts", { fields: "id,name,access_token,instagram_business_account{id}", limit: "100" });
  const page = (js.data ?? []).find((p: any) => p.instagram_business_account?.id === cfg.id);
  if (!page) {
    const seen = (js.data ?? []).map((p: any) => p.name + (p.instagram_business_account?.id ? " (Instagram " + p.instagram_business_account.id + ")" : " (sem Instagram ligado)"));
    throw new Fail("permission", "Nenhuma Página do Facebook ligada ao Instagram da Flow está atribuída ao usuário do sistema. Atribua a Página (Controle total) e gere o token de novo. " +
      (seen.length ? "Páginas que o token vê: " + seen.join("; ") + "." : "O token não vê nenhuma Página."));
  }
  return { pageId: String(page.id), token: String(page.access_token) };
}

const MSG_FIELDS = "id,created_time,from,to,message,story,attachments,is_unsupported";

async function run(cfg: Cfg, full: boolean) {
  const pg = await pageToken(cfg);
  const known = new Map<string, string | null>();
  const { data: rows } = await sb.from("ig_conversations").select("id, updated_at");
  for (const r of rows ?? []) known.set(r.id, r.updated_at);

  // Lista as conversas (mais recentes primeiro) e lê só as que mudaram desde a última vez.
  const convs: any[] = [];
  let next: string | null = `${pg.pageId}/conversations`;
  let params: Record<string, string> = { platform: "instagram", fields: "id,updated_time,participants", limit: "50" };
  for (let page = 0; next && page < 40; page++) {
    const js: any = await graph(cfg, pg.token, next, params);
    convs.push(...(js.data ?? []));
    next = js.paging?.next ?? null;
    params = {};
  }
  const started = Date.now();
  let read = 0, messages = 0, skipped = 0;
  const now = new Date().toISOString();
  for (const c of convs) {
    const prev = known.get(c.id);
    if (!full && prev && Date.parse(prev) >= Date.parse(c.updated_time)) { skipped++; continue; }
    if (Date.now() - started > 110_000) break; // o resto entra na próxima rodada
    const other = (c.participants?.data ?? []).find((p: any) => String(p.id) !== cfg.id && p.username !== undefined) ?? (c.participants?.data ?? [])[0] ?? {};
    const js: any = await graph(cfg, pg.token, String(c.id), { fields: `messages.limit(100){${MSG_FIELDS}}` });
    const msgs: any[] = js.messages?.data ?? [];
    const { error: e1 } = await sb.from("ig_conversations").upsert({
      id: String(c.id), user_id: other.id ? String(other.id) : null, username: other.username ?? null, updated_at: c.updated_time ?? null, fetched_at: now,
    }, { onConflict: "id" });
    if (e1) throw e1;
    if (msgs.length) {
      const out = msgs.map((m) => {
        const fromId = String(m.from?.id ?? "");
        const att = m.attachments?.data?.[0];
        return {
          id: String(m.id), conversation_id: String(c.id), from_id: fromId || null, from_username: m.from?.username ?? null,
          from_business: fromId === cfg.id || m.from?.username === "useaflow",
          text: m.message ? String(m.message).slice(0, 4000) : null,
          story_url: m.story?.reply_to?.link ?? m.story?.mention?.link ?? null,
          attachment: m.story?.mention ? "story_mention" : m.story?.reply_to ? "story_reply" : att ? (att.image_data ? "image" : att.video_data ? "video" : att.audio_data ? "audio" : att.file_url ? "file" : "share") : (m.is_unsupported ? "unsupported" : null),
          created_at: m.created_time ?? null, fetched_at: now,
        };
      });
      const { error: e2 } = await sb.from("ig_messages").upsert(out, { onConflict: "id" });
      if (e2) throw e2;
      messages += out.length;
    }
    read++;
  }
  return { ok: true, conversations: convs.length, read, skipped, messages, pending: convs.length - read - skipped };
}

async function caller(req: Request): Promise<boolean> {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) { const { data } = await sb.rpc("verify_sync_secret", { secret: cronSecret }); return data === true; }
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) return false;
  const { data: admin } = await sb.from("app_admins").select("user_id").eq("user_id", data.user.id).maybeSingle();
  return !!admin;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (!(await caller(req))) return json({ ok: false, error: "unauthorized" }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* cron */ }
  const started = Date.now();
  let result: Record<string, unknown>;
  try {
    result = { ...(await run(config(), body?.full === true)), seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    result = { ok: false, code: e instanceof Fail ? e.code : "internal", error: String((e as Error)?.message ?? e).slice(0, 400) };
  }
  await sb.from("sync_state").upsert({ key: "instagram_dm_last_run", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() });
  return json(result, result.ok ? 200 : (["no_config", "permission"].includes(String(result.code)) ? 200 : 500));
});
