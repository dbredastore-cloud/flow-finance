-- Comentário opcional de cada despesa no mês (aparece como tooltip na linha da despesa).
alter table public.monthly_expenses
  add column if not exists note text check (char_length(note) <= 500);
