-- Acesso por menu.
--
-- Cada pessoa em app_admins tem um perfil:
--   role = 'admin'  → vê todos os menus e gerencia a tela Equipe (padrão: todos os acessos que já existiam)
--   role = 'custom' → vê só os menus em `menus` (chaves abaixo)
--
-- Chaves de menu:
--   Financeiro: fin.financeiro (Home e ferramentas) · fin.health (Flow Health) · fin.clients (Saúde dos clientes)
--               fin.hours (Horas de dev.) · fin.trello (Cards Trello)
--   Afiliados:  af.overview (Visão geral) · af.base (Influencers) · af.flowinf (Influencers Flow)
--               af.products (Produtos) · af.youtube (YouTube) · af.mercado (Rastrear Mercado)
--
-- O painel esconde o que a pessoa não pode ver, e as regras do banco (RLS) garantem o mesmo nos dados:
-- cada tabela só abre para quem tem algum menu que a usa. is_admin() continua significando "tem acesso
-- ao painel" (ui_prefs, sync_state); is_owner() é o perfil admin.

alter table public.app_admins
  add column if not exists role  text   not null default 'admin',
  add column if not exists menus text[] not null default '{}';
alter table public.app_admins drop constraint if exists app_admins_role_check;
alter table public.app_admins add constraint app_admins_role_check check (role in ('admin', 'custom'));

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid() and role = 'admin');
$$;

-- true se a pessoa é admin ou tem algum dos menus pedidos.
create or replace function public.can(p_menus text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins a
                  where a.user_id = auth.uid() and (a.role = 'admin' or a.menus && p_menus));
$$;

-- Perfil de quem está logado (o painel usa para montar o menu).
create or replace function public.my_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('role', a.role, 'menus', to_jsonb(a.menus), 'email', a.email)
    from public.app_admins a where a.user_id = auth.uid();
$$;

revoke all on function public.is_owner() from public, anon;
revoke all on function public.can(text[]) from public, anon;
revoke all on function public.my_access() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;
grant execute on function public.can(text[]) to authenticated, service_role;
grant execute on function public.my_access() to authenticated;

-- Regras por tabela: quem lê (read) e quem altera (write). As policies existentes são recriadas
-- com o mesmo nome e comando, trocando is_admin() por can(...).
do $$
declare
  fin_all text := 'fin.financeiro,fin.health,fin.clients,fin.hours,fin.trello';
  af_all  text := 'af.overview,af.base,af.flowinf,af.products,af.youtube,af.mercado';
  m record;
  p record;
  rd text; wr text; expr text;
begin
  create temp table _acc (tbl text, rd text, wr text) on commit drop;
  insert into _acc values
    ('tools',                         fin_all || ',' || af_all,                  'fin.financeiro'),
    ('monthly_expenses',              'fin.financeiro,fin.health',               'fin.financeiro'),
    ('expense_categories',            'fin.financeiro,fin.health',               'fin.financeiro'),
    ('monthly_revenue',               'fin.financeiro',                          'fin.financeiro'),
    ('monthly_revenue_manual_backup', 'fin.financeiro',                          'fin.financeiro'),
    ('kiwify_monthly_product',        'fin.financeiro',                          'fin.financeiro'),
    ('revenue_alerts',                'fin.financeiro',                          'fin.financeiro'),
    ('kiwify_sales_snapshot',         'fin.financeiro,fin.health,fin.clients',   'fin.financeiro'),
    ('kiwify_plans',                  'fin.financeiro,fin.health,fin.clients',   'fin.health'),
    ('flow_goals',                    'fin.health',                              'fin.health'),
    ('kiwify_products',               'fin.financeiro,fin.health,fin.clients,' || af_all, af_all || ',fin.financeiro'),
    ('usage_daily',                   'fin.clients',                             'fin.clients'),
    ('usage_api_keys',                'fin.clients',                             'fin.clients'),
    ('dev_hours_snapshot',            'fin.hours',                               'fin.hours'),
    ('trello_cards',                  'fin.trello',                              'fin.trello'),
    ('affiliates',                    af_all,                                    af_all),
    ('affiliate_sales',               af_all || ',fin.health',                   af_all),
    ('youtube_channels',              af_all,                                    af_all),
    ('youtube_videos',                af_all,                                    af_all),
    ('youtube_channel_snapshots',     af_all,                                    af_all),
    ('influencer_contracts',          'af.flowinf',                              'af.flowinf'),
    ('influencer_deliverables',       'af.flowinf',                              'af.flowinf'),
    ('market_channels',               'af.mercado',                              'af.mercado'),
    ('market_scans',                  'af.mercado',                              'af.mercado'),
    ('market_targets',                'af.mercado',                              'af.mercado');

  for m in select * from _acc loop
    rd := format('public.can(%L::text[])', '{' || m.rd || '}');
    wr := format('public.can(%L::text[])', '{' || m.wr || '}');
    for p in select policyname, cmd from pg_policies where schemaname = 'public' and tablename = m.tbl loop
      execute format('drop policy %I on public.%I', p.policyname, m.tbl);
      if p.cmd = 'SELECT' then
        execute format('create policy %I on public.%I for select to authenticated using (%s)', p.policyname, m.tbl, rd);
      elsif p.cmd = 'INSERT' then
        execute format('create policy %I on public.%I for insert to authenticated with check (%s)', p.policyname, m.tbl, wr);
      elsif p.cmd = 'DELETE' then
        execute format('create policy %I on public.%I for delete to authenticated using (%s)', p.policyname, m.tbl, wr);
      elsif p.cmd = 'UPDATE' then
        execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', p.policyname, m.tbl, wr, wr);
      else -- ALL: leitura e escrita pelo mesmo critério de escrita, mais uma policy só de leitura
        execute format('create policy %I on public.%I for all to authenticated using (%s) with check (%s)', p.policyname, m.tbl, wr, wr);
        if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = m.tbl and cmd = 'SELECT') then
          execute format('create policy %I on public.%I for select to authenticated using (%s)', 'menu_read', m.tbl, rd);
        end if;
      end if;
    end loop;
  end loop;
end $$;

-- Tentativas de login: só admin.
drop policy if exists admin_read on public.login_attempts;
drop policy if exists admin_update on public.login_attempts;
create policy admin_read on public.login_attempts for select to authenticated using (public.is_owner());
create policy admin_update on public.login_attempts for update to authenticated using (public.is_owner()) with check (public.is_owner());

-- Equipe: admin vê todos; cada pessoa vê a própria linha.
drop policy if exists admin_read_app_admins on public.app_admins;
create policy admin_read_app_admins on public.app_admins for select to authenticated
  using (public.is_owner() or user_id = auth.uid());

-- Funções que gravam por conta própria (security definer) passam a pedir o menu certo.
create or replace function public.trello_set_read(p_id text, p_read boolean)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v timestamptz;
begin
  if not public.can(array['fin.trello']) then raise exception 'not allowed'; end if;
  update public.trello_cards
     set read_at = case when p_read then now() end,
         read_by = case when p_read then auth.uid() end
   where id = p_id
  returning read_at into v;
  return v;
end $$;

create or replace function public.usage_import(p_events jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  if not public.can(array['fin.clients']) then raise exception 'sem permissão'; end if;
  return public.usage_ingest_core(p_events);
end $$;
