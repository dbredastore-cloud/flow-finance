-- Retenção: "Desistiram na 1ª compra" — reembolso ou chargeback da primeira compra de assinatura (Kiwify).
-- Essas vendas não entram na base (só cobranças pagas contam), então não aparecem como cliente nem como churn.
-- Aqui elas são contadas à parte, no período da data da compra:
--   reembolso  = pediu o dinheiro de volta (garantia)
--   chargeback = contestação no cartão
-- Não separa "até 7 dias / depois": desde 08/2026 a Kiwify grava refunded_at quase sempre no 7º–8º dia
-- (data de processamento, não do pedido), então essa divisão daria número errado.
-- "1ª compra" = o e-mail não tinha nenhuma cobrança paga da ferramenta antes (no consolidado: de nenhuma ferramenta).
-- Cada e-mail conta uma vez por escopo; se tiver os dois casos vale chargeback.

-- Índice pequeno (só reembolsos/chargebacks) para não ler a tabela de vendas inteira a cada abertura da tela.
create index if not exists kiwify_sales_snapshot_desist_idx
  on public.kiwify_sales_snapshot (sale_created_at) where status in ('refunded', 'chargedback');
CREATE OR REPLACE FUNCTION public.rm_dashboard(p_ini date DEFAULT NULL::date, p_fim date DEFAULT NULL::date, p_plano text DEFAULT 'todos'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET work_mem TO '64MB'
AS $function$
declare
  tz constant text := 'America/Sao_Paulo';
  v_now timestamptz := now();
  v_ini date := coalesce(p_ini, ((now() at time zone 'America/Sao_Paulo')::date - 89));
  v_fim date := coalesce(p_fim, (now() at time zone 'America/Sao_Paulo')::date);
  t_ini timestamptz; t_fim timestamptz; t_snap timestamptz; v_plano text := coalesce(nullif(p_plano, ''), 'todos');
  res jsonb;
begin
  if auth.uid() is not null and not public.can(array['fin.health', 'fin.clients']) then raise exception 'sem permissão'; end if;
  if v_plano not in ('todos', 'mensal', 'semestral', 'anual', 'vitalicio') then raise exception 'plano inválido: %', v_plano; end if;
  if v_fim < v_ini then raise exception 'período inválido'; end if;
  t_ini := v_ini::timestamp at time zone tz;
  t_fim := least((v_fim + 1)::timestamp at time zone tz, v_now);
  t_snap := t_fim - interval '1 microsecond';

  with
  scopes as (select unnest(array['all', 'flowpages', 'flowtracking', 'flowspy']) as scope),
  snap as materialized (
    select x.scope, g.tool, g.email, public.rm_plan_group(g.plano) as plano, g.mrr
      from public.rm_segs g cross join lateral (values (g.tool), ('all')) x(scope)
     where g.s <= t_snap and g.e > t_snap and public.rm_plan_ok(g.plano, v_plano)
  ),
  ini_cli as materialized (
    select x.scope, g.email, bool_or(g.plano = 'vitalicio') as vit,
           bool_or(public.rm_plan_ok(g.plano, v_plano)) as no_filtro,
           array_agg(distinct public.rm_plan_group(g.plano)) filter (where g.plano <> 'vitalicio') as planos
      from public.rm_segs g cross join lateral (values (g.tool), ('all')) x(scope)
     where g.s <= t_ini and g.e > t_ini
     group by 1, 2
  ),
  spl as materialized (
    select tool as scope, email, fim, public.rm_plan_group(plano_fim) as plano, encerrado, motivo from public.rm_spells
     where fim >= least(t_ini, v_now - interval '7 days') and fim <> 'infinity'
    union all
    select 'all', email, fim, public.rm_plan_group(plano_fim), encerrado, motivo from public.rm_cspells
     where fim >= least(t_ini, v_now - interval '7 days') and fim <> 'infinity'
  ),
  base_p as materialized (
    select sc.scope,
           (select count(distinct email) from snap s where s.scope = sc.scope) as clientes,
           (select count(*) from snap s where s.scope = sc.scope) as assinaturas,
           (select count(distinct email) from snap s where s.scope = sc.scope and s.plano <> 'vitalicio') as pagantes,
           (select coalesce(round(sum(mrr), 2), 0) from snap s where s.scope = sc.scope) as mrr,
           (select count(*) from ini_cli i where i.scope = sc.scope and i.no_filtro) as clientes_ini,
           (select coalesce(jsonb_object_agg(plano, n), '{}'::jsonb) from (select plano, count(distinct email) as n from snap s where s.scope = sc.scope group by plano) x) as por_plano,
           (select coalesce(jsonb_object_agg(tool, n), '{}'::jsonb) from (select tool, count(*) as n from snap s where s.scope = sc.scope group by tool) x) as por_ferramenta,
           (select count(*) from spl sp where sp.scope = sc.scope and not sp.encerrado and sp.fim <= v_now
               and public.rm_plan_ok(sp.plano, v_plano)) as em_carencia
      from scopes sc
  ),
  risco_p as materialized (
    select scope, 'todos' as plano, count(*) as n from ini_cli where not vit group by 1
    union all
    select i.scope, p, count(*) from ini_cli i cross join unnest(i.planos) p where not i.vit group by 1, 2
  ),
  churn_p as materialized (
    select scope, coalesce(plano, 'todos') as plano, total, voluntario, chargeback, involuntario, nao_identificado from (
      select sp.scope, sp.plano, count(*) as total,
             count(*) filter (where sp.motivo = 'voluntario') as voluntario, count(*) filter (where sp.motivo = 'chargeback') as chargeback,
             count(*) filter (where sp.motivo = 'involuntario') as involuntario,
             count(*) filter (where sp.motivo = 'nao_identificado') as nao_identificado
        from spl sp where sp.encerrado and sp.fim >= t_ini and sp.fim < t_fim
       group by grouping sets ((sp.scope, sp.plano), (sp.scope))) z
  ),
  churn_p_out as materialized (
    select sc.scope, coalesce((select jsonb_agg(jsonb_build_object('plano', k.plano, 'base_ini', coalesce(r.n, 0),
             'total', coalesce(c.total, 0), 'voluntario', coalesce(c.voluntario, 0), 'chargeback', coalesce(c.chargeback, 0),
             'involuntario', coalesce(c.involuntario, 0), 'nao_identificado', coalesce(c.nao_identificado, 0)))
             from (select plano from risco_p where scope = sc.scope union select plano from churn_p where scope = sc.scope) k
             left join risco_p r on r.scope = sc.scope and r.plano = k.plano
             left join churn_p c on c.scope = sc.scope and c.plano = k.plano), '[]'::jsonb) as churn
      from scopes sc
  ),
  renov_p as materialized (
    select sc.scope, r.plano, count(*) as devidas, count(*) filter (where r.renovou) as renovadas, count(*) filter (where r.pendente and not r.renovou) as pendentes, max(r.vence + interval '7 days') filter (where r.pendente and not r.renovou) as fecha_em, count(*) filter (where not r.pendente) as fechadas, count(*) filter (where not r.pendente and r.renovou) as renovadas_fechadas
      from public.rm_renov r cross join lateral (values (r.tool), ('all')) sc(scope)
     where r.vence >= t_ini and r.vence < t_fim group by 1, 2
  ),
  novos_p as materialized (
    select n.scope, count(*) filter (where public.rm_plan_ok(n.plano, v_plano)) as novos, count(*) as novos_todos
      from (select tool as scope, ts, plano from public.rm_charges where n = 1
            union all
            select 'all', ts, plano from (select distinct on (email) email, ts, plano from public.rm_charges where n = 1 order by email, ts) f) n
     where n.ts >= t_ini and n.ts < t_fim group by 1
  ),
  desist_v as materialized (
    select t.slug as tool, lower(btrim(s.customer_email)) as email, s.sale_created_at as ts,
           s.status = 'chargedback' as cb
      from public.kiwify_sales_snapshot s
      join public.kiwify_products p on p.id = s.product_id
      join public.tools t on t.id = p.tool_id
      left join public.kiwify_plans kp on kp.plan_id = s.plan_id
     where s.status in ('refunded', 'chargedback')
       and s.sale_created_at >= t_ini and s.sale_created_at < t_fim
       and s.customer_email is not null and btrim(s.customer_email) <> ''
       and (t.revenue_start is null or s.sale_created_at >= t.revenue_start::timestamptz)
       and coalesce(kp.plan_name, s.plan_name, '') !~* 'teste'
       and public.rm_plan_ok(public.rm_plan_type(coalesce(kp.months, public.guess_plan_months(s.plan_name), 1)), v_plano)
  ),
  desist_e as materialized (
    select sc.scope, d.email, bool_or(d.cb) as cb
      from desist_v d cross join lateral (values (d.tool), ('all')) sc(scope)
     where not exists (select 1 from public.rm_charges c
                        where c.email = d.email and c.ts < d.ts and (sc.scope = 'all' or c.tool = d.tool))
     group by 1, 2
  ),
  desist_p as materialized (
    select scope, count(*) as total,
           count(*) filter (where not cb) as reembolso,
           count(*) filter (where cb) as chargeback
      from desist_e group by 1
  ),
  comissao_p as materialized (
    select sc.scope, sum(c.comissao) as comissao from public.rm_charges c cross join lateral (values (c.tool), ('all')) sc(scope)
     where c.n = 1 and c.ts >= t_ini and c.ts < t_fim group by 1
  ),
  desp as materialized (
    select t.slug as tool, make_date(e.year, e.month, 1) as mes, sum(e.amount) as marketing
      from public.monthly_expenses e
      join public.expense_categories c on c.id = e.category_id and c.group_name = 'Marketing'
      join public.tools t on t.id = e.tool_id and t.slug in ('flowpages', 'flowtracking', 'flowspy')
     group by 1, 2
  ),
  mkt_p as materialized (
    select sc.scope,
           sum(d.marketing * greatest(0, least((d.mes + interval '1 month')::date, v_fim + 1) - greatest(d.mes, v_ini))::numeric
               / ((d.mes + interval '1 month')::date - d.mes)) as marketing,
           count(distinct d.mes) as meses
      from desp d cross join lateral (values (d.tool), ('all')) sc(scope)
     where d.mes <= v_fim and (d.mes + interval '1 month')::date > v_ini
     group by 1
  ),
  mix_cli as materialized (
    select email, count(*) as n, string_agg(tool, '+' order by tool) as combo, array_agg(tool) as tools from snap where scope = 'all' group by email
  ),
  mix_out as materialized (
    select sc.scope, jsonb_build_object(
             'clientes', (select count(*) from mix_cli m where sc.scope = 'all' or sc.scope = any(m.tools)),
             'por_qtd', coalesce((select jsonb_object_agg(q.n::text, q.c) from (select n, count(*) c from mix_cli m
                                   where sc.scope = 'all' or sc.scope = any(m.tools) group by n) q), '{}'::jsonb),
             'combos', coalesce((select jsonb_object_agg(q.combo, q.c) from (select combo, count(*) c from mix_cli m
                                   where sc.scope = 'all' or sc.scope = any(m.tools) group by combo) q), '{}'::jsonb)) as mix
      from scopes sc
  ),
  periodo as materialized (
    select sc.scope, jsonb_build_object(
      'base', (select to_jsonb(b) - 'scope' from base_p b where b.scope = sc.scope),
      'churn', (select c.churn from churn_p_out c where c.scope = sc.scope),
      'renovacao', coalesce((select jsonb_agg(jsonb_build_object('plano', r.plano, 'devidas', r.devidas, 'renovadas', r.renovadas, 'pendentes', r.pendentes, 'fecha_em', r.fecha_em, 'fechadas', r.fechadas, 'renovadas_fechadas', r.renovadas_fechadas)) from renov_p r where r.scope = sc.scope), '[]'::jsonb),
      'novos', coalesce((select n.novos from novos_p n where n.scope = sc.scope), 0),
      'novos_todos', coalesce((select n.novos_todos from novos_p n where n.scope = sc.scope), 0),
      'desistencia', coalesce((select to_jsonb(x) - 'scope' from desist_p x where x.scope = sc.scope),
                              jsonb_build_object('total', 0, 'reembolso', 0, 'chargeback', 0)),
      'comissao', coalesce((select round(c.comissao, 2) from comissao_p c where c.scope = sc.scope), 0),
      'marketing', (select round(m.marketing, 2) from mkt_p m where m.scope = sc.scope),
      'marketing_meses', coalesce((select m.meses from mkt_p m where m.scope = sc.scope), 0),
      'mix', (select mix from mix_out m where m.scope = sc.scope),
      'primeira_venda', (select min(c.ts) from public.rm_charges c where sc.scope = 'all' or c.tool = sc.scope)
    ) as p
      from scopes sc
  )
  select jsonb_build_object(
    'atualizado_em', (select atualizado_em from public.rm_meta where id = 1),
    'gerado_em', v_now,
    'filtro', jsonb_build_object('ini', v_ini, 'fim', v_fim, 'plano', v_plano, 'fim_efetivo', t_fim,
                                 'meses_periodo', (select count(*) from generate_series(date_trunc('month', v_ini), date_trunc('month', v_fim), interval '1 month'))),
    'periodo', (select jsonb_object_agg(pp.scope, pp.p) from periodo pp),
    'historico', (select c.payload from public.rm_cache c where c.plano = v_plano)
  ) into res;
  return res;
end $function$;
