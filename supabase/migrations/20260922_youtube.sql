-- Canais e vídeos do YouTube dos influencers (a partir do campo affiliates.youtube).
-- Preenchidos pela Edge Function youtube-sync; o painel só lê.

create table if not exists public.youtube_channels (
  affiliate_email  text primary key references public.affiliates(email) on delete cascade,
  input_url        text not null,           -- link cadastrado no painel, para detectar troca
  channel_id       text,
  title            text,
  handle           text,
  thumbnail_url    text,
  country          text,
  channel_created  timestamptz,
  subscribers      bigint,
  hidden_subs      boolean default false,
  total_views      bigint,
  video_count      integer,
  fetched_at       timestamptz,
  error            text
);

create table if not exists public.youtube_videos (
  video_id       text primary key,
  channel_id     text not null,
  title          text,
  published_at   timestamptz,
  duration_s     integer,
  views          bigint,
  likes          bigint,
  comments       bigint,
  thumbnail_url  text,
  fetched_at     timestamptz not null default now()
);
create index if not exists youtube_videos_channel_idx on public.youtube_videos (channel_id, published_at desc);

alter table public.youtube_channels enable row level security;
alter table public.youtube_videos   enable row level security;
create policy auth_read_youtube_channels on public.youtube_channels for select to authenticated using (true);
create policy auth_read_youtube_videos   on public.youtube_videos   for select to authenticated using (true);

-- Short de verdade (confirmado pela URL /shorts/ID), não só pela duração.
alter table public.youtube_videos add column if not exists is_short boolean;
