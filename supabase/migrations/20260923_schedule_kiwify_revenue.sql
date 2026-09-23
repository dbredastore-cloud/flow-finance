-- Recalcula a receita do financeiro a partir da Kiwify a cada 30 minutos.
select cron.unschedule('kiwify-revenue') where exists (select 1 from cron.job where jobname = 'kiwify-revenue');
select cron.schedule(
  'kiwify-revenue',
  '12,42 * * * *',
  $$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/kiwify-revenue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZ21ub2djcHhldWp0c3Jyb3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MDAxNjgsImV4cCI6MjEwNTA3NjE2OH0.Mz7ZAXDupXhkb0x3LhfKq7xyvAhowR2sAGcJ3S9o6KI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kiwify_sync_cron')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
