-- Portal do Afiliado: vendas agrupadas por cliente e "recusada de verdade".
-- Uma tentativa recusada (ou pendente) só conta como oportunidade se o cliente NÃO comprou depois a mesma ferramenta
-- (FlowPages, FlowTracking… ou o mesmo produto quando não é ferramenta), por qualquer canal: com este afiliado,
-- com outro ou direto na Kiwify (kiwify_sales_snapshot tem todas as vendas). O portal recebe só o sim/não e a data,
-- nunca de quem foi a compra.

create index if not exists affiliate_sales_customer_lower_idx on public.affiliate_sales (lower(customer_email), sale_created_at);
create index if not exists kiwify_sales_snapshot_customer_lower_idx on public.kiwify_sales_snapshot (lower(customer_email), sale_created_at);

create or replace function public.portal_sales(p_from timestamptz, p_to timestamptz, p_email text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e text := public.portal_target(p_email);
  contact boolean;
begin
  if e is null then return null; end if;
  -- Equipe vendo o portal: sempre com contato. Afiliado: conforme a opção da tela Equipe (p_email dele não muda nada).
  contact := (p_email is not null and public.can(array['af.base', 'af.flowinf'])) or coalesce((select pu.show_customer_contact from public.partner_users pu where pu.user_id = auth.uid()), false);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'at', s.sale_created_at, 'approved_at', s.approved_at, 'refunded_at', s.refunded_at,
      'product', s.product_name, 'tool', t.name, 'status', s.status, 'method', s.payment_method,
      'amount', s.amount, 'commission', s.commission,
      'pct', case when s.commission > 0 and coalesce(s.net_amount, 0) + s.commission > 0
                  then round(100 * s.commission / (coalesce(s.net_amount, 0) + s.commission)) end,
      'customer', s.customer_name,
      'customer_email', case when contact then s.customer_email end,
      'customer_phone', case when contact then s.customer_phone end,
      -- chave do cliente (mesmo com o contato escondido) e "família" do produto (ferramenta ou produto)
      'ckey', md5(coalesce(nullif(lower(btrim(s.customer_email)), ''), 'nome:' || lower(coalesce(s.customer_name, s.id)))),
      'fam', coalesce(p.tool_id::text, s.product_id), 'fam_name', coalesce(t.name, s.product_name),
      'bought_later_at', bl.at,
      'fu_done', f.done, 'fu_note', f.note, 'fu_at', f.updated_at
    ) order by s.sale_created_at desc)
    from (select * from public.affiliate_sales x
           where x.affiliate_email = e and x.sale_created_at >= p_from and x.sale_created_at < p_to
           order by x.sale_created_at desc limit 5000) s
    left join public.kiwify_products p on p.id = s.product_id
    left join public.tools t on t.id = p.tool_id
    left join public.partner_followups f on f.sale_id = s.id and f.affiliate_email = e
    -- Compra paga depois desta tentativa (só para o que não foi pago).
    left join lateral (
      select min(z.at) as at from (
        select a.sale_created_at as at from public.affiliate_sales a left join public.kiwify_products pa on pa.id = a.product_id
         where s.status not in ('paid', 'approved') and s.customer_email is not null
           and lower(a.customer_email) = lower(s.customer_email) and a.sale_created_at >= s.sale_created_at
           and a.status in ('paid', 'approved') and coalesce(pa.tool_id::text, a.product_id) = coalesce(p.tool_id::text, s.product_id)
        union all
        select k.sale_created_at from public.kiwify_sales_snapshot k left join public.kiwify_products pk on pk.id = k.product_id
         where s.status not in ('paid', 'approved') and s.customer_email is not null
           and lower(k.customer_email) = lower(s.customer_email) and k.sale_created_at >= s.sale_created_at
           and k.status in ('paid', 'approved') and coalesce(pk.tool_id::text, k.product_id) = coalesce(p.tool_id::text, s.product_id)
      ) z
    ) bl on true
  ), '[]'::jsonb);
end $$;
