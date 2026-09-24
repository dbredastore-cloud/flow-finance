-- % de comissão cadastrada na Kiwify por produto (ex.: {"Flow Pages": 30, "Flow Spy": 20}).
-- A Kiwify guarda em centésimos de ponto (3000 = 30%). Vai na view leve do painel para não
-- precisar baixar a lista completa de produtos de cada afiliado.
create or replace view public.affiliates_relevant
with (security_invoker = true) as
select id, email, name, document, company_name, company_cnpj, director_cpf, kiwify_status,
       whatsapp, instagram, facebook, youtube, tiktok, notes,
       (select jsonb_object_agg(p->>'name', round((p->>'commission')::numeric / 100, 2))
          from jsonb_array_elements(a.products) p
          where p->>'name' is not null and p->>'commission' ~ '^[0-9.]+$') as commissions
from public.affiliates a
where exists (select 1 from public.affiliate_sales s where s.affiliate_email = a.email)
   or coalesce(a.whatsapp, a.instagram, a.facebook, a.youtube, a.tiktok, a.notes) is not null;
