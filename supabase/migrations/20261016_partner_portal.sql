-- Portal do afiliado (/parceiro/): o afiliado entra com login próprio e vê SÓ os dados dele
-- (vendas, clientes, contrato do Influencers Flow e canal do YouTube).
--
-- Segurança:
--   · o afiliado NÃO entra em app_admins: todas as tabelas continuam fechadas para ele (RLS por can()/is_admin());
--   · ele só lê pelas funções portal_* abaixo (security definer), que filtram pelo e-mail de afiliado
--     vinculado ao login em partner_users — nunca pelo que vem do navegador;
--   · a equipe (menu Afiliados ou Influencers Flow) pode passar p_email para ver o portal como o afiliado vê.
-- Contas e vínculos são criados pela tela Equipe (Edge Function team-admin, perfil admin).

-- WhatsApp/telefone do cliente (vem da Kiwify em customer.mobile; preenchido pelo kiwify-sync).
alter table public.affiliate_sales add column if not exists customer_phone text;

create table if not exists public.partner_users (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  affiliate_email       text not null references public.affiliates(email) on update cascade on delete cascade,
  login_email           text,
  active                boolean not null default true,
  show_customer_contact boolean not null default true,   -- mostra e-mail e WhatsApp dos clientes no portal
  created_by            uuid,
  created_at            timestamptz not null default now(),
  last_seen_at          timestamptz
);
create index if not exists partner_users_affiliate_idx on public.partner_users (affiliate_email);

alter table public.partner_users enable row level security;
revoke all on public.partner_users from anon, authenticated;
grant select on public.partner_users to authenticated;
drop policy if exists team_read on public.partner_users;
create policy team_read on public.partner_users for select to authenticated
  using ((select public.can(array['af.base', 'af.flowinf'])));

-- E-mail de afiliado que o portal vai mostrar: o vínculo do login; ou, para a equipe, o afiliado pedido.
create or replace function public.portal_target(p_email text default null)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when p_email is not null and public.can(array['af.base', 'af.flowinf']) then lower(p_email)
    else (select p.affiliate_email from public.partner_users p where p.user_id = auth.uid() and p.active)
  end
$$;

-- Perfil do afiliado (cabeçalho do portal). null = login sem vínculo ativo.
create or replace function public.portal_me(p_email text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e text := public.portal_target(p_email);
  r jsonb;
begin
  if e is null then return null; end if;
  select jsonb_build_object(
    'email', a.email, 'name', coalesce(a.name, a.email), 'company_name', a.company_name,
    'document', a.company_cnpj, 'instagram', a.instagram, 'youtube', a.youtube, 'tiktok', a.tiktok,
    'preview', p_email is not null and public.can(array['af.base', 'af.flowinf']),
    'show_contact', coalesce((select pu.show_customer_contact from public.partner_users pu where pu.affiliate_email = a.email and pu.active
                               order by (pu.user_id = auth.uid()) desc limit 1), true),
    'first_sale', (select min(s.sale_created_at) from public.affiliate_sales s where s.affiliate_email = a.email),
    'has_contract', exists (select 1 from public.influencer_contracts c where c.affiliate_email = a.email),
    'has_channel', exists (select 1 from public.youtube_channels y where y.affiliate_email = a.email and y.channel_id is not null)
  ) into r
  from public.affiliates a where a.email = e;
  if r is not null and p_email is null then
    update public.partner_users set last_seen_at = now() where user_id = auth.uid();
  end if;
  return r;
end $$;

-- Vendas do afiliado no período (todas as situações). Valor = valor cobrado do cliente; % = comissão ÷ (líquido + comissão),
-- a mesma conta do painel. O líquido do produtor não sai daqui.
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
      'customer_phone', case when contact then s.customer_phone end
    ) order by s.sale_created_at desc)
    from (select * from public.affiliate_sales x
           where x.affiliate_email = e and x.sale_created_at >= p_from and x.sale_created_at < p_to
           order by x.sale_created_at desc limit 5000) s
    left join public.kiwify_products p on p.id = s.product_id
    left join public.tools t on t.id = p.tool_id
  ), '[]'::jsonb);
end $$;

