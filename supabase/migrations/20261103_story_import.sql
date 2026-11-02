-- Stories importados de relatório de insights do Instagram (ex.: o relatório do Tayron de 09/10 a 31/10).
--
-- · source 'import': números já conferidos (status confirmed), vindos dos insights do próprio Instagram.
-- · mention_taps: toques na figurinha de menção @useaflow; link_taps (já existia): cliques no link do story.
-- · story_compare passa a trazer alcance, cliques no link, toques @useaflow e o CTR do link (cliques ÷ alcance).

alter table public.instagram_stories drop constraint if exists instagram_stories_source_chk;
alter table public.instagram_stories add constraint instagram_stories_source_chk check (source in ('api', 'print', 'import'));
alter table public.instagram_stories add column if not exists mention_taps bigint;

-- portal_content: stories trazem os toques @useaflow.
do $patch$
declare src text;
begin
  src := pg_get_functiondef('public.portal_content(text)'::regprocedure);
  src := replace(src, $a$'link_taps', s.link_taps,$a$, $a$'link_taps', s.link_taps, 'mention_taps', s.mention_taps,$a$);
  if src !~ 'mention_taps' then raise exception 'portal_content: trecho não encontrado'; end if;
  execute src;
end $patch$;

-- story_compare com alcance, cliques no link, toques @useaflow e CTR.
create or replace function public.story_compare(p_email text, p_limit integer default 12)
returns jsonb language sql stable security definer set search_path = '' as $$
  with s as (
    select x.*, coalesce(x.story_date, (x.posted_at at time zone 'America/Sao_Paulo')::date) as day,
           public.story_num(x, 'views') as v, public.story_num(x, 'interactions') as i, public.story_num(x, 'replies') as r,
           public.story_num(x, 'shares') as sh, public.story_num(x, 'likes') as l, public.story_num(x, 'profile_activity') as pa,
           public.story_num(x, 'exits') as ex, public.story_num(x, 'taps_forward') as tf, public.story_num(x, 'swipes_forward') as sf,
           x.reach as rc, x.link_taps as lk, x.mention_taps as mt
      from public.instagram_stories x
     where x.affiliate_email = p_email
       and (auth.uid() is null or public.can(array['af.base', 'af.flowinf'])
            or p_email = (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active))
  ), lst as (
    select * from s where v is not null and v > 0 order by day desc, posted_at desc limit greatest(1, least(coalesce(p_limit, 12), 60))
  ), r as (
    select lst.*,
           round(i::numeric / v, 4) as eng_rate, round(r::numeric / v, 4) as reply_rate, round(sh::numeric / v, 4) as share_rate,
           round(ex::numeric / v, 4) as exit_rate, round(lk::numeric / nullif(rc, 0), 4) as ctr,
           rank() over (order by v desc) as rk_views,
           rank() over (order by i desc nulls last) as rk_interactions,
           rank() over (order by r desc nulls last) as rk_replies,
           rank() over (order by sh desc nulls last) as rk_shares,
           rank() over (order by l desc nulls last) as rk_likes,
           rank() over (order by pa desc nulls last) as rk_profile,
           rank() over (order by i::numeric / v desc nulls last) as rk_eng_rate,
           rank() over (order by ex::numeric / v asc nulls last) as rk_exit_rate,
           rank() over (order by rc desc nulls last) as rk_reach,
           rank() over (order by lk desc nulls last) as rk_link,
           rank() over (order by mt desc nulls last) as rk_mention,
           rank() over (order by lk::numeric / nullif(rc, 0) desc nulls last) as rk_ctr,
           count(*) over () as n
      from lst
  )
  select jsonb_build_object(
    'n', coalesce(max(n), 0),
    'has_link', coalesce(bool_or(lk is not null), false),
    'stories', coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'day', day, 'source', source, 'status', status, 'topic', topic, 'topic_guess', ai_read ->> 'topic_guess',
        'tools', (select coalesce(jsonb_agg(t.name order by t.sort_order), '[]'::jsonb) from public.content_tool_tags g join public.tools t on t.id = g.tool_id
                   where g.kind = 'ig_story' and g.content_id = r.id),
        'views', v, 'interactions', i, 'replies', r.r, 'shares', sh, 'likes', l, 'profile_activity', pa, 'exits', ex,
        'taps_forward', tf, 'swipes_forward', sf, 'reach', rc, 'link_taps', lk, 'mention_taps', mt,
        'eng_rate', eng_rate, 'reply_rate', reply_rate, 'share_rate', share_rate, 'exit_rate', exit_rate, 'ctr', ctr,
        'rank', jsonb_build_object('views', rk_views, 'interactions', rk_interactions, 'replies', rk_replies, 'shares', rk_shares,
                                   'likes', rk_likes, 'profile_activity', rk_profile, 'eng_rate', rk_eng_rate, 'exit_rate', rk_exit_rate,
                                   'reach', case when rc is not null then rk_reach end, 'link_taps', case when lk is not null then rk_link end,
                                   'mention_taps', case when mt is not null then rk_mention end, 'ctr', case when lk is not null and rc > 0 then rk_ctr end)
      ) order by day desc, posted_at desc), '[]'::jsonb),
    'averages', jsonb_build_object('views', round(avg(v)), 'interactions', round(avg(i)), 'replies', round(avg(r.r), 1), 'shares', round(avg(sh), 1),
                                   'eng_rate', round(avg(eng_rate), 4), 'exit_rate', round(avg(exit_rate), 4),
                                   'reach', round(avg(rc)), 'link_taps', round(avg(lk), 1), 'mention_taps', round(avg(mt), 1), 'ctr', round(avg(ctr), 4))
  ) from r
$$;

-- Liga as imagens importadas (miniaturas dos stories) ao story; usada pela Edge Function story-prints (service role).
create or replace function public.story_import_image(p_id text, p_path text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.instagram_stories set image_paths = array[p_path], image_path = p_path
   where id = p_id and source = 'import' and split_part(p_path, '/', 1) = md5(affiliate_email);
  if not found then raise exception 'Story importado % não encontrado.', p_id; end if;
  return jsonb_build_object('id', p_id, 'image_path', p_path);
end $$;
revoke all on function public.story_import_image(text, text) from public, anon, authenticated;
grant execute on function public.story_import_image(text, text) to service_role;

-- Caminho da miniatura de um story importado na pasta do afiliado (bucket story-prints).
create or replace function public.story_import_path(p_id text)
returns text language sql stable security definer set search_path = '' as $$
  select md5(affiliate_email) || '/import-' || regexp_replace(id, '[^A-Za-z0-9_-]', '', 'g') || '.jpg'
    from public.instagram_stories where id = p_id and source = 'import'
$$;
revoke all on function public.story_import_path(text) from public, anon, authenticated;
grant execute on function public.story_import_path(text) to service_role;
