-- Testes de Retenção e Monetização (rm_refresh, rm_build, rm_dashboard).
--
-- Como rodar: cole tudo no SQL editor do Supabase (ou execute_sql do MCP). Roda dentro de uma transação e termina
-- SEMPRE com um erro proposital "RM_TESTES ..." que desfaz tudo (clientes de teste, cache, nada fica gravado).
-- O resultado vem na própria mensagem de erro: {"falhas": [...], "ok": n, ...}. falhas vazio = tudo passou.
--
-- Método: com o mesmo now() (fixo na transação), calcula o cache com os dados reais, insere clientes de teste
-- (@rm-teste.invalid) com cenários conhecidos, recalcula e confere as DIFERENÇAS esperadas. Assim os testes valem
-- com qualquer volume de dados reais. Cenários (N = agora):
--   A  Pages anual em N−14m e renovação paga em N−2m (no vencimento)        → renovou; retido no D365
--   B  Pages anual em N−14m, sem renovação                                    → churn anual, motivo não identificado
--   C  Pages anual em N−15m e nova compra 40 dias depois do vencimento        → não é renovação; churn + volta (ativo)
--   D  Tracking mensal em N−3m e a cobrança seguinte reembolsada              → churn voluntário
--   E  Tracking mensal em N−3m e a cobrança seguinte recusada                 → churn involuntário
--   F  Tracking mensal em N−3m, sem nada depois                              → churn não identificado
--   G  Pages anual em N−14m (vence) + Tracking anual em N−6m (ativo)          → churn só na ferramenta, não no consolidado
--   H  Pages anual em N−14m + Tracking anual 5 dias depois, nenhum renova     → 1 churn no consolidado, 1 em cada ferramenta
--   I  Pages anual em N−11m (vence daqui a 1 mês)                             → ativo (cancelamento agendado não é churn)
--   J  Pages plano "Teste" R$ 0                                               → ignorado (teste grátis)
--   K  as três ferramentas, anual, em N−2m                                    → cliente com 3 ferramentas
--   L  Spy semestral em N−1m                                                  → cliente com 1 ferramenta
--   M  Tracking anual vencido há 1 dia, sem renovar                           → em carência (3 dias): taxa parcial, não é churn
--   O  Tracking anual vencido há 2 dias e renovado 1 dia depois do vencimento → renovado com a carência ainda aberta
do $test$
declare
  n timestamptz := now();
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  p_fp text := (select p.id from public.kiwify_products p join public.tools t on t.id = p.tool_id where t.slug = 'flowpages' and not exists (select 1 from public.bundle_products b where b.product_id = p.id) order by p.created_at limit 1);
  p_ft text := (select p.id from public.kiwify_products p join public.tools t on t.id = p.tool_id where t.slug = 'flowtracking' and not exists (select 1 from public.bundle_products b where b.product_id = p.id) order by p.created_at limit 1);
  p_fs text := (select p.id from public.kiwify_products p join public.tools t on t.id = p.tool_id where t.slug = 'flowspy' and not exists (select 1 from public.bundle_products b where b.product_id = p.id) order by p.created_at limit 1);
  d0 jsonb; d1 jsonb; h0 jsonb; h1 jsonb; past0 jsonb; past1 jsonb; vazio jsonb; men0 jsonb; men1 jsonb;
  ini365 date := hoje - 364;
  falhas jsonb := '[]'; ok int := 0;
  dt timestamptz;
