-- Até 3 prints por story enviado.
--
-- A tela de métricas do story no Instagram não cabe num print só (Visão geral em cima; alcance, respostas,
-- compartilhamentos e toques no link mais abaixo). O influencer anexa de 1 a 3 prints no envio e pode juntar mais
-- (até 3 no total) num story que ainda não foi confirmado; o story volta para "aguardando leitura" e a tarefa
-- agendada lê todos os prints juntos. image_path continua com o primeiro print (compatibilidade).
-- Também passa a guardar as interações (total_interactions), que aparecem na Visão geral.

alter table public.instagram_stories add column if not exists image_paths text[] not null default '{}';
update public.instagram_stories set image_paths = array[image_path]
 where source = 'print' and image_path is not null and image_paths = '{}';

-- Confere os caminhos dos prints: 1 a 3, na pasta do afiliado, já enviados ao bucket.
create or replace function public.story_prints_check(p_email text, p_paths text[])
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(cardinality(p_paths), 0) = 0 then raise exception 'Envie pelo menos um print do story.'; end if;
  if cardinality(p_paths) > 3 then raise exception 'Cada story aceita até 3 prints.'; end if;
  if exists (select 1 from unnest(p_paths) x
              where x is null or split_part(x, '/', 1) <> md5(p_email)
                 or not exists (select 1 from storage.objects o where o.bucket_id = 'story-prints' and o.name = x)) then
    raise exception 'Envie os prints do story antes de salvar.';
  end if;
end $$;
revoke all on function public.story_prints_check(text, text[]) from public, anon, authenticated;

drop function if exists public.portal_story_create(date, text, text[]);
create or replace function public.portal_story_create(p_day date, p_paths text[], p_tools text[])
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
  insert into public.instagram_stories (id, affiliate_email, media_type, posted_at, expires_at, source, story_date, image_path, image_paths, status, final, mentions_flow, first_seen_at, created_by)
  values (v_id, e, 'IMAGE', v_at, v_at + interval '24 hours', 'print', p_day, p_paths[1], p_paths, 'reading', true, true, now(), auth.uid());
  perform public.portal_tag_content('ig_story', v_id, p_tools);
  return jsonb_build_object('id', v_id);
end $$;

