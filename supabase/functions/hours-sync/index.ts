// Lê a planilha de controle de horas (Google Sheets "Controle de horas Flow") e guarda uma foto dela em
// dev_hours_snapshot, que o menu "Horas de desenvolvimento" do painel mostra.
//
// Chamado pelo pg_cron a cada 30 minutos (header x-cron-secret) ou pelo botão "Atualizar agora" do painel (JWT de admin).
// A leitura usa o endereço de exportação CSV do Google; por isso a planilha precisa estar compartilhada como
// "Qualquer pessoa com o link: leitor". Se estiver privada, devolve code "sheet_private" e a foto anterior fica como está.
//
// Abas lidas: Contrato (horas contratadas por mês), Sprints (datas e mês de referência) e Entregas (uma linha por demanda).
// Secret opcional: HOURS_SHEET_ID (padrão: a planilha atual).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SHEET_ID = (Deno.env.get("HOURS_SHEET_ID") ?? "1VlxW4oVio7Q92dzL_6jRfzvaTmXFRminyR7IzbJlu9E").trim();
const SHEET_TITLE = "Controle de horas Flow";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

class Fail extends Error {
  code: string;
  constructor(code: string, msg: string) { super(msg); this.code = code; }
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
const monthIdx = (name: string) => MONTHS.findIndex((m) => norm(m) === norm(name));

// CSV com aspas (valores com vírgula, como "2.637,0", vêm entre aspas).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// "2.637,0" → 2637 · "108,0" → 108 · "108.0" → 108
function num(s: string): number {
  const t = (s ?? "").trim().replace(/[^\d.,-]/g, "");
  if (!t) return 0;
  const v = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t.includes(",") ? t.replace(",", ".") : t;
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}
// "28/09/2026" → "2026-09-28"
function isoDate(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((s ?? "").trim());
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

async function sheetCsv(name: string): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;
  const r = await fetch(url, { redirect: "manual" });
  const ct = r.headers.get("content-type") ?? "";
  if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400) || ct.includes("text/html")) {
    await r.body?.cancel();
    throw new Fail("sheet_private", "A planilha está privada. Compartilhe como \"Qualquer pessoa com o link: leitor\" para a atualização automática funcionar.");
  }
  if (!r.ok) throw new Fail("sheet", `Google respondeu ${r.status} ao ler a aba ${name}.`);
  return parseCsv(await r.text());
}

