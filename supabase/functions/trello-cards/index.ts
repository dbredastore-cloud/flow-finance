// Cards Trello: lê os boards das ferramentas Flow no Trello e guarda os cards das listas
// "Testes do cliente" e "Em produção" (tabela trello_cards). Para cada card, o Claude classifica
// o tipo de atualização e escreve três textos: resumo para o Daniel, mensagem para o Slack da TB
// e ideias de conteúdo para o Instagram (reels, story, carrossel…).
//
// Ações (POST JSON):
//   { action: "sync", generate?: n }   → lê o Trello; depois gera textos de até n cards sem texto/desatualizados
//   { action: "generate", id, force? } → gera (ou refaz) os textos de um card
//
// Chamado pelo pg_cron (header x-cron-secret) ou pelo painel (JWT de administrador).
//
// Secrets (Supabase → Edge Functions → Secrets):
//   TRELLO_KEY, TRELLO_TOKEN  – https://trello.com/power-ups/admin → API key + token
//   TRELLO_BOARD_IDS          – opcional: ids dos boards separados por vírgula. Sem ele, entram os boards
//                               abertos da conta com "flow" no nome.
//   ANTHROPIC_API_KEY         – opcional (API paga): gera os textos pelo painel. Sem ela, o painel só lê o
//                               Trello e os textos são escritos pelo Claude no chat, direto na coluna ai.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@0.134.0";

const TRELLO = "https://api.trello.com/1";
const MODEL = "claude-opus-5-5";
const MAX_GENERATE = 5; // por chamada de sync, para não estourar o tempo da função

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

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

