-- Análise da IA para cada influencer contratado (Portal do Afiliado, /parceiro/).
--
-- public.influencer_analysis_facts(email) calcula os números do influencer (o banco faz as contas; a IA só escreve):
--   contrato  · início, fim, dias restantes, meta de vendas do bônus, vendas no contrato e ritmo até o fim
--   vendas    · mês atual até agora × mês anterior até o mesmo dia (vendas, comissão, reembolsos), por produto
--   entregas  · stories, reels e YouTube do mês atual (com o ritmo esperado até hoje) e do mês anterior
--   youtube   · inscritos e views do canal hoje × 30 dias atrás, vídeos dos últimos 30 dias, vídeos sobre a Flow
--   instagram · seguidores hoje × 30 dias atrás, posts e reels dos últimos 30 dias × 30 anteriores, médias e destaque
-- A tarefa agendada do Claude ("Análise e Avisos FlowFinance") escreve o texto para cada influencer, falando com ele
-- ("você"), e grava em partner_analyses. O portal lê pela portal_analysis(): o texto mais recente + os números de agora.
-- O afiliado não lê a tabela: só pela função, que descobre o afiliado pelo login (portal_target).

create table if not exists public.partner_analyses (
  id               uuid primary key default gen_random_uuid(),
  affiliate_email  text not null references public.affiliates(email) on update cascade on delete cascade,
  created_at       timestamptz not null default now(),
  text             text not null,
  source           text not null default 'claude',
  model            text,
  facts            jsonb not null
);
create index if not exists partner_analyses_email_idx on public.partner_analyses (affiliate_email, created_at desc);
alter table public.partner_analyses enable row level security;
revoke all on public.partner_analyses from anon, authenticated;
grant select on public.partner_analyses to authenticated;
drop policy if exists team_read on public.partner_analyses;
create policy team_read on public.partner_analyses for select to authenticated using ((select public.can(array['af.flowinf'])));

