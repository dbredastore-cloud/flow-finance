-- Vários lançamentos da mesma categoria no mesmo mês (valores, datas e formas de pagamento diferentes).
-- Antes: unique (tool_id, category_id, year, month) permitia uma só linha. Os totais (monthly_summary,
-- flow_health) já somam as linhas, então não mudam.
alter table public.monthly_expenses
  drop constraint if exists monthly_expenses_tool_id_category_id_year_month_key;

create index if not exists idx_expenses_tool_period
  on public.monthly_expenses (tool_id, year, month, category_id);
