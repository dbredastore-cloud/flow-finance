-- Pautas Instagram para os influencers (Portal do Afiliado, /parceiro/).
--
-- A equipe (menu fin.instagram) marca em cada card da tela Pautas Instagram "Mostrar aos influencers"
-- (trello_cards.ig_partner_at/by, função trello_ig_share). Só os cards marcados aparecem no menu Pautas Instagram
-- do portal, com o conteúdo completo menos o link do Trello.
-- Lido, Interessante e Conteúdo feito no portal são de cada afiliado (tabela partner_ig_flags): o que um marca
-- não aparece para os outros nem muda as marcações da equipe.
-- O afiliado não lê trello_cards: tudo passa pelas funções portal_ig_* (security definer), que descobrem o afiliado
-- pelo login (portal_target), como as demais funções do portal.

alter table public.trello_cards
  add column if not exists ig_partner_at timestamptz,
  add column if not exists ig_partner_by text;

create table if not exists public.partner_ig_flags (
  affiliate_email text not null references public.affiliates(email) on update cascade on delete cascade,
  card_id         text not null references public.trello_cards(id) on delete cascade,
  read_at         timestamptz,
  fav_at          timestamptz,
  used_at         timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (affiliate_email, card_id)
);
alter table public.partner_ig_flags enable row level security;
revoke all on public.partner_ig_flags from anon, authenticated;
-- A equipe do Instagram pode ler (ex.: ver quem já fez conteúdo); o afiliado só pelas funções abaixo.
grant select on public.partner_ig_flags to authenticated;
drop policy if exists team_read on public.partner_ig_flags;
create policy team_read on public.partner_ig_flags for select to authenticated using ((select public.can(array['fin.instagram'])));

-- Equipe: liga/desliga "Mostrar aos influencers".
create or replace function public.trello_ig_share(p_id text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  who text := coalesce(auth.jwt() ->> 'email', auth.uid()::text);
  r public.trello_cards;
begin
  if not public.can(array['fin.instagram']) then raise exception 'not allowed'; end if;
  update public.trello_cards
     set ig_partner_at = case when p_on then now() end, ig_partner_by = case when p_on then who end
   where id = p_id returning * into r;
  if r.id is null then raise exception 'card não encontrado'; end if;
  return jsonb_build_object('ig_partner_at', r.ig_partner_at, 'ig_partner_by', r.ig_partner_by);
end $$;

-- Portal: cards liberados, no mesmo formato que a tela da equipe usa (sem url do Trello e sem as marcações da equipe).
-- ig_read_at / ig_fav_at / ig_used_at são as marcações DESTE afiliado.
create or replace function public.portal_ig_cards(p_email text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare e text := public.portal_target(p_email);
begin
  if e is null then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'tool', c.tool, 'board_name', c.board_name, 'list_name', c.list_name, 'stage', c.stage, 'name', c.name,
             'entered_list_at', c.entered_list_at, 'last_activity', c.last_activity, 'ai', c.ai, 'ig', c.ig,
             'shared_at', c.ig_partner_at,
             'ig_read_at', f.read_at, 'ig_fav_at', f.fav_at, 'ig_used_at', f.used_at)
           order by c.ig_partner_at desc)
      from public.trello_cards c
      left join public.partner_ig_flags f on f.card_id = c.id and f.affiliate_email = e
     where c.ig_partner_at is not null and c.active and not coalesce(c.is_bug, false) and c.ai is not null
  ), '[]'::jsonb);
end $$;

-- Portal: Lido, Interessante, Conteúdo feito do próprio afiliado. A equipe vendo "como o afiliado" não grava.
create or replace function public.portal_ig_flag(p_id text, p_flag text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e text := public.portal_target(null);
  v timestamptz := case when p_on then now() end;
  r public.partner_ig_flags;
begin
  if e is null then raise exception 'Só o afiliado marca as próprias pautas.'; end if;
  if p_flag not in ('read', 'fav', 'used') then raise exception 'flag inválida'; end if;
  if not exists (select 1 from public.trello_cards c where c.id = p_id and c.ig_partner_at is not null and c.active and not coalesce(c.is_bug, false)) then
    raise exception 'pauta não encontrada';
  end if;
  insert into public.partner_ig_flags as x (affiliate_email, card_id, read_at, fav_at, used_at)
  values (e, p_id,
          case when p_flag = 'read' or (p_flag = 'used' and p_on) then v end,
          case when p_flag = 'fav' then v end,
          case when p_flag = 'used' then v end)
  on conflict (affiliate_email, card_id) do update set
    read_at = case when p_flag = 'read' then v
                   when p_flag = 'used' and p_on then coalesce(x.read_at, v)   -- conteúdo feito também conta como lido
                   else x.read_at end,
    fav_at  = case when p_flag = 'fav' then v else x.fav_at end,
    used_at = case when p_flag = 'used' then v else x.used_at end,
    updated_at = now()
  returning * into r;
  return jsonb_build_object('ig_read_at', r.read_at, 'ig_fav_at', r.fav_at, 'ig_used_at', r.used_at);
end $$;

revoke all on function public.trello_ig_share(text, boolean), public.portal_ig_cards(text), public.portal_ig_flag(text, text, boolean) from public, anon;
grant execute on function public.trello_ig_share(text, boolean), public.portal_ig_cards(text), public.portal_ig_flag(text, text, boolean) to authenticated;
