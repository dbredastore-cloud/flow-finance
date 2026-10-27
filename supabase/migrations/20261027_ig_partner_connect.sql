-- Instagram dos influencers — fase 2: o influencer conecta o próprio Instagram no Portal do Afiliado.
--
-- Login oficial do Instagram (API do Instagram com Login do Instagram, permissões instagram_business_basic e
-- instagram_business_manage_insights). A Edge Function ig-connect faz o login e guarda o token de 60 dias; a ig-partners
-- lê de hora em hora os stories (a Meta só entrega um story nas 24 h em que está no ar) e a cada 6 h as métricas privadas
-- dos posts e reels (alcance, salvamentos, compartilhamentos, tempo assistido), o resumo diário da conta e o público.
-- O token nunca sai do servidor: instagram_connections e instagram_connect_states não abrem para nenhum login.

create table if not exists public.instagram_connections (
  affiliate_email  text primary key references public.affiliates(email) on update cascade on delete cascade,
  ig_user_id       text,
  username         text,
  access_token     text not null,
  token_expires_at timestamptz,
  scopes           text[],
  connected_at     timestamptz not null default now(),
  connected_by     uuid,
  last_refresh_at  timestamptz,
  last_sync_at     timestamptz,
  last_full_at     timestamptz,
  status           text not null default 'ok' check (status in ('ok', 'expired', 'error')),
  error            text
);

-- Pedido de login em andamento (o "state" do OAuth): liga a volta do Instagram ao afiliado que clicou. Vale 15 min.
create table if not exists public.instagram_connect_states (
  state           text primary key,
  affiliate_email text not null references public.affiliates(email) on update cascade on delete cascade,
  user_id         uuid not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '15 minutes'
);

alter table public.instagram_connections enable row level security;
alter table public.instagram_connect_states enable row level security;
revoke all on public.instagram_connections, public.instagram_connect_states from anon, authenticated;

-- Stories de cada influencer conectado (mesmas métricas do @useaflow em ig_stories).
create table if not exists public.instagram_stories (
  id                 text primary key,
  affiliate_email    text not null references public.affiliates(email) on update cascade on delete cascade,
  media_type         text,
  caption            text,
  permalink          text,
  posted_at          timestamptz not null,
  expires_at         timestamptz not null,
  reach              bigint,
  views              bigint,
  replies            bigint,
  shares             bigint,
  total_interactions bigint,
  follows            bigint,
  profile_visits     bigint,
  taps_forward       bigint,
  taps_back          bigint,
  exits              bigint,
  swipes_forward     bigint,
  mentions_flow      boolean not null default false,  -- legenda cita a Flow (FlowPages, FlowTracking, FlowSpy, @useaflow)
  insights_note      text,
  first_seen_at      timestamptz not null default now(),
  insights_at        timestamptz,
  final              boolean not null default false
);
create index if not exists instagram_stories_aff_idx on public.instagram_stories (affiliate_email, posted_at desc);

-- Resumo da conta por dia (fuso da Meta).
create table if not exists public.instagram_account_daily (
  affiliate_email    text not null references public.affiliates(email) on update cascade on delete cascade,
  day                date not null,
  reach              bigint,
  views              bigint,
  accounts_engaged   bigint,
  total_interactions bigint,
  likes              bigint,
  comments           bigint,
  shares             bigint,
  saves              bigint,
  replies            bigint,
  profile_links_taps bigint,
  new_followers      bigint,
  fetched_at         timestamptz not null default now(),
  primary key (affiliate_email, day)
);

-- Público (seguidores) por cidade, país, idade e gênero. A Meta só mostra com 100+ seguidores.
create table if not exists public.instagram_audience (
  affiliate_email text not null references public.affiliates(email) on update cascade on delete cascade,
  breakdown       text not null check (breakdown in ('city', 'country', 'age', 'gender')),
  key             text not null,
  value           bigint,
  fetched_at      timestamptz not null default now(),
  primary key (affiliate_email, breakdown, key)
);

