-- Horas de dev. passa a ficar no Financeiro (abaixo de Ferramentas) e mostra, para cada demanda da planilha,
-- o card do Trello ligado a ela (título, lista e resumo). Por isso quem tem o menu fin.hours também lê trello_cards
-- (a tela usa a visão trello_cards_list, que tem security_invoker e segue esta mesma regra).
drop policy if exists admin_read on public.trello_cards;
create policy admin_read on public.trello_cards for select to authenticated
  using ((select public.can(array['fin.trello', 'fin.instagram', 'fin.hours'])));
