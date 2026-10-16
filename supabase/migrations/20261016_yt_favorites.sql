-- Canais favoritos (menu Afiliados → Canais favoritos): youtubers marcados com ★ no YouTube ou no Rastrear Mercado
-- (ou colados pelo link) para acompanhar de perto. Guarda a data em que a Flow liberou o acesso às ferramentas;
-- o resumo conta, desde essa data, quantos vídeos o canal publicou e quantos citam FlowPages, FlowTracking ou FlowSpy.
-- Vídeos e a foto diária do canal reaproveitam youtube_videos e youtube_channel_snapshots (chave = channel_id),
-- preenchidos pela Edge Function youtube-sync (cron a cada 6 h e ao favoritar).

create table if not exists public.yt_favorites (
  channel_id      text primary key check (channel_id ~ '^UC[\w-]{20,24}$'),
  title           text,
  handle          text,
  thumbnail_url   text,
  banner_url      text,
  country         text,
  description     text,
  channel_created timestamptz,
  subscribers     bigint,
  hidden_subs     boolean not null default false,
  total_views     bigint,
  video_count     integer,
  source          text not null default 'manual' check (source in ('youtube', 'mercado', 'manual')),
  affiliate_email text,                 -- quando o canal é de um influencer da base
  access_at       date,                 -- dia em que a Flow liberou o acesso às ferramentas (null = ainda não liberou)
  notes           text,
  added_by        uuid default auth.uid(),
  added_at        timestamptz not null default now(),
  fetched_at      timestamptz,
  error           text
);

alter table public.yt_favorites enable row level security;
revoke all on public.yt_favorites from anon;
grant select, insert, update, delete on public.yt_favorites to authenticated;

-- Quem favorita pelo YouTube ou pelo Rastrear Mercado também precisa ler/gravar a estrela.
drop policy if exists fav_read on public.yt_favorites;
drop policy if exists fav_write on public.yt_favorites;
create policy fav_read on public.yt_favorites for select to authenticated
  using ((select public.can(array['af.favoritos', 'af.youtube', 'af.mercado'])));
create policy fav_write on public.yt_favorites for all to authenticated
  using ((select public.can(array['af.favoritos', 'af.youtube', 'af.mercado'])))
  with check ((select public.can(array['af.favoritos', 'af.youtube', 'af.mercado'])));

-- O novo menu também lê os vídeos e o histórico diário dos canais.
alter policy admin_read on public.youtube_videos using ((select public.can(array['af.overview','af.base','af.flowinf','af.products','af.youtube','af.mercado','af.favoritos'])));
alter policy admin_read on public.youtube_channel_snapshots using ((select public.can(array['af.overview','af.base','af.flowinf','af.products','af.youtube','af.mercado','af.favoritos'])));
alter policy admin_read on public.youtube_channels using ((select public.can(array['af.overview','af.base','af.flowinf','af.products','af.youtube','af.mercado','af.favoritos'])));

-- Mesmo critério do painel (assets/influencer-dash.js): o nome da ferramenta escrito no título ou na descrição.
create or replace function public.flow_tool_hits(p_text text)
returns text[] language sql immutable set search_path = '' as $$
  select array_remove(array[
    case when p_text ~* '(^|[^a-z])flow[\s_.-]*pages?([^a-z]|$)' then 'FlowPages' end,
    case when p_text ~* '(^|[^a-z])flow[\s_.-]*track(ing)?([^a-z]|$)' then 'FlowTracking' end,
    case when p_text ~* '(^|[^a-z])flow[\s_.-]*spy([^a-z]|$)' then 'FlowSpy' end
  ], null)
$$;

-- Resumo de cada favorito para a lista do painel (sem baixar as descrições dos vídeos).
-- "desde" = data do acesso liberado; sem data, conta desde que o canal foi favoritado.
create or replace view public.yt_favorites_summary with (security_invoker = true) as
with v as (
  select f.channel_id, y.published_at, y.views, y.is_short, y.duration_s,
         public.flow_tool_hits(coalesce(y.title, '') || ' ' || coalesce(y.description, '')) as hits,
         y.published_at >= coalesce(f.access_at::timestamp at time zone 'America/Sao_Paulo', f.added_at) as after
    from public.yt_favorites f
    join public.youtube_videos y on y.channel_id = f.channel_id
)
select f.*,
       coalesce(s.videos_after, 0)      as videos_after,
       coalesce(s.shorts_after, 0)      as shorts_after,
       coalesce(s.views_after, 0)       as views_after,
       coalesce(s.flow_after, 0)        as flow_after,
       coalesce(s.pages_after, 0)       as pages_after,
       coalesce(s.tracking_after, 0)    as tracking_after,
       coalesce(s.spy_after, 0)         as spy_after,
       coalesce(s.flow_views_after, 0)  as flow_views_after,
       coalesce(s.flow_before, 0)       as flow_before,
       coalesce(s.videos_total, 0)      as videos_total,
       s.last_video_at, s.last_flow_at, s.oldest_video_at,
       (select sn.subscribers from public.youtube_channel_snapshots sn
         where sn.channel_id = f.channel_id order by sn.day limit 1) as first_subscribers,
       (select sn.day from public.youtube_channel_snapshots sn
         where sn.channel_id = f.channel_id order by sn.day limit 1) as first_snapshot_day
  from public.yt_favorites f
  left join lateral (
    select count(*) filter (where after)                                                   as videos_after,
           count(*) filter (where after and coalesce(is_short, duration_s <= 180))         as shorts_after,
           sum(views) filter (where after)                                                 as views_after,
           count(*) filter (where after and cardinality(hits) > 0)                         as flow_after,
           count(*) filter (where after and 'FlowPages' = any(hits))                       as pages_after,
           count(*) filter (where after and 'FlowTracking' = any(hits))                    as tracking_after,
           count(*) filter (where after and 'FlowSpy' = any(hits))                         as spy_after,
           sum(views) filter (where after and cardinality(hits) > 0)                       as flow_views_after,
           count(*) filter (where not after and cardinality(hits) > 0)                     as flow_before,
           count(*)                                                                        as videos_total,
           max(published_at)                                                               as last_video_at,
           max(published_at) filter (where cardinality(hits) > 0)                          as last_flow_at,
           min(published_at)                                                               as oldest_video_at
      from v where v.channel_id = f.channel_id
  ) s on true;

revoke all on public.yt_favorites_summary from anon;
grant select on public.yt_favorites_summary to authenticated;
