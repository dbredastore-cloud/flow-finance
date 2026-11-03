-- Saúde dos clientes com as compras das três plataformas (Kiwify, TMB e Hotmart).
--
-- Antes, a base da tela era customer_software: só quem pagou uma assinatura da ferramenta na Kiwify. Quem
-- comprou o Combo Vitalício Viver de Dólar 2026 (que libera Flow Pages, Flow Tracking e Flow Spy) só entrava
-- se também tivesse assinatura, e mesmo assim aparecia pela situação da assinatura.
--
-- Agora a base é customer_tools: uma linha por e-mail × ferramenta, juntando
--   assinatura · customer_software (Kiwify), sem mudança;
--   vitalício  · compra paga de um combo vitalício (product_bundles.lifetime) em qualquer plataforma; cada
--                ferramenta do combo (bundle_components) vira uma linha.
-- Quem tem os dois (ex.: assinava o Flow Pages e depois comprou o combo) fica com uma linha por ferramenta,
-- situação "vitalicio", sem vencimento, e passa a ter também as ferramentas que não assinava.
-- migrou_vitalicio = tinha assinatura da ferramenta antes de comprar o combo.
-- Reembolso/chargeback do combo entra em "devolveram" das três ferramentas.

create or replace function public.lifetime_grants()
returns table (tool text, email text, nome text, desde timestamptz, ultima timestamptz, plano text, plataformas text, pago boolean, devolveu boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can(array['fin.health', 'fin.clients']) then return; end if;
  return query
  with comp as (
    select c.bundle_id, c.component as tool, b.name as plano
      from public.bundle_components c
      join public.tools t on t.slug = c.component
      join public.product_bundles b on b.id = c.bundle_id and b.lifetime
  ),
  combo as (
    select bp.bundle_id, 'kiwify' as platform, lower(k.customer_email) as email, k.customer_name as nome, k.sale_created_at as ts,
           k.status in ('paid', 'approved') as paga
      from public.bundle_products bp join public.kiwify_sales_snapshot k on k.product_id = bp.product_id
     where bp.platform = 'kiwify' and k.status in ('paid', 'approved', 'refunded', 'chargedback')
    union all
    select bp.bundle_id, 'tmb', lower(o.customer_email), o.customer_name, o.created_at, o.status = 'Efetivado'
      from public.bundle_products bp join public.tmb_orders o on o.product_id::text = bp.product_id
     where bp.platform = 'tmb' and o.status in ('Efetivado', 'Cancelado')
    union all
    select bp.bundle_id, 'hotmart', lower(h.buyer_email), h.buyer_name, h.order_date, h.status in ('APPROVED', 'COMPLETE')
      from public.bundle_products bp join public.hotmart_sales h on h.product_id::text = bp.product_id
     where bp.platform = 'hotmart' and h.commission_as in ('PRODUCER', 'COPRODUCER')
       and h.status in ('APPROVED', 'COMPLETE', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CHARGEBACK')
  )
  select cp.tool, c.email,
         (array_agg(c.nome order by c.paga desc, c.ts desc))[1],
         min(c.ts) filter (where c.paga), max(c.ts) filter (where c.paga),
         (array_agg(cp.plano order by c.paga desc, c.ts desc))[1],
         string_agg(distinct c.platform, ',') filter (where c.paga),
         bool_or(c.paga), bool_or(not c.paga)
    from combo c join comp cp on cp.bundle_id = c.bundle_id
   where c.email is not null and c.email <> ''
   group by 1, 2;
end $$;
revoke all on function public.lifetime_grants() from public, anon;
grant execute on function public.lifetime_grants() to authenticated;

create or replace view public.customer_tools with (security_invoker = true) as
with params as (
  select now() as agora, (now() at time zone 'America/Sao_Paulo')::date as hoje
),
lv as (select * from public.lifetime_grants() where pago),
cs as (
  select tool_id, software, tool, email, nome, primeira_compra, ultima_compra, pagamentos, liquido_total, plano, meses_plano,
         cobre_ate, situacao, dias_para_vencer, reembolsou, chargeback
    from public.customer_software
),
j as (
  select coalesce(cs.tool_id, t.id) as tool_id, coalesce(cs.software, lv.tool) as software, coalesce(cs.tool, t.name) as tool,
         coalesce(cs.email, lv.email) as email, coalesce(cs.nome, lv.nome) as nome,
         least(cs.primeira_compra, lv.desde) as primeira_compra, greatest(cs.ultima_compra, lv.ultima) as ultima_compra,
         coalesce(cs.pagamentos, 1) as pagamentos, cs.liquido_total,
         case when lv.email is not null then lv.plano else cs.plano end as plano,
         case when lv.email is null then cs.meses_plano end as meses_plano,
         case when lv.email is null then cs.cobre_ate end as cobre_ate,
         case when lv.email is not null then 'vitalicio' else cs.situacao end as situacao,
         case when lv.email is null then cs.dias_para_vencer end as dias_para_vencer,
         coalesce(cs.reembolsou, false) as reembolsou, coalesce(cs.chargeback, false) as chargeback,
         (lv.email is not null) as vitalicio, lv.desde as vitalicio_desde, lv.plataformas as vitalicio_plataformas,
         (lv.email is not null and coalesce(cs.primeira_compra < lv.desde, false)) as migrou_vitalicio,
         cs.plano as plano_assinatura, cs.cobre_ate as assinatura_cobre_ate
    from cs
    full join lv on lv.tool = cs.software and lv.email = cs.email
    left join public.tools t on t.slug = lv.tool
),
uso as (
  select u.software, u.email, max(u.last_at) as ultimo_acesso, sum(u.hits) as acessos_total,
         coalesce(sum(u.hits) filter (where u.day >= p.hoje - 6), 0) as acessos_7,
         coalesce(sum(u.hits) filter (where u.day >= p.hoje - 29), 0) as acessos_30,
         count(*) filter (where u.day >= p.hoje - 6) as dias_7,
         count(*) filter (where u.day >= p.hoje - 29) as dias_30
  from public.usage_daily u cross join params p group by 1, 2
)
select j.tool_id, j.software, j.tool, j.email, j.nome, j.primeira_compra, j.ultima_compra, j.pagamentos,
       j.liquido_total, j.plano, j.meses_plano, j.cobre_ate, j.situacao, j.dias_para_vencer, j.reembolsou, j.chargeback,
       count(*) over (partition by j.email) as n_produtos,
       (us.email is not null) as tem_uso, us.ultimo_acesso, coalesce(us.acessos_total, 0) as acessos_total,
       coalesce(us.acessos_7, 0) as acessos_7, coalesce(us.acessos_30, 0) as acessos_30,
       coalesce(us.dias_7, 0) as dias_7, coalesce(us.dias_30, 0) as dias_30,
       case when us.ultimo_acesso is null then null else extract(epoch from (p.agora - us.ultimo_acesso)) / 86400 end as dias_sem_acesso,
       j.vitalicio, j.vitalicio_desde, j.vitalicio_plataformas, j.migrou_vitalicio, j.plano_assinatura, j.assinatura_cobre_ate
from j
cross join params p
left join uso us on us.software = j.software and us.email = j.email;
grant select on public.customer_tools to authenticated;

/* ---------------- Resumo por software ---------------- */
create or replace function public.health_summary(p_high integer default 3, p_low integer default 21, p_inactive integer default 30)
returns jsonb language sql stable set search_path = '' set work_mem = '64MB' as $function$
with b as materialized (
  select c.*,
    case when not c.tem_uso then (case when su.software is not null then 'nunca' end)
         when c.dias_sem_acesso > p_inactive then 'inativo'
         when c.dias_7 >= p_high then 'muito_engajado'
         when c.dias_7 >= 1 then 'engajado'
         when c.dias_sem_acesso >= p_low then 'baixo'
         else 'moderado' end as uso_seg,
    case when c.situacao = 'vitalicio' then 'vitalicio'
         when c.situacao = 'ativo' and c.dias_para_vencer <= 30 then 'vence_30'
         when c.situacao = 'cancelou' and (c.plano ~* 'teste' or c.liquido_total < 5) then 'teste'
         else c.situacao end as ass_seg
  from public.customer_tools c
  left join (select distinct software from public.usage_daily) su on su.software = c.software
),
hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),
-- Reembolso/chargeback por ferramenta (e-mail único): da ferramenta na Kiwify e do combo vitalício em
-- qualquer plataforma, inclusive de quem não tem outra compra paga e por isso não está na base.
dev as (
  select r.software, count(*) as devolveram, count(*) filter (where b.email is null) as devolveram_sairam
    from (select distinct t.slug as software, lower(s.customer_email) as email
            from public.kiwify_sales_snapshot s
            join public.kiwify_products p on p.id = s.product_id
            join public.tools t on t.id = p.tool_id
           where s.status in ('refunded', 'chargedback') and s.customer_email is not null
             and (t.revenue_start is null or s.sale_created_at >= t.revenue_start::timestamptz)
          union
          select tool, email from public.lifetime_grants() where devolveu) r
    left join b on b.software = r.software and b.email = r.email
   group by 1
),
por_sw as (
  select b.software, b.tool,
    count(*) as clientes,
    count(*) filter (where ass_seg = 'ativo') as ass_ativo,
    count(*) filter (where ass_seg = 'vence_30') as ass_vence_30,
    count(*) filter (where ass_seg = 'carencia') as ass_carencia,
    count(*) filter (where ass_seg = 'cancelou') as ass_cancelou,
    count(*) filter (where ass_seg = 'vitalicio') as ass_vitalicio,
    count(*) filter (where ass_seg = 'teste') as ass_teste,
    count(*) filter (where migrou_vitalicio) as vit_migraram,
    count(*) filter (where vitalicio and not migrou_vitalicio) as vit_novos,
    count(*) filter (where vitalicio_plataformas like '%kiwify%') as vit_kiwify,
    count(*) filter (where vitalicio_plataformas like '%tmb%') as vit_tmb,
    count(*) filter (where vitalicio_plataformas like '%hotmart%') as vit_hotmart,
    count(*) filter (where plano_assinatura is not null) as com_assinatura,
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
  'pessoas', (select count(distinct email) from b),
  'pessoas_vitalicio', (select count(distinct email) from b where vitalicio),
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

/* ---------------- Lista de clientes ---------------- */
create or replace function public.health_customers(
  p_software text default null, p_ass text default null, p_uso text default null, p_ultimo text default null,
  p_freq_min integer default null, p_plano text default null, p_q text default null,
  p_order text default 'ultima_compra', p_desc boolean default true, p_limit integer default 50, p_offset integer default 0,
  p_high integer default 3, p_low integer default 21, p_inactive integer default 30)
returns jsonb language sql stable security invoker set search_path = '' set work_mem = '64MB' as $$
with b as (
  select c.*,
    case when not c.tem_uso then (case when su.software is not null then 'nunca' end)
         when c.dias_sem_acesso > p_inactive then 'inativo'
         when c.dias_7 >= p_high then 'muito_engajado'
         when c.dias_7 >= 1 then 'engajado'
         when c.dias_sem_acesso >= p_low then 'baixo'
         else 'moderado' end as uso_seg,
    case when c.situacao = 'vitalicio' then 'vitalicio'
         when c.situacao = 'ativo' and c.dias_para_vencer <= 30 then 'vence_30'
         when c.situacao = 'cancelou' and (c.plano ~* 'teste' or c.liquido_total < 5) then 'teste'
         else c.situacao end as ass_seg
  from public.customer_tools c
  left join (select distinct software from public.usage_daily) su on su.software = c.software
  where (p_software is null or c.software = p_software)
),
f as materialized (
  select b.*,
    case p_order
      when 'pagamentos' then pagamentos::numeric
      when 'liquido_total' then liquido_total
      when 'ultima_compra' then extract(epoch from ultima_compra)
      when 'dias_para_vencer' then dias_para_vencer::numeric
      when 'ultimo_acesso' then extract(epoch from ultimo_acesso)
      when 'dias_sem_acesso' then dias_sem_acesso::numeric
      when 'acessos_7' then acessos_7::numeric
      when 'acessos_30' then acessos_30::numeric
      when 'dias_30' then dias_30::numeric
      when 'n_produtos' then n_produtos::numeric
    end as sort_val,
    case p_order when 'email' then email when 'nome' then lower(coalesce(nome, '')) end as sort_txt
  from b
  where (p_ass is null or case p_ass
          when 'reembolso' then (reembolsou or chargeback)
          when 'renovou' then pagamentos > 1
          when 'multi' then n_produtos > 1
          when 'migrou' then migrou_vitalicio
          else ass_seg = p_ass end)
    and (p_uso is null or case p_uso
          when 'hoje' then tem_uso and (ultimo_acesso at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date
          when 'd7' then dias_7 >= 1
          when 'd30' then dias_30 >= 1
          else uso_seg = p_uso end)
    and (p_ultimo is null or case p_ultimo
          when 'hoje' then tem_uso and (ultimo_acesso at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date
          when '7' then dias_7 >= 1
          when '30' then dias_30 >= 1
          when 'mais30' then tem_uso and dias_sem_acesso > p_inactive
          when 'nunca' then not tem_uso
          else true end)
    and (p_freq_min is null or dias_30 >= p_freq_min)
    and (p_plano is null or plano = p_plano)
    and (p_q is null or p_q = '' or email ilike '%' || p_q || '%' or coalesce(nome, '') ilike '%' || p_q || '%')
),
pag as (
  select * from f
  order by (case when p_desc then sort_val end) desc nulls last, (case when not p_desc then sort_val end) asc nulls last,
           (case when p_desc then sort_txt end) desc, (case when not p_desc then sort_txt end) asc, email, software
  limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0)
)
select jsonb_build_object(
  'total', (select count(*) from f),
  'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'software', software, 'tool', tool, 'email', email, 'nome', nome, 'plano', plano, 'pagamentos', pagamentos,
      'liquido_total', liquido_total, 'ultima_compra', ultima_compra, 'cobre_ate', cobre_ate, 'dias_para_vencer', dias_para_vencer,
      'ass_seg', ass_seg, 'n_produtos', n_produtos, 'tem_uso', tem_uso, 'ultimo_acesso', ultimo_acesso,
      'acessos_7', acessos_7, 'acessos_30', acessos_30, 'dias_7', dias_7, 'dias_30', dias_30,
      'dias_sem_acesso', dias_sem_acesso, 'uso_seg', uso_seg,
      'vitalicio_plataformas', vitalicio_plataformas, 'migrou_vitalicio', migrou_vitalicio, 'plano_assinatura', plano_assinatura)) from pag), '[]'::jsonb)
);
$$;