-- Junta prints a um story ainda não confirmado (até 3 no total); ele volta para a fila de leitura.
create or replace function public.portal_story_add_prints(p_id text, p_paths text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
  s public.instagram_stories;
  v_all text[];
begin
  if e is null then raise exception 'Só o próprio influencer envia os prints.'; end if;
  select * into s from public.instagram_stories where id = p_id and affiliate_email = e and source = 'print';
  if s.id is null then raise exception 'Story não encontrado.'; end if;
  if s.status = 'confirmed' then raise exception 'Este story já foi confirmado. Corrija os números direto nos campos.'; end if;
  v_all := s.image_paths || p_paths;
  if cardinality(v_all) > 3 then raise exception 'Cada story aceita até 3 prints (este já tem %).', cardinality(s.image_paths); end if;
  perform public.story_prints_check(e, p_paths);
  update public.instagram_stories set image_paths = v_all, image_path = v_all[1], status = 'reading' where id = p_id;
  return jsonb_build_object('id', p_id, 'image_paths', v_all);
end $$;

-- Tira um print de um story não confirmado (fica pelo menos um). O portal apaga a imagem do bucket.
create or replace function public.portal_story_remove_print(p_id text, p_path text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
  s public.instagram_stories;
  v_all text[];
begin
  if e is null then raise exception 'Só o próprio influencer mexe nos prints.'; end if;
  select * into s from public.instagram_stories where id = p_id and affiliate_email = e and source = 'print';
  if s.id is null or not (p_path = any (s.image_paths)) then raise exception 'Print não encontrado.'; end if;
  if s.status = 'confirmed' then raise exception 'Este story já foi confirmado.'; end if;
  v_all := array_remove(s.image_paths, p_path);
  if cardinality(v_all) = 0 then raise exception 'O story precisa de pelo menos um print. Para tirar tudo, apague o story.'; end if;
  update public.instagram_stories set image_paths = v_all, image_path = v_all[1] where id = p_id;
  return jsonb_build_object('id', p_id, 'removed', p_path, 'image_paths', v_all);
end $$;

drop function if exists public.portal_story_confirm(text, date, bigint, bigint, bigint, bigint, bigint);
create or replace function public.portal_story_confirm(p_id text, p_day date, p_reach bigint, p_views bigint, p_replies bigint, p_shares bigint,
  p_link_taps bigint, p_interactions bigint default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
  s public.instagram_stories;
  v_at timestamptz;
begin
  if e is null then raise exception 'Só o próprio influencer confirma os stories.'; end if;
  select * into s from public.instagram_stories where id = p_id and affiliate_email = e and source = 'print';
  if s.id is null then raise exception 'Story não encontrado.'; end if;
  if p_day is null or p_day > (now() at time zone 'America/Sao_Paulo')::date then raise exception 'Informe o dia em que o story foi postado.'; end if;
  if least(coalesce(p_reach, 0), coalesce(p_views, 0), coalesce(p_replies, 0), coalesce(p_shares, 0), coalesce(p_link_taps, 0), coalesce(p_interactions, 0)) < 0 then
    raise exception 'Os números não podem ser negativos.';
  end if;
  if p_reach is null then raise exception 'Informe pelo menos o alcance.'; end if;
  v_at := (p_day + time '12:00') at time zone 'America/Sao_Paulo';
  update public.instagram_stories
     set story_date = p_day, posted_at = v_at, expires_at = v_at + interval '24 hours',
         reach = p_reach, views = p_views, replies = p_replies, shares = p_shares, link_taps = p_link_taps,
         total_interactions = p_interactions,
         status = 'confirmed', confirmed_at = now(), insights_at = now()
   where id = p_id;
  return jsonb_build_object('id', p_id, 'status', 'confirmed');
end $$;

-- Apaga o story enviado por print (e as marcações); devolve os prints para o portal apagar do bucket.
create or replace function public.portal_story_delete(p_id text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
  v_paths text[];
begin
  if e is null then raise exception 'Só o próprio influencer apaga os stories.'; end if;
  delete from public.instagram_stories where id = p_id and affiliate_email = e and source = 'print'
    returning coalesce(nullif(image_paths, '{}'), array[image_path]) into v_paths;
  if v_paths is null then raise exception 'Story não encontrado.'; end if;
  delete from public.content_tool_tags where kind = 'ig_story' and content_id = p_id;
  return jsonb_build_object('id', p_id, 'image_path', v_paths[1], 'image_paths', v_paths);
end $$;

revoke all on function public.portal_story_create(date, text[], text[]), public.portal_story_add_prints(text, text[]),
  public.portal_story_remove_print(text, text), public.portal_story_confirm(text, date, bigint, bigint, bigint, bigint, bigint, bigint),
  public.portal_story_delete(text) from public, anon;
grant execute on function public.portal_story_create(date, text[], text[]), public.portal_story_add_prints(text, text[]),
  public.portal_story_remove_print(text, text), public.portal_story_confirm(text, date, bigint, bigint, bigint, bigint, bigint, bigint),
  public.portal_story_delete(text) to authenticated;

-- portal_content: os stories passam a trazer image_paths e as interações.
do $patch$
declare src text;
begin
  src := pg_get_functiondef('public.portal_content(text)'::regprocedure);
  src := replace(src, $a$'image_path', s.image_path, $a$, $a$'image_path', s.image_path, 'image_paths', s.image_paths, 'interactions', s.total_interactions, $a$);
  if src !~ 'image_paths' then raise exception 'portal_content: trecho não encontrado'; end if;
  execute src;
end $patch$;
