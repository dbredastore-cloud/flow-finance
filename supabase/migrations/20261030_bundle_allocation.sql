-- Rateio de combos: quanto de cada venda de um combo (ex.: Combo Vitalício Viver de Dólar 2026)
-- é de cada ferramenta e da Comunidade.
--
-- Método: preço avulso relativo (CPC 47 / IFRS 15). Cada item do combo tem um preço de referência
-- avulso na mesma base (plano anual); o peso do item = preço dele ÷ soma dos preços, e esse peso é
-- aplicado ao valor líquido de cada venda do combo. Os preços ficam editáveis no painel.
--
-- Valor líquido por plataforma:
--   Kiwify  = net_amount (já sem taxa e comissão)
--   TMB     = valor total × (1 − taxa de administração)   [estimado]
--   Hotmart = preço − taxa da Hotmart, só vendas em BRL     [comissão de afiliado não vem na API]

create table if not exists public.product_bundles (
  id          text primary key,
  name        text not null,
  notes       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.bundle_components (
  bundle_id   text not null references public.product_bundles(id) on delete cascade,
  component   text not null,        -- slug de tools (flowpages…) ou outro item (comunidade)
  label       text not null,
  ref_price   numeric(12,2) not null check (ref_price >= 0),
  sort        integer not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (bundle_id, component)
);

create table if not exists public.bundle_products (
  platform    text not null check (platform in ('kiwify', 'tmb', 'hotmart')),
  product_id  text not null,
  bundle_id   text not null references public.product_bundles(id) on delete cascade,
  primary key (platform, product_id)
);

alter table public.product_bundles enable row level security;
alter table public.bundle_components enable row level security;
alter table public.bundle_products enable row level security;
drop policy if exists bundles_read on public.product_bundles;
drop policy if exists bundle_components_read on public.bundle_components;
drop policy if exists bundle_components_write on public.bundle_components;
drop policy if exists bundle_products_read on public.bundle_products;
create policy bundles_read on public.product_bundles for select to authenticated
  using ((select public.can(array['fin.financeiro', 'fin.health', 'fin.clients'])));
create policy bundle_components_read on public.bundle_components for select to authenticated
  using ((select public.can(array['fin.financeiro', 'fin.health', 'fin.clients'])));
create policy bundle_components_write on public.bundle_components for update to authenticated
  using ((select public.can(array['fin.clients']))) with check ((select public.can(array['fin.clients'])));
create policy bundle_products_read on public.bundle_products for select to authenticated
  using ((select public.can(array['fin.financeiro', 'fin.health', 'fin.clients'])));
revoke all on public.product_bundles, public.bundle_components, public.bundle_products from anon;
grant select on public.product_bundles, public.bundle_products to authenticated;
grant select, update (ref_price, updated_at, updated_by) on public.bundle_components to authenticated;

-- Combo Vitalício Viver de Dólar 2026. Preços de referência: plano anual avulso
-- (Comunidade = ticket anual na TMB; ferramentas = média cobrada nos planos anuais da Kiwify em 2026).
insert into public.product_bundles (id, name, notes) values
  ('cvd-vitalicio-2026', 'Combo Vitalício Viver de Dólar 2026', 'Comunidade Viver de Dólar + Flow Pages, Flow Tracking e Flow Spy, vitalícios')
on conflict (id) do nothing;
insert into public.bundle_components (bundle_id, component, label, ref_price, sort) values
  ('cvd-vitalicio-2026', 'comunidade',   'Comunidade Viver de Dólar', 2497, 1),
  ('cvd-vitalicio-2026', 'flowtracking', 'Flow Tracking',              660, 2),
  ('cvd-vitalicio-2026', 'flowspy',      'Flow Spy',                   630, 3),
  ('cvd-vitalicio-2026', 'flowpages',    'Flow Pages',                 440, 4)
on conflict (bundle_id, component) do nothing;
insert into public.bundle_products (platform, product_id, bundle_id) values
  ('kiwify',  'da753340-94c8-11f1-b764-b7fe74a7e480', 'cvd-vitalicio-2026'),
  ('tmb',     '37604',                                'cvd-vitalicio-2026'),
  ('hotmart', '8386734',                              'cvd-vitalicio-2026')
on conflict (platform, product_id) do nothing;

-- O kiwify-revenue também lê as vendas dos produtos de combo (sem tool_id, então ficam fora do
-- financeiro por ferramenta e do Flow Health).
insert into public.kiwify_products (id, name, tool_id) values
  ('da753340-94c8-11f1-b764-b7fe74a7e480', 'Combo Vitalício Viver de Dólar 2026', null)
on conflict (id) do nothing;

-- Vendas e rateio de cada combo, por plataforma e por item.
create or replace function public.bundle_allocation() returns jsonb
language sql stable security invoker set search_path = '' as $$
with vendas as (
  select bp.bundle_id, 'kiwify' as platform, count(*) as n, sum(coalesce(s.charge_amount, s.net_amount)) as bruto, sum(s.net_amount) as liquido,
         min(s.sale_created_at) as primeira, max(s.sale_created_at) as ultima
    from public.bundle_products bp join public.kiwify_sales_snapshot s on s.product_id = bp.product_id
   where bp.platform = 'kiwify' and s.status in ('paid', 'approved') group by 1
  union all
  select bp.bundle_id, 'tmb', count(*), sum(o.total_amount), sum(o.total_amount * (1 - coalesce(o.admin_fee_pct, 0) / 100)),
         min(o.created_at), max(o.created_at)
    from public.bundle_products bp join public.tmb_orders o on o.product_id::text = bp.product_id
   where bp.platform = 'tmb' and o.status = 'Efetivado' group by 1
  union all
  select bp.bundle_id, 'hotmart', count(*), sum(h.price_value), sum(h.price_value - coalesce(h.fee_total, 0)),
         min(h.order_date), max(h.order_date)
    from public.bundle_products bp join public.hotmart_sales h on h.product_id::text = bp.product_id
   where bp.platform = 'hotmart' and h.commission_as in ('PRODUCER', 'COPRODUCER') and h.status in ('APPROVED', 'COMPLETE') and h.currency = 'BRL'
   group by 1
),
pesos as (
  select c.*, c.ref_price / nullif(sum(c.ref_price) over (partition by c.bundle_id), 0) as peso
    from public.bundle_components c
)
select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'nome', b.name, 'notas', b.notes,
    'vendas', coalesce((select sum(n) from vendas v where v.bundle_id = b.id), 0),
    'bruto', coalesce((select sum(bruto) from vendas v where v.bundle_id = b.id), 0),
    'liquido', coalesce((select sum(liquido) from vendas v where v.bundle_id = b.id), 0),
    'plataformas', coalesce((select jsonb_agg(jsonb_build_object('plataforma', v.platform, 'vendas', v.n, 'bruto', round(v.bruto, 2),
        'liquido', round(v.liquido, 2), 'primeira', v.primeira, 'ultima', v.ultima) order by v.liquido desc) from vendas v where v.bundle_id = b.id), '[]'::jsonb),
    'itens', coalesce((select jsonb_agg(jsonb_build_object('componente', p.component, 'nome', p.label, 'preco_ref', p.ref_price,
        'peso', round(p.peso, 4),
        'liquido', round(p.peso * coalesce((select sum(liquido) from vendas v where v.bundle_id = b.id), 0), 2),
        'por_venda', round(p.peso * coalesce((select sum(liquido) / nullif(sum(n), 0) from vendas v where v.bundle_id = b.id), 0), 2),
        'atualizado', p.updated_at) order by p.sort) from pesos p where p.bundle_id = b.id), '[]'::jsonb)
  ) order by b.name), '[]'::jsonb)
  from public.product_bundles b;
$$;
revoke all on function public.bundle_allocation() from public, anon;
grant execute on function public.bundle_allocation() to authenticated;
