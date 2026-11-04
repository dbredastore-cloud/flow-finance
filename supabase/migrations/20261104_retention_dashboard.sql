-- Retenção e Monetização: números da tela, a partir do cache de 20261104_retention_cache.sql (rm_*).
--
-- rm_build(plano)   · histórico mês a mês desde jun/2025 (pesado; roda no cron dentro de rm_refresh e fica em rm_cache):
--                     base no fim do mês, churn por plano e motivo, renovação, receita reconhecida, despesas, LTV/CAC,
--                     coortes de retenção (D30/D90/D180/D365) e quantidade de ferramentas por cliente.
-- rm_dashboard(ini, fim, plano) · o que a tela pede: o histórico guardado + os números do período escolhido.
-- Escopos: 'all' (consolidado por cliente: só sai quando perde todas as ferramentas) e cada ferramenta.
-- Plano: 'todos' · 'mensal' · 'semestral' (inclui trimestral) · 'anual' · 'vitalicio'.
-- Datas no fuso de São Paulo. Histórico: cada mês usa a situação daquela data (trechos rm_segs), não a de hoje.
--
-- Fórmulas (também explicadas na tela):
--   ativo          · trecho vigente na data (assinatura paga em dia ou combo vitalício). Sem teste, sem uso/login.
--   churn do mês   · períodos encerrados com fim da vigência no mês ÷ base que podia cancelar no começo do mês
--                    (ativos sem vitalício). Consolidado: rm_cspells (perdeu todas as ferramentas).
--   renovação      · cobranças vencidas no período que tiveram nova cobrança paga da mesma ferramenta (rm_renov).
--   receita        · líquido de cada cobrança paga (Kiwify: já sem cupom, taxa e comissão; reembolsos ficam fora)
--                    espalhado pelos dias que ela cobre: o anual vira 1/12 por mês.
--   margem bruta   · 1 − (Infraestrutura + Suporte) ÷ receita reconhecida, nos 12 meses até o mês (só meses com despesa lançada).
--   permanência    · 1 ÷ churn mensal médio dos 12 meses até o mês (Σ churn ÷ Σ base em risco).
--   ARPU           · receita mensal (MRR) das assinaturas ativas ÷ clientes pagantes ativos.
--   LTV            · ARPU × margem bruta × permanência.
--   CAC            · (comissão de afiliados nas primeiras compras + despesas do grupo Marketing) ÷ clientes novos.

create or replace function public.rm_build(p_plano text) returns jsonb
language plpgsql stable security definer set search_path = '' set work_mem = '64MB' as $$
declare
  tz constant text := 'America/Sao_Paulo';
  v_now timestamptz := now();
  v_plano text := coalesce(nullif(p_plano, ''), 'todos');
  res jsonb;
