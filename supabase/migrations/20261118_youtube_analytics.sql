-- YouTube dos influencers — tempo assistido (YouTube Analytics API).
--
-- A YouTube Data API (youtube-sync, chave pública) não tem tempo assistido. Esses números são privados do canal e só
-- saem pela YouTube Analytics API com a autorização do dono. O influencer conecta o próprio canal no Portal do Afiliado
-- (botão "Conectar YouTube", login do Google, Edge Function yt-connect, permissão só de leitura yt-analytics.readonly)
-- e a yt-analytics lê a cada 6 h:
--   · por dia do canal: views, minutos assistidos, tempo médio por visualização, % médio assistido, inscritos ganhos/perdidos;
--   · por vídeo (desde a publicação): os mesmos números + curtidas e compartilhamentos;
--   · curva de retenção (em que ponto do vídeo as pessoas saem) dos vídeos recentes e dos marcados com a Flow.
-- O YouTube só entrega médias e totais: não existe o tempo de cada espectador. Os dados chegam com 2 a 3 dias de atraso.
-- O token nunca sai do servidor: youtube_connections e youtube_connect_states não abrem para nenhum login.

create table if not exists public.youtube_connections (
  affiliate_email   text primary key references public.affiliates(email) on update cascade on delete cascade,
  channel_id        text,
  channel_title     text,
  refresh_token     text not null,
  access_token      text,
  access_expires_at timestamptz,
  scopes            text[],
  connected_at      timestamptz not null default now(),
  connected_by      uuid,
  last_sync_at      timestamptz,
  last_full_at      timestamptz,
  status            text not null default 'ok' check (status in ('ok', 'expired', 'error')),
  error             text
);

create table if not exists public.youtube_connect_states (
  state           text primary key,
  affiliate_email text not null references public.affiliates(email) on update cascade on delete cascade,
  user_id         uuid not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '15 minutes'
);

alter table public.youtube_connections enable row level security;
alter table public.youtube_connect_states enable row level security;
revoke all on public.youtube_connections, public.youtube_connect_states from anon, authenticated;

-- Canal por dia (fuso do YouTube: Pacífico).
create table if not exists public.youtube_analytics_daily (
  channel_id          text not null,
  day                 date not null,
  views               bigint,
  minutes_watched     numeric,
  avg_view_s          numeric,   -- tempo médio assistido por visualização (segundos)
  avg_view_pct        numeric,   -- % médio do vídeo assistido (0–100)
  subs_gained         bigint,
  subs_lost           bigint,
  fetched_at          timestamptz not null default now(),
  primary key (channel_id, day)
);

-- Vídeo desde a publicação.
create table if not exists public.youtube_video_analytics (
  video_id            text primary key,
  channel_id          text not null,
  views               bigint,
  minutes_watched     numeric,
  avg_view_s          numeric,
  avg_view_pct        numeric,
  subs_gained         bigint,
  likes               bigint,
  shares              bigint,
  fetched_at          timestamptz not null default now()
);
create index if not exists youtube_video_analytics_channel_idx on public.youtube_video_analytics (channel_id);

-- Curva de retenção: 100 pontos (1% a 100% do vídeo). watch_ratio = parte de quem assistiu que ainda estava no vídeo
-- naquele ponto (pode passar de 1 quando o trecho é revisto); rel_perf = retenção comparada a vídeos de mesma duração
-- no YouTube (0 a 1; 0,5 = na média).
create table if not exists public.youtube_video_retention (
  video_id     text not null,
  x            smallint not null check (x between 0 and 100),
  watch_ratio  numeric,
  rel_perf     numeric,
  primary key (video_id, x)
);
alter table public.youtube_video_analytics add column if not exists retention_at timestamptz;

alter table public.youtube_analytics_daily enable row level security;
alter table public.youtube_video_analytics enable row level security;
alter table public.youtube_video_retention enable row level security;
revoke all on public.youtube_analytics_daily, public.youtube_video_analytics, public.youtube_video_retention from anon, authenticated;
grant select on public.youtube_analytics_daily, public.youtube_video_analytics, public.youtube_video_retention to authenticated;
do $$ declare t text; begin
  foreach t in array array['youtube_analytics_daily', 'youtube_video_analytics', 'youtube_video_retention'] loop
    execute format('drop policy if exists team_read on public.%I', t);
    execute format('create policy team_read on public.%I for select to authenticated using ((select public.can(array[''af.base'', ''af.flowinf'', ''af.overview'', ''af.youtube'', ''af.favoritos''])))', t);
  end loop;
