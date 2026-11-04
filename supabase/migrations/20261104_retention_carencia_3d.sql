-- Retenção e Monetização: carência de 3 dias (antes 20).
--
-- Regra do usuário: quem não renovou até o vencimento já é churn, com tolerância de 3 dias. Muda em todos os pontos
-- que usavam os 20 dias:
--   · períodos contínuos (rm_spells/rm_cspells): cobrança nova até 3 dias depois do vencimento continua o período;
--   · período encerrado (churn) = vencimento + 3 dias já passou; o churn conta na data do vencimento;
--   · renovação: nova cobrança paga entre 45 dias antes e 3 dias depois do vencimento; pendente até vencimento + 3 dias;
--     quem entrou no vitalício até vencimento + 3 dias sai das oportunidades;
--   · motivo: reembolso/chargeback entre 45 dias antes e 3 dias depois do fim; falha de pagamento entre 10 dias antes
--     e 3 dias depois;
--   · coortes de retenção completas = mês da coorte + marco + 3 dias; "em carência agora" e fim da renovação parcial.
-- Todos os "interval '20 days'" de rm_refresh, rm_build e rm_dashboard são essa carência; troca todos.

do $$
declare f text; def text;
begin
  foreach f in array array['public.rm_refresh()', 'public.rm_build(text)', 'public.rm_dashboard(date, date, text)'] loop
    def := pg_get_functiondef(f::regprocedure);
    if position('''20 days''' in def) > 0 then
      execute replace(def, '''20 days''', '''3 days''');
    end if;
  end loop;
end $$;

select public.rm_refresh();
