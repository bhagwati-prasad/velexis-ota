#!/usr/bin/env bash
# =====================================================================================================
# backup.sh — nightly encrypted backup of the Velexis VM, copied off the VM (ADR-0007).
# Root-owned copy: /usr/local/sbin/velexis-backup, run by velexis-backup.service (timer 02:30 UTC).
# Settings: /etc/velexis/backup.env (deploy/env/backup.env.example). Docs: docs/mvp/deployment-single-vm.md §10.
# Manual run: sudo systemctl start velexis-backup   (or: sudo /usr/local/sbin/velexis-backup)
#
# Produces, per run, in $BACKUP_DIR/<UTC stamp>/ and then in <remote>/daily/<YYYY-MM-DD>/ (and monthly/<YYYY-MM>/
# on the 1st of the month):
#   velexis-db.dump.age        pg_dump --format=custom of the whole database (platform, reference, tenant_*)
#   globals.sql.age            roles and grants without passwords (pg_dumpall --globals-only --no-role-passwords)
#   storage.tar.zst.age        /var/lib/velexis/storage (documents, exports)
#   redis-aof.tar.zst.age      the Redis AOF directory (queues, schedules; PostgreSQL stays the record)
#   config.tar.zst.age         /etc/velexis incl. the master key, encrypted to a DIFFERENT age key
#   MANIFEST.txt               sizes, SHA-256 of the encrypted files, versions and the figures that the restore
#                              drill prints (no secrets)
# Every file is encrypted with `age` to public keys whose private halves are kept OFF the VM. The script refuses to
# run when the data and config recipients share a key, or when a private age key is in a recipients file or
# anywhere in /etc/velexis. An uploaded set is never replaced (rclone --immutable): a second run on the same day
# goes to <remote>/daily/<UTC stamp>/ beside the first one.
# Off-VM retention (14 daily, 6 monthly) is enforced by the bucket's lifecycle rules and object lock, not here:
# the VM's bucket key can put, list and read, but never delete (deployment-single-vm.md §10), and this script
# never removes anything remotely. A root compromise of the VM therefore cannot destroy the off-site copies.
#
# Overrides for tests and development machines (deploy/scripts/test/backup-restore.test.sh); the VM keeps the
# defaults:
#   PG_DATABASE      the database to dump (default velexis)
#   BACKUP_DIR       local staging folder (default /var/backups/velexis)
#   STORAGE_DIR      document storage (default /var/lib/velexis/storage)
#   REDIS_AOF_DIR    the Redis AOF directory (default /var/lib/redis/appendonlydir)
#   SKIP_REDIS=1     no Redis archive (machines without an AOF directory); the MANIFEST says redis=skipped
#   CONFIG_DIR       the configuration folder (default /etc/velexis)
#   PG_RUNAS         the command prefix of pg_dump, pg_dumpall and psql (default `runuser -u postgres --`: peer
#                    authentication as the superuser). `env` runs them as the calling user with the PG* environment
#                    (PGHOST, PGUSER, PGPASSFILE, ...); only with another PG_RUNAS may the script run without root.
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
: "${BACKUP_DIR:=/var/backups/velexis}"
: "${AGE_RECIPIENTS_FILE:?set in /etc/velexis/backup.env}"
: "${AGE_CONFIG_RECIPIENTS_FILE:?set in /etc/velexis/backup.env}"
: "${RCLONE_CONFIG:?set in /etc/velexis/backup.env}"
: "${RCLONE_REMOTE:?set in /etc/velexis/backup.env}"
: "${RETENTION_LOCAL_DAYS:=2}"
: "${PG_DATABASE:=velexis}"
: "${PG_RUNAS:=$DEFAULT_PG_RUNAS}"
: "${REDIS_AOF_DIR:=/var/lib/redis/appendonlydir}"
: "${SKIP_REDIS:=0}"
: "${STORAGE_DIR:=/var/lib/velexis/storage}"
: "${CONFIG_DIR:=/etc/velexis}"
: "${BACKUP_MARKER_FILE:=/var/lib/velexis/backup-last-success}"
export RCLONE_CONFIG
read -r -a PG_RUNAS_CMD <<<"$PG_RUNAS"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
pg() { "${PG_RUNAS_CMD[@]}" "$@"; } # a PostgreSQL client tool, as PG_RUNAS
age_keys() { grep -oE '^age1[0-9a-z]+' "$1" | sort -u || true; } # the age1 public keys of a recipients file
PRIVATE_KEY_RE='AGE-SECRET-KEY-1[0-9A-Z]{58}' # an age private key, as age-keygen writes it
only_public_keys() { # recipients file: 0 when every line is an age1 key, a comment or empty
  awk '!/^[[:space:]]*(#|$)/ && !/^age1[0-9a-z]+[[:space:]]*$/ { bad = 1 } END { exit bad }' "$1"
}