end $$;

-- Situação da conexão para a equipe (sem o token).
create or replace view public.youtube_connections_public with (security_invoker = false) as
  select affiliate_email, channel_id, channel_title, connected_at, last_sync_at, status, error from public.youtube_connections
  where (select public.can(array['af.base', 'af.flowinf', 'af.overview', 'af.youtube', 'af.favoritos']));
revoke all on public.youtube_connections_public from anon, authenticated;
grant select on public.youtube_connections_public to authenticated;

/* ---------------- portal_youtube: canal + conexão + tempo assistido ----------------
   Agora devolve o objeto também sem canal lido (para o portal mostrar o botão "Conectar YouTube"). */
create or replace function public.portal_youtube(p_email text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e text := public.portal_target(p_email);
  ch public.youtube_channels;
  c public.youtube_connections;
  cid text;
begin
  if e is null then return null; end if;
  select * into ch from public.youtube_channels where affiliate_email = e;
  select * into c from public.youtube_connections where affiliate_email = e;
  cid := coalesce(c.channel_id, ch.channel_id);
  return jsonb_build_object(
    'channel', case when ch.channel_id is null then null else jsonb_build_object('channel_id', ch.channel_id, 'title', ch.title, 'handle', ch.handle, 'thumbnail_url', ch.thumbnail_url,
      'country', ch.country, 'channel_created', ch.channel_created, 'subscribers', ch.subscribers, 'hidden_subs', ch.hidden_subs,
      'total_views', ch.total_views, 'video_count', ch.video_count, 'fetched_at', ch.fetched_at, 'description', ch.description) end,
    'connection', case when c.affiliate_email is null then null else jsonb_build_object('channel_id', c.channel_id, 'channel_title', c.channel_title,
      'connected_at', c.connected_at, 'last_sync_at', c.last_sync_at, 'status', c.status, 'error', c.error) end,
    'videos', coalesce((select jsonb_agg(to_jsonb(v) order by v.published_at desc) from (
        select y.video_id, y.title, y.published_at, y.duration_s, y.views, y.likes, y.comments, y.thumbnail_url, y.is_short, y.description, y.tags,
               (select coalesce(jsonb_agg(t.slug order by t.sort_order), '[]'::jsonb)
                  from public.content_tool_tags g join public.tools t on t.id = g.tool_id
                 where g.kind = 'youtube' and g.content_id = y.video_id) as flow_tools
          from public.youtube_videos y where ch.channel_id is not null and y.channel_id = ch.channel_id order by y.published_at desc limit 600) v), '[]'::jsonb),
    'snaps', coalesce((select jsonb_agg(jsonb_build_object('day', sn.day, 'subscribers', sn.subscribers, 'total_views', sn.total_views,
        'video_count', sn.video_count, 'taken_at', sn.taken_at) order by sn.day)
      from public.youtube_channel_snapshots sn where ch.channel_id is not null and sn.channel_id = ch.channel_id), '[]'::jsonb),
    'yta', case when cid is null then null else jsonb_build_object(
      'daily', coalesce((select jsonb_agg(to_jsonb(d) - 'channel_id' - 'fetched_at' order by d.day)
          from public.youtube_analytics_daily d where d.channel_id = cid and d.day > current_date - 400), '[]'::jsonb),
      'videos', coalesce((select jsonb_agg(to_jsonb(va) - 'channel_id')
          from public.youtube_video_analytics va where va.channel_id = cid), '[]'::jsonb),
      'retention', coalesce((select jsonb_object_agg(r.video_id, r.pts) from (
          select vr.video_id, jsonb_agg(jsonb_build_array(vr.x, vr.watch_ratio, vr.rel_perf) order by vr.x) as pts
            from public.youtube_video_retention vr join public.youtube_video_analytics va on va.video_id = vr.video_id
           where va.channel_id = cid group by vr.video_id) r), '{}'::jsonb)
    ) end
  );
end $$;
revoke all on function public.portal_youtube(text) from public, anon;
grant execute on function public.portal_youtube(text) to authenticated;

-- Rodada a cada 6 h (os números do YouTube Analytics mudam devagar e chegam com atraso).
select cron.unschedule('yt-analytics') where exists (select 1 from cron.job where jobname = 'yt-analytics');
select cron.schedule('yt-analytics', '23 */6 * * *', $cron$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/yt-analytics',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$cron$);
