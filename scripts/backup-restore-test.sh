#!/usr/bin/env bash
# Teste de backup e restauração: gera dump lógico, restaura em banco temporário e compara
# contagens de todas as tabelas + verifica a cadeia de auditoria no banco restaurado.
# Uso: scripts/backup-restore-test.sh <DATABASE_URL de origem> <URL de administração (para criar o banco temporário)>
set -euo pipefail
SRC="${1:?URL de origem}"; ADMIN="${2:?URL administrativa}"
TMPDB="sgi_restore_$(date +%s)"; OUT="${BACKUP_DIR:-backups}"; mkdir -p "$OUT"
FILE="$OUT/sgi-$(date +%Y%m%d-%H%M%S).dump"
echo "1) Backup lógico → $FILE"
pg_dump --format=custom --no-owner --no-privileges "$SRC" -f "$FILE"
sha256sum "$FILE" | tee "$FILE.sha256"
echo "2) Restauração em $TMPDB"
psql "$ADMIN" -qc "CREATE DATABASE $TMPDB"
DST="${ADMIN%/*}/$TMPDB"
pg_restore --no-owner --no-privileges -d "$DST" "$FILE"
echo "3) Comparação de contagens"
Q="SELECT string_agg(t || '=' || n, ',' ORDER BY t) FROM (SELECT table_name t, (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM '||table_name, false, true, '')))[1]::text::int n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') x"
A=$(psql "$SRC" -Atc "$Q"); B=$(psql "$DST" -Atc "$Q")
if [ "$A" != "$B" ]; then echo "DIVERGÊNCIA"; echo "$A"; echo "$B"; RC=1; else echo "Contagens idênticas em $(echo "$A" | tr ',' '\n' | wc -l) tabelas"; RC=0; fi
echo "4) Cadeia de auditoria no banco restaurado"
BROKEN=$(psql "$DST" -Atc "SELECT count(*) FROM fn_audit_verify()")
[ "$BROKEN" = "0" ] && echo "Cadeia íntegra ($(psql "$DST" -Atc 'SELECT count(*) FROM audit_log') registros)" || { echo "CADEIA ROMPIDA"; RC=1; }
psql "$ADMIN" -qc "DROP DATABASE $TMPDB"
exit $RC
