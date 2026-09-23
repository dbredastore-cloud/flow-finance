-- Blindagem de acesso aos dados.
--
-- Antes: qualquer usuário autenticado lia/escrevia tudo (policies "using (true)").
-- Agora: só quem está em app_admins acessa qualquer tabela. Uma conta criada por fora
-- (cadastro aberto, convite etc.) não enxerga nada.

create table if not exists public.app_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  created_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;

insert into public.app_admins (user_id, email)
select id, email from auth.users where email = 'flow@tbnegociosdigitais.com'
on conflict (user_id) do nothing;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

drop policy if exists admin_read_app_admins on public.app_admins;
create policy admin_read_app_admins on public.app_admins for select to authenticated using (public.is_admin());

-- Tentativas de login (gravadas pela Edge Function auth-login). Nunca guarda senha.
create table if not exists public.login_attempts (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  email       text,
  ip          text,
  country     text,
  user_agent  text,
  success     boolean not null,
  reason      text,
  seen_at     timestamptz
);
create index if not exists login_attempts_ip_idx on public.login_attempts (ip, created_at desc);
create index if not exists login_attempts_open_idx on public.login_attempts (created_at desc) where not success and seen_at is null;
alter table public.login_attempts enable row level security;

-- Recria todas as policies das tabelas do painel exigindo admin.
do $$
declare
  r record;
  t text;
  read_only text[] := array['affiliate_sales','sync_state','youtube_channels','youtube_videos',
    'monthly_revenue_manual_backup','kiwify_sales_snapshot','kiwify_monthly_product'];
  read_update text[] := array['kiwify_products','affiliates','revenue_alerts','login_attempts'];
  read_write text[] := array['tools','expense_categories','monthly_expenses','monthly_revenue'];
begin
  for r in select tablename, policyname from pg_policies
           where schemaname = 'public' and tablename = any(read_only || read_update || read_write) loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
  foreach t in array read_only || read_update || read_write loop
    execute format('create policy admin_read on public.%I for select to authenticated using (public.is_admin())', t);
  end loop;
  foreach t in array read_update loop
    execute format('create policy admin_update on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
  foreach t in array read_write loop
    execute format('create policy admin_insert on public.%I for insert to authenticated with check (public.is_admin())', t);
    execute format('create policy admin_update on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    execute format('create policy admin_delete on public.%I for delete to authenticated using (public.is_admin())', t);
  end loop;
end $$;

-- Visitante sem login (anon) não tem permissão nenhuma nas tabelas/views do painel.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
