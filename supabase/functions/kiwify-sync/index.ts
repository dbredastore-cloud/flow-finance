// Sincroniza afiliados e vendas com comissão da Kiwify para o Supabase.
//
// Chamado pelo pg_cron (header x-cron-secret) ou pelo botão "Sincronizar" do
// painel (JWT de usuário logado). Cada execução trabalha até ~110s: primeiro
// atualiza a lista de afiliados, depois avança o histórico (janelas de 89 dias,
// de hoje para trás) e, com o histórico completo, busca só o que mudou.
//
// Secrets necessários (Supabase → Edge Functions → Secrets):
//   KIWIFY_CLIENT_ID, KIWIFY_CLIENT_SECRET, KIWIFY_ACCOUNT_ID
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const KIWIFY_BASE = "https://public-api.kiwify.com/v1";
const HISTORY_DAYS = 1095; // 3 anos
const WINDOW_DAYS = 89; // a API aceita no máximo 90 dias por consulta
const TIME_BUDGET_MS = 110_000;
const MIN_GAP_MS = 720; // ~85 req/min, mesmo limite do kiwify_bot
const AFFILIATES_REFRESH_MS = 6 * 3600_000;
const LOCK_TTL_MS = 5 * 60_000;

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

let started = 0;
let deadline = 0;
const timeLeft = () => Date.now() < deadline;

// ---------------- Kiwify client ----------------
let token: string | null = null;
let lastReq = 0;

