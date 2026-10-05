-- Últimos vídeos de cada canal analisado no radar (até 50, com métricas de cada um) para a tela completa
-- "Expandir pesquisa". Fica fora do select da lista e é lido só ao expandir um canal.
alter table public.market_channels
  add column if not exists recent_videos jsonb not null default '[]'::jsonb;
