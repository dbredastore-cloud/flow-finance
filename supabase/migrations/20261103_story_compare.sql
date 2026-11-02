-- Comparação dos stories de cada influencer: qual teve mais engajamento, respostas, compartilhamentos.
--
-- · topic: sobre o que foi o story (o influencer escreve no envio ou depois; a leitura do print sugere em ai_read.topic_guess).
-- · story_compare: os últimos 12 stories do influencer com números (os confirmados ou, antes disso, os lidos do print),
--   as taxas sobre as visualizações e a posição de cada um em cada métrica. É calculada na hora: o Portal e o painel
--   mostram o ranking sempre atualizado.
-- · ai_insight: análise escrita pela tarefa "Leitura dos prints de stories" a cada leitura, comparando o story com os
--   últimos (o que foi melhor, em quê, e qual assunto vale repetir).

alter table public.instagram_stories
  add column if not exists topic         text,
  add column if not exists ai_insight    text,
  add column if not exists ai_insight_at timestamptz;

-- Números de um story: os confirmados; enquanto não confirmar, os lidos do print.
create or replace function public.story_num(s public.instagram_stories, k text)
returns bigint language sql immutable set search_path = '' as $$
  select coalesce(
    case k when 'views' then s.views when 'interactions' then s.total_interactions when 'profile_activity' then s.profile_activity
           when 'likes' then s.likes when 'replies' then s.replies when 'shares' then s.shares when 'taps_forward' then s.taps_forward
           when 'exits' then s.exits when 'taps_back' then s.taps_back when 'swipes_forward' then s.swipes_forward end,
    case when s.status <> 'confirmed' and coalesce(s.ai_read ->> k, '') ~ '^\d+$' then (s.ai_read ->> k)::bigint end)
$$;

-- Últimos p_limit stories do afiliado com visualizações, com taxas e posições (1 = melhor; em "saiu", menor é melhor).
create or replace function public.story_compare(p_email text, p_limit integer default 12)
returns jsonb language sql stable security definer set search_path = '' as $$
  with s as (
    select x.*, coalesce(x.story_date, (x.posted_at at time zone 'America/Sao_Paulo')::date) as day,
           public.story_num(x, 'views') as v, public.story_num(x, 'interactions') as i, public.story_num(x, 'replies') as r,
           public.story_num(x, 'shares') as sh, public.story_num(x, 'likes') as l, public.story_num(x, 'profile_activity') as pa,
           public.story_num(x, 'exits') as ex, public.story_num(x, 'taps_forward') as tf, public.story_num(x, 'swipes_forward') as sf
      from public.instagram_stories x
     where x.affiliate_email = p_email
       and (auth.uid() is null or public.can(array['af.base', 'af.flowinf'])
            or p_email = (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active))
  ), lst as (
    select * from s where v is not null and v > 0 order by day desc, posted_at desc limit greatest(1, least(coalesce(p_limit, 12), 60))
  ), r as (
    select lst.*,
           round(i::numeric / v, 4) as eng_rate, round(r::numeric / v, 4) as reply_rate, round(sh::numeric / v, 4) as share_rate,
           round(ex::numeric / v, 4) as exit_rate,
           rank() over (order by v desc) as rk_views,
           rank() over (order by i desc nulls last) as rk_interactions,
           rank() over (order by r desc nulls last) as rk_replies,
           rank() over (order by sh desc nulls last) as rk_shares,
           rank() over (order by l desc nulls last) as rk_likes,
           rank() over (order by pa desc nulls last) as rk_profile,
           rank() over (order by i::numeric / v desc nulls last) as rk_eng_rate,
           rank() over (order by ex::numeric / v asc nulls last) as rk_exit_rate,
           count(*) over () as n
      from lst
  )
  select jsonb_build_object(
    'n', coalesce(max(n), 0),
    'stories', coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'day', day, 'source', source, 'status', status, 'topic', topic, 'topic_guess', ai_read ->> 'topic_guess',
        'tools', (select coalesce(jsonb_agg(t.name order by t.sort_order), '[]'::jsonb) from public.content_tool_tags g join public.tools t on t.id = g.tool_id
                   where g.kind = 'ig_story' and g.content_id = r.id),
        'views', v, 'interactions', i, 'replies', r.r, 'shares', sh, 'likes', l, 'profile_activity', pa, 'exits', ex,
        'taps_forward', tf, 'swipes_forward', sf,
        'eng_rate', eng_rate, 'reply_rate', reply_rate, 'share_rate', share_rate, 'exit_rate', exit_rate,
        'rank', jsonb_build_object('views', rk_views, 'interactions', rk_interactions, 'replies', rk_replies, 'shares', rk_shares,
                                   'likes', rk_likes, 'profile_activity', rk_profile, 'eng_rate', rk_eng_rate, 'exit_rate', rk_exit_rate)
      ) order by day desc, posted_at desc), '[]'::jsonb),
    'averages', jsonb_build_object('views', round(avg(v)), 'interactions', round(avg(i)), 'replies', round(avg(r.r), 1), 'shares', round(avg(sh), 1),
                                   'eng_rate', round(avg(eng_rate), 4), 'exit_rate', round(avg(exit_rate), 4))
  ) from r
