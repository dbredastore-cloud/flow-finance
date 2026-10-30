// Lê produtos e o histórico de vendas da Hotmart e regrava hotmart_products e hotmart_sales.
//
// Sem filtro de status, a Hotmart só devolve vendas aprovadas e completas; aqui pedimos todos os
// status para ter reembolso, chargeback e cancelamento. Sem datas ela devolve só os últimos 30 dias,
// e um período muito longo é recusado, então a leitura vai mês a mês: o mês atual e o anterior em
// toda execução e os antigos em rodízio (cursor em sync_state.hotmart_cursor), até o tempo acabar.
// Dados pessoais: só nome e e-mail do comprador.
//
// Secrets: HOTMART_CLIENT_ID, HOTMART_CLIENT_SECRET e HOTMART_BASIC (o token "Basic" das credenciais).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const TOKEN_URL = "https://api-sec-vlc.hotmart.com/security/oauth/token";
const API = "https://developers.hotmart.com";
const START = { year: 2021, month: 1 };
const PAGE_SIZE = 500;
const TIME_BUDGET_MS = 100_000; // a função tem ~150 s
const STATUSES = [
  "APPROVED", "BLOCKED", "CANCELLED", "CHARGEBACK", "COMPLETE", "EXPIRED", "NO_FUNDS", "OVERDUE",
  "PARTIALLY_REFUNDED", "PRE_ORDER", "PRINTED_BILLET", "PROCESSING_TRANSACTION", "PROTESTED", "REFUNDED",
  "STARTED", "UNDER_ANALISYS", "WAITING_PAYMENT",
];

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let token: string | null = null;
async function hotmartGet(path: string, params: [string, string][]) {
  if (!token) {
    const u = new URL(TOKEN_URL);
    u.searchParams.set("grant_type", "client_credentials");
    u.searchParams.set("client_id", env("HOTMART_CLIENT_ID"));
    u.searchParams.set("client_secret", env("HOTMART_CLIENT_SECRET"));
    const r = await fetch(u, { method: "POST", headers: { Authorization: `Basic ${env("HOTMART_BASIC").replace(/^Basic\s+/i, "")}` } });
    if (!r.ok) throw new Error(`Hotmart recusou o login (${r.status}): ${(await r.text()).slice(0, 200)}`);
    token = (await r.json()).access_token;
  }
  const url = new URL(API + path);
  for (const [k, v] of params) url.searchParams.append(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    let r: Response;
    try {
      r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    } catch (_) { await sleep(2000 * (attempt + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`Hotmart ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  }
  throw new Error(`Hotmart ${path}: sem resposta depois de 3 tentativas`);
}

// Ferramentas Flow citadas no nome do produto.
function guessTools(name: string) {
  const out: string[] = [];
  if (/flow\s*pages/i.test(name)) out.push("flowpages");
  if (/flow\s*tracking/i.test(name)) out.push("flowtracking");
  if (/flow\s*spy/i.test(name)) out.push("flowspy");
  return out;
}
const ms = (v: unknown) => (typeof v === "number" && v > 0 ? new Date(v).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

async function syncProducts() {
  const list: any[] = [];
  let pageToken = "";
  do {
    const js = await hotmartGet("/products/api/v1/products", [["max_results", "100"], ...(pageToken ? [["page_token", pageToken] as [string, string]] : [])]);
    list.push(...(js.items ?? []));
    pageToken = js.page_info?.next_page_token ?? "";
  } while (pageToken);
  const { data: have, error } = await sb.from("hotmart_products").select("id, manual");
  if (error) throw error;
  const manual = new Set((have ?? []).filter((p) => p.manual).map((p) => Number(p.id)));
  const now = new Date().toISOString();
  for (const p of list) {
    const row: Record<string, unknown> = {
      id: p.id, name: str(p.name) ?? `Produto ${p.id}`, status: p.status ?? null, format: p.format ?? null,
      is_subscription: p.is_subscription ?? null, updated_at: now,
    };
    if (!manual.has(p.id)) row.includes_tools = guessTools(p.name ?? "");
    const { error: e } = await sb.from("hotmart_products").upsert(row, { onConflict: "id" });
    if (e) throw e;
  }
  return list.length;
}

// Meses (início em ms UTC-3) do mais novo para o mais antigo.
function months() {
  const out: { label: string; ini: number; fim: number }[] = [];
  const d = new Date(Date.now() - 3 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let y = START.year, m = START.month; y < d.getUTCFullYear() || (y === d.getUTCFullYear() && m <= d.getUTCMonth() + 1); m === 12 ? (y++, m = 1) : m++) {
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    out.push({ label: `${y}-${pad(m)}`, ini: Date.parse(`${y}-${pad(m)}-01T03:00:00Z`), fim: Date.parse(`${ny}-${pad(nm)}-01T03:00:00Z`) - 1 });
  }
  return out.reverse();
}

async function syncSales(deadline: number) {
  const now = new Date().toISOString();
  const all = months();
  const recent = all.slice(0, 2), old = all.slice(2);
  const { data: cur } = await sb.from("sync_state").select("value").eq("key", "hotmart_cursor").maybeSingle();
  let idx = Math.max(0, old.findIndex((m) => m.label === cur?.value?.next));

  let vendas = 0, oldDone = 0;
  const failed: string[] = [];
  // Mês grande (2024 tem ~3.000 vendas por mês) pode não caber numa execução: a página onde parou
  // fica no cursor e a próxima execução continua dali.
  let resumeToken: string = cur?.value?.next === old[idx]?.label ? cur?.value?.page_token ?? "" : "";
  const readMonth = async (m: { label: string; ini: number; fim: number }, startToken = "") => {
    let pageToken = startToken;
    try {
      do {
        const params: [string, string][] = [
          ["max_results", String(PAGE_SIZE)], ["start_date", String(m.ini)], ["end_date", String(m.fim)],
          ...STATUSES.map((s) => ["transaction_status", s] as [string, string]),
        ];
        if (pageToken) params.push(["page_token", pageToken]);
        const js = await hotmartGet("/payments/api/v1/sales/history", params);
        const rows = (js.items ?? []).filter((it: any) => it.purchase?.transaction).map((it: any) => {
          const pu = it.purchase;
          return {
            transaction: pu.transaction, product_id: it.product?.id, product_name: str(it.product?.name),
            commission_as: pu.commission_as ?? null, status: pu.status ?? null,
            is_subscription: pu.is_subscription ?? null, recurrency_number: num(pu.recurrency_number),
            buyer_name: str(it.buyer?.name), buyer_email: str(it.buyer?.email)?.toLowerCase() ?? null,
            price_value: num(pu.price?.value), currency: pu.price?.currency_code ?? null, fee_total: num(pu.hotmart_fee?.total),
            payment_type: pu.payment?.type ?? null, installments: num(pu.payment?.installments_number),
            offer_code: pu.offer?.code ?? null, payment_mode: pu.offer?.payment_mode ?? null,
            order_date: ms(pu.order_date), approved_date: ms(pu.approved_date), warranty_until: ms(pu.warranty_expire_date),
            source_sck: str(pu.tracking?.source_sck), synced_at: now,
          };
        });
        if (rows.length) {
          const { error } = await sb.from("hotmart_sales").upsert(rows, { onConflict: "transaction" });
          if (error) throw error;
        }
        vendas += rows.length;
        pageToken = js.page_info?.next_page_token ?? "";
      } while (pageToken && Date.now() < deadline);
      resumeToken = pageToken;
      return !pageToken;
    } catch (e) {
      if (String(e).includes("recusou o login")) throw e;
      failed.push(m.label);
      return true;
    }
  };

  const firstToken = resumeToken;
  for (const m of recent) await readMonth(m);
  resumeToken = firstToken; // se o tempo acabar antes do 1º mês antigo, a página guardada continua valendo
  while (old.length && oldDone < old.length && Date.now() < deadline) {
    if (!(await readMonth(old[(idx + oldDone) % old.length], oldDone === 0 ? firstToken : ""))) break; // cortado pelo tempo
    oldDone++;
  }
  if (old.length) {
    idx = (idx + oldDone) % old.length;
    await sb.from("sync_state").upsert({ key: "hotmart_cursor", value: { next: old[idx].label, page_token: resumeToken || null }, updated_at: now });
  }
  return { vendas, meses_antigos_lidos: oldDone, proximo: old.length ? old[idx].label : null, falharam: failed };
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
  if (!data?.user) return false;
  const { data: admin } = await sb.from("app_admins").select("user_id").eq("user_id", data.user.id).maybeSingle();
  return !!admin;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);

  const started = Date.now();
  let result: Record<string, unknown>;
  try {
    const produtos = await syncProducts();
    const sales = await syncSales(started + TIME_BUDGET_MS);
    result = { ok: true, produtos, ...sales, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    result = { ok: false, error: String((e as Error)?.message ?? e) };
  }
  await sb.from("sync_state").upsert({ key: "hotmart_last_run", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() });
  return json(result, result.ok ? 200 : 500);
});
