-- Alunos por plataforma (students_all_summary) ficou lenta depois de juntar os produtos por nome (5–22 s medidos
-- em 12/11/2026, contra 1,7–2,8 s antes). O tempo ia em contar e-mails distintos: ordenar ~68 mil e-mails com as
-- regras do português é caro. Agora os e-mails são comparados byte a byte (collate "C") e os distintos são
-- contados por hash (select distinct), e a divisão por plataforma é calculada uma vez. Resultado idêntico ao anterior.
create or replace function public.students_all_summary(p_products text[] default null)
returns jsonb
language sql
stable
set search_path = ''
set work_mem = '64MB'
as $$
with s0 as (
  select 'k:' || k.product_id as pid, p.name as nome, 'Kiwify' as plataforma, lower(k.customer_email) collate "C" as email,
         k.status in ('paid', 'approved') as paga, k.status in ('refunded', 'chargedback') as devolvida, k.net_amount as valor, k.sale_created_at as ts
    from public.kiwify_sales_snapshot k join public.kiwify_products p on p.id = k.product_id
  union all
  select 't:' || o.product_id, coalesce(tp.name, o.product_name), 'TMB', lower(o.customer_email) collate "C", o.status = 'Efetivado', o.status = 'Cancelado', o.total_amount, o.created_at
    from public.tmb_orders o left join public.tmb_products tp on tp.id = o.product_id
  union all
  select 'h:' || h.product_id, coalesce(hp.name, h.product_name), 'Hotmart', lower(h.buyer_email) collate "C", h.status in ('APPROVED', 'COMPLETE'), h.status in ('REFUNDED', 'PARTIALLY_REFUNDED', 'CHARGEBACK'),
         case when h.currency = 'BRL' then h.price_value end, h.order_date
    from public.hotmart_sales h left join public.hotmart_products hp on hp.id = h.product_id where h.commission_as in ('PRODUCER', 'COPRODUCER')
),
s as materialized (select s0.*, ('n:' || lower(btrim(coalesce(s0.nome, s0.pid)))) collate "C" as gid from s0),
sel as materialized (select * from s where p_products is null or pid = any(p_products) or gid = any(p_products)),
pg as materialized (select * from sel where paga),
flow as materialized (select distinct email collate "C" as email from public.customer_tools),
por_plat as materialized (select gid, plataforma, count(*) filter (where paga) as n from s group by 1, 2),
plat_txt as materialized (
  select gid, case when count(*) = 1 then max(plataforma) else string_agg(plataforma || ' ' || n, ' · ' order by n desc, plataforma) end as txt
    from por_plat group by 1
),
alunos_prod as materialized (select gid, count(*) a from (select distinct gid, email from s where paga) z group by 1),
prod as materialized (
  select s.gid, (array_agg(s.nome order by s.paga desc, s.ts desc))[1] as nome, count(*) filter (where paga) n,
         sum(valor) filter (where paga) v, count(*) filter (where devolvida) r, max(ts) u
    from s group by 1
)
select jsonb_build_object(
  'gerado_em', now(),
  'vendas', (select count(*) from pg),
  'alunos', (select count(*) from (select distinct email from pg) z),
  'valor', (select coalesce(sum(valor), 0) from pg),
  'ticket_medio', (select round(avg(valor), 2) from pg),
  'devolvidas', (select count(*) from sel where devolvida),
  'multi_plataforma', (select count(*) from (select email from (select distinct email, plataforma from pg) d group by 1 having count(*) > 1) x),
  'tambem_flow', (select count(*) from (select distinct pg.email from pg join flow f on f.email = pg.email) z),
  'por_plataforma', coalesce((select jsonb_object_agg(plataforma, n) from (select plataforma, count(*) n from (select distinct plataforma, email from pg) d group by 1) x), '{}'::jsonb),
  'produtos', coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.gid, 'nome', x.nome, 'plataforma', pt.txt,
      'vendas', x.n, 'alunos', coalesce(ap.a, 0), 'valor', x.v, 'reembolsos', x.r, 'ultimo', x.u) order by x.n desc, x.nome)
    from prod x left join plat_txt pt on pt.gid = x.gid left join alunos_prod ap on ap.gid = x.gid), '[]'::jsonb)
);
$$;