/* ---------------- Trello ---------------- */
async function trello(path: string, params: Record<string, string | number> = {}) {
  const key = (Deno.env.get("TRELLO_KEY") ?? "").trim();
  const token = (Deno.env.get("TRELLO_TOKEN") ?? "").trim();
  if (!key || !token) throw new Error("Secrets TRELLO_KEY e TRELLO_TOKEN não configurados no Supabase.");
  const url = new URL(TRELLO + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("key", key);
  url.searchParams.set("token", token);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Trello ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// "Testes do cliente" → teste_cliente; "Em produção" → producao; o resto não entra.
function stageOf(listName: string): "teste_cliente" | "producao" | null {
  const n = norm(listName);
  if (n.includes("teste") && n.includes("cliente")) return "teste_cliente";
  if (n.includes("producao")) return "producao";
  return null;
}

function toolOf(boardName: string): string | null {
  const n = norm(boardName).replace(/[^a-z]/g, "");
  if (n.includes("pages")) return "FlowPages";
  if (n.includes("tracking")) return "FlowTracking";
  if (n.includes("spy")) return "FlowSpy";
  return null;
}

async function hash(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function boards(): Promise<{ id: string; name: string }[]> {
  const ids = (Deno.env.get("TRELLO_BOARD_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length) return Promise.all(ids.map((id) => trello(`/boards/${id}`, { fields: "name" })));
  const all = await trello("/members/me/boards", { filter: "open", fields: "name" });
  return all.filter((b: any) => norm(b.name).includes("flow"));
}

async function sync() {
  const now = new Date().toISOString();
  const seen: string[] = [];
  const rows: any[] = [];
  const bs = await boards();
  if (!bs.length) throw new Error("Nenhum board encontrado. Confira TRELLO_BOARD_IDS ou se os boards têm \"Flow\" no nome.");

  for (const b of bs) {
    const lists = (await trello(`/boards/${b.id}/lists`, { filter: "open", fields: "name" }))
      .map((l: any) => ({ ...l, stage: stageOf(l.name) }))
      .filter((l: any) => l.stage);
    if (!lists.length) continue;

    // Quando cada card entrou na lista atual: última movimentação (ou criação) para essa lista.
    const actions = await trello(`/boards/${b.id}/actions`, { filter: "updateCard:idList,createCard", limit: 1000, fields: "date,data,type" });
    const entered = new Map<string, string>();
    for (const a of actions) { // mais recentes primeiro
      const card = a.data?.card?.id, list = a.data?.listAfter?.id ?? a.data?.list?.id;
      if (card && list && !entered.has(card + list)) entered.set(card + list, a.date);
    }

    for (const l of lists) {
      const cards = await trello(`/lists/${l.id}/cards`, {
        fields: "name,desc,due,dueComplete,labels,shortUrl,dateLastActivity,idList", members: "true", member_fields: "fullName",
      });
      for (const c of cards) {
        seen.push(c.id);
        rows.push({
          id: c.id, board_id: b.id, board_name: b.name, tool: toolOf(b.name), list_id: l.id, list_name: l.name, stage: l.stage,
          name: c.name, description: c.desc ?? "",
          labels: (c.labels ?? []).map((x: any) => ({ name: x.name, color: x.color })),
          members: (c.members ?? []).map((m: any) => m.fullName),
          url: c.shortUrl, due: c.due, due_complete: !!c.dueComplete,
          entered_list_at: entered.get(c.id + l.id) ?? null, last_activity: c.dateLastActivity,
          active: true, content_hash: await hash(c.name + "\n" + (c.desc ?? "")), synced_at: now,
        });
      }
    }
  }

  if (rows.length) {
    const { error } = await sb.from("trello_cards").upsert(rows, { onConflict: "id" });
    if (error) throw error;
  }
  // Saiu de "Testes do cliente"/"Em produção" (ou foi arquivado) → some da tela, histórico fica.
  let q = sb.from("trello_cards").update({ active: false }).eq("active", true);
  if (seen.length) q = q.not("id", "in", `(${seen.map((s) => `"${s}"`).join(",")})`);
  const { error } = await q;
  if (error) throw error;
  return { boards: bs.map((b) => b.name), cards: rows.length };
}

/* ---------------- Claude ---------------- */
const TIPOS = ["Nova funcionalidade", "Melhoria", "Correção de bug", "Performance", "Interface / UX", "Integração", "Segurança", "Outro"];

const str = { type: "string" };
const strs = { type: "array", items: str };
const obj = (props: Record<string, unknown>) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });

const SCHEMA = obj({
  tipo: { type: "string", enum: TIPOS },
  titulo: str,
  resumo: obj({ o_que_e: str, beneficio: str, para_quem: str }),
  slack: str,
  instagram: obj({
    ganchos: strs,
    reels: obj({ gancho: str, roteiro: strs, legenda: str }),
    story: obj({ telas: strs, cta: str }),
    carrossel: obj({ slides: strs, legenda: str }),
    outros: strs,
  }),
});

const SYSTEM = `Você trabalha no time da TB Negócios Digitais, que cria as ferramentas Flow para afiliados que anunciam no Google Ads:
- FlowPages: a IA monta presells e páginas de review (benefícios, ingredientes, vídeos) em menos de um minuto, em 16 idiomas; páginas rápidas ajudam a baixar o custo por clique.
- FlowTracking: lucro líquido por campanha em tempo real, receita e custos num só painel, bloqueio de IPs contra cliques fraudulentos e conversões enviadas sozinhas ao Google Ads.
- FlowSpy: descobrir o produto vencedor antes de gastar — nichos em alta, criativos vencedores dos concorrentes e sinais de escala.
Você recebe um card do Trello do time de desenvolvimento e transforma em comunicação. Escreva sempre em português do Brasil.

Regras:
- Baseie-se só no que o card diz. Não invente números, prazos ou funcionalidades que não estão nele. Se o card for vago, seja honesto e genérico em vez de inventar.
- "tipo": a categoria que melhor descreve a atualização.
- "titulo": nome curto e claro da atualização (até 8 palavras), sem jargão técnico.
- "resumo": para o Daniel, de forma clara e objetiva. "o_que_e" em 1 a 3 frases; "beneficio" diz o ganho prático para o usuário da ferramenta; "para_quem" diz quem mais aproveita.
- "slack": mensagem para a equipe da TB no Slack, amigável e humana, como um colega contando uma novidade. Comece com um emoji e uma frase de impacto, explique em poucas linhas o que mudou e por que importa, feche convidando a testar ou a mandar feedback. Use *negrito* do Slack com moderação. Sem hashtags.
- "instagram": ideias para o perfil da ferramenta, falando com afiliados e gestores de tráfego.
  - "ganchos": 5 ganchos fortes para os primeiros segundos/primeira linha (curiosidade, dor, contraste, número, prova).
  - "reels": um gancho, o roteiro em cenas curtas (o que aparece/é dito em cada uma) e a legenda com CTA.
  - "story": sequência de 3 a 5 telas (texto de cada tela, com sugestão de enquete/caixinha quando fizer sentido) e o CTA final.
  - "carrossel": 5 a 8 slides (slide 1 é o gancho, o último é o CTA) e a legenda.
  - "outros": 2 ou 3 ideias de outros formatos (live, post estático, antes e depois, depoimento, tutorial…), uma frase cada.`;

let anthropic: Anthropic | null = null;
function claude() {
  if (!Deno.env.get("ANTHROPIC_API_KEY")) throw new Error("Secret ANTHROPIC_API_KEY não configurado no Supabase.");
  return (anthropic ??= new Anthropic());
}

async function generate(card: any) {
  const labels = (card.labels ?? []).map((l: any) => l.name).filter(Boolean).join(", ");
  const prompt = [
    `Ferramenta: ${card.tool ?? card.board_name}`,
    `Board: ${card.board_name}`,
    `Lista: ${card.list_name}`,
    labels ? `Etiquetas: ${labels}` : "",
    `Título do card: ${card.name}`,
    `Descrição do card:\n${card.description?.trim() || "(sem descrição)"}`,
  ].filter(Boolean).join("\n");

  // Server-side fallback: se o modelo recusar por engano, a API refaz no modelo de reserva.
  const res = await claude().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  } as any);
  if (res.stop_reason === "refusal") throw new Error("O modelo recusou gerar os textos deste card.");
  if (res.stop_reason === "max_tokens") throw new Error("Resposta cortada (limite de tokens).");
  const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return JSON.parse(text);
}

async function generateOne(card: any) {
  try {
    const ai = await generate(card);
    await sb.from("trello_cards").update({ ai, ai_hash: card.content_hash, ai_generated_at: new Date().toISOString(), ai_error: null }).eq("id", card.id);
    return { id: card.id, ok: true, ai };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    await sb.from("trello_cards").update({ ai_error: msg }).eq("id", card.id);
    return { id: card.id, ok: false, error: msg };
  }
}

async function pending(limit: number) {
  const { data, error } = await sb.from("trello_cards").select("*").eq("active", true).order("synced_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).filter((c) => !c.ai || c.ai_hash !== c.content_hash).slice(0, limit);
}

/* ---------------- HTTP ---------------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* corpo vazio */ }

  try {
    if (body.action === "generate") {
      if (typeof body.id !== "string") return json({ error: "id obrigatório" }, 400);
      const { data: card, error } = await sb.from("trello_cards").select("*").eq("id", body.id).maybeSingle();
      if (error) throw error;
      if (!card) return json({ error: "card não encontrado" }, 404);
      if (card.ai && card.ai_hash === card.content_hash && !body.force) return json({ id: card.id, ok: true, ai: card.ai, cached: true });
      const r = await generateOne(card);
      return json(r, r.ok ? 200 : 500);
    }

    const result: Record<string, unknown> = await sync();
    const n = Math.min(Math.max(Number(body.generate) || 0, 0), MAX_GENERATE);
    if (n && Deno.env.get("ANTHROPIC_API_KEY")) {
      const done = [];
      for (const c of await pending(n)) done.push(await generateOne(c));
      result.generated = done.filter((d) => d.ok).length;
      result.failed = done.filter((d) => !d.ok).length;
    }
    result.ok = true;
    result.ai_enabled = !!Deno.env.get("ANTHROPIC_API_KEY");
    await sb.from("sync_state").upsert({ key: "trello_last_run", value: { at: new Date().toISOString(), ...result }, updated_at: new Date().toISOString() });
    return json(result);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await sb.from("sync_state").upsert({ key: "trello_last_run", value: { at: new Date().toISOString(), ok: false, error: msg, ai_enabled: !!Deno.env.get("ANTHROPIC_API_KEY") }, updated_at: new Date().toISOString() });
    return json({ ok: false, error: msg }, 500);
  }
});
