-- Hotmart: vendas da conta (cursos, comunidade, combos e "Pagamento Alternativo - Flow Tools").
--
-- A Edge Function hotmart-sync lê o histórico de vendas da API da Hotmart (secrets HOTMART_CLIENT_ID,
-- HOTMART_CLIENT_SECRET e HOTMART_BASIC) a cada 30 minutos. A conta vende como produtora e também
-- ganha comissão como afiliada de produtos de terceiros: commission_as separa os dois. Os alunos
-- da Flow são as vendas como PRODUCER.
--
-- price_value é o preço da venda na moeda da compra (currency); a comissão líquida não vem nesse
-- endpoint. Dados pessoais: só nome e e-mail do comprador.

create table if not exists public.hotmart_products (
  id              bigint primary key,
  name            text not null,
  status          text,
  format          text,
  is_subscription boolean,
  includes_tools  text[] not null default '{}',   -- slugs de tools que o produto libera
  manual          boolean not null default false, -- includes_tools corrigido à mão: o sync não mexe
  updated_at      timestamptz not null default now()
);

create table if not exists public.hotmart_sales (
  transaction        text primary key,
  product_id         bigint not null,
  product_name       text,
  commission_as      text,          -- PRODUCER | COPRODUCER | AFFILIATE
  status             text,          -- APPROVED, COMPLETE, REFUNDED, CHARGEBACK, CANCELLED…
  is_subscription    boolean,
  recurrency_number  integer,
  buyer_name         text,
  buyer_email        text,
  price_value        numeric(12,2),
  currency           text,
  fee_total          numeric(12,2),
  payment_type       text,
  installments       integer,
  offer_code         text,
  payment_mode       text,
  order_date         timestamptz,
  approved_date      timestamptz,
  warranty_until     timestamptz,
  source_sck         text,
  synced_at          timestamptz not null default now()
);
create index if not exists hotmart_sales_email_idx on public.hotmart_sales (lower(buyer_email));
create index if not exists hotmart_sales_product_idx on public.hotmart_sales (product_id, order_date desc);

alter table public.hotmart_products enable row level security;
alter table public.hotmart_sales enable row level security;
drop policy if exists hotmart_products_read on public.hotmart_products;
drop policy if exists hotmart_products_write on public.hotmart_products;
drop policy if exists hotmart_sales_read on public.hotmart_sales;
create policy hotmart_products_read on public.hotmart_products for select to authenticated
  using ((select public.can(array['fin.financeiro', 'fin.health', 'fin.clients'])));
create policy hotmart_products_write on public.hotmart_products for update to authenticated
  using ((select public.can(array['fin.clients']))) with check ((select public.can(array['fin.clients'])));
create policy hotmart_sales_read on public.hotmart_sales for select to authenticated
  using ((select public.can(array['fin.clients'])));
revoke all on public.hotmart_products, public.hotmart_sales from anon;
grant select, update on public.hotmart_products to authenticated;
grant select on public.hotmart_sales to authenticated;

-- Resumo para a tela Saúde dos clientes (só vendas como produtora; afiliado vem à parte).
create or replace function public.hotmart_summary() returns jsonb
language sql stable security invoker set search_path = '' as $$
with s as (
  select *, lower(buyer_email) as email, status in ('APPROVED', 'COMPLETE') as paga from public.hotmart_sales
),
p as (select * from s where commission_as in ('PRODUCER', 'COPRODUCER')),
pg as (select * from p where paga),
flow as (select distinct email from public.customer_software)
select jsonb_build_object(
  'gerado_em', now(),
  'ultima_leitura', (select max(synced_at) from public.hotmart_sales),
  'primeira_venda', (select min(order_date) from s),
  'vendas', (select count(*) from pg),
  'alunos', (select count(distinct email) from pg),
  'reembolsos', (select count(*) from p where status in ('REFUNDED', 'PARTIALLY_REFUNDED')),
  'chargebacks', (select count(*) from p where status = 'CHARGEBACK'),
  'canceladas', (select count(*) from p where status in ('CANCELLED', 'EXPIRED', 'NO_FUNDS', 'PROTESTED', 'BLOCKED')),
  'valor_brl', (select coalesce(sum(price_value), 0) from pg where currency = 'BRL'),
  'vendas_outras_moedas', (select count(*) from pg where currency <> 'BRL'),
  'assinaturas', (select count(*) from pg where is_subscription),
  'tambem_flow', (select count(distinct pg.email) from pg join flow f on f.email = pg.email),
  'afiliado', jsonb_build_object(
      'vendas', (select count(*) from s where commission_as = 'AFFILIATE' and paga),
      'produtos', (select count(distinct product_id) from s where commission_as = 'AFFILIATE' and paga)),
  'produtos', coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.product_id, 'nome', coalesce(hp.name, x.nome), 'ferramentas', coalesce(hp.includes_tools, '{}'),
      'vendas', x.n, 'alunos', x.a, 'valor_brl', x.v, 'reembolsos', x.r, 'ultimo', x.u) order by x.n desc)
    from (select product_id, max(product_name) nome, count(*) filter (where paga) n, count(distinct email) filter (where paga) a,
                 sum(price_value) filter (where paga and currency = 'BRL') v,
                 count(*) filter (where status in ('REFUNDED', 'PARTIALLY_REFUNDED', 'CHARGEBACK')) r, max(order_date) u
            from p group by 1) x
    left join public.hotmart_products hp on hp.id = x.product_id), '[]'::jsonb)
);
$$;
revoke all on function public.hotmart_summary() from public, anon;
grant execute on function public.hotmart_summary() to authenticated;

-- Compras na Hotmart de um cliente (ficha do cliente; inclui as feitas como afiliado).
create or replace function public.hotmart_customer(p_email text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'data', order_date, 'produto', product_name, 'status', status, 'como', commission_as,
      'valor', price_value, 'moeda', currency, 'pagamento', payment_type, 'parcelas', installments,
      'assinatura', is_subscription, 'recorrencia', recurrency_number)
      order by order_date desc), '[]'::jsonb)
  from public.hotmart_sales where lower(buyer_email) = lower(btrim(p_email));
$$;
revoke all on function public.hotmart_customer(text) from public, anon;
grant execute on function public.hotmart_customer(text) to authenticated;

-- Puxada a cada 30 minutos (mesmo segredo de cron da Kiwify).
select cron.unschedule('hotmart-sync') where exists (select 1 from cron.job where jobname = 'hotmart-sync');
select cron.schedule(
  'hotmart-sync',
  '22,52 * * * *',
  $$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/hotmart-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