/* ---------------- Ficha do cliente ---------------- */
create or replace function public.health_customer(p_email text, p_high integer default 3, p_low integer default 21, p_inactive integer default 30)
returns jsonb language sql stable security invoker set search_path = '' as $$
with e as (select lower(btrim(p_email)) as email),
b as (
  select c.*,
    case when not c.tem_uso then (case when su.software is not null then 'nunca' end)
         when c.dias_sem_acesso > p_inactive then 'inativo'
         when c.dias_7 >= p_high then 'muito_engajado'
         when c.dias_7 >= 1 then 'engajado'
         when c.dias_sem_acesso >= p_low then 'baixo'
         else 'moderado' end as uso_seg,
    case when c.situacao = 'vitalicio' then 'vitalicio'
         when c.situacao = 'ativo' and c.dias_para_vencer <= 30 then 'vence_30'
         when c.situacao = 'cancelou' and (c.plano ~* 'teste' or c.liquido_total < 5) then 'teste'
         else c.situacao end as ass_seg
  from public.customer_tools c
  left join (select distinct software from public.usage_daily) su on su.software = c.software
  where c.email = (select email from e)
)
select jsonb_build_object(
  'email', (select email from e),
  'nome', (select nome from b order by ultima_compra desc limit 1),
  'softwares', coalesce((select jsonb_agg(jsonb_build_object(
      'software', software, 'tool', tool, 'plano', plano, 'pagamentos', pagamentos, 'liquido_total', liquido_total,
      'primeira_compra', primeira_compra, 'ultima_compra', ultima_compra, 'cobre_ate', cobre_ate, 'dias_para_vencer', dias_para_vencer,
      'ass_seg', ass_seg, 'reembolsou', reembolsou, 'chargeback', chargeback, 'tem_uso', tem_uso, 'ultimo_acesso', ultimo_acesso,
      'acessos_7', acessos_7, 'acessos_30', acessos_30, 'dias_7', dias_7, 'dias_30', dias_30, 'dias_sem_acesso', dias_sem_acesso,
      'acessos_total', acessos_total, 'uso_seg', uso_seg,
      'vitalicio_desde', vitalicio_desde, 'vitalicio_plataformas', vitalicio_plataformas, 'migrou_vitalicio', migrou_vitalicio,
      'plano_assinatura', plano_assinatura, 'assinatura_cobre_ate', assinatura_cobre_ate) order by tool) from b), '[]'::jsonb),
  'compras', coalesce((select jsonb_agg(x order by x->>'data' desc) from (
      select jsonb_build_object('tool', t.name, 'plano', coalesce(kp.plan_name, s.plan_name, '(sem plano)'), 'status', s.status,
             'valor', s.net_amount, 'data', s.sale_created_at) as x
      from public.kiwify_sales_snapshot s
      join public.kiwify_products p on p.id = s.product_id
      join public.tools t on t.id = p.tool_id
      left join public.kiwify_plans kp on kp.plan_id = s.plan_id
      where lower(s.customer_email) = (select email from e)
      order by s.sale_created_at desc limit 40) q), '[]'::jsonb),
  'acessos', coalesce((select jsonb_agg(jsonb_build_object('software', software, 'day', day, 'hits', hits) order by day)
      from public.usage_daily where email = (select email from e) and day >= (now() at time zone 'America/Sao_Paulo')::date - 89), '[]'::jsonb)
);
$$;

