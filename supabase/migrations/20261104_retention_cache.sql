-- Retenção e Monetização (menu Análises do Financeiro): cache por pg_cron.
--
-- A tela não lê as views customer_software/customer_tools (0,3 a 1,3 s cada) nem lifetime_grants(), que checa
-- public.can() e vem vazia quando roda no cron. rm_refresh() lê as tabelas brutas e grava quatro tabelas pequenas:
--
--   rm_charges · uma linha por cobrança PAGA de assinatura de ferramenta na Kiwify (status paid/approved), a partir do
--                revenue_start da ferramenta. Fora: teste/cortesia (plano "Teste" ou menos de R$ 5 líquidos).
--                Reembolso/chargeback não é pago: a cobrança some daqui (e vira motivo de churn voluntário).
--                cobre_ate = data da cobrança + meses do plano.
--   rm_spells  · períodos contínuos de acesso por e-mail × ferramenta. Junta as cobranças e o combo vitalício
--                (bundle_products de product_bundles.lifetime, pago em Kiwify, TMB ou Hotmart, sem fim). Uma
--                cobrança nova até 20 dias depois do vencimento continua o mesmo período (renovação com atraso);
--                depois disso é um período novo (nova assinatura, não renovação).
--                Período encerrado (fim + 20 dias já passou) = churn da ferramenta, na data do fim da vigência.
--                Motivo do churn:
--                  voluntario    · reembolso/chargeback da ferramenta entre 45 dias antes e 20 dias depois do fim
--                  involuntario  · cobrança recusada ou não paga (refused/waiting_payment) entre 10 dias antes e
--                                  20 dias depois do fim (mesma regra do Flow Health)
--                  nao_identificado · nenhum dos dois (a Kiwify não manda o pedido de cancelamento)
--   rm_cspells · o mesmo por e-mail (todas as ferramentas): o cliente só sai quando perde todas.
--   rm_segs    · trechos de cada período com o plano em vigor (mensal, trimestral, semestral, anual, vitalício) e o
--                valor mensal da cobrança (líquido ÷ meses do plano). Base de "ativo em uma data".
--   rm_renov   · cada cobrança que já venceu (há mais de 20 dias) e se foi renovada (ver rm_refresh).
--   rm_cache   · o histórico mês a mês já calculado, um por filtro de plano (rm_build, em 20261104_retention_dashboard.sql).
--   rm_meta    · data e hora da última atualização.

create table if not exists public.rm_charges (
  tool text not null, email text not null, sale_id text not null, ts timestamptz not null, cobre_ate timestamptz not null,
  months integer not null, plano text not null, liquido numeric not null, comissao numeric not null default 0,
  n integer not null,                      -- 1 = primeira compra paga da ferramenta
  primary key (sale_id)
);
create index if not exists rm_charges_te on public.rm_charges (tool, email, ts);

create table if not exists public.rm_spells (
  tool text not null, email text not null, inicio timestamptz not null, fim timestamptz not null,  -- fim 'infinity' = vitalício
  vitalicio boolean not null, plano_fim text, encerrado boolean not null, motivo text,
  primary key (tool, email, inicio)
);
create table if not exists public.rm_cspells (
  email text not null, inicio timestamptz not null, fim timestamptz not null, vitalicio boolean not null,
  plano_fim text, tool_fim text, encerrado boolean not null, motivo text,
  primary key (email, inicio)
);
create table if not exists public.rm_segs (
  tool text not null, email text not null, s timestamptz not null, e timestamptz not null, plano text not null, mrr numeric not null
);
create index if not exists rm_segs_se on public.rm_segs (s, e);
create index if not exists rm_segs_te on public.rm_segs (tool, email);
create table if not exists public.rm_renov (tool text not null, email text not null, vence timestamptz not null, plano text not null, renovou boolean not null);
create table if not exists public.rm_cache (plano text primary key, payload jsonb not null, gerado_em timestamptz not null default now());
create table if not exists public.rm_meta (id integer primary key default 1 check (id = 1), atualizado_em timestamptz, duracao_ms integer, linhas jsonb);

