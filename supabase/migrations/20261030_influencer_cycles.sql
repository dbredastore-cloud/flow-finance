-- Entregas dos influencers por ciclo do contrato, não por mês do calendário.
--
-- Cada ciclo dura 1 mês a partir da data de assinatura: contrato assinado em 18/10 tem o 1º ciclo de 18/10 a 17/11,
-- o 2º de 18/11 a 17/12 e assim por diante (assinatura no dia 31 vira o último dia dos meses curtos). Stories, reels
-- e o vídeo do YouTube de cada ciclo contam dentro dele. Em influencer_deliverables o ciclo continua gravado pelo
-- ano/mês em que começa (cada mês do calendário tem o início de exatamente um ciclo).
-- Refaz generate_alerts (avisos de entregas atrasadas) e influencer_analysis_facts (análise do Portal) com o ciclo.

create or replace function public.generate_alerts() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  tz       constant text := 'America/Sao_Paulo';
  meses    constant text[] := array['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  v_now    timestamptz := now();
  v_local  timestamp := now() at time zone 'America/Sao_Paulo';
  v_today  date := (now() at time zone 'America/Sao_Paulo')::date;
  v_m0     timestamptz;   -- início do mês atual
  v_p0     timestamptz;   -- início do mês passado
  v_pnow   timestamptz;   -- mesmo ponto do mês passado
  v_ym     text := to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM');
  v_week   text := to_char(now() at time zone 'America/Sao_Paulo', 'IYYY-IW');
  v_cur_m  text;
  v_prev_m text;
  v_upd    integer;
  v_res    integer;
begin
  if auth.uid() is not null and not public.can(array['fin.avisos']) then raise exception 'sem permissão'; end if;

  v_m0 := date_trunc('month', v_local) at time zone tz;
  v_p0 := (date_trunc('month', v_local) - interval '1 month') at time zone tz;
  v_pnow := ((v_local - interval '1 month')) at time zone tz;
  v_cur_m := meses[extract(month from v_local)::int];
  v_prev_m := meses[extract(month from v_local - interval '1 month')::int];

  drop table if exists _a;
  create temp table _a (key text primary key, category text, severity text, title text, body text, data jsonb, sort integer) on commit drop;

  /* ---------------- faturamento por ferramenta (vendas pagas, valor líquido) ---------------- */
  with s as (
    select t.id, t.name, t.slug, t.sort_order,
           count(*)          filter (where k.sale_created_at >= v_m0) as cur_n,
           coalesce(sum(k.net_amount) filter (where k.sale_created_at >= v_m0), 0) as cur_net,
           count(*)          filter (where k.sale_created_at >= v_p0 and k.sale_created_at < v_pnow) as prev_n,
           coalesce(sum(k.net_amount) filter (where k.sale_created_at >= v_p0 and k.sale_created_at < v_pnow), 0) as prev_net,
           coalesce(sum(k.net_amount) filter (where k.sale_created_at >= v_p0 and k.sale_created_at < v_m0), 0) as prev_full
      from public.tools t
      join public.kiwify_products p on p.tool_id = t.id
      join public.kiwify_sales_snapshot k on k.product_id = p.id and k.status = 'paid' and k.sale_created_at >= v_p0
     where t.active
     group by t.id, t.name, t.slug, t.sort_order
  ), r as (
    select slug, name, sort_order, cur_n, cur_net, prev_n, prev_net, prev_full from s
    union all
    select 'total', 'Todas as ferramentas', -1, sum(cur_n), sum(cur_net), sum(prev_n), sum(prev_net), sum(prev_full) from s having count(*) > 0
  )
  insert into _a
  select 'rev:' || slug || ':' || v_ym, 'faturamento',
         case when prev_net = 0 then 'info'
              when cur_net / prev_net - 1 <= -0.25 then 'critical'
              when cur_net / prev_net - 1 <= -0.10 then 'warning'
              when cur_net / prev_net - 1 >=  0.10 then 'good' else 'info' end,
         name || ': ' || public.alert_brl(cur_net) || ' em ' || v_cur_m || ' (' || public.alert_pct(cur_net, prev_net) || ')',
         cur_n || ' vendas pagas de 1 a ' || extract(day from v_local)::int || ' de ' || v_cur_m || ', contra ' || prev_n ||
           ' vendas e ' || public.alert_brl(prev_net) || ' no mesmo período de ' || v_prev_m || ' (que fechou em ' || public.alert_brl(prev_full) || ').',
         jsonb_build_object('tool', name, 'cur_n', cur_n, 'cur_net', cur_net, 'prev_n', prev_n, 'prev_net', prev_net, 'prev_full', prev_full,
                            'delta', case when prev_net > 0 then round(cur_net / prev_net - 1, 4) end),
         100 + sort_order
    from r;

  /* ---------------- reembolsos e chargebacks ---------------- */
  with k as (
    select t.name as tool, k.status, k.net_amount, k.sale_created_at as sale_at,
           case when k.status = 'chargedback' then coalesce(k.refunded_at, k.kiwify_updated_at) else k.refunded_at end as at
      from public.kiwify_sales_snapshot k
      join public.kiwify_products p on p.id = k.product_id
      join public.tools t on t.id = p.tool_id
     where k.status in ('refunded', 'chargedback')
  ), m as (
    select count(*) filter (where status = 'refunded'    and at >= v_m0) as ref_cur,
           count(*) filter (where status = 'refunded'    and at >= v_p0 and at < v_pnow) as ref_prev,
           coalesce(sum(net_amount) filter (where status = 'refunded' and at >= v_m0), 0) as ref_cur_val,
           count(*) filter (where status = 'chargedback' and at >= v_m0) as cb_cur,
           count(*) filter (where status = 'chargedback' and at >= v_p0 and at < v_pnow) as cb_prev,
           coalesce(sum(net_amount) filter (where status = 'chargedback' and at >= v_m0), 0) as cb_cur_val,
           count(*) filter (where status = 'refunded' and at >= v_now - interval '24 hours') as ref_24h,
           count(*) filter (where status = 'refunded' and at >= v_now - interval '31 days' and at < v_now - interval '24 hours') / 30.0 as ref_avg,
           (select to_char(mode() within group (order by (sale_at at time zone tz)::date), 'DD/MM') from k where status = 'refunded' and at >= v_now - interval '24 hours') as ref_24h_sale,
           (select jsonb_object_agg(tool, n) from (select tool, count(*) n from k where status = 'refunded' and at >= v_m0 group by tool) x) as ref_by_tool,
           (select jsonb_object_agg(tool, n) from (select tool, count(*) n from k where status = 'chargedback' and at >= v_m0 group by tool) x) as cb_by_tool
      from k
  ), paid as (
    select count(*) as n from public.kiwify_sales_snapshot s join public.kiwify_products p on p.id = s.product_id
     where p.tool_id is not null and s.status = 'paid' and s.sale_created_at >= v_m0
  )
  insert into _a
  select 'ref:' || v_ym, 'reembolsos',
         case when ref_cur >= 10 and ref_cur > ref_prev * 1.6 then 'critical'
              when ref_cur >= 5 and ref_cur > ref_prev * 1.3 then 'warning'
              when ref_prev >= 5 and ref_cur < ref_prev * 0.8 then 'good' else 'info' end,
         ref_cur || ' reembolsos em ' || v_cur_m || ' (' || public.alert_pct(ref_cur, ref_prev) || ' vs. ' || v_prev_m || ')',
         public.alert_brl(ref_cur_val) || ' devolvidos de 1 a ' || extract(day from v_local)::int || ', contra ' || ref_prev || ' reembolsos no mesmo período de ' || v_prev_m ||
           '. ' || paid.n || ' vendas pagas no mês' || case when paid.n > 0 then ' (reembolsos = ' || translate(to_char(round(ref_cur * 100.0 / paid.n, 1), 'FM990.0'), '.', ',') || '% delas)' else '' end || '.',
         jsonb_build_object('cur', ref_cur, 'prev', ref_prev, 'cur_value', ref_cur_val, 'paid', paid.n, 'by_tool', coalesce(ref_by_tool, '{}'::jsonb)),
         200
    from m, paid
  union all
  select 'cb:' || v_ym, 'reembolsos',
         case when cb_cur >= 3 and cb_cur > cb_prev then 'critical' else 'warning' end,
         cb_cur || case when cb_cur = 1 then ' chargeback' else ' chargebacks' end || ' em ' || v_cur_m,
         public.alert_brl(cb_cur_val) || ' contestados no cartão de 1 a ' || extract(day from v_local)::int || ' (' || cb_prev || ' no mesmo período de ' || v_prev_m || '). Chargeback conta contra a conta na Kiwify: vale olhar cada um.',
         jsonb_build_object('cur', cb_cur, 'prev', cb_prev, 'cur_value', cb_cur_val, 'by_tool', coalesce(cb_by_tool, '{}'::jsonb)),
         201
    from m where cb_cur > 0
  union all
  select 'refspike:' || v_today, 'reembolsos', 'critical',
         ref_24h || ' reembolsos nas últimas 24 horas',
         'A média dos últimos 30 dias é ' || translate(to_char(ref_avg, 'FM990.0'), '.', ',') || ' por dia. A maior parte é de vendas feitas em ' || ref_24h_sale || '. Vale ver se há algum problema no produto, na cobrança ou na entrega.',
         jsonb_build_object('last24h', ref_24h, 'daily_avg', round(ref_avg, 2), 'sale_day', ref_24h_sale),
         199
    from m where ref_24h >= 3 and ref_24h >= ref_avg * 2.5;

  -- Meses já fechados que mudaram na Kiwify (tabela revenue_alerts, ainda não vistos).
  insert into _a
  select 'revchg:open', 'reembolsos', 'warning',
         count(*) || case when count(*) = 1 then ' mês fechado mudou na Kiwify' else ' meses fechados mudaram na Kiwify' end,
         'Detalhes no topo da Home: ' || string_agg(distinct coalesce(product_name, product_id) || ' ' || lpad(month::text, 2, '0') || '/' || year, ', ') || '.',
         jsonb_build_object('n', count(*)),
         202
    from public.revenue_alerts where seen_at is null
  having count(*) > 0;

  /* ---------------- afiliados (só produtos das ferramentas) ---------------- */
  with s as (
    select a.affiliate_email as email, max(btrim(a.affiliate_name)) as name,
           count(*) filter (where a.sale_created_at >= v_m0) as cur_n,
           coalesce(sum(a.net_amount) filter (where a.sale_created_at >= v_m0), 0) as cur_net,
           count(*) filter (where a.sale_created_at >= v_p0 and a.sale_created_at < v_pnow) as prev_n,
           count(*) filter (where a.sale_created_at >= v_now - interval '7 days') as last7,
           count(*) filter (where a.sale_created_at >= v_now - interval '21 days' and a.sale_created_at < v_now - interval '7 days') as prev14
      from public.affiliate_sales a
      join public.kiwify_products p on p.id = a.product_id and p.tool_id is not null
     where a.status = 'paid' and a.affiliate_email is not null and a.sale_created_at >= least(v_p0, v_now - interval '21 days')
     group by a.affiliate_email
  )
  insert into _a
  select 'aff:up:' || email || ':' || v_ym, 'afiliados', 'good',
         coalesce(name, email) || ' subiu: ' || cur_n || ' vendas em ' || v_cur_m || ' (' || public.alert_pct(cur_n, prev_n) || ')',
         prev_n || ' vendas no mesmo período de ' || v_prev_m || '. Líquido no mês: ' || public.alert_brl(cur_net) || '.',
         jsonb_build_object('email', email, 'cur_n', cur_n, 'prev_n', prev_n, 'cur_net', cur_net), 300
    from s where cur_n >= 10 and prev_n >= 5 and cur_n >= prev_n * 1.5
  union all
  select 'aff:down:' || email || ':' || v_ym, 'afiliados', 'warning',
         coalesce(name, email) || ' caiu: ' || cur_n || ' vendas em ' || v_cur_m || ' (' || public.alert_pct(cur_n, prev_n) || ')',
         prev_n || ' vendas no mesmo período de ' || v_prev_m || '.',
         jsonb_build_object('email', email, 'cur_n', cur_n, 'prev_n', prev_n), 301
    from s where prev_n >= 10 and cur_n <= prev_n * 0.5
  union all
  select 'aff:stop:' || email, 'afiliados', 'warning',
         coalesce(name, email) || ' parou de vender',
         'Nenhuma venda nos últimos 7 dias, depois de ' || prev14 || ' vendas nas duas semanas anteriores.',
         jsonb_build_object('email', email, 'last7', last7, 'prev14', prev14), 302
    from s where prev14 >= 6 and last7 = 0;

  insert into _a
  select 'aff:top:' || v_ym, 'afiliados', 'info',
         'Top afiliados de ' || v_cur_m || ': ' || string_agg(coalesce(name, email) || ' (' || cur_n || ')', ', ' order by cur_n desc),
         'Vendas pagas das ferramentas Flow de 1 a ' || extract(day from v_local)::int || ' de ' || v_cur_m || ', com a variação contra o mesmo período de ' || v_prev_m || ': ' ||
           string_agg(coalesce(name, email) || ' ' || public.alert_pct(cur_n, prev_n), ' · ' order by cur_n desc) || '.',
         jsonb_build_object('top', jsonb_agg(jsonb_build_object('name', coalesce(name, email), 'cur_n', cur_n, 'prev_n', prev_n, 'cur_net', cur_net) order by cur_n desc)),
         310
    from (
      select a.affiliate_email as email, max(btrim(a.affiliate_name)) as name,
             count(*) filter (where a.sale_created_at >= v_m0) as cur_n,
             count(*) filter (where a.sale_created_at < v_pnow and a.sale_created_at >= v_p0) as prev_n,
             coalesce(sum(a.net_amount) filter (where a.sale_created_at >= v_m0), 0) as cur_net
        from public.affiliate_sales a
        join public.kiwify_products p on p.id = a.product_id and p.tool_id is not null
       where a.status = 'paid' and a.affiliate_email is not null and a.sale_created_at >= v_p0
       group by a.affiliate_email
       order by 3 desc
       limit 5
    ) t
   where cur_n > 0
  having count(*) > 0;

  /* ---------------- influencers: entregas do contrato ---------------- */
  -- Ciclos do contrato (1 mês a partir da data de assinatura: 18/10 a 17/11, 18/11 a 17/12...): o atual e o anterior (fechado). Contagem = o maior entre o lançado à mão e o detectado:
  -- stories que citam a Flow e reels com "Flow ..." na legenda (Instagram conectado no Portal) e vídeos longos do
  -- YouTube com "flow" no título (o ajuste manual do YouTube, se houver, vale sozinho, como no painel de Afiliados).
  with mo as (
    select c.id, c.affiliate_email, coalesce(nullif(btrim(af.name), ''), c.affiliate_email) as name,
           c.stories_per_month, c.reels_per_month, c.youtube_per_month, c.start_date, c.end_date,
           c.bonus_sales_target,
           k.cs as m_start, k.ce as m_next, k.cs as w_start,
           least(coalesce(c.end_date, k.ce - 1), k.ce - 1) as w_end
      from public.influencer_contracts c
      left join public.affiliates af on af.email = c.affiliate_email
      cross join lateral (
      select x.cs, x.ce from (
        select (c.start_date + make_interval(months => g))::date as cs, (c.start_date + make_interval(months => g + 1))::date as ce
          from generate_series(greatest(0, (extract(year from age(v_today, c.start_date)) * 12 + extract(month from age(v_today, c.start_date)))::int - 1),
                               (extract(year from age(v_today, c.start_date)) * 12 + extract(month from age(v_today, c.start_date)))::int + 1) g
      ) x where x.cs <= v_today order by x.cs desc limit 2) k
     where c.active and c.start_date <= v_today
       and (c.end_date is null or c.end_date >= k.cs)
  ), cnt as (
    select mo.*,
           greatest(coalesce(d.stories_done, 0),
             (select count(*) from public.instagram_stories s where s.affiliate_email = mo.affiliate_email and s.mentions_flow
                 and (s.posted_at at time zone tz)::date >= mo.m_start and (s.posted_at at time zone tz)::date < mo.m_next)) as stories,
           greatest(coalesce(d.reels_done, 0),
             (select count(*) from public.instagram_media x where x.affiliate_email = mo.affiliate_email and x.media_product_type = 'REELS'
                 and x.caption ~* 'flow[[:space:]_.-]*(pages?|track(ing)?|spy)'
                 and (x.posted_at at time zone tz)::date >= mo.m_start and (x.posted_at at time zone tz)::date < mo.m_next)) as reels,
           coalesce(d.youtube_done,
             (select count(*) from public.youtube_videos v join public.youtube_channels ch on ch.channel_id = v.channel_id
               where ch.affiliate_email = mo.affiliate_email and v.title ~* 'flow'
                 and not coalesce(v.is_short, v.duration_s is not null and v.duration_s <= 180)
                 and (v.published_at at time zone tz)::date >= mo.m_start and (v.published_at at time zone tz)::date < mo.m_next))::int as youtube,
           (mo.m_next <= v_today) as closed,
           (mo.w_end - v_today) as days_left,
           least(1.0, greatest(0.0, (v_today - mo.w_start + 1)::numeric / greatest(1, mo.w_end - mo.w_start + 1))) as f
      from mo
      left join public.influencer_deliverables d on d.contract_id = mo.id
            and d.year = extract(year from mo.m_start)::int and d.month = extract(month from mo.m_start)::int
  ), ev as (
    select cnt.*,
           -- gravidade por item: 2 = crítico, 1 = atenção, 0 = em dia
           case when stories >= stories_per_month then 0
                when closed then 2
                when days_left <= 5 and stories < stories_per_month * 0.8 then 2
                when f >= 0.3 and stories < floor(stories_per_month * f) - 1 then 1 else 0 end as s_lvl,
           case when reels >= reels_per_month then 0 when closed or days_left <= 3 then 2 when days_left <= 7 then 1 else 0 end as r_lvl,
           case when youtube >= youtube_per_month then 0 when closed or days_left <= 3 then 2 when days_left <= 7 then 1 else 0 end as y_lvl
      from cnt
  )
  insert into _a
  select 'inf:' || id || ':' || to_char(m_start, 'YYYY-MM'), 'influencers',
         case when greatest(s_lvl, r_lvl, y_lvl) = 2 then 'critical' else 'warning' end,
         name || case when closed then ': entregas pendentes do ciclo ' else ': entregas atrasadas no ciclo ' end
              || to_char(m_start, 'DD/MM') || ' a ' || to_char(w_end, 'DD/MM'),
         concat_ws(' · ',
           case when stories_per_month > 0 then 'Stories ' || stories || '/' || stories_per_month ||
             case when not closed and stories < stories_per_month then ' (o ritmo pede ~' || floor(stories_per_month * f)::int || ' até hoje)' else '' end end,
           case when reels_per_month > 0 then 'Reels ' || reels || '/' || reels_per_month end,
           case when youtube_per_month > 0 then 'YouTube ' || youtube || '/' || youtube_per_month end)
           || case when closed then '. O ciclo já fechou.' else '. Faltam ' || days_left || case when days_left = 1 then ' dia' else ' dias' end || ' para fechar o ciclo (' || to_char(w_end, 'DD/MM') || ').' end,
         jsonb_build_object('contract_id', id, 'email', affiliate_email, 'month', to_char(m_start, 'YYYY-MM'), 'cycle_start', m_start, 'cycle_end', w_end, 'closed', closed, 'days_left', days_left,
                            'stories', stories, 'stories_need', stories_per_month, 'reels', reels, 'reels_need', reels_per_month,
                            'youtube', youtube, 'youtube_need', youtube_per_month),
         case when closed then 400 else 401 end
    from ev
   where greatest(s_lvl, r_lvl, y_lvl) > 0;

  -- Contratos que terminam nos próximos 15 dias (com o progresso até o bônus).
  insert into _a
  select 'inf:end:' || c.id, 'influencers', 'info',
         coalesce(nullif(btrim(af.name), ''), c.affiliate_email) || ': contrato termina em ' || to_char(c.end_date, 'DD/MM'),
         'Faltam ' || (c.end_date - v_today) || ' dias. Vendas no contrato: ' || coalesce(v.n, 0) || ' de ' || c.bonus_sales_target || ' para o bônus de ' || public.alert_brl(c.bonus_amount) || '. Hora de decidir se renova.',
         jsonb_build_object('contract_id', c.id, 'end_date', c.end_date, 'sales', coalesce(v.n, 0), 'target', c.bonus_sales_target),
         410
    from public.influencer_contracts c
    left join public.affiliates af on af.email = c.affiliate_email
    left join lateral (
      select count(*) n from public.affiliate_sales a join public.kiwify_products p on p.id = a.product_id and p.tool_id is not null
       where a.affiliate_email = c.affiliate_email and a.status = 'paid'
         and a.sale_created_at >= (c.start_date::timestamp at time zone tz) and a.sale_created_at < ((c.end_date + 1)::timestamp at time zone tz)
    ) v on true
   where c.active and c.end_date is not null and c.end_date >= v_today and c.end_date <= v_today + 15;

  /* ---------------- Instagram @useaflow ---------------- */
  with w as (
    select coalesce(sum(views) filter (where day between v_today - 7 and v_today - 1), 0) as cur,
           coalesce(sum(views) filter (where day between v_today - 14 and v_today - 8), 0) as prev,
           coalesce(sum(reach) filter (where day between v_today - 7 and v_today - 1), 0) as reach_cur,
           coalesce(sum(new_followers) filter (where day between v_today - 7 and v_today - 1), 0) as new_cur
      from public.ig_account_daily where day >= v_today - 14
  )
  insert into _a
  select 'ig:views:' || v_week, 'instagram',
         case when cur <= prev * 0.6 then 'warning' else 'good' end,
         '@useaflow: ' || cur || ' views nos últimos 7 dias (' || public.alert_pct(cur, prev) || ')',
         'Na semana anterior foram ' || prev || ' views. Alcance dos últimos 7 dias: ' || reach_cur || ' contas; novos seguidores: ' || new_cur || '.',
         jsonb_build_object('cur', cur, 'prev', prev, 'reach', reach_cur, 'new_followers', new_cur), 500
    from w where (prev >= 300 and cur <= prev * 0.6) or (cur >= 300 and cur >= prev * 1.5);

  with f as (
    select (select followers_count from public.ig_account_daily where followers_count is not null order by day desc limit 1) as now_n,
           (select followers_count from public.ig_account_daily where followers_count is not null and day <= v_today - 6 order by day desc limit 1) as old_n,
           (select day from public.ig_account_daily where followers_count is not null and day <= v_today - 6 order by day desc limit 1) as old_day
  )
  insert into _a
  select 'ig:fol:' || v_week, 'instagram',
         case when now_n - old_n <= -10 then 'warning' when now_n - old_n < 0 then 'info' else 'good' end,
         '@useaflow ' || case when now_n >= old_n then 'ganhou ' else 'perdeu ' end || abs(now_n - old_n) || ' seguidores na semana',
         'Eram ' || old_n || ' em ' || to_char(old_day, 'DD/MM') || ', agora são ' || now_n || '.',
         jsonb_build_object('now', now_n, 'before', old_n, 'since', old_day), 501
    from f where now_n is not null and old_n is not null and (now_n - old_n < 0 or now_n - old_n >= 20);

  insert into _a
  select 'ig:post:' || m.id, 'instagram', 'good',
         'Post do @useaflow acima da média: ' || m.views || ' views',
         coalesce(left(regexp_replace(m.caption, '\s+', ' ', 'g'), 90), 'sem legenda') || ' · ' ||
           round(m.views / greatest(1, b.med))::int || 'x a mediana dos posts dos últimos 90 dias (' || round(b.med)::int || ' views).',
         jsonb_build_object('id', m.id, 'permalink', m.permalink, 'views', m.views, 'median', round(b.med)), 502
    from public.ig_media m,
         (select percentile_cont(0.5) within group (order by views) as med from public.ig_media
           where views is not null and posted_at >= v_now - interval '90 days') b
   where m.posted_at >= v_now - interval '10 days' and m.views is not null and b.med > 0
     and m.views >= 500 and m.views >= b.med * 2;

  /* ---------------- sistema: sincronizações paradas ---------------- */
  insert into _a
  select 'sync:kiwify-revenue', 'sistema', 'critical', 'Vendas por ferramenta sem atualizar há ' || floor(extract(epoch from v_now - m) / 3600)::int || ' horas',
         'A última leitura da Kiwify (kiwify-revenue) foi em ' || to_char(m at time zone tz, 'DD/MM HH24:MI') || '. Os avisos de faturamento podem estar desatualizados.',
         jsonb_build_object('last', m), 900
    from (select max(synced_at) m from public.kiwify_sales_snapshot) x where m < v_now - interval '3 hours'
  union all
  select 'sync:kiwify-affiliates', 'sistema', 'critical', 'Vendas de afiliados sem atualizar há ' || floor(extract(epoch from v_now - m) / 3600)::int || ' horas',
         'A última leitura da Kiwify (kiwify-sync) foi em ' || to_char(m at time zone tz, 'DD/MM HH24:MI') || '.',
         jsonb_build_object('last', m), 901
    from (select max(synced_at) m from public.affiliate_sales) x where m < v_now - interval '3 hours'
  union all
  select 'sync:instagram-own', 'sistema', 'warning', 'Instagram do @useaflow sem atualizar há ' || floor(extract(epoch from v_now - m) / 3600)::int || ' horas',
         'A última leitura (instagram-own) foi em ' || to_char(m at time zone tz, 'DD/MM HH24:MI') || '. Pode ser o token da Meta.',
         jsonb_build_object('last', m), 902
    from (select max(fetched_at) m from public.ig_account_daily) x where m < v_now - interval '26 hours';

  /* ---------------- grava ---------------- */
  insert into public.alerts as al (key, category, severity, title, body, data, sort)
  select key, category, severity, title, body, data, sort from _a
  on conflict (key) do update
     set category = excluded.category, title = excluded.title, body = excluded.body, data = excluded.data, sort = excluded.sort,
         updated_at = now(), resolved_at = null,
         seen_at = case when al.severity is distinct from excluded.severity or al.resolved_at is not null then null else al.seen_at end,
         seen_by = case when al.severity is distinct from excluded.severity or al.resolved_at is not null then null else al.seen_by end,
         severity = excluded.severity;
  get diagnostics v_upd = row_count;

  update public.alerts set resolved_at = now()
   where resolved_at is null and not exists (select 1 from _a where _a.key = alerts.key);
  get diagnostics v_res = row_count;

  delete from public.alerts where resolved_at < now() - interval '90 days';

  return jsonb_build_object('ok', true, 'active', v_upd, 'resolved', v_res, 'at', v_now);
end $$;

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
      'metas_por_ciclo', jsonb_build_object('stories', c.stories_per_month, 'reels', c.reels_per_month, 'youtube', c.youtube_per_month));

    -- Ciclos de entrega: 1 mês a partir da data de assinatura (o atual e o anterior).
    with mo as (
      select k.cs as m_start, k.ce as m_next, k.cs as w_start,
             least(coalesce(c.end_date, k.ce - 1), k.ce - 1) as w_end
        from (select 1) one
        cross join lateral (
        select x.cs, x.ce from (
          select (c.start_date + make_interval(months => g))::date as cs, (c.start_date + make_interval(months => g + 1))::date as ce
            from generate_series(greatest(0, (extract(year from age(v_today, c.start_date)) * 12 + extract(month from age(v_today, c.start_date)))::int - 1),
                                 (extract(year from age(v_today, c.start_date)) * 12 + extract(month from age(v_today, c.start_date)))::int + 1) g
        ) x where x.cs <= v_today order by x.cs desc limit 2) k
       where c.start_date <= v_today and (c.end_date is null or c.end_date >= k.cs)
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'mes', 'ciclo de ' || to_char(mo.m_start, 'DD/MM') || ' a ' || to_char(mo.w_end, 'DD/MM'),
             'inicio_ciclo', mo.m_start, 'fim_ciclo', mo.w_end,
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

revoke all on function public.generate_alerts() from public, anon;
grant execute on function public.generate_alerts() to authenticated, service_role;
grant execute on function public.influencer_analysis_facts(text) to authenticated, service_role;
