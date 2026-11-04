-- Saúde dos clientes: resumos de alunos rápidos (antes estouravam o limite de 8 s do banco).
--
-- kiwify_students_summary lia k.* (com o JSON bruto da venda) de 65 mil vendas numa CTE que ia para o disco
-- e era lida várias vezes (≈8–11 s). Agora pega só as colunas usadas. Nas três funções, a lista de e-mails
-- que também são clientes Flow (customer_tools) é calculada uma vez só (materialized), em vez de o
-- planejador refazer a view dentro do join. Mesmo resultado de antes.

create or replace function public.kiwify_students_summary(p_products text[] default null)
returns jsonb language sql stable set search_path = '' set work_mem = '64MB' as $$
with s as materialized (
  select k.product_id, k.status, k.net_amount, k.charge_amount, k.sale_created_at, k.synced_at,
         lower(k.customer_email) as email, k.status in ('paid', 'approved') as paga, p.name as produto
    from public.kiwify_sales_snapshot k
    join public.kiwify_products p on p.id = k.product_id
),
sel as materialized (select * from s where p_products is null or product_id = any(p_products)),
pg as materialized (select * from sel where paga),
flow as materialized (select distinct email from public.customer_tools)
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

create or replace function public.students_all_summary(p_products text[] default null)
returns jsonb language sql stable set search_path = '' set work_mem = '64MB' as $$
with s as materialized (
  select 'k:' || k.product_id as pid, p.name as nome, 'Kiwify' as plataforma, lower(k.customer_email) as email,
         k.status in ('paid', 'approved') as paga, k.status in ('refunded', 'chargedback') as devolvida,
         k.net_amount as valor, k.sale_created_at as ts
    from public.kiwify_sales_snapshot k join public.kiwify_products p on p.id = k.product_id
  union all
  select 't:' || o.product_id, coalesce(tp.name, o.product_name), 'TMB', lower(o.customer_email),
         o.status = 'Efetivado', o.status = 'Cancelado', o.total_amount, o.created_at
    from public.tmb_orders o left join public.tmb_products tp on tp.id = o.product_id
  union all
  select 'h:' || h.product_id, coalesce(hp.name, h.product_name), 'Hotmart', lower(h.buyer_email),
         h.status in ('APPROVED', 'COMPLETE'), h.status in ('REFUNDED', 'PARTIALLY_REFUNDED', 'CHARGEBACK'),
         case when h.currency = 'BRL' then h.price_value end, h.order_date
    from public.hotmart_sales h left join public.hotmart_products hp on hp.id = h.product_id
   where h.commission_as in ('PRODUCER', 'COPRODUCER')
),
sel as materialized (select * from s where p_products is null or pid = any(p_products)),
pg as materialized (select * from sel where paga),
flow as materialized (select distinct email from public.customer_tools)
select jsonb_build_object(
  'gerado_em', now(),
  'vendas', (select count(*) from pg),
  'alunos', (select count(distinct email) from pg),
  'valor', (select coalesce(sum(valor), 0) from pg),
  'ticket_medio', (select round(avg(valor), 2) from pg),
  'devolvidas', (select count(*) from sel where devolvida),
  'multi_plataforma', (select count(*) from (select email from pg group by 1 having count(distinct plataforma) > 1) x),
  'tambem_flow', (select count(distinct pg.email) from pg join flow f on f.email = pg.email),
  'por_plataforma', coalesce((select jsonb_object_agg(plataforma, n) from (select plataforma, count(distinct email) n from pg group by 1) x), '{}'::jsonb),
  'produtos', coalesce((select jsonb_agg(jsonb_build_object(
      'id', pid, 'nome', nome, 'plataforma', plataforma, 'vendas', n, 'alunos', a, 'valor', v, 'reembolsos', r, 'ultimo', u) order by n desc, nome)
    from (select pid, max(nome) nome, max(plataforma) plataforma, count(*) filter (where paga) n, count(distinct email) filter (where paga) a,
                 sum(valor) filter (where paga) v, count(*) filter (where devolvida) r, max(ts) u
            from s group by 1) x), '[]'::jsonb)
);
$$;

create or replace function public.tmb_summary(p_products integer[] default null)
returns jsonb language sql stable set search_path = '' as $$
with o as materialized (
  select *, lower(customer_email) as email from public.tmb_orders
),
sel as materialized (select * from o where p_products is null or product_id = any(p_products)),
ef as materialized (select * from sel where status = 'Efetivado'),
flow as materialized (select distinct email from public.customer_tools)
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
