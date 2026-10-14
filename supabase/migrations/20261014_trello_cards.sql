-- Cards Trello (menu do Financeiro): entregas das ferramentas Flow lidas do Trello.
--
-- A Edge Function trello-cards lê os boards, guarda só os cards das listas "Testes do cliente" e
-- "Em produção" e, para cada card, pede ao Claude o tipo de atualização e três textos:
--   resumo (para o Daniel), mensagem para o Slack da TB e ideias de conteúdo para o Instagram.
-- Card que sai dessas listas fica com active = false (o histórico e os textos ficam guardados).

create table if not exists public.trello_cards (
  id              text primary key,                -- id do card no Trello
  board_id        text not null,
  board_name      text not null,
  tool            text,                            -- FlowPages / FlowTracking / FlowSpy (pelo nome do board)
  list_id         text not null,
  list_name       text not null,
  stage           text not null check (stage in ('teste_cliente', 'producao')),
  name            text not null,
  description     text not null default '',
  labels          jsonb not null default '[]'::jsonb,
  members         jsonb not null default '[]'::jsonb,
  url             text,
  due             timestamptz,                     -- data de entrega definida no card
  due_complete    boolean not null default false,
  entered_list_at timestamptz,                     -- quando o card entrou na lista atual
  last_activity   timestamptz,
  active          boolean not null default true,
  content_hash    text,                            -- nome + descrição; muda → textos ficam desatualizados
  ai              jsonb,                           -- { tipo, titulo, resumo, slack, instagram }
  ai_hash         text,                            -- content_hash usado para gerar o ai
  ai_generated_at timestamptz,
  ai_error        text,
  synced_at       timestamptz not null default now()
);
create index if not exists trello_cards_active_idx on public.trello_cards (active, stage, due);

alter table public.trello_cards enable row level security;
drop policy if exists admin_read on public.trello_cards;
create policy admin_read on public.trello_cards for select to authenticated using (public.is_admin());

-- Atualiza do Trello a cada 30 min (e gera os textos dos cards novos, alguns por vez).
select cron.unschedule('trello-cards') where exists (select 1 from cron.job where jobname = 'trello-cards');
select cron.schedule(
  'trello-cards',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/trello-cards',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')
    ),
    body := '{"action":"sync","generate":3}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
