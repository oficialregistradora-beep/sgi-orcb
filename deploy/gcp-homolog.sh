#!/usr/bin/env bash
# SGI-ORCB — publicação da HOMOLOGAÇÃO no Google Cloud, sem chave de conta de serviço.
# Executar no Cloud Shell (console.cloud.google.com → ícone ">_"), logado como administrador, na pasta do código:
#   bash deploy/gcp-homolog.sh
# Usa o login de quem executa (nenhuma chave é criada). Pode ser executado de novo a qualquer momento:
# o que já existe é mantido; a imagem é reconstruída e republicada.
# Segredos são gerados aqui e gravados direto no Secret Manager; nada é exibido na tela.
set -euo pipefail

PROJECT="${PROJECT:-sgi-orcb-homolog}"
REGION="southamerica-east1"
DOMAIN="${DOMAIN:-registroscapivari.com}"
SERVICE="sgi-orcb"
SQL_INSTANCE="sgi-homolog"
DB_NAME="sgi"
VPC="sgi-vpc"
SUBNET="sgi-run"
REPO="sgi"
CONF="$HOME/.sgi-homolog.conf"

passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()    { printf '    \033[32m✓\033[0m %s\n' "$*"; }
aviso() { printf '    \033[33m!\033[0m %s\n' "$*"; }
erro()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
trap 'printf "\n\033[1;31m✗ Parou na linha %s. Copie as últimas linhas acima (sem senhas) e envie ao desenvolvimento.\033[0m\n" "$LINENO" >&2' ERR

[ -f Dockerfile ] && [ -f scripts/cloud-setup.ts ] || erro "Execute dentro da pasta do código (onde estão Dockerfile e scripts/)."
command -v docker >/dev/null || erro "Docker indisponível: execute no Cloud Shell."

# ---------------------------------------------------------------------------
passo "1/10 Conferências"
gcloud config set project "$PROJECT" --quiet >/dev/null 2>&1
ACCOUNT="$(gcloud config get-value account 2>/dev/null)"
[[ "$ACCOUNT" == *"@$DOMAIN" ]] || erro "Conta atual ($ACCOUNT) não é do domínio $DOMAIN."
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
case "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || echo '?')" in
  [Tt]rue) ;;
  [Ff]alse) erro "O projeto $PROJECT não está ligado a uma conta de faturamento (Faturamento → Vincular uma conta de faturamento)." ;;
  *) aviso "Não consegui conferir o faturamento automaticamente; seguindo (se faltar, o passo 2 avisará)." ;;
esac
APP_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
ok "Conta $ACCOUNT · projeto $PROJECT ($PROJECT_NUMBER)"

# Respostas guardadas para as próximas execuções (nenhum segredo neste arquivo).
# shellcheck source=/dev/null
[ -f "$CONF" ] && . "$CONF"
pergunta_email() { # $1 variável, $2 texto, $3 obrigatório(1/0)
  local v="${!1:-}"
  while [ -z "$v" ] || [[ "$v" != *"@$DOMAIN" ]]; do
    read -r -p "    $2 (@$DOMAIN)${3:+: }" v
    [ -z "$v" ] && [ "$3" = 0 ] && break
    [[ "$v" == *"@$DOMAIN" ]] || echo "    Use um e-mail @$DOMAIN."
  done
  printf -v "$1" '%s' "$v"
}
pergunta_email EMAIL_OFICIAL "E-mail Google de quem fará o papel da OFICIAL nos testes" 1
pergunta_email EMAIL_SUBSTITUTA "E-mail Google de quem fará o papel da SUBSTITUTA (Enter para pular)" 0
while [[ "${GOOGLE_CLIENT_ID:-}" != *.apps.googleusercontent.com ]]; do
  read -r -p "    ID do cliente OAuth \"SGI homologação\" (termina em .apps.googleusercontent.com): " GOOGLE_CLIENT_ID
done
printf 'EMAIL_OFICIAL=%q\nEMAIL_SUBSTITUTA=%q\nGOOGLE_CLIENT_ID=%q\n' "$EMAIL_OFICIAL" "${EMAIL_SUBSTITUTA:-}" "$GOOGLE_CLIENT_ID" > "$CONF"
ok "Respostas guardadas em $CONF"