async function kiwifyToken(): Promise<string> {
  if (token) return token;
  const env = (k: string) => (Deno.env.get(k) ?? "").trim();
  const missing = ["KIWIFY_CLIENT_ID", "KIWIFY_CLIENT_SECRET", "KIWIFY_ACCOUNT_ID"].filter((k) => !env(k));
  if (missing.length) throw new Error(`Secrets não configurados no Supabase: ${missing.join(", ")}`);
  const r = await fetch(`${KIWIFY_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("KIWIFY_CLIENT_ID"),
      client_secret: env("KIWIFY_CLIENT_SECRET"),
      grant_type: "client_credentials",
    }),
  });
  if (!r.ok) throw new Error(`Kiwify recusou o login (${r.status}): ${(await r.text()).slice(0, 200)}`);
  token = (await r.json()).access_token;
  return token!;
}

async function kiwifyGet(path: string, params: Record<string, string | number | boolean>) {
  const url = new URL(KIWIFY_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastReq + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${await kiwifyToken()}`,
        "x-kiwify-account-id": (Deno.env.get("KIWIFY_ACCOUNT_ID") ?? "").trim(),
      },
    });
    if (r.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`Kiwify ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  }
  throw new Error(`Kiwify ${path}: limite de requisições (429) persistente`);
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ---------------- Helpers ----------------
const cents = (v: unknown) => (typeof v === "number" ? Math.round(v) / 100 : v == null || v === "" ? null : Number(v) / 100);
const iso = (v: unknown) => (typeof v === "string" && v ? v : null);
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);
const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

async function getState<T>(key: string, fallback: T): Promise<T> {
  const { data } = await sb.from("sync_state").select("value").eq("key", key).maybeSingle();
  return (data?.value as T) ?? fallback;
}
async function setState(key: string, value: unknown) {
  const { error } = await sb.from("sync_state").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
}

let tools: { id: string; slug: string; name: string }[] = [];
const knownProducts = new Set<string>();

function guessTool(productName: string): string | null {
  const n = norm(productName);
  const hit = tools.find((t) => n.includes(norm(t.slug)) || n.includes(norm(t.name)));
  return hit?.id ?? null;
}

// ---------------- Affiliates ----------------
async function syncAffiliates() {
  const last = await getState<{ at?: string }>("affiliates", {});
  if (last.at && Date.now() - Date.parse(last.at) < AFFILIATES_REFRESH_MS) return 0;

  const byEmail = new Map<string, any>();
  for (let page = 1; ; page++) {
    if (!timeLeft()) return 0; // tenta de novo na próxima execução
    const js = await kiwifyGet("/affiliates", { page_size: 100, page_number: page });
    const rows: any[] = js.data ?? [];
    for (const a of rows) {
      const email = (a.email || "").trim().toLowerCase();
      if (!email) continue;
      const cur = byEmail.get(email) ?? {
        email, name: a.name ?? null, company_name: a.company_name || null,
        company_cnpj: a.company_cnpj || null, director_cpf: a.director_cpf || null,
        kiwify_status: a.status ?? null, kiwify_ids: [] as string[], products: [] as any[],
      };
      if (a.affiliate_id && !cur.kiwify_ids.includes(a.affiliate_id)) cur.kiwify_ids.push(a.affiliate_id);
      if (a.product?.id) cur.products.push({ id: a.product.id, name: a.product.name, commission: a.commission, status: a.status });
      if (a.status === "active") cur.kiwify_status = "active";
      cur.company_cnpj ||= a.company_cnpj || null;
      byEmail.set(email, cur);
      if (a.product?.id) await ensureProduct(a.product.id, a.product.name);
    }
    const count = js.pagination?.count ?? 0;
    if (!rows.length || page * 100 >= count) break;
  }
  const rows = [...byEmail.values()].map((r) => ({ ...r, document: r.company_cnpj || r.director_cpf }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("affiliates").upsert(rows.slice(i, i + 500), { onConflict: "email" });
    if (error) throw error;
  }
  await setState("affiliates", { at: new Date().toISOString(), count: rows.length });
  return rows.length;
}

async function ensureProduct(id: string, name: string) {
  if (knownProducts.has(id)) return;
  knownProducts.add(id);
  await sb.from("kiwify_products").upsert(
    { id, name: name || id, tool_id: guessTool(name) },
    { onConflict: "id", ignoreDuplicates: true },
  );
}

// ---------------- Sales ----------------
function affiliateOf(sale: any) {
  let ac = sale.affiliate_commission;
  if (Array.isArray(ac)) ac = ac.find((x) => x?.email) ?? null;
  if (!ac || !ac.email) return null;
  return ac;
}

async function saveSales(sales: any[]) {
  const rows: any[] = [];
  const affiliates = new Map<string, any>();
  for (const s of sales) {
    const ac = affiliateOf(s);
    if (!ac) continue;
    const email = String(ac.email).trim().toLowerCase();
    if (s.product?.id) await ensureProduct(s.product.id, s.product.name);
    rows.push({
      id: s.id,
      affiliate_email: email,
      affiliate_name: ac.name ?? null,
      affiliate_document: ac.document ?? null,
      product_id: s.product?.id ?? null,
      product_name: s.product?.name ?? null,
      status: s.status ?? null,
      payment_method: s.payment_method ?? null,
      amount: cents(s.payment?.charge_amount ?? s.payment?.product_base_price),
      net_amount: cents(s.net_amount ?? s.payment?.net_amount),
      commission: cents(ac.amount),
      customer_name: s.customer?.name ?? null,
      customer_email: s.customer?.email ?? null,
      sale_created_at: s.created_at,
      approved_at: iso(s.approved_date),
      refunded_at: iso(s.refunded_at),
      kiwify_updated_at: iso(s.updated_at),
      raw: { affiliate_commission: s.affiliate_commission, payment: s.payment, product: s.product, sale_type: s.sale_type },
      synced_at: new Date().toISOString(),
    });
    if (!affiliates.has(email)) affiliates.set(email, { email, name: ac.name ?? null, document: ac.document ?? null });
  }
  if (affiliates.size) {
    // Afiliado visto em venda mas ainda não listado em /affiliates: cria sem sobrescrever nada.
    await sb.from("affiliates").upsert([...affiliates.values()], { onConflict: "email", ignoreDuplicates: true });
  }
  if (rows.length) {
    const { error } = await sb.from("affiliate_sales").upsert(rows, { onConflict: "id" });
    if (error) throw error;
  }
  return rows.length;
}

type Cursor = { end: string; page: number; done: boolean; limit: string };

// Percorre uma janela de datas página a página. Retorna false se o tempo acabou.
async function syncWindow(
  start: string, end: string, extra: Record<string, string>, fromPage: number,
  onPage: (page: number) => Promise<void>, stats: { fetched: number; saved: number },
) {
  for (let page = fromPage; ; page++) {
    if (!timeLeft()) return false;
    const js = await kiwifyGet("/sales", {
      start_date: start, end_date: end, page_size: 100, page_number: page,
      view_full_sale_details: true, ...extra,
    });
    const sales: any[] = js.data ?? [];
    stats.fetched += sales.length;
    stats.saved += await saveSales(sales);
    const count = js.pagination?.count ?? 0;
    const finished = !sales.length || page * 100 >= count;
    await onPage(finished ? -1 : page + 1);
    if (finished) return true;
  }
}

async function syncBackfill(stats: { fetched: number; saved: number }) {
  const today = new Date();
  const cur = await getState<Cursor>("backfill", {
    end: day(today), page: 1, done: false, limit: day(addDays(today, -HISTORY_DAYS)),
  });
  while (!cur.done && timeLeft()) {
    const end = new Date(cur.end + "T00:00:00Z");
    const limit = new Date(cur.limit + "T00:00:00Z");
    const start = addDays(end, -WINDOW_DAYS) < limit ? limit : addDays(end, -WINDOW_DAYS);
    const complete = await syncWindow(day(start), cur.end, {}, cur.page, async (next) => {
      if (next === -1) {
        cur.end = day(addDays(start, -1));
        cur.page = 1;
        cur.done = start <= limit;
      } else cur.page = next;
      await setState("backfill", cur);
    }, stats);
    if (!complete) break;
  }
  return cur;
}

async function syncRecent(stats: { fetched: number; saved: number }) {
  // Vendas criadas nos últimos 89 dias que mudaram desde a última passada
  // (aprovações, reembolsos, chargebacks).
  const st = await getState<{ since?: string; page?: number; runStart?: string }>("recent", {});
  const now = new Date();
  const runStart = st.page && st.page > 1 && st.runStart ? st.runStart : now.toISOString();
  const extra: Record<string, string> = {};
  if (st.since) {
    extra.updated_at_start_date = day(addDays(new Date(st.since), -1));
    extra.updated_at_end_date = day(addDays(now, 1));
  }
  const complete = await syncWindow(day(addDays(now, -WINDOW_DAYS)), day(now), extra, st.page ?? 1, async (next) => {
    await setState("recent", next === -1 ? { since: runStart, page: 1 } : { ...st, runStart, page: next });
  }, stats);
  return complete;
}

// ---------------- Handler ----------------
async function authorized(req: Request) {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    const { data } = await sb.rpc("verify_sync_secret", { secret: cronSecret });
    return data === true;
  }
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data } = await sb.auth.getUser(jwt);
  return !!data?.user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);

  started = Date.now();
  deadline = started + TIME_BUDGET_MS;
  const lock = await getState<{ at?: string }>("lock", {});
  if (lock.at && Date.now() - Date.parse(lock.at) < LOCK_TTL_MS) {
    return json({ ok: true, skipped: "sincronização já em andamento" });
  }
  await setState("lock", { at: new Date().toISOString() });

  const stats = { fetched: 0, saved: 0 };
  let result: Record<string, unknown> = {};
  try {
    tools = (await sb.from("tools").select("id, slug, name")).data ?? [];
    const affiliates = await syncAffiliates();
    const backfill = await syncBackfill(stats);
    let recentComplete = false;
    if (backfill.done && timeLeft()) recentComplete = await syncRecent(stats);
    result = {
      ok: true, affiliates, ...stats,
      backfill_done: backfill.done, backfill_cursor: backfill.end,
      recent_complete: recentComplete, seconds: Math.round((Date.now() - started) / 1000),
    };
  } catch (e) {
    result = { ok: false, error: String((e as Error)?.message ?? e), ...stats };
  } finally {
    await setState("lock", {});
  }
  await setState("last_run", { at: new Date().toISOString(), ...result });
  return json(result, result.ok ? 200 : 500);
});
