-- Avisos: o que está acontecendo no negócio, calculado por regras fixas aqui no banco.
--
-- public.generate_alerts() roda as regras e grava em public.alerts (uma linha por aviso, chave estável em `key`):
--   faturamento  · cada ferramenta e o total: mês atual até agora contra o mês passado até o mesmo ponto
--   reembolsos   · reembolsos e chargebacks do mês contra o mês passado, pico nas últimas 24 h e meses fechados que mudaram
--   afiliados    · quem subiu ou caiu forte, quem parou de vender e o ranking do mês (só produtos das ferramentas)
--   influencers  · entregas do contrato (stories, reels, YouTube) atrasadas no mês atual ou pendentes no mês fechado,
--                  e contratos perto do fim
--   instagram    · views e seguidores do @useaflow na semana e post muito acima da média
--   sistema      · sincronização da Kiwify ou do Instagram parada
-- Aviso que deixa de valer fica com resolved_at preenchido (some da lista de abertos). Aviso que muda de gravidade
-- volta a aparecer como não visto.
--
-- O resumo escrito pela IA fica em public.alert_digests (Edge Function alerts-digest, que também manda no Telegram).
-- Menu: fin.avisos (public.can).

create table if not exists public.alerts (
  id             uuid primary key default gen_random_uuid(),
  key            text not null unique,
  category       text not null,
  severity       text not null check (severity in ('critical', 'warning', 'info', 'good')),
  title          text not null,
  body           text,
  data           jsonb not null default '{}'::jsonb,
  sort           integer not null default 0,
  first_seen_at  timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  seen_at        timestamptz,
  seen_by        uuid
);
create index if not exists alerts_open_idx on public.alerts (updated_at desc) where resolved_at is null;

create table if not exists public.alert_digests (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  text          text not null,
  source        text not null default 'ai',   -- ai | regras (sem chave da IA ou falha)
  model         text,
  alerts_count  integer not null default 0,
  telegram      boolean not null default false,
  note          text
);
create index if not exists alert_digests_created_idx on public.alert_digests (created_at desc);

alter table public.alerts        enable row level security;
alter table public.alert_digests enable row level security;
drop policy if exists menu_read on public.alerts;
drop policy if exists menu_read on public.alert_digests;
create policy menu_read on public.alerts        for select to authenticated using ((select public.can(array['fin.avisos'])));
create policy menu_read on public.alert_digests for select to authenticated using ((select public.can(array['fin.avisos'])));

-- Marcar como visto / não visto (a tabela não abre para escrita direta).
create or replace function public.alert_set_seen(p_id uuid, p_seen boolean)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v timestamptz;
begin
  if not public.can(array['fin.avisos']) then raise exception 'sem permissão'; end if;
  update public.alerts
     set seen_at = case when p_seen then now() end,
         seen_by = case when p_seen then auth.uid() end
   where id = p_id
  returning seen_at into v;
  return v;
end $$;

-- Formatação em pt-BR para os textos dos avisos.
create or replace function public.alert_brl(v numeric) returns text
language sql immutable set search_path = '' as $$
  select 'R$ ' || translate(to_char(coalesce(v, 0), 'FM999,999,999,990.00'), ',.', '.,');
$$;
create or replace function public.alert_pct(cur numeric, prev numeric) returns text
language sql immutable set search_path = '' as $$
  select case when coalesce(prev, 0) = 0 then 'sem base no mês passado'
              else (case when cur >= prev then '+' else '' end) || translate(to_char(round((cur / prev - 1) * 100, 1), 'FM999990.0'), '.', ',') || '%' end;
$$;

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
  -- Meses do contrato: o atual e o anterior (fechado). Contagem = o maior entre o lançado à mão e o detectado:
  -- stories que citam a Flow e reels com "Flow ..." na legenda (Instagram conectado no Portal) e vídeos longos do
  -- YouTube com "flow" no título (o ajuste manual do YouTube, se houver, vale sozinho, como no painel de Afiliados).
  with mo as (
    select c.id, c.affiliate_email, coalesce(nullif(btrim(af.name), ''), c.affiliate_email) as name,
           c.stories_per_month, c.reels_per_month, c.youtube_per_month, c.start_date, c.end_date,
           c.bonus_sales_target,
           m.ms::date as m_start, (m.ms + interval '1 month')::date as m_next,
           greatest(c.start_date, m.ms::date) as w_start,
           least(coalesce(c.end_date, (m.ms + interval '1 month - 1 day')::date), (m.ms + interval '1 month - 1 day')::date) as w_end
      from public.influencer_contracts c
      left join public.affiliates af on af.email = c.affiliate_email
      cross join lateral (values (date_trunc('month', v_local)), (date_trunc('month', v_local) - interval '1 month')) m(ms)
     where c.active and c.start_date <= v_today
       and c.start_date < (m.ms + interval '1 month')::date
       and (c.end_date is null or c.end_date >= m.ms::date)
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
         name || case when closed then ': entregas pendentes de ' || meses[extract(month from m_start)::int]
                      else ': entregas atrasadas em ' || meses[extract(month from m_start)::int] end,
         concat_ws(' · ',
           case when stories_per_month > 0 then 'Stories ' || stories || '/' || stories_per_month ||
             case when not closed and stories < stories_per_month then ' (o ritmo pede ~' || floor(stories_per_month * f)::int || ' até hoje)' else '' end end,
           case when reels_per_month > 0 then 'Reels ' || reels || '/' || reels_per_month end,
           case when youtube_per_month > 0 then 'YouTube ' || youtube || '/' || youtube_per_month end)
           || case when closed then '. O mês já fechou.' else '. Faltam ' || days_left || case when days_left = 1 then ' dia' else ' dias' end || ' para fechar o mês' ||
                case when w_start > m_start then ' (contrato começou em ' || to_char(w_start, 'DD/MM') || ')' else '' end || '.' end,
         jsonb_build_object('contract_id', id, 'email', affiliate_email, 'month', to_char(m_start, 'YYYY-MM'), 'closed', closed, 'days_left', days_left,
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

revoke all on function public.generate_alerts() from public, anon;
revoke all on function public.alert_set_seen(uuid, boolean) from public, anon;
grant execute on function public.generate_alerts() to authenticated, service_role;
grant execute on function public.alert_set_seen(uuid, boolean) to authenticated;

-- Regras a cada 30 minutos (só SQL, sem custo). O resumo da IA + Telegram roda às 8h de Brasília (11h UTC).
select cron.unschedule('alerts-generate') where exists (select 1 from cron.job where jobname = 'alerts-generate');
select cron.schedule('alerts-generate', '3,33 * * * *', $$ select public.generate_alerts(); $$);

select cron.unschedule('alerts-digest') where exists (select 1 from cron.job where jobname = 'alerts-digest');
select cron.schedule(
  'alerts-digest',
  '0 11 * * *',
  $$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/alerts-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')
    ),
    body := '{"telegram": true}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
