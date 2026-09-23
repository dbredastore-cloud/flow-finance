-- Flow Health: planos, renovações, churn, LTV, CAC e metas.

-- Dados extras de cada venda (preenchidos pelo kiwify-revenue).
alter table public.kiwify_sales_snapshot add column if not exists plan_id text;
alter table public.kiwify_sales_snapshot add column if not exists plan_name text;
alter table public.kiwify_sales_snapshot add column if not exists parent_order_id text;
alter table public.kiwify_sales_snapshot add column if not exists utm_source text;
create index if not exists kiwify_sales_snapshot_customer_idx on public.kiwify_sales_snapshot (product_id, lower(customer_email));

-- Planos da Kiwify e quantos meses cada pagamento cobre. "months" é deduzido do nome
-- (Mensal=1, Trimestral=3, Semestral=6, resto=12) e pode ser corrigido no painel.
create table if not exists public.kiwify_plans (
  plan_id     text primary key,
  product_id  text,
  plan_name   text,
  months      integer not null default 12 check (months between 1 and 120),
  manual      boolean not null default false,
  first_seen  timestamptz not null default now()
);
alter table public.kiwify_plans enable row level security;
drop policy if exists admin_read on public.kiwify_plans;
drop policy if exists admin_update on public.kiwify_plans;
create policy admin_read on public.kiwify_plans for select to authenticated using (public.is_admin());
create policy admin_update on public.kiwify_plans for update to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.guess_plan_months(p_name text) returns integer
language sql immutable set search_path = '' as $$
  select case
    when p_name ~* 'mensal|monthly' then 1
    when p_name ~* 'trimestr' then 3
    when p_name ~* 'semestr|semestre' then 6
    else 12 end;
$$;

-- Metas anuais do painel.
create table if not exists public.flow_goals (
  year               integer primary key,
  new_customers      integer not null,
  revenue            numeric(14,2) not null,
  updated_at         timestamptz not null default now()
);
alter table public.flow_goals enable row level security;
drop policy if exists admin_read on public.flow_goals;
drop policy if exists admin_write on public.flow_goals;
create policy admin_read on public.flow_goals for select to authenticated using (public.is_admin());
create policy admin_write on public.flow_goals for all to authenticated using (public.is_admin()) with check (public.is_admin());
insert into public.flow_goals (year, new_customers, revenue) values (2026, 8600, 3000000)
on conflict (year) do nothing;
