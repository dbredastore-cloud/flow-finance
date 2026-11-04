-- Retenção e Monetização: renovação anual parcial durante a carência.
--
-- Antes, rm_renov só tinha cobranças vencidas há mais de 20 dias (carência encerrada). Com os anuais do lançamento do
-- Flow Tracking vencendo agora, o card ficava "Ainda sem histórico de renovação anual" mesmo com 100+ renovações pagas.
-- Agora rm_renov guarda também as vencidas que ainda estão na carência (pendente = true):
--   renovou        · já tem nova cobrança paga (conta como renovada, mesmo com a carência aberta)
--   pendente e não renovou · ainda pode renovar: entra no total, mas a tela mostra a taxa como parcial
-- rm_build (renov_mes) e rm_dashboard (renovacao) passam a devolver "pendentes" e, no período, "fecha_em"
-- (quando termina a última carência: a partir daí a taxa é final), além de "fechadas"/"renovadas_fechadas" (só as
-- assinaturas cuja carência já terminou: a taxa final dessas).
-- Mesmo padrão de 20261103_health_all_platforms.sql: troca trechos do corpo das funções já criadas.

alter table public.rm_renov add column if not exists pendente boolean not null default false;

do $$
declare def text;
begin
  -- rm_refresh: inclui as vencidas ainda na carência
  def := pg_get_functiondef('public.rm_refresh()'::regprocedure);
  if position('renovou, pendente)' in def) = 0 then
    if position('insert into public.rm_renov (tool, email, vence, plano, renovou)' in def) = 0
       or position(E'and r.ts <= c.cobre_ate + interval ''20 days'')\n    from public.rm_charges c\n   where c.cobre_ate + interval ''20 days'' <= v_now' in def) = 0 then
      raise exception 'rm_refresh: trecho esperado não encontrado';
    end if;
    def := replace(def, 'insert into public.rm_renov (tool, email, vence, plano, renovou)', 'insert into public.rm_renov (tool, email, vence, plano, renovou, pendente)');
    def := replace(def, E'and r.ts <= c.cobre_ate + interval ''20 days'')\n    from public.rm_charges c\n   where c.cobre_ate + interval ''20 days'' <= v_now',
                        E'and r.ts <= c.cobre_ate + interval ''20 days''),\n         c.cobre_ate + interval ''20 days'' > v_now\n    from public.rm_charges c\n   where c.cobre_ate <= v_now');
    execute def;
  end if;

  -- rm_build: pendentes no histórico mês a mês
  def := pg_get_functiondef('public.rm_build(text)'::regprocedure);
  if position('as pendentes' in def) = 0 then
    def := replace(def, 'count(*) filter (where r.renovou) as renovadas',
                        'count(*) filter (where r.renovou) as renovadas, count(*) filter (where r.pendente and not r.renovou) as pendentes');
    def := replace(def, '''devidas'', devidas, ''renovadas'', renovadas)', '''devidas'', devidas, ''renovadas'', renovadas, ''pendentes'', pendentes)');
    if position('''pendentes'', pendentes' in def) = 0 then raise exception 'rm_build: trecho esperado não encontrado'; end if;
    execute def;
  end if;

  -- rm_dashboard: pendentes e fim da última carência no período
  def := pg_get_functiondef('public.rm_dashboard(date, date, text)'::regprocedure);
  if position('as pendentes' in def) = 0 then
    def := replace(def, 'count(*) filter (where r.renovou) as renovadas',
                        'count(*) filter (where r.renovou) as renovadas, count(*) filter (where r.pendente and not r.renovou) as pendentes, '
                        || 'max(r.vence + interval ''20 days'') filter (where r.pendente and not r.renovou) as fecha_em, '
                        || 'count(*) filter (where not r.pendente) as fechadas, count(*) filter (where not r.pendente and r.renovou) as renovadas_fechadas');
    def := replace(def, '''devidas'', r.devidas, ''renovadas'', r.renovadas)',
                        '''devidas'', r.devidas, ''renovadas'', r.renovadas, ''pendentes'', r.pendentes, ''fecha_em'', r.fecha_em, '
                        || '''fechadas'', r.fechadas, ''renovadas_fechadas'', r.renovadas_fechadas)');
    if position('''fecha_em'', r.fecha_em' in def) = 0 then raise exception 'rm_dashboard: trecho esperado não encontrado'; end if;
    execute def;
  end if;
end $$;

select public.rm_refresh();