if [ "$(id -u)" -ne 0 ] && [ "$PG_RUNAS" = "$DEFAULT_PG_RUNAS" ]; then die "run as root"; fi
[[ "$RETENTION_LOCAL_DAYS" =~ ^[0-9]{1,3}$ ]] || die "RETENTION_LOCAL_DAYS must be a number of days"
[[ "$PG_DATABASE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "PG_DATABASE must be a plain database name"

# ---- 0. Keys: public halves only, two different keys, no private key on the VM -------------------------------
for f in "$AGE_RECIPIENTS_FILE" "$AGE_CONFIG_RECIPIENTS_FILE"; do
  [ -r "$f" ] || die "cannot read $f (see deployment-single-vm.md §10)"
  if grep -qE "$PRIVATE_KEY_RE" "$f"; then
    die "$f holds a PRIVATE age key: only public keys (age1...) belong on the VM"
  fi
  [ -n "$(age_keys "$f")" ] || die "no age public key in $f (see deployment-single-vm.md §10)"
  only_public_keys "$f" || die "$f may hold only age1 public keys, comments and empty lines"
done
if [ -n "$(comm -12 <(age_keys "$AGE_RECIPIENTS_FILE") <(age_keys "$AGE_CONFIG_RECIPIENTS_FILE"))" ]; then
  die "data and config backups must use different age keys: $AGE_CONFIG_RECIPIENTS_FILE shares a key with $AGE_RECIPIENTS_FILE"
fi
if grep -rqsE "$PRIVATE_KEY_RE" "$CONFIG_DIR"; then
  die "a PRIVATE age key is in $CONFIG_DIR: remove it with shred -u (private keys stay off the VM)"
fi
if [ "$SKIP_REDIS" != 1 ] && [ ! -d "$REDIS_AOF_DIR" ]; then
  die "no Redis AOF directory $REDIS_AOF_DIR (SKIP_REDIS=1 skips Redis)"
fi

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
DAY="${STAMP%%T*}"
MONTH="${DAY%-*}"
WORK="$BACKUP_DIR/$STAMP"
mkdir -p "$BACKUP_DIR"
mkdir "$WORK"
log "backup $STAMP of $PG_DATABASE into $WORK"

encrypt_data() { age -R "$AGE_RECIPIENTS_FILE" -o "$1"; }
encrypt_config() { age -R "$AGE_CONFIG_RECIPIENTS_FILE" -o "$1"; }

# ---- 1. PostgreSQL ---------------------------------------------------------------------------------------
# The figures that restore.sh's check_db prints, taken just before the dump (a write in between, such as an audit
# entry, shows as a difference of that write). A database that has no platform tables yet (a backup before the
# first deploy) gets "none".
FIGURES="$(pg psql -X -w -q -At -v ON_ERROR_STOP=1 -d "$PG_DATABASE" <<'SQL'
SELECT to_regclass('platform.tenants') IS NOT NULL AND to_regclass('reference.airports') IS NOT NULL
   AND to_regclass('platform.platform_audit_log') IS NOT NULL AS migrated \gset
\if :migrated
SELECT 'tenants=' || count(*) FROM platform.tenants;
SELECT 'tenant_schemas=' || count(*) FROM pg_namespace WHERE nspname LIKE 'tenant\_%';
SELECT 'reference_airports=' || count(*) FROM reference.airports;
SELECT 'last_audit_at=' || coalesce(max(created_at)::text, 'none') FROM platform.platform_audit_log;
\else
SELECT 'tenants=none';
SELECT 'tenant_schemas=' || count(*) FROM pg_namespace WHERE nspname LIKE 'tenant\_%';
SELECT 'reference_airports=none';
SELECT 'last_audit_at=none';
\endif
SQL
)"
PG_VERSION="$(pg psql -X -w -At -v ON_ERROR_STOP=1 -d "$PG_DATABASE" -c 'SHOW server_version')"
log "pg_dump $PG_DATABASE"
pg pg_dump -w --format=custom --compress=zstd:3 "$PG_DATABASE" | encrypt_data "$WORK/velexis-db.dump.age"
pg pg_dumpall -w --globals-only --no-role-passwords | encrypt_data "$WORK/globals.sql.age"

# ---- 2. File storage -------------------------------------------------------------------------------------
log "storage $STORAGE_DIR"
tar -C "$(dirname "$STORAGE_DIR")" -cf - "$(basename "$STORAGE_DIR")" | zstd -q -T0 | encrypt_data "$WORK/storage.tar.zst.age"

# ---- 3. Redis AOF (copy only while no AOF rewrite is running) ---------------------------------------------
redis_rewrite_in_progress() { # prints 0 or 1, or nothing when Redis does not answer
  REDISCLI_AUTH="${REDIS_PASSWORD:-}" redis-cli -h 127.0.0.1 INFO persistence 2>/dev/null \
    | tr -d '\r' | sed -n 's/^aof_rewrite_in_progress:\([01]\)$/\1/p' || true
}
tar_aof() { # the incr file grows every second: GNU tar's exit 1 ("file changed as we read it") is expected
  local rc=0
  tar --warning=no-file-changed -C "$(dirname "$REDIS_AOF_DIR")" -cf - "$(basename "$REDIS_AOF_DIR")" || rc=$?
  [ "$rc" -le 1 ] || return "$rc"
}
if [ "$SKIP_REDIS" = 1 ]; then
  log "redis AOF skipped (SKIP_REDIS=1)"
  REDIS_STATE=skipped
else
  log "redis AOF $REDIS_AOF_DIR"
  rewrite=""
  for _ in $(seq 1 60); do
    rewrite="$(redis_rewrite_in_progress)"
    [ "$rewrite" = 1 ] || break
    sleep 2
  done
  case "$rewrite" in
    0) ;;
    1) log "WARNING: an AOF rewrite has been running for 2 minutes; copying the AOF directory anyway" ;;
    *) log "WARNING: Redis did not answer INFO persistence; copying the AOF directory as it is" ;;
  esac
  tar_aof | zstd -q -T0 | encrypt_data "$WORK/redis-aof.tar.zst.age"
  REDIS_STATE=included
