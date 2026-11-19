# Tempo assistido do YouTube (YouTube Analytics API)

O `youtube-sync` lê só dados públicos (views, curtidas, comentários). Tempo médio assistido, % do vídeo assistido,
horas assistidas, inscritos ganhos por vídeo e a curva de retenção são **privados do canal**: só saem pela
YouTube Analytics API com a autorização do dono. O YouTube entrega médias e totais (nunca o tempo de cada
espectador), com 2 a 3 dias de atraso.

## Fluxo

```
Portal do Afiliado ── botão "Conectar YouTube" ──▶ yt-connect (login do Google, só leitura)
                                                     │ guarda o refresh token em youtube_connections
                                                     ▼
pg_cron (a cada 6 h, job yt-analytics) ──────────▶ yt-analytics ──▶ youtube_analytics_daily
                                                                  ├▶ youtube_video_analytics
                                                                  └▶ youtube_video_retention
```

Aparece em: dashboard do influencer (seção **Tempo assistido**, colunas Tempo médio e % assistido na tabela de
vídeos, retenção ao abrir um vídeo), menu **YouTube** (grupo "Tempo assistido · 28 dias" e colunas no detalhe do
canal) e Portal do Afiliado (Seu canal no YouTube).

## Configuração no Google Cloud (uma vez)

1. console.cloud.google.com → criar (ou escolher) um projeto.
2. **APIs e serviços → Biblioteca**: ativar **YouTube Analytics API** e **YouTube Data API v3**.
3. **Tela de consentimento OAuth**: tipo *Externo*; nome do app, e-mail de suporte, domínio `gestorflowtools.shop`.
   Escopos: `.../auth/yt-analytics.readonly` e `.../auth/youtube.readonly`.
4. Enquanto o app estiver **em teste**, só entram os e-mails cadastrados em *Usuários de teste* (até 100): cadastre a
   conta Google do canal de cada influencer. Para liberar a qualquer pessoa, publique o app e peça a verificação do
   Google (escopos sensíveis). Em modo de teste a autorização vence em 7 dias; publicado, não vence.
5. **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da Web**. URI de redirecionamento autorizado:
   `https://jagmnogcpxeujtsrrotd.supabase.co/functions/v1/yt-connect`
6. Supabase → Edge Functions → Secrets: `YT_OAUTH_CLIENT_ID` e `YT_OAUTH_CLIENT_SECRET`.

## Deploy

- Migration `supabase/migrations/20261118_youtube_analytics.sql` (tabelas, `portal_youtube` nova, cron `yt-analytics`).
- Edge Functions `yt-connect` (**verify_jwt = false**: a volta do Google não traz login) e `yt-analytics`.
