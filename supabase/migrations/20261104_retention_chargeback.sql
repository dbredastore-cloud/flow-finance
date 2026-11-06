-- Retenção e Monetização: chargeback como motivo próprio de churn e data da 1ª venda por ferramenta.
--
-- Antes "voluntario" juntava reembolso e chargeback. Agora (mesma janela: 45 dias antes a 3 dias depois do fim):
--   voluntario   · reembolso (refunded) pedido pelo cliente
--   chargeback   · contestação no cartão (chargedback); se houve reembolso também, fica voluntário
--   involuntario · falha de pagamento (refused/waiting_payment) de 10 dias antes a 3 dias depois do fim
--   nao_identificado · nenhum dos três
-- rm_build (churn_mes) e rm_dashboard (churn) passam a devolver a coluna "chargeback"; no consolidado, o período da
-- ferramenta que acabou por último define o motivo (desempate: voluntário, chargeback, involuntário, não identificado).
-- rm_dashboard devolve também "primeira_venda" de cada escopo (filtro "Período total" da tela).
-- Mesmo padrão das migrations anteriores: troca trechos do corpo das funções já criadas e confere cada troca.

do $$
declare def text; novo text;
begin
  -- rm_refresh: motivo chargeback e desempate no consolidado
  def := pg_get_functiondef('public.rm_refresh()'::regprocedure);
  if position('then ''chargeback''' in def) = 0 then
    novo := replace(def,
      E'x.status in (''refunded'', ''chargedback'')\n                              and x.ts between sp.fim - interval ''45 days'' and sp.fim + interval ''3 days'') then ''voluntario''',
      E'x.status = ''refunded''\n                              and x.ts between sp.fim - interval ''45 days'' and sp.fim + interval ''3 days'') then ''voluntario''\n'
      || E'              when exists (select 1 from _v x where x.tool = sp.tool and x.email = sp.email and x.status = ''chargedback''\n'
      || E'                              and x.ts between sp.fim - interval ''45 days'' and sp.fim + interval ''3 days'') then ''chargeback''');
    if novo = def then raise exception 'rm_refresh: trecho do motivo não encontrado'; end if;
    def := novo;
    novo := replace(def, 'when ''involuntario'' then 2 else 3', 'when ''chargeback'' then 2 when ''involuntario'' then 3 else 4');
    if novo = def then raise exception 'rm_refresh: desempate não encontrado'; end if;
    execute novo;
  end if;

  -- rm_build: coluna chargeback no churn mês a mês
  def := pg_get_functiondef('public.rm_build(text)'::regprocedure);
  if position('as chargeback' in def) = 0 then
    novo := replace(def, 'count(*) filter (where sp.motivo = ''voluntario'') as voluntario,',
                         'count(*) filter (where sp.motivo = ''voluntario'') as voluntario, count(*) filter (where sp.motivo = ''chargeback'') as chargeback,');
    novo := replace(novo, '''voluntario'', voluntario, ''involuntario''', '''voluntario'', voluntario, ''chargeback'', chargeback, ''involuntario''');
    novo := replace(novo, 'coalesce(c.voluntario, 0) as voluntario,', 'coalesce(c.voluntario, 0) as voluntario, coalesce(c.chargeback, 0) as chargeback,');
    if position('''chargeback'', chargeback' in novo) = 0 or position('coalesce(c.chargeback, 0) as chargeback' in novo) = 0 then
      raise exception 'rm_build: trecho não encontrado';
    end if;
    execute novo;
  end if;

  -- rm_dashboard: coluna chargeback no churn do período e 1ª venda por escopo
  def := pg_get_functiondef('public.rm_dashboard(date, date, text)'::regprocedure);
  if position('as chargeback' in def) = 0 then
    novo := replace(def, 'count(*) filter (where sp.motivo = ''voluntario'') as voluntario,',
                         'count(*) filter (where sp.motivo = ''voluntario'') as voluntario, count(*) filter (where sp.motivo = ''chargeback'') as chargeback,');
    novo := replace(novo, 'select scope, coalesce(plano, ''todos'') as plano, total, voluntario, involuntario, nao_identificado from (',
                          'select scope, coalesce(plano, ''todos'') as plano, total, voluntario, chargeback, involuntario, nao_identificado from (');
    novo := replace(novo, '''voluntario'', coalesce(c.voluntario, 0),', '''voluntario'', coalesce(c.voluntario, 0), ''chargeback'', coalesce(c.chargeback, 0),');
    novo := replace(novo, E'''mix'', (select mix from mix_out m where m.scope = sc.scope)\n    ) as p',
                          E'''mix'', (select mix from mix_out m where m.scope = sc.scope),\n'
                          || E'      ''primeira_venda'', (select min(c.ts) from public.rm_charges c where sc.scope = ''all'' or c.tool = sc.scope)\n    ) as p');
    if position('''chargeback'', coalesce(c.chargeback, 0)' in novo) = 0 or position('total, voluntario, chargeback,' in novo) = 0
       or position('''primeira_venda''' in novo) = 0 then
      raise exception 'rm_dashboard: trecho não encontrado';
    end if;
    execute novo;
  end if;
end $$;

select public.rm_refresh();
