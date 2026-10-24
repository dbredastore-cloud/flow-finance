-- Stories do Instagram da Flow (@useaflow).
--
-- A Meta só entrega um story (e as métricas dele) nas 24 h em que ele está no ar. A Edge Function
-- instagram-stories roda de hora em hora, guarda cada story e atualiza as métricas a cada leitura; quando ele
-- sai do ar, a última leitura fica como a final (final = true). Cada leitura também vai para ig_story_snapshots,
-- para ver como o story evoluiu ao longo do dia.
-- Métricas (Graph API, login com Facebook): alcance, visualizações, respostas, compartilhamentos, interações,
-- seguidores ganhos, visitas e atividade no perfil, e a navegação (avançou, voltou, saiu, pulou para a próxima conta).
-- O que a Meta não entrega por API: votos de enquete, perguntas da caixinha e o texto das respostas (Direct).

create table if not exists public.ig_stories (
  id                 text primary key,
  ig_user_id         text,
  media_type         text,          -- IMAGE ou VIDEO
  caption            text,
  permalink          text,
  posted_at          timestamptz not null,
  expires_at         timestamptz not null,
  reach              bigint,
  views              bigint,
  replies            bigint,
  shares             bigint,
  total_interactions bigint,
  follows            bigint,
  profile_visits     bigint,
  profile_activity   bigint,
  navigation         bigint,        -- total de ações de navegação
  taps_forward       bigint,
  taps_back          bigint,
  exits              bigint,
  swipes_forward     bigint,
  insights_note      text,          -- ex.: menos de 5 contas viram, a Meta ainda não mostra
  first_seen_at      timestamptz not null default now(),
  insights_at        timestamptz,
  final              boolean not null default false
);
create index if not exists ig_stories_posted_idx on public.ig_stories (posted_at desc);

create table if not exists public.ig_story_snapshots (
  story_id  text not null references public.ig_stories(id) on delete cascade,
  taken_at  timestamptz not null default now(),
  metrics   jsonb not null,
  primary key (story_id, taken_at)
);

alter table public.ig_stories enable row level security;
alter table public.ig_story_snapshots enable row level security;
revoke all on public.ig_stories, public.ig_story_snapshots from anon, authenticated;
grant select on public.ig_stories, public.ig_story_snapshots to authenticated;
drop policy if exists menu_read on public.ig_stories;
drop policy if exists menu_read on public.ig_story_snapshots;
create policy menu_read on public.ig_stories for select to authenticated using ((select public.can(array['fin.instagram'])));
create policy menu_read on public.ig_story_snapshots for select to authenticated using ((select public.can(array['fin.instagram'])));

-- Rodada de hora em hora (mesmo segredo dos outros syncs).
select cron.unschedule('instagram-stories') where exists (select 1 from cron.job where jobname = 'instagram-stories');
select cron.schedule('instagram-stories', '17 * * * *', $cron$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/instagram-stories',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$cron$);
