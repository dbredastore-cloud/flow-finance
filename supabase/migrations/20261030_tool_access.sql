-- Acesso às ferramentas Flow por e-mail único, juntando as três plataformas.
--
-- Um "acesso" (tool_grants) é uma linha por e-mail × ferramenta × origem:
--   assinatura · plano mensal/semestral/anual da ferramenta (Kiwify), com cobertura até cobre_ate
--                (vem de customer_software, mesmas regras da tela: ativo, carência de 15 dias, cancelou)
--   vitalicio  · compra paga de um combo vitalício (product_bundles.lifetime) em qualquer plataforma,
--                que libera as ferramentas listadas em bundle_components; nunca vence
-- O mesmo e-mail com assinatura e combo conta uma vez só na ferramenta: a situação passa a ser
-- "vitalício" e ele aparece em "migrou para vitalício" (tinha assinatura antes de comprar o combo).
-- Compra reembolsada, recusada ou cancelada não dá acesso.

alter table public.product_bundles add column if not exists lifetime boolean not null default false;
update public.product_bundles set lifetime = true where id = 'cvd-vitalicio-2026';

create or replace view public.tool_grants with (security_invoker = true) as
with comp as (
  select c.bundle_id, c.component as tool
    from public.bundle_components c join public.tools t on t.slug = c.component
),
combo as (
  select bp.bundle_id, 'kiwify' as platform, lower(k.customer_email) as email, k.sale_created_at as ts
    from public.bundle_products bp join public.kiwify_sales_snapshot k on k.product_id = bp.product_id
   where bp.platform = 'kiwify' and k.status in ('paid', 'approved')
  union all
  select bp.bundle_id, 'tmb', lower(o.customer_email), o.created_at
    from public.bundle_products bp join public.tmb_orders o on o.product_id::text = bp.product_id
   where bp.platform = 'tmb' and o.status = 'Efetivado'
  union all
  select bp.bundle_id, 'hotmart', lower(h.buyer_email), h.order_date
    from public.bundle_products bp join public.hotmart_sales h on h.product_id::text = bp.product_id
   where bp.platform = 'hotmart' and h.status in ('APPROVED', 'COMPLETE') and h.commission_as in ('PRODUCER', 'COPRODUCER')
)
select c.platform, c.email, cp.tool, 'vitalicio'::text as kind, c.ts, null::timestamptz as cobre_ate, 1::bigint as pagamentos, b.name as plano
  from combo c
  join public.product_bundles b on b.id = c.bundle_id and b.lifetime
  join comp cp on cp.bundle_id = c.bundle_id
 where c.email is not null
union all
select 'kiwify', cs.email, cs.software, 'assinatura', cs.primeira_compra, cs.cobre_ate, cs.pagamentos, cs.plano
  from public.customer_software cs;
grant select on public.tool_grants to authenticated;

