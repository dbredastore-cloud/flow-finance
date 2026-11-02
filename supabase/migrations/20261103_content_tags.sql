-- Entregas de conteúdo dos influencers marcadas por ferramenta.
--
-- O influencer marca no Portal do Afiliado (aba Conteúdo) quais ferramentas Flow aparecem em cada vídeo do YouTube,
-- post do Instagram e story (FlowPages, FlowTracking, FlowSpy; pode marcar mais de uma). Só conta como entrega o
-- conteúdo com pelo menos uma ferramenta marcada; um conteúdo com duas ferramentas conta 1 na meta e aparece nas
-- duas no relatório.
--   · YouTube: vídeos longos contam para a meta; Shorts marcados são entrega extra (fora da meta).
--   · Instagram: reels contam para a meta; feed e carrossel marcados são entrega extra (fora da meta).
--   · Stories: os da API (Instagram conectado) e os enviados por print. O print vai para o Storage (bucket
--     story-prints); a tarefa agendada do Claude "Leitura dos prints de stories" lê os números (sem API paga) e o
--     influencer confere e confirma. O story conta na meta assim que é enviado; o alcance só entra depois de confirmado.
-- Tudo por ciclo do contrato (1 mês a partir da assinatura), dentro de start_date/end_date.
-- influencer_deliverables vira só ajuste manual (+/−) da equipe: stories_adj, reels_adj, youtube_adj. Os números
-- lançados à mão até hoje passam para o ajuste, para os totais não mudarem.
-- O parceiro não lê nenhuma tabela: tudo passa pelas funções portal_* (security definer), que descobrem o afiliado
-- pelo login (partner_users).

/* ---------------- marcação das ferramentas ---------------- */
create table if not exists public.content_tool_tags (
  kind            text not null check (kind in ('youtube', 'ig_media', 'ig_story')),
  content_id      text not null,          -- youtube_videos.video_id, instagram_media.id ou instagram_stories.id
  tool_id         uuid not null references public.tools(id) on delete cascade,
  affiliate_email text not null references public.affiliates(email) on update cascade on delete cascade,
  tagged_by       uuid,
  tagged_at       timestamptz not null default now(),
  primary key (kind, content_id, tool_id)
);
create index if not exists content_tool_tags_aff_idx on public.content_tool_tags (affiliate_email);

alter table public.content_tool_tags enable row level security;
revoke all on public.content_tool_tags from anon, authenticated;
grant select on public.content_tool_tags to authenticated;
drop policy if exists team_read on public.content_tool_tags;
create policy team_read on public.content_tool_tags for select to authenticated
  using ((select public.can(array['af.base', 'af.flowinf'])));

/* ---------------- stories por print ---------------- */
alter table public.instagram_stories
  add column if not exists source       text not null default 'api',
  add column if not exists story_date   date,
  add column if not exists image_path   text,
  add column if not exists status       text not null default 'confirmed',
  add column if not exists link_taps    bigint,          -- "toques" no link / figurinha
  add column if not exists ai_read      jsonb,           -- números que a leitura do print sugeriu
  add column if not exists ai_read_at   timestamptz,
  add column if not exists confirmed_at timestamptz,
  add column if not exists created_by   uuid;
alter table public.instagram_stories drop constraint if exists instagram_stories_source_chk;
alter table public.instagram_stories add constraint instagram_stories_source_chk check (source in ('api', 'print'));
alter table public.instagram_stories drop constraint if exists instagram_stories_status_chk;
-- reading = aguardando a leitura do print · review = lido, aguardando o influencer conferir · confirmed = números conferidos
alter table public.instagram_stories add constraint instagram_stories_status_chk check (status in ('reading', 'review', 'confirmed'));
create index if not exists instagram_stories_reading_idx on public.instagram_stories (status) where source = 'print' and status = 'reading';

/* ---------------- ajuste manual das entregas ---------------- */
alter table public.influencer_deliverables
  add column if not exists stories_adj integer not null default 0,
  add column if not exists reels_adj   integer not null default 0,
  add column if not exists youtube_adj integer not null default 0;