fi

# ---- 4. /etc/velexis (master key, env files) — separate key -----------------------------------------------
log "config $CONFIG_DIR"
tar -C "$(dirname "$CONFIG_DIR")" -cf - "$(basename "$CONFIG_DIR")" | zstd -q -T0 | encrypt_config "$WORK/config.tar.zst.age"

# ---- 5. Manifest -------------------------------------------------------------------------------------------
{
  echo "created_at=$STAMP"
  echo "host=$(hostname)"
  echo "release=$(basename "$(readlink -f /srv/velexis/current 2>/dev/null || echo none)")"
  echo "postgres=$PG_VERSION"
  echo "database=$PG_DATABASE"
  echo "$FIGURES"
  echo "redis=$REDIS_STATE"
  ( cd "$WORK" && sha256sum ./*.age && du -b ./*.age )
} > "$WORK/MANIFEST.txt"

# ---- 6. Upload off the VM and verify ---------------------------------------------------------------------
# A set already in daily/<day>/ (an earlier run today) stays as it is; this run then goes to daily/<stamp>/. The
# monthly copy is made once per month.
remote_has_dir() { # parent name: 0 when <remote>/<parent>/<name>/ exists
  local list
  list="$(rclone lsf --dirs-only "$RCLONE_REMOTE/$1" 2>/dev/null)" || return 1
  grep -qxF "$2/" <<<"$list"
}
DEST="daily/$DAY"
if remote_has_dir daily "$DAY"; then
  DEST="daily/$STAMP"
  log "$RCLONE_REMOTE/daily/$DAY already holds a set from today; this one goes beside it"
fi
log "upload to $RCLONE_REMOTE/$DEST"
rclone copy "$WORK" "$RCLONE_REMOTE/$DEST" --immutable --retries 5
rclone check "$WORK" "$RCLONE_REMOTE/$DEST" --one-way
if [ "${DAY##*-}" = "01" ]; then # the day of the run's stamp, also when the upload ends after midnight
  if remote_has_dir monthly "$MONTH"; then
    log "$RCLONE_REMOTE/monthly/$MONTH already holds this month's set"
  else
    log "monthly copy $RCLONE_REMOTE/monthly/$MONTH"
    rclone copy "$WORK" "$RCLONE_REMOTE/monthly/$MONTH" --immutable --retries 5
    rclone check "$WORK" "$RCLONE_REMOTE/monthly/$MONTH" --one-way
  fi
fi

# ---- 7. Local retention only (the bucket expires remote copies itself) ---------------------------------------
# Only set folders (<UTC stamp>) are pruned; anything else in BACKUP_DIR (a restore in progress) stays.
log "local retention: ${RETENTION_LOCAL_DAYS}d"
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d \
  -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z' \
  -mtime +"$RETENTION_LOCAL_DAYS" -exec rm -rf --one-file-system {} +

date -u +%s > "$BACKUP_MARKER_FILE"
log "backup $STAMP done in ${SECONDS}s: $RCLONE_REMOTE/$DEST ($(du -sh "$WORK" | cut -f1))"
