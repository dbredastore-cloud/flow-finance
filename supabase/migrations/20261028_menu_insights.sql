-- Insights da IA em cada menu do Financeiro e dos Afiliados.
--
-- Cada linha é um texto curto (3 a 5 pontos) sobre o que está acontecendo naquele menu, escrito todo dia pela tarefa
-- agendada do Claude ("Análise e Avisos FlowFinance"), sem API paga. O painel mostra o mais recente de cada chave
-- (assets/ai-insights.js).
--   key     · qual tela: fin.health, fin.clients, fin.hours, fin.trello, fin.instagram (Pautas), fin.radar, fin.useaflow,
--             tool:<slug da ferramenta> (página de cada ferramenta), af.overview, af.base, af.flowinf, af.products,
--             af.youtube, af.mercado, af.favoritos
--   access  · menu que precisa ter para ler (public.can), ex.: tool:flowpages → fin.financeiro, fin.radar → fin.instagram

create table if not exists public.menu_insights (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,
  access      text not null,
  created_at  timestamptz not null default now(),
  text        text not null,
  source      text not null default 'claude',
  model       text
);
create index if not exists menu_insights_key_idx on public.menu_insights (key, created_at desc);
alter table public.menu_insights enable row level security;
drop policy if exists menu_read on public.menu_insights;
create policy menu_read on public.menu_insights for select to authenticated using (public.can(array[access]));
