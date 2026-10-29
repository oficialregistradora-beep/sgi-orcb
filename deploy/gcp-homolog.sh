#!/usr/bin/env bash
# Publicação da HOMOLOGAÇÃO (dados fictícios). Ver deploy/gcp-publicar.sh.
AMBIENTE=homologacao exec bash "$(dirname "$0")/gcp-publicar.sh" "$@"
