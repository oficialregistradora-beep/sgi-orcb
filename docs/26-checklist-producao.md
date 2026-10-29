# Checklist para entrada em produção

**Situação em 29/10/2026:** homologação publicada no Google Cloud (dados fictícios) e concluída; aceite e **autorização expressa** da Oficial enviados em 29/10/2026 (`28-registro-homologacao.md`). Produção em preparação (`29-guia-producao.md`, `deploy/gcp-producao.sh`). Pendências que a autorização condiciona: IP fixo (Ateky), quitação do banco de horas anterior, encarregado(a) LGPD e validação jurídica dos itens J.

## A. Decisões e documentos da serventia
| Item | Decisão / documento | Bloqueia |
|---|---|---|
| P-01 | Edição do Google Workspace | Integrações |
| P-02 | Aprovar a infraestrutura (Cloud Run + Cloud SQL) e o faturamento no Google Cloud | Homologação na nuvem e produção |
| P-03 | Projeto no Google Cloud, cliente OAuth interno, conta de serviço (Drive/Agenda/Gmail), espaço do Chat — passo a passo em `27-guia-google-cloud-p02-p03.md` | Login Google real e integrações |
| P-04 | Convenção coletiva vigente e modelos de acordo individual | Parametrização de jornada/banco/plantão |
| P-05 | Profissional jurídico para validar os itens J | Homologação |
| P-06 | Encarregado(a) de dados (LGPD) | Produção (dados reais de pessoas) |
| J-01 a J-17 | Validações jurídicas registradas em `01-entrega-1-planejamento.md` §9 | Uso dos respectivos parâmetros em produção |
| — | Definir quem paga (terceiro papel financeiro), prazos de avaliação de experiência, treinamentos obrigatórios e requisitos reais do PQTA | Uso pleno dos módulos |

## B. Infraestrutura (após P-02/P-03) — guia: `07-manual-instalacao.md` e `23-guia-integracoes-google-antivirus.md`
- [ ] **IP fixo** contratado com o provedor de internet do cartório (para a restrição de rede).
- [ ] Após publicar: confirmar em *Configurações → Rede* que o endereço mostrado é o IP fixo do cartório (valida `TRUSTED_PROXY_HOPS`); cadastrar e ativar a restrição.
- [ ] Projeto GCP na região de São Paulo; Cloud SQL PostgreSQL 16 com backups automáticos e PITR; Cloud Run com HTTPS.
- [ ] Segredos no Secret Manager: `FIELD_ENCRYPTION_KEY`, `HMAC_KEY` (gerados uma única vez e guardados com cópia segura), `GOOGLE_CLIENT_SECRET`, `CRON_SECRET` (≥ 32 caracteres).
- [ ] `APP_ENV=producao`, `AUTH_DEV_LOGIN=false`, cookies seguros, `GOOGLE_WORKSPACE_DOMAIN` institucional.
- [ ] ClamAV (contêiner `clamav/clamav`) acessível; em produção o envio é recusado sem antivírus.
- [ ] Cloud Scheduler: `POST /api/cron/processar` diário e `?somente=integracoes` a cada 10 min, com `Authorization: Bearer <CRON_SECRET>`.
- [ ] Executar as migrações; **não** executar o seed (é recusado em produção).
- [ ] Teste de restauração (`scripts/backup-restore-test.sh`) no ambiente real; registrar o resultado.

## C. Validação antes do aceite
- [ ] Rodadas automatizadas no ambiente de homologação na nuvem (suíte completa, E2E, sondagem de segurança, acessibilidade, carga) — comandos em `15-plano-de-testes.md`.
- [x] Roteiro de homologação (`25-roteiro-homologacao.md`) executado e aceito por escrito (29/10/2026).
- [ ] Recomendado: teste de intrusão independente.

## D. Implantação gradual (`14-plano-implantacao.md`)
- [ ] Cadastro da Oficial; papéis; cadastros funcionais reais pela interface (sem importação de dados reais em ambiente de teste).
- [ ] Treinamento da equipe e cadastro dos autenticadores.
- [ ] Operação paralela por 1 mês, conferindo espelhos; depois, encerrar o controle anterior.
- [x] **Autorização expressa da Oficial** para a publicação (29/10/2026).
