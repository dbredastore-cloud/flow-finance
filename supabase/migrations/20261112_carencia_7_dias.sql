-- Carência das ferramentas: 7 dias em todos os cálculos (pedido do usuário em 12/11/2026).
-- Antes: 15 dias na Saúde dos clientes (customer_software), nos acessos por ferramenta (tool_access_summary) e no
-- Flow Health (flow_health); 3 dias na Retenção e Monetização (rm_refresh, rm_dashboard, rm_build).
-- Carência = depois do vencimento, o cliente ainda pode renovar sem contar como cancelado/churn.
-- Não mudam (não são carência): janela de renovação de 45 dias, "10 dias antes do vencimento" das cobranças
-- recusadas, e as janelas dos alertas.
-- Troca só os trechos na definição em produção e falha se algum não for encontrado (ou já estiver em 7 dias).
do $mig$
declare
  r record; def text; n int;
begin
  -- Funções: (nome, texto antigo, texto novo, quantas vezes deve aparecer)
  for r in select * from (values
    ('public.tool_access_summary(text)', 'now() - interval ''15 days'' then ''carencia''', 'now() - interval ''7 days'' then ''carencia''', 1),
    ('public.flow_health(integer)', 'interval ''15 days'' as carencia', 'interval ''7 days'' as carencia', 1),
    ('public.rm_refresh()', 'interval ''3 days''', 'interval ''7 days''', null),
    ('public.rm_dashboard(date,date,text)', 'interval ''3 days''', 'interval ''7 days''', null),
    ('public.rm_build(text)', 'interval ''3 days''', 'interval ''7 days''', null)
  ) v(fn, old_txt, new_txt, expected)
  loop
    def := pg_get_functiondef(r.fn::regprocedure);
    n := (length(def) - length(replace(def, r.old_txt, ''))) / length(r.old_txt);
    if n = 0 or (r.expected is not null and n <> r.expected) then
      raise exception 'carência 7 dias: % tem % ocorrência(s) de "%"', r.fn, n, r.old_txt;
    end if;
    execute replace(def, r.old_txt, r.new_txt);
    raise notice '% → % troca(s)', r.fn, n;
  end loop;

  -- View da Saúde dos clientes.
  def := pg_get_viewdef('public.customer_software'::regclass);
  if position('''15 days''::interval' in def) = 0 then raise exception 'customer_software: 15 dias não encontrado'; end if;
  execute 'create or replace view public.customer_software with (security_invoker = true) as '
          || replace(def, '''15 days''::interval', '''7 days''::interval');
end
$mig$;