$$;
revoke all on function public.story_compare(text, integer) from public, anon;
grant execute on function public.story_compare(text, integer) to authenticated, service_role;

-- Para a tarefa de leitura (sem login): a comparação do influencer dono do story.
create or replace function public.story_compare_for(p_story_id text, p_limit integer default 12)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.story_compare(s.affiliate_email, p_limit) from public.instagram_stories s where s.id = p_story_id
$$;
revoke all on function public.story_compare_for(text, integer) from public, anon, authenticated;

-- Grava a análise escrita de um story (tarefa de leitura).
create or replace function public.story_insight_set(p_id text, p_text text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.instagram_stories set ai_insight = nullif(btrim(p_text), ''), ai_insight_at = now() where id = p_id;
  if not found then raise exception 'Story % não encontrado.', p_id; end if;
  return jsonb_build_object('id', p_id, 'ok', true);
end $$;
revoke all on function public.story_insight_set(text, text) from public, anon, authenticated;

-- Portal: comparação do afiliado logado (ou, para a equipe, do afiliado pedido).
create or replace function public.portal_story_compare(p_email text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare e text := public.portal_target(p_email);
begin
  if e is null then return null; end if;
  return public.story_compare(e, 12);
end $$;
revoke all on function public.portal_story_compare(text) from public, anon;
grant execute on function public.portal_story_compare(text) to authenticated;

-- Assunto do story (enviado por print ou lido pela API), escrito pelo próprio influencer.
create or replace function public.portal_story_set_topic(p_id text, p_topic text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare e text := (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
begin
  if e is null then raise exception 'Só o próprio influencer escreve o assunto.'; end if;
  update public.instagram_stories set topic = nullif(left(btrim(p_topic), 200), '') where id = p_id and affiliate_email = e;
  if not found then raise exception 'Story não encontrado.'; end if;
  return jsonb_build_object('id', p_id, 'topic', nullif(left(btrim(p_topic), 200), ''));
end $$;
revoke all on function public.portal_story_set_topic(text, text) from public, anon;
grant execute on function public.portal_story_set_topic(text, text) to authenticated;

-- Envio com assunto (p_topic opcional: a página antiga, sem o campo, continua funcionando).
drop function if exists public.portal_story_create(date, text[], text[]);
create or replace function public.portal_story_create(p_day date, p_paths text[], p_tools text[], p_topic text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
  v_id text := 'print:' || gen_random_uuid();
  v_at timestamptz;
begin
  if e is null then raise exception 'Só o próprio influencer envia os stories.'; end if;
  if p_day is null or p_day > (now() at time zone 'America/Sao_Paulo')::date then raise exception 'Informe o dia em que o story foi postado.'; end if;
  if coalesce(cardinality(p_tools), 0) = 0 then raise exception 'Marque pelo menos uma ferramenta que aparece no story.'; end if;
  perform public.story_prints_check(e, p_paths);
  v_at := (p_day + time '12:00') at time zone 'America/Sao_Paulo';
  insert into public.instagram_stories (id, affiliate_email, media_type, posted_at, expires_at, source, story_date, image_path, image_paths, status, final, mentions_flow, first_seen_at, created_by, topic)
  values (v_id, e, 'IMAGE', v_at, v_at + interval '24 hours', 'print', p_day, p_paths[1], p_paths, 'reading', true, true, now(), auth.uid(), nullif(left(btrim(p_topic), 200), ''));
  perform public.portal_tag_content('ig_story', v_id, p_tools);
  return jsonb_build_object('id', v_id);
end $$;
revoke all on function public.portal_story_create(date, text[], text[], text) from public, anon;
grant execute on function public.portal_story_create(date, text[], text[], text) to authenticated;

-- portal_content: os stories trazem o assunto e a análise.
do $patch$
declare src text;
begin
  src := pg_get_functiondef('public.portal_content(text)'::regprocedure);
  src := replace(src, $a$'ai_read', s.ai_read,$a$, $a$'ai_read', s.ai_read, 'topic', s.topic, 'ai_insight', s.ai_insight, 'ai_insight_at', s.ai_insight_at,$a$);
  if src !~ 'ai_insight_at' then raise exception 'portal_content: trecho não encontrado'; end if;
  execute src;
end $patch$;
