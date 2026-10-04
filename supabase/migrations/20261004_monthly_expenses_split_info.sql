-- Rateio de despesas: guarda o valor cheio e em quantas partes foi dividido,
-- para a tela mostrar "rateado — total R$ X ÷ 3" na linha da despesa.
alter table public.monthly_expenses
  add column if not exists split_total numeric(14,2),
  add column if not exists split_parts smallint;

comment on column public.monthly_expenses.split_total is 'Valor cheio que foi rateado entre as ferramentas (null = lançamento normal)';
comment on column public.monthly_expenses.split_parts is 'Em quantas partes o valor cheio foi dividido (null = lançamento normal)';
