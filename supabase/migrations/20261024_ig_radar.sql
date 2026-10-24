-- Radar Instagram (menu do Financeiro): acompanhar perfis de concorrentes, influencers e qualquer @ do mercado.
--
-- A Meta só mostra dados públicos de contas profissionais (Empresa ou Criador), lidos com a conta da Flow pelo
-- Business Discovery: seguidores, nº de posts, bio e cada post/reel com curtidas, comentários, views e legenda.
-- Alcance, stories e público de outros perfis não saem por API.
-- A Edge Function ig-radar lê um perfil na hora em que ele é adicionado e todos a cada 6 h; a foto diária de
-- seguidores (ig_radar_snapshots) mostra o crescimento a partir do dia em que o perfil entrou no radar.
-- Acesso: quem tem o menu Instagram (fin.instagram) vê e gerencia o radar.

create table if not exists public.ig_radar_profiles (
  username            text primary key check (username ~ '^[a-z0-9._]{1,30}$'),
  category            text not null default 'concorrente' check (category in ('concorrente', 'influencer', 'mercado')),
  note                text,
  added_by            text,
  added_at            timestamptz not null default now(),
  ig_user_id          text,
  name                text,
  biography           text,
  website             text,
  profile_picture_url text,
  followers_count     bigint,
  follows_count       bigint,
  media_count         integer,
  fetched_at          timestamptz,
  error               text
);

create table if not exists public.ig_radar_media (
  id                 text primary key,
  username           text not null references public.ig_radar_profiles(username) on delete cascade,
  media_type         text,
  media_product_type text,
  caption            text,
  permalink          text,
  posted_at          timestamptz,
  like_count         bigint,
  comments_count     bigint,
  view_count         bigint,
  fetched_at         timestamptz not null default now()
);
create index if not exists ig_radar_media_user_idx on public.ig_radar_media (username, posted_at desc);

create table if not exists public.ig_radar_snapshots (
  username        text not null references public.ig_radar_profiles(username) on delete cascade,
  day             date not null,
  followers_count bigint,
  media_count     integer,
  taken_at        timestamptz not null default now(),
  primary key (username, day)
);

-- Quem adicionou (e-mail do login), preenchido pelo banco.
create or replace function public.ig_radar_stamp()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.added_by := coalesce(new.added_by, auth.jwt() ->> 'email', 'sistema');
  return new;
end $$;
drop trigger if exists ig_radar_stamp on public.ig_radar_profiles;
create trigger ig_radar_stamp before insert on public.ig_radar_profiles for each row execute function public.ig_radar_stamp();

alter table public.ig_radar_profiles enable row level security;
alter table public.ig_radar_media enable row level security;
alter table public.ig_radar_snapshots enable row level security;
revoke all on public.ig_radar_profiles, public.ig_radar_media, public.ig_radar_snapshots from anon, authenticated;
grant select on public.ig_radar_profiles, public.ig_radar_media, public.ig_radar_snapshots to authenticated;
-- A tela só escolhe o @, a categoria e a observação; o resto é escrito pela função.
grant insert (username, category, note) on public.ig_radar_profiles to authenticated;
grant update (category, note) on public.ig_radar_profiles to authenticated;
grant delete on public.ig_radar_profiles to authenticated;
do $$ declare t text; begin
  foreach t in array array['ig_radar_profiles', 'ig_radar_media', 'ig_radar_snapshots'] loop
    execute format('drop policy if exists menu_read on public.%I', t);
    execute format('create policy menu_read on public.%I for select to authenticated using ((select public.can(array[''fin.instagram''])))', t);
  end loop;
end $$;
drop policy if exists menu_insert on public.ig_radar_profiles;
drop policy if exists menu_update on public.ig_radar_profiles;
drop policy if exists menu_delete on public.ig_radar_profiles;
create policy menu_insert on public.ig_radar_profiles for insert to authenticated with check ((select public.can(array['fin.instagram'])));
create policy menu_update on public.ig_radar_profiles for update to authenticated
  using ((select public.can(array['fin.instagram']))) with check ((select public.can(array['fin.instagram'])));
create policy menu_delete on public.ig_radar_profiles for delete to authenticated using ((select public.can(array['fin.instagram'])));

-- Rodada a cada 6 h (mesmo segredo dos outros syncs).
select cron.unschedule('ig-radar') where exists (select 1 from cron.job where jobname = 'ig-radar');
select cron.schedule('ig-radar', '37 */6 * * *', $cron$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/ig-radar',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$cron$);
