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

## Canais favoritos (menu do /afiliados/)

- Acompanhar de perto youtubers que receberam acesso às ferramentas Flow. A estrela ☆ no **YouTube** (ao lado do nome do canal) e no **Rastrear Mercado** (tabela, painel lateral e tela expandida) favorita o canal; também dá para colar o link, @usuario ou ID no topo do menu.
- Cada canal tem a **data em que a Flow liberou o acesso**. A partir dela o card conta os vídeos publicados e quantos citam FlowPages, FlowTracking ou FlowSpy no título ou na descrição (por ferramenta), mostra se o canal já citava a Flow antes do acesso, o crescimento de inscritos, o último vídeo e um campo de observações. Filtros: divulgaram / ainda não divulgaram / sem data de acesso.
- **Abrir painel do canal** usa o dashboard do influencer (`assets/influencer-dash.js`, `openCtx`) com a janela começando na data de acesso: métricas dia a dia, views de cada vídeo, menções à Flow com o trecho, tabela de todos os vídeos e CSV.
- Coleta: `youtube-sync` lê os favoritos a cada 6 h (junto dos influencers) e, ao favoritar, busca 12 meses de vídeos (`fav_add` / `fav_sync`); cerca de 3 a 5 unidades da cota do YouTube por canal por rodada. Vídeos e fotos diárias ficam em `youtube_videos` e `youtube_channel_snapshots`.
- Banco: `yt_favorites`, visão `yt_favorites_summary` e função `flow_tool_hits` (migration `20261016_yt_favorites.sql`). Menu de acesso `af.favoritos` (tela Equipe); a estrela só aparece para quem tem esse menu.

## Influencers Flow (menu do /afiliados/)

- Influencers contratados: a estrela ☆ ao lado do nome (menu Afiliados ou ficha) cria o contrato em `influencer_contracts` (padrão: fixo, 30% de comissão, bônus de R$ 3.000 ao bater 150 vendas, 12 stories + 1 reels + 1 vídeo no YouTube por mês) e abre os termos para editar. Tirar a estrela só desativa; o histórico fica.
- Cada contrato mostra as vendas das ferramentas Flow (produtos com `tool_id`) dentro do período do contrato, o progresso até o bônus (e a data da venda que bateu a meta) e o fechamento mês a mês: vendas, faturamento, comissão paga (e o % pago, em amarelo se diferente do combinado), fixo, bônus, custo total e conteúdos.
- Stories e reels são marcados à mão (`influencer_deliverables`). YouTube: conta sozinho os vídeos (não Shorts) com "Flow" no título publicados no mês no canal cadastrado; o número pode ser corrigido à mão.
- Migration: `20260924_influencers_flow.sql`.

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

## Flow Health (menu do /financeiro/)

- Função SQL `flow_health(ano)` calcula, venda a venda (`kiwify_sales_snapshot` + plano de cada venda em `kiwify_plans`): clientes ativos/em carência/cancelados, taxa de renovação (geral, mensal, anual), LTV histórico e projetado (ponderado por duração de plano), MRR/ARR, CAC (comissão de afiliados das 1ªs compras + despesas do grupo Marketing), payback, reembolso, coortes e planos.
- Metas anuais em `flow_goals` (2026: 8.600 novos clientes e R$ 3 milhões), editáveis no painel. "Novo cliente" = primeira compra paga na ferramenta; há opção de contar renovações como no financeiro.
- A duração de cada plano é deduzida do nome (Mensal=1, Trimestral=3, Semestral=6, resto=12) e pode ser corrigida na tabela "Planos".

## Cards Trello (menu do /financeiro/)

- Mostra os cards das listas **Testes do cliente** e **Em produção** dos boards do Trello das ferramentas Flow, com a **data de entrega** do card (atrasado / hoje / em N dias). Card sem data mostra quando entrou na lista.
- Para cada card, o Claude classifica o tipo de atualização (nova funcionalidade, melhoria, correção…) e escreve três textos, com botão **Copiar**:
  1. **Para mim** — o que é (contexto de antes e depois), como funciona, o que beneficia e para quem;
  2. **Slack da TB** — comunicado executivo, sem emojis: título, contexto, *O que muda*, *Impacto* e *Próximos passos*;
  3. **Instagram** — ganchos, roteiro de reels, sequência de stories, carrossel e outros formatos, com legendas e CTA.
