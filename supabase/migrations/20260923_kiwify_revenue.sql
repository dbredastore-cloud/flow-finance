-- Receita mensal do financeiro calculada automaticamente a partir da Kiwify.
--
-- Regras (conferidas com os valores lançados à mão em ago/2026, FlowTracking):
--   faturamento     = soma do net_amount das vendas pagas criadas no mês (horário de Brasília)
--   reembolsos      = vendas criadas no mês que estão com status "refunded"
--   novos_usuarios  = quantidade de vendas pagas criadas no mês
--   usuarios_totais = soma acumulada de novos_usuarios desde o primeiro mês com venda

-- Cópia dos valores lançados à mão antes da automação (uma vez só).
create table if not exists public.monthly_revenue_manual_backup as
  select *, now() as backed_up_at from public.monthly_revenue;
alter table public.monthly_revenue_manual_backup enable row level security;
drop policy if exists auth_read_revenue_backup on public.monthly_revenue_manual_backup;
create policy auth_read_revenue_backup on public.monthly_revenue_manual_backup for select to authenticated using (true);

alter table public.monthly_revenue add column if not exists source text not null default 'manual';
alter table public.monthly_revenue add column if not exists synced_at timestamptz;

-- Totais por produto da Kiwify e mês, gravados pela Edge Function kiwify-revenue.
create table if not exists public.kiwify_monthly_product (
  product_id        text not null,
  year              integer not null,
  month             integer not null check (month between 1 and 12),
  paid_count        integer not null default 0,
  net_amount        numeric(14,2) not null default 0,
  charge_amount     numeric(14,2) not null default 0,
  refunded_count    integer not null default 0,
  chargeback_count  integer not null default 0,
  synced_at         timestamptz not null default now(),
  primary key (product_id, year, month)
);
alter table public.kiwify_monthly_product enable row level security;
drop policy if exists auth_read_kiwify_monthly_product on public.kiwify_monthly_product;
create policy auth_read_kiwify_monthly_product on public.kiwify_monthly_product for select to authenticated using (true);

-- Soma os produtos de cada ferramenta e grava em monthly_revenue (source = 'kiwify').
-- Só mexe em ferramentas que têm produto da Kiwify ligado, a partir de tools.revenue_start
-- (ou do 1º mês com venda, se não houver).
create or replace function public.refresh_revenue_from_kiwify() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with per_tool as (
    select p.tool_id, k.year, k.month,
           sum(k.net_amount) as faturamento,
           sum(k.refunded_count)::int as reembolsos,
           sum(k.paid_count)::int as novos
    from public.kiwify_monthly_product k
    join public.kiwify_products p on p.id = k.product_id
    where p.tool_id is not null
    group by 1, 2, 3
  ), started as (
    -- tools.revenue_start vem da migration 20260923_tools_revenue_start.sql
    select pt.*, coalesce(t.revenue_start,
             min(case when novos > 0 then make_date(pt.year, pt.month, 1) end) over (partition by pt.tool_id)) as first_month
    from per_tool pt join public.tools t on t.id = pt.tool_id
  ), rows as (
    select tool_id, year, month, faturamento, reembolsos, novos,
           sum(novos) over (partition by tool_id order by year, month)::int as totais
    from started
    where first_month is not null and make_date(year, month, 1) >= first_month
  )
  insert into public.monthly_revenue as r
    (tool_id, year, month, faturamento, reembolsos, novos_usuarios, usuarios_totais, source, synced_at, updated_at)
  select tool_id, year, month, faturamento, reembolsos, novos, totais, 'kiwify', now(), now() from rows
  on conflict (tool_id, year, month) do update set
    faturamento = excluded.faturamento, reembolsos = excluded.reembolsos,
    novos_usuarios = excluded.novos_usuarios, usuarios_totais = excluded.usuarios_totais,
    source = 'kiwify', synced_at = now(), updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.refresh_revenue_from_kiwify() from public, anon, authenticated;
grant execute on function public.refresh_revenue_from_kiwify() to service_role;
