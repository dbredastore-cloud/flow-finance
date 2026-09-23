-- Registra a tentativa e conta os erros recentes numa operação atômica (trava por IP e
-- por e-mail), para que rajadas de tentativas em paralelo não escapem do bloqueio.
create or replace function public.login_gate(p_ip text, p_email text, p_ua text, p_country text, p_window_min int)
returns table (attempt_id bigint, ip_fails int, email_fails int)
language plpgsql security definer set search_path = '' as $$
declare since timestamptz := now() - make_interval(mins => p_window_min);
begin
  perform pg_advisory_xact_lock(hashtext('login-ip:' || coalesce(p_ip, '')));
  perform pg_advisory_xact_lock(hashtext('login-email:' || coalesce(p_email, '')));
  select count(*) into ip_fails from public.login_attempts
    where ip = p_ip and not success and created_at >= since;
  select count(*) into email_fails from public.login_attempts
    where email = p_email and not success and created_at >= since;
  insert into public.login_attempts (email, ip, country, user_agent, success, reason)
    values (p_email, p_ip, p_country, p_ua, false, 'verificando')
    returning id into attempt_id;
  return next;
end $$;
revoke all on function public.login_gate(text, text, text, text, int) from public, anon, authenticated;
grant execute on function public.login_gate(text, text, text, text, int) to service_role;
