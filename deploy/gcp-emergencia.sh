#!/usr/bin/env bash
# SGI-ORCB — procedimento de EMERGÊNCIA do segundo fator (para quem perdeu o aplicativo autenticador, inclusive a Oficial).
# Executar no Cloud Shell, na pasta do código (versão 15 ou posterior, já publicada):
#   cd ~/sgi-orcb && bash deploy/gcp-emergencia.sh
# Libera o código no e-mail pessoal e/ou redefine o autenticador da pessoa. Tudo fica na auditoria do sistema.
# O job usado é apagado ao final (o e-mail pessoal não fica guardado na configuração do Google Cloud).
set -euo pipefail

AMBIENTE="${AMBIENTE:-producao}"
case "$AMBIENTE" in
  producao)    PROJECT="${PROJECT:-sgi-orcb-prod}";    DB_SSL="require"; CONF="$HOME/.sgi-producao.conf" ;;
  homologacao) PROJECT="${PROJECT:-sgi-orcb-homolog}"; DB_SSL="false";   CONF="$HOME/.sgi-homolog.conf" ;;
  *) echo "AMBIENTE inválido: $AMBIENTE" >&2; exit 1 ;;
esac
REGION="southamerica-east1"
DOMAIN="${DOMAIN:-registroscapivari.com}"
SERVICE="sgi-orcb"
VPC="sgi-vpc"
SUBNET="sgi-run"
JOB="sgi-emergencia"

passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()    { printf '    \033[32m✓\033[0m %s\n' "$*"; }
erro()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f scripts/emergencia-mfa.ts ] || erro "Execute dentro da pasta do código da versão 15 ou posterior (cd ~/sgi-orcb)."

passo "1/3 Conferências"
gcloud config set project "$PROJECT" --quiet >/dev/null 2>&1
ACCOUNT="$(gcloud config get-value account 2>/dev/null)"
[[ "$ACCOUNT" == *"@$DOMAIN" ]] || erro "Conta atual ($ACCOUNT) não é do domínio $DOMAIN."
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
APP_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
IMAGE="$(gcloud run jobs describe sgi-setup --region="$REGION" --format='value(spec.template.spec.template.spec.containers[0].image)' 2>/dev/null || true)"
[ -n "$IMAGE" ] || erro "O sistema ainda não foi publicado neste projeto (bash deploy/gcp-producao.sh)."
# shellcheck source=/dev/null
[ -f "$CONF" ] && . "$CONF"
[ -n "${GOOGLE_CLIENT_ID:-}" ] || erro "Respostas da publicação não encontradas ($CONF). Publique a versão 15 antes (bash deploy/gcp-producao.sh)."
ok "Conta $ACCOUNT · projeto $PROJECT"

passo "2/3 O que fazer"
ALVO="${EMAIL_OFICIAL:-}"
read -r -p "    E-mail INSTITUCIONAL da pessoa [${ALVO}]: " v
ALVO="${v:-$ALVO}"; ALVO="${ALVO//[[:space:]]/}"
[[ "$ALVO" == *"@$DOMAIN" ]] || erro "Use o e-mail @$DOMAIN da pessoa."
cat <<EOF
    1) Liberar o código no E-MAIL PESSOAL (entra sem o aplicativo; exige o envio de e-mail ligado: --ligar-email)
    2) REDEFINIR o autenticador (no próximo acesso, cadastra o aplicativo de novo lendo um QR code)
    3) Os dois (recomendado quando o aplicativo foi perdido)
EOF
read -r -p "    Escolha 1, 2 ou 3: " op
case "$op" in 1) ACAO=EMAIL ;; 2) ACAO=REDEFINIR ;; 3) ACAO=AMBOS ;; *) erro "Opção inválida." ;; esac
PESSOAL=""
if [ "$ACAO" != REDEFINIR ]; then
  read -r -p "    E-mail PESSOAL que receberá os códigos (fora do @$DOMAIN): " PESSOAL
  read -r -p "    Repita o e-mail pessoal: " p2
  PESSOAL="${PESSOAL//[[:space:]]/}"; p2="${p2//[[:space:]]/}"
  [ "$PESSOAL" = "$p2" ] || erro "Os e-mails digitados são diferentes."
  [[ "$PESSOAL" == *@* && "$PESSOAL" != *"@$DOMAIN" ]] || erro "Informe um e-mail pessoal válido, fora do @$DOMAIN."
  [ -n "${GMAIL_SENDER:-}" ] || printf '    \033[33m!\033[0m O envio de e-mail ainda não está ligado: publique com --ligar-email e autorize no admin.google.com.\n'
fi
read -r -p "    Digite EMERGENCIA para confirmar: " c
[ "$c" = EMERGENCIA ] || erro "Cancelado."

passo "3/3 Executando (1–2 min)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/env.yaml" <<EOF
APP_ENV: $AMBIENTE
APP_URL: $APP_URL
GOOGLE_WORKSPACE_DOMAIN: $DOMAIN
GOOGLE_CLIENT_ID: $GOOGLE_CLIENT_ID
DATABASE_SSL: "$DB_SSL"
AUTH_DEV_LOGIN: "false"
ALVO_EMAIL: "$ALVO"
ACAO: "$ACAO"
EMAIL_PESSOAL: "$PESSOAL"
EXECUTADO_POR: "$ACCOUNT"
EOF
gcloud run jobs deploy "$JOB" --image="$IMAGE" --region="$REGION" --service-account="sgi-setup@$PROJECT.iam.gserviceaccount.com" \
  --network="$VPC" --subnet="$SUBNET" --vpc-egress=private-ranges-only \
  --command=node --args="--experimental-strip-types,scripts/emergencia-mfa.ts" --env-vars-file="$TMP/env.yaml" \
  --set-secrets=DATABASE_URL=sgi-database-url-owner:latest,FIELD_ENCRYPTION_KEY=sgi-field-key:latest,HMAC_KEY=sgi-hmac-key:latest \
  --max-retries=0 --task-timeout=5m --memory=512Mi --quiet >/dev/null
RES=0; gcloud run jobs execute "$JOB" --region="$REGION" --wait --quiet >/dev/null || RES=1
gcloud run jobs delete "$JOB" --region="$REGION" --quiet >/dev/null 2>&1 || true
[ "$RES" = 0 ] || erro "Não concluiu. Causas comuns: e-mail institucional não cadastrado no SGI, ou a versão publicada é anterior à 15. Veja: Cloud Run → Jobs (histórico) → Registros."
ok "Concluído para $ALVO (registrado na auditoria do sistema)"

cat <<EOF

  Próximo passo: abra $APP_URL e entre com $ALVO.
$( [ "$ACAO" != REDEFINIR ] && echo "  Na tela do código: \"Enviar código para meu e-mail pessoal\" → digite o código recebido (vale 10 min)." )
$( [ "$ACAO" != EMAIL ] && echo "  Para voltar a usar o aplicativo: leia o novo QR code (Google Authenticator) e gere novos códigos em Minha segurança." )
EOF
