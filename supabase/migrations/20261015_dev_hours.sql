-- Controle de horas de desenvolvimento (planilha "controle-horas-flow", da Biancode).
-- A Edge Function hours-sync lê a planilha e guarda uma foto dela aqui (uma linha só, id = 1);
-- o painel (menu "Horas de desenvolvimento") só lê. Só administradores enxergam.
create table if not exists public.dev_hours_snapshot (
  id           integer primary key default 1 check (id = 1),
  sheet_id     text,
  sheet_title  text,
  data         jsonb not null default '{}'::jsonb,   -- { contract: [...], sprints: [...], deliveries: [...], projects: [...] }
  source       text not null default 'sheet',        -- 'sheet' (leitura automática) ou 'manual' (carga inicial)
  synced_at    timestamptz not null default now()
);
alter table public.dev_hours_snapshot enable row level security;
create policy admin_read on public.dev_hours_snapshot for select to authenticated using (public.is_admin());
revoke all on public.dev_hours_snapshot from anon;

-- Atualiza a foto da planilha de 30 em 30 minutos.
select cron.unschedule('hours-sync') where exists (select 1 from cron.job where jobname = 'hours-sync');
select cron.schedule(
  'hours-sync',
  '7,37 * * * *',
  $$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/hours-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