- **Lido / Pendente**: cada card tem o botão **Marcar como lido** (`read_at`, gravado pela função `trello_set_read`, só admin). O filtro abre em **Pendentes**; o card lido vai para **Lidos** e pode voltar. O sync nunca mexe nisso.
- **Imagens**: os anexos de imagem do card ficam em `trello_cards.images` e abrem numa galeria. Como o Trello só entrega anexos com a chave da API, a imagem vem pela função (`action: "image"`).
- `supabase/functions/trello-cards/`: `sync` lê os boards (listas reconhecidas pelo nome, sem acento/maiúscula) e grava em `trello_cards`; `generate` gera os textos de um card; `image` devolve um anexo. Card que sai dessas listas some da tela (fica `active = false`). Se o card mudar no Trello, o painel avisa para refazer os textos. Migrations: `20261014_trello_cards.sql` e `20261015_trello_cards_read_images.sql`.
- O Trello é lido a cada 30 min (`20261014_trello_cards.sql`) ou pelo botão **Atualizar do Trello**.
- Textos, sem custo: a tarefa agendada **Textos dos Cards Trello** do app Claude (seg a sex, 8h, com o app aberto) lê os cards sem texto pelo conector do Supabase, escreve os textos e grava direto em `trello_cards.ai`. O painel mostra "Textos a caminho" até lá.
- Textos pela API (opcional, pago): com o secret `ANTHROPIC_API_KEY`, a função gera com `claude-opus-5-5` — 3 cards novos a cada 30 min, e o painel ganha os botões **Gerar textos**, **Refazer** e **Gerar textos pendentes**.
- Secrets (Supabase → Edge Functions → Secrets):
  - `TRELLO_KEY` e `TRELLO_TOKEN` (trello.com/power-ups/admin → Autenticação do Trello → chave de API → link "token");
  - `TRELLO_BOARD_IDS` (opcional, ids separados por vírgula; sem ele entram os boards abertos com "Flow" no nome);
  - `ANTHROPIC_API_KEY` (opcional, ver acima).

## Portal do Afiliado (/parceiro/)

- O afiliado (influencer) entra com login próprio e vê **só os dados dele**: vendas por período (aprovadas, pendentes, recusadas, reembolsos e chargebacks), cliente de cada venda com e-mail e WhatsApp (botão com mensagem pronta para recuperar a venda), comissão e %, vendas por dia, por produto, CSV, o contrato do Influencers Flow (termos, meta do bônus e fechamento mês a mês) e o canal do YouTube (com o painel completo do canal, só leitura).
- **Criar o acesso:** tela Equipe → *Portal do afiliado*. Vincula pelo e-mail de cadastro na Kiwify ou pelo CNPJ/CPF, gera a senha provisória e envia o e-mail com o link para o afiliado definir a senha. Na lista: ver o portal como ele vê, reenviar o acesso, redefinir senha, pausar/reativar, excluir e ligar/desligar os contatos dos clientes.
- **Segurança:** o afiliado não entra em `app_admins`, então todas as tabelas continuam fechadas para ele. Ele só lê pelas funções `portal_me`, `portal_sales`, `portal_contract` e `portal_youtube` (security definer), que descobrem o afiliado pelo login (`partner_users`) e ignoram qualquer e-mail vindo do navegador. A equipe com o menu Afiliados ou Influencers Flow pode abrir `/parceiro/?ver=<e-mail>` para ver como o afiliado vê. O líquido do produtor e as observações internas do contrato não saem para o portal. Login pela mesma função `auth-login` (bloqueio por força bruta, aviso no Telegram) e recuperação de senha pela `auth-mail`.
- **WhatsApp do cliente:** `affiliate_sales.customer_phone`, gravado pelo `kiwify-sync` a partir de `customer.mobile`. As vendas antigas são relidas uma vez, no tempo que sobra de cada sincronização (`sync_state.phone_backfill`). Também aparece na ficha do afiliado (menu Afiliados), com o e-mail do cliente.
- **Clientes agrupados:** a tabela de vendas mostra uma linha por cliente (pelo e-mail), com o resumo dos eventos; clicar abre todos os eventos dele (tentativas, pagamentos, reembolsos, chargebacks). **Recusadas sem compra** e **Pendentes sem pagamento** só trazem quem NÃO comprou depois a mesma ferramenta, por nenhum canal (com o afiliado, com outro afiliado ou direto: o banco confere em `affiliate_sales` e `kiwify_sales_snapshot` e devolve só a data, sem dizer de quem foi a compra). **Recuperados** = teve recusa ou pendência e comprou depois. Migration `20261017_portal_clients.sql`.
- **Acompanhamento de cada cliente:** o afiliado marca o cliente como **Feito** ou **Pendente** e anota o que foi tratado (filtro Todos / A tratar / Feitos; entra no CSV). Vale para o **histórico inteiro do cliente**, em qualquer período (tabela `partner_client_followups`, chave = e-mail do cliente). Grava só pela função `portal_set_client_followup`, que confere se o cliente comprou ou tentou comprar com aquele afiliado; a equipe vê em "Ver portal", só leitura. Migrations `20261016_partner_followups.sql` e `20261017_partner_client_followups.sql` (as anotações por venda foram migradas para o cliente).
- Migration: `20261016_partner_portal.sql`.

