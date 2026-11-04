-- affiliate_tool_months mais rápida: a versão anterior filtrava por lower(affiliate_email), que não usa o
-- índice affiliate_sales_email_idx e varria a tabela inteira (≈1 s por afiliado, às vezes estourando o tempo).
-- Agora busca as vendas do afiliado pelo índice primeiro e só depois liga às ferramentas (≈30 ms).

create or replace function public.affiliate_tool_months(p_email text)
returns table (ym text, tool text, vendas integer, reembolsos integer, faturamento numeric, comissao numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can(array['af.base', 'af.flowinf', 'af.overview']) then raise exception 'sem permissão'; end if;
  return query
  with s as materialized (
    select a.product_id, a.status, a.amount, a.commission, a.sale_created_at
      from public.affiliate_sales a
     where a.affiliate_email = any (array[p_email, lower(p_email)])
  )
  select to_char(s.sale_created_at at time zone 'America/Sao_Paulo', 'YYYY-MM') as ym,
         t.slug as tool,
         (count(*) filter (where s.status in ('paid', 'approved')))::integer,
         (count(*) filter (where s.status in ('refunded', 'chargedback', 'refund_requested', 'pending_refund')))::integer,
         coalesce(sum(s.amount) filter (where s.status in ('paid', 'approved')), 0)::numeric,
         coalesce(sum(s.commission) filter (where s.status in ('paid', 'approved')), 0)::numeric
    from s
    join public.kiwify_products p on p.id = s.product_id
    join public.tools t on t.id = p.tool_id
   where t.slug in ('flowpages', 'flowtracking', 'flowspy')
   group by 1, 2
   order by 1, 2;
end $$;
