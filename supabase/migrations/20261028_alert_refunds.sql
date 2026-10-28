-- Avisos → "Ver reembolsos e chargebacks": a lista por trás dos avisos de reembolso, pico de 24 h e chargeback.
--
-- public.alert_refunds(de, até) devolve os reembolsos e chargebacks das ferramentas que ACONTECERAM no período
-- (pela data do reembolso/contestação, a mesma regra dos avisos), com a venda original, cliente, valor, forma de
-- pagamento e afiliado. Security definer porque quem tem só o menu Avisos não lê kiwify_sales_snapshot.

create or replace function public.alert_refunds(p_from timestamptz, p_to timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can(array['fin.avisos', 'fin.financeiro']) then raise exception 'sem permissão'; end if;
  if p_to - p_from > interval '400 days' then raise exception 'período longo demais'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', k.id, 'tipo', case when k.status = 'chargedback' then 'chargeback' else 'reembolso' end,
             'quando', x.at, 'venda_em', k.sale_created_at, 'dias_ate_reembolso', round(extract(epoch from x.at - k.sale_created_at) / 86400.0, 1),
             'ferramenta', t.name, 'produto', p.name, 'valor', k.net_amount, 'cobrado', k.charge_amount,
             'pagamento', k.payment_method, 'cliente', k.customer_name, 'email', k.customer_email,
             'afiliado', a.affiliate_name)
           order by x.at desc)
      from public.kiwify_sales_snapshot k
      join public.kiwify_products p on p.id = k.product_id
      join public.tools t on t.id = p.tool_id
      cross join lateral (select case when k.status = 'chargedback' then coalesce(k.refunded_at, k.kiwify_updated_at) else k.refunded_at end as at) x
      left join public.affiliate_sales a on a.id = k.id and a.affiliate_email is not null
     where k.status in ('refunded', 'chargedback') and x.at >= p_from and x.at < p_to
  ), '[]'::jsonb);
end $$;

revoke all on function public.alert_refunds(timestamptz, timestamptz) from public, anon;
grant execute on function public.alert_refunds(timestamptz, timestamptz) to authenticated;
