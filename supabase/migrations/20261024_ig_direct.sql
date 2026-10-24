-- Direct do @useaflow: conversas e mensagens lidas pela API de mensagens do Instagram (Graph API, login com
-- Facebook, token com instagram_manage_messages). A Edge Function instagram-dm grava; o menu @useaflow lê.
-- Respostas a stories chegam como mensagem com story_url. Perguntas da caixinha e votos de enquete não são mensagens
-- e continuam fora da API.
-- A Meta só entrega as mensagens mais recentes de cada conversa (cerca de 20 por conversa); o painel guarda tudo o
-- que já leu, então o histórico cresce a partir de agora.

create table if not exists public.ig_conversations (
  id            text primary key,
  user_id       text,            -- id (IGSID) de quem conversa com a Flow
  username      text,
  updated_at    timestamptz,
  fetched_at    timestamptz not null default now()
);

create table if not exists public.ig_messages (
  id              text primary key,
  conversation_id text not null references public.ig_conversations(id) on delete cascade,
  from_id         text,
  from_username   text,
  from_business   boolean not null default false,  -- mensagem enviada pela própria Flow
  text            text,
  story_url       text,          -- resposta ou menção a um story
  attachment      text,          -- tipo do anexo (image, video, audio, share…)
  created_at      timestamptz,
  fetched_at      timestamptz not null default now()
);
create index if not exists ig_messages_conv_idx on public.ig_messages (conversation_id, created_at desc);
create index if not exists ig_messages_created_idx on public.ig_messages (created_at desc);

-- Pedidos vindos do Direct entram nas Ideias com o id da mensagem (único), como os comentários.
alter table public.user_ideas add column if not exists ig_message_id text unique;

alter table public.ig_conversations enable row level security;
alter table public.ig_messages enable row level security;
revoke all on public.ig_conversations, public.ig_messages from anon, authenticated;
grant select on public.ig_conversations, public.ig_messages to authenticated;
do $$ declare t text; begin
  foreach t in array array['ig_conversations', 'ig_messages'] loop
    execute format('drop policy if exists menu_read on public.%I', t);
    execute format('create policy menu_read on public.%I for select to authenticated using ((select public.can(array[''fin.instagram''])))', t);
  end loop;
end $$;

-- Rodada de hora em hora (mesmo segredo dos outros syncs).
select cron.unschedule('instagram-dm') where exists (select 1 from cron.job where jobname = 'instagram-dm');
select cron.schedule('instagram-dm', '47 * * * *', $cron$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/instagram-dm',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$cron$);