begin
  with
  meses as materialized (
    select m::date as mes, (m at time zone tz) as ini, least(((m + interval '1 month') at time zone tz), v_now) as fim
      from generate_series(timestamp '2025-06-01', date_trunc('month', v_now at time zone tz), interval '1 month') m
  ),
  seg as materialized (
    select tool as scope, tool, email, s, e, plano, mrr from public.rm_segs
    union all select 'all', tool, email, s, e, plano, mrr from public.rm_segs
  ),
  spl as materialized (
    select tool as scope, email, inicio, fim, public.rm_plan_group(plano_fim) as plano, encerrado, motivo from public.rm_spells
    union all select 'all', email, inicio, fim, public.rm_plan_group(plano_fim), encerrado, motivo from public.rm_cspells
  ),
  scopes as (select unnest(array['all', 'flowpages', 'flowtracking', 'flowspy']) as scope),
  -- 1ª compra paga de assinatura: por ferramenta (n = 1) e por cliente (a mais antiga entre as ferramentas).
  novos as materialized (
    select tool as scope, email, ts, public.rm_plan_group(plano) as plano from public.rm_charges where n = 1
    union all
    select 'all', email, ts, plano from (
      select distinct on (email) email, ts, public.rm_plan_group(plano) as plano from public.rm_charges where n = 1 order by email, ts) f
  ),
  desp as materialized (
    select t.slug as tool, make_date(e.year, e.month, 1) as mes,
           sum(e.amount) filter (where c.group_name in ('Infraestrutura', 'Suporte')) as direto,
           sum(e.amount) filter (where c.group_name = 'Marketing') as marketing,
           sum(e.amount) as total
      from public.monthly_expenses e
      join public.expense_categories c on c.id = e.category_id
      join public.tools t on t.id = e.tool_id and t.slug in ('flowpages', 'flowtracking', 'flowspy')
     group by 1, 2
  ),
  desp_s as materialized (
    select tool as scope, mes, direto, marketing, total from desp
    union all select 'all', mes, sum(direto), sum(marketing), sum(total) from desp group by mes
  ),
  -- Receita reconhecida (todos os planos: base da margem, que compara com as despesas da ferramenta inteira).
  receita as materialized (
    select sc.scope, m.mes,
           sum(c.liquido * extract(epoch from (least(c.cobre_ate, m.fim) - greatest(c.ts, m.ini))) / extract(epoch from (c.cobre_ate - c.ts))) as receita
      from meses m
      join public.rm_charges c on c.ts < m.fim and c.cobre_ate > m.ini
      cross join lateral (values (c.tool), ('all')) sc(scope)
     group by 1, 2
  ),
  -- Ativos no último instante do mês (ou agora, no mês corrente), com o filtro de plano.
  ativo_fim as materialized (
    select g.scope, m.mes, g.tool, g.email, g.plano, g.mrr
      from meses m join seg g on g.s <= m.fim - interval '1 microsecond' and g.e > m.fim - interval '1 microsecond'
     where public.rm_plan_ok(g.plano, v_plano)
  ),
  base_m as materialized (
    select scope, mes, count(distinct email) as clientes, count(*) as assinaturas, sum(mrr) as mrr,
           count(distinct email) filter (where plano <> 'vitalicio') as pagantes
      from ativo_fim group by 1, 2
  ),
  -- Base que pode cancelar no começo do mês: ativos sem vitalício (no consolidado: sem nenhum vitalício).
  ini_cli as materialized (
    select g.scope, m.mes, g.email, bool_or(g.plano = 'vitalicio') as vit,
           array_agg(distinct public.rm_plan_group(g.plano)) filter (where g.plano <> 'vitalicio') as planos
      from meses m join seg g on g.s <= m.ini and g.e > m.ini
     group by 1, 2, 3
  ),
  risco_m as materialized (
    select scope, mes, null::text as plano, count(*) as base_ini from ini_cli where not vit group by 1, 2
    union all
    select i.scope, i.mes, p, count(*) from ini_cli i cross join unnest(i.planos) p where not i.vit group by 1, 2, 3
  ),
  churn_m as materialized (
    select sp.scope, m.mes, sp.plano,
           count(*) as total,
           count(*) filter (where sp.motivo = 'voluntario') as voluntario,
           count(*) filter (where sp.motivo = 'involuntario') as involuntario,
           count(*) filter (where sp.motivo = 'nao_identificado') as nao_identificado
      from meses m join spl sp on sp.encerrado and sp.fim >= m.ini and sp.fim < m.fim
     group by grouping sets ((1, 2, 3), (1, 2))
  ),
  novos_m as materialized (
    select n.scope, m.mes, count(*) filter (where public.rm_plan_ok(n.plano, v_plano)) as novos, count(*) as novos_todos
      from meses m join novos n on n.ts >= m.ini and n.ts < m.fim group by 1, 2
  ),
  comissao_m as materialized (
    select sc.scope, m.mes, sum(c.comissao) as comissao
      from meses m join public.rm_charges c on c.n = 1 and c.comissao > 0 and c.ts >= m.ini and c.ts < m.fim
      cross join lateral (values (c.tool), ('all')) sc(scope) group by 1, 2
  ),
  renov_m as materialized (
    select sc.scope, m.mes, r.plano, count(*) as devidas, count(*) filter (where r.renovou) as renovadas
      from meses m join public.rm_renov r on r.vence >= m.ini and r.vence < m.fim
      cross join lateral (values (r.tool), ('all')) sc(scope) group by 1, 2, 3
  ),
  serie as materialized (
    select s.scope, m.mes,
           coalesce(b.clientes, 0) as clientes, coalesce(b.assinaturas, 0) as assinaturas,
           coalesce(b.pagantes, 0) as pagantes, coalesce(b.mrr, 0) as mrr,
           coalesce(rk.base_ini, 0) as base_risco, coalesce(ch.total, 0) as churn,
           coalesce(n.novos, 0) as novos, coalesce(n.novos_todos, 0) as novos_todos, coalesce(cm.comissao, 0) as comissao,
           coalesce(rc.receita, 0) as receita, d.direto, d.marketing, d.total as despesas, (d.mes is not null) as tem_despesa
      from scopes s cross join meses m
      left join base_m b on b.scope = s.scope and b.mes = m.mes
      left join risco_m rk on rk.scope = s.scope and rk.mes = m.mes
            and rk.plano is not distinct from (case when v_plano = 'todos' then null else v_plano end)
      left join churn_m ch on ch.scope = s.scope and ch.mes = m.mes
            and ch.plano is not distinct from (case when v_plano = 'todos' then null else v_plano end)
      left join novos_m n on n.scope = s.scope and n.mes = m.mes
      left join comissao_m cm on cm.scope = s.scope and cm.mes = m.mes
      left join receita rc on rc.scope = s.scope and rc.mes = m.mes
      left join desp_s d on d.scope = s.scope and d.mes = m.mes
  ),
  serie3 as materialized (
    select s.*,
           sum(s.base_risco) over w12 as risco_12, sum(s.churn) over w12 as churn_12,
           sum(case when s.tem_despesa then s.receita end) over w12 as receita_12, sum(s.direto) over w12 as direto_12,
           count(*) filter (where s.tem_despesa) over w12 as meses_despesa_12
      from serie s
    window w12 as (partition by s.scope order by s.mes rows between 11 preceding and current row)
  ),
  serie_out as materialized (
    select s.scope, jsonb_agg(jsonb_build_object(
             'mes', s.mes, 'clientes', s.clientes, 'assinaturas', s.assinaturas, 'pagantes', s.pagantes, 'mrr', round(s.mrr, 2),
             'base_risco', s.base_risco, 'churn', s.churn, 'novos', s.novos, 'novos_todos', s.novos_todos, 'comissao', round(s.comissao, 2),
             'receita', round(s.receita, 2), 'direto', s.direto, 'marketing', s.marketing, 'despesas', s.despesas,
             'arpu', case when s.pagantes > 0 then round(s.mrr / s.pagantes, 2) end,
             'margem', case when s.receita_12 > 0 and s.meses_despesa_12 > 0 then round(1 - coalesce(s.direto_12, 0) / s.receita_12, 4) end,
             'churn_medio', case when s.risco_12 > 0 then round(s.churn_12::numeric / s.risco_12, 5) end,
             'permanencia', case when s.churn_12 > 0 then round(s.risco_12::numeric / s.churn_12, 2) end,
             -- CAC sempre com todos os planos: comissão e marketing não se separam por plano.
             'cac', case when s.novos_todos > 0 and (s.comissao > 0 or coalesce(s.marketing, 0) > 0)
                         then round((s.comissao + coalesce(s.marketing, 0)) / s.novos_todos, 2) end,
             'marketing_lancado', s.marketing is not null
           ) order by s.mes) as serie
      from serie3 s group by s.scope
  ),
  churn_out as materialized (
    select scope, jsonb_agg(jsonb_build_object('mes', mes, 'plano', coalesce(plano, 'todos'), 'base_ini', base_ini, 'total', total,
             'voluntario', voluntario, 'involuntario', involuntario, 'nao_identificado', nao_identificado) order by mes, plano nulls first) as churn
      from (select coalesce(c.scope, r.scope) as scope, coalesce(c.mes, r.mes) as mes, coalesce(c.plano, r.plano) as plano,
                   coalesce(r.base_ini, 0) as base_ini, coalesce(c.total, 0) as total, coalesce(c.voluntario, 0) as voluntario,
                   coalesce(c.involuntario, 0) as involuntario, coalesce(c.nao_identificado, 0) as nao_identificado
              from churn_m c full join risco_m r on r.scope = c.scope and r.mes = c.mes and r.plano is not distinct from c.plano) x
     group by scope
  ),
  renov_out as materialized (
    select scope, jsonb_agg(jsonb_build_object('mes', mes, 'plano', plano, 'devidas', devidas, 'renovadas', renovadas) order by mes, plano) as renov
      from renov_m group by scope
  ),
  -- Retenção: retido no marco = tem acesso (período ativo) N meses depois da 1ª compra paga, no mesmo dia do mês.
  -- Só coortes cujo mês inteiro já passou do marco + 20 dias de carência.
  coorte_base as materialized (
    select n.scope, n.email, n.ts, n.plano, date_trunc('month', n.ts at time zone tz)::date as coorte from novos n
     where public.rm_plan_ok(n.plano, v_plano)
  ),
  marcos as (select unnest(array[1, 3, 6, 12]) as meses),
  ret as materialized (
    select cb.scope, cb.coorte, cb.email, mk.meses,
           bool_or(sp.inicio <= cb.ts + make_interval(months => mk.meses) and sp.fim > cb.ts + make_interval(months => mk.meses)) as retido
      from coorte_base cb cross join marcos mk
      join spl sp on sp.scope = cb.scope and sp.email = cb.email
     where ((cb.coorte + make_interval(months => mk.meses + 1))::timestamp at time zone tz) + interval '20 days' <= v_now
     group by 1, 2, 3, 4
  ),
  coortes as materialized (select scope, coorte, meses, count(*) filter (where retido) as retidos from ret group by 1, 2, 3),
  coortes_out as materialized (
    select t.scope, jsonb_agg(jsonb_build_object('coorte', t.coorte, 'clientes', t.clientes,
             'marcos', coalesce((select jsonb_object_agg(c.meses::text, c.retidos) from coortes c where c.scope = t.scope and c.coorte = t.coorte), '{}'::jsonb))
             order by t.coorte) as coortes
      from (select scope, coorte, count(*) as clientes from coorte_base group by 1, 2) t group by t.scope
  ),
  -- Quantas ferramentas cada cliente ativo tinha no fim de cada mês; por ferramenta, só quem tem aquela ferramenta.
  mix_cli_m as materialized (
    select mes, email, count(distinct tool) as n, array_agg(distinct tool) as tools from ativo_fim where scope = 'all' group by 1, 2
  ),
  mix_out as materialized (
    select sc.scope, jsonb_agg(jsonb_build_object('mes', x.mes, 'n', x.n, 'clientes', x.c) order by x.mes, x.n) as mix
      from scopes sc
      join lateral (select mes, n, count(*) as c from mix_cli_m mm where sc.scope = 'all' or sc.scope = any(mm.tools) group by 1, 2) x on true
     group by sc.scope
  )
  select jsonb_build_object('plano', v_plano, 'gerado_em', v_now,
    'escopos', (select jsonb_object_agg(sc.scope, jsonb_build_object(
        'serie', coalesce((select serie from serie_out s where s.scope = sc.scope), '[]'::jsonb),
        'churn_mes', coalesce((select churn from churn_out c where c.scope = sc.scope), '[]'::jsonb),
        'renov_mes', coalesce((select renov from renov_out r where r.scope = sc.scope), '[]'::jsonb),
        'coortes', coalesce((select coortes from coortes_out c where c.scope = sc.scope), '[]'::jsonb),
        'mix_mes', coalesce((select mix from mix_out m where m.scope = sc.scope), '[]'::jsonb)))
      from scopes sc)
  ) into res;
  return res;
