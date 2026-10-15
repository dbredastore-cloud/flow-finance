-- Menu Instagram (Financeiro): conteúdo de Instagram por card do Trello, só para o que não é bug.
--
-- ig        : roteiros e ideias (escritos pelo Claude, como os demais textos: { v, publico, angulo, formato_ideal,
--             ganchos, reels{...}, carrossel{...}, stories[...], legenda, hashtags, dica })
-- ig_hash   : content_hash do card quando o ig foi escrito (card mudou → reescrever)
-- marcações : Lido, Interessante e Conteúdo feito, compartilhadas pela equipe (quem marcou e quando).
--             Gravadas só pela função trello_ig_flag; cada uma liga e desliga.
-- is_bug    : etiqueta "Bug", tipo "Correção de bug" ou nome começando com "[Bug]". Bugs não entram no menu.

alter table public.trello_cards
  add column if not exists ig              jsonb,
  add column if not exists ig_hash         text,
  add column if not exists ig_generated_at timestamptz,
  add column if not exists ig_read_at      timestamptz,
  add column if not exists ig_read_by      text,
  add column if not exists ig_fav_at       timestamptz,
  add column if not exists ig_fav_by       text,
  add column if not exists ig_used_at      timestamptz,
  add column if not exists ig_used_by      text;

alter table public.trello_cards drop column if exists is_bug;
alter table public.trello_cards add column is_bug boolean generated always as (
  labels @> '[{"name":"Bug"}]'::jsonb or coalesce(ai->>'tipo', '') = 'Correção de bug' or name ilike '[bug]%'
) stored;

-- Cards Trello e Instagram leem a mesma tabela.
drop policy if exists admin_read on public.trello_cards;
create policy admin_read on public.trello_cards for select to authenticated
  using (public.can(array['fin.trello', 'fin.instagram']));

-- p_flag: 'read' | 'fav' | 'used'. Devolve as três marcações atualizadas.
create or replace function public.trello_ig_flag(p_id text, p_flag text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  who text := coalesce(auth.jwt() ->> 'email', auth.uid()::text);
  r public.trello_cards;
begin
  if not public.can(array['fin.instagram']) then raise exception 'not allowed'; end if;
  if p_flag = 'read' then
    update public.trello_cards set ig_read_at = case when p_on then now() end, ig_read_by = case when p_on then who end where id = p_id returning * into r;
  elsif p_flag = 'fav' then
    update public.trello_cards set ig_fav_at = case when p_on then now() end, ig_fav_by = case when p_on then who end where id = p_id returning * into r;
  elsif p_flag = 'used' then
    -- Conteúdo feito também conta como lido.
    update public.trello_cards set ig_used_at = case when p_on then now() end, ig_used_by = case when p_on then who end,
      ig_read_at = case when p_on then coalesce(ig_read_at, now()) else ig_read_at end,
      ig_read_by = case when p_on then coalesce(ig_read_by, who) else ig_read_by end
     where id = p_id returning * into r;
  else
    raise exception 'flag inválida';
  end if;
  if r.id is null then raise exception 'card não encontrado'; end if;
  return jsonb_build_object('ig_read_at', r.ig_read_at, 'ig_read_by', r.ig_read_by, 'ig_fav_at', r.ig_fav_at,
    'ig_fav_by', r.ig_fav_by, 'ig_used_at', r.ig_used_at, 'ig_used_by', r.ig_used_by);
end $$;
revoke all on function public.trello_ig_flag(text, text, boolean) from public, anon;
grant execute on function public.trello_ig_flag(text, text, boolean) to authenticated;