# ---------------------------------------------------------------------------
passo "2/10 Ativando as APIs (pode levar 1–2 min)"
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com \
  compute.googleapis.com servicenetworking.googleapis.com cloudscheduler.googleapis.com --quiet
ok "APIs ativas"

# ---------------------------------------------------------------------------
passo "3/10 Rede privada (o banco não fica exposto à internet)"
gcloud compute networks describe "$VPC" >/dev/null 2>&1 || gcloud compute networks create "$VPC" --subnet-mode=custom --quiet
gcloud compute networks subnets describe "$SUBNET" --region="$REGION" >/dev/null 2>&1 \
  || gcloud compute networks subnets create "$SUBNET" --network="$VPC" --region="$REGION" --range=10.10.0.0/24 --enable-private-ip-google-access --quiet
gcloud compute addresses describe sgi-psa --global >/dev/null 2>&1 \
  || gcloud compute addresses create sgi-psa --global --purpose=VPC_PEERING --prefix-length=20 --network="$VPC" --quiet
gcloud services vpc-peerings list --network="$VPC" --format='value(peering)' 2>/dev/null | grep -q servicenetworking \
  || gcloud services vpc-peerings connect --service=servicenetworking.googleapis.com --ranges=sgi-psa --network="$VPC" --quiet
ok "Rede $VPC pronta"