do $$ begin
  if not exists (select 1 from public.influencer_deliverables where stories_adj <> 0 or reels_adj <> 0 or youtube_adj <> 0) then
    update public.influencer_deliverables
       set stories_adj = coalesce(stories_done, 0), reels_adj = coalesce(reels_done, 0), youtube_adj = coalesce(youtube_done, 0);
  end if;
end $$;
comment on column public.influencer_deliverables.stories_done is 'Antigo (lançamento manual). A contagem vem de content_tool_tags + stories_adj.';
comment on column public.influencer_deliverables.reels_done is 'Antigo (lançamento manual). A contagem vem de content_tool_tags + reels_adj.';
comment on column public.influencer_deliverables.youtube_done is 'Antigo (lançamento manual). A contagem vem de content_tool_tags + youtube_adj.';

/* ---------------- Storage: prints dos stories ---------------- */
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('story-prints', 'story-prints', false, 6291456, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Pasta do afiliado logado no bucket (md5 do e-mail). null para a equipe e para quem não é afiliado.
create or replace function public.portal_story_folder()
returns text language sql stable security definer set search_path = '' as $$
  select md5(p.affiliate_email) from public.partner_users p where p.user_id = auth.uid() and p.active
$$;
revoke all on function public.portal_story_folder() from public, anon;
grant execute on function public.portal_story_folder() to authenticated;

drop policy if exists story_prints_insert on storage.objects;
drop policy if exists story_prints_read on storage.objects;
drop policy if exists story_prints_delete on storage.objects;
create policy story_prints_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'story-prints' and (storage.foldername(name))[1] = (select public.portal_story_folder()));
create policy story_prints_read on storage.objects for select to authenticated
  using (bucket_id = 'story-prints' and ((storage.foldername(name))[1] = (select public.portal_story_folder())
                                         or (select public.can(array['af.base', 'af.flowinf']))));
create policy story_prints_delete on storage.objects for delete to authenticated
  using (bucket_id = 'story-prints' and (storage.foldername(name))[1] = (select public.portal_story_folder()));

/* ---------------- contagem ---------------- */
-- Ciclos do contrato: 1 mês a partir da assinatura, do início até hoje (ou até o fim do contrato).
-- ce = início do ciclo seguinte; w_end = último dia do ciclo (cortado no fim do contrato).
create or replace function public.contract_cycles(p_start date, p_end date)
returns table (cycle_no integer, cs date, ce date, w_end date, is_current boolean, closed boolean)
language sql stable set search_path = '' as $$
  with t as (select (now() at time zone 'America/Sao_Paulo')::date as today),
  b as (select t.today, least(t.today, coalesce(p_end, t.today)) as upto from t)
  select g + 1, x.cs, x.ce, least(x.ce - 1, coalesce(p_end, x.ce - 1)),
         x.cs <= b.today and b.today < x.ce and (p_end is null or b.today <= p_end),
         x.ce <= b.today or (p_end is not null and p_end < b.today)
    from b
    cross join lateral generate_series(0, greatest(0, (extract(year from age(b.upto, p_start)) * 12 + extract(month from age(b.upto, p_start)))::int + 1)) g
    cross join lateral (select (p_start + make_interval(months => g))::date as cs, (p_start + make_interval(months => g + 1))::date as ce) x
   where p_start is not null and x.cs <= b.upto
$$;
revoke all on function public.contract_cycles(date, date) from public, anon;
grant execute on function public.contract_cycles(date, date) to authenticated, service_role;

