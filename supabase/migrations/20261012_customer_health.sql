-- Saúde dos clientes: engajamento por software (Flow Pages / Flow Tracking / Flow Spy).
--
-- Duas fontes:
--   1) Kiwify (já temos): situação da assinatura de cada cliente por software (ativo, vence em 30 dias,
--      carência, cancelou), pagamentos, plano, receita, uso de mais de um produto. Mesmas regras do flow_health.
--   2) Uso dos softwares (a Biancode envia): acessos por usuário e dia, na tabela usage_daily. Enquanto não
--      houver dados, as telas mostram só a parte da Kiwify.
--
-- Entrada de acessos: Edge Function usage-ingest (chave de API) ou importação de CSV pelo painel.
-- (Estado final aplicado no banco: inclui as correções de desempenho feitas depois da primeira versão.)

/* ---------------- Tabelas ---------------- */
create table if not exists public.usage_daily (
  software text not null check (software in ('flowpages', 'flowtracking', 'flowspy')),
  email    text not null check (email = lower(email) and char_length(email) between 3 and 254),
  day      date not null,                      -- dia em horário de Brasília
  hits     integer not null default 1 check (hits > 0),
  first_at timestamptz not null,
  last_at  timestamptz not null,
  primary key (software, email, day)
);
create index if not exists usage_daily_day_idx on public.usage_daily (software, day desc);
create index if not exists usage_daily_email_idx on public.usage_daily (email);
alter table public.usage_daily enable row level security;
drop policy if exists admin_read on public.usage_daily;
create policy admin_read on public.usage_daily for select to authenticated using (public.is_admin());

-- Chaves de API para a Biancode enviar acessos. Só o hash (sha-256) é guardado.
create table if not exists public.usage_api_keys (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 80),
  key_hash     text not null unique,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  last_used_at timestamptz,
  revoked_at   timestamptz
);
alter table public.usage_api_keys enable row level security;
drop policy if exists admin_read on public.usage_api_keys;
drop policy if exists admin_insert on public.usage_api_keys;
drop policy if exists admin_update on public.usage_api_keys;
create policy admin_read   on public.usage_api_keys for select to authenticated using (public.is_admin());
create policy admin_insert on public.usage_api_keys for insert to authenticated with check (public.is_admin());
create policy admin_update on public.usage_api_keys for update to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.usage_daily, public.usage_api_keys from anon;
grant select on public.usage_daily to authenticated;
grant select, insert, update on public.usage_api_keys to authenticated;

