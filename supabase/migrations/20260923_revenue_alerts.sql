-- Avisos de mudança em meses já fechados (reembolso, chargeback, venda aprovada depois etc.).
--
-- O kiwify-revenue guarda cada venda dos produtos ligados a ferramentas; ao reler um mês
-- fechado, compara com a leitura anterior e registra aqui o que mudou.

create table if not exists public.kiwify_sales_snapshot (
  id                 text primary key,
  product_id         text not null,
  year               integer not null,
  month              integer not null,
  status             text,
  net_amount         numeric(12,2),
  charge_amount      numeric(12,2),
  customer_name      text,
  customer_email     text,
  payment_method     text,
  sale_created_at    timestamptz,
  approved_at        timestamptz,
  refunded_at        timestamptz,
  kiwify_updated_at  timestamptz,
  synced_at          timestamptz not null default now()
);
create index if not exists kiwify_sales_snapshot_month_idx on public.kiwify_sales_snapshot (product_id, year, month);
alter table public.kiwify_sales_snapshot enable row level security;
drop policy if exists auth_read_kiwify_sales_snapshot on public.kiwify_sales_snapshot;
create policy auth_read_kiwify_sales_snapshot on public.kiwify_sales_snapshot for select to authenticated using (true);

-- Quando o mês ganhou a primeira leitura venda a venda (base para comparar).
alter table public.kiwify_monthly_product add column if not exists snapshot_at timestamptz;

create table if not exists public.revenue_alerts (
  id            uuid primary key default gen_random_uuid(),
  tool_id       uuid references public.tools(id) on delete cascade,
  product_id    text not null,
  product_name  text,
  year          integer not null,
  month         integer not null,
  before        jsonb not null,   -- {novos, faturamento, reembolsos, chargebacks}
  after         jsonb not null,
  changes       jsonb not null,   -- vendas que mudaram, com status anterior e novo
  created_at    timestamptz not null default now(),
  seen_at       timestamptz,
  seen_by       text
);
create index if not exists revenue_alerts_open_idx on public.revenue_alerts (created_at desc) where seen_at is null;
alter table public.revenue_alerts enable row level security;
drop policy if exists auth_read_revenue_alerts on public.revenue_alerts;
drop policy if exists auth_update_revenue_alerts on public.revenue_alerts;
create policy auth_read_revenue_alerts on public.revenue_alerts for select to authenticated using (true);
create policy auth_update_revenue_alerts on public.revenue_alerts for update to authenticated using (true) with check (true);