-- Conteúdo marcado do afiliado entre p_from e p_to (datas de Brasília, p_to exclusivo).
-- Meta: stories, reels e vídeos longos do YouTube. Extras: feed/carrossel e Shorts. Alcance: só stories confirmados.
create or replace function public.content_counts(p_email text, p_from date, p_to date)
returns table (stories integer, reels integer, youtube integer, feed integer, shorts integer, story_reach bigint, by_tool jsonb)
language sql stable security definer set search_path = '' as $$
  -- Equipe (menus de afiliados), rotinas do servidor (sem login) ou o próprio afiliado.
  with allowed as (
    select auth.uid() is null or public.can(array['af.base', 'af.flowinf'])
        or p_email = (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active) as ok
  ), items as (
    select 'ig_story'::text as kind, s.id, 'stories'::text as cat, s.reach, s.status
      from public.instagram_stories s
     where (select ok from allowed) and s.affiliate_email = p_email
       and coalesce(s.story_date, (s.posted_at at time zone 'America/Sao_Paulo')::date) >= p_from
       and coalesce(s.story_date, (s.posted_at at time zone 'America/Sao_Paulo')::date) < p_to
    union all
    select 'ig_media', m.id, case when m.media_product_type = 'REELS' then 'reels' else 'feed' end, null::bigint, null::text
      from public.instagram_media m
     where (select ok from allowed) and m.affiliate_email = p_email
       and (m.posted_at at time zone 'America/Sao_Paulo')::date >= p_from and (m.posted_at at time zone 'America/Sao_Paulo')::date < p_to
    union all
    select 'youtube', v.video_id, case when coalesce(v.is_short, v.duration_s is not null and v.duration_s <= 180) then 'shorts' else 'youtube' end, null::bigint, null::text
      from public.youtube_videos v join public.youtube_channels ch on ch.channel_id = v.channel_id
     where (select ok from allowed) and ch.affiliate_email = p_email
       and (v.published_at at time zone 'America/Sao_Paulo')::date >= p_from and (v.published_at at time zone 'America/Sao_Paulo')::date < p_to
  ), tagged as (
    select i.kind, i.id, i.cat, i.reach, i.status, t.slug
      from items i
      join public.content_tool_tags g on g.kind = i.kind and g.content_id = i.id
      join public.tools t on t.id = g.tool_id
  ), one as (select distinct kind, id, cat, reach, status from tagged)
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
             'story_reach', coalesce(sum(reach) filter (where cat = 'stories' and status = 'confirmed'), 0)) as j
             from tagged group by slug) x), '{}'::jsonb)
    from one
$$;
-- A visão influencer_content_cycles chama esta função com o login de quem consulta, por isso authenticated executa
-- (a regra de acesso fica no "allowed" acima).
revoke all on function public.content_counts(text, date, date) from public, anon;
grant execute on function public.content_counts(text, date, date) to authenticated, service_role;

-- Entregas por contrato × ciclo: o marcado + o ajuste manual, contra a meta. A equipe (menus de afiliados) vê todos;
-- o afiliado logado vê só os próprios (a visão roda como dona das tabelas, por isso a regra fica aqui dentro).
create or replace view public.influencer_content_cycles with (security_invoker = false) as
  select c.id as contract_id, c.affiliate_email, c.active, k.cycle_no, k.cs as cycle_start, k.w_end as cycle_end, k.ce as next_cycle_start,
         k.is_current, k.closed,
         c.stories_per_month as stories_goal, c.reels_per_month as reels_goal, c.youtube_per_month as youtube_goal,
         cc.stories as stories_tagged, cc.reels as reels_tagged, cc.youtube as youtube_tagged,
         coalesce(d.stories_adj, 0) as stories_adj, coalesce(d.reels_adj, 0) as reels_adj, coalesce(d.youtube_adj, 0) as youtube_adj,
         greatest(0, cc.stories + coalesce(d.stories_adj, 0)) as stories,
         greatest(0, cc.reels + coalesce(d.reels_adj, 0)) as reels,
         greatest(0, cc.youtube + coalesce(d.youtube_adj, 0)) as youtube,
         cc.feed as feed_extra, cc.shorts as shorts_extra, cc.story_reach, cc.by_tool
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

