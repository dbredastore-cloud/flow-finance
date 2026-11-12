-- Black Viver de Dólar 2026: dá Flow Pages, Flow Tracking e Flow Spy por 12 meses (Kiwify, TMB e Hotmart).
-- Regras (confirmadas pelo usuário em 12/11/2026):
--   * e-mail novo → cliente novo, 1 ano de acesso às 3 ferramentas a partir da compra;
--   * já assinante (assinatura ativa) → a assinatura renova: o novo ano conta da data da Black e o tempo que
--     restava da assinatura anterior se perde;
--   * ex-assinante (assinatura vencida) → conta como cliente que voltou, não como cliente novo.
-- Modelo: combo com duração (product_bundles.months = 12, lifetime = false). Cada compra vira um "pagamento de
-- 12 meses" em cada ferramenta, somado às vendas da Kiwify em customer_software (Saúde dos clientes, acessos por
-- ferramenta) e em rm_refresh (Retenção e Monetização). A receita fica fora do financeiro das ferramentas, como
-- no Combo Vitalício, e aparece no rateio dos combos (bundle_allocation) pelos preços de referência dos itens.

-- 1. Combo com duração em meses (null = vitalício ou sem acesso por tempo).
alter table public.product_bundles add column if not exists months integer
  check (months is null or months between 1 and 120);
comment on column public.product_bundles.months is
  'Combo com prazo: meses de acesso às ferramentas a partir da compra (lifetime = false). Null nos vitalícios.';

-- 2. Cadastro da Black.
insert into public.product_bundles (id, name, notes, lifetime, months) values
  ('black-vd-2026', 'Black Viver de Dólar 2026',
   'Flow Pages, Flow Tracking e Flow Spy por 12 meses a partir da compra. Já assinante: a assinatura recomeça na data da Black (o que restava da anterior se perde). Ex-assinante conta como cliente que voltou.',
   false, 12)
on conflict (id) do update set name = excluded.name, notes = excluded.notes, lifetime = excluded.lifetime, months = excluded.months;

insert into public.bundle_components (bundle_id, component, label, ref_price, sort) values
  ('black-vd-2026', 'comunidade', 'Comunidade Viver de Dólar', 2497, 1),
  ('black-vd-2026', 'flowtracking', 'Flow Tracking', 660, 2),
  ('black-vd-2026', 'flowspy', 'Flow Spy', 630, 3),
  ('black-vd-2026', 'flowpages', 'Flow Pages', 440, 4)
on conflict do nothing;

insert into public.bundle_products (platform, product_id, bundle_id) values
  ('kiwify', 'a7637340-c0f1-11f1-b73b-7bb129a127d0', 'black-vd-2026'),
  ('tmb', '38936', 'black-vd-2026'),
  ('hotmart', '8665339', 'black-vd-2026')
on conflict do nothing;

-- 3. Compras de combos com prazo, uma linha por ferramenta do combo, no formato das vendas da Kiwify
--    (status paid/refunded/chargedback/...; liquido = líquido da venda × peso do item no rateio).
create or replace view public.bundle_term_sales with (security_invoker = true) as
with pesos as (
  select c.bundle_id, c.component, c.ref_price / nullif(sum(c.ref_price) over (partition by c.bundle_id), 0) as peso
    from public.bundle_components c
),
compra as (
  select bp.bundle_id, 'kiwify'::text as platform, k.id as sale_id, lower(btrim(k.customer_email)) as email, k.customer_name as nome,
         k.status, k.sale_created_at as ts, coalesce(k.net_amount, 0) as liquido
    from public.bundle_products bp join public.kiwify_sales_snapshot k on k.product_id = bp.product_id
   where bp.platform = 'kiwify'
  union all
  select bp.bundle_id, 'tmb', 'tmb:' || o.id, lower(btrim(o.customer_email)), o.customer_name,
         case o.status when 'Efetivado' then 'paid' when 'Cancelado' then 'refunded' else lower(o.status) end,
         o.created_at, coalesce(o.total_amount * (1 - coalesce(o.admin_fee_pct, 0) / 100), 0)
    from public.bundle_products bp join public.tmb_orders o on o.product_id::text = bp.product_id
   where bp.platform = 'tmb'
  union all
  select bp.bundle_id, 'hotmart', 'hotmart:' || h.transaction, lower(btrim(h.buyer_email)), h.buyer_name,
         case when h.status in ('APPROVED', 'COMPLETE') then 'paid'
              when h.status in ('REFUNDED', 'PARTIALLY_REFUNDED') then 'refunded'
              when h.status = 'CHARGEBACK' then 'chargedback' else lower(h.status) end,
         h.order_date, case when h.currency = 'BRL' then coalesce(h.price_value - coalesce(h.fee_total, 0), 0) else 0 end
    from public.bundle_products bp join public.hotmart_sales h on h.product_id::text = bp.product_id
   where bp.platform = 'hotmart' and h.commission_as in ('PRODUCER', 'COPRODUCER')
)
select c.platform, c.sale_id, c.bundle_id, b.name as plan_name, b.months, t.id as tool_id, t.slug, t.name as tool,
       c.email, c.nome, c.status, c.ts, round(c.liquido * coalesce(p.peso, 0), 2) as liquido
  from compra c
  join public.product_bundles b on b.id = c.bundle_id and not b.lifetime and b.months is not null
  join public.bundle_components bc on bc.bundle_id = c.bundle_id
  join public.tools t on t.slug = bc.component
  left join pesos p on p.bundle_id = bc.bundle_id and p.component = bc.component
 where c.email is not null and c.email <> '' and c.ts is not null;

