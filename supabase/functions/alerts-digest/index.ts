// Resumo dos avisos: roda as regras (public.generate_alerts), pega os avisos abertos e pede ao Claude (Haiku) um texto
// curto em português para quem gerencia a Flow. Guarda em alert_digests (a tela Avisos mostra o último) e, se pedido,
// manda no Telegram.
//
// Chamado pelo pg_cron todo dia às 8h de Brasília (header x-cron-secret, body {"telegram": true}) ou pelo botão
// "Gerar resumo agora" da tela Avisos (JWT de quem tem o menu fin.avisos; body {"telegram": false|true}).
//
// A IA só escreve sobre números já calculados pelas regras do banco; ela não faz contas nem lê vendas.
// Sem API paga: a tarefa agendada "Análise e Avisos FlowFinance" do Claude escreve o resumo antes das 8h (source 'claude')
// e o envio das 8h manda esse texto no Telegram.
// Secrets: ANTHROPIC_API_KEY (opcional; sem ela e sem o texto do Claude, o resumo sai montado pelas próprias regras),
//          TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID (opcionais, os mesmos do aviso de login).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

type Alert = { category: string; severity: string; title: string; body: string | null; sort: number; first_seen_at: string; seen_at: string | null };

const SEV = { critical: "CRÍTICO", warning: "ATENÇÃO", info: "INFO", good: "BOM" } as Record<string, string>;
const CAT = { faturamento: "Faturamento", reembolsos: "Reembolsos e chargebacks", afiliados: "Afiliados", influencers: "Influencers", instagram: "Instagram", sistema: "Sistema" } as Record<string, string>;
const RANK = { critical: 0, warning: 1, good: 2, info: 3 } as Record<string, number>;

async function caller(req: Request): Promise<"cron" | "user" | null> {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) { const { data } = await sb.rpc("verify_sync_secret", { secret: cronSecret }); return data === true ? "cron" : null; }
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: a } = await sb.from("app_admins").select("role, menus").eq("user_id", data.user.id).maybeSingle();
  return a && (a.role === "admin" || (a.menus ?? []).includes("fin.avisos")) ? "user" : null;
}

// Lista dos avisos em texto simples (vai para a IA e serve de resumo quando não há IA).
function listing(alerts: Alert[]): string {
  const byCat: Record<string, Alert[]> = {};
  for (const a of alerts) (byCat[a.category] ??= []).push(a);
  return Object.keys(CAT).filter((c) => byCat[c]).map((c) =>
    `${CAT[c]}:\n` + byCat[c].map((a) => `- [${SEV[a.severity] ?? a.severity}] ${a.title}${a.body ? ` — ${a.body}` : ""}`).join("\n")
  ).join("\n\n");
}

function plainDigest(alerts: Alert[]): string {
  const crit = alerts.filter((a) => a.severity === "critical").length, warn = alerts.filter((a) => a.severity === "warning").length;
  const head = crit || warn ? `${crit} críticos e ${warn} de atenção.` : "Nada crítico hoje.";
  return `${head}\n\n${listing(alerts)}`;
}

const SYSTEM = `Você escreve o resumo diário de avisos do painel FlowFinance da Flow (ferramentas SaaS FlowPages, FlowTracking e FlowSpy, vendidas pela Kiwify com afiliados e influencers contratados).
Quem lê é o dono do negócio, no celular (Telegram), em português do Brasil.
Regras:
- Use só os números da lista de avisos. Não calcule números novos, não invente causas; se sugerir uma causa, diga que é hipótese.
- Comece pelo que exige ação hoje (críticos e atenção), depois o que vai bem, em no máximo 12 linhas curtas.
- Agrupe por assunto. Cite nomes de influencers e afiliados quando o aviso trouxer.
- Feche com até 3 ações práticas para hoje, começando com verbo.
- Texto simples: sem markdown, sem asteriscos, sem tabelas. Pode usar "•" no começo das linhas.`;

