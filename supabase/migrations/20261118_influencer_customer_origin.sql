-- Dashboard do influencer: os clientes que ele trouxe são novos ou já eram clientes da empresa?
--
-- Seção restrita: só aparece para quem estiver em owner_features com a chave 'inf.customer_origin'.
-- A lista de quem pode ver fica só no banco (nenhum e-mail no código das páginas). Para liberar:
--   insert into public.owner_features (user_id, feature)
--   select id, 'inf.customer_origin' from auth.users where email = '<e-mail>';
--
-- Regra: para cada venda paga das ferramentas Flow do influencer dentro da vigência do contrato (mesma regra do
-- cartão do contrato), procura uma compra paga ANTERIOR do mesmo e-mail em qualquer canal da empresa:
--   Kiwify (todos os produtos, com ou sem afiliado: kiwify_sales_snapshot + affiliate_sales),
--   Hotmart (APPROVED/COMPLETE) e TMB (Efetivado).
-- Sem compra anterior = cliente novo. Com compra anterior da mesma ferramenta = já era cliente da ferramenta
-- (renovação/recompra); só de outro produto = já era cliente da empresa (de outro produto).

create table if not exists public.owner_features (
  user_id    uuid not null references auth.users(id) on delete cascade,
  feature    text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, feature)
);
alter table public.owner_features enable row level security;
-- Sem policies: ninguém lê ou grava pela API; só as funções abaixo (security definer) consultam.

create or replace function public.has_owner_feature(p_feature text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.owner_features f where f.user_id = auth.uid() and f.feature = p_feature);
$$;
revoke all on function public.has_owner_feature(text) from public, anon;
grant execute on function public.has_owner_feature(text) to authenticated;

create or replace function public.influencer_customer_origin(p_contract_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c public.influencer_contracts;
begin
  if not public.has_owner_feature('inf.customer_origin') then return null; end if;
  select * into c from public.influencer_contracts where id = p_contract_id;
  if c.id is null then return null; end if;

  return coalesce((
    with s as (
      select x.id, x.sale_created_at, x.product_name, x.amount, x.net_amount, x.customer_name,
             lower(btrim(x.customer_email)) as em, p.tool_id, t.name as tool_name
        from public.affiliate_sales x
        join public.kiwify_products p on p.id = x.product_id and p.tool_id is not null
        join public.tools t on t.id = p.tool_id
       where x.affiliate_email = c.affiliate_email
         and x.status in ('paid', 'approved')
         and x.sale_created_at >= (c.start_date::timestamp at time zone 'America/Sao_Paulo')
         and (c.end_date is null or x.sale_created_at < ((c.end_date + 1)::timestamp at time zone 'America/Sao_Paulo'))
    ),
    prev as (
      -- Todas as compras pagas anteriores de cada cliente, em qualquer canal.
      select s.id as sale_id, z.at, z.platform, z.product, z.tool_id
        from s
        join lateral (
          select k.sale_created_at as at, 'Kiwify'::text as platform, coalesce(pk.name, k.product_id) as product, pk.tool_id
            from public.kiwify_sales_snapshot k left join public.kiwify_products pk on pk.id = k.product_id
           where lower(k.customer_email) = s.em and k.sale_created_at < s.sale_created_at and k.id <> s.id
             and k.status in ('paid', 'approved')
          union all
          select a.sale_created_at, 'Kiwify', coalesce(pa.name, a.product_name), pa.tool_id
            from public.affiliate_sales a left join public.kiwify_products pa on pa.id = a.product_id
           where lower(a.customer_email) = s.em and a.sale_created_at < s.sale_created_at and a.id <> s.id
             and a.status in ('paid', 'approved')
             and not exists (select 1 from public.kiwify_sales_snapshot k2 where k2.id = a.id)
          union all
          select h.order_date, 'Hotmart', h.product_name, null::uuid
            from public.hotmart_sales h
           where lower(h.buyer_email) = s.em and h.order_date < s.sale_created_at and h.status in ('APPROVED', 'COMPLETE')
          union all
          select o.created_at, 'TMB', o.product_name, null::uuid
            from public.tmb_orders o
           where lower(o.customer_email) = s.em and o.created_at < s.sale_created_at and o.status = 'Efetivado'
        ) z on true
       where s.em is not null and s.em <> ''
    ),
    agg as (
      select s.*,
             (select count(*) from prev where prev.sale_id = s.id) as n_prev,
             (select count(*) from prev where prev.sale_id = s.id and prev.tool_id = s.tool_id) as n_same,
             f.at as first_at, f.platform as first_platform, f.product as first_product,
             (select jsonb_agg(distinct prev.platform) from prev where prev.sale_id = s.id) as platforms
        from s
        left join lateral (select prev.at, prev.platform, prev.product from prev where prev.sale_id = s.id order by prev.at limit 1) f on true
    )
    select jsonb_agg(jsonb_build_object(
      'id', id, 'at', sale_created_at, 'product', product_name, 'tool', tool_name,
      'amount', amount, 'net', net_amount, 'customer', customer_name, 'email', em,
      'origin', case when em is null or em = '' then 'unknown' when n_prev = 0 then 'new' when n_same > 0 then 'tool' else 'company' end,
      'prev_count', n_prev, 'first_at', first_at, 'first_platform', first_platform, 'first_product', first_product,
      'platforms', coalesce(platforms, '[]'::jsonb)
    ) order by sale_created_at desc)
    from agg
  ), '[]'::jsonb);
end $$;
revoke all on function public.influencer_customer_origin(uuid) from public, anon;
grant execute on function public.influencer_customer_origin(uuid) to authenticated;
