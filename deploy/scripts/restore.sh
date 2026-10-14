#!/usr/bin/env bash
# =====================================================================================================
# restore.sh — fetch, decrypt and restore Velexis backups made by backup.sh (ADR-0007).
# Root-owned copy: /usr/local/sbin/velexis-restore. Runbook: docs/mvp/deployment-single-vm.md §10–§11.
# Tested by deploy/scripts/test/backup-restore.test.sh (X-024); the restore drill on a scratch VM is X-031.
# The age PRIVATE keys are brought to the VM only for the restore (e.g. /root/restore/data.key), then deleted with
# `shred -u`.
#
# Commands:
#   velexis-restore list                                         list backups on the remote
#   velexis-restore fetch <daily/YYYY-MM-DD|monthly/YYYY-MM> <dir>   download one backup set and check its MANIFEST
#   velexis-restore db <dir> --identity <key> [--target <db>]    restore the dump into <db> (default: velexis_restore,
#                                                                a scratch database; the live one is untouched)
#   velexis-restore db <dir> --identity <key> --replace-live     replace the LIVE database: restore into a staging
#                                                                database and check it first; only then stop the
#                                                                apps and swap names (old one kept as
#                                                                <db>_before_restore_<stamp> for rollback)
#   velexis-restore storage <dir> --identity <key> [--replace-live]   unpack beside, or replace the live folder
#                                                                (old one kept as <folder>.before-restore-<stamp>)
#   velexis-restore redis <dir> --identity <key>                 replace Redis data (stops Redis briefly)
#   velexis-restore config <dir> --identity <config-key>         unpack /etc/velexis into /root/velexis-config.restore
#   velexis-restore drill <dir> --identity <key>                 restore into a scratch db, run checks, drop it
#
# Every command but list and fetch first checks the set's files against the SHA-256 lines of its MANIFEST.txt, and
# age refuses a file that was changed or encrypted to another key. pg_restore reads the dump straight from age, so no
# decrypted copy of the database is ever written to disk (it restores with one job). A failed `db` or `drill` drops
# the database it was restoring into, never the live one; a failed `storage --replace-live` or `redis` removes its
# staging folder and leaves the live folder as it was.
#
# Overrides for tests and development machines (deploy/scripts/test/backup-restore.test.sh); the VM keeps the
# defaults:
#   PG_DATABASE         the live database (default velexis)
#   BACKUP_DIR          local folder of backup.sh; `storage` unpacks into $BACKUP_DIR/storage.restore
#   STORAGE_DIR         document storage (default /var/lib/velexis/storage)
#   REDIS_AOF_DIR       the Redis AOF directory (default /var/lib/redis/appendonlydir)
#   CONFIG_RESTORE_DIR  where `config` unpacks (default /root/velexis-config.restore)
#   LOG_DIR             where `drill` writes its log (default /var/log/velexis)
#   SYSTEMCTL           the systemctl to call (default systemctl)
#   PG_RUNAS            the command prefix of psql and pg_restore (default `runuser -u postgres --`). `env` runs
#                       them as the calling user with the PG* environment; only with another PG_RUNAS may the
#                       script run without root.
# =====================================================================================================
set -euo pipefail
umask 077