revoke all on public.bundle_term_sales from public, anon;
grant select on public.bundle_term_sales to authenticated;

-- 4. Assinaturas por cliente e ferramenta: vendas da Kiwify + compras de combos com prazo.
--    Vencimento = o do último pagamento, mas nunca antes do fim de um combo com prazo já pago (uma mensalidade
--    cobrada depois da Black não encurta o ano da Black).
create or replace view public.customer_software with (security_invoker = true) as
with params as (
  select now() as agora, (now() at time zone 'America/Sao_Paulo')::date as hoje
),
tp as (
  select p_1.id as product_id, t.id as tool_id, t.slug, t.name as tool, t.revenue_start
    from public.kiwify_products p_1 join public.tools t on t.id = p_1.tool_id
),
vendas as (
  select tp.tool_id, tp.slug, tp.tool, lower(s.customer_email) as email, s.customer_name, s.status,
         coalesce(kp.plan_name, s.plan_name, '(sem plano)') as plan_name,
         coalesce(kp.months, public.guess_plan_months(s.plan_name)) as months,
         coalesce(s.net_amount, 0) as liquido, s.sale_created_at as ts, false as termo
    from public.kiwify_sales_snapshot s
    join tp on tp.product_id = s.product_id
    left join public.kiwify_plans kp on kp.plan_id = s.plan_id
   where s.customer_email is not null and (tp.revenue_start is null or s.sale_created_at >= tp.revenue_start::timestamptz)
  union all
  select b.tool_id, b.slug, b.tool, b.email, b.nome, b.status, b.plan_name, b.months, b.liquido, b.ts, true
    from public.bundle_term_sales b
),
pagas as (
  select v.*, v.ts + make_interval(months => v.months) as cobre_ate
    from vendas v where v.status in ('paid', 'approved')
),
cli as (
  select tool_id, slug, tool, email,
         (array_agg(customer_name order by ts desc))[1] as nome,
         min(ts) as primeira_compra, max(ts) as ultima_compra, count(*) as pagamentos, sum(liquido) as liquido_total,
         greatest((array_agg(cobre_ate order by ts desc))[1], max(cobre_ate) filter (where termo)) as cobre_ate,
         (array_agg(plan_name order by ts desc))[1] as plano,
         (array_agg(months order by ts desc))[1] as meses_plano
    from pagas group by tool_id, slug, tool, email
),
problemas as (
  select tool_id, email, bool_or(status = 'refunded') as reembolsou, bool_or(status = 'chargedback') as chargeback
    from vendas group by tool_id, email
),
uso as (
  select u.software, u.email, max(u.last_at) as ultimo_acesso, sum(u.hits) as acessos_total,
         coalesce(sum(u.hits) filter (where u.day >= p_1.hoje - 6), 0::bigint) as acessos_7,
         coalesce(sum(u.hits) filter (where u.day >= p_1.hoje - 29), 0::bigint) as acessos_30,
         count(*) filter (where u.day >= p_1.hoje - 6) as dias_7,
         count(*) filter (where u.day >= p_1.hoje - 29) as dias_30
    from public.usage_daily u cross join params p_1
   group by u.software, u.email
)
select c.tool_id, c.slug as software, c.tool, c.email, c.nome, c.primeira_compra, c.ultima_compra, c.pagamentos,
       c.liquido_total, c.plano, c.meses_plano, c.cobre_ate,
       case when c.cobre_ate >= p.agora then 'ativo'
            when c.cobre_ate >= p.agora - interval '15 days' then 'carencia'
            else 'cancelou' end as situacao,
       extract(epoch from c.cobre_ate - p.agora) / 86400::numeric as dias_para_vencer,
       coalesce(pb.reembolsou, false) as reembolsou,
       coalesce(pb.chargeback, false) as chargeback,
       count(*) over (partition by c.email) as n_produtos,
       us.email is not null as tem_uso,
       us.ultimo_acesso,
       coalesce(us.acessos_total, 0::bigint) as acessos_total,
       coalesce(us.acessos_7, 0::bigint) as acessos_7,
       coalesce(us.acessos_30, 0::bigint) as acessos_30,
       coalesce(us.dias_7, 0::bigint) as dias_7,
       coalesce(us.dias_30, 0::bigint) as dias_30,
       case when us.ultimo_acesso is null then null::numeric
            else extract(epoch from p.agora - us.ultimo_acesso) / 86400::numeric end as dias_sem_acesso
  from cli c
  cross join params p
  left join problemas pb on pb.tool_id = c.tool_id and pb.email = c.email
  left join uso us on us.software = c.slug and us.email = c.email;

