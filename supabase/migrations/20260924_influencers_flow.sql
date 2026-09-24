-- Influencers Flow: influencers contratados, com contrato (fixo + % + bônus por meta de vendas),
-- metas mensais de conteúdo e o registro do que foi entregue em cada mês.

create table if not exists public.influencer_contracts (
  id                    uuid primary key default gen_random_uuid(),
  affiliate_email       text not null unique references public.affiliates(email) on delete cascade,
  active                boolean not null default true,
  start_date            date not null default date_trunc('month', now())::date,
  end_date              date,
  fixed_fee             numeric(12,2) not null default 0,     -- valor fixo por mês
  commission_pct        numeric(5,2) not null default 30,     -- % de comissão combinado
  bonus_sales_target    integer not null default 150,         -- vendas no contrato para o bônus
  bonus_amount          numeric(12,2) not null default 3000,
  stories_per_month     integer not null default 12,
  reels_per_month       integer not null default 1,
  youtube_per_month     integer not null default 1,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists public.influencer_deliverables (
  contract_id     uuid not null references public.influencer_contracts(id) on delete cascade,
  year            integer not null,
  month           integer not null check (month between 1 and 12),
  stories_done    integer not null default 0,
  reels_done      integer not null default 0,
  youtube_done    integer,          -- null = usar o que foi detectado no canal
  links           text,
  notes           text,
  updated_at      timestamptz not null default now(),
  primary key (contract_id, year, month)
);

drop trigger if exists influencer_contracts_touch on public.influencer_contracts;
create trigger influencer_contracts_touch before update on public.influencer_contracts
  for each row execute function public.touch_updated_at();

alter table public.influencer_contracts    enable row level security;
alter table public.influencer_deliverables enable row level security;
do $$
declare t text;
begin
  foreach t in array array['influencer_contracts', 'influencer_deliverables'] loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;
