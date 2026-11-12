-- hotmart_summary estourava o limite de 8 s do papel authenticated (5–17 s medidos em 12/11/2026) e a aba
-- "Saúde dos clientes → Hotmart" mostrava erro. Causas: a lista de clientes Flow (view customer_tools, pesada)
-- era refeita dentro do join, e a tabela de vendas era lida várias vezes com todas as colunas.
-- Agora: lê só as colunas usadas, materializa a lista de clientes Flow uma vez e soma tudo numa passada só.
-- Mesmo formato de saída de antes.
create or replace function public.hotmart_summary(p_products bigint[] default null)
returns jsonb
language sql
stable
set search_path = ''
set work_mem = '64MB'
as $$
with s as materialized (
  select product_id, product_name, commission_as, status, is_subscription, price_value, currency, installments, order_date,
         lower(buyer_email) as email, status in ('APPROVED', 'COMPLETE') as paga
    from public.hotmart_sales
),
p as materialized (select * from s where commission_as in ('PRODUCER', 'COPRODUCER')),
sel as materialized (select * from p where p_products is null or product_id = any(p_products)),
flow as materialized (select distinct email from public.customer_tools),
tot as (
  select count(*) filter (where paga) as vendas,
         count(distinct email) filter (where paga) as alunos,
         count(*) filter (where status in ('REFUNDED', 'PARTIALLY_REFUNDED')) as reembolsos,
         count(*) filter (where status = 'CHARGEBACK') as chargebacks,
         coalesce(sum(price_value) filter (where paga and currency = 'BRL'), 0) as valor_brl,
         round(avg(price_value) filter (where paga and currency = 'BRL'), 2) as ticket_medio,
         round(avg(installments) filter (where paga), 1) as parcelas_media,
         count(*) filter (where paga and currency <> 'BRL') as vendas_outras_moedas,
         count(*) filter (where paga and is_subscription) as assinaturas
    from sel
)
select jsonb_build_object(
  'gerado_em', now(),
  'ultima_leitura', (select max(synced_at) from public.hotmart_sales),
  'primeira_venda', (select min(order_date) from p),
  'vendas', t.vendas,
  'alunos', t.alunos,
  'reembolsos', t.reembolsos,
  'chargebacks', t.chargebacks,
  'valor_brl', t.valor_brl,
  'ticket_medio', t.ticket_medio,
  'parcelas_media', t.parcelas_media,
  'vendas_outras_moedas', t.vendas_outras_moedas,
  'assinaturas', t.assinaturas,
  'tambem_flow', (select count(distinct sel.email) from sel join flow f on f.email = sel.email where sel.paga),
  'afiliado', (select jsonb_build_object('vendas', count(*), 'produtos', count(distinct product_id))
                 from s where commission_as = 'AFFILIATE' and paga),
  'produtos', coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.product_id::text, 'nome', coalesce(hp.name, x.nome), 'ferramentas', coalesce(hp.includes_tools, '{}'),
      'vendas', x.n, 'alunos', x.a, 'valor', x.v, 'reembolsos', x.r, 'ultimo', x.u) order by x.n desc, coalesce(hp.name, x.nome))
    from (select product_id, max(product_name) nome, count(*) filter (where paga) n, count(distinct email) filter (where paga) a,
                 sum(price_value) filter (where paga and currency = 'BRL') v,
                 count(*) filter (where status in ('REFUNDED', 'PARTIALLY_REFUNDED', 'CHARGEBACK')) r, max(order_date) u
            from p group by 1) x
    left join public.hotmart_products hp on hp.id = x.product_id), '[]'::jsonb)
)
from tot t;
$$;

-- Limite de tempo das consultas de quem está logado no painel: 8 s → 15 s.
-- As rotinas de sync (rm_refresh a cada 30 min leva ~25 s; generate_alerts até 25 s) disputam a CPU da instância
-- e, nesses minutos, consultas que normalmente levam 1–3 s passavam dos 8 s e eram canceladas (erro na tela).
-- Visitantes sem login (anon) continuam com 3 s.
alter role authenticated set statement_timeout = '15s';
notify pgrst, 'reload config';