alter table public.rm_charges enable row level security;
alter table public.rm_spells enable row level security;
alter table public.rm_cspells enable row level security;
alter table public.rm_segs enable row level security;
alter table public.rm_meta enable row level security;
alter table public.rm_renov enable row level security;
alter table public.rm_cache enable row level security;
-- Sem policies: só as funções abaixo (security definer) leem e gravam.

create or replace function public.rm_plan_type(m integer) returns text language sql immutable as $$
  select case when m is null or m <= 1 then 'mensal' when m < 6 then 'trimestral' when m < 12 then 'semestral' else 'anual' end
$$;
-- Filtro de plano da tela: 'todos', 'mensal', 'semestral' (inclui trimestral), 'anual', 'vitalicio'.
create or replace function public.rm_plan_ok(p_plano text, p_filtro text) returns boolean language sql immutable as $$
  select p_filtro is null or p_filtro = 'todos' or p_plano = p_filtro or (p_filtro = 'semestral' and p_plano = 'trimestral')
$$;
create or replace function public.rm_plan_group(p_plano text) returns text language sql immutable as $$
  select case when p_plano = 'trimestral' then 'semestral' else p_plano end
$$;

create or replace function public.rm_refresh() returns jsonb
language plpgsql volatile security definer set search_path = '' set work_mem = '64MB' as $$
declare t0 timestamptz := clock_timestamp(); v_now timestamptz := now(); res jsonb;
begin

  create temp table _v on commit drop as
  select t.slug as tool, lower(btrim(s.customer_email)) as email, s.id, s.status, s.sale_created_at as ts,
         coalesce(kp.months, public.guess_plan_months(s.plan_name), 1) as months,
         coalesce(kp.plan_name, s.plan_name, '') as plan_name, coalesce(s.net_amount, 0) as liquido
    from public.kiwify_sales_snapshot s
    join public.kiwify_products p on p.id = s.product_id
    join public.tools t on t.id = p.tool_id
    left join public.kiwify_plans kp on kp.plan_id = s.plan_id
   where s.customer_email is not null and btrim(s.customer_email) <> '' and s.sale_created_at is not null
     and (t.revenue_start is null or s.sale_created_at >= t.revenue_start::timestamptz);
  create index on _v (tool, email, status, ts);
  analyze _v;

  -- delete (e não truncate): quem abre a tela durante a atualização continua lendo a versão anterior, sem esperar lock.
  delete from public.rm_charges; delete from public.rm_spells; delete from public.rm_cspells;
  delete from public.rm_segs; delete from public.rm_renov;

  insert into public.rm_charges (tool, email, sale_id, ts, cobre_ate, months, plano, liquido, comissao, n)
  select v.tool, v.email, v.id, v.ts, v.ts + make_interval(months => v.months), v.months, public.rm_plan_type(v.months), v.liquido,
         coalesce(a.commission, 0), row_number() over (partition by v.tool, v.email order by v.ts, v.id)
    from _v v left join public.affiliate_sales a on a.id = v.id
   where v.status in ('paid', 'approved') and v.liquido >= 5 and v.plan_name !~* 'teste';

  -- Combo vitalício pago (qualquer plataforma), por ferramenta do combo. Mesma regra de lifetime_grants().
  create temp table _vit on commit drop as
  with comp as (
    select c.bundle_id, c.component as tool from public.bundle_components c
      join public.tools t on t.slug = c.component join public.product_bundles b on b.id = c.bundle_id and b.lifetime
  ), combo as (
    select bp.bundle_id, lower(btrim(k.customer_email)) as email, k.sale_created_at as ts
      from public.bundle_products bp join public.kiwify_sales_snapshot k on k.product_id = bp.product_id
     where bp.platform = 'kiwify' and k.status in ('paid', 'approved')
    union all
    select bp.bundle_id, lower(btrim(o.customer_email)), o.created_at
      from public.bundle_products bp join public.tmb_orders o on o.product_id::text = bp.product_id
     where bp.platform = 'tmb' and o.status = 'Efetivado'
    union all
    select bp.bundle_id, lower(btrim(h.buyer_email)), h.order_date
      from public.bundle_products bp join public.hotmart_sales h on h.product_id::text = bp.product_id
     where bp.platform = 'hotmart' and h.commission_as in ('PRODUCER', 'COPRODUCER') and h.status in ('APPROVED', 'COMPLETE')
  )
  select cp.tool, c.email, min(c.ts) as desde
    from combo c join comp cp on cp.bundle_id = c.bundle_id
   where c.email is not null and c.email <> '' and c.ts is not null
   group by 1, 2;
  create index on _vit (tool, email);
  analyze _vit;
  analyze public.rm_charges;

  -- Períodos por ferramenta: junta intervalos com folga de 20 dias.
  create temp table _sp on commit drop as
  with iv as (
    select tool, email, ts as s, cobre_ate as e, false as vit from public.rm_charges
    union all select tool, email, desde, 'infinity'::timestamptz, true from _vit
  ), o as (
    select iv.*, max(e) over (partition by tool, email order by s, e rows between unbounded preceding and 1 preceding) as prev_e from iv
  ), g as (
    select o.*, sum(case when prev_e is null or s > prev_e + interval '20 days' then 1 else 0 end)
             over (partition by tool, email order by s, e rows unbounded preceding) as grp from o
  )
  select tool, email, min(s) as inicio, max(e) as fim, bool_or(vit) as vitalicio from g group by tool, email, grp;
  analyze _sp;

  insert into public.rm_spells (tool, email, inicio, fim, vitalicio, plano_fim, encerrado, motivo)
  select sp.tool, sp.email, sp.inicio, sp.fim, sp.vitalicio,
         case when sp.vitalicio then 'vitalicio' else (
           select c.plano from public.rm_charges c where c.tool = sp.tool and c.email = sp.email
              and c.ts >= sp.inicio and c.ts < sp.fim order by c.cobre_ate desc, c.ts desc limit 1) end,
         (not sp.vitalicio and sp.fim + interval '20 days' <= v_now),
         case when sp.vitalicio or sp.fim + interval '20 days' > v_now then null
              when exists (select 1 from _v x where x.tool = sp.tool and x.email = sp.email and x.status in ('refunded', 'chargedback')
                              and x.ts between sp.fim - interval '45 days' and sp.fim + interval '20 days') then 'voluntario'
              when exists (select 1 from _v x where x.tool = sp.tool and x.email = sp.email and x.status in ('refused', 'waiting_payment')
                              and x.ts between sp.fim - interval '10 days' and sp.fim + interval '20 days') then 'involuntario'
              else 'nao_identificado' end
    from _sp sp;
  analyze public.rm_spells;

  -- Por cliente: junta os períodos das ferramentas (folga de 20 dias entre uma e outra).
  insert into public.rm_cspells (email, inicio, fim, vitalicio, plano_fim, tool_fim, encerrado, motivo)
  with o as (
    select s.*, max(fim) over (partition by email order by inicio, fim rows between unbounded preceding and 1 preceding) as prev_e from public.rm_spells s
  ), g as (
    select o.*, sum(case when prev_e is null or inicio > prev_e + interval '20 days' then 1 else 0 end)
             over (partition by email order by inicio, fim rows unbounded preceding) as grp from o
  ), agg as (
    select email, grp, min(inicio) as inicio, max(fim) as fim, bool_or(vitalicio) as vitalicio,
           -- o período da ferramenta que acabou por último define plano e motivo
           (array_agg(plano_fim order by fim desc, case motivo when 'voluntario' then 1 when 'involuntario' then 2 else 3 end))[1] as plano_fim,
           (array_agg(tool order by fim desc, case motivo when 'voluntario' then 1 when 'involuntario' then 2 else 3 end))[1] as tool_fim,
           (array_agg(motivo order by fim desc, case motivo when 'voluntario' then 1 when 'involuntario' then 2 else 3 end))[1] as motivo
      from g group by email, grp
  )
  select email, inicio, fim, vitalicio, plano_fim, tool_fim,
         (not vitalicio and fim + interval '20 days' <= v_now), case when not vitalicio and fim + interval '20 days' <= v_now then motivo end
    from agg;

  -- Trechos com o plano em vigor: cada cobrança vale até a próxima cobrança (ou o fim do período, ou a entrada no
  -- vitalício); o vitalício vale dali em diante.
  insert into public.rm_segs (tool, email, s, e, plano, mrr)
  with c as (
    select c.tool, c.email, c.ts, c.cobre_ate, c.plano, c.liquido / c.months as mrr, sp.fim,
           lead(c.ts) over (partition by c.tool, c.email, sp.inicio order by c.ts, c.sale_id) as prox,
           (select v.desde from _vit v where v.tool = c.tool and v.email = c.email) as vit
      from public.rm_charges c
      join public.rm_spells sp on sp.tool = c.tool and sp.email = c.email and c.ts >= sp.inicio and c.ts < sp.fim
  ), x as (
    select tool, email, ts as s,
           least(coalesce(prox, case when fim = 'infinity' then cobre_ate else fim end), coalesce(vit, 'infinity')) as e, plano, mrr
      from c
  )
  select tool, email, s, e, plano, mrr from x where e > s
  union all
  select tool, email, desde, 'infinity', 'vitalicio', 0 from _vit;
  analyze public.rm_segs;
  analyze public.rm_cspells;

  -- Renovação: cada cobrança vencida há mais de 20 dias. Renovou = nova cobrança paga da mesma ferramenta entre 45 dias
  -- antes e 20 dias depois do vencimento (depois disso é nova assinatura). Fora: a cobrança substituída por outra antes
  -- da janela (compra repetida/upgrade) e quem entrou no vitalício antes de vencer (não tinha o que renovar).
  insert into public.rm_renov (tool, email, vence, plano, renovou)
  select c.tool, c.email, c.cobre_ate, public.rm_plan_group(c.plano),
         exists (select 1 from public.rm_charges r where r.tool = c.tool and r.email = c.email
                    and r.ts > greatest(c.ts, c.cobre_ate - interval '45 days') and r.ts <= c.cobre_ate + interval '20 days')
    from public.rm_charges c
   where c.cobre_ate + interval '20 days' <= v_now
     and not exists (select 1 from public.rm_charges r where r.tool = c.tool and r.email = c.email
                        and r.ts > c.ts and r.ts <= c.cobre_ate - interval '45 days')
     and not exists (select 1 from _vit v where v.tool = c.tool and v.email = c.email and v.desde <= c.cobre_ate + interval '20 days');
  analyze public.rm_renov;

  -- Histórico mês a mês, um por filtro de plano.
  insert into public.rm_cache (plano, payload, gerado_em)
  select p, public.rm_build(p), v_now from unnest(array['todos', 'mensal', 'semestral', 'anual', 'vitalicio']) p
  on conflict (plano) do update set payload = excluded.payload, gerado_em = excluded.gerado_em;

  res := jsonb_build_object('cobrancas', (select count(*) from public.rm_charges), 'periodos', (select count(*) from public.rm_spells),
                            'clientes', (select count(*) from public.rm_cspells), 'trechos', (select count(*) from public.rm_segs),
                            'renovacoes', (select count(*) from public.rm_renov));
  insert into public.rm_meta (id, atualizado_em, duracao_ms, linhas)
  values (1, v_now, (extract(epoch from clock_timestamp() - t0) * 1000)::int, res)
  on conflict (id) do update set atualizado_em = excluded.atualizado_em, duracao_ms = excluded.duracao_ms, linhas = excluded.linhas;
  return res || jsonb_build_object('atualizado_em', v_now);
end $$;
-- Só o cron (postgres) roda: leva alguns segundos e passaria do limite de 8 s de quem está logado.
revoke all on function public.rm_refresh() from public, anon, authenticated;
