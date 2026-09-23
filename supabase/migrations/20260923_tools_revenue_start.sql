-- Cada ferramenta só entra no financeiro automático a partir do 1º mês que era
-- lançado à mão (antes disso a Kiwify só tinha vendas de teste, ex.: FlowSpy fev/2026).
alter table public.tools add column if not exists revenue_start date;
update public.tools t set revenue_start = b.first_month
from (select tool_id, min(make_date(year, month, 1)) first_month from public.monthly_revenue_manual_backup group by 1) b
where b.tool_id = t.id and t.revenue_start is null;

delete from public.monthly_revenue r using public.tools t
where r.tool_id = t.id and r.source = 'kiwify' and t.revenue_start is not null
  and make_date(r.year, r.month, 1) < t.revenue_start;
