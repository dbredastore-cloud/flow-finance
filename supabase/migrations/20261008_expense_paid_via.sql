-- Forma de pagamento de cada despesa: cartão da empresa (Cartão Flow) ou cobrança via Biancode.
-- null = ainda não classificada.
alter table public.monthly_expenses
  add column if not exists paid_via text check (paid_via in ('cartao', 'biancode'));
