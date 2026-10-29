#!/usr/bin/env bash
# Publicação da PRODUÇÃO (dados reais; projeto sgi-orcb-prod; pede confirmação). Ver deploy/gcp-publicar.sh.
AMBIENTE=producao exec bash "$(dirname "$0")/gcp-publicar.sh" "$@"
