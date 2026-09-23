// Calcula a receita mensal de cada produto da Kiwify ligado a uma ferramenta
// (kiwify_products.tool_id) e preenche o financeiro (monthly_revenue).
//
// Guarda cada venda do mês (kiwify_sales_snapshot). Ao reler um mês já fechado,
// compara venda a venda com a leitura anterior e, se algo mudou (reembolso,
// chargeback, Pix aprovado depois etc.), registra um aviso em revenue_alerts.
//
// Ordem de trabalho por execução (~110 s):
//   1. últimos RECENT_MONTHS meses de cada produto (sempre);
//   2. meses ainda sem leitura venda a venda (criam a base, sem aviso);
//   3. meses lidos há mais de REREAD_AFTER_MS, do mais antigo para o mais novo
//      (chargebacks podem chegar meses depois).
// Quando não falta nenhum mês, chama refresh_revenue_from_kiwify().
//
// Secrets: os mesmos KIWIFY_* do kiwify-sync.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const KIWIFY_BASE = "https://public-api.kiwify.com/v1";
const START = { year: 2025, month: 1 };
const RECENT_MONTHS = 3;
const REREAD_AFTER_MS = 24 * 3600_000;
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
const ymKey = (p: string, m: Ym) => `${p}:${m.year}-${m.month}`;
const ymNum = (m: Ym) => m.year * 12 + m.month;
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
const cents = (v: unknown) => (typeof v === "number" ? v / 100 : null);
const round2 = (n: number) => Math.round(n * 100) / 100;

type Agg = { novos: number; faturamento: number; reembolsos: number; chargebacks: number; bruto: number };
function aggregate(rows: { status: string | null; net_amount: unknown; charge_amount: unknown }[]): Agg {
  const a: Agg = { novos: 0, faturamento: 0, reembolsos: 0, chargebacks: 0, bruto: 0 };
  for (const r of rows) {
    if (PAID.includes(r.status ?? "")) { a.novos++; a.faturamento += Number(r.net_amount) || 0; a.bruto += Number(r.charge_amount) || 0; }
    else if (r.status === "refunded") a.reembolsos++;
    else if (r.status === "chargedback") a.chargebacks++;
  }
  a.faturamento = round2(a.faturamento); a.bruto = round2(a.bruto);
  return a;
}
// Só interessa mudança que mexe nos números do financeiro.
const counts = (s: string | null) => PAID.includes(s ?? "") || s === "refunded" || s === "chargedback";

async function fetchMonth(productId: string, m: Ym) {
  const { start, end } = monthRange(m);
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const js = await kiwifyGet("/sales", {
      product_id: productId, start_date: start, end_date: end, page_size: 100, page_number: page, view_full_sale_details: true,
    });
    const sales: any[] = js.data ?? [];
    out.push(...sales);
    if (!sales.length || page * 100 >= (js.pagination?.count ?? 0)) break;
  }
  const now = new Date().toISOString();
  return out.map((s) => ({
    id: s.id, product_id: productId, year: m.year, month: m.month, status: s.status ?? null,
    net_amount: cents(s.net_amount ?? s.payment?.net_amount), charge_amount: cents(s.payment?.charge_amount),
    customer_name: s.customer?.name ?? null, customer_email: s.customer?.email ?? null,
    payment_method: s.payment_method ?? null, sale_created_at: s.created_at ?? null,
    approved_at: s.approved_date || null, refunded_at: s.refunded_at || null,
    kiwify_updated_at: s.updated_at || null, synced_at: now,
  }));
}