end $$;
revoke all on function public.rm_build(text) from public, anon, authenticated;

-- Período escolhido na tela. Leve: só duas datas (início e fim) sobre as tabelas pequenas do cache.
create or replace function public.rm_dashboard(p_ini date default null, p_fim date default null, p_plano text default 'todos')
returns jsonb language plpgsql stable security definer set search_path = '' set work_mem = '64MB' as $$
declare
  tz constant text := 'America/Sao_Paulo';
  v_now timestamptz := now();
  v_ini date := coalesce(p_ini, ((now() at time zone 'America/Sao_Paulo')::date - 89));
  v_fim date := coalesce(p_fim, (now() at time zone 'America/Sao_Paulo')::date);
  t_ini timestamptz; t_fim timestamptz; t_snap timestamptz; v_plano text := coalesce(nullif(p_plano, ''), 'todos');
  res jsonb;
begin
  -- anon não executa (revoke abaixo); logado, só quem vê Flow Health ou Saúde dos clientes; sem usuário = servidor/testes.
  if auth.uid() is not null and not public.can(array['fin.health', 'fin.clients']) then raise exception 'sem permissão'; end if;
  if v_plano not in ('todos', 'mensal', 'semestral', 'anual', 'vitalicio') then raise exception 'plano inválido: %', v_plano; end if;
  if v_fim < v_ini then raise exception 'período inválido'; end if;
  t_ini := v_ini::timestamp at time zone tz;
  t_fim := least((v_fim + 1)::timestamp at time zone tz, v_now);
  t_snap := t_fim - interval '1 microsecond';     -- último instante do período

  with
  scopes as (select unnest(array['all', 'flowpages', 'flowtracking', 'flowspy']) as scope),
  -- Ativos no fim do período, com o filtro de plano.
  snap as materialized (
    select x.scope, g.tool, g.email, public.rm_plan_group(g.plano) as plano, g.mrr
      from public.rm_segs g cross join lateral (values (g.tool), ('all')) x(scope)
     where g.s <= t_snap and g.e > t_snap and public.rm_plan_ok(g.plano, v_plano)
  ),
  -- Ativos no começo do período (base em risco de churn e crescimento).
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
     where fim >= least(t_ini, v_now - interval '20 days') and fim <> 'infinity'
    union all
    select 'all', email, fim, public.rm_plan_group(plano_fim), encerrado, motivo from public.rm_cspells
     where fim >= least(t_ini, v_now - interval '20 days') and fim <> 'infinity'
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
           -- em carência agora: venceu há até 20 dias e ainda pode renovar (não é ativo nem churn ainda)
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
    select scope, coalesce(plano, 'todos') as plano, total, voluntario, involuntario, nao_identificado from (
      select sp.scope, sp.plano, count(*) as total,
             count(*) filter (where sp.motivo = 'voluntario') as voluntario,
             count(*) filter (where sp.motivo = 'involuntario') as involuntario,
             count(*) filter (where sp.motivo = 'nao_identificado') as nao_identificado
        from spl sp where sp.encerrado and sp.fim >= t_ini and sp.fim < t_fim
       group by grouping sets ((sp.scope, sp.plano), (sp.scope))) z
  ),
  churn_p_out as materialized (
    select sc.scope, coalesce((select jsonb_agg(jsonb_build_object('plano', k.plano, 'base_ini', coalesce(r.n, 0),
             'total', coalesce(c.total, 0), 'voluntario', coalesce(c.voluntario, 0),
             'involuntario', coalesce(c.involuntario, 0), 'nao_identificado', coalesce(c.nao_identificado, 0)))
             from (select plano from risco_p where scope = sc.scope union select plano from churn_p where scope = sc.scope) k
             left join risco_p r on r.scope = sc.scope and r.plano = k.plano
             left join churn_p c on c.scope = sc.scope and c.plano = k.plano), '[]'::jsonb) as churn
      from scopes sc
  ),
  renov_p as materialized (
    select sc.scope, r.plano, count(*) as devidas, count(*) filter (where r.renovou) as renovadas
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
  comissao_p as materialized (
    select sc.scope, sum(c.comissao) as comissao from public.rm_charges c cross join lateral (values (c.tool), ('all')) sc(scope)
     where c.n = 1 and c.ts >= t_ini and c.ts < t_fim group by 1
  ),
  -- Marketing do período: cada mês entra na proporção dos dias dele que caem no período.
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
      'renovacao', coalesce((select jsonb_agg(jsonb_build_object('plano', r.plano, 'devidas', r.devidas, 'renovadas', r.renovadas)) from renov_p r where r.scope = sc.scope), '[]'::jsonb),
      'novos', coalesce((select n.novos from novos_p n where n.scope = sc.scope), 0),
      'novos_todos', coalesce((select n.novos_todos from novos_p n where n.scope = sc.scope), 0),
      'comissao', coalesce((select round(c.comissao, 2) from comissao_p c where c.scope = sc.scope), 0),
      'marketing', (select round(m.marketing, 2) from mkt_p m where m.scope = sc.scope),
      'marketing_meses', coalesce((select m.meses from mkt_p m where m.scope = sc.scope), 0),
      'mix', (select mix from mix_out m where m.scope = sc.scope)
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
end $$;
revoke all on function public.rm_dashboard(date, date, text) from public, anon;
grant execute on function public.rm_dashboard(date, date, text) to authenticated;

-- Atualiza o cache a cada 30 minutos (a Kiwify sincroniza a cada 5 min; TMB e Hotmart a cada 30).
select cron.unschedule(jobid) from cron.job where jobname = 'retention-refresh';
select cron.schedule('retention-refresh', '9,39 * * * *', $$ select public.rm_refresh(); $$);
select public.rm_refresh();
