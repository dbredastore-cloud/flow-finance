-- Painel de afiliados: base de influencers + vendas com comissão vindas da Kiwify.

-- Produtos da Kiwify ligados às ferramentas (tools). O sync preenche tool_id
-- automaticamente pelo nome; dá para corrigir manualmente no painel.
create table if not exists public.kiwify_products (
  id          text primary key,
  name        text not null,
  tool_id     uuid references public.tools(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Base de afiliados/influencers. Campos "kiwify" vêm do sync; os de contato
-- (whatsapp, redes sociais, notas) são preenchidos à mão e o sync nunca os toca.
create table if not exists public.affiliates (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  name           text,
  document       text,
  company_name   text,
  company_cnpj   text,
  director_cpf   text,
  kiwify_status  text,
  kiwify_ids     jsonb not null default '[]'::jsonb,
  products       jsonb not null default '[]'::jsonb,
  whatsapp       text,
  instagram      text,
  facebook       text,
  youtube        text,
  tiktok         text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Uma linha por venda da Kiwify que teve comissão de afiliado. Valores em R$.
create table if not exists public.affiliate_sales (
  id                  text primary key,
  affiliate_email     text not null,
  affiliate_name      text,
  affiliate_document  text,
  product_id          text,
  product_name        text,
  status              text,
  payment_method      text,
  amount              numeric(12,2),
  net_amount          numeric(12,2),
  commission          numeric(12,2),
  customer_name       text,
  customer_email      text,
  sale_created_at     timestamptz not null,
  approved_at         timestamptz,
  refunded_at         timestamptz,
  kiwify_updated_at   timestamptz,
  raw                 jsonb,
  synced_at           timestamptz not null default now()
);
create index if not exists affiliate_sales_created_idx on public.affiliate_sales (sale_created_at);
create index if not exists affiliate_sales_email_idx on public.affiliate_sales (affiliate_email);

-- Estado do sincronizador (cursor do histórico, última execução, trava).
create table if not exists public.sync_state (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create or replace view public.affiliate_sales_v
with (security_invoker = true) as
select s.*, p.tool_id, t.name as tool_name
from public.affiliate_sales s
left join public.kiwify_products p on p.id = s.product_id
left join public.tools t on t.id = p.tool_id;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists affiliates_touch on public.affiliates;
create trigger affiliates_touch before update on public.affiliates
  for each row execute function public.touch_updated_at();
drop trigger if exists kiwify_products_touch on public.kiwify_products;
create trigger kiwify_products_touch before update on public.kiwify_products
  for each row execute function public.touch_updated_at();

-- RLS: usuários logados leem tudo e editam contatos/mapeamento de produto.
-- Vendas e estado do sync só são gravados pela Edge Function (service role).
alter table public.kiwify_products enable row level security;
alter table public.affiliates      enable row level security;
alter table public.affiliate_sales enable row level security;
alter table public.sync_state      enable row level security;

create policy auth_read_kiwify_products  on public.kiwify_products for select to authenticated using (true);
create policy auth_update_kiwify_products on public.kiwify_products for update to authenticated using (true) with check (true);
create policy auth_read_affiliates       on public.affiliates      for select to authenticated using (true);
create policy auth_update_affiliates     on public.affiliates      for update to authenticated using (true) with check (true);
create policy auth_read_affiliate_sales  on public.affiliate_sales for select to authenticated using (true);
create policy auth_read_sync_state       on public.sync_state      for select to authenticated using (true);

-- Segredo que o agendador (pg_cron) envia para a Edge Function.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'kiwify_sync_cron') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'kiwify_sync_cron');
  end if;
end $$;

create or replace function public.verify_sync_secret(secret text) returns boolean
language sql security definer set search_path = '' as $$
  select exists (
    select 1 from vault.decrypted_secrets ds
    where ds.name = 'kiwify_sync_cron' and ds.decrypted_secret = verify_sync_secret.secret
  );
$$;
revoke all on function public.verify_sync_secret(text) from public, anon, authenticated;
grant execute on function public.verify_sync_secret(text) to service_role;
