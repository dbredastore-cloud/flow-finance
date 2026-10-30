-- Clientes ativos por ferramenta com a mesma regra de cancelamento do Flow Health e da Saúde dos clientes:
-- assinatura de teste/cortesia (plano "Teste" ou menos de R$ 5 pagos) que venceu não conta como "cancelaram".
-- tool_grants ganha a coluna teste (no fim, para o create or replace view aceitar).

create or replace view public.tool_grants with (security_invoker = true) as
with comp as (
  select c.bundle_id, c.component as tool
    from public.bundle_components c join public.tools t on t.slug = c.component
),
combo as (
  select bp.bundle_id, 'kiwify' as platform, lower(k.customer_email) as email, k.sale_created_at as ts,
         k.status in ('paid', 'approved') as paga
    from public.bundle_products bp join public.kiwify_sales_snapshot k on k.product_id = bp.product_id
   where bp.platform = 'kiwify' and k.status in ('paid', 'approved', 'refunded', 'chargedback')
  union all
  select bp.bundle_id, 'tmb', lower(o.customer_email), o.created_at, o.status = 'Efetivado'
    from public.bundle_products bp join public.tmb_orders o on o.product_id::text = bp.product_id
   where bp.platform = 'tmb' and o.status in ('Efetivado', 'Cancelado')
  union all
  select bp.bundle_id, 'hotmart', lower(h.buyer_email), h.order_date, h.status in ('APPROVED', 'COMPLETE')
    from public.bundle_products bp join public.hotmart_sales h on h.product_id::text = bp.product_id
   where bp.platform = 'hotmart' and h.commission_as in ('PRODUCER', 'COPRODUCER')
     and h.status in ('APPROVED', 'COMPLETE', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CHARGEBACK')
)
select c.platform, c.email, cp.tool, case when c.paga then 'vitalicio' else 'devolvido' end::text as kind, c.ts,
       null::timestamptz as cobre_ate, (case when c.paga then 1 else 0 end)::bigint as pagamentos, b.name as plano, false as teste
  from combo c
  join public.product_bundles b on b.id = c.bundle_id and b.lifetime
  join comp cp on cp.bundle_id = c.bundle_id
 where c.email is not null
union all
select 'kiwify', cs.email, cs.software, 'assinatura', cs.primeira_compra, cs.cobre_ate, cs.pagamentos, cs.plano,
       (cs.plano ~* 'teste' or cs.liquido_total < 5)
  from public.customer_software cs
union all
select 'kiwify', lower(s.customer_email), t.slug, 'devolvido', s.sale_created_at, null, 0, s.plan_name, false
  from public.kiwify_sales_snapshot s
  join public.kiwify_products p on p.id = s.product_id
  join public.tools t on t.id = p.tool_id
 where s.status in ('refunded', 'chargedback') and s.customer_email is not null
   and (t.revenue_start is null or s.sale_created_at >= t.revenue_start::timestamptz);
grant select on public.tool_grants to authenticated;


create or replace function public.tool_access_summary(p_platform text default null) returns jsonb
language sql stable security invoker set search_path = '' set work_mem = '64MB' as $$
with g_all as (select * from public.tool_grants),
g as (select * from g_all where p_platform is null or platform = p_platform),
hist as (
  select tool, email, min(ts) as ass_desde from g_all where kind = 'assinatura' group by 1, 2
),
per as (
  select g.tool, g.email,
         bool_or(kind = 'vitalicio') as vit,
         min(ts) filter (where kind = 'vitalicio') as vit_em,
         max(cobre_ate) filter (where kind = 'assinatura') as cobre,
         max(pagamentos) filter (where kind = 'assinatura') as pags,
         bool_and(teste) filter (where kind = 'assinatura') as teste
    from g group by 1, 2
),
st as (
  select p.*, h.ass_desde,
         case when p.vit then 'vitalicio'
              when p.cobre is null then 'devolveu' -- só reembolso/chargeback nessa ferramenta
              when p.cobre >= now() then 'ativo'
              when p.cobre >= now() - interval '15 days' then 'carencia'
              when p.teste then 'teste' -- compra de teste/cortesia: não é cancelamento
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
    count(*) filter (where situacao = 'cancelou') as cancelaram,
    count(*) filter (where situacao = 'devolveu') as devolveram,
    count(*) filter (where situacao in ('cancelou', 'devolveu')) as saidas,
    count(*) filter (where situacao = 'teste') as testes,
    -- origem (para bater com as plataformas): quem pagou a ferramenta, quem recebeu pelo combo e quem tem os dois
    count(*) filter (where cobre is not null) as assinantes,
    count(*) filter (where vit) as via_combo,
    count(*) filter (where vit and cobre is not null) as ambos
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

