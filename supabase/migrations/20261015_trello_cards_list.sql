-- Velocidade do menu Cards Trello: a tela baixava trello_cards inteira (1,86 MB com 468 cards), incluindo a
-- descrição completa, o pacote do Instagram (ig) e o endereço de cada imagem. Esta visão entrega só o que a
-- tela usa (≈ 0,77 MB): descrição resumida apenas para cards sem textos e as imagens sem o endereço do Trello
-- (a imagem continua vindo pela Edge Function trello-cards). security_invoker: valem as mesmas regras de acesso.
create or replace view public.trello_cards_list with (security_invoker = true) as
select id, tool, board_name, list_name, stage, name, labels, members, url, due, due_complete,
       entered_list_at, last_activity, active, content_hash, ai, ai_hash, ai_error, read_at,
       case when ai is null then left(description, 240) else '' end as description,
       (select coalesce(jsonb_agg(i - 'url'), '[]'::jsonb) from jsonb_array_elements(images) i) as images
  from public.trello_cards;

revoke all on public.trello_cards_list from anon;
grant select on public.trello_cards_list to authenticated;
