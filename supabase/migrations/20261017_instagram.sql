-- Instagram dos influencers (perfil cadastrado na ficha: affiliates.instagram).
-- Fase 1 (agora): Business Discovery — dados públicos de contas profissionais, lidos com a conta da Flow
--   (seguidores, posts, reels, curtidas, comentários, visualizações, legenda). source = 'discovery'.
-- Fase 2 (depois): o influencer conecta o Instagram dele no Portal do Afiliado e entram as métricas privadas
--   (alcance, salvamentos, compartilhamentos, tempo assistido) e os stories. source = 'oauth'; colunas já previstas.
-- Preenchido pela Edge Function instagram-sync; o painel só lê.

create table if not exists public.instagram_accounts (
  affiliate_email     text primary key references public.affiliates(email) on update cascade on delete cascade,
  input_handle        text not null,              -- o que está na ficha (para detectar troca)
  username            text,
  ig_user_id          text,
  name                text,
  biography           text,
  website             text,
  profile_picture_url text,
  followers_count     bigint,
  follows_count       bigint,
  media_count         integer,
  source              text not null default 'discovery' check (source in ('discovery', 'oauth')),
  fetched_at          timestamptz,
  error               text
);

create table if not exists public.instagram_media (
  id                 text primary key,
  affiliate_email    text not null references public.affiliates(email) on update cascade on delete cascade,
  username           text,
  media_type         text,        -- IMAGE, VIDEO, CAROUSEL_ALBUM
  media_product_type text,        -- FEED, REELS, STORY
  caption            text,
  permalink          text,
  posted_at          timestamptz,
  like_count         bigint,
  comments_count     bigint,
  view_count         bigint,
  thumbnail_url      text,
  -- fase 2 (insights do próprio influencer)
  reach              bigint,
  saved              bigint,
  shares             bigint,
  total_interactions bigint,
  avg_watch_ms       bigint,
  insights_at        timestamptz,
  source             text not null default 'discovery',
  fetched_at         timestamptz not null default now()
);
create index if not exists instagram_media_aff_idx on public.instagram_media (affiliate_email, posted_at desc);

-- Foto diária do perfil (crescimento de seguidores).
create table if not exists public.instagram_snapshots (
  affiliate_email text not null references public.affiliates(email) on update cascade on delete cascade,
  day             date not null,
  followers_count bigint,
  media_count     integer,
  taken_at        timestamptz not null default now(),
  primary key (affiliate_email, day)
);

alter table public.instagram_accounts  enable row level security;
alter table public.instagram_media     enable row level security;
alter table public.instagram_snapshots enable row level security;
revoke all on public.instagram_accounts, public.instagram_media, public.instagram_snapshots from anon, authenticated;
grant select on public.instagram_accounts, public.instagram_media, public.instagram_snapshots to authenticated;
do $$ declare t text; begin
  foreach t in array array['instagram_accounts', 'instagram_media', 'instagram_snapshots'] loop
    execute format('drop policy if exists team_read on public.%I', t);
    execute format('create policy team_read on public.%I for select to authenticated using ((select public.can(array[''af.base'', ''af.flowinf'', ''af.overview''])))', t);
  end loop;
end $$;

-- Portal do Afiliado: o Instagram do próprio afiliado (mesma regra das outras funções portal_*).
create or replace function public.portal_instagram(p_email text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e text := public.portal_target(p_email);
  a public.instagram_accounts;
begin
  if e is null then return null; end if;
  select * into a from public.instagram_accounts where affiliate_email = e;
  if a.username is null then return null; end if;
  return jsonb_build_object(
    'account', jsonb_build_object('username', a.username, 'name', a.name, 'profile_picture_url', a.profile_picture_url,
      'followers_count', a.followers_count, 'follows_count', a.follows_count, 'media_count', a.media_count,
      'source', a.source, 'fetched_at', a.fetched_at),
    'media', coalesce((select jsonb_agg(to_jsonb(m) - 'affiliate_email' - 'source' - 'fetched_at' order by m.posted_at desc)
        from (select * from public.instagram_media where affiliate_email = e order by posted_at desc limit 300) m), '[]'::jsonb),
    'snaps', coalesce((select jsonb_agg(jsonb_build_object('day', s.day, 'followers_count', s.followers_count) order by s.day)
        from public.instagram_snapshots s where s.affiliate_email = e), '[]'::jsonb)
  );
end $$;
revoke all on function public.portal_instagram(text) from public, anon;
grant execute on function public.portal_instagram(text) to authenticated;

-- O portal mostra o bloco do Instagram quando há perfil lido.
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
    'has_channel', exists (select 1 from public.youtube_channels y where y.affiliate_email = a.email and y.channel_id is not null),
    'has_instagram', exists (select 1 from public.instagram_accounts i where i.affiliate_email = a.email and i.username is not null)
  ) into r
  from public.affiliates a where a.email = e;
  if r is not null and p_email is null then
    update public.partner_users set last_seen_at = now() where user_id = auth.uid();
  end if;
  return r;
end $$;

-- Rodada automática a cada 6 h (mesmo segredo dos outros syncs).
select cron.unschedule('instagram-sync') where exists (select 1 from cron.job where jobname = 'instagram-sync');
select cron.schedule('instagram-sync', '47 */6 * * *', $cron$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/instagram-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$cron$);
