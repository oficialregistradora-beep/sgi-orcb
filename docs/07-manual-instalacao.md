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

## Demonstração em um computador (Docker Desktop, dados fictícios)
Para conhecer o sistema num notebook, sem nuvem e sem credenciais: requer apenas Docker Desktop (Windows/macOS/Linux).
```bash
docker compose -f docker-compose.local.yml up -d --build   # 1ª vez: 5–15 min (compilação + assinaturas do antivírus)
# abrir http://localhost:8080 — escolher um usuário fictício; o código MFA aparece na própria tela
docker compose -f docker-compose.local.yml down             # parar (os dados ficam guardados)
docker compose -f docker-compose.local.yml down -v          # parar e APAGAR tudo (banco, chaves)
```
- Sobe banco, antivírus (ClamAV) e aplicação; aplica as migrations e o seed fictício só na primeira vez; as chaves de criptografia são geradas no próprio volume `chaves_local`.
- A porta fica presa ao próprio computador (`127.0.0.1:8080`): ninguém na mesma rede Wi-Fi acessa.
- Uso exclusivo para demonstração/homologação: login de teste ligado, senha de banco fixa, sem Google, sem backup. **Não cadastrar dados reais.**

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
10a. **Antivírus (obrigatório):** contêiner auxiliar `clamav/clamav:1.4` no mesmo serviço do Cloud Run; `CLAMAV_HOST=127.0.0.1`. Sem ele, o envio de anexos fica bloqueado em produção. Detalhes e custo: `23-guia-integracoes-google-antivirus.md`.
10b. **Google Drive (opcional):** passos B1–B3 do mesmo guia.
11. Cloud Monitoring: verificação de disponibilidade em `/api/v1/health` com alerta por e-mail.

## Variante VM / instalação local (Alternativas C e "custo mínimo")
`docker compose up -d` (arquivo `docker-compose.yml`, que já inclui o antivírus ClamAV), atrás de proxy reverso com TLS (Caddy ou Nginx), com backups conforme `12-backup-restauracao.md`. A aplicação **não deve** ser exposta sem HTTPS.

> Status: build de produção, execução local e demonstração em Docker **testados**. **Homologação** publicada no Google Cloud em 24/10/2026 pelo caminho sem chave (`deploy/gcp-homolog.sh`, ver `27-guia-google-cloud-p02-p03.md`). Aceite e autorização da Oficial em 29/10/2026; publicação da produção: `deploy/gcp-producao.sh`, passo a passo em `29-guia-producao.md`.
