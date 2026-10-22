# Manual de instalação

## Requisitos
Node.js 22+, PostgreSQL 16 (extensões `pgcrypto` e `btree_gist`) e, opcionalmente, Docker.

## Ambiente local (desenvolvimento/homologação com dados fictícios)
```bash
npm ci
cp .env.example .env          # preencher; gerar chaves com: openssl rand -base64 32
# criar o banco e as extensões (como superusuário):
#   CREATE DATABASE sgi_dev OWNER sgi;  \c sgi_dev  CREATE EXTENSION pgcrypto; CREATE EXTENSION btree_gist;
npm run db:migrate
npm run db:seed               # SOMENTE dados fictícios; recusado em APP_ENV=producao
npm run build && npm run start   # ou npm run dev
```
Com `APP_ENV=homologacao` e `AUTH_DEV_LOGIN=true`, a tela de login oferece usuários fictícios, e a tela de MFA mostra o código atual do usuário de teste.

## Produção — Alternativa A (Google Cloud, região southamerica-east1)
**Depende de autorização da serventia (P-02) e de projeto GCP com faturamento.**
1. Projeto GCP; habilitar Cloud Run, Cloud SQL Admin, Secret Manager e Artifact Registry.
2. Cloud SQL PostgreSQL 16, menor instância, **backups automáticos + PITR**, retenção de 30 dias, IP privado ou conector do Cloud SQL; criar as extensões.
3. Papéis de banco: `sgi_owner` (migrations) e `sgi_app` (aplicação) — `db/roles.sql`.
4. Secret Manager: `DATABASE_URL` (sgi_app), `FIELD_ENCRYPTION_KEY`, `HMAC_KEY`, `GOOGLE_CLIENT_SECRET`, `CRON_SECRET` (opcional).
5. OAuth: Console GCP → Tela de consentimento **Interna** → Cliente "Aplicativo da Web" → URI de redirecionamento `https://<dominio>/api/auth/google/callback`. Escopos: `openid`, `email`, `profile`.
6. Build e publicação: `gcloud builds submit --tag <região>-docker.pkg.dev/<proj>/sgi/app:<versão>`.
7. Migrations (job Cloud Run com credencial `sgi_owner`): `node --experimental-strip-types scripts/migrate.ts`.
8. Serviço Cloud Run: variáveis `APP_ENV=producao`, `APP_URL=https://…`, `GOOGLE_WORKSPACE_DOMAIN`, `GOOGLE_CLIENT_ID`, `DATABASE_SSL=true` + segredos; instâncias de 0 a 2 (ou mínimo 1 para evitar partida a frio às 08h); domínio próprio com HTTPS gerenciado.
9. Cadastrar a Oficial (único `is_owner`), uma vez, via SQL administrativo auditado:
   `INSERT INTO users (email, display_name, is_owner) VALUES ('<email>', '<nome>', true);` e o cadastro funcional correspondente. Os demais cadastros são feitos pela interface.
10. Admin Console do Workspace: exigir verificação em duas etapas (recomendado).
11. Cloud Monitoring: verificação de disponibilidade em `/api/v1/health` com alerta por e-mail.

## Variante VM / instalação local (Alternativas C e "custo mínimo")
`docker compose up -d` (arquivo `docker-compose.yml`), atrás de proxy reverso com TLS (Caddy ou Nginx), com backups conforme `12-backup-restauracao.md`. A aplicação **não deve** ser exposta sem HTTPS.

> Status: build de produção e execução local **testados**; imagem Docker e implantação no GCP **não executadas** neste ambiente (dependem de credenciais e autorização).
