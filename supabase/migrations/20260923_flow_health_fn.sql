-- flow_health(ano): métricas de saúde das ferramentas Flow, calculadas venda a venda.
--
-- Definições (todas em horário de Brasília):
--   cliente            = e-mail distinto por ferramenta, com pelo menos 1 venda paga
--   cobertura          = data da venda + duração do plano (kiwify_plans.months)
--   ativo              = cobertura da última venda ainda não venceu
--   em carência        = venceu há até 15 dias (ainda pode renovar)
--   cancelou (churn)   = venceu há mais de 15 dias sem nova compra
--   renovação devida   = venda cuja cobertura venceu há mais de 15 dias;
--                        renovou = houve outra venda paga do mesmo cliente até 45 dias após vencer
--   LTV histórico      = receita líquida total ÷ clientes
--   LTV projetado      = ticket líquido médio × pagamentos esperados (1 ÷ (1 − taxa de renovação))
--   MRR                = soma, nos ativos, de (valor líquido do último pagamento ÷ meses do plano)
--   CAC                = (comissão de afiliados das 1ªs compras + marketing lançado) ÷ novos clientes
-- Receita = valor líquido (o mesmo "faturamento" do financeiro); bruto = valor cobrado.
create or replace function public.flow_health(p_year integer)
returns jsonb
language sql stable security invoker set search_path = '' as $$
with
params as (
  select now() as agora,
         make_timestamptz(p_year, 1, 1, 0, 0, 0, 'America/Sao_Paulo') as ano_ini,
         make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'America/Sao_Paulo') as ano_fim,
         interval '15 days' as carencia, interval '45 days' as janela_renov
),
tp as (
  select p.id as product_id, t.id as tool_id, t.name as tool, t.revenue_start
  from public.kiwify_products p join public.tools t on t.id = p.tool_id
),
vendas as (
  select tp.tool_id, tp.tool, s.id, lower(s.customer_email) as email, s.status, s.plan_id,
         coalesce(kp.plan_name, s.plan_name, '(sem plano)') as plan_name,
         coalesce(kp.months, public.guess_plan_months(s.plan_name)) as months,
         coalesce(s.net_amount, 0) as liquido, coalesce(s.charge_amount, 0) as bruto,
         s.sale_created_at as ts, coalesce(a.commission, 0) as comissao
  from public.kiwify_sales_snapshot s
  join tp on tp.product_id = s.product_id
  left join public.kiwify_plans kp on kp.plan_id = s.plan_id
  left join public.affiliate_sales a on a.id = s.id
  where s.customer_email is not null
    and (tp.revenue_start is null or s.sale_created_at >= tp.revenue_start::timestamptz)
),
pagas as (
  select v.*,
         row_number() over (partition by tool_id, email order by ts) as n,
         lead(ts) over (partition by tool_id, email order by ts) as prox_ts,
         ts + make_interval(months => months) as cobre_ate
  from vendas v where status in ('paid', 'approved')
),
clientes as (
  select tool_id, tool, email, min(ts) as primeira, max(ts) as ultima, count(*) as pagamentos,
         sum(liquido) as liquido_total,
         (array_agg(cobre_ate order by ts desc))[1] as cobre_ate,
         (array_agg(liquido / months order by ts desc))[1] as mrr,
         (array_agg(months order by ts desc))[1] as meses_plano
  from pagas group by 1, 2, 3
),
cli_status as (
  select c.*, case
      when c.cobre_ate >= p.agora then 'ativo'
      when c.cobre_ate >= p.agora - p.carencia then 'carencia'
      else 'cancelou' end as situacao
  from clientes c cross join params p
),
renov as (
  select pg.tool_id, pg.months, pg.cobre_ate,
         (pg.prox_ts is not null and pg.prox_ts <= pg.cobre_ate + p.janela_renov) as renovou
  from pagas pg cross join params p
  where pg.cobre_ate < p.agora - p.carencia
),
mkt as (
  select e.tool_id, sum(e.amount) as marketing
  from public.monthly_expenses e join public.expense_categories c on c.id = e.category_id
  where c.group_name = 'Marketing' and e.year = p_year group by 1
),
despesas as (
  select tool_id, sum(amount) as total from public.monthly_expenses where year = p_year group by 1
),
por_ferramenta as (
  select t.tool_id, t.tool,
    (select count(*) from cli_status c where c.tool_id = t.tool_id) as clientes,
    (select count(*) from cli_status c where c.tool_id = t.tool_id and situacao = 'ativo') as ativos,
    (select count(*) from cli_status c where c.tool_id = t.tool_id and situacao = 'carencia') as em_carencia,
    (select count(*) from cli_status c where c.tool_id = t.tool_id and situacao = 'cancelou') as cancelados,
    (select coalesce(sum(mrr), 0) from cli_status c where c.tool_id = t.tool_id and situacao = 'ativo') as mrr,
    (select count(*) from renov r where r.tool_id = t.tool_id) as renov_devidas,
    (select count(*) from renov r where r.tool_id = t.tool_id and renovou) as renovadas,
    (select count(*) from renov r where r.tool_id = t.tool_id and months = 1) as renov_devidas_mensal,
    (select count(*) from renov r where r.tool_id = t.tool_id and months = 1 and renovou) as renovadas_mensal,
    (select count(*) from renov r where r.tool_id = t.tool_id and months >= 12) as renov_devidas_anual,
    (select count(*) from renov r where r.tool_id = t.tool_id and months >= 12 and renovou) as renovadas_anual,
    (select coalesce(avg(pagamentos - 1), 0) from cli_status c where c.tool_id = t.tool_id) as renovacoes_por_cliente,
    (select max(pagamentos) from cli_status c where c.tool_id = t.tool_id) as max_pagamentos,
    (select coalesce(sum(liquido_total), 0) from cli_status c where c.tool_id = t.tool_id) as liquido_total,
    (select count(*) from pagas pg where pg.tool_id = t.tool_id) as pagamentos,
    -- no ano
    (select count(*) from pagas pg, params p where pg.tool_id = t.tool_id and pg.n = 1 and pg.ts >= p.ano_ini and pg.ts < p.ano_fim) as novos_ano,
    (select count(*) from pagas pg, params p where pg.tool_id = t.tool_id and pg.n > 1 and pg.ts >= p.ano_ini and pg.ts < p.ano_fim) as renovacoes_ano,
    (select coalesce(sum(liquido), 0) from pagas pg, params p where pg.tool_id = t.tool_id and pg.ts >= p.ano_ini and pg.ts < p.ano_fim) as liquido_ano,
    (select coalesce(sum(bruto), 0) from pagas pg, params p where pg.tool_id = t.tool_id and pg.ts >= p.ano_ini and pg.ts < p.ano_fim) as bruto_ano,
    (select coalesce(sum(comissao), 0) from pagas pg, params p where pg.tool_id = t.tool_id and pg.n = 1 and pg.ts >= p.ano_ini and pg.ts < p.ano_fim) as comissao_novos_ano,
    (select count(*) from vendas v, params p where v.tool_id = t.tool_id and v.status in ('refunded') and v.ts >= p.ano_ini and v.ts < p.ano_fim) as reembolsos_ano,
    (select count(*) from vendas v, params p where v.tool_id = t.tool_id and v.status in ('chargedback') and v.ts >= p.ano_ini and v.ts < p.ano_fim) as chargebacks_ano,
    (select count(*) from vendas v, params p where v.tool_id = t.tool_id and v.status in ('paid','approved','refunded','chargedback') and v.ts >= p.ano_ini and v.ts < p.ano_fim) as aprovadas_ano,
    coalesce((select marketing from mkt m where m.tool_id = t.tool_id), 0) as marketing_ano,
    coalesce((select total from despesas d where d.tool_id = t.tool_id), 0) as despesas_ano
  from (select distinct tool_id, tool from tp) t
),
mensal as (
  select tool_id, extract(month from (ts at time zone 'America/Sao_Paulo'))::int as mes,
         count(*) filter (where n = 1) as novos, count(*) filter (where n > 1) as renovacoes,
         sum(liquido) as liquido
  from pagas, params p where ts >= p.ano_ini and ts < p.ano_fim group by 1, 2
),
cancel_mes as (
  select c.tool_id, extract(month from ((c.cobre_ate + p.carencia) at time zone 'America/Sao_Paulo'))::int as mes, count(*) as cancelados
  from cli_status c cross join params p
  where c.situacao = 'cancelou' and c.cobre_ate + p.carencia >= p.ano_ini and c.cobre_ate + p.carencia < least(p.ano_fim, p.agora)
  group by 1, 2
),
coortes as (
  select c.tool_id, to_char(c.primeira at time zone 'America/Sao_Paulo', 'YYYY-MM') as coorte,
         count(*) as clientes,
         count(*) filter (where c.pagamentos > 1) as renovaram,
         count(*) filter (where c.situacao = 'ativo') as ativos,
         sum(c.liquido_total) as liquido
  from cli_status c cross join params p
  where c.primeira >= p.agora - interval '18 months'
  group by 1, 2
),
planos as (
  select tool_id, plan_id, plan_name, months, count(*) as pagamentos, count(distinct email) as clientes,
         round(avg(liquido), 2) as ticket_liquido
  from pagas group by 1, 2, 3, 4
),
-- Por duração de plano (1, 3, 6, 12…): base do LTV projetado ponderado, para não misturar
-- a renovação do mensal com o ticket do anual.
faixas as (
  select pg.tool_id, pg.months,
         count(*) filter (where pg.n = 1) as entradas,
         count(*) as pagamentos, sum(pg.liquido) as liquido,
         (select count(*) from renov r where r.tool_id = pg.tool_id and r.months = pg.months) as devidas,
         (select count(*) from renov r where r.tool_id = pg.tool_id and r.months = pg.months and r.renovou) as renovadas
  from pagas pg group by 1, 2
)
select jsonb_build_object(
  'ano', p_year,
  'gerado_em', (select agora from params),
  'meta', (select to_jsonb(g) from public.flow_goals g where g.year = p_year),
  'ferramentas', (select coalesce(jsonb_agg(to_jsonb(f) order by f.tool), '[]') from por_ferramenta f),
  'mensal', (select coalesce(jsonb_agg(to_jsonb(m)), '[]') from mensal m),
  'cancelamentos_mes', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from cancel_mes c),
  'coortes', (select coalesce(jsonb_agg(to_jsonb(c) order by c.coorte), '[]') from coortes c),
  'planos', (select coalesce(jsonb_agg(to_jsonb(pl) order by pl.pagamentos desc), '[]') from planos pl),
  'faixas', (select coalesce(jsonb_agg(to_jsonb(fx) order by fx.months), '[]') from faixas fx)
);
$$;
revoke all on function public.flow_health(integer) from public, anon;
grant execute on function public.flow_health(integer) to authenticated;
