-- Preferências de tela por usuário (ex.: largura das colunas da tabela do YouTube).
-- Cada admin só enxerga e altera as próprias linhas.
create table if not exists public.ui_prefs (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key        text not null check (char_length(key) between 1 and 80),
  value      jsonb not null check (octet_length(value::text) <= 20000),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.ui_prefs enable row level security;

drop policy if exists own_read   on public.ui_prefs;
drop policy if exists own_insert on public.ui_prefs;
drop policy if exists own_update on public.ui_prefs;
drop policy if exists own_delete on public.ui_prefs;
create policy own_read   on public.ui_prefs for select to authenticated using (public.is_admin() and user_id = auth.uid());
create policy own_insert on public.ui_prefs for insert to authenticated with check (public.is_admin() and user_id = auth.uid());
create policy own_update on public.ui_prefs for update to authenticated using (public.is_admin() and user_id = auth.uid()) with check (public.is_admin() and user_id = auth.uid());
create policy own_delete on public.ui_prefs for delete to authenticated using (public.is_admin() and user_id = auth.uid());

revoke all on public.ui_prefs from anon;
grant select, insert, update, delete on public.ui_prefs to authenticated;
