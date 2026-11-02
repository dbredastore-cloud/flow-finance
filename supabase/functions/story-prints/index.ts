// Prints dos stories dos influencers para a tarefa agendada do Claude "Leitura dos prints de stories" (sem API paga).
//
// O influencer sobe o print no Portal do Afiliado (bucket privado story-prints, pasta dele) e o story entra como
// "aguardando leitura". A tarefa pede um passe pelo conector do Supabase (select public.story_reader_ticket(), vale
// 15 min), chama esta função com ele e recebe links assinados (10 min) das imagens pendentes. Ela lê cada print e
// grava os números com public.story_print_read; o influencer confere e confirma no portal.
//
//   POST { action: "pending", limit?: n }   header x-story-ticket  → { stories: [{ id, day, urls: [...], affiliate }] }
//   Cada story tem de 1 a 3 prints (a tela de métricas do Instagram pode não caber num só): leia todos juntos.
//
// Sem JWT no gateway (verify_jwt = false): a função confere o passe aqui dentro. Não devolve e-mail nem dado de cliente.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-story-ticket",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "use POST" }, 405);
  const ticket = (req.headers.get("x-story-ticket") ?? "").trim();
  if (!ticket) return json({ ok: false, error: "sem passe" }, 401);
  const { data: ok } = await sb.rpc("story_reader_ticket_ok", { p_ticket: ticket });
  if (ok !== true) return json({ ok: false, error: "passe inválido ou vencido" }, 401);

  const body = await req.json().catch(() => ({}));
  if (body.action !== "pending") return json({ ok: false, error: "ação desconhecida" }, 400);
  const limit = Math.min(Math.max(Number(body.limit) || 30, 1), 60);

  const { data: rows, error } = await sb.from("instagram_stories")
    .select("id, story_date, image_path, image_paths, affiliate_email")
    .eq("source", "print").eq("status", "reading").not("image_path", "is", null)
    .order("first_seen_at").limit(limit);
  if (error) return json({ ok: false, error: error.message }, 500);

  // Nome do influencer só para o resumo da tarefa (o e-mail não sai daqui).
  const emails = [...new Set((rows ?? []).map((r) => r.affiliate_email))];
  const names: Record<string, string> = {};
  if (emails.length) {
    const { data: af } = await sb.from("affiliates").select("email, name").in("email", emails);
    for (const a of af ?? []) names[a.email] = (a.name || "").trim() || "influencer";
  }

  const stories = [];
  for (const r of rows ?? []) {
    const paths: string[] = r.image_paths?.length ? r.image_paths : [r.image_path];
    const urls = [];
    for (const p of paths) {
      const { data: signed } = await sb.storage.from("story-prints").createSignedUrl(p, 600);
      if (signed?.signedUrl) urls.push(signed.signedUrl);
    }
    stories.push({ id: r.id, day: r.story_date, affiliate: names[r.affiliate_email] ?? "influencer", urls });
  }
  return json({ ok: true, stories });
});