if [ -z "${RCLONE_REMOTE:-}" ] && [ -f /etc/velexis/backup.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/velexis/backup.env
  set +a
fi
DEFAULT_PG_RUNAS="runuser -u postgres --"
: "${PG_DATABASE:=velexis}"
: "${PG_RUNAS:=$DEFAULT_PG_RUNAS}"
: "${BACKUP_DIR:=/var/backups/velexis}"
: "${STORAGE_DIR:=/var/lib/velexis/storage}"
: "${REDIS_AOF_DIR:=/var/lib/redis/appendonlydir}"
: "${CONFIG_RESTORE_DIR:=/root/velexis-config.restore}"
: "${LOG_DIR:=/var/log/velexis}"
: "${SYSTEMCTL:=systemctl}"
export RCLONE_CONFIG="${RCLONE_CONFIG:-/etc/velexis/backup/rclone.conf}"
read -r -a PG_RUNAS_CMD <<<"$PG_RUNAS"

APP_UNITS=(velexis-portal velexis-platform-admin velexis-ota-admin velexis-platform-api velexis-ota-api
  velexis-platform-worker velexis-ota-worker)

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
usage() { sed -n '/^# Commands:/,/^# *$/p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
psql_admin() { "${PG_RUNAS_CMD[@]}" psql -X -w -v ON_ERROR_STOP=1 "$@"; }
db_name_ok() { [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }
drop_db() { # database (a scratch, staging or drill database, never the live one): dropped with its sessions
  # A PG_RUNAS without superuser rights (the test) cannot terminate an autovacuum worker, so DROP ... WITH (FORCE)
  # fails while one is in the freshly restored database ("permission denied to terminate process"). The plain DROP
  # stops autovacuum workers itself and waits up to 5 s for sessions that are already ending.
  local sql="DROP DATABASE IF EXISTS \"$1\""
  psql_admin -q -d postgres -c 'SET client_min_messages = warning' -c "$sql WITH (FORCE)" 2>/dev/null \
    || psql_admin -q -d postgres -c 'SET client_min_messages = warning' -c "$sql"
}

if [ "$(id -u)" -ne 0 ] && [ "$PG_RUNAS" = "$DEFAULT_PG_RUNAS" ]; then die "run as root"; fi
db_name_ok "$PG_DATABASE" || die "PG_DATABASE must be a plain database name"
CMD="${1:-}"
case "$CMD" in list | fetch | db | storage | redis | config | drill) shift ;; *) usage ;; esac

# What a failed run leaves behind is cleaned up here: the scratch or staging database it created, the staging
# folder of a storage or Redis restore. The live database and folders are never touched by this.
CREATED_DB=""
CREATED_DIR=""
STAGE=""
APPS_STOPPED=0
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ -n "$CREATED_DB" ]; then
      log "dropping $CREATED_DB, which this failed run created"
      drop_db "$CREATED_DB" >/dev/null 2>&1 || log "WARNING: could not drop $CREATED_DB; drop it by hand"
    fi
    if [ -n "$CREATED_DIR" ]; then
      log "removing $CREATED_DIR, which this failed run created"
      rm -rf --one-file-system "$CREATED_DIR" || log "WARNING: could not remove $CREATED_DIR"
    fi
    case "$CMD" in
      db | drill) log "restore $CMD failed; the live database $PG_DATABASE is unchanged" ;;
      *) log "restore $CMD failed (see the messages above)" ;;
    esac
    if [ "$APPS_STOPPED" = 1 ]; then
      log "the app units are stopped; start them again: systemctl start ${APP_UNITS[*]}"
    fi
  fi
  exit "$rc"
}
trap on_exit EXIT

verify_manifest() { # dir: every SHA-256 line of MANIFEST.txt matches
  [ -f "$1/MANIFEST.txt" ] || die "no MANIFEST.txt in $1"
  ( cd "$1" && grep -E '^[0-9a-f]{64}  ' MANIFEST.txt | sha256sum --quiet --strict -c - ) \
    || die "checksums in $1/MANIFEST.txt do not match"
}

DIR=""; IDENTITY=""; TARGET=""; REPLACE_LIVE=0
if [ "$CMD" != "list" ] && [ "$CMD" != "fetch" ]; then
  DIR="${1:-}"; [ -d "$DIR" ] || die "backup directory not found: $DIR"; shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --identity) IDENTITY="${2:-}"; shift 2 ;;
      --target) TARGET="${2:-}"; shift 2 ;;
      --replace-live) REPLACE_LIVE=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  [ -f "$IDENTITY" ] || die "--identity <age private key file> is required"
  verify_manifest "$DIR"
fi

decrypt() { # file of the set: only one that its MANIFEST lists, decrypted to stdout
  awk -v f="./$(basename "$1")" '$1 ~ /^[0-9a-f]+$/ && length($1) == 64 && $2 == f { found = 1 } END { exit !found }' \
    "$DIR/MANIFEST.txt" || die "$(basename "$1") is not listed in $DIR/MANIFEST.txt"
  age -d -i "$IDENTITY" "$1"
}