async function readSnapshot(productId: string, m: Ym) {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("kiwify_sales_snapshot").select("*")
      .eq("product_id", productId).eq("year", m.year).eq("month", m.month).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

const saleInfo = (s: any) => ({
  id: s.id, cliente: s.customer_name, email: s.customer_email, pagamento: s.payment_method,
  data_venda: s.sale_created_at, aprovada_em: s.approved_at, reembolsada_em: s.refunded_at,
  valor_liquido: s.net_amount, valor_cobrado: s.charge_amount,
});

async function processMonth(p: { id: string; name: string; tool_id: string }, m: Ym, hasBase: boolean, closed: boolean) {
  const fresh = await fetchMonth(p.id, m);
  const agg = aggregate(fresh);
  let alert = false;

  if (hasBase && closed) {
    const old = await readSnapshot(p.id, m);
    const oldById = new Map(old.map((s) => [s.id, s]));
    const freshIds = new Set(fresh.map((s) => s.id));
    const changes: any[] = [];
    for (const s of fresh) {
      const o = oldById.get(s.id);
      if (o && o.status !== s.status && (counts(o.status) || counts(s.status))) {
        changes.push({ tipo: "status", status_antes: o.status, status_depois: s.status, ...saleInfo(s) });
      } else if (o && o.status === s.status && PAID.includes(s.status ?? "") && Number(o.net_amount) !== Number(s.net_amount)) {
        changes.push({ tipo: "valor", status_antes: o.status, status_depois: s.status, valor_antes: o.net_amount, ...saleInfo(s) });
      } else if (!o && counts(s.status)) {
        changes.push({ tipo: "nova", status_antes: null, status_depois: s.status, ...saleInfo(s) });
      }
    }
    for (const o of old) {
      if (!freshIds.has(o.id) && counts(o.status)) changes.push({ tipo: "sumiu", status_antes: o.status, status_depois: null, ...saleInfo(o) });
    }
    if (changes.length) {
      const before = aggregate(old);
      const { error } = await sb.from("revenue_alerts").insert({
        tool_id: p.tool_id, product_id: p.id, product_name: p.name, year: m.year, month: m.month,
        before, after: agg, changes,
      });
      if (error) throw error;
      alert = true;
    }
  }

  // Grava a leitura nova como base da próxima comparação.
  for (let i = 0; i < fresh.length; i += 500) {
    const { error } = await sb.from("kiwify_sales_snapshot").upsert(fresh.slice(i, i + 500), { onConflict: "id" });
    if (error) throw error;
  }
  if (hasBase) {
    const freshIds = new Set(fresh.map((s) => s.id));
    const gone = (await readSnapshot(p.id, m)).map((r) => r.id).filter((id) => !freshIds.has(id));
    if (gone.length) await sb.from("kiwify_sales_snapshot").delete().in("id", gone);
  }

  const now = new Date().toISOString();
  const { error } = await sb.from("kiwify_monthly_product").upsert({
    product_id: p.id, year: m.year, month: m.month,
    paid_count: agg.novos, net_amount: agg.faturamento, charge_amount: agg.bruto,
    refunded_count: agg.reembolsos, chargeback_count: agg.chargebacks, synced_at: now, snapshot_at: now,
  }, { onConflict: "product_id,year,month" });
  if (error) throw error;
  return alert;
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
    const { data: products, error } = await sb.from("kiwify_products").select("id, name, tool_id").not("tool_id", "is", null);
    if (error) throw error;
    const { data: have } = await sb.from("kiwify_monthly_product").select("product_id, year, month, synced_at, snapshot_at");
    const info = new Map((have ?? []).map((r) => [ymKey(r.product_id, r), r]));

    const now = currentMonthBrt();
    const all = monthsBetween(START, now);
    const recentFrom = ymNum(all[Math.max(0, all.length - RECENT_MONTHS)]);
    type Task = { p: { id: string; name: string; tool_id: string }; m: Ym };
    const recent: Task[] = [], noBase: Task[] = [], stale: { t: Task; at: number }[] = [];
    for (const p of products ?? []) for (const m of all) {
      const r = info.get(ymKey(p.id, m));
      const t = { p, m };
      if (ymNum(m) >= recentFrom) recent.push(t);
      else if (!r?.snapshot_at) noBase.push(t);
      else if (Date.now() - Date.parse(r.synced_at) > REREAD_AFTER_MS) stale.push({ t, at: Date.parse(r.synced_at) });
    }
    noBase.sort((a, b) => ymNum(b.m) - ymNum(a.m));
    stale.sort((a, b) => a.at - b.at);
    const queue = [...recent, ...noBase, ...stale.map((s) => s.t)];

    let processed = 0, alerts = 0;
    for (const t of queue) {
      if (Date.now() >= deadline) break;
      const r = info.get(ymKey(t.p.id, t.m));
      const closed = ymNum(t.m) < ymNum(now);
      if (await processMonth(t.p, t.m, !!r?.snapshot_at, closed)) alerts++;
      info.set(ymKey(t.p.id, t.m), { ...(r ?? {}), product_id: t.p.id, ...t.m, synced_at: new Date().toISOString(), snapshot_at: new Date().toISOString() });
      processed++;
    }
    const missing = (products ?? []).reduce((n, p) => n + all.filter((m) => !info.has(ymKey(p.id, m))).length, 0);
    let updated = 0;
    if (missing === 0) {
      const { data, error: rpcErr } = await sb.rpc("refresh_revenue_from_kiwify");
      if (rpcErr) throw rpcErr;
      updated = data ?? 0;
    }
    result = { ok: true, processed, alerts, missing, queue: queue.length, financeiro_rows: updated, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    result = { ok: false, error: String((e as Error)?.message ?? e) };
  }
  await sb.from("sync_state").upsert({ key: "revenue_last_run", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() });
  return json(result, result.ok ? 200 : 500);
});