## Acesso por menu (tela Equipe)

- Cada pessoa em `app_admins` tem um perfil: **Admin** (`role = 'admin'`, vê todos os menus e gerencia a Equipe) ou **Acesso personalizado** (`role = 'custom'`, vê só os menus em `menus`). Quem já tinha acesso antes desta mudança ficou como Admin.
- Menus: Financeiro → `fin.financeiro` (Home e ferramentas), `fin.health`, `fin.clients`, `fin.hours`, `fin.trello`; Afiliados → `af.overview`, `af.base`, `af.flowinf`, `af.products`, `af.youtube`, `af.mercado`. A lista fica em `assets/flow-access.js`, na Edge Function `team-admin` e na migration `20261015_menu_access.sql`; menu novo precisa entrar nos três.
- Proteção nos dados, não só na tela: as policies de cada tabela usam `public.can(array[...menus])`, então quem só tem Cards Trello não lê despesas nem pela API. `is_owner()` = perfil admin (tentativas de login, tela Equipe); `my_access()` devolve o perfil de quem está logado.
- No painel, os itens do menu têm `data-menu`, os links entre painéis `data-page` e o link da Equipe `data-admin-only`; quem não tem nenhum menu de um painel é levado ao primeiro que pode ver.
- Gerenciar: tela Equipe → **Editar acesso** (ou o seletor ao adicionar pessoa). Precisa sobrar sempre pelo menos um Admin.

## Instagram (menu do /financeiro/)

- Painel de pautas a partir das entregas do Trello, só com o que **não é bug** (coluna gerada `trello_cards.is_bug`: etiqueta "Bug", tipo "Correção de bug" ou nome começando com "[Bug]").
- Para cada card: o que foi feito, ângulo, formato ideal, ganchos, roteiro de Reels cena a cena (tempo, imagem, fala, texto na tela), carrossel slide a slide, sequência de stories, legenda, hashtags e dica de gravação (coluna `ig`), além dos textos Para mim e Slack dos Cards Trello. Tudo com botão Copiar.
- Marcações compartilhadas pela equipe, que ligam e desligam: **Lido**, **Interessante** e **Conteúdo feito** (marcar Conteúdo feito também marca Lido). Gravadas pela função `trello_ig_flag`, com quem marcou e quando. Filtros por situação, ferramenta, tipo e formato ideal.
- O conteúdo é escrito pelo Claude (sem API paga): a tarefa agendada "Textos dos Cards Trello" escreve `ai` e depois `ig` dos cards novos. Enquanto `ig` não existe, o painel mostra as ideias básicas de `ai.instagram`.
- Acesso: menu `fin.instagram` na tela Equipe. Migration `20261015_trello_instagram.sql`.

## Velocidade

- **Policies (RLS)**: sempre `using ((select public.can(array[...])))`, com o `select` em volta. Sem ele o Postgres chama a função para cada linha (afiliados levava 0,6 s a 4 s; com ele, 14 ms). Migration `20261015_rls_initplan.sql`.
- **Cards Trello** lê a visão `trello_cards_list` (só as colunas da tela, ~0,77 MB em vez de 1,86 MB).
- **Cache da aba** (sessionStorage): Financeiro, Cards Trello e Instagram mostram na hora o que já tinham e atualizam por trás; o perfil de acesso (`flow_access_v1`) também fica guardado e é conferido por trás (se mudou, a página recarrega).