# ---------------------------------------------------------------------------
passo "4/10 Contas de serviço (identidades do sistema, sem chave)"
for sa in sgi-app sgi-setup; do
  gcloud iam service-accounts describe "$sa@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1 \
    || gcloud iam service-accounts create "$sa" --display-name="SGI ${sa#sgi-}" --quiet
done
SA_APP="sgi-app@$PROJECT.iam.gserviceaccount.com"; SA_SETUP="sgi-setup@$PROJECT.iam.gserviceaccount.com"
ok "sgi-app (aplicação) e sgi-setup (preparação do banco)"

# ---------------------------------------------------------------------------
passo "5/10 Segredos (gerados aqui, gravados no Secret Manager)"
segredo() { # $1 nome, $2 valor (somente na criação)
  if gcloud secrets describe "$1" >/dev/null 2>&1; then return 0; fi
  printf '%s' "$2" | gcloud secrets create "$1" --replication-policy=user-managed --locations="$REGION" --data-file=- --quiet >/dev/null
  ok "criado: $1"
}
ler_segredo() { gcloud secrets versions access latest --secret="$1"; }
segredo sgi-field-key "$(openssl rand -base64 32)"
segredo sgi-hmac-key "$(openssl rand -base64 32)"
segredo sgi-cron-secret "$(openssl rand -hex 32)"
segredo sgi-db-owner-password "$(openssl rand -hex 24)"
segredo sgi-db-app-password "$(openssl rand -hex 24)"
segredo sgi-db-root-password "$(openssl rand -hex 24)"
if ! gcloud secrets describe sgi-google-client-secret >/dev/null 2>&1; then
  CS=""
  while [ ${#CS} -lt 10 ]; do read -r -s -p "    Chave secreta do cliente OAuth (não aparece ao digitar/colar; Enter): " CS; echo; done
  segredo sgi-google-client-secret "$CS"; unset CS
fi
ok "Segredos prontos"

# ---------------------------------------------------------------------------
passo "6/10 Banco de dados (Cloud SQL PostgreSQL 16, São Paulo — a criação leva ~10 min)"
if ! gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  gcloud sql instances create "$SQL_INSTANCE" --database-version=POSTGRES_16 --edition=enterprise --tier=db-f1-micro \
    --region="$REGION" --network="projects/$PROJECT/global/networks/$VPC" --no-assign-ip \
    --storage-type=SSD --storage-size=10 --storage-auto-increase \
    --backup-start-time=06:00 --enable-point-in-time-recovery --retained-backups-count=7 --retained-transaction-log-days=7 \
    --ssl-mode=ALLOW_UNENCRYPTED_AND_ENCRYPTED --root-password="$(ler_segredo sgi-db-root-password)" --quiet
fi
gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null 2>&1 || gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE" --quiet
if gcloud sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx sgi_owner; then
  gcloud sql users set-password sgi_owner --instance="$SQL_INSTANCE" --password="$(ler_segredo sgi-db-owner-password)" --quiet
else
  gcloud sql users create sgi_owner --instance="$SQL_INSTANCE" --password="$(ler_segredo sgi-db-owner-password)" --quiet
fi
DB_IP="$(gcloud sql instances describe "$SQL_INSTANCE" --format=json | python3 -c 'import json,sys; print(next(a["ipAddress"] for a in json.load(sys.stdin)["ipAddresses"] if a["type"]=="PRIVATE"))')"
url_segredo() { # $1 nome, $2 url — atualiza quando muda
  if gcloud secrets describe "$1" >/dev/null 2>&1; then
    [ "$(ler_segredo "$1")" = "$2" ] || printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --quiet >/dev/null
  else segredo "$1" "$2"; fi
}
url_segredo sgi-database-url-owner "postgres://sgi_owner:$(ler_segredo sgi-db-owner-password)@$DB_IP:5432/$DB_NAME"
url_segredo sgi-database-url-app "postgres://sgi_app:$(ler_segredo sgi-db-app-password)@$DB_IP:5432/$DB_NAME"
ok "Banco $SQL_INSTANCE (IP privado), backups diários e recuperação pontual (7 dias)"

# Acesso de cada identidade somente aos segredos de que precisa.
acesso() { gcloud secrets add-iam-policy-binding "$1" --member="serviceAccount:$2" --role=roles/secretmanager.secretAccessor --quiet >/dev/null; }
for s in sgi-database-url-app sgi-field-key sgi-hmac-key sgi-google-client-secret sgi-cron-secret; do acesso "$s" "$SA_APP"; done
for s in sgi-database-url-owner sgi-db-app-password sgi-field-key sgi-hmac-key; do acesso "$s" "$SA_SETUP"; done
ok "Permissões dos segredos aplicadas"

# ---------------------------------------------------------------------------
passo "7/10 Imagens (montagem aqui no Cloud Shell — 5 a 10 min)"
gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" --quiet
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet >/dev/null 2>&1
REG="$REGION-docker.pkg.dev/$PROJECT/$REPO"
TAG="$(date +%Y%m%d-%H%M)"
docker build -q -t "$REG/app:$TAG" . >/dev/null
# Envio com novas tentativas: falhas momentâneas de rede no Cloud Shell são comuns logo após criar o repositório.
tenta() {
  local n=1
  until "$@" >/dev/null; do
    [ $n -ge 5 ] && erro "Falha de rede repetida em: ${*:1:3}. Aguarde alguns minutos e execute o mesmo comando de novo."
    aviso "Falha de rede (tentativa $n de 5); nova tentativa em $((n * 15)) s…"
    sleep $((n * 15)); n=$((n + 1))
  done
}
tenta docker push -q "$REG/app:$TAG"
tenta docker pull -q clamav/clamav:1.4
docker tag clamav/clamav:1.4 "$REG/clamav:1.4"
tenta docker push -q "$REG/clamav:1.4"
ok "app:$TAG e clamav:1.4 publicadas no Artifact Registry"

# ---------------------------------------------------------------------------
TMP="$(mktemp -d)"
cat > "$TMP/comum.yaml" <<EOF
APP_ENV: homologacao
APP_URL: $APP_URL
GOOGLE_WORKSPACE_DOMAIN: $DOMAIN
GOOGLE_CLIENT_ID: $GOOGLE_CLIENT_ID
DATABASE_SSL: "false"
AUTH_DEV_LOGIN: "false"
TRUSTED_PROXY_HOPS: "0"
EOF
SEED="oficial=$EMAIL_OFICIAL${EMAIL_SUBSTITUTA:+;substituta=$EMAIL_SUBSTITUTA}"
{ cat "$TMP/comum.yaml"; echo "SEED_EMAILS: \"$SEED\""; } > "$TMP/job.yaml"
{ cat "$TMP/comum.yaml"; echo 'CLAMAV_HOST: "127.0.0.1"'; echo 'CLAMAV_PORT: "3310"'; } > "$TMP/app.yaml"
REDE=(--network="$VPC" --subnet="$SUBNET" --vpc-egress=private-ranges-only)

passo "8/10 Preparando o banco (migrations, papel da aplicação e dados FICTÍCIOS de homologação)"
job() { # $1 nome, $2 script
  gcloud run jobs deploy "$1" --image="$REG/app:$TAG" --region="$REGION" --service-account="$SA_SETUP" "${REDE[@]}" \
    --command=node --args="--experimental-strip-types,$2" --env-vars-file="$TMP/job.yaml" \
    --set-secrets=DATABASE_URL=sgi-database-url-owner:latest,FIELD_ENCRYPTION_KEY=sgi-field-key:latest,HMAC_KEY=sgi-hmac-key:latest,SGI_APP_DB_PASSWORD=sgi-db-app-password:latest \
    --max-retries=0 --task-timeout=20m --memory=1Gi --quiet >/dev/null
  gcloud run jobs execute "$1" --region="$REGION" --wait --quiet >/dev/null \
    || erro "O job $1 falhou. Veja: Cloud Run → Jobs → $1 → Registros."
}
job sgi-setup scripts/cloud-setup.ts
ok "Migrations e permissões aplicadas"
job sgi-seed scripts/seed.ts
ok "Dados fictícios carregados (Oficial: $EMAIL_OFICIAL${EMAIL_SUBSTITUTA:+; Substituta: $EMAIL_SUBSTITUTA}) — na 2ª execução em diante o seed não altera nada"

# ---------------------------------------------------------------------------
passo "9/10 Publicando o sistema (Cloud Run, com antivírus junto)"
gcloud run deploy "$SERVICE" --region="$REGION" --service-account="$SA_APP" "${REDE[@]}" \
  --execution-environment=gen2 --no-cpu-throttling --min-instances=0 --max-instances=2 --timeout=300 \
  --ingress=all --no-invoker-iam-check \
  --container=app --image="$REG/app:$TAG" --port=8080 --cpu=1 --memory=1Gi --env-vars-file="$TMP/app.yaml" \
  --set-secrets=DATABASE_URL=sgi-database-url-app:latest,FIELD_ENCRYPTION_KEY=sgi-field-key:latest,HMAC_KEY=sgi-hmac-key:latest,GOOGLE_CLIENT_SECRET=sgi-google-client-secret:latest,CRON_SECRET=sgi-cron-secret:latest \
  --container=clamav --image="$REG/clamav:1.4" --cpu=1 --memory=3Gi \
  --quiet >/dev/null
for _ in $(seq 1 30); do curl -sf "$APP_URL/api/v1/health" | grep -q '"banco":"ok"' && break; sleep 5; done
curl -sf "$APP_URL/api/v1/health" | grep -q '"banco":"ok"' && ok "No ar: $APP_URL" || aviso "Publicado, mas a verificação de saúde ainda não respondeu. Teste $APP_URL/api/v1/health em 2 min."

# ---------------------------------------------------------------------------
passo "10/10 Rotina diária (06:10, horário de Brasília)"
CRON_AUTH="Authorization=Bearer $(ler_segredo sgi-cron-secret)"
if gcloud scheduler jobs describe sgi-rotina-diaria --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http sgi-rotina-diaria --location="$REGION" --schedule="10 6 * * *" --time-zone=America/Sao_Paulo \
    --uri="$APP_URL/api/cron/processar" --http-method=POST --update-headers="$CRON_AUTH" --quiet >/dev/null && ok "Rotina atualizada" \
    || aviso "Não foi possível atualizar a rotina diária (o sistema funciona; avise o desenvolvimento)."
else
  gcloud scheduler jobs create http sgi-rotina-diaria --location="$REGION" --schedule="10 6 * * *" --time-zone=America/Sao_Paulo \
    --uri="$APP_URL/api/cron/processar" --http-method=POST --headers="$CRON_AUTH" --attempt-deadline=600s --quiet >/dev/null && ok "Rotina criada" \
    || aviso "Não foi possível criar a rotina diária (o sistema funciona; avise o desenvolvimento)."
fi
unset CRON_AUTH; rm -rf "$TMP"

cat <<EOF

$(printf '\033[1;32m')Homologação publicada.$(printf '\033[0m')

  Endereço do sistema:  $APP_URL

  FALTA UM CLIQUE: no console, Google Auth Platform → Clientes → "SGI homologação" →
  "URIs de redirecionamento autorizados" → Adicionar URI → cole exatamente:

      $APP_URL/api/auth/google/callback

  → Salvar (vale em 1 a 5 minutos). Depois entre em $APP_URL com $EMAIL_OFICIAL.

  Dados: somente FICTÍCIOS. Não cadastre pessoas, documentos ou valores reais na homologação.
  O antivírus leva 2–3 min para carregar após o sistema "acordar"; nesse intervalo, anexos são recusados.
EOF
