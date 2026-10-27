# Instagram: como conectar a conta da Flow à API da Meta

O painel já tem a leitura do Instagram pronta. Falta só a Meta liberar o acesso. Um único token serve para as duas funções:
- `instagram-sync` (a cada 6 h): dados públicos dos perfis dos influencers;
- `instagram-stories` (de hora em hora): os stories do **@useaflow**, com alcance, visualizações, respostas,
  compartilhamentos, seguidores ganhos, visitas ao perfil e navegação (avançou, voltou, saiu, pulou). A Meta só entrega
  um story nas 24 h em que ele está no ar, então o histórico começa no dia em que o token for cadastrado.
Este guia é da **fase 1** (dados públicos dos perfis profissionais dos influencers). A fase 2 (o influencer conecta o
próprio Instagram no Portal do Afiliado) está no final.

> Nunca cole tokens ou senhas no chat. Eles vão direto nos Secrets do Supabase (passo 7).

## 1. Conta do Instagram da Flow como profissional
No app do Instagram da Flow: **Configurações → Tipo de conta e ferramentas → Mudar para conta profissional → Empresa**.

## 2. Ligar o Instagram a uma Página do Facebook
Na Página do Facebook da Flow (ou crie uma): **Configurações → Contas vinculadas → Instagram → Conectar conta**.

## 3. Portfólio empresarial (Business Manager)
Em **business.facebook.com**, confira se a Página e a conta do Instagram estão no portfólio da empresa
(**Configurações → Contas → Páginas** e **Contas do Instagram**).

## 4. Criar o app da Meta
1. Em **developers.facebook.com**, clique em **Entrar** (canto superior direito) com o Facebook que administra a Página da Flow.
   Na primeira vez aparece **Começar** (Get Started): conclua o cadastro de desenvolvedor (termos + confirmar telefone/e-mail).
2. Clique em **Meus apps** (ou abra direto `developers.facebook.com/apps`) → **Criar app**.
3. Caso de uso: **Outro** (Other) → avançar. Tipo de app: **Empresa** (Business) — só ele aceita o produto Instagram.
4. Nome (ex.: "Flow Painel"), e-mail de contato e, se pedir, o **portfólio empresarial** da Flow.
5. No painel do app, em **Adicionar produtos**, clique em **Configurar** no **Instagram** e use a
   **API com Login do Facebook** (API setup with Facebook Login). Se pedir, adicione também o **Login do Facebook para Empresas**.
6. Em modo de desenvolvimento o app já funciona para a conta da Flow; a política de privacidade e a análise da Meta só
   entram na fase 2.

## 5. Gerar um token que não expira (usuário do sistema)
1. Em **business.facebook.com → Configurações → Usuários → Usuários do sistema → Adicionar** (função Admin).
2. **Atribuir ativos**: a Página da Flow, a conta do Instagram da Flow e o app criado.
3. **Gerar novo token** escolhendo o app e as permissões:
   `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`, `pages_show_list`, `business_management`.
4. Copie o token (ele aparece uma vez só) e guarde para o passo 7.

## 6. Descobrir o ID da conta do Instagram (IG_BUSINESS_ID)
No **Explorador da API do Graph** (developers.facebook.com/tools/explorer), com o token do passo 5, rode:
`me/accounts?fields=name,instagram_business_account`
O número em `instagram_business_account.id` (começa com 1784…) é o `IG_BUSINESS_ID`. Para o @useaflow deve
ser `17841441194954388` (o mesmo id que o Windsor.ai mostra); confira se bate.

## 7. Cadastrar no Supabase
**Supabase → Edge Functions → Secrets → Add new secret**:
- `IG_ACCESS_TOKEN` = token do passo 5
- `IG_BUSINESS_ID` = ID do passo 6

Depois é só avisar: a primeira leitura roda na hora. Os stories do @useaflow passam a ser guardados em
`ig_stories` (uma leitura por hora em `ig_story_snapshots`) e os perfis aparecem no dashboard de cada influencer
(Influencers Flow / YouTube → Abrir dados) e no Portal do Afiliado.

## O que é lido (fase 1)
Só de contas **profissionais** (Comercial ou Criador de conteúdo). Conta pessoal aparece com o aviso
"Perfil não encontrado ou não é conta profissional".
- Perfil: seguidores, seguindo, nº de posts, bio, foto (e a foto diária de seguidores para o crescimento).
- Posts, reels e carrosséis: data, tipo, legenda, link, curtidas, comentários e visualizações.
- Contagem de reels e posts por mês (aparece ao lado das entregas do contrato) e menções à Flow nas legendas.

## Fase 2 — o influencer conecta o próprio Instagram (stories, alcance, salvamentos, público)
No Portal do Afiliado (Seu Instagram) há o botão **Conectar Instagram**: o influencer entra na página oficial do
Instagram e autoriza; **a senha dele nunca passa pelo nosso sistema**. A conta dele precisa ser profissional
(Empresa ou Criador de conteúdo).

- `supabase/functions/ig-connect/` faz o login (API do Instagram com Login do Instagram, permissões
  `instagram_business_basic` e `instagram_business_manage_insights`), guarda o token de 60 dias em
  `instagram_connections` (nenhum login lê essa tabela) e devolve o influencer para `/parceiro/?ig=conectado`.
- `supabase/functions/ig-partners/` roda de hora em hora (cron `ig-partners`, minuto 7): renova o token quando faltam
  menos de 15 dias, lê os stories no ar (`instagram_stories`) e, a cada 6 h, as métricas privadas dos posts e reels
  (`instagram_media`), o resumo diário da conta (`instagram_account_daily`) e o público por cidade, país, idade e
  gênero (`instagram_audience`). Última rodada em `sync_state.ig_partners_last_run`. Migration
  `20261027_ig_partner_connect.sql`.

### Configuração no app da Meta (Flow Painel)
1. Painel do app → **Casos de uso** → **Adicionar caso de uso** → *Gerenciar mensagens e conteúdo no Instagram*
   (API do Instagram) → em **API configuration with Instagram login**, adicionar as permissões
   `instagram_business_basic` e `instagram_business_manage_insights`.
2. Na mesma tela, **Configurar login comercial do Instagram** → *URIs de redirecionamento OAuth*:
   `https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/ig-connect`.
3. Copiar o **ID do app do Instagram** e a **Chave secreta do app do Instagram** (são diferentes do ID do app da Meta)
   e cadastrar no Supabase → Edge Functions → Secrets como `IG_APP_ID` e `IG_APP_SECRET`.

### Testadores (antes da aprovação da Meta)
Enquanto o app não passa pela Análise do app, só contas adicionadas como testadoras conseguem conectar:
1. App → **Funções do app** → **Funções** → **Adicionar pessoas** → **Testador do Instagram** → @ do influencer.
2. O influencer aceita em instagram.com → Configurações → **Apps e sites** → **Convites de testador**
   (no app do celular nem sempre aparece; pelo navegador funciona).
3. Ele entra no Portal do Afiliado e clica em **Conectar Instagram**.

### Para liberar para todos
**Verificação da empresa** (Configurações do portfólio → Central de segurança) e **Análise do app** pedindo acesso
avançado às duas permissões, com página de política de privacidade, instruções de exclusão de dados e um vídeo curto
mostrando o fluxo (Portal → Conectar Instagram → números aparecendo).
