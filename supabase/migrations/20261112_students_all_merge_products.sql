-- Alunos por plataforma → aba "Todas": o mesmo produto vendido em mais de uma plataforma (mesmo nome, ex.:
-- Black Viver de Dólar na Kiwify, TMB e Hotmart) vira uma linha só, com a divisão na coluna Plataforma
-- ("Kiwify 288 · TMB 16 · Hotmart 4"). Antes eram 3 linhas soltas e parecia que a Black tinha 4 vendas.
-- O id da linha passa a ser "n:<nome>"; o filtro de produtos aceita esse id e também os antigos (k:/t:/h:),
-- para as seleções já guardadas nos navegadores continuarem valendo. Totais do topo não mudam.
create or replace function public.students_all_summary(p_products text[] default null)
returns jsonb
language sql
stable
set search_path = ''
set work_mem = '64MB'
as $$
with s0 as (
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
s as materialized (select s0.*, 'n:' || lower(btrim(coalesce(s0.nome, s0.pid))) as gid from s0),
sel as materialized (select * from s where p_products is null or pid = any(p_products) or gid = any(p_products)),
pg as materialized (select * from sel where paga),
flow as materialized (select distinct email from public.customer_tools),
por_plat as (
  select gid, plataforma, count(*) filter (where paga) as n, count(*) as linhas from s group by 1, 2
),
prod as (
  select s.gid, (array_agg(s.nome order by s.paga desc, s.ts desc))[1] as nome,
         count(*) filter (where paga) n, count(distinct email) filter (where paga) a,
         sum(valor) filter (where paga) v, count(*) filter (where devolvida) r, max(ts) u
    from s group by 1
)
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
      'id', x.gid, 'nome', x.nome,
      'plataforma', (select case when count(*) = 1 then max(pp.plataforma)
                                 else string_agg(pp.plataforma || ' ' || pp.n, ' · ' order by pp.n desc, pp.plataforma) end
                       from por_plat pp where pp.gid = x.gid),
      'vendas', x.n, 'alunos', x.a, 'valor', x.v, 'reembolsos', x.r, 'ultimo', x.u) order by x.n desc, x.nome)
    from prod x), '[]'::jsonb)
);
$$;

-- Coluna "Libera" na aba Hotmart: o nome dos produtos não cita as ferramentas, então o sync não as detectava.
-- manual = true para o hotmart-sync não sobrescrever.
update public.hotmart_products set includes_tools = array['flowpages', 'flowtracking', 'flowspy'], manual = true
 where id in (8665339, 8386734); -- Black Viver de Dólar, Combo Vitalício Viver de Dólar 2026
