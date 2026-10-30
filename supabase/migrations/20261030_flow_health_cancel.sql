-- Flow Health: cancelamento corrigido.
--
-- Antes "cancelou" era toda assinatura de ferramenta na Kiwify vencida há mais de 15 dias sem nova compra.
-- Agora, dessas, não contam como cancelamento:
--   · compra de teste ou cortesia (plano "Teste" ou menos de R$ 5 pagos no total) → vencidos_teste
--   · quem tem o combo vitalício em qualquer plataforma (segue com acesso)     → vencidos_com_vitalicio
-- E o cancelamento é dividido em involuntário (cobrança recusada/pendente entre 10 dias antes e 45 dias
-- depois do vencimento) e voluntário (nenhuma tentativa). "devolveram" = reembolso/chargeback de quem não
-- tem nenhuma compra paga da ferramenta (antes não aparecia em lugar nenhum).

-- E-mails com combo vitalício por ferramenta, juntando Kiwify, TMB e Hotmart. security definer porque o
-- Flow Health é usado por quem não tem o menu Saúde dos clientes (que libera TMB e Hotmart); só responde
-- para quem tem um dos menus que já mostram e-mails de clientes.
create or replace function public.lifetime_access() returns table (tool text, email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can(array['fin.health', 'fin.clients']) then return; end if;
  return query select distinct g.tool, g.email from public.tool_grants g where g.kind = 'vitalicio';
end $$;
revoke all on function public.lifetime_access() from public, anon;
grant execute on function public.lifetime_access() to authenticated;

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
         (array_agg(months order by ts desc))[1] as meses_plano,
         (array_agg(plan_name order by ts desc))[1] as plano
  from pagas group by 1, 2, 3
),
cli_base as (
  select c.*, case
      when c.cobre_ate >= p.agora then 'ativo'
      when c.cobre_ate >= p.agora - p.carencia then 'carencia'
      else 'cancelou' end as situacao_assinatura
  from clientes c cross join params p
),
-- Acesso vitalício (combo em qualquer plataforma) e tentativas de cobrança que falharam.
vit as (
  select distinct t.id as tool_id, l.email
    from public.lifetime_access() l join public.tools t on t.slug = l.tool
),
-- Por junção (e não "exists" linha a linha): com ~10 mil clientes o exists levava quase 1 minuto.
falhou as (
  select distinct c.tool_id, c.email
    from cli_base c
    join vendas f on f.tool_id = c.tool_id and f.email = c.email
   where f.status in ('refused', 'waiting_payment')
     and f.ts between c.cobre_ate - interval '10 days' and c.cobre_ate + interval '45 days'
),
-- Cancelou = venceu há mais de 15 dias sem nova compra, exceto:
--   teste    · compra de teste ou cortesia (plano "Teste" ou menos de R$ 5 pagos no total)
--   vitalicio · tem o combo vitalício: segue com acesso
-- involuntario = houve cobrança recusada/pendente entre 10 dias antes e 45 dias depois do vencimento.
cli_status as (
  select c.*,
    case when c.situacao_assinatura <> 'cancelou' then c.situacao_assinatura
         when c.plano ~* 'teste' or c.liquido_total < 5 then 'teste'
         when v.email is not null then 'vitalicio'
         else 'cancelou' end as situacao,
    (fl.email is not null) as cobranca_falhou
  from cli_base c
  left join vit v on v.tool_id = c.tool_id and v.email = c.email
  left join falhou fl on fl.tool_id = c.tool_id and fl.email = c.email
),
-- Reembolso/chargeback de quem não tem nenhuma compra paga da ferramenta: saiu sem virar cliente.
devolveram as (
  select v.tool_id, count(distinct v.email) as n
    from vendas v
    left join clientes c on c.tool_id = v.tool_id and c.email = v.email
   where v.status in ('refunded', 'chargedback') and c.email is null
   group by 1
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
    (select count(*) from cli_status c where c.tool_id = t.tool_id and situacao = 'cancelou' and cobranca_falhou) as cancelados_involuntario,
    (select count(*) from cli_status c where c.tool_id = t.tool_id and situacao = 'cancelou' and not cobranca_falhou) as cancelados_voluntario,
    (select count(*) from cli_status c where c.tool_id = t.tool_id and situacao = 'teste') as vencidos_teste,
    (select count(*) from cli_status c where c.tool_id = t.tool_id and situacao = 'vitalicio') as vencidos_com_vitalicio,
    coalesce((select n from devolveram d where d.tool_id = t.tool_id), 0) as devolveram,
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
