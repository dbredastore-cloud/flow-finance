-- Afiliados que o painel precisa ao abrir: quem já vendeu ou tem contato preenchido.
-- A base completa (20+ mil, maioria sem venda) só é carregada sob demanda.
create or replace view public.affiliates_relevant
with (security_invoker = true) as
select id, email, name, document, company_name, company_cnpj, director_cpf, kiwify_status,
       whatsapp, instagram, facebook, youtube, tiktok, notes
from public.affiliates a
where exists (select 1 from public.affiliate_sales s where s.affiliate_email = a.email)
   or coalesce(a.whatsapp, a.instagram, a.facebook, a.youtube, a.tiktok, a.notes) is not null;
