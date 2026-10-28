// Análise da IA na Home do Financeiro: comparativos de faturamento, vendas, reembolsos e despesas para tomada de decisão.
//
// Os números vêm prontos de public.fin_analysis_facts() (mês atual × mês anterior × mesmo mês do ano passado, mês
// fechado × mesmo mês do ano passado, ano × ano, por ferramenta, despesas e projeção). O Claude (Haiku) só interpreta
// e escreve; o texto e os números usados ficam em fin_analyses (a Home mostra o último).
//
// Chamado pelo pg_cron todo dia às 8h10 de Brasília (header x-cron-secret) ou pelo botão "Gerar análise agora" da Home
// (JWT de quem tem o menu fin.financeiro).
// Secret: ANTHROPIC_API_KEY (sem ela, a análise é gravada só com os números e a Home mostra a tabela de comparativos).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

async function caller(req: Request): Promise<"cron" | "user" | null> {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) { const { data } = await sb.rpc("verify_sync_secret", { secret: cronSecret }); return data === true ? "cron" : null; }
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: a } = await sb.from("app_admins").select("role, menus").eq("user_id", data.user.id).maybeSingle();
  return a && (a.role === "admin" || (a.menus ?? []).includes("fin.financeiro")) ? "user" : null;
}

const SYSTEM = `Você é o analista financeiro da Flow (ferramentas SaaS FlowPages, FlowTracking e FlowSpy, vendidas pela Kiwify, parte por afiliados).
Recebe um JSON com números já calculados e escreve, em português do Brasil, a análise que aparece no topo do painel financeiro para o dono decidir o que fazer.

Regras:
- Use só os números do JSON. Pode calcular diferenças e variações percentuais entre dois números do JSON, mas não invente nenhum dado.
- Escreva valores em reais no formato R$ 12.345,67 e percentuais com vírgula (ex.: +12,3%).
- Diga sempre qual período está comparando (use os rótulos de "periodos").
- Ferramenta que ainda não vendia no período de comparação (ver "ferramentas_inicio") não "cresceu infinito": diga que não há base.
- Causas são hipóteses: escreva "pode ser" ou "vale checar", nunca afirme.
- Seja direto e útil para decisão; nada de frases genéricas.

Formato (texto simples, sem markdown, sem asteriscos, sem tabelas). Cada seção começa com o título em MAIÚSCULAS numa linha própria, seguido de linhas começando com "• ":
RESUMO (3 linhas no máximo: o mais importante agora)
MÊS ATUAL × MÊS ANTERIOR (até o mesmo dia: líquido, vendas, ticket médio, por ferramenta)
MÊS ATUAL × MESMO MÊS DO ANO PASSADO
MÊS FECHADO × MESMO MÊS DO ANO PASSADO (inclua despesas e resultado = líquido − despesas)
ANO ATUAL × ANO PASSADO (até a mesma data; inclua despesas dos meses fechados)
REEMBOLSOS E CHARGEBACKS (quantidade, valor, taxa sobre as vendas e tendência)
AFILIADOS (peso das vendas de afiliados e variação)
PROJEÇÃO DO MÊS (no ritmo atual, comparada ao mês anterior fechado)
O QUE FAZER AGORA (até 4 ações práticas, começando com verbo)`;

async function aiText(facts: unknown): Promise<string | null> {
  const key = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  if (!key) return null;
  const client = new Anthropic({ apiKey: key });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "medium" },
    system: SYSTEM,
    messages: [{ role: "user", content: "Números do painel (JSON):\n" + JSON.stringify(facts) + "\n\nEscreva a análise." }],
  } as any);
  if (res.stop_reason === "refusal") return null;
  const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("").trim();
  return text || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  const who = await caller(req);
  if (!who) return json({ ok: false, error: "unauthorized" }, 401);

  try {
    const { data: facts, error } = await sb.rpc("fin_analysis_facts");
    if (error) throw error;
    let text: string | null = null, source = "regras", model: string | null = null, note: string | null = null;
    try {
      text = await aiText(facts);
      if (text) { source = "ai"; model = MODEL; }
      else note = Deno.env.get("ANTHROPIC_API_KEY") ? "A IA recusou ou não respondeu; ficaram só os números." : "Sem ANTHROPIC_API_KEY: ficaram só os números.";
    } catch (e) {
      note = "Falha na IA: " + String((e as Error)?.message ?? e).slice(0, 200);
    }
    const ins = await sb.from("fin_analyses").insert({ text, source, model, facts, note }).select("id, created_at").single();
    if (ins.error) throw ins.error;
    return json({ ok: true, by: who, source, note, analysis: ins.data });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});
