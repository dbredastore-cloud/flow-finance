-- tool_access_summary: origem de cada número, para conferir com as plataformas.
--   assinantes = e-mails com compra paga do produto da ferramenta (Kiwify)
--   via_combo  = e-mails que receberam a ferramenta pelo combo vitalício
--   ambos      = estão nos dois grupos (contam uma vez: clientes = assinantes + via_combo − ambos + devolveram)

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
    count(*) filter (where situacao in ('cancelou', 'devolveu')) as saidas,
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

