-- Ideias Usuários (menu do Financeiro): o que o público pede, sugere ou pergunta sobre as ferramentas Flow.
--
-- source : de onde veio — comentario (post/reels do @useaflow), caixinha (caixinha de perguntas dos stories),
--          direct, enquete ou outro.
-- tool   : FlowSpy, FlowPages, FlowTracking ou Geral.
-- kind   : ideia (pedido de recurso/melhoria), duvida, compra (preço, plano, promoção) ou problema.
-- status : novo → analise → roadmap → entregue (ou descartado). A equipe muda no painel.
-- Comentários importados guardam ig_comment_id (único), então a mesma importação pode rodar de novo sem duplicar.
-- Caixinha e Direct não saem pela API do Instagram: a equipe registra à mão no painel.

create table if not exists public.user_ideas (
  id            uuid primary key default gen_random_uuid(),
  source        text not null default 'caixinha' check (source in ('comentario', 'caixinha', 'direct', 'enquete', 'outro')),
  tool          text not null default 'Geral' check (tool in ('FlowSpy', 'FlowPages', 'FlowTracking', 'Geral')),
  kind          text not null default 'ideia' check (kind in ('ideia', 'duvida', 'compra', 'problema')),
  status        text not null default 'novo' check (status in ('novo', 'analise', 'roadmap', 'entregue', 'descartado')),
  text          text not null check (length(btrim(text)) between 1 and 4000),
  author        text,                 -- @ de quem pediu, quando se sabe
  note          text,                 -- observação interna da equipe
  said_at       timestamptz not null default now(),  -- quando a pessoa pediu
  ig_comment_id text unique,
  ig_media_id   text,
  ig_permalink  text,
  created_at    timestamptz not null default now(),
  created_by    text,
  updated_at    timestamptz,
  updated_by    text
);
create index if not exists user_ideas_said_idx on public.user_ideas (said_at desc);

-- Quem registrou e quem mudou por último (e-mail do login), preenchido pelo banco.
create or replace function public.user_ideas_stamp()
returns trigger language plpgsql set search_path = '' as $$
declare who text := coalesce(auth.jwt() ->> 'email', 'sistema');
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := coalesce(new.created_by, who);
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := who;
  end if;
  return new;
end $$;
drop trigger if exists user_ideas_stamp on public.user_ideas;
create trigger user_ideas_stamp before insert or update on public.user_ideas
  for each row execute function public.user_ideas_stamp();

alter table public.user_ideas enable row level security;
revoke all on public.user_ideas from anon, authenticated;
grant select, insert, update, delete on public.user_ideas to authenticated;
drop policy if exists menu_read on public.user_ideas;
drop policy if exists menu_insert on public.user_ideas;
drop policy if exists menu_update on public.user_ideas;
drop policy if exists menu_delete on public.user_ideas;
create policy menu_read on public.user_ideas for select to authenticated using ((select public.can(array['fin.ideias'])));
create policy menu_insert on public.user_ideas for insert to authenticated with check ((select public.can(array['fin.ideias'])));
create policy menu_update on public.user_ideas for update to authenticated
  using ((select public.can(array['fin.ideias']))) with check ((select public.can(array['fin.ideias'])));
create policy menu_delete on public.user_ideas for delete to authenticated using ((select public.can(array['fin.ideias'])));
