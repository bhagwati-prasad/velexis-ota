#!/usr/bin/env bash
# =====================================================================================================
# backup.sh — nightly encrypted backup of the Velexis VM, copied off the VM (ADR-0007).
# Root-owned copy: /usr/local/sbin/velexis-backup, run by velexis-backup.service (timer 02:30 UTC).
#
# TEMPLATE: finalised and tested by task X-024. Settings: /etc/velexis/backup.env (deploy/env/backup.env.example).
# Manual run: sudo systemctl start velexis-backup   (or: sudo /usr/local/sbin/velexis-backup)
#
# Produces, per run, in $BACKUP_DIR/<UTC stamp>/ and then in <remote>/daily/<YYYY-MM-DD>/ (and monthly/<YYYY-MM>/
# on the 1st of the month):
#   velexis-db.dump.age        pg_dump --format=custom of the whole database (platform, reference, tenant_*)
#   globals.sql.age            roles and grants without passwords (pg_dumpall --globals-only --no-role-passwords)
#   storage.tar.zst.age        /var/lib/velexis/storage (documents, exports)
#   redis-aof.tar.zst.age      the Redis AOF directory (queues, schedules; PostgreSQL stays the record)
#   config.tar.zst.age         /etc/velexis incl. the master key, encrypted to a DIFFERENT age key
#   MANIFEST.txt               sizes, SHA-256 of the encrypted files, versions (no secrets)
# Every file is encrypted with `age` to public keys whose private halves are kept OFF the VM.
# =====================================================================================================
set -euo pipefail
umask 077

if [ -z "${RCLONE_REMOTE:-}" ] && [ -f /etc/velexis/backup.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/velexis/backup.env
  set +a
fi

: "${BACKUP_DIR:=/var/backups/velexis}"
: "${AGE_RECIPIENTS_FILE:?set in /etc/velexis/backup.env}"
: "${AGE_CONFIG_RECIPIENTS_FILE:?set in /etc/velexis/backup.env}"
: "${RCLONE_CONFIG:?set in /etc/velexis/backup.env}"
: "${RCLONE_REMOTE:?set in /etc/velexis/backup.env}"
: "${RETENTION_DAILY_DAYS:=14}"
: "${RETENTION_MONTHLY_MONTHS:=6}"
: "${RETENTION_LOCAL_DAYS:=2}"
: "${PG_DATABASE:=velexis}"
: "${REDIS_AOF_DIR:=/var/lib/redis/appendonlydir}"
: "${STORAGE_DIR:=/var/lib/velexis/storage}"
: "${BACKUP_MARKER_FILE:=/var/lib/velexis/backup-last-success}"
export RCLONE_CONFIG

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
for f in "$AGE_RECIPIENTS_FILE" "$AGE_CONFIG_RECIPIENTS_FILE"; do
  grep -q '^age1' "$f" 2>/dev/null || die "no age public key in $f (see deployment-single-vm.md §10)"
done
cmp -s "$AGE_RECIPIENTS_FILE" "$AGE_CONFIG_RECIPIENTS_FILE" && die "data and config backups must use different age keys"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
DAY="$(date -u +%F)"
MONTH="$(date -u +%Y-%m)"
WORK="$BACKUP_DIR/$STAMP"
mkdir -p "$WORK"

encrypt_data() { age -R "$AGE_RECIPIENTS_FILE" -o "$1"; }
encrypt_config() { age -R "$AGE_CONFIG_RECIPIENTS_FILE" -o "$1"; }

# ---- 1. PostgreSQL ---------------------------------------------------------------------------------------
log "pg_dump $PG_DATABASE"
runuser -u postgres -- pg_dump --format=custom --compress=zstd:3 "$PG_DATABASE" | encrypt_data "$WORK/velexis-db.dump.age"
runuser -u postgres -- pg_dumpall --globals-only --no-role-passwords | encrypt_data "$WORK/globals.sql.age"

# ---- 2. File storage -------------------------------------------------------------------------------------
log "storage $STORAGE_DIR"
tar -C "$(dirname "$STORAGE_DIR")" -cf - "$(basename "$STORAGE_DIR")" | zstd -q -T0 | encrypt_data "$WORK/storage.tar.zst.age"

# ---- 3. Redis AOF (copy only while no AOF rewrite is running) ---------------------------------------------
log "redis AOF $REDIS_AOF_DIR"
for _ in $(seq 1 60); do
  if REDISCLI_AUTH="${REDIS_PASSWORD:-}" redis-cli -h 127.0.0.1 INFO persistence | grep -q '^aof_rewrite_in_progress:0'; then break; fi
  sleep 2
done
tar -C "$(dirname "$REDIS_AOF_DIR")" -cf - "$(basename "$REDIS_AOF_DIR")" | zstd -q -T0 | encrypt_data "$WORK/redis-aof.tar.zst.age"

# ---- 4. /etc/velexis (master key, env files) — separate key -----------------------------------------------
log "config /etc/velexis"
tar -C /etc -cf - velexis | zstd -q -T0 | encrypt_config "$WORK/config.tar.zst.age"

# ---- 5. Manifest -------------------------------------------------------------------------------------------
{
  echo "created_at=$STAMP"
  echo "host=$(hostname)"
  echo "release=$(basename "$(readlink -f /srv/velexis/current 2>/dev/null || echo none)")"
  echo "postgres=$(runuser -u postgres -- psql -XAtc 'SHOW server_version')"
  echo "tenant_schemas=$(runuser -u postgres -- psql -XAt -d "$PG_DATABASE" -c "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'tenant\_%'")"
  ( cd "$WORK" && sha256sum ./*.age && du -b ./*.age )
} > "$WORK/MANIFEST.txt"

# ---- 6. Upload off the VM and verify ---------------------------------------------------------------------
log "upload to $RCLONE_REMOTE/daily/$DAY"
rclone copy "$WORK" "$RCLONE_REMOTE/daily/$DAY" --immutable --retries 5
rclone check "$WORK" "$RCLONE_REMOTE/daily/$DAY" --one-way
if [ "$(date -u +%d)" = "01" ]; then
  log "monthly copy $RCLONE_REMOTE/monthly/$MONTH"
  rclone copy "$WORK" "$RCLONE_REMOTE/monthly/$MONTH" --immutable --retries 5
fi

# ---- 7. Retention ------------------------------------------------------------------------------------------
log "retention: ${RETENTION_DAILY_DAYS}d daily, ${RETENTION_MONTHLY_MONTHS} months, ${RETENTION_LOCAL_DAYS}d local"
rclone delete "$RCLONE_REMOTE/daily" --min-age "${RETENTION_DAILY_DAYS}d"
rclone rmdirs "$RCLONE_REMOTE/daily" --leave-root
rclone delete "$RCLONE_REMOTE/monthly" --min-age "$((RETENTION_MONTHLY_MONTHS * 31))d"
rclone rmdirs "$RCLONE_REMOTE/monthly" --leave-root
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_LOCAL_DAYS" -exec rm -rf --one-file-system {} +

date -u +%s > "$BACKUP_MARKER_FILE"
log "backup $STAMP done ($(du -sh "$WORK" | cut -f1))"