confirm_live() {
  printf 'This REPLACES live data on %s. Type the hostname to continue: ' "$(hostname)"
  read -r answer || answer=""
  [ "$answer" = "$(hostname)" ] || die "aborted"
}

apply_db_grants() { # database-level ACLs of deploy/postgres/bootstrap.sql: pg_dump without --create omits them
  local db="$1"
  psql_admin -q -d postgres <<SQL
REVOKE ALL ON DATABASE "$db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE "$db" TO velexis_platform_app, velexis_ota_app;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE "$db" TO velexis_provisioner;
GRANT ALL ON DATABASE "$db" TO velexis_migrator;
SQL
}

restore_db() { # target database name; never the live database (see `db --replace-live`)
  local db="$1"
  db_name_ok "$db" || die "not a plain database name: $db"
  case "$db" in
    "$PG_DATABASE" | postgres | template0 | template1 | "${PG_DATABASE}_before_restore_"*)
      die "refusing to restore over $db; the live database is replaced only with --replace-live" ;;
  esac
  log "restore database into $db"
  drop_db "$db"
  psql_admin -q -d postgres -c "CREATE DATABASE \"$db\" OWNER velexis_migrator ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0"
  CREATED_DB="$db"
  apply_db_grants "$db"
  decrypt "$DIR/velexis-db.dump.age" | "${PG_RUNAS_CMD[@]}" pg_restore --exit-on-error --no-password --dbname "$db"
}

check_db() { # database name: prints the sanity figures used by the restore drill (also in the set's MANIFEST)
  local db="$1"
  psql_admin -d "$db" -At <<'SQL'
SELECT 'tenants=' || count(*) FROM platform.tenants;
SELECT 'tenant_schemas=' || count(*) FROM pg_namespace WHERE nspname LIKE 'tenant\_%';
SELECT 'reference_airports=' || count(*) FROM reference.airports;
SELECT 'last_audit_at=' || coalesce(max(created_at)::text, 'none') FROM platform.platform_audit_log;
SQL
}

unpack_beside() { # archive live-folder: unpacks the archive into a staging folder ($STAGE) next to live-folder
  local archive="$1" live="$2" stage
  stage="$(dirname "$live")/.restore-$(basename "$live")-$(date -u +%Y%m%d%H%M%S)"
  mkdir -m 0700 "$stage"
  CREATED_DIR="$stage"
  decrypt "$archive" | zstd -dq | tar -C "$stage" -xf -
  [ -d "$stage/$(basename "$live")" ] || die "$(basename "$archive") holds no $(basename "$live") folder"
  STAGE="$stage"
}

swap_in() { # live-folder: moves the live folder aside and the unpacked one (unpack_beside) into its place
  local live="$1" before
  before="$live.before-restore-$(date -u +%Y%m%d%H%M%S)"
  if [ -e "$live" ]; then mv "$live" "$before"; fi
  if ! mv "$STAGE/$(basename "$live")" "$live"; then
    if [ -e "$before" ]; then mv "$before" "$live"; fi
    die "could not move the restored $(basename "$live") into place; the live folder is back as it was"
  fi
  rmdir "$STAGE"
  CREATED_DIR=""
  log "$live replaced; the previous one is kept as $before"
}

case "$CMD" in
  list)
    log "daily sets on $RCLONE_REMOTE:"
    rclone lsf "$RCLONE_REMOTE/daily" --dirs-only
    log "monthly sets:"
    rclone lsf "$RCLONE_REMOTE/monthly" --dirs-only 2>/dev/null || log "none" ;;
  fetch)
    [ $# -eq 2 ] || usage
    [[ "$1" =~ ^(daily|monthly)/[0-9A-Za-z-]+$ ]] || die "not a set name (daily/<date> or monthly/<month>): $1"
    mkdir -p "$2"
    rclone copy "$RCLONE_REMOTE/$1" "$2"
    verify_manifest "$2"
    log "fetched $1 into $2 (checksums match its MANIFEST)" ;;
  db)
    if [ "$REPLACE_LIVE" -eq 1 ]; then
      [ -z "$TARGET" ] || die "--target and --replace-live exclude each other"
      confirm_live
      stamp="$(date -u +%Y%m%d%H%M%S)"
      staging="${PG_DATABASE}_restore_${stamp}"
      before="${PG_DATABASE}_before_restore_${stamp}"
      db_name_ok "$before" || die "PG_DATABASE is too long for $before (63 characters at most)"
      # 1. Restore and check beside the live database. Any failure here (wrong key, corrupt file, full disk,
      #    pg_restore error) stops the script with the live database untouched, the apps running, and the staging
      #    database dropped.
      restore_db "$staging"
      check_db "$staging"
      # 2. Only now stop the apps and swap the names in one transaction. Client sessions left on either database
      #    are terminated; autovacuum workers are stopped by the RENAME itself (a PG_RUNAS without superuser
      #    rights could not terminate them).
      APPS_STOPPED=1
      "$SYSTEMCTL" stop "${APP_UNITS[@]}"
      psql_admin -q -d postgres <<SQL
