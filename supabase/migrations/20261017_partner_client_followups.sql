-- Portal do Afiliado: o acompanhamento (feito/pendente + observação) passa a ser do CLIENTE, não de uma venda.
-- Vale para o histórico inteiro dele e aparece em qualquer período. Chave do cliente = a mesma ckey do portal_sales
-- (md5 do e-mail em minúsculas; sem e-mail, do nome). As anotações já feitas por venda são migradas (fica a mais recente).

create or replace function public.portal_ckey(p_email text, p_name text, p_id text)
returns text language sql immutable set search_path = '' as $$
  select md5(coalesce(nullif(lower(btrim(p_email)), ''), 'nome:' || lower(coalesce(p_name, p_id))))
$$;

create table if not exists public.partner_client_followups (
  affiliate_email text not null,
  ckey            text not null,
  done            boolean not null default false,
  note            text,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  primary key (affiliate_email, ckey)
);

alter table public.partner_client_followups enable row level security;
revoke all on public.partner_client_followups from anon, authenticated;
grant select on public.partner_client_followups to authenticated;
drop policy if exists team_read on public.partner_client_followups;
create policy team_read on public.partner_client_followups for select to authenticated
  using ((select public.can(array['af.base', 'af.flowinf'])));

-- Migra as anotações por venda (a mais recente de cada cliente).
insert into public.partner_client_followups (affiliate_email, ckey, done, note, updated_at, updated_by)
select distinct on (f.affiliate_email, public.portal_ckey(s.customer_email, s.customer_name, s.id))
       f.affiliate_email, public.portal_ckey(s.customer_email, s.customer_name, s.id), f.done, f.note, f.updated_at, f.updated_by
  from public.partner_followups f join public.affiliate_sales s on s.id = f.sale_id
 order by f.affiliate_email, public.portal_ckey(s.customer_email, s.customer_name, s.id), f.updated_at desc
on conflict (affiliate_email, ckey) do nothing;

-- Só o afiliado logado grava, e só em cliente que comprou ou tentou comprar com ele.
create or replace function public.portal_set_client_followup(p_ckey text, p_done boolean, p_note text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active);
  n text := nullif(btrim(left(coalesce(p_note, ''), 2000)), '');
  r public.partner_client_followups;
begin
  if e is null then raise exception 'sem acesso ao portal' using errcode = '42501'; end if;
  if not exists (select 1 from public.affiliate_sales s
                  where s.affiliate_email = e and public.portal_ckey(s.customer_email, s.customer_name, s.id) = p_ckey) then
    raise exception 'cliente não encontrado' using errcode = '42501';
  end if;
  insert into public.partner_client_followups as f (affiliate_email, ckey, done, note, updated_at, updated_by)
  values (e, p_ckey, coalesce(p_done, false), n, now(), auth.uid())
  on conflict (affiliate_email, ckey) do update set done = excluded.done, note = excluded.note, updated_at = now(), updated_by = auth.uid()
  returning * into r;
  return jsonb_build_object('done', r.done, 'note', r.note, 'updated_at', r.updated_at);
end $$;

revoke all on function public.portal_set_client_followup(text, boolean, text) from public, anon;
grant execute on function public.portal_set_client_followup(text, boolean, text) to authenticated;

-- A gravação por venda sai de uso (os dados antigos ficam em partner_followups, já migrados).
drop function if exists public.portal_set_followup(text, boolean, text);

-- portal_sales: acompanhamento vem do cliente (todas as vendas dele trazem o mesmo).
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
      'ckey', s.ckey,
      'fam', coalesce(p.tool_id::text, s.product_id), 'fam_name', coalesce(t.name, s.product_name),
      'bought_later_at', bl.at,
      'fu_done', f.done, 'fu_note', f.note, 'fu_at', f.updated_at
    ) order by s.sale_created_at desc)
    from (select x.*, public.portal_ckey(x.customer_email, x.customer_name, x.id) as ckey from public.affiliate_sales x
           where x.affiliate_email = e and x.sale_created_at >= p_from and x.sale_created_at < p_to
           order by x.sale_created_at desc limit 5000) s
    left join public.kiwify_products p on p.id = s.product_id
    left join public.tools t on t.id = p.tool_id
    left join public.partner_client_followups f on f.affiliate_email = e and f.ckey = s.ckey
    -- Compra paga depois desta tentativa (só para o que não foi pago), por qualquer canal.
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
