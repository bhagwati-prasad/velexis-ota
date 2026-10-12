#!/usr/bin/env bash
# =====================================================================================================
# restore.sh — fetch, decrypt and restore Velexis backups made by backup.sh (ADR-0007).
# Root-owned copy: /usr/local/sbin/velexis-restore. Runbook: docs/mvp/deployment-single-vm.md §10–§11.
#
# TEMPLATE: finalised and tested by task X-024 (restore drill: X-031). The age PRIVATE keys are brought to the VM
# only for the restore (e.g. /root/restore/data.key), then deleted with `shred -u`.
#
#   velexis-restore list                                         list backups on the remote
#   velexis-restore fetch <daily/YYYY-MM-DD|monthly/YYYY-MM> <dir>   download one backup set
#   velexis-restore db <dir> --identity <key> [--target <db>]    restore the dump into <db> (default: velexis_restore,
#                                                                a scratch database; the live one is untouched)
#   velexis-restore db <dir> --identity <key> --replace-live     replace the LIVE database (stops all app units)
#   velexis-restore storage <dir> --identity <key> [--replace-live]
#   velexis-restore redis <dir> --identity <key>                 replace Redis data (stops Redis briefly)
#   velexis-restore config <dir> --identity <config-key>         unpack /etc/velexis into /root/velexis-config.restore
#   velexis-restore drill <dir> --identity <key>                 restore into a scratch db, run checks, drop it
# =====================================================================================================
set -euo pipefail
umask 077

if [ -f /etc/velexis/backup.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/velexis/backup.env
  set +a
fi
: "${PG_DATABASE:=velexis}"
: "${STORAGE_DIR:=/var/lib/velexis/storage}"
: "${REDIS_AOF_DIR:=/var/lib/redis/appendonlydir}"
export RCLONE_CONFIG="${RCLONE_CONFIG:-/etc/velexis/backup/rclone.conf}"

APP_UNITS="velexis-portal velexis-platform-admin velexis-ota-admin velexis-platform-api velexis-ota-api velexis-platform-worker velexis-ota-worker"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
usage() { sed -n '2,20p' "$0"; exit 2; }
psql_admin() { runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 "$@"; }

[ "$(id -u)" -eq 0 ] || die "run as root"
CMD="${1:-}"; [ -n "$CMD" ] || usage; shift

DIR=""; IDENTITY=""; TARGET=""; REPLACE_LIVE=0
if [ "$CMD" != "list" ] && [ "$CMD" != "fetch" ]; then
  DIR="${1:-}"; [ -d "$DIR" ] || die "backup directory not found: $DIR"; shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --identity) IDENTITY="$2"; shift 2 ;;
      --target) TARGET="$2"; shift 2 ;;
      --replace-live) REPLACE_LIVE=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  [ -f "$IDENTITY" ] || die "--identity <age private key file> is required"
  ( cd "$DIR" && grep -E '^[0-9a-f]{64}  ' MANIFEST.txt | sha256sum --quiet -c - ) || die "checksums in $DIR/MANIFEST.txt do not match"
fi

decrypt() { age -d -i "$IDENTITY" "$1"; }

confirm_live() {
  printf 'This REPLACES live data on %s. Type the hostname to continue: ' "$(hostname)"
  read -r answer
  [ "$answer" = "$(hostname)" ] || die "aborted"
}

restore_db() { # target database name
  local db="$1"
  log "restore database into $db"
  psql_admin -d postgres -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)"
  psql_admin -d postgres -c "CREATE DATABASE \"$db\" OWNER velexis_migrator ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0"
  decrypt "$DIR/velexis-db.dump.age" > "/var/backups/velexis/restore-$db.dump"
  chown postgres "/var/backups/velexis/restore-$db.dump"
  runuser -u postgres -- pg_restore --exit-on-error --jobs 4 --dbname "$db" "/var/backups/velexis/restore-$db.dump"
  shred -u "/var/backups/velexis/restore-$db.dump"
}

check_db() { # database name: prints the sanity figures used by the restore drill
  local db="$1"
  psql_admin -d "$db" -At <<'SQL'
SELECT 'tenants=' || count(*) FROM platform.tenants;
SELECT 'tenant_schemas=' || count(*) FROM pg_namespace WHERE nspname LIKE 'tenant\_%';
SELECT 'reference_airports=' || count(*) FROM reference.airports;
SELECT 'last_audit_at=' || coalesce(max(created_at)::text, 'none') FROM platform.platform_audit_log;
SQL
}

case "$CMD" in
  list)
    rclone lsf "$RCLONE_REMOTE/daily" --dirs-only
    rclone lsf "$RCLONE_REMOTE/monthly" --dirs-only ;;
  fetch)
    [ $# -eq 2 ] || usage
    mkdir -p "$2"
    rclone copy "$RCLONE_REMOTE/$1" "$2"
    log "fetched $1 into $2" ;;
  db)
    if [ "$REPLACE_LIVE" -eq 1 ]; then
      confirm_live
      # shellcheck disable=SC2086
      systemctl stop $APP_UNITS
      restore_db "$PG_DATABASE"
      check_db "$PG_DATABASE"
      log "database replaced. Start the apps with: sudo /usr/local/sbin/velexis-deploy --status, then systemctl start <units>"
    else
      restore_db "${TARGET:-velexis_restore}"
      check_db "${TARGET:-velexis_restore}"
    fi ;;
  storage)
    if [ "$REPLACE_LIVE" -eq 1 ]; then
      confirm_live
      mv "$STORAGE_DIR" "$STORAGE_DIR.before-restore-$(date -u +%s)"
      decrypt "$DIR/storage.tar.zst.age" | zstd -dq | tar -C "$(dirname "$STORAGE_DIR")" -xf -
    else
      mkdir -p /var/backups/velexis/storage.restore
      decrypt "$DIR/storage.tar.zst.age" | zstd -dq | tar -C /var/backups/velexis/storage.restore -xf -
      log "storage unpacked into /var/backups/velexis/storage.restore"
    fi ;;
  redis)
    confirm_live
    systemctl stop redis-server
    mv "$REDIS_AOF_DIR" "$REDIS_AOF_DIR.before-restore-$(date -u +%s)"
    decrypt "$DIR/redis-aof.tar.zst.age" | zstd -dq | tar -C "$(dirname "$REDIS_AOF_DIR")" -xf -
    chown -R redis:redis "$REDIS_AOF_DIR"
    systemctl start redis-server
    log "redis restored" ;;
  config)
    mkdir -p /root/velexis-config.restore
    decrypt "$DIR/config.tar.zst.age" | zstd -dq | tar -C /root/velexis-config.restore -xf -
    log "config unpacked into /root/velexis-config.restore (compare, then copy what you need into /etc/velexis)" ;;
  drill)
    db="velexis_drill_$(date -u +%Y%m%d)"
    restore_db "$db"
    check_db "$db" | tee "/var/log/velexis/restore-drill-$(date -u +%F).log"
    psql_admin -d postgres -c "DROP DATABASE \"$db\" WITH (FORCE)"
    log "drill OK: compare the figures above with the MANIFEST and the live database" ;;
  *) usage ;;
esac