begin
  -- Compara e acumula. Valores numéricos como texto para mensagens claras.
  create temp table _chk (nome text, esperado numeric, obtido numeric) on commit drop;

  perform public.rm_refresh();
  d0 := public.rm_dashboard(ini365, hoje, 'todos');
  men0 := public.rm_dashboard(ini365, hoje, 'mensal');
  past0 := public.rm_dashboard(((n - interval '6 months') at time zone 'America/Sao_Paulo')::date - 30, ((n - interval '6 months') at time zone 'America/Sao_Paulo')::date, 'todos');
  h0 := (select payload from public.rm_cache where plano = 'todos');

  -- ---------- clientes de teste ----------
  create temp table _fx (id text, prod text, email text, ts timestamptz, status text, plano text, liquido numeric) on commit drop;
  insert into _fx values
    ('rmt-a1', p_fp, 'a@rm-teste.invalid', n - interval '14 months', 'paid', 'Plano Anual', 400),
    ('rmt-a2', p_fp, 'a@rm-teste.invalid', n - interval '2 months', 'paid', 'Plano Anual', 400),
    ('rmt-b1', p_fp, 'b@rm-teste.invalid', n - interval '14 months', 'paid', 'Plano Anual', 400),
    ('rmt-c1', p_fp, 'c@rm-teste.invalid', n - interval '15 months', 'paid', 'Plano Anual', 400),
    ('rmt-c2', p_fp, 'c@rm-teste.invalid', n - interval '3 months' + interval '40 days', 'paid', 'Plano Anual', 400),
    ('rmt-d1', p_ft, 'd@rm-teste.invalid', n - interval '3 months', 'paid', 'Plano Mensal', 130),
    ('rmt-d2', p_ft, 'd@rm-teste.invalid', n - interval '2 months', 'refunded', 'Plano Mensal', 130),
    ('rmt-e1', p_ft, 'e@rm-teste.invalid', n - interval '3 months', 'paid', 'Plano Mensal', 130),
    ('rmt-e2', p_ft, 'e@rm-teste.invalid', n - interval '2 months' + interval '1 day', 'refused', 'Plano Mensal', 130),
    ('rmt-f1', p_ft, 'f@rm-teste.invalid', n - interval '3 months', 'paid', 'Plano Mensal', 130),
    ('rmt-g1', p_fp, 'g@rm-teste.invalid', n - interval '14 months', 'paid', 'Plano Anual', 400),
    ('rmt-g2', p_ft, 'g@rm-teste.invalid', n - interval '6 months', 'paid', 'Plano Anual', 500),
    ('rmt-h1', p_fp, 'h@rm-teste.invalid', n - interval '14 months', 'paid', 'Plano Anual', 400),
    ('rmt-h2', p_ft, 'h@rm-teste.invalid', n - interval '14 months' + interval '5 days', 'paid', 'Plano Anual', 500),
    ('rmt-i1', p_fp, 'i@rm-teste.invalid', n - interval '11 months', 'paid', 'Plano Anual', 400),
    ('rmt-j1', p_fp, 'j@rm-teste.invalid', n - interval '1 month', 'paid', 'Teste', 0),
    ('rmt-k1', p_fp, 'k@rm-teste.invalid', n - interval '2 months', 'paid', 'Plano Anual', 400),
    ('rmt-k2', p_ft, 'k@rm-teste.invalid', n - interval '2 months', 'paid', 'Plano Anual', 500),
    ('rmt-k3', p_fs, 'k@rm-teste.invalid', n - interval '2 months', 'paid', 'Plano Anual', 500),
    ('rmt-l1', p_fs, 'l@rm-teste.invalid', n - interval '1 month', 'paid', 'Plano Semestral', 390),
    ('rmt-m1', p_ft, 'm@rm-teste.invalid', n - interval '12 months' - interval '1 day', 'paid', 'Plano Anual', 500),
    ('rmt-o1', p_ft, 'o@rm-teste.invalid', n - interval '12 months' - interval '2 days', 'paid', 'Plano Anual', 500),
    ('rmt-o2', p_ft, 'o@rm-teste.invalid', n - interval '1 day', 'paid', 'Plano Anual', 500);
  insert into public.kiwify_sales_snapshot (id, product_id, year, month, status, net_amount, charge_amount, customer_name, customer_email, sale_created_at, plan_name)
  select id, prod, extract(year from ts)::int, extract(month from ts)::int, status, liquido, liquido, 'Teste RM', email, ts, plano from _fx;

  drop table if exists _v, _vit, _sp;   -- tabelas temporárias da 1ª rodada de rm_refresh (mesma transação)
  perform public.rm_refresh();
  d1 := public.rm_dashboard(ini365, hoje, 'todos');
  men1 := public.rm_dashboard(ini365, hoje, 'mensal');
  past1 := public.rm_dashboard(((n - interval '6 months') at time zone 'America/Sao_Paulo')::date - 30, ((n - interval '6 months') at time zone 'America/Sao_Paulo')::date, 'todos');
  h1 := (select payload from public.rm_cache where plano = 'todos');
  vazio := public.rm_dashboard(date '2025-01-01', date '2025-01-31', 'todos');

  -- ---------- conferências (diferença depois − antes) ----------
  -- churn no período (365 dias), por escopo e motivo
  insert into _chk
  select 'churn ' || sc || ' ' || k, esp,
         coalesce(((select c from jsonb_array_elements(d1->'periodo'->sc->'churn') c where c->>'plano' = 'todos')->>k)::numeric, 0)
       - coalesce(((select c from jsonb_array_elements(d0->'periodo'->sc->'churn') c where c->>'plano' = 'todos')->>k)::numeric, 0)
    from (values
      ('flowpages', 'total', 4), ('flowpages', 'nao_identificado', 4), ('flowpages', 'voluntario', 0), ('flowpages', 'involuntario', 0),
      ('flowtracking', 'total', 4), ('flowtracking', 'voluntario', 1), ('flowtracking', 'involuntario', 1), ('flowtracking', 'nao_identificado', 2),
      ('flowspy', 'total', 0),
      ('all', 'total', 6), ('all', 'voluntario', 1), ('all', 'involuntario', 1), ('all', 'nao_identificado', 4)) v(sc, k, esp);
  -- churn por plano
  insert into _chk
  select 'churn ' || sc || ' plano ' || pl, esp,
         coalesce(((select c from jsonb_array_elements(d1->'periodo'->sc->'churn') c where c->>'plano' = pl)->>'total')::numeric, 0)
       - coalesce(((select c from jsonb_array_elements(d0->'periodo'->sc->'churn') c where c->>'plano' = pl)->>'total')::numeric, 0)
    from (values ('flowpages', 'anual', 4), ('flowtracking', 'mensal', 3), ('flowtracking', 'anual', 1), ('all', 'mensal', 3), ('all', 'anual', 3)) v(sc, pl, esp);
  -- filtro de plano mensal: o churn do período vem só do mensal
  insert into _chk values ('filtro mensal: churn flowtracking',
    3, coalesce(((select c from jsonb_array_elements(men1->'periodo'->'flowtracking'->'churn') c where c->>'plano' = 'mensal')->>'total')::numeric, 0)
     - coalesce(((select c from jsonb_array_elements(men0->'periodo'->'flowtracking'->'churn') c where c->>'plano' = 'mensal')->>'total')::numeric, 0));
  insert into _chk values ('filtro mensal: novos flowtracking (D, E, F)',
    3, (men1->'periodo'->'flowtracking'->>'novos')::numeric - (men0->'periodo'->'flowtracking'->>'novos')::numeric);
  -- renovação anual
  insert into _chk
  select 'renovação anual ' || sc || ' ' || k, esp,
         coalesce(((select r from jsonb_array_elements(d1->'periodo'->sc->'renovacao') r where r->>'plano' = 'anual')->>k)::numeric, 0)
       - coalesce(((select r from jsonb_array_elements(d0->'periodo'->sc->'renovacao') r where r->>'plano' = 'anual')->>k)::numeric, 0)
    from (values ('flowpages', 'devidas', 5), ('flowpages', 'renovadas', 1), ('flowpages', 'pendentes', 0),
                 ('flowtracking', 'devidas', 3), ('flowtracking', 'renovadas', 1), ('flowtracking', 'pendentes', 1),
                 ('flowtracking', 'fechadas', 1), ('flowtracking', 'renovadas_fechadas', 0),
                 ('all', 'devidas', 8), ('all', 'renovadas', 2), ('all', 'pendentes', 1)) v(sc, k, esp);
  -- carência aberta: a taxa parcial informa quando fica final (fim da carência de M, vencido há 5 dias)
  insert into _chk values ('renovação parcial: fecha_em >= vencimento de M + 3 dias', 1,
    case when ((select r from jsonb_array_elements(d1->'periodo'->'flowtracking'->'renovacao') r where r->>'plano' = 'anual')->>'fecha_em')::timestamptz
              >= n - interval '1 day' + interval '3 days' - interval '1 second' then 1 else 0 end);
  insert into _chk values ('M em carência não é churn', 0, (select count(*) from public.rm_spells where email = 'm@rm-teste.invalid' and encerrado));
  -- base ativa no fim do período (hoje)
  insert into _chk
  select 'base hoje ' || sc || ' ' || k, esp, (d1->'periodo'->sc->'base'->>k)::numeric - (d0->'periodo'->sc->'base'->>k)::numeric
    from (values ('all', 'clientes', 7), ('all', 'assinaturas', 9), ('all', 'pagantes', 7),
                 ('flowpages', 'clientes', 4), ('flowtracking', 'clientes', 3), ('flowspy', 'clientes', 2)) v(sc, k, esp);
  -- histórico: base 6 meses atrás usa a situação daquela data (B, G e H estavam ativos e hoje saíram; M e O também contam)
  insert into _chk
  select 'base há 6 meses ' || k, esp, (past1->'periodo'->'all'->'base'->>k)::numeric - (past0->'periodo'->'all'->'base'->>k)::numeric
    from (values ('clientes', 8), ('assinaturas', 10)) v(k, esp);
  -- monetização: 1, 2 e 3 ferramentas e combinações
  insert into _chk
  select 'mix ' || k, esp, coalesce((d1->'periodo'->'all'->'mix'->'por_qtd'->>k)::numeric, 0) - coalesce((d0->'periodo'->'all'->'mix'->'por_qtd'->>k)::numeric, 0)
    from (values ('1', 6), ('2', 0), ('3', 1)) v(k, esp);
  insert into _chk values ('mix combo três ferramentas', 1,
    coalesce((d1->'periodo'->'all'->'mix'->'combos'->>'flowpages+flowspy+flowtracking')::numeric, 0) - coalesce((d0->'periodo'->'all'->'mix'->'combos'->>'flowpages+flowspy+flowtracking')::numeric, 0));
  insert into _chk values ('mix filtro Flow Spy: clientes com Spy (K, L)', 2,
    (d1->'periodo'->'flowspy'->'mix'->>'clientes')::numeric - (d0->'periodo'->'flowspy'->'mix'->>'clientes')::numeric);
  -- novos clientes no período (1ª compra paga)
  insert into _chk
  select 'novos ' || sc, esp, (d1->'periodo'->sc->>'novos')::numeric - (d0->'periodo'->sc->>'novos')::numeric
    from (values ('flowpages', 2), ('flowtracking', 5), ('flowspy', 2), ('all', 6)) v(sc, esp);
  -- retenção por coorte: D30 da coorte mensal de D/E/F (nenhum renovou) e D365 da coorte anual (só A)
  insert into _chk
  select 'coorte ' || sc || ' ' || to_char(m, 'YYYY-MM') || ' ' || k, esp,
         coalesce((select case when k = 'clientes' then (c->>'clientes')::numeric else (c->'marcos'->>k)::numeric end from jsonb_array_elements(h1->'escopos'->sc->'coortes') c where c->>'coorte' = to_char(m, 'YYYY-MM-DD')), 0)
       - coalesce((select case when k = 'clientes' then (c->>'clientes')::numeric else (c->'marcos'->>k)::numeric end from jsonb_array_elements(h0->'escopos'->sc->'coortes') c where c->>'coorte' = to_char(m, 'YYYY-MM-DD')), 0)
    from (values
      ('flowtracking', date_trunc('month', (n - interval '3 months') at time zone 'America/Sao_Paulo'), 'clientes', 3),
      ('flowtracking', date_trunc('month', (n - interval '3 months') at time zone 'America/Sao_Paulo'), '1', 0),
      ('flowpages', date_trunc('month', (n - interval '14 months') at time zone 'America/Sao_Paulo'), 'clientes', 4),
      ('flowpages', date_trunc('month', (n - interval '14 months') at time zone 'America/Sao_Paulo'), '12', 1)) v(sc, m, k, esp);
  -- teste grátis não entra em nada
  insert into _chk values ('teste grátis (J) fora do cache', 0, (select count(*) from public.rm_charges where email = 'j@rm-teste.invalid'));
  -- cancelamento agendado (I): ativo, sem churn
  insert into _chk values ('I ativo e sem churn', 0, (select count(*) from public.rm_spells where email = 'i@rm-teste.invalid' and encerrado));
  -- C: a compra 40 dias depois do vencimento abriu período novo (2 períodos) e não é renovação
  insert into _chk values ('C tem 2 períodos', 2, (select count(*) from public.rm_spells where email = 'c@rm-teste.invalid'));
  insert into _chk values ('C não renovou', 0, (select count(*) from public.rm_renov where email = 'c@rm-teste.invalid' and renovou));
  -- G: churn na ferramenta Pages, mas o cliente continua (consolidado sem churn)
  insert into _chk values ('G consolidado sem churn', 0, (select count(*) from public.rm_cspells where email = 'g@rm-teste.invalid' and encerrado));
  -- consolidado bate com a soma das ferramentas (dados reais + teste): assinaturas e renovações
  insert into _chk values ('assinaturas: consolidado = soma das ferramentas',
    (d1->'periodo'->'flowpages'->'base'->>'assinaturas')::numeric + (d1->'periodo'->'flowtracking'->'base'->>'assinaturas')::numeric + (d1->'periodo'->'flowspy'->'base'->>'assinaturas')::numeric,
    (d1->'periodo'->'all'->'base'->>'assinaturas')::numeric);
  insert into _chk values ('renovações anuais: consolidado = soma das ferramentas',
    (select coalesce(sum((r->>'devidas')::numeric), 0) from jsonb_array_elements(d1->'periodo'->'flowpages'->'renovacao') r where r->>'plano' = 'anual')
    + (select coalesce(sum((r->>'devidas')::numeric), 0) from jsonb_array_elements(d1->'periodo'->'flowtracking'->'renovacao') r where r->>'plano' = 'anual')
    + (select coalesce(sum((r->>'devidas')::numeric), 0) from jsonb_array_elements(d1->'periodo'->'flowspy'->'renovacao') r where r->>'plano' = 'anual'),
    (select coalesce(sum((r->>'devidas')::numeric), 0) from jsonb_array_elements(d1->'periodo'->'all'->'renovacao') r where r->>'plano' = 'anual'));
  -- soma dos motivos = churn total, em todo o histórico mensal e em todos os escopos
  insert into _chk values ('histórico: voluntário + involuntário + não identificado = total', 0,
    (select count(*) from jsonb_each(h1->'escopos') e, jsonb_array_elements(e.value->'churn_mes') c
      where (c->>'voluntario')::int + (c->>'involuntario')::int + (c->>'nao_identificado')::int <> (c->>'total')::int));
  -- 1 + 2 + 3 ferramentas = clientes (100%)
  insert into _chk values ('mix: 1 + 2 + 3 = clientes', (d1->'periodo'->'all'->'mix'->>'clientes')::numeric,
    (select sum(v::numeric) from jsonb_each_text(d1->'periodo'->'all'->'mix'->'por_qtd') x(k, v)));
  -- período sem dados (jan/2025, antes das vendas): tudo zero, sem renovação e sem custo
  insert into _chk values ('sem dados: clientes', 0, (vazio->'periodo'->'all'->'base'->>'clientes')::numeric);
  insert into _chk values ('sem dados: renovações devidas', 0, (select count(*) from jsonb_array_elements(vazio->'periodo'->'all'->'renovacao')));
  insert into _chk values ('sem dados: novos', 0, (vazio->'periodo'->'all'->>'novos')::numeric);
  insert into _chk values ('sem dados: marketing nulo (CAC não disponível)', 1, case when vazio->'periodo'->'all'->'marketing' = 'null'::jsonb or vazio->'periodo'->'all'->'marketing' is null then 1 else 0 end);
  -- LTV/CAC do histórico: a fórmula guardada bate com o recálculo independente (mês passado, Flow Pages)
  dt := date_trunc('month', (n at time zone 'America/Sao_Paulo') - interval '1 month') at time zone 'America/Sao_Paulo';
  insert into _chk
  select 'CAC flowpages mês passado = (comissão 1ªs compras + marketing) ÷ novos',
         round((
           (select coalesce(sum(coalesce(a.commission, 0)), 0) from public.rm_charges c left join public.affiliate_sales a on a.id = c.sale_id
             where c.tool = 'flowpages' and c.n = 1 and c.ts >= dt and c.ts < dt + interval '1 month' and c.email not like '%@rm-teste.invalid')
           + coalesce((select sum(e.amount) from public.monthly_expenses e join public.expense_categories g on g.id = e.category_id join public.tools t on t.id = e.tool_id
             where t.slug = 'flowpages' and g.group_name = 'Marketing' and e.year = extract(year from dt at time zone 'America/Sao_Paulo') and e.month = extract(month from dt at time zone 'America/Sao_Paulo')), 0)
         ) / nullif((select count(*) from public.rm_charges c where c.tool = 'flowpages' and c.n = 1 and c.ts >= dt and c.ts < dt + interval '1 month' and c.email not like '%@rm-teste.invalid'), 0), 2),
         (select (x->>'cac')::numeric from jsonb_array_elements(h0->'escopos'->'flowpages'->'serie') x where (x->>'mes')::date = (dt at time zone 'America/Sao_Paulo')::date);
  insert into _chk
  select 'permanência = Σ base em risco ÷ Σ churn (12 meses, consolidado)',
         round((select sum((x->>'base_risco')::numeric) / nullif(sum((x->>'churn')::numeric), 0) from (select x from jsonb_array_elements(h0->'escopos'->'all'->'serie') x order by (x->>'mes')::date desc limit 12) z), 2),
         (select (x->>'permanencia')::numeric from jsonb_array_elements(h0->'escopos'->'all'->'serie') x order by (x->>'mes')::date desc limit 1);

  select coalesce(jsonb_agg(jsonb_build_object('teste', nome, 'esperado', esperado, 'obtido', obtido)), '[]') into falhas
    from _chk where esperado is distinct from obtido;
  select count(*) into ok from _chk where esperado is not distinct from obtido;
  raise exception 'RM_TESTES %', jsonb_build_object('ok', ok, 'falhas', falhas, 'total', (select count(*) from _chk));
end $test$;
