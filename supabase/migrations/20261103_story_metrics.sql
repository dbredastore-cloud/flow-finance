-- Métricas dos stories enviados por print: as 10 da tela do Instagram.
--
-- Visualizações, Interações, Atividade do perfil, Curtidas, Respostas, Compartilhamentos e a navegação (Avanço, Saiu,
-- Voltar, Próximo story). O alcance e os toques no link saem do formulário (o Instagram não mostra mais o alcance
-- nessa tela); nos relatórios os stories passam a somar visualizações (story_views), e story_reach continua só para
-- os stories lidos pela API.

alter table public.instagram_stories
  add column if not exists likes            bigint,
  add column if not exists profile_activity bigint;

/* ---------------- confirmação pelo influencer ---------------- */
drop function if exists public.portal_story_confirm(text, date, bigint, bigint, bigint, bigint, bigint, bigint);
-- p_m = {"views":…, "interactions":…, "profile_activity":…, "likes":…, "replies":…, "shares":…,
--        "taps_forward":…, "exits":…, "taps_back":…, "swipes_forward":…} (null no que não houver). Visualizações é obrigatório.
create or replace function public.portal_story_confirm(p_id text, p_day date, p_m jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
  s public.instagram_stories;
  v_at timestamptz;
  k text;
  n bigint;
  m jsonb := '{}';
begin
  if e is null then raise exception 'Só o próprio influencer confirma os stories.'; end if;
  select * into s from public.instagram_stories where id = p_id and affiliate_email = e and source = 'print';
  if s.id is null then raise exception 'Story não encontrado.'; end if;
  if p_day is null or p_day > (now() at time zone 'America/Sao_Paulo')::date then raise exception 'Informe o dia em que o story foi postado.'; end if;
  foreach k in array array['views', 'interactions', 'profile_activity', 'likes', 'replies', 'shares', 'taps_forward', 'exits', 'taps_back', 'swipes_forward'] loop
    n := case when coalesce(p_m ->> k, '') ~ '^\d+$' then (p_m ->> k)::bigint end;
    if coalesce(p_m ->> k, '') <> '' and n is null then raise exception 'Número inválido em %.', k; end if;
    m := m || jsonb_build_object(k, n);
  end loop;
  if m ->> 'views' is null then raise exception 'Informe pelo menos as visualizações.'; end if;
  v_at := (p_day + time '12:00') at time zone 'America/Sao_Paulo';
  update public.instagram_stories
     set story_date = p_day, posted_at = v_at, expires_at = v_at + interval '24 hours',
         views = (m ->> 'views')::bigint, total_interactions = (m ->> 'interactions')::bigint,
         profile_activity = (m ->> 'profile_activity')::bigint, likes = (m ->> 'likes')::bigint,
         replies = (m ->> 'replies')::bigint, shares = (m ->> 'shares')::bigint,
         taps_forward = (m ->> 'taps_forward')::bigint, exits = (m ->> 'exits')::bigint,
         taps_back = (m ->> 'taps_back')::bigint, swipes_forward = (m ->> 'swipes_forward')::bigint,
         status = 'confirmed', confirmed_at = now(), insights_at = now()
   where id = p_id;
  return jsonb_build_object('id', p_id, 'status', 'confirmed');
end $$;
revoke all on function public.portal_story_confirm(text, date, jsonb) from public, anon;
grant execute on function public.portal_story_confirm(text, date, jsonb) to authenticated;

/* ---------------- portal_content traz as métricas novas ---------------- */
do $patch$
declare src text;
begin
  src := pg_get_functiondef('public.portal_content(text)'::regprocedure);
  src := replace(src, $a$'link_taps', s.link_taps,$a$,
    $a$'link_taps', s.link_taps, 'likes', s.likes, 'profile_activity', s.profile_activity, 'taps_forward', s.taps_forward, 'exits', s.exits, 'taps_back', s.taps_back, 'swipes_forward', s.swipes_forward,$a$);
  if src !~ 'swipes_forward' then raise exception 'portal_content: trecho não encontrado'; end if;
  execute src;
end $patch$;

/* ---------------- contagem: visualizações dos stories ---------------- */
drop view if exists public.influencer_content_cycles;
drop function if exists public.content_counts(text, date, date);
create function public.content_counts(p_email text, p_from date, p_to date)
returns table (stories integer, reels integer, youtube integer, feed integer, shorts integer, story_reach bigint, by_tool jsonb, story_views bigint)
language sql stable security definer set search_path = '' as $$
  -- Equipe (menus de afiliados), rotinas do servidor (sem login) ou o próprio afiliado.
  with allowed as (
    select auth.uid() is null or public.can(array['af.base', 'af.flowinf'])
        or p_email = (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active) as ok
  ), items as (
    select 'ig_story'::text as kind, s.id, 'stories'::text as cat, s.reach, s.views, s.status
      from public.instagram_stories s
     where (select ok from allowed) and s.affiliate_email = p_email
       and coalesce(s.story_date, (s.posted_at at time zone 'America/Sao_Paulo')::date) >= p_from
       and coalesce(s.story_date, (s.posted_at at time zone 'America/Sao_Paulo')::date) < p_to
    union all
    select 'ig_media', m.id, case when m.media_product_type = 'REELS' then 'reels' else 'feed' end, null::bigint, null::bigint, null::text
      from public.instagram_media m
     where (select ok from allowed) and m.affiliate_email = p_email
       and (m.posted_at at time zone 'America/Sao_Paulo')::date >= p_from and (m.posted_at at time zone 'America/Sao_Paulo')::date < p_to
    union all
    select 'youtube', v.video_id, case when coalesce(v.is_short, v.duration_s is not null and v.duration_s <= 180) then 'shorts' else 'youtube' end, null::bigint, null::bigint, null::text
      from public.youtube_videos v join public.youtube_channels ch on ch.channel_id = v.channel_id
     where (select ok from allowed) and ch.affiliate_email = p_email
       and (v.published_at at time zone 'America/Sao_Paulo')::date >= p_from and (v.published_at at time zone 'America/Sao_Paulo')::date < p_to
  ), tagged as (
    select i.kind, i.id, i.cat, i.reach, i.views, i.status, t.slug
      from items i
      join public.content_tool_tags g on g.kind = i.kind and g.content_id = i.id
      join public.tools t on t.id = g.tool_id
  ), one as (select distinct kind, id, cat, reach, views, status from tagged)
  select (count(*) filter (where cat = 'stories'))::int,
         (count(*) filter (where cat = 'reels'))::int,
         (count(*) filter (where cat = 'youtube'))::int,
         (count(*) filter (where cat = 'feed'))::int,
         (count(*) filter (where cat = 'shorts'))::int,
         coalesce(sum(reach) filter (where cat = 'stories' and status = 'confirmed'), 0)::bigint,
         coalesce((select jsonb_object_agg(x.slug, x.j) from (
           select slug, jsonb_build_object(
             'stories', count(*) filter (where cat = 'stories'), 'reels', count(*) filter (where cat = 'reels'),
             'youtube', count(*) filter (where cat = 'youtube'), 'feed', count(*) filter (where cat = 'feed'),
             'shorts', count(*) filter (where cat = 'shorts'),
             'story_reach', coalesce(sum(reach) filter (where cat = 'stories' and status = 'confirmed'), 0),
             'story_views', coalesce(sum(views) filter (where cat = 'stories' and status = 'confirmed'), 0)) as j
             from tagged group by slug) x), '{}'::jsonb),
         coalesce(sum(views) filter (where cat = 'stories' and status = 'confirmed'), 0)::bigint
    from one
$$;
revoke all on function public.content_counts(text, date, date) from public, anon;
grant execute on function public.content_counts(text, date, date) to authenticated, service_role;

create view public.influencer_content_cycles with (security_invoker = false) as
  select c.id as contract_id, c.affiliate_email, c.active, k.cycle_no, k.cs as cycle_start, k.w_end as cycle_end, k.ce as next_cycle_start,
         k.is_current, k.closed,
         c.stories_per_month as stories_goal, c.reels_per_month as reels_goal, c.youtube_per_month as youtube_goal,
         cc.stories as stories_tagged, cc.reels as reels_tagged, cc.youtube as youtube_tagged,
         coalesce(d.stories_adj, 0) as stories_adj, coalesce(d.reels_adj, 0) as reels_adj, coalesce(d.youtube_adj, 0) as youtube_adj,
         greatest(0, cc.stories + coalesce(d.stories_adj, 0)) as stories,
         greatest(0, cc.reels + coalesce(d.reels_adj, 0)) as reels,
         greatest(0, cc.youtube + coalesce(d.youtube_adj, 0)) as youtube,
         cc.feed as feed_extra, cc.shorts as shorts_extra, cc.story_reach, cc.by_tool, cc.story_views
    from public.influencer_contracts c
    cross join lateral public.contract_cycles(c.start_date, c.end_date) k
    cross join lateral public.content_counts(c.affiliate_email, k.cs, least(k.ce, coalesce(c.end_date + 1, k.ce))) cc
    left join public.influencer_deliverables d on d.contract_id = c.id
          and d.year = extract(year from k.cs)::int and d.month = extract(month from k.cs)::int
   where auth.uid() is null
      or (select public.can(array['af.base', 'af.flowinf']))
      or c.affiliate_email = (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
revoke all on public.influencer_content_cycles from anon, authenticated;
grant select on public.influencer_content_cycles to authenticated, service_role;

/* ---------------- relatório: visualizações dos stories ---------------- */
do $patch$
declare src text;
begin
  src := pg_get_functiondef('public.influencer_report(text)'::regprocedure);
  src := replace(src, $a$'alcance_stories', m.story_reach,$a$, $a$'alcance_stories', m.story_reach, 'visualizacoes_stories', m.story_views,$a$);
  src := replace(src, $a$'alcance_stories', sum(k.story_reach))$a$, $a$'alcance_stories', sum(k.story_reach), 'visualizacoes_stories', sum(k.story_views))$a$);
  src := replace(src, $a$'alcance_total_stories', (select coalesce(sum(k.story_reach), 0) from public.influencer_content_cycles k where k.contract_id = c.id),$a$,
    $a$'alcance_total_stories', (select coalesce(sum(k.story_reach), 0) from public.influencer_content_cycles k where k.contract_id = c.id),
        'visualizacoes_total_stories', (select coalesce(sum(k.story_views), 0) from public.influencer_content_cycles k where k.contract_id = c.id),$a$);
  if (length(src) - length(replace(src, 'visualizacoes_', ''))) / length('visualizacoes_') <> 3 then raise exception 'influencer_report: trecho não encontrado'; end if;
  execute src;
end $patch$;
