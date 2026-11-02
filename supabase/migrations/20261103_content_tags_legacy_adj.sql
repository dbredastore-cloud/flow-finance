-- Ajustes antigos saem sozinhos quando o influencer começa a marcar.
--
-- Os números lançados à mão antes das marcações viraram ajuste em 20261103_content_tags.sql. Para não contar duas
-- vezes, cada um vale só até o influencer marcar o primeiro conteúdo daquele tipo (stories, reels ou vídeo longo do
-- YouTube) no mesmo ciclo: aí o ajuste daquele tipo zera e passa a valer só o marcado. Ajustes que a equipe digitar
-- depois em Influencers Flow não zeram (o painel tira o tipo de legacy_adj ao salvar).

alter table public.influencer_deliverables add column if not exists legacy_adj text[] not null default '{}';
update public.influencer_deliverables
   set legacy_adj = array_remove(array[case when stories_adj <> 0 then 'stories' end,
                                       case when reels_adj <> 0 then 'reels' end,
                                       case when youtube_adj <> 0 then 'youtube' end], null)
 where legacy_adj = '{}' and (stories_adj <> 0 or reels_adj <> 0 or youtube_adj <> 0);
comment on column public.influencer_deliverables.legacy_adj is
  'Tipos (stories, reels, youtube) cujo ajuste veio do lançamento manual antigo; zera quando o influencer marca o primeiro conteúdo do tipo no ciclo.';

create or replace function public.content_tags_clear_legacy() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_cat text;
  v_day date;
  v_cs date;
  v_contract uuid;
begin
  if new.kind = 'ig_story' then
    select 'stories', coalesce(s.story_date, (s.posted_at at time zone 'America/Sao_Paulo')::date) into v_cat, v_day
      from public.instagram_stories s where s.id = new.content_id;
  elsif new.kind = 'ig_media' then
    select 'reels', (m.posted_at at time zone 'America/Sao_Paulo')::date into v_cat, v_day
      from public.instagram_media m where m.id = new.content_id and m.media_product_type = 'REELS';
  else
    select 'youtube', (v.published_at at time zone 'America/Sao_Paulo')::date into v_cat, v_day
      from public.youtube_videos v where v.video_id = new.content_id and not coalesce(v.is_short, v.duration_s is not null and v.duration_s <= 180);
  end if;
  if v_cat is null then return null; end if;   -- feed, carrossel e Shorts não mexem no ajuste

  select c.id, k.cs into v_contract, v_cs
    from public.influencer_contracts c
    cross join lateral public.contract_cycles(c.start_date, c.end_date) k
   where c.affiliate_email = new.affiliate_email and v_day >= k.cs and v_day < k.ce
     and (c.end_date is null or v_day <= c.end_date)
   order by c.active desc, c.start_date desc limit 1;
  if v_contract is null then return null; end if;

  update public.influencer_deliverables
     set stories_adj = case when v_cat = 'stories' then 0 else stories_adj end,
         reels_adj   = case when v_cat = 'reels' then 0 else reels_adj end,
         youtube_adj = case when v_cat = 'youtube' then 0 else youtube_adj end,
         legacy_adj  = array_remove(legacy_adj, v_cat),
         notes = concat_ws(E'\n', nullif(notes, ''), to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') ||
                   ': ajuste antigo de ' || v_cat || ' zerado (o influencer começou a marcar no Portal).'),
         updated_at = now()
   where contract_id = v_contract and year = extract(year from v_cs)::int and month = extract(month from v_cs)::int
     and v_cat = any (legacy_adj);
  return null;
end $$;
revoke all on function public.content_tags_clear_legacy() from public, anon, authenticated;

drop trigger if exists content_tags_clear_legacy on public.content_tool_tags;
create trigger content_tags_clear_legacy after insert on public.content_tool_tags
  for each row execute function public.content_tags_clear_legacy();