/* ---------------- Portal do Afiliado ---------------- */
-- Aba Conteúdo: ciclos do contrato com as contagens, vídeos, posts e stories da vigência com as marcações.
create or replace function public.portal_content(p_email text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e text := public.portal_target(p_email);
  c public.influencer_contracts;
  v_from timestamptz;
  v_to timestamptz;
begin
  if e is null then return null; end if;
  select * into c from public.influencer_contracts where affiliate_email = e order by active desc, start_date desc limit 1;
  if c.id is null then return jsonb_build_object('contract', null); end if;
  v_from := c.start_date::timestamp at time zone 'America/Sao_Paulo';
  v_to := case when c.end_date is null then 'infinity'::timestamptz else (c.end_date + 1)::timestamp at time zone 'America/Sao_Paulo' end;
  return jsonb_build_object(
    'contract', jsonb_build_object('active', c.active, 'start_date', c.start_date, 'end_date', c.end_date,
      'stories_per_month', c.stories_per_month, 'reels_per_month', c.reels_per_month, 'youtube_per_month', c.youtube_per_month),
    'tools', (select jsonb_agg(jsonb_build_object('slug', t.slug, 'name', t.name) order by t.sort_order)
                from public.tools t where t.slug in ('flowpages', 'flowtracking', 'flowspy')),
    'cycles', coalesce((select jsonb_agg(to_jsonb(x) - 'affiliate_email' - 'contract_id' - 'active' order by x.cycle_start desc)
                from public.influencer_content_cycles x where x.contract_id = c.id), '[]'::jsonb),
    'ig', jsonb_build_object(
      'has_account', exists (select 1 from public.instagram_accounts a where a.affiliate_email = e and a.username is not null),
      'connected', exists (select 1 from public.instagram_connections ic where ic.affiliate_email = e and ic.status = 'ok'),
      'connection_status', (select ic.status from public.instagram_connections ic where ic.affiliate_email = e)),
    'has_channel', exists (select 1 from public.youtube_channels y where y.affiliate_email = e and y.channel_id is not null),
    'youtube', coalesce((select jsonb_agg(jsonb_build_object('id', v.video_id, 'title', v.title, 'published_at', v.published_at,
        'thumbnail_url', v.thumbnail_url, 'views', v.views, 'is_short', coalesce(v.is_short, v.duration_s is not null and v.duration_s <= 180),
        'tools', (select coalesce(jsonb_agg(t.slug order by t.sort_order), '[]'::jsonb) from public.content_tool_tags g join public.tools t on t.id = g.tool_id
                   where g.kind = 'youtube' and g.content_id = v.video_id)) order by v.published_at desc)
      from public.youtube_videos v join public.youtube_channels ch on ch.channel_id = v.channel_id
      where ch.affiliate_email = e and v.published_at >= v_from and v.published_at < v_to), '[]'::jsonb),
    'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'media_type', m.media_type, 'media_product_type', m.media_product_type,
        'caption', left(m.caption, 300), 'permalink', m.permalink, 'posted_at', m.posted_at, 'thumbnail_url', m.thumbnail_url,
        'like_count', m.like_count, 'comments_count', m.comments_count, 'view_count', m.view_count, 'reach', m.reach,
        'tools', (select coalesce(jsonb_agg(t.slug order by t.sort_order), '[]'::jsonb) from public.content_tool_tags g join public.tools t on t.id = g.tool_id
                   where g.kind = 'ig_media' and g.content_id = m.id)) order by m.posted_at desc)
      from public.instagram_media m where m.affiliate_email = e and m.posted_at >= v_from and m.posted_at < v_to), '[]'::jsonb),
    'stories', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'source', s.source, 'status', s.status,
        'day', coalesce(s.story_date, (s.posted_at at time zone 'America/Sao_Paulo')::date), 'posted_at', s.posted_at, 'permalink', s.permalink,
        'image_path', s.image_path, 'reach', s.reach, 'views', s.views, 'replies', s.replies, 'shares', s.shares, 'link_taps', s.link_taps,
        'ai_read', s.ai_read, 'ai_read_at', s.ai_read_at, 'confirmed_at', s.confirmed_at, 'mentions_flow', s.mentions_flow,
        'tools', (select coalesce(jsonb_agg(t.slug order by t.sort_order), '[]'::jsonb) from public.content_tool_tags g join public.tools t on t.id = g.tool_id
                   where g.kind = 'ig_story' and g.content_id = s.id))
        order by coalesce(s.story_date, (s.posted_at at time zone 'America/Sao_Paulo')::date) desc, s.posted_at desc)
      from public.instagram_stories s where s.affiliate_email = e
        and (s.source = 'print' or (s.posted_at >= v_from and s.posted_at < v_to))), '[]'::jsonb)
  );
end $$;

