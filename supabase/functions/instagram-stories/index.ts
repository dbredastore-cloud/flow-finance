// Guarda os stories do Instagram da Flow (@useaflow) e as métricas de cada um.
//
// A Meta só entrega um story nas 24 h em que ele está no ar, então esta função roda de hora em hora (pg_cron):
// lê os stories no ar, grava/atualiza cada um em ig_stories com as métricas do momento e guarda a leitura em
// ig_story_snapshots. Story que estava no ar e sumiu da lista saiu do ar: a última leitura fica como final.
//
// Chamado pelo pg_cron (header x-cron-secret) ou pelo painel (JWT de alguém da equipe).
//
// Secrets (Supabase → Edge Functions → Secrets), os mesmos do instagram-sync:
//   IG_ACCESS_TOKEN   token do usuário do sistema (Business Manager) com instagram_basic,
//                     instagram_manage_insights, pages_read_engagement, pages_show_list
//   IG_BUSINESS_ID    ID da conta profissional do Instagram da Flow (17841…)
//   IG_GRAPH_VERSION  opcional; padrão v25.0
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

async function graph(cfg: Cfg, path: string, params: Record<string, string>) {
  const url = new URL(`https://graph.facebook.com/${cfg.ver}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", cfg.token);
  const r = await fetch(url);
  const js = await r.json().catch(() => ({}));
  if (r.ok) return js;
  const err = js?.error ?? {};
  // 190 = token inválido/expirado; 4/17/32/613 = limite de chamadas; 10/200 = falta permissão.
  if (err.code === 190) throw new Fail("token", "O token do Instagram expirou ou foi revogado. Gere um novo e atualize o secret IG_ACCESS_TOKEN.");
  if ([4, 17, 32, 613].includes(err.code)) throw new Fail("rate", "Limite de chamadas da API do Instagram atingido. Tenta de novo na próxima rodada.");
  const msg = String(err.error_user_msg || err.message || `HTTP ${r.status}`);
  throw new Fail("api", msg.slice(0, 300));
}

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

// Métricas simples de story. Se a Meta recusar a lista toda (uma métrica fora desta versão da API), pede uma a uma
// e guarda as que vierem.
const METRICS = ["reach", "views", "replies", "shares", "total_interactions", "follows", "profile_visits", "profile_activity"];
const NAV: Record<string, string> = { tap_forward: "taps_forward", tap_back: "taps_back", tap_exit: "exits", swipe_forward: "swipes_forward" };
const valueOf = (m: any) => num(m?.values?.[0]?.value ?? m?.total_value?.value);

async function insights(cfg: Cfg, id: string) {
  const out: Record<string, number | null> = {};
  let note: string | null = null;
  const fewViews = (e: unknown) => e instanceof Fail && /not enough|insufficient|enough viewers|reach.*(5|five)/i.test(e.message);
  try {
    const js = await graph(cfg, `${id}/insights`, { metric: METRICS.join(",") });
    for (const m of js.data ?? []) out[m.name] = valueOf(m);
  } catch (e) {
    if (fewViews(e)) return { out, note: "Menos de 5 contas viram: a Meta ainda não mostra as métricas." };
    if (!(e instanceof Fail && e.code === "api")) throw e;
    const skipped: string[] = [];
    for (const name of METRICS) {
      try { const js = await graph(cfg, `${id}/insights`, { metric: name }); out[name] = valueOf(js.data?.[0]); }
      catch (e2) { if (!(e2 instanceof Fail && e2.code === "api")) throw e2; skipped.push(name); }
    }
    if (skipped.length) note = "A Meta não entregou: " + skipped.join(", ") + ".";
  }
  try {
    const js = await graph(cfg, `${id}/insights`, { metric: "navigation", breakdown: "story_navigation_action_type" });
    const nav = js.data?.[0];
    out.navigation = num(nav?.total_value?.value);
    for (const r of nav?.total_value?.breakdowns?.[0]?.results ?? []) {
      const col = NAV[String(r.dimension_values?.[0] ?? "").toLowerCase()];
      if (col) out[col] = num(r.value);
    }
  } catch (e) {
    if (!(e instanceof Fail && e.code === "api")) throw e;
    note = (note ? note + " " : "") + "Navegação indisponível.";
  }
  return { out, note };
}

async function run(cfg: Cfg) {
  const now = new Date().toISOString();
  const list = await graph(cfg, `${cfg.id}/stories`, { fields: "id,media_type,caption,permalink,timestamp", limit: "100" });
  const live: any[] = list.data ?? [];
  let saved = 0;
  const errors: Record<string, string> = {};
  for (const s of live) {
    try {
      const { out, note } = await insights(cfg, String(s.id));
      const posted = s.timestamp ? new Date(s.timestamp) : new Date();
      const { error } = await sb.from("ig_stories").upsert({
        id: String(s.id), ig_user_id: cfg.id, media_type: s.media_type ?? null,
        caption: String(s.caption ?? "").slice(0, 2200) || null, permalink: s.permalink ?? null,
        posted_at: posted.toISOString(), expires_at: new Date(posted.getTime() + 24 * 3600e3).toISOString(),
        reach: out.reach ?? null, views: out.views ?? null, replies: out.replies ?? null, shares: out.shares ?? null,
        total_interactions: out.total_interactions ?? null, follows: out.follows ?? null,
        profile_visits: out.profile_visits ?? null, profile_activity: out.profile_activity ?? null,
        navigation: out.navigation ?? null, taps_forward: out.taps_forward ?? null, taps_back: out.taps_back ?? null,
        exits: out.exits ?? null, swipes_forward: out.swipes_forward ?? null,
        insights_note: note, insights_at: now, final: false,
      }, { onConflict: "id" });
      if (error) throw error;
      await sb.from("ig_story_snapshots").insert({ story_id: String(s.id), taken_at: now, metrics: out });
      saved++;
    } catch (e) {
      if (e instanceof Fail && (e.code === "token" || e.code === "rate")) throw e;
      errors[String(s.id)] = String((e as Error)?.message ?? e).slice(0, 300);
    }
  }
  // O que estava no ar e não veio mais na lista saiu do ar: a última leitura vira a final.
  const ids = live.map((s) => String(s.id));
  let q = sb.from("ig_stories").update({ final: true }).eq("final", false);
  if (ids.length) q = q.not("id", "in", `(${ids.join(",")})`);
  const { data: closed } = await q.select("id");
  return { ok: true, live: live.length, saved, closed: (closed ?? []).length, errors };
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
  const started = Date.now();
  let result: Record<string, unknown>;
  try {
    result = { ...(await run(config())), seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    result = { ok: false, code: e instanceof Fail ? e.code : "internal", error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  await sb.from("sync_state").upsert({ key: "instagram_stories_last_run", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() });
  return json(result, result.ok ? 200 : (result.code === "no_config" ? 200 : 500));
});
