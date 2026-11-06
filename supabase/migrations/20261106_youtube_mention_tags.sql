-- "Cita a Flow" no YouTube passa a valer também para o vídeo que o influencer marcou na aba Conteúdo do portal.
--
-- Antes, o bloco "Seu canal no YouTube" do portal e a análise do influencer só liam o texto (título/descrição). Quem
-- fala das ferramentas só dentro do vídeo, sem escrever na descrição, marca o vídeo em Conteúdo e agora isso conta
-- nos dois lugares.
--   · portal_youtube: cada vídeo traz flow_tools (slugs marcados pelo influencer).
--   · influencer_analysis_facts: vídeo "sobre a Flow" = título com "flow", descrição citando FlowPages/FlowTracking/
--     FlowSpy ou marcado pelo influencer.

/* ---------------- portal_youtube ---------------- */
create or replace function public.portal_youtube(p_email text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e text := public.portal_target(p_email);
  ch public.youtube_channels;
begin
  if e is null then return null; end if;
  select * into ch from public.youtube_channels where affiliate_email = e;
  if ch.channel_id is null then return null; end if;
  return jsonb_build_object(
    'channel', jsonb_build_object('channel_id', ch.channel_id, 'title', ch.title, 'handle', ch.handle, 'thumbnail_url', ch.thumbnail_url,
      'country', ch.country, 'channel_created', ch.channel_created, 'subscribers', ch.subscribers, 'hidden_subs', ch.hidden_subs,
      'total_views', ch.total_views, 'video_count', ch.video_count, 'fetched_at', ch.fetched_at, 'description', ch.description),
    'videos', coalesce((select jsonb_agg(to_jsonb(v) order by v.published_at desc) from (
        select y.video_id, y.title, y.published_at, y.duration_s, y.views, y.likes, y.comments, y.thumbnail_url, y.is_short, y.description, y.tags,
               (select coalesce(jsonb_agg(t.slug order by t.sort_order), '[]'::jsonb)
                  from public.content_tool_tags g join public.tools t on t.id = g.tool_id
                 where g.kind = 'youtube' and g.content_id = y.video_id) as flow_tools
          from public.youtube_videos y where y.channel_id = ch.channel_id order by y.published_at desc limit 600) v), '[]'::jsonb),
    'snaps', coalesce((select jsonb_agg(jsonb_build_object('day', sn.day, 'subscribers', sn.subscribers, 'total_views', sn.total_views,
        'video_count', sn.video_count, 'taken_at', sn.taken_at) order by sn.day)
      from public.youtube_channel_snapshots sn where sn.channel_id = ch.channel_id), '[]'::jsonb)
  );
end $$;

/* ---------------- influencer_analysis_facts ---------------- */
do $$
declare
  src text;
  old_cond constant text := $c$v.title ~* 'flow' and (c.id is null$c$;
  new_cond constant text := $c$(v.title ~* 'flow' or coalesce(v.description, '') ~* 'flow[[:space:]_.-]*(pages?|track(ing)?|spy)'
        or exists (select 1 from public.content_tool_tags g where g.kind = 'youtube' and g.content_id = v.video_id)) and (c.id is null$c$;
begin
  src := pg_get_functiondef('public.influencer_analysis_facts(text)'::regprocedure);
  if position('content_tool_tags g where g.kind = ''youtube'' and g.content_id = v.video_id)) and (c.id is null' in src) > 0 then
    return;  -- já aplicado
  end if;
  if (length(src) - length(replace(src, old_cond, ''))) / length(old_cond) <> 2 then
    raise exception 'influencer_analysis_facts: trecho dos vídeos sobre a Flow não encontrado';
  end if;
  execute replace(src, old_cond, new_cond);
end $$;
