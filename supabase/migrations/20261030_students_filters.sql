-- Alunos por plataforma (Kiwify, TMB e Hotmart) com filtro de produtos.
--
-- Cada resumo recebe a lista de produtos escolhidos na tela (null = todos) e devolve os números só deles;
-- a lista "produtos" volta sempre completa (com os números de cada um), para o seletor da tela.
-- Kiwify: vendas dos produtos que não são ferramenta (cursos, comunidade, combos), gravadas pelo
-- kiwify-sync em kiwify_sales_snapshot. As ferramentas já aparecem nas outras partes da tela.

drop function if exists public.tmb_summary();
drop function if exists public.hotmart_summary();

create or replace function public.tmb_summary(p_products integer[] default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
with o as (
  select *, lower(customer_email) as email from public.tmb_orders
),
sel as (select * from o where p_products is null or product_id = any(p_products)),
ef as (select * from sel where status = 'Efetivado'),
flow as (select distinct email from public.customer_software)
select jsonb_build_object(
  'gerado_em', now(),
  'ultima_leitura', (select max(synced_at) from public.tmb_orders),
  'pedidos', (select count(*) from sel),
  'efetivados', (select count(*) from ef),
  'cancelados', (select count(*) from sel where status = 'Cancelado'),
  'alunos', (select count(distinct email) from ef),
  'valor_vendido', (select coalesce(sum(total_amount), 0) from ef),
  'ticket_medio', (select round(avg(total_amount), 2) from ef),
  'parcelas_media', (select round(avg(installments), 1) from ef),
  'financeiro', coalesce((select jsonb_object_agg(fs, n) from (
      select coalesce(financial_status, '(sem status)') fs, count(*) n from ef group by 1) x), '{}'::jsonb),
  'tambem_flow', (select count(distinct ef.email) from ef join flow f on f.email = ef.email),
  'produtos', coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id::text, 'nome', p.name, 'ativo', p.active, 'ferramentas', p.includes_tools,
      'efetivados', coalesce(x.n, 0), 'cancelados', coalesce(x.c, 0), 'alunos', coalesce(x.a, 0), 'valor', x.v,
      'inadimplentes', coalesce(x.i, 0), 'ultimo', x.u)
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
revoke all on function public.tmb_summary(integer[]) from public, anon;
grant execute on function public.tmb_summary(integer[]) to authenticated;

create or replace function public.hotmart_summary(p_products bigint[] default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
with s as (
  select *, lower(buyer_email) as email, status in ('APPROVED', 'COMPLETE') as paga from public.hotmart_sales
),
p as (select * from s where commission_as in ('PRODUCER', 'COPRODUCER')),
sel as (select * from p where p_products is null or product_id = any(p_products)),
pg as (select * from sel where paga),
flow as (select distinct email from public.customer_software)
select jsonb_build_object(
  'gerado_em', now(),
  'ultima_leitura', (select max(synced_at) from public.hotmart_sales),
  'primeira_venda', (select min(order_date) from p),
  'vendas', (select count(*) from pg),
  'alunos', (select count(distinct email) from pg),
  'reembolsos', (select count(*) from sel where status in ('REFUNDED', 'PARTIALLY_REFUNDED')),
  'chargebacks', (select count(*) from sel where status = 'CHARGEBACK'),
  'valor_brl', (select coalesce(sum(price_value), 0) from pg where currency = 'BRL'),
  'ticket_medio', (select round(avg(price_value), 2) from pg where currency = 'BRL'),
  'parcelas_media', (select round(avg(installments), 1) from pg),
  'vendas_outras_moedas', (select count(*) from pg where currency <> 'BRL'),
  'assinaturas', (select count(*) from pg where is_subscription),
  'tambem_flow', (select count(distinct pg.email) from pg join flow f on f.email = pg.email),
  'afiliado', jsonb_build_object(
      'vendas', (select count(*) from s where commission_as = 'AFFILIATE' and paga),
      'produtos', (select count(distinct product_id) from s where commission_as = 'AFFILIATE' and paga)),
  'produtos', coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.product_id::text, 'nome', coalesce(hp.name, x.nome), 'ferramentas', coalesce(hp.includes_tools, '{}'),
      'vendas', x.n, 'alunos', x.a, 'valor', x.v, 'reembolsos', x.r, 'ultimo', x.u) order by x.n desc, coalesce(hp.name, x.nome))
    from (select product_id, max(product_name) nome, count(*) filter (where paga) n, count(distinct email) filter (where paga) a,
                 sum(price_value) filter (where paga and currency = 'BRL') v,
                 count(*) filter (where status in ('REFUNDED', 'PARTIALLY_REFUNDED', 'CHARGEBACK')) r, max(order_date) u
            from p group by 1) x
    left join public.hotmart_products hp on hp.id = x.product_id), '[]'::jsonb)
);
$$;
revoke all on function public.hotmart_summary(bigint[]) from public, anon;
grant execute on function public.hotmart_summary(bigint[]) to authenticated;

create or replace function public.kiwify_students_summary(p_products text[] default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
with s as (
  select k.*, lower(k.customer_email) as email, k.status in ('paid', 'approved') as paga, p.name as produto
    from public.kiwify_sales_snapshot k
    join public.kiwify_products p on p.id = k.product_id
   where p.tool_id is null
),
sel as (select * from s where p_products is null or product_id = any(p_products)),
pg as (select * from sel where paga),
flow as (select distinct email from public.customer_software)
select jsonb_build_object(
  'gerado_em', now(),
  'ultima_leitura', (select max(synced_at) from s),
  'primeira_venda', (select min(sale_created_at) from s),
  'vendas', (select count(*) from pg),
  'alunos', (select count(distinct email) from pg),
  'liquido', (select coalesce(sum(net_amount), 0) from pg),
  'bruto', (select coalesce(sum(charge_amount), 0) from pg),
  'ticket_medio', (select round(avg(net_amount), 2) from pg),
  'reembolsos', (select count(*) from sel where status = 'refunded'),
  'chargebacks', (select count(*) from sel where status = 'chargedback'),
  'recusadas', (select count(*) from sel where status = 'refused'),
  'tambem_flow', (select count(distinct pg.email) from pg join flow f on f.email = pg.email),
  'produtos', coalesce((select jsonb_agg(jsonb_build_object(
      'id', product_id, 'nome', nome, 'vendas', n, 'alunos', a, 'valor', v, 'reembolsos', r, 'ultimo', u) order by n desc, nome)
    from (select product_id, max(produto) nome, count(*) filter (where paga) n, count(distinct email) filter (where paga) a,
                 sum(net_amount) filter (where paga) v, count(*) filter (where status in ('refunded', 'chargedback')) r,
                 max(sale_created_at) u
            from s group by 1) x), '[]'::jsonb)
);
$$;
revoke all on function public.kiwify_students_summary(text[]) from public, anon;
grant execute on function public.kiwify_students_summary(text[]) to authenticated;

-- Compras na Kiwify de um cliente em produtos que não são ferramenta (ficha do cliente).
create or replace function public.kiwify_customer(p_email text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'data', k.sale_created_at, 'produto', p.name, 'status', k.status, 'valor', k.net_amount, 'pagamento', k.payment_method)
      order by k.sale_created_at desc), '[]'::jsonb)
  from public.kiwify_sales_snapshot k
  join public.kiwify_products p on p.id = k.product_id
  where p.tool_id is null and lower(k.customer_email) = lower(btrim(p_email));
$$;
revoke all on function public.kiwify_customer(text) from public, anon;
grant execute on function public.kiwify_customer(text) to authenticated;