create or replace function public.influencer_analysis_facts(p_email text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  tz      constant text := 'America/Sao_Paulo';
  meses   constant text[] := array['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  -- Sem login (tarefa agendada / service role) vale o e-mail pedido; com login, as regras do portal.
  e       text := case when auth.uid() is null then lower(p_email) else public.portal_target(p_email) end;
  v_now   timestamptz := now();
  v_local timestamp := now() at time zone 'America/Sao_Paulo';
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  m0 timestamptz; p0 timestamptz; pnow timestamptz;
  c public.influencer_contracts;
  v_name text; v_contract jsonb; v_sales jsonb; v_deliv jsonb; v_yt jsonb; v_ig jsonb; v_prod jsonb;
  v_c_sales int; v_c_start timestamptz; v_c_end timestamptz;
begin
  if e is null then return null; end if;
  m0 := date_trunc('month', v_local) at time zone tz;
  p0 := (date_trunc('month', v_local) - interval '1 month') at time zone tz;
  pnow := (v_local - interval '1 month') at time zone tz;

  select coalesce(nullif(btrim(name), ''), email) into v_name from public.affiliates where email = e;
  select * into c from public.influencer_contracts where affiliate_email = e and active;

  /* ---------- vendas (só produtos das ferramentas Flow) ---------- */
  with s as (
    select a.status, a.commission, a.net_amount, a.amount, a.sale_created_at, a.refunded_at, a.product_name
      from public.affiliate_sales a join public.kiwify_products p on p.id = a.product_id and p.tool_id is not null
     where a.affiliate_email = e and a.sale_created_at >= least(p0, v_now - interval '60 days')
  )
  select jsonb_build_object(
    'mes_atual', jsonb_build_object('label', meses[extract(month from v_local)::int] || ' (1 a ' || extract(day from v_local)::int || ')',
       'vendas', count(*) filter (where status = 'paid' and sale_created_at >= m0),
       'comissao', round(coalesce(sum(commission) filter (where status = 'paid' and sale_created_at >= m0), 0), 2),
       'reembolsos', count(*) filter (where status = 'refunded' and sale_created_at >= m0)),
    'mes_anterior_mesmo_ponto', jsonb_build_object('label', meses[extract(month from v_local - interval '1 month')::int] || ' (1 a ' || extract(day from v_local)::int || ')',
       'vendas', count(*) filter (where status = 'paid' and sale_created_at >= p0 and sale_created_at < pnow),
       'comissao', round(coalesce(sum(commission) filter (where status = 'paid' and sale_created_at >= p0 and sale_created_at < pnow), 0), 2),
       'reembolsos', count(*) filter (where status = 'refunded' and sale_created_at >= p0 and sale_created_at < pnow)),
    'mes_anterior_inteiro', jsonb_build_object('label', meses[extract(month from v_local - interval '1 month')::int],
       'vendas', count(*) filter (where status = 'paid' and sale_created_at >= p0 and sale_created_at < m0),
       'comissao', round(coalesce(sum(commission) filter (where status = 'paid' and sale_created_at >= p0 and sale_created_at < m0), 0), 2)),
    'ultimos_7_dias', count(*) filter (where status = 'paid' and sale_created_at >= v_now - interval '7 days'),
    '7_dias_anteriores', count(*) filter (where status = 'paid' and sale_created_at >= v_now - interval '14 days' and sale_created_at < v_now - interval '7 days'),
    'ultima_venda', max(sale_created_at) filter (where status = 'paid'))
  into v_sales from s;

  select coalesce(jsonb_agg(jsonb_build_object('produto', product_name, 'vendas', n, 'comissao', com) order by n desc), '[]'::jsonb) into v_prod
    from (select a.product_name, count(*) n, round(sum(a.commission), 2) com
            from public.affiliate_sales a join public.kiwify_products p on p.id = a.product_id and p.tool_id is not null
           where a.affiliate_email = e and a.status = 'paid' and a.sale_created_at >= m0 group by 1) x;
  v_sales := v_sales || jsonb_build_object('por_produto_mes_atual', v_prod);

  /* ---------- contrato e entregas ---------- */
  if c.id is not null then
    v_c_start := c.start_date::timestamp at time zone tz;
    v_c_end := case when c.end_date is null then null else (c.end_date + 1)::timestamp at time zone tz end;
    select count(*) into v_c_sales
      from public.affiliate_sales a join public.kiwify_products p on p.id = a.product_id and p.tool_id is not null
     where a.affiliate_email = e and a.status = 'paid' and a.sale_created_at >= v_c_start and (v_c_end is null or a.sale_created_at < v_c_end);
    v_contract := jsonb_build_object(
      'inicio', c.start_date, 'fim', c.end_date,
      'dias_passados', v_today - c.start_date + 1,
      'dias_restantes', case when c.end_date is null then null else c.end_date - v_today end,
      'comissao_pct', c.commission_pct, 'fixo_mensal', c.fixed_fee,
      'meta_bonus_vendas', c.bonus_sales_target, 'bonus', c.bonus_amount,
      'vendas_no_contrato', v_c_sales,
      'falta_para_bonus', greatest(c.bonus_sales_target - v_c_sales, 0),
      -- Ritmo: vendas por dia desde o início × dias que faltam.
      'projecao_vendas_ate_o_fim', case when c.end_date is null then null
        else round(v_c_sales::numeric / greatest(v_today - c.start_date + 1, 1) * (c.end_date - c.start_date + 1)) end,
      'vendas_por_dia_necessarias', case when c.end_date is null or c.end_date <= v_today then null
        else round(greatest(c.bonus_sales_target - v_c_sales, 0)::numeric / (c.end_date - v_today), 2) end,
      'metas_por_mes', jsonb_build_object('stories', c.stories_per_month, 'reels', c.reels_per_month, 'youtube', c.youtube_per_month));

    with mo as (
      select m.ms::date as m_start, (m.ms + interval '1 month')::date as m_next,
             greatest(c.start_date, m.ms::date) as w_start,
             least(coalesce(c.end_date, (m.ms + interval '1 month - 1 day')::date), (m.ms + interval '1 month - 1 day')::date) as w_end
        from (values (date_trunc('month', v_local)), (date_trunc('month', v_local) - interval '1 month')) m(ms)
       where c.start_date < (m.ms + interval '1 month')::date and (c.end_date is null or c.end_date >= m.ms::date)
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'mes', meses[extract(month from mo.m_start)::int] || '/' || extract(year from mo.m_start),
             'fechado', mo.m_next <= v_today,
             'dias_restantes', greatest(mo.w_end - v_today, 0),
             'stories', greatest(coalesce(d.stories_done, 0), (select count(*) from public.instagram_stories s where s.affiliate_email = e and s.mentions_flow
                          and (s.posted_at at time zone tz)::date >= mo.m_start and (s.posted_at at time zone tz)::date < mo.m_next)),
             'reels', greatest(coalesce(d.reels_done, 0), (select count(*) from public.instagram_media x where x.affiliate_email = e and x.media_product_type = 'REELS'
                          and x.caption ~* 'flow[[:space:]_.-]*(pages?|track(ing)?|spy)'
                          and (x.posted_at at time zone tz)::date >= mo.m_start and (x.posted_at at time zone tz)::date < mo.m_next)),
             'youtube', coalesce(d.youtube_done, (select count(*) from public.youtube_videos v join public.youtube_channels ch on ch.channel_id = v.channel_id
                          where ch.affiliate_email = e and v.title ~* 'flow' and not coalesce(v.is_short, v.duration_s is not null and v.duration_s <= 180)
                            and (v.published_at at time zone tz)::date >= mo.m_start and (v.published_at at time zone tz)::date < mo.m_next))::int,
             'meta_stories', c.stories_per_month, 'meta_reels', c.reels_per_month, 'meta_youtube', c.youtube_per_month,
             'stories_esperados_ate_hoje', case when mo.m_next <= v_today then c.stories_per_month
               else floor(c.stories_per_month * least(1.0, greatest(0.0, (v_today - mo.w_start + 1)::numeric / greatest(1, mo.w_end - mo.w_start + 1)))) end
           ) order by mo.m_start desc), '[]'::jsonb)
      into v_deliv
      from mo left join public.influencer_deliverables d on d.contract_id = c.id
             and d.year = extract(year from mo.m_start)::int and d.month = extract(month from mo.m_start)::int;
  end if;

  /* ---------- YouTube ---------- */
  select jsonb_build_object(
      'canal', ch.title, 'inscritos', ch.subscribers, 'views_totais', ch.total_views, 'videos', ch.video_count,
      'inscritos_30_dias_atras', s30.subscribers, 'views_totais_30_dias_atras', s30.total_views, 'snapshot_de', s30.day,
      'videos_ultimos_30_dias', (select count(*) from public.youtube_videos v where v.channel_id = ch.channel_id and v.published_at >= v_now - interval '30 days'),
      'views_dos_videos_ultimos_30_dias', (select coalesce(sum(v.views), 0) from public.youtube_videos v where v.channel_id = ch.channel_id and v.published_at >= v_now - interval '30 days'),
      'videos_30_dias_anteriores', (select count(*) from public.youtube_videos v where v.channel_id = ch.channel_id and v.published_at >= v_now - interval '60 days' and v.published_at < v_now - interval '30 days'),
      'views_dos_videos_30_dias_anteriores', (select coalesce(sum(v.views), 0) from public.youtube_videos v where v.channel_id = ch.channel_id and v.published_at >= v_now - interval '60 days' and v.published_at < v_now - interval '30 days'),
      'video_destaque_30_dias', (select jsonb_build_object('titulo', v.title, 'views', v.views, 'curtidas', v.likes, 'comentarios', v.comments, 'publicado', v.published_at::date, 'short', coalesce(v.is_short, v.duration_s <= 180))
                                   from public.youtube_videos v where v.channel_id = ch.channel_id and v.published_at >= v_now - interval '30 days' order by v.views desc nulls last limit 1),
      'videos_sobre_flow_no_contrato', (select count(*) from public.youtube_videos v where v.channel_id = ch.channel_id and v.title ~* 'flow' and (c.id is null or v.published_at >= v_c_start)),
      'views_videos_sobre_flow', (select coalesce(sum(v.views), 0) from public.youtube_videos v where v.channel_id = ch.channel_id and v.title ~* 'flow' and (c.id is null or v.published_at >= v_c_start)))
    into v_yt
    from public.youtube_channels ch
    left join lateral (select y.subscribers, y.total_views, y.day from public.youtube_channel_snapshots y
                        where y.channel_id = ch.channel_id and y.day <= v_today - 30 order by y.day desc limit 1) s30 on true
   where ch.affiliate_email = e and ch.channel_id is not null
   limit 1;

  /* ---------- Instagram ---------- */
  with m as (
    select * from public.instagram_media x where x.affiliate_email = e and x.posted_at >= v_now - interval '60 days'
  )
  select jsonb_build_object(
      'usuario', a.username, 'seguidores', a.followers_count, 'posts', a.media_count,
      'seguidores_30_dias_atras', s30.followers_count, 'snapshot_de', s30.day,
      'conectado_no_portal', exists (select 1 from public.instagram_connections ic where ic.affiliate_email = e),
      'ultimos_30_dias', (select jsonb_build_object('posts', count(*), 'reels', count(*) filter (where media_product_type = 'REELS'),
                            'media_views_reels', round(avg(view_count) filter (where media_product_type = 'REELS')),
                            'media_curtidas', round(avg(like_count)), 'media_comentarios', round(avg(comments_count)),
                            'posts_sobre_flow', count(*) filter (where caption ~* 'flow[[:space:]_.-]*(pages?|track(ing)?|spy)'))
                          from m where posted_at >= v_now - interval '30 days'),
      '30_dias_anteriores', (select jsonb_build_object('posts', count(*), 'reels', count(*) filter (where media_product_type = 'REELS'),
                            'media_views_reels', round(avg(view_count) filter (where media_product_type = 'REELS')),
                            'media_curtidas', round(avg(like_count)), 'media_comentarios', round(avg(comments_count)))
                          from m where posted_at < v_now - interval '30 days'),
      'post_destaque_30_dias', (select jsonb_build_object('tipo', coalesce(media_product_type, media_type), 'legenda', left(regexp_replace(coalesce(caption, ''), '\s+', ' ', 'g'), 100),
                                  'views', view_count, 'curtidas', like_count, 'comentarios', comments_count, 'publicado', posted_at::date)
                                from m where posted_at >= v_now - interval '30 days' order by coalesce(view_count, like_count * 20) desc nulls last limit 1),
      'stories_sobre_flow_mes_atual', (select count(*) from public.instagram_stories s where s.affiliate_email = e and s.mentions_flow and s.posted_at >= m0))
    into v_ig
    from public.instagram_accounts a
    left join lateral (select z.followers_count, z.day from public.instagram_snapshots z
                        where z.affiliate_email = e and z.day <= v_today - 30 order by z.day desc limit 1) s30 on true
   where a.affiliate_email = e and a.error is null
   limit 1;

  return jsonb_build_object(
    'gerado_em', v_now, 'hoje', to_char(v_local, 'DD/MM/YYYY'), 'nome', v_name, 'email', e,
    'contrato', v_contract, 'vendas', v_sales, 'entregas', coalesce(v_deliv, '[]'::jsonb), 'youtube', v_yt, 'instagram', v_ig,
    'notas', jsonb_build_array(
      'Vendas e comissões só dos produtos das ferramentas Flow, vendas pagas.',
      'Entregas: o maior entre o que a equipe lançou e o detectado (stories que citam a Flow, reels com "Flow…" na legenda, vídeos longos com "flow" no título).',
      'Views dos vídeos/reels são as acumuladas até hoje: vídeos mais antigos tiveram mais tempo para somar.')
  );
end $$;

-- Portal: a análise do próprio afiliado (texto mais recente + números de agora). A equipe pode passar p_email.
create or replace function public.portal_analysis(p_email text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e text := public.portal_target(p_email); r public.partner_analyses;
begin
  if e is null then return null; end if;
  select * into r from public.partner_analyses where affiliate_email = e order by created_at desc limit 1;
  return jsonb_build_object('text', r.text, 'created_at', r.created_at, 'source', r.source, 'facts', public.influencer_analysis_facts(p_email));
end $$;

revoke all on function public.influencer_analysis_facts(text), public.portal_analysis(text) from public, anon;
grant execute on function public.influencer_analysis_facts(text), public.portal_analysis(text) to authenticated, service_role;
