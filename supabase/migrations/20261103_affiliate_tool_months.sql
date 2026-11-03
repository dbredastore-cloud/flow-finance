-- Ficha expandida do afiliado: vendas de cada mês por ferramenta (Flow Pages, Flow Tracking, Flow Spy).
--
-- Lê affiliate_sales de todo o histórico do afiliado (não só o período filtrado na tela) e liga o produto
-- à ferramenta por kiwify_products.tool_id. Mês no fuso de São Paulo, pela data da venda.
--   vendas      = vendas pagas/aprovadas
--   reembolsos  = vendas do mês que hoje estão reembolsadas ou com chargeback
--   faturamento / comissao = só das vendas pagas/aprovadas

create or replace function public.affiliate_tool_months(p_email text)
returns table (ym text, tool text, vendas integer, reembolsos integer, faturamento numeric, comissao numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can(array['af.base', 'af.flowinf', 'af.overview']) then raise exception 'sem permissão'; end if;
  return query
  select to_char(s.sale_created_at at time zone 'America/Sao_Paulo', 'YYYY-MM') as ym,
         t.slug as tool,
         (count(*) filter (where s.status in ('paid', 'approved')))::integer,
         (count(*) filter (where s.status in ('refunded', 'chargedback', 'refund_requested', 'pending_refund')))::integer,
         coalesce(sum(s.amount) filter (where s.status in ('paid', 'approved')), 0)::numeric,
         coalesce(sum(s.commission) filter (where s.status in ('paid', 'approved')), 0)::numeric
    from public.affiliate_sales s
    join public.kiwify_products p on p.id = s.product_id
    join public.tools t on t.id = p.tool_id
   where lower(s.affiliate_email) = lower(p_email)
     and t.slug in ('flowpages', 'flowtracking', 'flowspy')
   group by 1, 2
   order by 1, 2;
end $$;

revoke all on function public.affiliate_tool_months(text) from public, anon;
grant execute on function public.affiliate_tool_months(text) to authenticated, service_role;
