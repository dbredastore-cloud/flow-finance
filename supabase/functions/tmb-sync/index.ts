// Lê produtos e pedidos da TMB (Tem Mais no Boleto) e regrava tmb_products e tmb_orders.
//
// A API devolve os pedidos efetivados e cancelados com o status financeiro atual; relendo os meses
// (ver syncOrders) pegamos cancelamentos e quem ficou inadimplente sem precisar de webhook.
// Dados pessoais: só nome, e-mail, telefone, cidade e estado (CPF, endereço e nascimento ficam fora).
//
// Secret: TMB_API_TOKEN (Portal do Produtor → Produtos → TMB API).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const TMB_BASE = "https://api.tmbeducacao.com.br";
const PAGE_SIZE = 100; // máximo que a TMB devolve por página
const START = { year: 2024, month: 6 }; // mês do pedido mais antigo na TMB
const TIME_BUDGET_MS = 90_000; // a função tem ~150 s

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tmbGet(path: string) {
  const token = (Deno.env.get("TMB_API_TOKEN") ?? "").trim();
  if (!token) throw new Error("TMB_API_TOKEN não configurado nos secrets do Supabase");
  for (let attempt = 0; attempt < 2; attempt++) {
    // Às vezes a TMB não responde: sem limite, uma chamada pendurada estoura o tempo da função.
    let r: Response;
    try {
      r = await fetch(TMB_BASE + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    } catch (_) { await sleep(1500 * (attempt + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`TMB ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  }
  throw new Error(`TMB ${path}: sem resposta depois de 2 tentativas`);
}

// Ferramentas Flow citadas no nome ou na descrição do produto (combos que liberam as ferramentas).
function guessTools(text: string) {
  const out: string[] = [];
  if (/flow\s*pages/i.test(text)) out.push("flowpages");
  if (/flow\s*tracking/i.test(text)) out.push("flowtracking");
  if (/flow\s*spy/i.test(text)) out.push("flowspy");
  return out;
}

// A TMB manda datas com e sem fuso; sem fuso é horário de Brasília.
function ts(v: unknown) {
  if (typeof v !== "string" || !v) return null;
  return /[zZ]|[+-]\d\d:\d\d$/.test(v) ? v : v + "-03:00";
}
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

async function syncProducts() {
  const list: any[] = await tmbGet("/api/produtos");
  const { data: have, error } = await sb.from("tmb_products").select("id, manual");
  if (error) throw error;
  const manual = new Set((have ?? []).filter((p) => p.manual).map((p) => p.id));
  const now = new Date().toISOString();
  const rows = list.map((p) => {
    const row: Record<string, unknown> = {
      id: p.produto_id, name: p.produto_nome ?? `Produto ${p.produto_id}`, description: p.descricao ?? null,
      price_text: p.valor_total ?? null, active: p.ativo ?? null, updated_at: now,
    };
    if (!manual.has(p.produto_id)) row.includes_tools = guessTools(`${p.produto_nome ?? ""} ${p.descricao ?? ""}`);
    return row;
  });
  for (const r of rows.filter((r) => "includes_tools" in r)) {
    const { error: e } = await sb.from("tmb_products").upsert(r, { onConflict: "id" });
    if (e) throw e;
  }
  for (const r of rows.filter((r) => !("includes_tools" in r))) {
    const { error: e } = await sb.from("tmb_products").update(r).eq("id", r.id as number);
    if (e) throw e;
  }
  return rows.length;
}

// A listagem da TMB para de responder depois do pedido 1.000, então a leitura vai mês a mês.
function months() {
  const out: { ini: string; fim: string }[] = [];
  const d = new Date(Date.now() - 3 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let y = START.year, m = START.month; y < d.getUTCFullYear() || (y === d.getUTCFullYear() && m <= d.getUTCMonth() + 1); m === 12 ? (y++, m = 1) : m++) {
    // data_final pode ser lida como meia-noite: vai até o dia 1 do mês seguinte (repetidos são ignorados).
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    out.push({ ini: `${y}-${pad(m)}-01`, fim: `${ny}-${pad(nm)}-01` });
  }
  return out;
}

// Cada execução relê o mês atual e o anterior (status mudam mais nos recentes) e mais alguns meses
// antigos em rodízio, guardando onde parou em sync_state.tmb_cursor. A TMB fica instável com muitas
// chamadas seguidas, então há uma pausa entre elas e um mês que falha só volta na próxima volta.
const OLD_PER_RUN = 6;
const GAP_MS = 800;

async function syncOrders(deadline: number) {
  const now = new Date().toISOString();
  const seen = new Set<number>();
  const failed: string[] = [];
  const all = months().reverse(); // do mais novo para o mais antigo
  const recent = all.slice(0, 2), old = all.slice(2);

  const { data: cur } = await sb.from("sync_state").select("value").eq("key", "tmb_cursor").maybeSingle();
  let idx = Math.max(0, old.findIndex((m) => m.ini === cur?.value?.next));
  const queue = [...recent];
  for (let k = 0; k < Math.min(OLD_PER_RUN, old.length); k++) queue.push(old[(idx + k) % old.length]);

  let done = 0;
  for (const w of queue) {
    if (Date.now() > deadline) break;
    let ok = true;
    for (let page = 1; ; page++) {
      await sleep(GAP_MS);
      let js: any;
      try {
        js = await tmbGet(`/api/pedidos?pageNumber=${page}&pageSize=${PAGE_SIZE}&data_inicio=${w.ini}&data_final=${w.fim}`);
      } catch (_) { ok = false; break; }
      if ((await saveOrders(js)) < PAGE_SIZE) break;
    }
    if (!ok) failed.push(w.ini.slice(0, 7));
    done++;
  }
  const oldDone = Math.max(0, done - recent.length);
  if (old.length) {
    idx = (idx + oldDone) % old.length;
    await sb.from("sync_state").upsert({ key: "tmb_cursor", value: { next: old[idx].ini }, updated_at: now });
  }
  return { pedidos: seen.size, meses_lidos: done, falharam: failed };

  async function saveOrders(js: any) {
    if (js?.succeeded === false) throw new Error(`TMB pedidos: ${js.message ?? JSON.stringify(js.errors)}`);
    const list: any[] = js?.data ?? [];
    const rows = list.filter((o) => o.pedido_id != null && !seen.has(o.pedido_id)).map((o) => {
      seen.add(o.pedido_id);
      return {
        id: o.pedido_id, product_id: o.produto_id, product_name: str(o.lancamento),
        status: str(o.status_pedido), financial_status: str(o.status_financeiro),
        customer_name: str(o.cliente), customer_email: str(o.email)?.toLowerCase() ?? null,
        phone: str(o.telefone), city: str(o.endereco_cidade), state: str(o.endereco_estado),
        total_amount: num(o.valor_total), down_payment: num(o.valor_entrada), installment_amount: num(o.valor_parcela),
        installments: num(o.parcelas), admin_fee_pct: num(o.taxa_administracao),
        created_at: ts(o.criado_em), effective_at: ts(o.data_efetivado), best_payment_day: num(o.melhor_dia_pagamento),
        utm_source: str(o.utm_source), utm_medium: str(o.utm_medium), utm_campaign: str(o.utm_campaign), utm_content: str(o.utm_content),
        synced_at: now,
      };
    });
    if (rows.length) {
      const { error } = await sb.from("tmb_orders").upsert(rows, { onConflict: "id" });
      if (error) throw error;
    }
    return list.length; // página incompleta = fim do mês
  }
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
    const orders = await syncOrders(started + TIME_BUDGET_MS);
    result = { ok: true, produtos, ...orders, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    result = { ok: false, error: String((e as Error)?.message ?? e) };
  }
  await sb.from("sync_state").upsert({ key: "tmb_last_run", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() });
  return json(result, result.ok ? 200 : 500);
});
