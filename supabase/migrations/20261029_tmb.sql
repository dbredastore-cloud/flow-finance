-- TMB (Tem Mais no Boleto): alunos que compram cursos, comunidade e combos parcelados no boleto.
--
-- A Edge Function tmb-sync lê a API da TMB (secret TMB_API_TOKEN) a cada 30 minutos e regrava
-- produtos e pedidos. A API devolve pedidos efetivados e cancelados, com o status financeiro
-- (Adimplente, Inadimplente, Sem Financiamento…), então a releitura completa já pega as mudanças.
--
-- Dados pessoais: guardamos só nome, e-mail, telefone, cidade e estado. CPF, endereço completo e
-- data de nascimento que a TMB manda ficam de fora.
--
-- Ainda não entra no financeiro (monthly_revenue): falta definir se a receita conta no pedido
-- efetivado ou parcela a parcela.

create table if not exists public.tmb_products (
  id              integer primary key,
  name            text not null,
  description     text,
  price_text      text,            -- "valor_total" da TMB, que vem formatado ("R$ 2.497,00")
  active          boolean,
  includes_tools  text[] not null default '{}',  -- slugs de tools que o produto libera (combos)
  manual          boolean not null default false, -- includes_tools corrigido à mão: o sync não mexe
  updated_at      timestamptz not null default now()
);

create table if not exists public.tmb_orders (
  id                  bigint primary key,   -- pedido_id
  product_id          integer not null,
  product_name        text,
  status              text,                 -- status_pedido: Efetivado | Cancelado
  financial_status    text,                 -- status_financeiro
  customer_name       text,
  customer_email      text,
  phone               text,
  city                text,
  state               text,
  total_amount        numeric(12,2),
  down_payment        numeric(12,2),
  installment_amount  numeric(12,2),
  installments        integer,
  admin_fee_pct       numeric(6,2),
  created_at          timestamptz,
  effective_at        timestamptz,
  best_payment_day    integer,
  utm_source          text,
  utm_medium          text,
  utm_campaign        text,
  utm_content         text,
  synced_at           timestamptz not null default now()
);
create index if not exists tmb_orders_email_idx on public.tmb_orders (lower(customer_email));
create index if not exists tmb_orders_product_idx on public.tmb_orders (product_id, created_at desc);

alter table public.tmb_products enable row level security;
alter table public.tmb_orders enable row level security;
drop policy if exists tmb_products_read on public.tmb_products;
drop policy if exists tmb_products_write on public.tmb_products;
drop policy if exists tmb_orders_read on public.tmb_orders;
create policy tmb_products_read on public.tmb_products for select to authenticated
  using ((select public.can(array['fin.financeiro', 'fin.health', 'fin.clients'])));
create policy tmb_products_write on public.tmb_products for update to authenticated
  using ((select public.can(array['fin.clients']))) with check ((select public.can(array['fin.clients'])));
create policy tmb_orders_read on public.tmb_orders for select to authenticated
  using ((select public.can(array['fin.clients'])));
revoke all on public.tmb_products, public.tmb_orders from anon;
grant select, update on public.tmb_products to authenticated;
grant select on public.tmb_orders to authenticated;

-- Resumo para a tela Saúde dos clientes.
create or replace function public.tmb_summary() returns jsonb
language sql stable security invoker set search_path = '' as $$
with o as (
  select *, lower(customer_email) as email from public.tmb_orders
),
ef as (select * from o where status = 'Efetivado'),
flow as (select distinct email from public.customer_software)
select jsonb_build_object(
  'gerado_em', now(),
  'ultima_leitura', (select max(synced_at) from public.tmb_orders),
  'pedidos', (select count(*) from o),
  'efetivados', (select count(*) from ef),
  'cancelados', (select count(*) from o where status = 'Cancelado'),
  'alunos', (select count(distinct email) from ef),
  'valor_vendido', (select coalesce(sum(total_amount), 0) from ef),
  'ticket_medio', (select round(avg(total_amount), 2) from ef),
  'parcelas_media', (select round(avg(installments), 1) from ef),
  'financeiro', coalesce((select jsonb_object_agg(fs, n) from (
      select coalesce(financial_status, '(sem status)') fs, count(*) n from ef group by 1) x), '{}'::jsonb),
  'tambem_flow', (select count(distinct ef.email) from ef join flow f on f.email = ef.email),
  'mensal', coalesce((select jsonb_agg(jsonb_build_object('mes', mes, 'efetivados', n, 'valor', v) order by mes) from (
      select to_char(created_at at time zone 'America/Sao_Paulo', 'YYYY-MM') mes, count(*) n, sum(total_amount) v
        from ef where created_at >= now() - interval '13 months' group by 1) x), '[]'::jsonb),
  'produtos', coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'nome', p.name, 'ativo', p.active, 'ferramentas', p.includes_tools,
      'efetivados', x.n, 'cancelados', x.c, 'alunos', x.a, 'valor', x.v, 'inadimplentes', x.i, 'ultimo', x.u)
      order by x.n desc nulls last, p.name)
    from public.tmb_products p
    left join (select product_id, count(*) filter (where status = 'Efetivado') n, count(*) filter (where status = 'Cancelado') c,
                      count(distinct email) filter (where status = 'Efetivado') a,
                      sum(total_amount) filter (where status = 'Efetivado') v,
                      count(*) filter (where status = 'Efetivado' and financial_status ilike 'inadimpl%') i,
                      max(created_at) u
                 from o group by 1) x on x.product_id = p.id), '[]'::jsonb)
);
$$;
revoke all on function public.tmb_summary() from public, anon;
grant execute on function public.tmb_summary() to authenticated;

-- Compras na TMB de um cliente (ficha do cliente).
create or replace function public.tmb_customer(p_email text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'data', created_at, 'produto', product_name, 'status', status, 'financeiro', financial_status,
      'valor', total_amount, 'parcelas', installments, 'entrada', down_payment, 'parcela', installment_amount)
      order by created_at desc), '[]'::jsonb)
  from public.tmb_orders where lower(customer_email) = lower(btrim(p_email));
$$;
revoke all on function public.tmb_customer(text) from public, anon;
grant execute on function public.tmb_customer(text) to authenticated;

-- Puxada a cada 30 minutos (mesmo segredo de cron da Kiwify).
select cron.unschedule('tmb-sync') where exists (select 1 from cron.job where jobname = 'tmb-sync');
select cron.schedule(
  'tmb-sync',
  '7,37 * * * *',
  $$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/tmb-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
