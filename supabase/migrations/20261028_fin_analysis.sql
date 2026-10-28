-- Análise da IA na Home do Financeiro.
--
-- public.fin_analysis_facts() calcula os números (o banco faz todas as contas; a IA só interpreta):
--   períodos  · mês atual até agora × mês anterior até o mesmo ponto × mesmo mês do ano passado até o mesmo ponto
--             · mês anterior fechado × o mesmo mês no ano passado
--             · ano atual até hoje × ano passado até o mesmo dia
--   por ferramenta e total: vendas pagas, líquido, ticket médio, reembolsos e chargebacks (contados pela data em que
--             aconteceram), valor reembolsado e vendas por afiliado
--   despesas  · meses fechados (mês anterior, mesmo mês do ano passado, ano até o mês fechado) e o resultado
--   projeção  · mês atual no ritmo de agora
-- Vendas vêm de kiwify_sales_snapshot (status atual de cada venda: uma venda paga que foi reembolsada depois conta
-- como reembolso, não como venda) e despesas de monthly_expenses.
--
-- A Edge Function fin-analysis lê esses números, pede o texto ao Claude (Haiku) e guarda em public.fin_analyses.
-- Menu: fin.financeiro.

create table if not exists public.fin_analyses (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  text        text,                 -- null = sem IA (a tela mostra só a tabela de comparativos)
  source      text not null default 'ai',
  model       text,
  facts       jsonb not null,
  note        text
);
create index if not exists fin_analyses_created_idx on public.fin_analyses (created_at desc);
alter table public.fin_analyses enable row level security;
drop policy if exists menu_read on public.fin_analyses;
create policy menu_read on public.fin_analyses for select to authenticated using ((select public.can(array['fin.financeiro'])));

