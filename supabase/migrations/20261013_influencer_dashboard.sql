-- Dashboard do influencer (Influencers Flow): mais dados do YouTube e histórico diário do canal.
--  · descrição/tags de cada vídeo (para achar menções às ferramentas Flow e links divulgados);
--  · descrição e banner do canal;
--  · foto diária de inscritos/views/envios do canal, para mostrar o crescimento durante o contrato
--    (a API só informa o número de agora; o histórico passa a existir a partir do primeiro sync com esta versão).

alter table public.youtube_videos
  add column if not exists description text,
  add column if not exists tags text[];

alter table public.youtube_channels
  add column if not exists description text,
  add column if not exists banner_url text,
  add column if not exists keywords text;

create table if not exists public.youtube_channel_snapshots (
  channel_id   text not null,
  day          date not null,
  subscribers  bigint,
  total_views  bigint,
  video_count  integer,
  taken_at     timestamptz not null default now(),
  primary key (channel_id, day)
);
alter table public.youtube_channel_snapshots enable row level security;
create policy admin_read on public.youtube_channel_snapshots for select to authenticated using (public.is_admin());
revoke all on public.youtube_channel_snapshots from anon;
