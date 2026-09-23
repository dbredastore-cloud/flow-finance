// Calcula a receita mensal de cada produto da Kiwify ligado a uma ferramenta
// (kiwify_products.tool_id) e preenche o financeiro (monthly_revenue).
//
// Por execução (~110 s): recalcula os últimos 3 meses de cada produto (reembolsos
// mudam meses recentes) e completa meses que ainda faltam desde START. Quando
// não falta nenhum mês, chama refresh_revenue_from_kiwify() — antes disso o
// acumulado de usuários sairia errado.
//
// Secrets: os mesmos KIWIFY_* do kiwify-sync.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const KIWIFY_BASE = "https://public-api.kiwify.com/v1";
const START = { year: 2025, month: 1 };
const RECENT_MONTHS = 3;
const TIME_BUDGET_MS = 110_000;
const MIN_GAP_MS = 720;
const PAID = ["paid", "approved"];

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

let token: string | null = null;
let lastReq = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = (k: string) => (Deno.env.get(k) ?? "").trim();

async function kiwifyGet(path: string, params: Record<string, string | number | boolean>) {
  if (!token) {
    const r = await fetch(`${KIWIFY_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env("KIWIFY_CLIENT_ID"), client_secret: env("KIWIFY_CLIENT_SECRET"), grant_type: "client_credentials" }),
    });
    if (!r.ok) throw new Error(`Kiwify recusou o login (${r.status}): ${(await r.text()).slice(0, 200)}`);
    token = (await r.json()).access_token;
  }
  const url = new URL(KIWIFY_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastReq + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "x-kiwify-account-id": env("KIWIFY_ACCOUNT_ID") } });
    if (r.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`Kiwify ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  }
  throw new Error(`Kiwify ${path}: limite de requisições (429) persistente`);
}

type Ym = { year: number; month: number };
const key = (p: string, m: Ym) => `${p}:${m.year}-${m.month}`;
const pad = (n: number) => String(n).padStart(2, "0");
// Mês no horário de Brasília (UTC-3, sem horário de verão desde 2019).
function monthRange(m: Ym) {
  const next = m.month === 12 ? { year: m.year + 1, month: 1 } : { year: m.year, month: m.month + 1 };
  const start = `${m.year}-${pad(m.month)}-01T03:00:00.000Z`;
  const end = new Date(Date.parse(`${next.year}-${pad(next.month)}-01T03:00:00.000Z`) - 1).toISOString();
  return { start, end };
}
function currentMonthBrt(): Ym {
  const d = new Date(Date.now() - 3 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
function monthsBetween(a: Ym, b: Ym): Ym[] {
  const out: Ym[] = [];
  for (let y = a.year, m = a.month; y < b.year || (y === b.year && m <= b.month); m === 12 ? (y++, m = 1) : m++) out.push({ year: y, month: m });
  return out;
}

async function aggregateMonth(productId: string, m: Ym) {
  const { start, end } = monthRange(m);
  const agg = { paid_count: 0, net: 0, charge: 0, refunded_count: 0, chargeback_count: 0 };
  for (let page = 1; ; page++) {
    const js = await kiwifyGet("/sales", {
      product_id: productId, start_date: start, end_date: end, page_size: 100, page_number: page, view_full_sale_details: true,
    });
    const sales: any[] = js.data ?? [];
    for (const s of sales) {
      if (PAID.includes(s.status)) {
        agg.paid_count++;
        agg.net += s.net_amount ?? s.payment?.net_amount ?? 0;
        agg.charge += s.payment?.charge_amount ?? 0;
      } else if (s.status === "refunded") agg.refunded_count++;
      else if (s.status === "chargedback") agg.chargeback_count++;
    }
    const count = js.pagination?.count ?? 0;
    if (!sales.length || page * 100 >= count) break;
  }
  const { error } = await sb.from("kiwify_monthly_product").upsert({
    product_id: productId, year: m.year, month: m.month,
    paid_count: agg.paid_count, net_amount: agg.net / 100, charge_amount: agg.charge / 100,
    refunded_count: agg.refunded_count, chargeback_count: agg.chargeback_count, synced_at: new Date().toISOString(),
  }, { onConflict: "product_id,year,month" });
  if (error) throw error;
}

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

  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;
  let result: Record<string, unknown>;
  try {
    const { data: products, error } = await sb.from("kiwify_products").select("id, name").not("tool_id", "is", null);
    if (error) throw error;
    const { data: have } = await sb.from("kiwify_monthly_product").select("product_id, year, month");
    const done = new Set((have ?? []).map((r) => key(r.product_id, r)));

    const now = currentMonthBrt();
    const all = monthsBetween(START, now);
    const recent = all.slice(-RECENT_MONTHS);
    // Primeiro os meses recentes (sempre), depois os que faltam, do mais novo para o mais antigo.
    const queue: { p: string; m: Ym }[] = [];
    for (const p of products ?? []) for (const m of recent) queue.push({ p: p.id, m });
    for (const m of [...all].reverse()) for (const p of products ?? []) {
      if (!done.has(key(p.id, m)) && !recent.includes(m)) queue.push({ p: p.id, m });
    }

    let processed = 0;
    for (const t of queue) {
      if (Date.now() >= deadline) break;
      await aggregateMonth(t.p, t.m);
      done.add(key(t.p, t.m));
      processed++;
    }
    const missing = (products ?? []).reduce((n, p) => n + all.filter((m) => !done.has(key(p.id, m))).length, 0);
    let updated = 0;
    if (missing === 0) {
      const { data, error: rpcErr } = await sb.rpc("refresh_revenue_from_kiwify");
      if (rpcErr) throw rpcErr;
      updated = data ?? 0;
    }
    result = { ok: true, processed, missing, financeiro_rows: updated, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    result = { ok: false, error: String((e as Error)?.message ?? e) };
  }
  await sb.from("sync_state").upsert({ key: "revenue_last_run", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() });
  return json(result, result.ok ? 200 : 500);
});