SELECT count(pg_terminate_backend(pid, 5000)) AS terminated FROM pg_stat_activity
 WHERE datname IN ('$PG_DATABASE', '$staging') AND backend_type = 'client backend' AND pid <> pg_backend_pid() \gset
BEGIN;
ALTER DATABASE "$PG_DATABASE" RENAME TO "$before";
ALTER DATABASE "$staging" RENAME TO "$PG_DATABASE";
COMMIT;
SQL
      CREATED_DB=""
      APPS_STOPPED=0
      log "database replaced; the previous one is kept as $before."
      log "rollback: stop the apps, rename $PG_DATABASE away and $before back to $PG_DATABASE (deployment-single-vm.md §11)."
      log "start the apps with the Deploy workflow, or: systemctl start ${APP_UNITS[*]}. Drop $before after the checks."
    else
      target="${TARGET:-${PG_DATABASE}_restore}"
      restore_db "$target"
      check_db "$target"
      CREATED_DB=""
      log "restored into $target; the live database $PG_DATABASE is untouched"
    fi ;;
  storage)
    if [ "$REPLACE_LIVE" -eq 1 ]; then
      confirm_live
      unpack_beside "$DIR/storage.tar.zst.age" "$STORAGE_DIR"
      swap_in "$STORAGE_DIR"
    else
      mkdir -p "$BACKUP_DIR/storage.restore"
      decrypt "$DIR/storage.tar.zst.age" | zstd -dq | tar -C "$BACKUP_DIR/storage.restore" -xf -
      log "storage unpacked into $BACKUP_DIR/storage.restore"
    fi ;;
  redis)
    confirm_live
    unpack_beside "$DIR/redis-aof.tar.zst.age" "$REDIS_AOF_DIR"
    "$SYSTEMCTL" stop redis-server
    swap_in "$REDIS_AOF_DIR"
    chown -R redis:redis "$REDIS_AOF_DIR"
    "$SYSTEMCTL" start redis-server
    log "redis restored" ;;
  config)
    mkdir -p "$CONFIG_RESTORE_DIR"
    decrypt "$DIR/config.tar.zst.age" | zstd -dq | tar -C "$CONFIG_RESTORE_DIR" -xf -
    log "config unpacked into $CONFIG_RESTORE_DIR (compare, then copy what you need into /etc/velexis)" ;;
  drill)
    db="${PG_DATABASE}_drill_$(date -u +%Y%m%d)"
    drill_log="$LOG_DIR/restore-drill-$(date -u +%F).log"
    mkdir -p "$LOG_DIR"
    restore_db "$db"
    figures="$(check_db "$db")"
    printf '%s\n' "$figures" | tee "$drill_log"
    drop_db "$db"
    CREATED_DB=""
    if [ "$figures" = "$(grep -E '^(tenants|tenant_schemas|reference_airports|last_audit_at)=' "$DIR/MANIFEST.txt")" ]; then
      log "drill OK: the figures above match the set's MANIFEST.txt; compare them with the live database too" | tee -a "$drill_log"
    else
      log "drill restored, but the figures differ from the set's MANIFEST.txt (a write during the backup?):" | tee -a "$drill_log"
      grep -E '^(tenants|tenant_schemas|reference_airports|last_audit_at)=' "$DIR/MANIFEST.txt" | tee -a "$drill_log"
    fi ;;
  *) usage ;;
esac
