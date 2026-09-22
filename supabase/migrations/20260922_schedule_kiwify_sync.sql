-- Roda a Edge Function kiwify-sync a cada 15 minutos.
-- O Authorization usa a anon key (pública, já presente nas páginas); quem autoriza
-- de fato é o x-cron-secret guardado no Vault.
select cron.unschedule('kiwify-sync') where exists (select 1 from cron.job where jobname = 'kiwify-sync');
select cron.schedule(
  'kiwify-sync',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/kiwify-sync',
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