-- Resumo por ferramenta. p_platform: null = todas as plataformas; 'kiwify' | 'tmb' | 'hotmart' = só os
-- acessos que vieram de compras naquela plataforma (a migração para vitalício olha o histórico todo).
create or replace function public.tool_access_summary(p_platform text default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
with g_all as (select * from public.tool_grants),
g as (select * from g_all where p_platform is null or platform = p_platform),
hist as ( -- assinatura em qualquer plataforma, para saber quem migrou para o vitalício
  select tool, email, min(ts) as ass_desde from g_all where kind = 'assinatura' group by 1, 2
),
per as (
  select g.tool, g.email,
         bool_or(kind = 'vitalicio') as vit,
         min(ts) filter (where kind = 'vitalicio') as vit_em,
         max(cobre_ate) filter (where kind = 'assinatura') as cobre,
         max(pagamentos) filter (where kind = 'assinatura') as pags,
         string_agg(distinct platform, ',') as plats
    from g group by 1, 2
),
st as (
  select p.*, h.ass_desde,
         case when p.vit then 'vitalicio'
              when p.cobre >= now() then 'ativo'
              when p.cobre >= now() - interval '15 days' then 'carencia'
              else 'cancelou' end as situacao,
         (p.vit and h.ass_desde is not null and h.ass_desde < p.vit_em) as migrou
    from per p left join hist h on h.tool = p.tool and h.email = p.email
),
por_tool as (
  select t.slug as tool, t.name,
    count(s.email) as clientes,
    count(*) filter (where situacao in ('ativo', 'vitalicio')) as ativos,
    count(*) filter (where situacao = 'ativo') as assinatura_ativa,
    count(*) filter (where situacao = 'vitalicio') as vitalicios,
    count(*) filter (where migrou) as migraram,
    count(*) filter (where situacao = 'vitalicio' and not migrou) as vitalicio_novos,
    count(*) filter (where situacao = 'ativo' and pags > 1) as renovaram,
    count(*) filter (where situacao = 'ativo' and cobre < now() + interval '30 days') as vence_30,
    count(*) filter (where situacao = 'carencia') as carencia,
    count(*) filter (where situacao = 'cancelou') as cancelaram
  from public.tools t
  left join st s on s.tool = t.slug
  where t.slug in ('flowpages', 'flowtracking', 'flowspy')
  group by 1, 2
),
pessoa as (
  select email,
         count(*) filter (where situacao in ('ativo', 'vitalicio')) as n_ativas,
         bool_or(situacao = 'vitalicio') as tem_vit,
         bool_or(situacao = 'ativo') as tem_ass
    from st group by 1
)
select jsonb_build_object(
  'gerado_em', now(),
  'plataforma', coalesce(p_platform, 'todas'),
  'pessoas', (select count(*) from pessoa),
  'pessoas_ativas', (select count(*) from pessoa where n_ativas > 0),
  'pessoas_vitalicio', (select count(*) from pessoa where tem_vit),
  'pessoas_assinatura', (select count(*) from pessoa where tem_ass),
  'por_qtd', coalesce((select jsonb_object_agg(n_ativas, q) from (select n_ativas, count(*) q from pessoa where n_ativas > 0 group by 1) x), '{}'::jsonb),
  'ferramentas', coalesce((select jsonb_agg(to_jsonb(p) order by array_position(array['flowpages', 'flowtracking', 'flowspy'], p.tool)) from por_tool p), '[]'::jsonb)
);
$$;
revoke all on function public.tool_access_summary(text) from public, anon;
grant execute on function public.tool_access_summary(text) to authenticated;

-- Alunos da Kiwify: as ferramentas passam a entrar também (pedido da operação: ver todos os produtos).
create or replace function public.kiwify_students_summary(p_products text[] default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
with s as (
  select k.*, lower(k.customer_email) as email, k.status in ('paid', 'approved') as paga, p.name as produto
    from public.kiwify_sales_snapshot k
    join public.kiwify_products p on p.id = k.product_id
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

-- Todas as plataformas juntas. Produto = "plataforma:id" (k:, t:, h:). Alunos contados por e-mail único.
-- Valor = líquido na Kiwify, valor total do pedido na TMB e preço em reais na Hotmart.
create or replace function public.students_all_summary(p_products text[] default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
with s as (
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
sel as (select * from s where p_products is null or pid = any(p_products)),
pg as (select * from sel where paga),
flow as (select distinct email from public.customer_software)
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
revoke all on function public.students_all_summary(text[]) from public, anon;
grant execute on function public.students_all_summary(text[]) to authenticated;

-- As contagens por e-mail ordenam ~100 mil linhas: com a memória padrão a ordenação ia para o disco.
alter function public.students_all_summary(text[]) set work_mem = '64MB';
alter function public.kiwify_students_summary(text[]) set work_mem = '64MB';
alter function public.hotmart_summary(bigint[]) set work_mem = '64MB';
alter function public.tool_access_summary(text) set work_mem = '64MB';