-- 5. Acessos por ferramenta: reembolso/chargeback da Black também conta como "devolveu".
create or replace view public.tool_grants with (security_invoker = true) as
with comp as (
  select c.bundle_id, c.component as tool from public.bundle_components c join public.tools t on t.slug = c.component
),
combo as (
  select bp.bundle_id, 'kiwify'::text as platform, lower(k.customer_email) as email, k.sale_created_at as ts,
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
select c.platform, c.email, cp.tool,
       case when c.paga then 'vitalicio' else 'devolvido' end as kind,
       c.ts, null::timestamptz as cobre_ate, (case when c.paga then 1 else 0 end)::bigint as pagamentos,
       b.name as plano, false as teste
  from combo c
  join public.product_bundles b on b.id = c.bundle_id and b.lifetime
  join comp cp on cp.bundle_id = c.bundle_id
 where c.email is not null
union all
select 'kiwify', cs.email, cs.software, 'assinatura', cs.primeira_compra, cs.cobre_ate, cs.pagamentos, cs.plano,
       cs.plano ~* 'teste' or cs.liquido_total < 5::numeric
  from public.customer_software cs
union all
select 'kiwify', lower(s.customer_email), t.slug, 'devolvido', s.sale_created_at, null::timestamptz, 0, s.plan_name, false
  from public.kiwify_sales_snapshot s
  join public.kiwify_products p on p.id = s.product_id
  join public.tools t on t.id = p.tool_id
 where s.status in ('refunded', 'chargedback') and s.customer_email is not null
   and (t.revenue_start is null or s.sale_created_at >= t.revenue_start::timestamptz)
union all
select b.platform, b.email, b.slug, 'devolvido', b.ts, null::timestamptz, 0, b.plan_name, false
  from public.bundle_term_sales b
 where b.status in ('refunded', 'chargedback');

-- 6. Retenção e Monetização (rm_refresh): as compras da Black entram como cobranças de 12 meses (plano anual).
--    Novo: 1ª cobrança (conta em "novos"); já assinante: renovação antecipada (o período continua);
--    ex-assinante: novo período, mas não é 1ª cobrança (não conta como novo).
--    Cada compra vira uma cobrança por ferramenta (id "venda:ferramenta", pois rm_charges.sale_id é único); a comissão
--    de afiliado da Black não entra nessas cobranças (ela é do combo inteiro, não de cada ferramenta).
--    Só troca a origem das vendas (_v) da definição em produção; falha se não encontrar o trecho.
do $mig$
declare
  def text := pg_get_functiondef('public.rm_refresh()'::regprocedure);
  old_txt text := E'     and (t.revenue_start is null or s.sale_created_at >= t.revenue_start::timestamptz);\n  create index on _v (tool, email, status, ts);';
  new_txt text := E'     and (t.revenue_start is null or s.sale_created_at >= t.revenue_start::timestamptz)\n  union all\n  select b.slug, b.email, b.sale_id || '':'' || b.slug, b.status, b.ts, b.months, b.plan_name, b.liquido\n    from public.bundle_term_sales b;\n  create index on _v (tool, email, status, ts);';
begin
  if position(new_txt in def) > 0 then return; end if; -- já aplicado
  if position(old_txt in def) = 0 then raise exception 'rm_refresh: trecho das vendas não encontrado'; end if;
  execute replace(def, old_txt, new_txt);
end
$mig$;
