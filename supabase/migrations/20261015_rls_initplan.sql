-- Velocidade: as policies chamavam is_admin()/can()/is_owner() uma vez POR LINHA. Envolvendo a chamada em
-- (select …) o Postgres calcula a permissão uma vez por consulta (initPlan). Medido como usuário logado:
-- affiliates_relevant 611 ms → 14 ms, affiliate_sales 136 ms → 3 ms, flow_health 1,98 s → 0,47 s,
-- health_summary 585 ms → 235 ms. Regra para policies novas: escrever sempre using ((select public.can(…))).
do $$ declare p record; begin
  for p in select tablename, policyname, qual, with_check from pg_policies
           where schemaname = 'public'
             and (coalesce(qual, '') ~ '(can|is_admin|is_owner)\(' or coalesce(with_check, '') ~ '(can|is_admin|is_owner)\(') loop
    if p.qual is not null and p.qual !~ '^\(\s*SELECT' then
      execute format('alter policy %I on public.%I using ((select %s))', p.policyname, p.tablename, p.qual);
    end if;
    if p.with_check is not null and p.with_check !~ '^\(\s*SELECT' then
      execute format('alter policy %I on public.%I with check ((select %s))', p.policyname, p.tablename, p.with_check);
    end if;
  end loop;
end $$;