alter table public.instagram_stories enable row level security;
alter table public.instagram_account_daily enable row level security;
alter table public.instagram_audience enable row level security;
revoke all on public.instagram_stories, public.instagram_account_daily, public.instagram_audience from anon, authenticated;
grant select on public.instagram_stories, public.instagram_account_daily, public.instagram_audience to authenticated;
do $$ declare t text; begin
  foreach t in array array['instagram_stories', 'instagram_account_daily', 'instagram_audience'] loop
    execute format('drop policy if exists team_read on public.%I', t);
    execute format('create policy team_read on public.%I for select to authenticated using ((select public.can(array[''af.base'', ''af.flowinf'', ''af.overview''])))', t);
  end loop;
end $$;

-- Situação da conexão para a equipe (sem o token). A visão roda como dona da tabela, por isso a regra de leitura
-- (menus de afiliados) fica dentro dela.
create or replace view public.instagram_connections_public with (security_invoker = false) as
  select affiliate_email, username, connected_at, token_expires_at, last_sync_at, status, error from public.instagram_connections
  where (select public.can(array['af.base', 'af.flowinf', 'af.overview']));
revoke all on public.instagram_connections_public from anon, authenticated;
grant select on public.instagram_connections_public to authenticated;

-- Portal do Afiliado: o Instagram do afiliado, agora com a conexão, stories, resumo diário e público.
-- Devolve o objeto mesmo sem perfil lido, para o portal mostrar o botão "Conectar Instagram".
create or replace function public.portal_instagram(p_email text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e text := public.portal_target(p_email);
  a public.instagram_accounts;
  c public.instagram_connections;
begin
  if e is null then return null; end if;
  select * into a from public.instagram_accounts where affiliate_email = e;
  select * into c from public.instagram_connections where affiliate_email = e;
  return jsonb_build_object(
    'account', case when a.username is null then null else jsonb_build_object('username', a.username, 'name', a.name, 'profile_picture_url', a.profile_picture_url,
      'followers_count', a.followers_count, 'follows_count', a.follows_count, 'media_count', a.media_count,
      'source', a.source, 'fetched_at', a.fetched_at) end,
    'connection', case when c.affiliate_email is null then null else jsonb_build_object('username', c.username, 'connected_at', c.connected_at,
      'last_sync_at', c.last_sync_at, 'status', c.status, 'error', c.error, 'token_expires_at', c.token_expires_at) end,
    'media', coalesce((select jsonb_agg(to_jsonb(m) - 'affiliate_email' - 'source' - 'fetched_at' order by m.posted_at desc)
        from (select * from public.instagram_media where affiliate_email = e order by posted_at desc limit 300) m), '[]'::jsonb),
    'snaps', coalesce((select jsonb_agg(jsonb_build_object('day', s.day, 'followers_count', s.followers_count) order by s.day)
        from public.instagram_snapshots s where s.affiliate_email = e), '[]'::jsonb),
    'stories', coalesce((select jsonb_agg(to_jsonb(st) - 'affiliate_email' order by st.posted_at desc)
        from (select * from public.instagram_stories where affiliate_email = e and posted_at > now() - interval '120 days' order by posted_at desc limit 500) st), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(to_jsonb(d) - 'affiliate_email' - 'fetched_at' order by d.day)
        from public.instagram_account_daily d where d.affiliate_email = e and d.day > current_date - 60), '[]'::jsonb),
    'audience', coalesce((select jsonb_agg(jsonb_build_object('breakdown', au.breakdown, 'key', au.key, 'value', au.value) order by au.breakdown, au.value desc)
        from public.instagram_audience au where au.affiliate_email = e), '[]'::jsonb)
  );
end $$;
revoke all on function public.portal_instagram(text) from public, anon;
grant execute on function public.portal_instagram(text) to authenticated;

-- Rodada de hora em hora (mesmo segredo dos outros syncs).
select cron.unschedule('ig-partners') where exists (select 1 from cron.job where jobname = 'ig-partners');
select cron.schedule('ig-partners', '7 * * * *', $cron$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/ig-partners',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$cron$);
