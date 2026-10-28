-- Saúde dos clientes: quantos clientes usam 1, 2 ou 3 softwares Flow (por cliente, não por software).
--
-- public.health_mix() conta clientes únicos (e-mail) da view customer_software:
--   historico  · quantos softwares cada cliente já comprou (1, 2 ou 3) e as combinações mais comuns
--   ativos     · entre quem tem assinatura em dia agora, com quantos softwares ativos ao mesmo tempo
-- security invoker: segue as mesmas regras de leitura da tela (menu fin.clients).

create or replace function public.health_mix() returns jsonb
language sql stable security invoker set search_path = '' as $$
with c as (
  select email,
         count(*) as n,
         count(*) filter (where situacao = 'ativo') as n_ativos,
         string_agg(tool, ' + ' order by tool) as combo,
         string_agg(tool, ' + ' order by tool) filter (where situacao = 'ativo') as combo_ativo
    from public.customer_software group by email
)
select jsonb_build_object(
  'clientes', (select count(*) from c),
  'historico', (select jsonb_object_agg(n, q) from (select n, count(*) q from c group by n) x),
  'ativos', (select jsonb_object_agg(n_ativos, q) from (select n_ativos, count(*) q from c where n_ativos > 0 group by n_ativos) x),
  'clientes_ativos', (select count(*) from c where n_ativos > 0),
  'combos', coalesce((select jsonb_agg(jsonb_build_object('combo', combo, 'n', q, 'softwares', n) order by q desc)
                        from (select combo, n, count(*) q from c where n > 1 group by combo, n) x), '[]'::jsonb),
  'combos_ativos', coalesce((select jsonb_agg(jsonb_build_object('combo', combo_ativo, 'n', q, 'softwares', n_ativos) order by q desc)
                        from (select combo_ativo, n_ativos, count(*) q from c where n_ativos > 1 group by combo_ativo, n_ativos) x), '[]'::jsonb)
);
$$;
revoke all on function public.health_mix() from public, anon;
grant execute on function public.health_mix() to authenticated;