create or replace function public.fin_analysis_facts() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  tz      constant text := 'America/Sao_Paulo';
  meses   constant text[] := array['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  v_now   timestamptz := now();
  v_local timestamp := now() at time zone 'America/Sao_Paulo';
  m0 timestamp; p0 timestamp; y0 timestamp;
  v_day int; v_mdays int;
  v_per jsonb; v_sales jsonb; v_exp jsonb; v_proj jsonb; v_months jsonb;
  pm int; py int;   -- mês anterior fechado
begin
  if auth.uid() is not null and not public.can(array['fin.financeiro']) then raise exception 'sem permissão'; end if;

  m0 := date_trunc('month', v_local);
  p0 := m0 - interval '1 month';
  y0 := date_trunc('year', v_local);
  v_day := extract(day from v_local)::int;
  v_mdays := extract(day from (m0 + interval '1 month - 1 day'))::int;
  pm := extract(month from p0)::int; py := extract(year from p0)::int;

  -- Períodos (horário de Brasília). "Mesmo ponto" = mesma data e hora no mês/ano de comparação.
  create temp table if not exists _per (key text primary key, label text, a timestamptz, b timestamptz) on commit drop;
  truncate _per;
  insert into _per values
    ('mes_atual',               meses[extract(month from m0)::int] || '/' || extract(year from m0) || ' (1 a ' || v_day || ')',
                                m0 at time zone tz, v_now),
    ('mes_anterior_mesmo_ponto', meses[pm] || '/' || py || ' (1 a ' || v_day || ')',
                                p0 at time zone tz, (v_local - interval '1 month') at time zone tz),
    ('mes_atual_ano_passado',   meses[extract(month from m0)::int] || '/' || (extract(year from m0) - 1) || ' (1 a ' || v_day || ')',
                                (m0 - interval '1 year') at time zone tz, (v_local - interval '1 year') at time zone tz),
    ('mes_anterior_fechado',    meses[pm] || '/' || py || ' (mês inteiro)', p0 at time zone tz, m0 at time zone tz),
    ('mes_anterior_ano_passado', meses[pm] || '/' || (py - 1) || ' (mês inteiro)',
                                (p0 - interval '1 year') at time zone tz, (m0 - interval '1 year') at time zone tz),
    ('ano_atual',               extract(year from y0) || ' até ' || to_char(v_local, 'DD/MM'), y0 at time zone tz, v_now),
    ('ano_passado_mesmo_ponto', (extract(year from y0) - 1) || ' até ' || to_char(v_local, 'DD/MM'),
                                (y0 - interval '1 year') at time zone tz, (v_local - interval '1 year') at time zone tz);

  select jsonb_object_agg(key, jsonb_build_object('label', label, 'de', a, 'ate', b)) into v_per from _per;

  -- Vendas, reembolsos e chargebacks por período e ferramenta (+ Total).
  with s as (
    select t.name as tool, k.status, k.net_amount, k.sale_created_at, k.refunded_at, k.kiwify_updated_at,
           exists (select 1 from public.affiliate_sales a where a.id = k.id and a.affiliate_email is not null) as afiliado
      from public.kiwify_sales_snapshot k
      join public.kiwify_products p on p.id = k.product_id
      join public.tools t on t.id = p.tool_id
     where k.sale_created_at >= (y0 - interval '1 year') at time zone tz
        or k.refunded_at >= (y0 - interval '1 year') at time zone tz
  ), agg as (
    select per.key, coalesce(s.tool, 'Total') as tool,
           count(*) filter (where s.status = 'paid' and s.sale_created_at >= per.a and s.sale_created_at < per.b) as vendas,
           coalesce(sum(s.net_amount) filter (where s.status = 'paid' and s.sale_created_at >= per.a and s.sale_created_at < per.b), 0) as liquido,
           count(*) filter (where s.status = 'paid' and s.sale_created_at >= per.a and s.sale_created_at < per.b
                              and s.afiliado) as vendas_afiliados,
           count(*) filter (where s.status = 'refunded' and s.refunded_at >= per.a and s.refunded_at < per.b) as reembolsos,
           coalesce(sum(s.net_amount) filter (where s.status = 'refunded' and s.refunded_at >= per.a and s.refunded_at < per.b), 0) as valor_reembolsos,
           count(*) filter (where s.status = 'chargedback' and coalesce(s.refunded_at, s.kiwify_updated_at) >= per.a
                              and coalesce(s.refunded_at, s.kiwify_updated_at) < per.b) as chargebacks
      from _per per cross join s
     group by grouping sets ((per.key, s.tool), (per.key))
  )
  select jsonb_object_agg(key, tools) into v_sales from (
    select key, jsonb_object_agg(tool, jsonb_build_object(
             'vendas', vendas, 'liquido', round(liquido, 2), 'ticket_medio', case when vendas > 0 then round(liquido / vendas, 2) end,
             'vendas_afiliados', vendas_afiliados, 'reembolsos', reembolsos, 'valor_reembolsos', round(valor_reembolsos, 2),
             'chargebacks', chargebacks,
             'taxa_reembolso', case when vendas > 0 then round(reembolsos::numeric / vendas, 4) end)) as tools
      from agg group by key
  ) x;

  -- Despesas e resultado dos meses fechados (o mês atual ainda está aberto).
  with e as (
    select coalesce(t.name, 'Sem ferramenta') as tool, x.year, x.month, sum(x.amount) as amount
      from public.monthly_expenses x left join public.tools t on t.id = x.tool_id
     where x.year >= py - 1
     group by 1, 2, 3
  ), sel as (
    select 'mes_anterior_fechado' as key, tool, sum(amount) amount from e where year = py and month = pm group by tool
    union all
    select 'mes_anterior_ano_passado', tool, sum(amount) from e where year = py - 1 and month = pm group by tool
    union all
    select 'ano_atual_meses_fechados', tool, sum(amount) from e where year = extract(year from y0) and month < extract(month from m0) group by tool
    union all
    select 'ano_passado_mesmos_meses', tool, sum(amount) from e where year = extract(year from y0) - 1 and month < extract(month from m0) group by tool
  )
  select jsonb_object_agg(key, v) into v_exp from (
    select key, jsonb_object_agg(tool, round(amount, 2)) || jsonb_build_object('Total', round(sum(amount), 2)) as v from sel group by key
  ) z;

  -- Resultado (líquido de vendas − despesas) dos meses fechados do ano, mês a mês, e o mesmo mês do ano passado.
  with m as (
    select gs::date as ms from generate_series(y0 - interval '1 year', m0 - interval '1 month', interval '1 month') gs
  )
  select jsonb_agg(jsonb_build_object(
           'mes', to_char(m.ms, 'YYYY-MM'),
           'vendas', (select count(*) from public.kiwify_sales_snapshot k join public.kiwify_products p on p.id = k.product_id
                       where p.tool_id is not null and k.status = 'paid'
                         and k.sale_created_at >= m.ms::timestamp at time zone tz and k.sale_created_at < (m.ms + interval '1 month')::timestamp at time zone tz),
           'liquido', (select round(coalesce(sum(k.net_amount), 0), 2) from public.kiwify_sales_snapshot k join public.kiwify_products p on p.id = k.product_id
                       where p.tool_id is not null and k.status = 'paid'
                         and k.sale_created_at >= m.ms::timestamp at time zone tz and k.sale_created_at < (m.ms + interval '1 month')::timestamp at time zone tz),
           'reembolsos', (select count(*) from public.kiwify_sales_snapshot k join public.kiwify_products p on p.id = k.product_id
                       where p.tool_id is not null and k.status = 'refunded'
                         and k.refunded_at >= m.ms::timestamp at time zone tz and k.refunded_at < (m.ms + interval '1 month')::timestamp at time zone tz),
           'despesas', (select round(coalesce(sum(x.amount), 0), 2) from public.monthly_expenses x
                         where x.year = extract(year from m.ms) and x.month = extract(month from m.ms)))
         order by m.ms) into v_months
    from m;

  -- Projeção do mês atual no ritmo de agora.
  select jsonb_object_agg(tool, jsonb_build_object(
           'liquido', round((v->>'liquido')::numeric / greatest(extract(epoch from v_now - (m0 at time zone tz)) / 86400.0, 1) * v_mdays, 2),
           'vendas', round((v->>'vendas')::numeric / greatest(extract(epoch from v_now - (m0 at time zone tz)) / 86400.0, 1) * v_mdays)))
    into v_proj
    from jsonb_each(v_sales->'mes_atual') as j(tool, v);

  return jsonb_build_object(
    'gerado_em', v_now, 'hoje', to_char(v_local, 'DD/MM/YYYY HH24:MI'), 'dia_do_mes', v_day, 'dias_no_mes', v_mdays,
    'periodos', v_per, 'vendas', v_sales, 'despesas', coalesce(v_exp, '{}'::jsonb), 'projecao_mes_atual', v_proj,
    'meses', v_months,
    'ferramentas_inicio', (select jsonb_object_agg(name, revenue_start) from public.tools where active),
    'notas', jsonb_build_array(
      'Vendas = vendas pagas que continuam pagas hoje (valor líquido para o produtor).',
      'Reembolsos e chargebacks contam pela data em que aconteceram, não pela data da venda.',
      'Despesas só de meses fechados; o mês atual ainda não tem todas as despesas.',
      'Ferramenta que ainda não vendia no período de comparação aparece com zero (ver ferramentas_inicio).')
  );
end $$;

revoke all on function public.fin_analysis_facts() from public, anon;
grant execute on function public.fin_analysis_facts() to authenticated, service_role;

-- Análise diária às 8h10 de Brasília (11h10 UTC), depois das sincronizações da madrugada.
select cron.unschedule('fin-analysis') where exists (select 1 from cron.job where jobname = 'fin-analysis');
select cron.schedule(
  'fin-analysis',
  '10 11 * * *',
  $$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/fin-analysis',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
