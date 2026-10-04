-- Dia da cobrança no cartão das despesas.
--   expense_categories.billing_day : dia fixo do mês (1–31) em que a categoria é cobrada.
--   monthly_expenses.charged_on    : data real da cobrança naquele mês (sobrepõe o dia fixo).
alter table public.expense_categories
  add column if not exists billing_day smallint check (billing_day between 1 and 31);
alter table public.monthly_expenses
  add column if not exists charged_on date;
