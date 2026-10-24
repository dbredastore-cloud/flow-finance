-- Instagram da Flow (@useaflow): posts, reels, comentários e o resumo diário da conta, lidos pela Graph API
-- (login com Facebook) pela Edge Function instagram-own a cada 6 h. Os stories ficam em ig_stories (instagram-stories,
-- de hora em hora). O menu Instagram do Financeiro lê estas tabelas (menu fin.instagram).

-- Cada post, carrossel e reel com as métricas da última leitura. A Meta mede coisas diferentes por formato:
-- seguidores ganhos e visitas ao perfil só no feed; tempo assistido e pulos só em reels.
create table if not exists public.ig_media (
  id                 text primary key,
  media_type         text,          -- IMAGE, VIDEO, CAROUSEL_ALBUM
  media_product_type text,          -- FEED, REELS
  caption            text,
  permalink          text,
  thumbnail_url      text,
  posted_at          timestamptz,
  like_count         bigint,
  comments_count     bigint,
  reach              bigint,
  views              bigint,
  saved              bigint,
  shares             bigint,
  total_interactions bigint,
  follows            bigint,
  profile_visits     bigint,
  profile_activity   bigint,
  avg_watch_ms       bigint,
  total_watch_ms     bigint,
  skip_rate          numeric,       -- 0 a 1: parcela de views que pulou nos 3 primeiros segundos
  insights_note      text,
  insights_at        timestamptz,
  fetched_at         timestamptz not null default now()
);
create index if not exists ig_media_posted_idx on public.ig_media (posted_at desc);

create table if not exists public.ig_comments (
  id          text primary key,
  media_id    text references public.ig_media(id) on delete cascade,
  parent_id   text,                 -- resposta a outro comentário
  username    text,
  text        text,
  like_count  bigint,
  posted_at   timestamptz,
  fetched_at  timestamptz not null default now()
);
create index if not exists ig_comments_posted_idx on public.ig_comments (posted_at desc);

-- Resumo da conta por dia (horário da Meta, Pacífico). Seguidores e nº de posts são a foto do dia da leitura.
create table if not exists public.ig_account_daily (
  day                date primary key,
  followers_count    bigint,
  media_count        integer,
  new_followers      bigint,
  reach              bigint,
  views              bigint,
  accounts_engaged   bigint,
  total_interactions bigint,
  likes              bigint,
  comments           bigint,
  shares             bigint,
  saves              bigint,
  replies            bigint,
  profile_links_taps bigint,
  fetched_at         timestamptz not null default now()
);

alter table public.ig_media enable row level security;
alter table public.ig_comments enable row level security;
alter table public.ig_account_daily enable row level security;
revoke all on public.ig_media, public.ig_comments, public.ig_account_daily from anon, authenticated;
grant select on public.ig_media, public.ig_comments, public.ig_account_daily to authenticated;
do $$ declare t text; begin
  foreach t in array array['ig_media', 'ig_comments', 'ig_account_daily'] loop
    execute format('drop policy if exists menu_read on public.%I', t);
    execute format('create policy menu_read on public.%I for select to authenticated using ((select public.can(array[''fin.instagram''])))', t);
  end loop;
end $$;

-- Rodada a cada 6 h (mesmo segredo dos outros syncs).
select cron.unschedule('instagram-own') where exists (select 1 from cron.job where jobname = 'instagram-own');
select cron.schedule('instagram-own', '27 */6 * * *', $cron$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/instagram-own',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$cron$);
