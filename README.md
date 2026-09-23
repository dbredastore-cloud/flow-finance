# flow-finance

Painéis internos em `gestorflowtools.shop` (GitHub Pages + Supabase).

| Página | O que é |
|---|---|
| `/financeiro/` | Receita, despesas e margem por ferramenta |
| `/afiliados/` | Vendas, faturamento e comissões dos afiliados da Kiwify + base de influencers |

## Afiliados

```
Kiwify API ──(a cada 5 min, pg_cron)──▶ Edge Function kiwify-sync ──▶ tabelas Supabase ──▶ /afiliados/
```

- `supabase/functions/kiwify-sync/` – busca `/affiliates` e `/sales` (com `view_full_sale_details`) e grava só as vendas que têm `affiliate_commission`. Na primeira vez importa 3 anos de histórico em partes (~110 s por execução); depois busca só o que mudou nos últimos 89 dias (aprovações, reembolsos, chargebacks).
- `supabase/migrations/` – tabelas `affiliates`, `affiliate_sales`, `kiwify_products`, `sync_state`, a view `affiliate_sales_v` e o agendamento.
- WhatsApp, Instagram, Facebook, YouTube, TikTok e notas são preenchidos à mão no painel; o sync nunca sobrescreve esses campos.
- O painel agrupa tudo por produto, com o nome cadastrado na Kiwify (todos os produtos da conta, não só as ferramentas Flow).

### Configuração (uma vez)

Supabase → Project Settings → Edge Functions → Secrets:

- `KIWIFY_CLIENT_ID`
- `KIWIFY_CLIENT_SECRET`
- `KIWIFY_ACCOUNT_ID`

(Kiwify → Apps → API.) Depois clique em **Sincronizar agora** no painel ou espere o próximo ciclo de 5 min.

### Deploy

- Páginas: push na `main` → GitHub Pages publica sozinho.
- Edge Function / banco: aplicados direto no projeto Supabase `jagmnogcpxeujtsrrotd`; os arquivos aqui são a fonte da verdade.

## YouTube

- Menu **YouTube** em `/afiliados/`: só entram influencers com o link do canal cadastrado na ficha.
- `supabase/functions/youtube-sync/` lê o canal (inscritos, views, nº de vídeos) e os últimos 100 envios, marcando quais são Shorts (confirmado pela URL /shorts/ID) pela YouTube Data API; roda a cada 6 h (`20260922_schedule_youtube_sync.sql`) ou pelo botão **Atualizar YouTube**.
- Secret necessário: `YOUTUBE_API_KEY` (Supabase → Edge Functions → Secrets).

## Receita automática no financeiro

- `supabase/functions/kiwify-revenue/` calcula, por produto e mês (horário de Brasília), a partir das vendas da Kiwify, e grava em `kiwify_monthly_product`; a função SQL `refresh_revenue_from_kiwify()` soma por ferramenta e preenche `monthly_revenue` (`source = 'kiwify'`). Roda a cada 30 min e sempre recalcula os últimos 3 meses (reembolsos mudam meses recentes).
- Regras: faturamento = valor líquido das vendas pagas; reembolsos = vendas do mês com status reembolsado; novos usuários = vendas pagas no mês; usuários totais = acumulado dos novos desde `tools.revenue_start`.
- Os valores lançados à mão antes da automação estão em `monthly_revenue_manual_backup`.
- Ferramentas sem produto da Kiwify ligado (ex.: Flow Subscriptions) continuam com receita manual.
- Avisos: o `kiwify-revenue` guarda cada venda em `kiwify_sales_snapshot` e relê meses fechados (os 3 últimos a cada 30 min, os demais 1x por dia). Se uma venda de um mês fechado muda de status/valor, grava em `revenue_alerts` (antes/depois + vendas afetadas) e o `/financeiro/` mostra o aviso no topo, com "marcar como visto".

## Segurança

- **Dados**: RLS em todas as tabelas exige `public.is_admin()` (usuário em `app_admins`). Visitante sem login (anon) não tem permissão em nenhuma tabela; conta logada fora de `app_admins` não enxerga nada. Para dar acesso a outra pessoa: `insert into app_admins (user_id, email) select id, email from auth.users where email = '...'`.
- **Login**: as páginas entram pela Edge Function `auth-login` (`assets/secure-login.js`), que grava cada tentativa em `login_attempts` (e-mail, IP, dispositivo — nunca a senha), bloqueia IP após 5 erros em 15 min (`login_gate`, atômico) e avisa no Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). O painel financeiro mostra as tentativas falhas.
- **Sincronizadores**: só o cron (segredo no Vault) ou um administrador logado disparam `kiwify-sync`, `kiwify-revenue` e `youtube-sync`.
- **Indexação**: `robots.txt` + `noindex` em todas as páginas.
- A anon key nas páginas é pública por design; sozinha ela não lê nada.
