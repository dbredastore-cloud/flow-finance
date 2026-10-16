-- Portal do Afiliado: acompanhamento de cada venda pelo próprio afiliado.
-- Ele marca o cliente como "feito" ou "pendente" (ex.: já chamou no WhatsApp, recuperou a venda) e anota o que foi tratado.
-- Grava só pela função portal_set_followup, que confere se a venda é do afiliado logado; a equipe vê junto (portal_sales).

create table if not exists public.partner_followups (
  sale_id         text primary key references public.affiliate_sales(id) on delete cascade,
  affiliate_email text not null,
  done            boolean not null default false,
  note            text,
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);
create index if not exists partner_followups_affiliate_idx on public.partner_followups (affiliate_email);

alter table public.partner_followups enable row level security;
revoke all on public.partner_followups from anon, authenticated;
grant select on public.partner_followups to authenticated;
drop policy if exists team_read on public.partner_followups;
create policy team_read on public.partner_followups for select to authenticated
  using ((select public.can(array['af.base', 'af.flowinf'])));

-- Só o afiliado logado (não a visão da equipe) grava, e só em vendas dele.
create or replace function public.portal_set_followup(p_sale_id text, p_done boolean, p_note text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
  n text := nullif(btrim(left(coalesce(p_note, ''), 2000)), '');
  r public.partner_followups;
begin
  if e is null then raise exception 'sem acesso ao portal' using errcode = '42501'; end if;
  if not exists (select 1 from public.affiliate_sales s where s.id = p_sale_id and s.affiliate_email = e) then
    raise exception 'venda não encontrada' using errcode = '42501';
  end if;
  insert into public.partner_followups as f (sale_id, affiliate_email, done, note, updated_at, updated_by)
  values (p_sale_id, e, coalesce(p_done, false), n, now(), auth.uid())
  on conflict (sale_id) do update set done = excluded.done, note = excluded.note, updated_at = now(), updated_by = auth.uid()
  returning * into r;
  return jsonb_build_object('done', r.done, 'note', r.note, 'updated_at', r.updated_at);
end $$;

revoke all on function public.portal_set_followup(text, boolean, text) from public, anon;
grant execute on function public.portal_set_followup(text, boolean, text) to authenticated;

-- portal_sales passa a trazer o acompanhamento de cada venda.
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
      'fu_done', f.done, 'fu_note', f.note, 'fu_at', f.updated_at
    ) order by s.sale_created_at desc)
    from (select * from public.affiliate_sales x
           where x.affiliate_email = e and x.sale_created_at >= p_from and x.sale_created_at < p_to
           order by x.sale_created_at desc limit 5000) s
    left join public.kiwify_products p on p.id = s.product_id
    left join public.tools t on t.id = p.tool_id
    left join public.partner_followups f on f.sale_id = s.id and f.affiliate_email = e
  ), '[]'::jsonb);
end $$;