-- Marca as ferramentas de um conteúdo do afiliado logado (substitui as marcações anteriores). Só o próprio
-- influencer marca: na visão da equipe (?ver=) não há vínculo de login e a função recusa.
create or replace function public.portal_tag_content(p_kind text, p_id text, p_tools text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
  ok boolean;
  bad text;
begin
  if e is null then raise exception 'Só o próprio influencer marca as ferramentas.'; end if;
  if p_kind = 'youtube' then
    ok := exists (select 1 from public.youtube_videos v join public.youtube_channels ch on ch.channel_id = v.channel_id where v.video_id = p_id and ch.affiliate_email = e);
  elsif p_kind = 'ig_media' then
    ok := exists (select 1 from public.instagram_media m where m.id = p_id and m.affiliate_email = e);
  elsif p_kind = 'ig_story' then
    ok := exists (select 1 from public.instagram_stories s where s.id = p_id and s.affiliate_email = e);
  else
    raise exception 'Tipo de conteúdo inválido.';
  end if;
  if not ok then raise exception 'Conteúdo não encontrado.'; end if;
  select x into bad from unnest(coalesce(p_tools, '{}')) x where x not in ('flowpages', 'flowtracking', 'flowspy') limit 1;
  if bad is not null then raise exception 'Ferramenta inválida: %', bad; end if;
  delete from public.content_tool_tags where kind = p_kind and content_id = p_id;
  insert into public.content_tool_tags (kind, content_id, tool_id, affiliate_email, tagged_by)
    select p_kind, p_id, t.id, e, auth.uid() from public.tools t where t.slug = any (coalesce(p_tools, '{}'));
  return (select coalesce(jsonb_agg(t.slug order by t.sort_order), '[]'::jsonb) from public.content_tool_tags g join public.tools t on t.id = g.tool_id
           where g.kind = p_kind and g.content_id = p_id);
end $$;

-- Story enviado por print: o portal já subiu a imagem para a pasta do afiliado no bucket story-prints.
-- Entra como "aguardando leitura"; a tarefa agendada lê os números e o influencer confere em portal_story_confirm.
create or replace function public.portal_story_create(p_day date, p_path text, p_tools text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
  v_id text := 'print:' || gen_random_uuid();
  v_at timestamptz;
begin
  if e is null then raise exception 'Só o próprio influencer envia os stories.'; end if;
  if p_day is null or p_day > (now() at time zone 'America/Sao_Paulo')::date then raise exception 'Informe o dia em que o story foi postado.'; end if;
  if coalesce(cardinality(p_tools), 0) = 0 then raise exception 'Marque pelo menos uma ferramenta que aparece no story.'; end if;
  if p_path is null or split_part(p_path, '/', 1) <> md5(e)
     or not exists (select 1 from storage.objects o where o.bucket_id = 'story-prints' and o.name = p_path) then
    raise exception 'Envie o print do story antes de salvar.';
  end if;
  v_at := (p_day + time '12:00') at time zone 'America/Sao_Paulo';
  insert into public.instagram_stories (id, affiliate_email, media_type, posted_at, expires_at, source, story_date, image_path, status, final, mentions_flow, first_seen_at, created_by)
  values (v_id, e, 'IMAGE', v_at, v_at + interval '24 hours', 'print', p_day, p_path, 'reading', true, true, now(), auth.uid());
  perform public.portal_tag_content('ig_story', v_id, p_tools);
  return jsonb_build_object('id', v_id);
end $$;

-- O influencer confere e confirma os números do story (os lidos do print ou digitados por ele).
create or replace function public.portal_story_confirm(p_id text, p_day date, p_reach bigint, p_views bigint, p_replies bigint, p_shares bigint, p_link_taps bigint)
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
  if least(coalesce(p_reach, 0), coalesce(p_views, 0), coalesce(p_replies, 0), coalesce(p_shares, 0), coalesce(p_link_taps, 0)) < 0 then
    raise exception 'Os números não podem ser negativos.';
  end if;
  if p_reach is null then raise exception 'Informe pelo menos o alcance.'; end if;
  v_at := (p_day + time '12:00') at time zone 'America/Sao_Paulo';
  update public.instagram_stories
     set story_date = p_day, posted_at = v_at, expires_at = v_at + interval '24 hours',
         reach = p_reach, views = p_views, replies = p_replies, shares = p_shares, link_taps = p_link_taps,
         status = 'confirmed', confirmed_at = now(), insights_at = now()
   where id = p_id;
  return jsonb_build_object('id', p_id, 'status', 'confirmed');
end $$;

-- Apaga um story enviado por print (e as marcações). O portal apaga a imagem do bucket.
create or replace function public.portal_story_delete(p_id text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
  v_path text;
begin
  if e is null then raise exception 'Só o próprio influencer apaga os stories.'; end if;
  delete from public.instagram_stories where id = p_id and affiliate_email = e and source = 'print' returning image_path into v_path;
  if v_path is null then raise exception 'Story não encontrado.'; end if;
  delete from public.content_tool_tags where kind = 'ig_story' and content_id = p_id;
  return jsonb_build_object('id', p_id, 'image_path', v_path);
end $$;

revoke all on function public.portal_content(text), public.portal_tag_content(text, text, text[]), public.portal_story_create(date, text, text[]),
  public.portal_story_confirm(text, date, bigint, bigint, bigint, bigint, bigint), public.portal_story_delete(text) from public, anon;
grant execute on function public.portal_content(text), public.portal_tag_content(text, text, text[]), public.portal_story_create(date, text, text[]),
  public.portal_story_confirm(text, date, bigint, bigint, bigint, bigint, bigint), public.portal_story_delete(text) to authenticated;

/* ---------------- leitura dos prints (tarefa agendada do Claude, sem API paga) ---------------- */
-- A tarefa roda pelo conector do Supabase (como postgres): pede um passe de 15 minutos, chama a Edge Function
-- story-prints com ele para receber links assinados das imagens pendentes, lê cada print e grava os números aqui.
create table if not exists public.story_reader_tickets (
  ticket     text primary key,
  expires_at timestamptz not null default now() + interval '15 minutes'
);
alter table public.story_reader_tickets enable row level security;
revoke all on public.story_reader_tickets from anon, authenticated;

create or replace function public.story_reader_ticket()
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  delete from public.story_reader_tickets where expires_at < now();
  insert into public.story_reader_tickets (ticket) values (v);
  return v;
end $$;

-- Usada pela Edge Function (service role): confere o passe (vale 15 min, pode ser usado na rodada inteira).
create or replace function public.story_reader_ticket_ok(p_ticket text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.story_reader_tickets where ticket = p_ticket and expires_at > now())
$$;

-- Grava a leitura de um print. p_read = {"reach":…, "views":…, "replies":…, "shares":…, "link_taps":…, "note":"…"}
-- (null no número que não deu para ler). O story passa para "review" e o influencer confirma no portal.
create or replace function public.story_print_read(p_id text, p_read jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.instagram_stories
     set ai_read = p_read, ai_read_at = now(), status = case when status = 'reading' then 'review' else status end
   where id = p_id and source = 'print';
  if not found then raise exception 'Story % não encontrado.', p_id; end if;
  return jsonb_build_object('id', p_id, 'ok', true);
end $$;

revoke all on function public.story_reader_ticket(), public.story_reader_ticket_ok(text), public.story_print_read(text, jsonb) from public, anon, authenticated;
grant execute on function public.story_reader_ticket_ok(text) to service_role;

/* ---------------- relatório: vendas × conteúdo por influencer ---------------- */
-- Para o relatório mensal e o resumo diário. Por influencer com contrato ativo (ou só p_email): vendas aprovadas na
-- Kiwify por ferramenta dentro da vigência (combos ficam de fora, como no contrato do portal), dias de contrato,
-- média diária, projeção para 30 dias, entregas do ciclo atual, do mês do calendário e desde o início × o contratado,
-- e o alcance dos stories confirmados.
create or replace function public.influencer_report(p_email text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  tz constant text := 'America/Sao_Paulo';
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_m0 date := date_trunc('month', now() at time zone 'America/Sao_Paulo')::date;
  r jsonb;
begin
  if auth.uid() is not null and not public.can(array['af.base', 'af.flowinf']) then raise exception 'sem permissão'; end if;
  select coalesce(jsonb_agg(x.j order by x.name), '[]'::jsonb) into r from (
    select coalesce(nullif(btrim(af.name), ''), c.affiliate_email) as name,
      jsonb_build_object(
        'email', c.affiliate_email, 'nome', coalesce(nullif(btrim(af.name), ''), c.affiliate_email),
        'contrato', jsonb_build_object('inicio', c.start_date, 'fim', c.end_date, 'ativo', c.active,
          'meta_por_ciclo', jsonb_build_object('stories', c.stories_per_month, 'reels', c.reels_per_month, 'youtube', c.youtube_per_month)),
        'dias_de_contrato', d.days, 'dias_totais', case when c.end_date is not null then c.end_date - c.start_date + 1 end,
        'dias_restantes', case when c.end_date is not null then greatest(0, c.end_date - v_today) end,
        'vendas', sv.total, 'vendas_por_ferramenta', sv.by_tool, 'faturamento', sv.amount, 'comissao', sv.commission,
        'media_diaria', round(sv.total::numeric / greatest(1, d.days), 2),
        'projecao_30_dias', round(sv.total::numeric / greatest(1, d.days) * 30, 1),
        'ciclo_atual', (select to_jsonb(k) - 'affiliate_email' - 'contract_id' - 'active' from public.influencer_content_cycles k
                         where k.contract_id = c.id and k.is_current),
        'mes_atual', (select jsonb_build_object('de', greatest(v_m0, c.start_date), 'ate', v_today,
                        'stories', m.stories, 'reels', m.reels, 'youtube', m.youtube, 'feed_extra', m.feed, 'shorts_extra', m.shorts,
                        'alcance_stories', m.story_reach, 'por_ferramenta', m.by_tool)
                       from public.content_counts(c.affiliate_email, greatest(v_m0, c.start_date), least(v_today, coalesce(c.end_date, v_today)) + 1) m),
        'desde_o_inicio', (select jsonb_build_object(
                        'ciclos', count(*), 'stories', sum(k.stories), 'reels', sum(k.reels), 'youtube', sum(k.youtube),
                        'stories_contratados', sum(k.stories_goal), 'reels_contratados', sum(k.reels_goal), 'youtube_contratados', sum(k.youtube_goal),
                        'feed_extra', sum(k.feed_extra), 'shorts_extra', sum(k.shorts_extra), 'alcance_stories', sum(k.story_reach))
                       from public.influencer_content_cycles k where k.contract_id = c.id),
        'alcance_total_stories', (select coalesce(sum(k.story_reach), 0) from public.influencer_content_cycles k where k.contract_id = c.id),
        'instagram_conectado', exists (select 1 from public.instagram_connections ic where ic.affiliate_email = c.affiliate_email and ic.status = 'ok'),
        'stories_aguardando', (select count(*) from public.instagram_stories s where s.affiliate_email = c.affiliate_email and s.source = 'print' and s.status <> 'confirmed')
      ) as j
    from public.influencer_contracts c
    left join public.affiliates af on af.email = c.affiliate_email
    cross join lateral (select greatest(0, least(v_today, coalesce(c.end_date, v_today)) - c.start_date + 1) as days) d
    cross join lateral (
      select count(*)::int as total, coalesce(sum(s.amount), 0) as amount, coalesce(sum(s.commission), 0) as commission,
             coalesce((select jsonb_object_agg(q.name, q.n) from (
               select t.name, count(*) as n from public.affiliate_sales s2
                 join public.kiwify_products p2 on p2.id = s2.product_id join public.tools t on t.id = p2.tool_id
                where s2.affiliate_email = c.affiliate_email and s2.status in ('paid', 'approved')
                  and s2.sale_created_at >= (c.start_date::timestamp at time zone tz)
                  and (c.end_date is null or s2.sale_created_at < ((c.end_date + 1)::timestamp at time zone tz))
                group by t.name) q), '{}'::jsonb) as by_tool
        from public.affiliate_sales s join public.kiwify_products p on p.id = s.product_id
       where s.affiliate_email = c.affiliate_email and p.tool_id is not null and s.status in ('paid', 'approved')
         and s.sale_created_at >= (c.start_date::timestamp at time zone tz)
         and (c.end_date is null or s.sale_created_at < ((c.end_date + 1)::timestamp at time zone tz))
    ) sv
    where c.start_date <= v_today
      and (case when p_email is null then c.active else c.affiliate_email = lower(p_email) end)
  ) x;
  return jsonb_build_object('gerado_em', now(), 'influencers', r);
end $$;
revoke all on function public.influencer_report(text) from public, anon;
grant execute on function public.influencer_report(text) to authenticated, service_role;


/* ---------------- avisos e análise do Portal passam a usar o conteúdo marcado ---------------- */
-- Troca só a contagem das entregas em generate_alerts e influencer_analysis_facts (20261030_influencer_cycles.sql),
-- direto na definição que está no banco: o resto das funções fica como está.
do $patch$
declare
  src text;
begin
  -- generate_alerts
  src := pg_get_functiondef('public.generate_alerts()'::regprocedure);
  src := regexp_replace(src,
    '           greatest\(coalesce\(d\.stories_done, 0\),.*?\)\)::int as youtube,',
    E'           greatest(0, cc.stories + coalesce(d.stories_adj, 0)) as stories,\n' ||
    E'           greatest(0, cc.reels + coalesce(d.reels_adj, 0)) as reels,\n' ||
    E'           greatest(0, cc.youtube + coalesce(d.youtube_adj, 0)) as youtube,', 's');
  src := replace(src,
    E'            and d.year = extract(year from mo.m_start)::int and d.month = extract(month from mo.m_start)::int\n  ), ev as (',
    E'            and d.year = extract(year from mo.m_start)::int and d.month = extract(month from mo.m_start)::int\n' ||
    E'      cross join lateral public.content_counts(mo.affiliate_email, mo.m_start, least(mo.m_next, mo.w_end + 1)) cc\n  ), ev as (');
  if src !~ 'cc\.stories \+ coalesce\(d\.stories_adj' or src !~ 'lateral public\.content_counts\(mo\.affiliate_email' or src ~ 'd\.stories_done' then
    raise exception 'generate_alerts: trecho das entregas não encontrado (a função mudou?)';
  end if;
  execute src;

  -- influencer_analysis_facts
  src := pg_get_functiondef('public.influencer_analysis_facts(text)'::regprocedure);
  src := regexp_replace(src,
    '''stories'', greatest\(coalesce\(d\.stories_done, 0\),.*?\)\)::int,',
    E'''stories'', greatest(0, cc.stories + coalesce(d.stories_adj, 0)),\n' ||
    E'             ''reels'', greatest(0, cc.reels + coalesce(d.reels_adj, 0)),\n' ||
    E'             ''youtube'', greatest(0, cc.youtube + coalesce(d.youtube_adj, 0)),\n' ||
    E'             ''feed_extra'', cc.feed, ''shorts_extra'', cc.shorts, ''alcance_stories'', cc.story_reach, ''por_ferramenta'', cc.by_tool,', 's');
  src := replace(src,
    E'             and d.year = extract(year from mo.m_start)::int and d.month = extract(month from mo.m_start)::int;',
    E'             and d.year = extract(year from mo.m_start)::int and d.month = extract(month from mo.m_start)::int\n' ||
    E'      cross join lateral public.content_counts(e, mo.m_start, least(mo.m_next, mo.w_end + 1)) cc;');
  src := regexp_replace(src, '''Entregas: o maior entre[^'']*''',
    '''Entregas: conteúdo que o influencer marcou no Portal com pelo menos uma ferramenta Flow (stories, reels e vídeos longos do YouTube) + o ajuste manual da equipe. Feed, carrossel e Shorts marcados são extras, fora da meta.''');
  if src !~ 'cc\.stories \+ coalesce\(d\.stories_adj' or src !~ 'lateral public\.content_counts\(e,' or src ~ 'd\.stories_done' then
    raise exception 'influencer_analysis_facts: trecho das entregas não encontrado (a função mudou?)';
  end if;
  execute src;
end $patch$;
