-- Saúde dos clientes com a mesma regra de cancelamento do Flow Health.
--
-- Assinatura vencida há mais de 15 dias deixa de ser "cancelou" quando:
--   teste     · compra de teste ou cortesia (plano "Teste" ou menos de R$ 5 pagos no total)
--   vitalicio · a pessoa tem o combo vitalício (Kiwify, TMB ou Hotmart): segue com acesso à ferramenta
-- Vale para o resumo (health_summary, que ganha ass_vitalicio e ass_teste), a lista (health_customers)
-- e a ficha do cliente (health_customer). lifetime_access passa a ler os combos direto (sem tool_grants,
-- que inclui customer_software e deixava a consulta pesada).

create or replace function public.lifetime_access() returns table (tool text, email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can(array['fin.health', 'fin.clients']) then return; end if;
  return query
  with comp as (
    select c.bundle_id, c.component as tool
      from public.bundle_components c
      join public.tools t on t.slug = c.component
      join public.product_bundles b on b.id = c.bundle_id and b.lifetime
  ),
  combo as (
    select bp.bundle_id, lower(k.customer_email) as email
      from public.bundle_products bp join public.kiwify_sales_snapshot k on k.product_id = bp.product_id
     where bp.platform = 'kiwify' and k.status in ('paid', 'approved')
    union
    select bp.bundle_id, lower(o.customer_email)
      from public.bundle_products bp join public.tmb_orders o on o.product_id::text = bp.product_id
     where bp.platform = 'tmb' and o.status = 'Efetivado'
    union
    select bp.bundle_id, lower(h.buyer_email)
      from public.bundle_products bp join public.hotmart_sales h on h.product_id::text = bp.product_id
     where bp.platform = 'hotmart' and h.status in ('APPROVED', 'COMPLETE') and h.commission_as in ('PRODUCER', 'COPRODUCER')
  )
  select distinct cp.tool, c.email from combo c join comp cp on cp.bundle_id = c.bundle_id where c.email is not null;
end $$;
revoke all on function public.lifetime_access() from public, anon;
grant execute on function public.lifetime_access() to authenticated;

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
    case when c.situacao = 'ativo' and c.dias_para_vencer <= 30 then 'vence_30'
         when c.situacao = 'cancelou' and (c.plano ~* 'teste' or c.liquido_total < 5) then 'teste'
         when c.situacao = 'cancelou' and lv.email is not null then 'vitalicio'
         else c.situacao end as ass_seg
  from public.customer_software c
  left join (select distinct software from public.usage_daily) su on su.software = c.software
  left join (select distinct tool, email from public.lifetime_access()) lv on lv.tool = c.software and lv.email = c.email
),
hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),
-- Reembolso/chargeback por ferramenta (e-mail único), inclusive de quem não tem outra compra paga
-- e por isso não aparece em customer_software.
dev as ( -- junção com b (e não "not exists" linha a linha, que levava segundos)
  select r.software, count(*) as devolveram, count(*) filter (where b.email is null) as devolveram_sairam
    from (select distinct t.slug as software, lower(s.customer_email) as email
            from public.kiwify_sales_snapshot s
            join public.kiwify_products p on p.id = s.product_id
            join public.tools t on t.id = p.tool_id
           where s.status in ('refunded', 'chargedback') and s.customer_email is not null
             and (t.revenue_start is null or s.sale_created_at >= t.revenue_start::timestamptz)) r
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

create or replace function public.health_customers(
  p_software text default null, p_ass text default null, p_uso text default null, p_ultimo text default null,
  p_freq_min integer default null, p_plano text default null, p_q text default null,
  p_order text default 'ultima_compra', p_desc boolean default true, p_limit integer default 50, p_offset integer default 0,
  p_high integer default 3, p_low integer default 21, p_inactive integer default 30)
returns jsonb language sql stable security invoker set search_path = '' as $$
with b as (
  select c.*,
    case when not c.tem_uso then (case when su.software is not null then 'nunca' end)
         when c.dias_sem_acesso > p_inactive then 'inativo'
         when c.dias_7 >= p_high then 'muito_engajado'
         when c.dias_7 >= 1 then 'engajado'
         when c.dias_sem_acesso >= p_low then 'baixo'
         else 'moderado' end as uso_seg,
    case when c.situacao = 'ativo' and c.dias_para_vencer <= 30 then 'vence_30'
         when c.situacao = 'cancelou' and (c.plano ~* 'teste' or c.liquido_total < 5) then 'teste'
         when c.situacao = 'cancelou' and lv.email is not null then 'vitalicio'
         else c.situacao end as ass_seg
  from public.customer_software c
  left join (select distinct software from public.usage_daily) su on su.software = c.software
  left join (select distinct tool, email from public.lifetime_access()) lv on lv.tool = c.software and lv.email = c.email
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
      'dias_sem_acesso', dias_sem_acesso, 'uso_seg', uso_seg)) from pag), '[]'::jsonb)
);
$$;

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
    case when c.situacao = 'ativo' and c.dias_para_vencer <= 30 then 'vence_30'
         when c.situacao = 'cancelou' and (c.plano ~* 'teste' or c.liquido_total < 5) then 'teste'
         when c.situacao = 'cancelou' and lv.email is not null then 'vitalicio'
         else c.situacao end as ass_seg
  from public.customer_software c
  left join (select distinct software from public.usage_daily) su on su.software = c.software
  left join (select distinct tool, email from public.lifetime_access()) lv on lv.tool = c.software and lv.email = c.email
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
      'acessos_total', acessos_total, 'uso_seg', uso_seg) order by tool) from b), '[]'::jsonb),
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