/* ---------------- Entrada de acessos ---------------- */
-- Recebe uma lista [{software, email, at?, hits?}], soma por usuário/software/dia e grava.
create or replace function public.usage_ingest_core(p_events jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if jsonb_typeof(p_events) <> 'array' then raise exception 'events deve ser uma lista'; end if;
  if jsonb_array_length(p_events) > 5000 then raise exception 'máximo de 5000 eventos por chamada'; end if;
  with raw as (
    select lower(btrim(e->>'software')) as software, lower(btrim(e->>'email')) as email,
           coalesce(nullif(e->>'at', '')::timestamptz, now()) as at_ts,
           least(greatest(coalesce(nullif(e->>'hits', '')::integer, 1), 1), 100000) as hits
    from jsonb_array_elements(p_events) e
  ), ok as (
    select * from raw
    where software in ('flowpages', 'flowtracking', 'flowspy')
      and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254
      and at_ts between now() - interval '400 days' and now() + interval '1 day'
  ), agg as (
    select software, email, (at_ts at time zone 'America/Sao_Paulo')::date as day,
           sum(hits)::integer as hits, min(at_ts) as first_at, max(at_ts) as last_at
    from ok group by 1, 2, 3
  ), up as (
    insert into public.usage_daily as u (software, email, day, hits, first_at, last_at)
    select software, email, day, hits, first_at, last_at from agg
    on conflict (software, email, day) do update
      set hits = u.hits + excluded.hits, first_at = least(u.first_at, excluded.first_at), last_at = greatest(u.last_at, excluded.last_at)
    returning 1
  )
  select count(*) into n from up;
  return coalesce(n, 0);
end $$;
revoke all on function public.usage_ingest_core(jsonb) from public, anon, authenticated;

-- Chamada pela Edge Function usage-ingest (service role) depois de validar a chave de API.
create or replace function public.usage_ingest(p_events jsonb) returns integer
language sql security definer set search_path = '' as $$ select public.usage_ingest_core(p_events); $$;
revoke all on function public.usage_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.usage_ingest(jsonb) to service_role;

-- Importação de CSV pelo painel (só administradores).
create or replace function public.usage_import(p_events jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'sem permissão'; end if;
  return public.usage_ingest_core(p_events);
end $$;
revoke all on function public.usage_import(jsonb) from public, anon;
grant execute on function public.usage_import(jsonb) to authenticated;

/* ---------------- Um cliente por software ---------------- */
-- n_produtos usa janela (e não um join) de propósito: o join repetia a conta linha a linha e a lista levava 11 s.
create or replace view public.customer_software with (security_invoker = true) as
with params as (
  select now() as agora, (now() at time zone 'America/Sao_Paulo')::date as hoje
),
tp as (
  select p.id as product_id, t.id as tool_id, t.slug, t.name as tool, t.revenue_start
  from public.kiwify_products p join public.tools t on t.id = p.tool_id
),
vendas as (
  select tp.tool_id, tp.slug, tp.tool, lower(s.customer_email) as email, s.customer_name, s.status,
         coalesce(kp.plan_name, s.plan_name, '(sem plano)') as plan_name,
         coalesce(kp.months, public.guess_plan_months(s.plan_name)) as months,
         coalesce(s.net_amount, 0) as liquido, s.sale_created_at as ts
  from public.kiwify_sales_snapshot s
  join tp on tp.product_id = s.product_id
  left join public.kiwify_plans kp on kp.plan_id = s.plan_id
  where s.customer_email is not null
    and (tp.revenue_start is null or s.sale_created_at >= tp.revenue_start::timestamptz)
),
pagas as (
  select v.*, v.ts + make_interval(months => v.months) as cobre_ate
  from vendas v where v.status in ('paid', 'approved')
),
cli as (
  select tool_id, slug, tool, email,
         (array_agg(customer_name order by ts desc))[1] as nome,
         min(ts) as primeira_compra, max(ts) as ultima_compra, count(*) as pagamentos, sum(liquido) as liquido_total,
         (array_agg(cobre_ate order by ts desc))[1] as cobre_ate,
         (array_agg(plan_name order by ts desc))[1] as plano,
         (array_agg(months order by ts desc))[1] as meses_plano
  from pagas group by 1, 2, 3, 4
),
problemas as (
  select tool_id, email, bool_or(status = 'refunded') as reembolsou, bool_or(status = 'chargedback') as chargeback
  from vendas group by 1, 2
),
uso as (
  select u.software, u.email, max(u.last_at) as ultimo_acesso, sum(u.hits) as acessos_total,
         coalesce(sum(u.hits) filter (where u.day >= p.hoje - 6), 0) as acessos_7,
         coalesce(sum(u.hits) filter (where u.day >= p.hoje - 29), 0) as acessos_30,
         count(*) filter (where u.day >= p.hoje - 6) as dias_7,
         count(*) filter (where u.day >= p.hoje - 29) as dias_30
  from public.usage_daily u cross join params p group by 1, 2
)
select c.tool_id, c.slug as software, c.tool, c.email, c.nome, c.primeira_compra, c.ultima_compra, c.pagamentos,
       c.liquido_total, c.plano, c.meses_plano, c.cobre_ate,
       case when c.cobre_ate >= p.agora then 'ativo'
            when c.cobre_ate >= p.agora - interval '15 days' then 'carencia'
            else 'cancelou' end as situacao,
       extract(epoch from (c.cobre_ate - p.agora)) / 86400 as dias_para_vencer,
       coalesce(pb.reembolsou, false) as reembolsou, coalesce(pb.chargeback, false) as chargeback,
       count(*) over (partition by c.email) as n_produtos,
       (us.email is not null) as tem_uso, us.ultimo_acesso, coalesce(us.acessos_total, 0) as acessos_total,
       coalesce(us.acessos_7, 0) as acessos_7, coalesce(us.acessos_30, 0) as acessos_30,
       coalesce(us.dias_7, 0) as dias_7, coalesce(us.dias_30, 0) as dias_30,
       case when us.ultimo_acesso is null then null else extract(epoch from (p.agora - us.ultimo_acesso)) / 86400 end as dias_sem_acesso
from cli c
cross join params p
left join problemas pb on pb.tool_id = c.tool_id and pb.email = c.email
left join uso us on us.software = c.slug and us.email = c.email;
grant select on public.customer_software to authenticated;

/* ---------------- Resumo por software ---------------- */
-- Faixas de uso: muito_engajado (dias distintos com acesso nos últimos 7 >= p_high), engajado (>= 1 nos últimos 7),
-- baixo (sem acesso há p_low a p_inactive dias), moderado (acessou no mês, sem frequência semanal),
-- inativo (sem acesso há mais de p_inactive dias), nunca (sem nenhum acesso registrado, quando o software já tem dados).
create or replace function public.health_summary(p_high integer default 3, p_low integer default 21, p_inactive integer default 30)
returns jsonb language sql stable security invoker set search_path = '' as $$
with b as (
  select c.*,
    case when not c.tem_uso then (case when su.software is not null then 'nunca' end)
         when c.dias_sem_acesso > p_inactive then 'inativo'
         when c.dias_7 >= p_high then 'muito_engajado'
         when c.dias_7 >= 1 then 'engajado'
         when c.dias_sem_acesso >= p_low then 'baixo'
         else 'moderado' end as uso_seg,
    case when c.situacao = 'ativo' and c.dias_para_vencer <= 30 then 'vence_30' else c.situacao end as ass_seg
  from public.customer_software c
  left join (select distinct software from public.usage_daily) su on su.software = c.software
),
hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),
por_sw as (
  select b.software, b.tool,
    count(*) as clientes,
    count(*) filter (where ass_seg = 'ativo') as ass_ativo,
    count(*) filter (where ass_seg = 'vence_30') as ass_vence_30,
    count(*) filter (where ass_seg = 'carencia') as ass_carencia,
    count(*) filter (where ass_seg = 'cancelou') as ass_cancelou,
    count(*) filter (where reembolsou or chargeback) as reembolsaram,
    count(*) filter (where pagamentos > 1) as renovaram,
    count(*) filter (where n_produtos > 1) as multi_produto,
    count(*) filter (where tem_uso) as com_uso,
    count(*) filter (where tem_uso and (ultimo_acesso at time zone 'America/Sao_Paulo')::date = (select d from hoje)) as hoje,
    count(*) filter (where dias_7 >= 1) as d7,
    count(*) filter (where dias_30 >= 1) as d30,
    count(*) filter (where uso_seg = 'inativo') as inativos,
    count(*) filter (where uso_seg = 'nunca') as nunca,
    count(*) filter (where uso_seg = 'muito_engajado') as seg_muito,
    count(*) filter (where uso_seg = 'engajado') as seg_engajado,
    count(*) filter (where uso_seg = 'moderado') as seg_moderado,
    count(*) filter (where uso_seg = 'baixo') as seg_baixo,
    count(*) filter (where ass_seg in ('ativo', 'vence_30') and dias_para_vencer <= 90) as vencem_90,
    count(*) filter (where ass_seg in ('ativo', 'vence_30') and dias_para_vencer <= 90 and uso_seg in ('inativo', 'baixo', 'nunca')) as vencem_90_sem_uso
  from b group by 1, 2
),
venc as (
  select software, floor(dias_para_vencer / 7)::int as sem, count(*) as n
  from b where ass_seg in ('ativo', 'vence_30') and dias_para_vencer < 84 group by 1, 2
),
planos as (
  select software, plano, count(*) as n,
         row_number() over (partition by software order by count(*) desc) as r
  from b group by 1, 2
)
select jsonb_build_object(
  'gerado_em', now(),
  'uso', jsonb_build_object(
    'eventos', (select count(*) from public.usage_daily),
    'ultimo', (select max(last_at) from public.usage_daily),
    'primeiro_dia', (select min(day) from public.usage_daily),
    'dias', (select count(distinct day) from public.usage_daily)),
  'softwares', coalesce((select jsonb_agg(
      to_jsonb(p) || jsonb_build_object(
        'vencimentos', coalesce((select jsonb_object_agg(v.sem::text, v.n) from venc v where v.software = p.software), '{}'::jsonb),
        'planos', coalesce((select jsonb_agg(jsonb_build_object('plano', pl.plano, 'n', pl.n) order by pl.n desc) from planos pl where pl.software = p.software and pl.r <= 15), '[]'::jsonb))
      order by p.clientes desc) from por_sw p), '[]'::jsonb)
);
$$;
grant execute on function public.health_summary(integer, integer, integer) to authenticated;

/* ---------------- Lista de clientes ---------------- */
-- p_ass: ativo | vence_30 | carencia | cancelou | reembolso | renovou | multi
-- p_uso: muito_engajado | engajado | moderado | baixo | inativo | nunca | hoje | d7 | d30
-- p_ultimo: hoje | 7 | 30 | mais30 | nunca     p_freq_min: mínimo de dias com acesso nos últimos 30
create or replace function public.health_customers(
  p_software text default null, p_ass text default null, p_uso text default null, p_ultimo text default null,
  p_freq_min integer default null, p_plano text default null, p_q text default null,
  p_order text default 'ultima_compra', p_desc boolean default true, p_limit integer default 50, p_offset integer default 0,
  p_high integer default 3, p_low integer default 21, p_inactive integer default 30)
returns jsonb language sql stable security invoker set search_path = '' as $$
with b as (
  select c.*,
    case when not c.tem_uso then (case when su.software is not null then 'nunca' end)
         when c.dias_sem_acesso > p_inactive then 'inativo'
         when c.dias_7 >= p_high then 'muito_engajado'
         when c.dias_7 >= 1 then 'engajado'
         when c.dias_sem_acesso >= p_low then 'baixo'
         else 'moderado' end as uso_seg,
    case when c.situacao = 'ativo' and c.dias_para_vencer <= 30 then 'vence_30' else c.situacao end as ass_seg
  from public.customer_software c
  left join (select distinct software from public.usage_daily) su on su.software = c.software
  where (p_software is null or c.software = p_software)
),
f as materialized (
  select b.*,
    case p_order
      when 'pagamentos' then pagamentos::numeric
      when 'liquido_total' then liquido_total
      when 'ultima_compra' then extract(epoch from ultima_compra)
      when 'dias_para_vencer' then dias_para_vencer::numeric
      when 'ultimo_acesso' then extract(epoch from ultimo_acesso)
      when 'dias_sem_acesso' then dias_sem_acesso::numeric
      when 'acessos_7' then acessos_7::numeric
      when 'acessos_30' then acessos_30::numeric
      when 'dias_30' then dias_30::numeric
      when 'n_produtos' then n_produtos::numeric
    end as sort_val,
    case p_order when 'email' then email when 'nome' then lower(coalesce(nome, '')) end as sort_txt
  from b
  where (p_ass is null or case p_ass
          when 'reembolso' then (reembolsou or chargeback)
          when 'renovou' then pagamentos > 1
          when 'multi' then n_produtos > 1
          else ass_seg = p_ass end)
    and (p_uso is null or case p_uso
          when 'hoje' then tem_uso and (ultimo_acesso at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date
          when 'd7' then dias_7 >= 1
          when 'd30' then dias_30 >= 1
          else uso_seg = p_uso end)
    and (p_ultimo is null or case p_ultimo
          when 'hoje' then tem_uso and (ultimo_acesso at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date
          when '7' then dias_7 >= 1
          when '30' then dias_30 >= 1
          when 'mais30' then tem_uso and dias_sem_acesso > p_inactive
          when 'nunca' then not tem_uso
          else true end)
    and (p_freq_min is null or dias_30 >= p_freq_min)
    and (p_plano is null or plano = p_plano)
    and (p_q is null or p_q = '' or email ilike '%' || p_q || '%' or coalesce(nome, '') ilike '%' || p_q || '%')
),
pag as (
  select * from f
  order by (case when p_desc then sort_val end) desc nulls last, (case when not p_desc then sort_val end) asc nulls last,
           (case when p_desc then sort_txt end) desc, (case when not p_desc then sort_txt end) asc, email, software
  limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0)
)
select jsonb_build_object(
  'total', (select count(*) from f),
  'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'software', software, 'tool', tool, 'email', email, 'nome', nome, 'plano', plano, 'pagamentos', pagamentos,
      'liquido_total', liquido_total, 'ultima_compra', ultima_compra, 'cobre_ate', cobre_ate, 'dias_para_vencer', dias_para_vencer,
      'ass_seg', ass_seg, 'n_produtos', n_produtos, 'tem_uso', tem_uso, 'ultimo_acesso', ultimo_acesso,
      'acessos_7', acessos_7, 'acessos_30', acessos_30, 'dias_7', dias_7, 'dias_30', dias_30,
      'dias_sem_acesso', dias_sem_acesso, 'uso_seg', uso_seg)) from pag), '[]'::jsonb)
);
$$;
grant execute on function public.health_customers(text, text, text, text, integer, text, text, text, boolean, integer, integer, integer, integer, integer) to authenticated;