async function aiDigest(alerts: Alert[], today: string): Promise<{ text: string; model: string } | null> {
  const key = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  if (!key) return null;
  const client = new Anthropic({ apiKey: key });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low" },
    system: SYSTEM,
    messages: [{ role: "user", content: `Hoje é ${today}. Avisos abertos no painel:\n\n${listing(alerts)}\n\nEscreva o resumo.` }],
  } as any);
  if (res.stop_reason === "refusal") return null;
  const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("").trim();
  return text ? { text, model: MODEL } : null;
}

async function telegram(text: string): Promise<boolean> {
  const token = (Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "").trim();
  const chat = (Deno.env.get("TELEGRAM_CHAT_ID") ?? "").trim();
  if (!token || !chat) return false;
  // Limite do Telegram: 4096 caracteres por mensagem.
  const body = text.length > 4000 ? text.slice(0, 3990) + "\n…" : text;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: body, disable_web_page_preview: true }),
  });
  await r.body?.cancel();
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  const who = await caller(req);
  if (!who) return json({ ok: false, error: "unauthorized" }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* sem corpo */ }

  try {
    const gen = await sb.rpc("generate_alerts");
    if (gen.error) throw gen.error;
    const { data, error } = await sb.from("alerts").select("category, severity, title, body, sort, first_seen_at, seen_at").is("resolved_at", null);
    if (error) throw error;
    const alerts = (data ?? []) as Alert[];
    alerts.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || a.sort - b.sort);

    const today = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "long" });
    let text = "", source = "regras", model: string | null = null, note: string | null = null;
    if (!alerts.length) text = "Nenhum aviso aberto. Tudo dentro do esperado.";
    else {
      try {
        const ai = await aiDigest(alerts, today);
        if (ai) { text = ai.text; source = "ai"; model = ai.model; }
        else note = Deno.env.get("ANTHROPIC_API_KEY") ? "A IA recusou ou não respondeu; resumo montado pelas regras." : "Sem ANTHROPIC_API_KEY; resumo montado pelas regras.";
      } catch (e) {
        note = "Falha na IA: " + String((e as Error)?.message ?? e).slice(0, 200);
      }
      if (!text) text = plainDigest(alerts);
    }

    const sendTg = body?.telegram === true;
    const header = `Avisos FlowFinance · ${today}\n\n`;

    // Sem API paga: a tarefa agendada do Claude (app do Claude no computador, ~7h40) grava o resumo com source 'claude'.
    // Se ele foi escrito nas últimas 6 h, é esse que vai para o Telegram, no lugar do montado pelas regras.
    if (source !== "ai" && sendTg) {
      const { data: cl } = await sb.from("alert_digests").select("id, text, created_at").eq("source", "claude")
        .gte("created_at", new Date(Date.now() - 6 * 3600e3).toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (cl?.text) {
        const ok = await telegram(header + cl.text + "\n\nPainel: https://gestorflowtools.shop/financeiro/");
        await sb.from("alert_digests").update({ telegram: ok, note: ok ? null : "Telegram não enviado (confira TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID)." }).eq("id", cl.id);
        return json({ ok: true, by: who, source: "claude", alerts: alerts.length, telegram: ok, digest: { id: cl.id, created_at: cl.created_at } });
      }
    }
    const sent = sendTg ? await telegram(header + text + "\n\nPainel: https://gestorflowtools.shop/financeiro/") : false;
    if (sendTg && !sent) note = [note, "Telegram não enviado (confira TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID)."].filter(Boolean).join(" ");

    const ins = await sb.from("alert_digests").insert({ text, source, model, alerts_count: alerts.length, telegram: sent, note }).select("id, created_at").single();
    if (ins.error) throw ins.error;
    return json({ ok: true, by: who, source, alerts: alerts.length, telegram: sent, note, digest: ins.data });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});