-- Contrato do Influencers Flow: termos (sem as observações internas), entregas do mês e as vendas aprovadas
-- das ferramentas Flow dentro da vigência (para o portal montar o fechamento mês a mês).
create or replace function public.portal_contract(p_email text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e text := public.portal_target(p_email);
  c public.influencer_contracts;
begin
  if e is null then return null; end if;
  select * into c from public.influencer_contracts where affiliate_email = e order by active desc, start_date desc limit 1;
  if c.id is null then return null; end if;
  return jsonb_build_object(
    'contract', jsonb_build_object('active', c.active, 'start_date', c.start_date, 'end_date', c.end_date, 'fixed_fee', c.fixed_fee,
      'commission_pct', c.commission_pct, 'bonus_sales_target', c.bonus_sales_target, 'bonus_amount', c.bonus_amount,
      'stories_per_month', c.stories_per_month, 'reels_per_month', c.reels_per_month, 'youtube_per_month', c.youtube_per_month),
    'deliverables', coalesce((select jsonb_agg(jsonb_build_object('year', d.year, 'month', d.month, 'stories', d.stories_done,
        'reels', d.reels_done, 'youtube', d.youtube_done) order by d.year, d.month)
      from public.influencer_deliverables d where d.contract_id = c.id), '[]'::jsonb),
    'sales', coalesce((select jsonb_agg(jsonb_build_object('at', s.sale_created_at, 'product', s.product_name, 'amount', s.amount, 'commission', s.commission)
        order by s.sale_created_at)
      from public.affiliate_sales s join public.kiwify_products p on p.id = s.product_id
      where s.affiliate_email = e and p.tool_id is not null and s.status in ('paid', 'approved')
        and s.sale_created_at >= (c.start_date::timestamp at time zone 'America/Sao_Paulo')
        and (c.end_date is null or s.sale_created_at < ((c.end_date + 1)::timestamp at time zone 'America/Sao_Paulo'))), '[]'::jsonb)
  );
end $$;

-- Canal do YouTube do afiliado: dados do canal, vídeos (até 600) e a foto diária.
create or replace function public.portal_youtube(p_email text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e text := public.portal_target(p_email);
  ch public.youtube_channels;
begin
  if e is null then return null; end if;
  select * into ch from public.youtube_channels where affiliate_email = e;
  if ch.channel_id is null then return null; end if;
  return jsonb_build_object(
    'channel', jsonb_build_object('channel_id', ch.channel_id, 'title', ch.title, 'handle', ch.handle, 'thumbnail_url', ch.thumbnail_url,
      'country', ch.country, 'channel_created', ch.channel_created, 'subscribers', ch.subscribers, 'hidden_subs', ch.hidden_subs,
      'total_views', ch.total_views, 'video_count', ch.video_count, 'fetched_at', ch.fetched_at, 'description', ch.description),
    'videos', coalesce((select jsonb_agg(to_jsonb(v) order by v.published_at desc) from (
        select video_id, title, published_at, duration_s, views, likes, comments, thumbnail_url, is_short, description, tags
          from public.youtube_videos where channel_id = ch.channel_id order by published_at desc limit 600) v), '[]'::jsonb),
    'snaps', coalesce((select jsonb_agg(jsonb_build_object('day', sn.day, 'subscribers', sn.subscribers, 'total_views', sn.total_views,
        'video_count', sn.video_count, 'taken_at', sn.taken_at) order by sn.day)
      from public.youtube_channel_snapshots sn where sn.channel_id = ch.channel_id), '[]'::jsonb)
  );
end $$;

revoke all on function public.portal_target(text), public.portal_me(text), public.portal_sales(timestamptz, timestamptz, text),
  public.portal_contract(text), public.portal_youtube(text) from public, anon;
revoke all on function public.portal_target(text) from authenticated;
grant execute on function public.portal_me(text), public.portal_sales(timestamptz, timestamptz, text),
  public.portal_contract(text), public.portal_youtube(text) to authenticated;

-- Perfil de acesso: o login de afiliado aparece como role "partner" (sem menus); os painéis da equipe o mandam para /parceiro/.
create or replace function public.my_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('role', a.role, 'menus', to_jsonb(a.menus), 'email', a.email)
       from public.app_admins a where a.user_id = auth.uid()),
    (select jsonb_build_object('role', 'partner', 'menus', '[]'::jsonb, 'email', p.login_email)
       from public.partner_users p where p.user_id = auth.uid() and p.active)
  )
$$;
