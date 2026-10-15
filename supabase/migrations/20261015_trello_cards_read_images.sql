-- Cards Trello: status Lido/Pendente e imagens anexadas ao card.
--
-- read_at/read_by: marcado pelo painel (botão "Marcar como lido") via trello_set_read; o sync nunca mexe.
-- images: anexos de imagem do card no Trello ({ id, name, mime }). O painel mostra pela Edge Function
-- trello-cards (ação "image"), porque os anexos do Trello só abrem com a chave da API.

alter table public.trello_cards
  add column if not exists read_at timestamptz,
  add column if not exists read_by uuid,
  add column if not exists images  jsonb not null default '[]'::jsonb;

create or replace function public.trello_set_read(p_id text, p_read boolean)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v timestamptz;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  update public.trello_cards
     set read_at = case when p_read then now() end,
         read_by = case when p_read then auth.uid() end
   where id = p_id
  returning read_at into v;
  return v;
end $$;
revoke all on function public.trello_set_read(text, boolean) from public, anon;
grant execute on function public.trello_set_read(text, boolean) to authenticated;
