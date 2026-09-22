# flow-finance

Painéis internos em `gestorflowtools.shop` (GitHub Pages + Supabase).

| Página | O que é |
|---|---|
| `/financeiro/` | Receita, despesas e margem por ferramenta |
| `/afiliados/` | Vendas, faturamento e comissões dos afiliados da Kiwify + base de influencers |

## Afiliados

```
Kiwify API ──(a cada 15 min, pg_cron)──▶ Edge Function kiwify-sync ──▶ tabelas Supabase ──▶ /afiliados/
```

- `supabase/functions/kiwify-sync/` – busca `/affiliates` e `/sales` (com `view_full_sale_details`) e grava só as vendas que têm `affiliate_commission`. Na primeira vez importa 3 anos de histórico em partes (~110 s por execução); depois busca só o que mudou nos últimos 89 dias (aprovações, reembolsos, chargebacks).
- `supabase/migrations/` – tabelas `affiliates`, `affiliate_sales`, `kiwify_products`, `sync_state`, a view `affiliate_sales_v` e o agendamento.
- WhatsApp, Instagram, Facebook, YouTube, TikTok e notas são preenchidos à mão no painel; o sync nunca sobrescreve esses campos.
- Produtos são ligados às ferramentas pelo nome; corrija na aba **Produtos** se algum ficar sem ferramenta.

### Configuração (uma vez)

Supabase → Project Settings → Edge Functions → Secrets:

- `KIWIFY_CLIENT_ID`
- `KIWIFY_CLIENT_SECRET`
- `KIWIFY_ACCOUNT_ID`

(Kiwify → Apps → API.) Depois clique em **Sincronizar agora** no painel ou espere o próximo ciclo de 15 min.

### Deploy

- Páginas: push na `main` → GitHub Pages publica sozinho.
- Edge Function / banco: aplicados direto no projeto Supabase `jagmnogcpxeujtsrrotd`; os arquivos aqui são a fonte da verdade.
