-- Reembolso e chargeback como saída de cliente.
--
-- Antes, quem reembolsou a única compra de uma ferramenta (ou do combo vitalício) sumia das contas: tanto
-- tool_access_summary quanto customer_software só olham compras pagas. Agora:
--   tool_grants ganha linhas kind = 'devolvido' (venda reembolsada ou com chargeback da ferramenta na Kiwify,
--     e do combo vitalício em qualquer plataforma; na TMB, pedido cancelado depois da entrada);
--   tool_access_summary: quem só tem devolução na ferramenta fica com situação 'devolveu' e entra em
--     "devolveram" e em "saidas" (= cancelaram por vencimento + devolveram);
--   health_summary: "devolveram" = e-mails com reembolso/chargeback na ferramenta; "devolveram_sairam" = os
--     que não têm outra compra paga dela (o antigo "reembolsaram" só contava quem continuou cliente).

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
       null::timestamptz as cobre_ate, (case when c.paga then 1 else 0 end)::bigint as pagamentos, b.name as plano
  from combo c
  join public.product_bundles b on b.id = c.bundle_id and b.lifetime
  join comp cp on cp.bundle_id = c.bundle_id
 where c.email is not null
union all
select 'kiwify', cs.email, cs.software, 'assinatura', cs.primeira_compra, cs.cobre_ate, cs.pagamentos, cs.plano
  from public.customer_software cs
union all
select 'kiwify', lower(s.customer_email), t.slug, 'devolvido', s.sale_created_at, null, 0, s.plan_name
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
         max(pagamentos) filter (where kind = 'assinatura') as pags
    from g group by 1, 2
),
st as (
  select p.*, h.ass_desde,
         case when p.vit then 'vitalicio'
              when p.cobre is null then 'devolveu' -- só reembolso/chargeback nessa ferramenta
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
    count(*) filter (where situacao = 'cancelou') as cancelaram,
    count(*) filter (where situacao = 'devolveu') as devolveram,
    count(*) filter (where situacao in ('cancelou', 'devolveu')) as saidas
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

create or replace function public.health_summary(p_high integer default 3, p_low integer default 21, p_inactive integer default 30)
returns jsonb language sql stable set search_path = '' as $function$
with b as (
  select c.*,
    case when not c.tem_uso then (case when su.software is not null then 'nunca' end)
         when c.dias_sem_acesso > p_inactive then 'inativo'
         when c.dias_7 >= p_high then 'muito_engajado'
         when c.dias_7 >= 1 then 'engajado'
         when c.dias_sem_acesso >= p_low then 'baixo'
         else 'moderado' end as uso_seg,
    case when c.situacao = 'ativo' and c.dias_para_vencer <= 30 then 'vence_30' else c.situacao end as ass_seg
  from public.customer_software c
  left join (select distinct software from public.usage_daily) su on su.software = c.software
),
hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),
-- Reembolso/chargeback por ferramenta (e-mail único), inclusive de quem não tem outra compra paga
-- e por isso não aparece em customer_software.
dev as (
  select t.slug as software,
         count(distinct lower(s.customer_email)) as devolveram,
         count(distinct lower(s.customer_email)) filter (where not exists (
           select 1 from b where b.software = t.slug and b.email = lower(s.customer_email))) as devolveram_sairam
    from public.kiwify_sales_snapshot s
    join public.kiwify_products p on p.id = s.product_id
    join public.tools t on t.id = p.tool_id
   where s.status in ('refunded', 'chargedback') and s.customer_email is not null
     and (t.revenue_start is null or s.sale_created_at >= t.revenue_start::timestamptz)
   group by 1
),
por_sw as (
  select b.software, b.tool,
    count(*) as clientes,
    count(*) filter (where ass_seg = 'ativo') as ass_ativo,
    count(*) filter (where ass_seg = 'vence_30') as ass_vence_30,
    count(*) filter (where ass_seg = 'carencia') as ass_carencia,
    count(*) filter (where ass_seg = 'cancelou') as ass_cancelou,
    count(*) filter (where reembolsou or chargeback) as reembolsaram,
    count(*) filter (where pagamentos > 1) as renovaram,
    count(*) filter (where n_produtos > 1) as multi_produto,
    count(*) filter (where tem_uso) as com_uso,
    count(*) filter (where tem_uso and (ultimo_acesso at time zone 'America/Sao_Paulo')::date = (select d from hoje)) as hoje,
    count(*) filter (where dias_7 >= 1) as d7,
    count(*) filter (where dias_30 >= 1) as d30,
    count(*) filter (where uso_seg = 'inativo') as inativos,
    count(*) filter (where uso_seg = 'nunca') as nunca,
    count(*) filter (where uso_seg = 'muito_engajado') as seg_muito,
    count(*) filter (where uso_seg = 'engajado') as seg_engajado,
    count(*) filter (where uso_seg = 'moderado') as seg_moderado,
    count(*) filter (where uso_seg = 'baixo') as seg_baixo,
    count(*) filter (where ass_seg in ('ativo', 'vence_30') and dias_para_vencer <= 90) as vencem_90,
    count(*) filter (where ass_seg in ('ativo', 'vence_30') and dias_para_vencer <= 90 and uso_seg in ('inativo', 'baixo', 'nunca')) as vencem_90_sem_uso
  from b group by 1, 2
),
venc as (
  select software, floor(dias_para_vencer / 7)::int as sem, count(*) as n
  from b where ass_seg in ('ativo', 'vence_30') and dias_para_vencer < 84 group by 1, 2
),
planos as (
  select software, plano, count(*) as n,
         row_number() over (partition by software order by count(*) desc) as r
  from b group by 1, 2
)
select jsonb_build_object(
  'gerado_em', now(),
  'uso', jsonb_build_object(
    'eventos', (select count(*) from public.usage_daily),
    'ultimo', (select max(last_at) from public.usage_daily),
    'primeiro_dia', (select min(day) from public.usage_daily),
    'dias', (select count(distinct day) from public.usage_daily)),
  'softwares', coalesce((select jsonb_agg(
      to_jsonb(p) || jsonb_build_object(
        'devolveram', coalesce((select d.devolveram from dev d where d.software = p.software), 0),
        'devolveram_sairam', coalesce((select d.devolveram_sairam from dev d where d.software = p.software), 0),
        'vencimentos', coalesce((select jsonb_object_agg(v.sem::text, v.n) from venc v where v.software = p.software), '{}'::jsonb),
        'planos', coalesce((select jsonb_agg(jsonb_build_object('plano', pl.plano, 'n', pl.n) order by pl.n desc) from planos pl where pl.software = p.software and pl.r <= 15), '[]'::jsonb))
      order by p.clientes desc) from por_sw p), '[]'::jsonb)
);
$function$;