async function readSheet() {
  const [contrato, sprints, entregas] = await Promise.all([sheetCsv("Contrato"), sheetCsv("Sprints"), sheetCsv("Entregas")]);

  // Ano: vem das datas das sprints; sem datas, o ano atual.
  let year = new Date().getFullYear();
  const firstDate = sprints.map((r) => isoDate(r[1] ?? "")).find(Boolean);
  if (firstDate) year = Number(firstDate.slice(0, 4));

  // Contrato: linhas entre o cabeçalho "Mês" e o "Total".
  const contract: { month: string; ym: number; contracted: number; carry: number }[] = [];
  const ch = contrato.findIndex((r) => norm(r[0] ?? "") === "mes");
  for (let i = ch + 1; ch >= 0 && i < contrato.length; i++) {
    const name = (contrato[i][0] ?? "").trim();
    if (!name || norm(name) === "total") break;
    const mi = monthIdx(name);
    if (mi < 0) continue;
    contract.push({ month: MONTHS[mi][0].toUpperCase() + MONTHS[mi].slice(1), ym: year * 100 + mi + 1, contracted: num(contrato[i][1]), carry: num(contrato[i][2]) });
  }

  // Sprints: cabeçalho "Sprint"; linhas até "Total". Só entram as que têm data ou mês preenchidos.
  const sp: { name: string; start: string | null; end: string | null; month: string }[] = [];
  const sh = sprints.findIndex((r) => norm(r[0] ?? "") === "sprint");
  for (let i = sh + 1; sh >= 0 && i < sprints.length; i++) {
    const name = (sprints[i][0] ?? "").trim();
    if (!name || norm(name) === "total") break;
    const start = isoDate(sprints[i][1] ?? ""), end = isoDate(sprints[i][2] ?? ""), month = (sprints[i][3] ?? "").trim();
    if (start || end || month) sp.push({ name, start, end, month });
  }

  // Entregas: cabeçalho "Sprint"; uma linha por demanda (ignora linhas sem demanda e a célula "Total lançado").
  const deliveries: { sprint: string; demand: string; project: string; hours: number; trello: string | null }[] = [];
  const eh = entregas.findIndex((r) => norm(r[0] ?? "") === "sprint");
  for (let i = eh + 1; eh >= 0 && i < entregas.length; i++) {
    const r = entregas[i];
    const demand = (r[3] ?? "").trim(), project = (r[4] ?? "").trim();
    if (!demand || !project) continue;
    deliveries.push({ sprint: (r[0] ?? "").trim(), demand, project, hours: num(r[5] ?? ""), trello: (r[6] ?? "").trim() || null, value: num(r[7] ?? "") });
  }
  if (!contract.length && !deliveries.length) throw new Fail("sheet", "Não encontrei os dados nas abas Contrato e Entregas. A estrutura da planilha mudou?");

  // Projetos (ferramentas): lista cadastrada no quadro "Projetos" da aba Contrato + os que aparecem nas entregas.
  const projects: string[] = [];
  const ph = contrato.findIndex((r) => norm(r[0] ?? "") === "projetos");
  for (let i = ph + 1; ph >= 0 && i < contrato.length; i++) {
    const name = (contrato[i][0] ?? "").trim();
    if (!name || /^como usar/i.test(norm(name))) break;
    projects.push(name);
  }
  for (const d of deliveries) if (!projects.includes(d.project)) projects.push(d.project);

  // Contratos e valor médio por hora: quadro "Contratos e valor médio por hora" da aba Contrato
  // (colunas: Contrato, Horas por mês, Valor pago, Horas do contrato, Valor por hora, Valor mensal; a última linha é o total/média).
  const contracts: { name: string; hoursMonth: number; paid: number | null; hours: number | null; rate: number; monthly: number }[] = [];
  let avg: { hoursMonth: number; paid: number | null; rate: number; monthly: number } | null = null;
  const kh = contrato.findIndex((r) => norm(r[0] ?? "").startsWith("contratos e valor"));
  for (let i = kh + 2; kh >= 0 && i < contrato.length; i++) {
    const name = (contrato[i][0] ?? "").trim();
    if (!name || !(contrato[i][1] ?? "").trim()) break;
    const opt = (s: string) => ((s ?? "").trim() ? num(s) : null);
    if (/^total|media/.test(norm(name))) { avg = { hoursMonth: num(contrato[i][1]), paid: opt(contrato[i][2]), rate: num(contrato[i][4]), monthly: num(contrato[i][5]) }; break; }
    contracts.push({ name, hoursMonth: num(contrato[i][1]), paid: opt(contrato[i][2]), hours: opt(contrato[i][3]), rate: num(contrato[i][4]), monthly: num(contrato[i][5]) });
  }

  // Valor médio por hora: o da planilha (média ponderada dos contratos); sem o quadro, valor lançado ÷ horas lançadas.
  const hours = deliveries.reduce((s, d) => s + d.hours, 0), value = deliveries.reduce((s, d) => s + d.value, 0);
  return { year, contract, sprints: sp, deliveries, projects, contracts, contractAvg: avg, rate: avg?.rate || (hours ? value / hours : 0), value };
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
  if (!(await authorized(req))) return json({ ok: false, error: "unauthorized" }, 401);

  try {
    const data = await readSheet();
    const { error } = await sb.from("dev_hours_snapshot").upsert({
      id: 1, sheet_id: SHEET_ID, sheet_title: SHEET_TITLE, data, source: "sheet", synced_at: new Date().toISOString(),
    }, { onConflict: "id" });
    if (error) throw error;
    const hours = data.deliveries.reduce((s, d) => s + d.hours, 0);
    return json({ ok: true, deliveries: data.deliveries.length, sprints: data.sprints.length, months: data.contract.length, hours });
  } catch (e) {
    const code = e instanceof Fail ? e.code : "internal";
    console.error("hours-sync", code, (e as Error)?.message);
    return json({ ok: false, code, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
});