/* ---------------- Histórico de um cliente ---------------- */
create or replace function public.health_customer(p_email text, p_high integer default 3, p_low integer default 21, p_inactive integer default 30)
returns jsonb language sql stable security invoker set search_path = '' as $$
with e as (select lower(btrim(p_email)) as email),
b as (
  select c.*,
    case when not c.tem_uso then (case when su.software is not null then 'nunca' end)
         when c.dias_sem_acesso > p_inactive then 'inativo'
         when c.dias_7 >= p_high then 'muito_engajado'
         when c.dias_7 >= 1 then 'engajado'
         when c.dias_sem_acesso >= p_low then 'baixo'
         else 'moderado' end as uso_seg,
    case when c.situacao = 'ativo' and c.dias_para_vencer <= 30 then 'vence_30' else c.situacao end as ass_seg
  from public.customer_software c
  left join (select distinct software from public.usage_daily) su on su.software = c.software
  where c.email = (select email from e)
)
select jsonb_build_object(
  'email', (select email from e),
  'nome', (select nome from b order by ultima_compra desc limit 1),
  'softwares', coalesce((select jsonb_agg(jsonb_build_object(
      'software', software, 'tool', tool, 'plano', plano, 'pagamentos', pagamentos, 'liquido_total', liquido_total,
      'primeira_compra', primeira_compra, 'ultima_compra', ultima_compra, 'cobre_ate', cobre_ate, 'dias_para_vencer', dias_para_vencer,
      'ass_seg', ass_seg, 'reembolsou', reembolsou, 'chargeback', chargeback, 'tem_uso', tem_uso, 'ultimo_acesso', ultimo_acesso,
      'acessos_7', acessos_7, 'acessos_30', acessos_30, 'dias_7', dias_7, 'dias_30', dias_30, 'dias_sem_acesso', dias_sem_acesso,
      'acessos_total', acessos_total, 'uso_seg', uso_seg) order by tool) from b), '[]'::jsonb),
  'compras', coalesce((select jsonb_agg(x order by x->>'data' desc) from (
      select jsonb_build_object('tool', t.name, 'plano', coalesce(kp.plan_name, s.plan_name, '(sem plano)'), 'status', s.status,
             'valor', s.net_amount, 'data', s.sale_created_at) as x
      from public.kiwify_sales_snapshot s
      join public.kiwify_products p on p.id = s.product_id
      join public.tools t on t.id = p.tool_id
      left join public.kiwify_plans kp on kp.plan_id = s.plan_id
      where lower(s.customer_email) = (select email from e)
      order by s.sale_created_at desc limit 40) q), '[]'::jsonb),
  'acessos', coalesce((select jsonb_agg(jsonb_build_object('software', software, 'day', day, 'hits', hits) order by day)
      from public.usage_daily where email = (select email from e) and day >= (now() at time zone 'America/Sao_Paulo')::date - 89), '[]'::jsonb)
);
$$;
grant execute on function public.health_customer(text, integer, integer, integer) to authenticated;