/* ---------------- Quantos softwares cada cliente usa ---------------- */
-- "ativos" passa a contar assinatura em dia e vitalício (o combo dá as três ferramentas sem vencimento).
create or replace function public.health_mix() returns jsonb
language sql stable security invoker set search_path = '' set work_mem = '64MB' as $$
with c as (
  select email,
         count(*) as n,
         count(*) filter (where situacao in ('ativo', 'vitalicio')) as n_ativos,
         string_agg(tool, ' + ' order by tool) as combo,
         string_agg(tool, ' + ' order by tool) filter (where situacao in ('ativo', 'vitalicio')) as combo_ativo
    from public.customer_tools group by email
)
select jsonb_build_object(
  'clientes', (select count(*) from c),
  'historico', (select jsonb_object_agg(n, q) from (select n, count(*) q from c group by n) x),
  'ativos', (select jsonb_object_agg(n_ativos, q) from (select n_ativos, count(*) q from c where n_ativos > 0 group by n_ativos) x),
  'clientes_ativos', (select count(*) from c where n_ativos > 0),
  'combos', coalesce((select jsonb_agg(jsonb_build_object('combo', combo, 'n', q, 'softwares', n) order by q desc)
                        from (select combo, n, count(*) q from c where n > 1 group by combo, n) x), '[]'::jsonb),
  'combos_ativos', coalesce((select jsonb_agg(jsonb_build_object('combo', combo_ativo, 'n', q, 'softwares', n_ativos) order by q desc)
                        from (select combo_ativo, n_ativos, count(*) q from c where n_ativos > 1 group by combo_ativo, n_ativos) x), '[]'::jsonb)
);
$$;

/* ---------------- Alunos: "também cliente Flow" com o combo ---------------- */
-- Os resumos de alunos (Kiwify, TMB, Hotmart e todas) contavam como cliente Flow só quem assinava na Kiwify.
do $$
declare r record; def text;
begin
  for r in select p.oid from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('kiwify_students_summary', 'tmb_summary', 'hotmart_summary', 'students_all_summary')
  loop
    def := pg_get_functiondef(r.oid);
    if position('public.customer_software' in def) > 0 then
      execute replace(def, 'public.customer_software', 'public.customer_tools');
    end if;
  end loop;
end $$;
