-- Registro dos e-mails de recuperação de senha enviados pela função auth-mail (limite por e-mail e por IP).
-- Só a função (chave de serviço) lê e grava; nenhum acesso para usuários do painel nem anônimos.
create table if not exists public.auth_mail_log (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  kind        text not null,
  email       text,
  ip          text
);
create index if not exists auth_mail_log_email_idx on public.auth_mail_log (kind, email, created_at desc);
create index if not exists auth_mail_log_ip_idx on public.auth_mail_log (kind, ip, created_at desc);
alter table public.auth_mail_log enable row level security;
revoke all on public.auth_mail_log from anon, authenticated;
