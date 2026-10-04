-- Rastrear Mercado: varreduras de canais do YouTube por palavra-chave.
-- Escritas feitas pela Edge Function market-scan (service role); o painel lê.
-- market_targets é o funil de prospecção, editado pelo painel.

create table if not exists public.market_scans (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  keywords    text[] not null,
  options     jsonb  not null default '{}'::jsonb,
  status      text   not null default 'running' check (status in ('running','done','error')),
  candidates  integer not null default 0,
  analyzed    integer not null default 0,
  quota_units integer not null default 0,
  error       text
);
create index if not exists market_scans_created_idx on public.market_scans (created_at desc);

create table if not exists public.market_channels (
  scan_id         uuid not null references public.market_scans(id) on delete cascade,
  channel_id      text not null,
  title           text,
  handle          text,
  thumbnail_url   text,
  country         text,
  description     text,
  channel_created timestamptz,
  subscribers     bigint,
  hidden_subs     boolean not null default false,
  total_views     bigint,
  video_count     integer,
  topic_hits      integer not null default 0,   -- vídeos da busca que pertencem ao canal
  hit_keywords    text[]  not null default '{}',
  sample_videos   jsonb   not null default '[]'::jsonb,  -- vídeos que apareceram na busca
  metrics         jsonb,                        -- métricas calculadas (null = ainda não analisado)
  top_videos      jsonb   not null default '[]'::jsonb,
  contacts        jsonb   not null default '{}'::jsonb,
  analyzed_at     timestamptz,
  error           text,
  primary key (scan_id, channel_id)
);
create index if not exists market_channels_channel_idx on public.market_channels (channel_id);

create table if not exists public.market_targets (
  channel_id text primary key,
  title      text,
  status     text not null default 'novo' check (status in ('novo','prospectar','contatado','parceiro','descartado')),
  updated_at timestamptz not null default now()
);

alter table public.market_scans    enable row level security;
alter table public.market_channels enable row level security;
alter table public.market_targets  enable row level security;

drop policy if exists admin_read   on public.market_scans;
drop policy if exists admin_delete on public.market_scans;
create policy admin_read   on public.market_scans for select to authenticated using (public.is_admin());
create policy admin_delete on public.market_scans for delete to authenticated using (public.is_admin());

drop policy if exists admin_read on public.market_channels;
create policy admin_read on public.market_channels for select to authenticated using (public.is_admin());

drop policy if exists admin_read   on public.market_targets;
drop policy if exists admin_insert on public.market_targets;
drop policy if exists admin_update on public.market_targets;
drop policy if exists admin_delete on public.market_targets;
create policy admin_read   on public.market_targets for select to authenticated using (public.is_admin());
create policy admin_insert on public.market_targets for insert to authenticated with check (public.is_admin());
create policy admin_update on public.market_targets for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_delete on public.market_targets for delete to authenticated using (public.is_admin());

revoke all on public.market_scans, public.market_channels, public.market_targets from anon;
grant select, delete on public.market_scans to authenticated;
grant select on public.market_channels to authenticated;
grant select, insert, update, delete on public.market_targets to authenticated;
