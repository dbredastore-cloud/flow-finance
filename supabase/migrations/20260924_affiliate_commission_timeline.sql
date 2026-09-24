-- Linha do tempo do % de comissão de cada afiliado em cada produto.
--
-- % de cada venda = comissão ÷ (líquido do produtor + comissão), a base sobre a qual a Kiwify
-- aplica o percentual. Vendas seguidas com o mesmo % formam um período; quando o % muda e as
-- vendas seguintes continuam no novo %, começa outro período.
--
-- Venda isolada (o % difere da venda anterior e da seguinte, e essas duas são iguais) não é
-- mudança de acordo — ex.: oferta/plano antigo que ainda paga o % antigo — e fica fora dos
-- períodos (continua visível venda a venda no painel).
create or replace view public.affiliate_commission_timeline
with (security_invoker = true) as
with s as (
  select affiliate_email, product_name, sale_created_at as ts,
         round(100 * commission / nullif(net_amount + commission, 0))::int as pct
  from public.affiliate_sales
  where status in ('paid', 'approved') and commission > 0 and net_amount is not null
),
vizinhos as (
  select *, lag(pct) over w as ant, lead(pct) over w as prox
  from s window w as (partition by affiliate_email, product_name order by ts)
),
sem_isoladas as (
  select affiliate_email, product_name, ts, pct from vizinhos
  where not (ant is not null and prox is not null and pct <> ant and ant = prox)
),
marcado as (
  select *, case when pct is distinct from lag(pct) over w then 1 else 0 end as muda
  from sem_isoladas window w as (partition by affiliate_email, product_name order by ts)
),
grupos as (
  select *, sum(muda) over (partition by affiliate_email, product_name order by ts) as grupo from marcado
)
select affiliate_email, product_name, pct, min(ts) as inicio, max(ts) as fim, count(*) as vendas
from grupos
group by affiliate_email, product_name, grupo, pct;
