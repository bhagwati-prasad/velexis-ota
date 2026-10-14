#!/usr/bin/env bash
# =====================================================================================================
# backup-restore.test.sh — tests deploy/scripts/backup.sh (velexis-backup) and restore.sh (velexis-restore) against
# the local development PostgreSQL, without a VM, a bucket or systemd (task X-024).
#
#   bash deploy/scripts/test/backup-restore.test.sh
#
# Needs a checkout after `pnpm install` (the test builds @velexis/db and runs its migration CLI), the local
# PostgreSQL 16 of docs/mvp/local-development.md with the roles of deploy/postgres/bootstrap.sql and
# velexis_test_admin, and on PATH: age and age-keygen (1.x), rclone (1.6x), zstd, the PostgreSQL 16 client tools
# (psql, pg_dump, pg_dumpall, pg_restore), node, pnpm, and GNU coreutils, tar and findutils. Redis is optional: with
# REDIS_URL, backup.sh asks it whether an AOF rewrite is running; without it, backup.sh warns and goes on. It runs as
# any user, and refuses to run where /etc/velexis exists (a provisioned VM).
# TEST_DATABASE_ADMIN_URL and DATABASE_MIGRATOR_URL (and REDIS_URL) come from the environment, else from the
# repository's .env.local (cp .env.example .env.local). They are never printed.
#
# Both scripts run exactly as they are, with the overrides of their headers:
#   PG_RUNAS=env     pg_dump, pg_dumpall, pg_restore and psql run as velexis_test_admin through PGHOST, PGPORT,
#                    PGUSER and a temporary PGPASSFILE (on the VM: runuser -u postgres --)
#   PG_DATABASE      scratch databases velexis_bkt_<run>_*: the source is made like the local development database
#                    (the Database section of bootstrap.sql, schemas.sql, the platform and reference migrations, two
#                    tenant schemas created by the migration CLI, a few rows); all are dropped at the end
#   BACKUP_DIR, STORAGE_DIR, REDIS_AOF_DIR, CONFIG_DIR, BACKUP_MARKER_FILE, CONFIG_RESTORE_DIR, LOG_DIR
#                    folders under a temporary folder: a fake /etc/velexis (the deploy/env templates as provisioning
#                    installs them, random stand-in keys and env values) and fake storage and AOF files
#   SYSTEMCTL        a stand-in that only records its arguments
# (and, for the two monthly runs only, a `date` stand-in first on PATH that moves backup.sh's run stamp to the 1st of
# a month).
# Two age key pairs are made with age-keygen (the "offline" private keys stay outside the fake /etc/velexis), and
# the bucket is an rclone remote of type `local` (a temporary folder, through a temporary RCLONE_CONFIG). The rclone
# on PATH is a wrapper that records every call and refuses, and records, every subcommand other than copy, check
# and lsf, and every --delete* flag: like the VM's bucket key, it cannot delete, and any refused call fails the test.
#
# Cases (docs/mvp/plans/foundation-tasks.md, X-024 step 2); every check ends with [X-024 AC1]:
#    1. backup.sh: the five .age files and MANIFEST.txt locally (0700/0600) and byte for byte in
#       <remote>/daily/<day>/; data files open with the data key only, the config file with the config key only;
#       the MANIFEST's checksums, sizes and figures; globals without passwords; the marker file; local retention
#       prunes only old set folders;
#    2. restore.sh list, fetch and drill: the fetched set restores into a scratch database whose figures equal the
#       source database's and the MANIFEST's, and the drill database is dropped;
#    3. a flipped byte in an .age file is refused, by the MANIFEST check and, with the MANIFEST "fixed", by age;
#    4. no delete on the remote: neither script contains a deleting rclone command, the wrapper refuses one (a
#       self-check before the first run), and a second run on the same day (SKIP_REDIS=1) puts its set beside the
#       first one, leaving every uploaded object (and an old set that only the bucket may expire) as it was; two
#       runs stamped on the 1st of a month (a `date` stand-in) make the monthly copy once and replace nothing;
#    5. backup.sh refuses one key for data and config (an identical file, or one shared key among others), a private
#       key as recipients and a private key in /etc/velexis, before writing or uploading anything;
#    6. restore.sh db --target, and db --replace-live against a scratch "live" database: a wrong hostname, a corrupt
#       .age file (refused by the MANIFEST, and by age), a wrong identity and a failing pg_restore (a truncated dump)
#       each stop the script with the live database unchanged and connectable, no app unit stopped and no staging
#       database left; a good set stops the apps, swaps the names, keeps <db>_before_restore_<stamp> (the old
#       data), and the new database has the source's schema, owners, grants and data and the database-level grants
#       of bootstrap.sql;
#    7. restore.sh storage (beside the live folder, and --replace-live, where a wrong key changes nothing) and config
#       (the data key cannot open it);
#   and over the whole run: no password, stand-in key or private age key in any output, log or MANIFEST, every
#   upload with --immutable, and no rclone call refused.
#
# Settings (environment): BACKUP_TEST_TMPDIR (parent of the temporary folder; default TMPDIR or /tmp),
# BACKUP_TEST_KEEP=1 (keep the temporary folder, with every script output in out/, and the scratch databases).
# =====================================================================================================
set -euo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$HERE/../.." && pwd)" # the deploy/ folder of this checkout
REPO="$(cd "$DEPLOY/.." && pwd)"
BACKUP_SH="$DEPLOY/scripts/backup.sh"
RESTORE_SH="$DEPLOY/scripts/restore.sh"
AGE_FILES="config.tar.zst.age globals.sql.age redis-aof.tar.zst.age storage.tar.zst.age velexis-db.dump.age"
DATA_FILES="globals.sql.age redis-aof.tar.zst.age storage.tar.zst.age velexis-db.dump.age"
APP_UNITS="velexis-portal velexis-platform-admin velexis-ota-admin velexis-platform-api velexis-ota-api velexis-platform-worker velexis-ota-worker"
FIGURE_LINES='^(tenants|tenant_schemas|reference_airports|last_audit_at)='

FAILED=0
LOG_SHOWN=""
LAST_LOG=""
PREFIX=""
pass() { printf 'PASS %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*"
  FAILED=1
  if [ -n "$LAST_LOG" ] && [ "$LOG_SHOWN" != "$LAST_LOG" ] && [ -f "$LAST_LOG" ]; then
    LOG_SHOWN="$LAST_LOG"
    echo "     output of the last script run ($(basename "$LAST_LOG")):"
    sed -e "s#$PREFIX#<tmp>#g" -e 's/^/       /' "$LAST_LOG"
  fi
}
die() { printf 'FAIL %s\n' "$*"; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
check() { # description command... -> one PASS or FAIL line
  local what="$1"
  shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}
not() { ! "$@"; }

for tool in age age-keygen rclone zstd psql pg_dump pg_dumpall pg_restore node pnpm tar sha256sum cmp comm awk od dd \
  find stat hostname diff; do
  command -v "$tool" >/dev/null || die "$tool is missing (see the header of this test)"
done
[ ! -e /etc/velexis ] || die "/etc/velexis exists: this looks like a provisioned Velexis VM; run the test on a development machine"
if [ ! -f "$BACKUP_SH" ] || [ ! -f "$RESTORE_SH" ] || [ ! -f "$REPO/packages/db/package.json" ]; then
  die "run it from a checkout of the repository"
fi

# ---- connection settings (never printed) -------------------------------------------------------------------------
env_value() { # name: from the environment, else from the repository's .env.local
  local name="$1" value
  value="${!name:-}"
  if [ -z "$value" ] && [ -f "$REPO/.env.local" ]; then
    value="$(sed -n "s/^${name}=//p" "$REPO/.env.local" | tail -n 1)"
  fi
  printf '%s' "$value"
}
# shellcheck disable=SC2016 # the single-quoted programs are JavaScript, not shell
url_part() { # url part: host, port, user, password or database of a postgres:// or redis:// URL
  URL_IN="$1" PART="$2" node -e '
    const u = new URL(process.env.URL_IN);
    const parts = {
      host: u.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: u.port || "5432",
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.slice(1)),
    };
    process.stdout.write(parts[process.env.PART] ?? "");'
}
# shellcheck disable=SC2016 # JavaScript, not shell
with_database() { # url database: the URL with another database
  URL_IN="$1" DB_IN="$2" node -e '
    const u = new URL(process.env.URL_IN);
    u.pathname = "/" + process.env.DB_IN;
    process.stdout.write(u.href);'
}
ADMIN_URL="$(env_value TEST_DATABASE_ADMIN_URL)"
MIGRATOR_URL="$(env_value DATABASE_MIGRATOR_URL)"
REDIS_URL_VALUE="$(env_value REDIS_URL)"
[ -n "$ADMIN_URL" ] || die "TEST_DATABASE_ADMIN_URL is not set (environment or .env.local, see .env.example)"
[ -n "$MIGRATOR_URL" ] || die "DATABASE_MIGRATOR_URL is not set (environment or .env.local, see .env.example)"
ADMIN_PASSWORD="$(url_part "$ADMIN_URL" password)"
MIGRATOR_PASSWORD="$(url_part "$MIGRATOR_URL" password)"
REDIS_PASSWORD_VALUE=""
[ -z "$REDIS_URL_VALUE" ] || REDIS_PASSWORD_VALUE="$(url_part "$REDIS_URL_VALUE" password)"

# ---- the temporary folder: a fake VM, the offline keys, the bucket ------------------------------------------------
PREFIX="$(mktemp -d "${BACKUP_TEST_TMPDIR:-${TMPDIR:-/tmp}}/velexis-backup-test.XXXXXX")"
PREFIX="$(cd "$PREFIX" && pwd -P)"
RUN="$(od -An -N4 -tx4 /dev/urandom | tr -d ' \n')"
DB_PREFIX="velexis_bkt_${RUN}_"
SRC="${DB_PREFIX}src"   # the source: made like the local development database
LIVE="${DB_PREFIX}live" # the scratch "live" database of --replace-live
OUT="$PREFIX/out"       # every output of the scripts
STATE="$PREFIX/state"   # logs of the rclone wrapper and the systemctl stand-in
FAKEBIN="$PREFIX/bin"   # rclone wrapper and systemctl stand-in, first on PATH
OFFLINE="$PREFIX/offline"
CONFIG="$PREFIX/etc/velexis"
BUCKET="$PREFIX/bucket/velexis-backups"
SETS="$PREFIX/sets" # altered copies of a set
mkdir -p "$OUT" "$STATE" "$FAKEBIN" "$OFFLINE" "$CONFIG/keys/platform" "$CONFIG/keys/ota" "$CONFIG/backup" "$BUCKET" \
  "$SETS" "$PREFIX/var/lib/velexis" "$PREFIX/var/lib/redis/appendonlydir" "$PREFIX/var/log/velexis"
chmod 0700 "$OFFLINE"
PGPASS="$PREFIX/pgpass"

admin_psql() { psql -X -w -q -v ON_ERROR_STOP=1 "$@"; }
databases() { admin_psql -At -d postgres -c "SELECT datname FROM pg_database WHERE starts_with(datname, '$DB_PREFIX') ORDER BY 1"; }
drop_scratch_databases() {
  local db
  for db in $(databases 2>/dev/null); do
    # velexis_test_admin cannot terminate an autovacuum worker, so WITH (FORCE) fails while one is in the database; the
    # plain DROP stops autovacuum itself (as restore.sh's drop_db does).
    admin_psql -d postgres -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 ||
      admin_psql -d postgres -c "DROP DATABASE IF EXISTS \"$db\"" >/dev/null 2>&1 || echo "could not drop $db"
  done
}
cleanup() {
  local rc=$?
  if [ "${BACKUP_TEST_KEEP:-0}" = 1 ]; then
    echo "BACKUP_TEST_KEEP=1: kept $PREFIX and the databases ${DB_PREFIX}*"
  else
    drop_scratch_databases
    chmod -R u+w "$PREFIX" 2>/dev/null || true
    rm -rf --one-file-system "$PREFIX"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# PostgreSQL: velexis_test_admin, its password in a 0600 pgpass file only.
pgpass_escape() { printf '%s' "$1" | sed 's/[\\:]/\\&/g'; }
(
  umask 077
  printf '*:*:*:%s:%s\n' "$(pgpass_escape "$(url_part "$ADMIN_URL" user)")" "$(pgpass_escape "$ADMIN_PASSWORD")" >"$PGPASS"
)
unset PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS
PGHOST="$(url_part "$ADMIN_URL" host)"
PGPORT="$(url_part "$ADMIN_URL" port)"
PGUSER="$(url_part "$ADMIN_URL" user)"
export PGHOST PGPORT PGUSER PGPASSFILE="$PGPASS"
admin_psql -d postgres -c 'SELECT 1' >/dev/null 2>&1 || die "cannot connect as TEST_DATABASE_ADMIN_URL (is PostgreSQL running?)"

# rclone: the real one, wrapped; systemctl: a stand-in.
REAL_RCLONE="$(command -v rclone)"
RCLONE_LOG="$STATE/rclone.log"
RCLONE_REFUSED="$STATE/rclone-refused.log"
cat >"$FAKEBIN/rclone" <<EOF
#!/usr/bin/env bash
# rclone wrapper of backup-restore.test.sh: records every call and refuses anything that could delete or move.
sub=""
for arg in "\$@"; do case "\$arg" in -*) ;; *) sub="\$arg"; break ;; esac; done
printf '%s\n' "\$*" >>"$RCLONE_LOG"
refuse() { printf 'refused: %s\n' "\$*" >>"$RCLONE_REFUSED"; echo "rclone (test wrapper): refused, the bucket key cannot delete: \$*" >&2; exit 1; }
case "\$sub" in copy | check | lsf) ;; *) refuse "\$@" ;; esac
for arg in "\$@"; do case "\$arg" in --delete* | --max-delete* | --backup-dir*) refuse "\$@" ;; esac; done
exec "$REAL_RCLONE" "\$@"
EOF
cat >"$FAKEBIN/systemctl" <<EOF
#!/usr/bin/env bash
# systemctl stand-in of backup-restore.test.sh: records its arguments.
printf '%s\n' "\$*" >>"$STATE/systemctl.log"
EOF
chmod 0755 "$FAKEBIN/rclone" "$FAKEBIN/systemctl"

# age: two key pairs made "offline"; only the public keys go into the fake /etc/velexis.
age-keygen -o "$OFFLINE/data.key" 2>/dev/null
age-keygen -o "$OFFLINE/config.key" 2>/dev/null
age-keygen -y "$OFFLINE/data.key" >"$CONFIG/backup/data-recipients.txt"
age-keygen -y "$OFFLINE/config.key" >"$CONFIG/backup/config-recipients.txt"
DATA_PUB="$(cat "$CONFIG/backup/data-recipients.txt")"
CONFIG_PUB="$(cat "$CONFIG/backup/config-recipients.txt")"
DATA_SECRET="$(grep '^AGE-SECRET-KEY-' "$OFFLINE/data.key")"
CONFIG_SECRET="$(grep '^AGE-SECRET-KEY-' "$OFFLINE/config.key")"
printf '[offsite]\ntype = local\n' >"$CONFIG/backup/rclone.conf"
# The rest of the fake /etc/velexis: the env templates as provision-vm.sh installs them (comments included), and a
# stand-in key and env file made of random values (no real secret).
for tpl in "$DEPLOY"/env/*.env.example; do cp "$tpl" "$CONFIG/$(basename "$tpl" .example)"; done
FAKE_MASTER="$(head -c 32 /dev/urandom | base64)"
FAKE_TOKEN="fake_$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$FAKE_MASTER" >"$CONFIG/keys/platform/master-v1.key"
cp "$CONFIG/keys/platform/master-v1.key" "$CONFIG/keys/ota/master-v1.key"
printf 'DATABASE_URL=postgres://velexis_platform_app:%s@127.0.0.1:5432/velexis\n' "$FAKE_TOKEN" >"$CONFIG/platform-backend.env"
chmod 0400 "$CONFIG/keys/platform/master-v1.key" "$CONFIG/keys/ota/master-v1.key"
chmod 0600 "$CONFIG/platform-backend.env"
SECRETS=("$ADMIN_PASSWORD" "$MIGRATOR_PASSWORD" "$REDIS_PASSWORD_VALUE" "$FAKE_MASTER" "$FAKE_TOKEN" "$DATA_SECRET"
  "$CONFIG_SECRET")
# Storage and Redis AOF stand-ins.
STORAGE="$PREFIX/var/lib/velexis/storage"
mkdir -p "$STORAGE/documents/tenant_bkta" "$STORAGE/exports"
head -c 70000 /dev/urandom >"$STORAGE/documents/tenant_bkta/ticket-1.pdf"
printf 'id,total\n1,"120.50"\n' >"$STORAGE/exports/bookings.csv"
AOF="$PREFIX/var/lib/redis/appendonlydir"
head -c 4096 /dev/urandom >"$AOF/appendonly.aof.1.base.rdb"
printf "*2\r\n\$6\r\nSELECT\r\n\$1\r\n0\r\n" >"$AOF/appendonly.aof.1.incr.aof" # RESP: SELECT 0
printf 'file appendonly.aof.1.base.rdb seq 1 type b\nfile appendonly.aof.1.incr.aof seq 1 type i\n' >"$AOF/appendonly.aof.manifest"

BACKUP_DIR="$PREFIX/var/backups/velexis"
export BACKUP_DIR STORAGE_DIR="$STORAGE" REDIS_AOF_DIR="$AOF" CONFIG_DIR="$CONFIG" PG_RUNAS=env \
  AGE_RECIPIENTS_FILE="$CONFIG/backup/data-recipients.txt" AGE_CONFIG_RECIPIENTS_FILE="$CONFIG/backup/config-recipients.txt" \
  RCLONE_CONFIG="$CONFIG/backup/rclone.conf" RCLONE_REMOTE="offsite:$BUCKET" \
  BACKUP_MARKER_FILE="$PREFIX/var/lib/velexis/backup-last-success" REDIS_PASSWORD="$REDIS_PASSWORD_VALUE" \
  CONFIG_RESTORE_DIR="$PREFIX/root/velexis-config.restore" LOG_DIR="$PREFIX/var/log/velexis" \
  SYSTEMCTL="$FAKEBIN/systemctl" PATH="$FAKEBIN:$PATH"
unset PG_DATABASE SKIP_REDIS RETENTION_LOCAL_DAYS

RUNS=0
RC=0
run() { # name script args... : runs backup.sh or restore.sh; output in $OUT/<n>-<name>.log, exit code in RC
  local name="$1"
  shift
  RUNS=$((RUNS + 1))
  LAST_LOG="$OUT/$(printf '%02d' "$RUNS")-$name.log"
  RC=0
  bash "$@" </dev/null >"$LAST_LOG" 2>&1 || RC=$?
}
run_typing() { # answer name script args... : like run, with <answer> typed at the hostname prompt
  local answer="$1" name="$2"
  shift 2
  RUNS=$((RUNS + 1))
  LAST_LOG="$OUT/$(printf '%02d' "$RUNS")-$name.log"
  RC=0
  printf '%s\n' "$answer" | bash "$@" >"$LAST_LOG" 2>&1 || RC=$?
}
rc_is() { [ "$RC" -eq "$1" ]; }
output_has() { grep -qF -- "$1" "$LAST_LOG"; }
refused_with() { [ "$RC" -ne 0 ] && output_has "$1"; } # message

# ---- database helpers ---------------------------------------------------------------------------------------------
db_list() { databases | tr '\n' ' '; }
connectable() { [ "$(admin_psql -At -d "$1" -c 'SELECT 1')" = 1 ]; }
db_props() { # database: owner, encoding, collation, allowed connections and ACL (the database-level grants)
  admin_psql -At -d postgres -v db="$1" <<'SQL'
SELECT pg_get_userbyid(datdba) || ' ' || pg_encoding_to_char(encoding) || ' ' || datcollate || ' ' || datctype
       || ' allowconn=' || datallowconn
       || ' acl=' || coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(datacl) a), 'default')
  FROM pg_database WHERE datname = :'db';
SQL
}
fingerprint() { # database: its schema (pg_dump --schema-only: objects, owners, grants) and the content of every table and sequence
  local db="$1"
  pg_dump -w --schema-only "$db" | grep -vE '^\\(un)?restrict '
  admin_psql -At -d "$db" <<'SQL'
SELECT n.nspname || '.' || c.relname || ' ' || (xpath('/row/h/text()', query_to_xml(format(
         'SELECT count(*) || '':'' || md5(coalesce(string_agg(t::text, ''|'' ORDER BY t::text), '''')) AS h FROM %I.%I t',
         n.nspname, c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND n.nspname !~ '^(pg_|information_schema$)'
 ORDER BY 1;
SELECT schemaname || '.' || sequencename || ' ' || coalesce(last_value::text, 'unused') FROM pg_sequences ORDER BY 1;
SQL
}
figures() { # database: the restore drill's figures, computed here independently of restore.sh
  admin_psql -At -d "$1" <<'SQL'
SELECT 'tenants=' || count(*) FROM platform.tenants;
SELECT 'tenant_schemas=' || count(*) FROM pg_namespace WHERE nspname LIKE 'tenant\_%';
SELECT 'reference_airports=' || count(*) FROM reference.airports;
SELECT 'last_audit_at=' || coalesce(max(created_at)::text, 'none') FROM platform.platform_audit_log;
SQL
}

# ---- file helpers -------------------------------------------------------------------------------------------------
flip_byte() { # file: flips the lowest bit of the byte in the middle of the file
  local file="$1" offset byte
  offset=$(($(stat -c %s "$file") / 2))
  byte="$(od -An -tu1 -j "$offset" -N1 "$file" | tr -d ' ')"
  printf '%b' "$(printf '\\0%03o' $((byte ^ 1)))" | dd of="$file" bs=1 seek="$offset" conv=notrunc status=none
}
reseal() { # set-dir file: writes the file's new SHA-256 into the set's MANIFEST.txt (what a careful attacker does)
  local sum
  sum="$(sha256sum "$1/$2" | cut -d' ' -f1)"
  awk -v f="./$2" -v s="$sum" 'length($1) == 64 && $2 == f { $0 = s "  " f } { print }' "$1/MANIFEST.txt" >"$1/MANIFEST.new"
  mv "$1/MANIFEST.new" "$1/MANIFEST.txt"
}
copy_set() { rm -rf "$2" && cp -a "$1" "$2"; } # from to
listing() { (cd "$1" && find . -mindepth 1 -printf '%P\n' | sort | tr '\n' ' '); }
same_files() { # dir dir: the same names, byte for byte
  [ "$(listing "$1")" = "$(listing "$2")" ] || return 1
  local f
  for f in "$1"/*; do cmp -s "$f" "$2/$(basename "$f")" || return 1; done
}
inventory() { # every object of the bucket: path, size, modification time, inode, SHA-256
  local f
  (cd "$BUCKET" && find . -type f -printf '%P\n' | sort | while IFS= read -r f; do
    printf '%s %s %s\n' "$f" "$(stat -c '%s %Y %i' "$f")" "$(sha256sum <"$f" | cut -d' ' -f1)"
  done)
}
local_sets() { find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??????Z' -printf '%f\n' 2>/dev/null | sort; }
decrypts_with() { age -d -i "$2" "$1" >/dev/null 2>&1; } # file key
unpacks_to() { # age-file key source-folder: the archive holds exactly the source folder
  local into
  into="$PREFIX/unpack/$(basename "$1")"
  rm -rf "$into" && mkdir -p "$into"
  age -d -i "$2" "$1" | zstd -dq | tar -C "$into" -xf - && diff -r "$3" "$into/$(basename "$3")" >/dev/null
}

# ---- 0. The source database and the rclone wrapper ------------------------------------------------------------------
step "Source database $SRC: bootstrap.sql's Database section, schemas.sql, migrations, two tenants, a few rows"
BOOTSTRAP_DB_SQL="$PREFIX/bootstrap-database.sql"
sed -n '/^-- ---- Database /,/^\\connect /p' "$DEPLOY/postgres/bootstrap.sql" | grep -v '^\\connect ' >"$BOOTSTRAP_DB_SQL"
if [ "$(grep -c 'CREATE DATABASE' "$BOOTSTRAP_DB_SQL")" != 1 ] || [ "$(grep -c ' ON DATABASE ' "$BOOTSTRAP_DB_SQL")" != 4 ]; then
  die "the Database section of deploy/postgres/bootstrap.sql changed; update this test"
fi
admin_psql -d postgres -v db_name="$SRC" -f "$BOOTSTRAP_DB_SQL" >"$OUT/00-bootstrap.log" 2>&1 || die "creating $SRC failed"
admin_psql -d "$SRC" -1 -c 'SET LOCAL ROLE velexis_migrator' -f "$DEPLOY/postgres/schemas.sql" >>"$OUT/00-bootstrap.log" 2>&1 \
  || die "schemas.sql on $SRC failed"
(cd "$REPO" && pnpm --filter @velexis/db run build) >"$OUT/00-build-db.log" 2>&1 || die "pnpm --filter @velexis/db run build failed"
SRC_MIGRATOR_URL="$(with_database "$MIGRATOR_URL" "$SRC")"
migrate() { (cd "$REPO" && DATABASE_MIGRATOR_URL="$SRC_MIGRATOR_URL" node packages/db/dist/cli/migrate.js "$@") >>"$OUT/00-migrate.log" 2>&1; }
migrate platform --dir platform/backend/migrations/platform || die "platform migrations on $SRC failed"
migrate reference --dir platform/backend/migrations/reference || die "reference migrations on $SRC failed"
migrate tenant --schema tenant_bkta --dir ota/backend/migrations/tenant --create || die "creating tenant_bkta failed"
migrate tenant --schema tenant_bktb --dir ota/backend/migrations/tenant --create || die "creating tenant_bktb failed"
admin_psql -d "$SRC" -1 >"$OUT/00-rows.log" 2>&1 <<'SQL' || die "inserting the rows into the source failed"
INSERT INTO reference.currencies (code, numeric_code, name, minor_units) VALUES ('EUR', '978', 'Euro', 2), ('GBP', '826', 'Pound Sterling', 2);
INSERT INTO reference.countries (code, alpha3, name, continent_code, currency_code, is_eu)
VALUES ('FR', 'FRA', 'France', 'EU', 'EUR', true), ('GB', 'GBR', 'United Kingdom', 'EU', 'GBP', false);
INSERT INTO reference.airports (iata_code, icao_code, name, city_name, country_code)
VALUES ('CDG', 'LFPG', 'Paris Charles de Gaulle', 'Paris', 'FR'), ('ORY', 'LFPO', 'Paris Orly', 'Paris', 'FR'),
       ('LHR', 'EGLL', 'London Heathrow', 'London', 'GB');
INSERT INTO platform.plans (code, name, monthly_price) VALUES ('starter', 'Starter', '49.00');
INSERT INTO platform.tenants (id, key, name, status, plan_code)
VALUES ('ten_01BKTA', 'bkta', 'Backup Test A', 'active', 'starter'), ('ten_01BKTB', 'bktb', 'Backup Test B', 'active', 'starter');
INSERT INTO platform.platform_audit_log (tenant_id, tenant_key, actor_type, action, created_at)
VALUES ('ten_01BKTA', 'bkta', 'system', 'tenant.provisioned', now() - interval '1 hour'),
       ('ten_01BKTB', 'bktb', 'system', 'tenant.provisioned', now());
SQL
SRC_FIGURES="$(figures "$SRC")"
SRC_FINGERPRINT="$(fingerprint "$SRC")"
SRC_PROPS="$(db_props "$SRC")"
while IFS= read -r line; do printf '     %s\n' "$line"; done <<<"$SRC_FIGURES"
[ "$(head -n 3 <<<"$SRC_FIGURES" | tr '\n' ' ')" = "tenants=2 tenant_schemas=2 reference_airports=3 " ] \
  || die "the source database does not have the expected rows"

# Seeds for retention: an old local set and an old folder that is no set; an old set on the remote.
mkdir -p "$BACKUP_DIR/2000-01-01T000000Z" "$BACKUP_DIR/storage.restore-old" "$BUCKET/daily/2000-01-01"
echo "old set" >"$BUCKET/daily/2000-01-01/MANIFEST.txt"
touch -d '10 days ago' "$BACKUP_DIR/2000-01-01T000000Z" "$BACKUP_DIR/storage.restore-old"

step "The test's rclone wrapper refuses deletes (self-check, before any script runs)"
wrapper_refuses() {
  local before
  before="$(inventory)"
  not rclone delete "offsite:$BUCKET/daily/2000-01-01" 2>/dev/null &&
    not rclone purge "offsite:$BUCKET/daily" 2>/dev/null &&
    not rclone sync "$OUT" "offsite:$BUCKET/daily/2000-01-01" 2>/dev/null &&
    [ "$(wc -l <"$RCLONE_REFUSED")" = 3 ] && [ "$(inventory)" = "$before" ]
}
check "rclone delete, purge and sync through the wrapper fail, are recorded, and change no object [X-024 AC1]" wrapper_refuses
rm -f "$RCLONE_REFUSED" "$RCLONE_LOG"
STARTED_AT="$(date -u +%s)"

# ---- 1. backup.sh -----------------------------------------------------------------------------------------------------
step "1. backup.sh: the five .age files and MANIFEST.txt, locally and on the remote"
PG_DATABASE="$SRC" run backup-1 "$BACKUP_SH"
SET1="$(local_sets | tail -n 1)"
LOCAL1="$BACKUP_DIR/$SET1"
DAY1="${SET1%%T*}"
check "backup.sh exits 0 [X-024 AC1]" rc_is 0
check "the local set $SET1 holds exactly the five .age files and MANIFEST.txt [X-024 AC1]" \
  test "$(listing "$LOCAL1")" = "MANIFEST.txt $AGE_FILES "
modes_ok() {
  local f
  [ "$(stat -c %a "$LOCAL1")" = 700 ] || return 1
  for f in "$LOCAL1"/*; do [ "$(stat -c %a "$f")" = 600 ] || return 1; done
}
check "the local set is 0700 and its files 0600 [X-024 AC1]" modes_ok
check "<remote>/daily/$DAY1/ holds the same six files, byte for byte [X-024 AC1]" same_files "$LOCAL1" "$BUCKET/daily/$DAY1"
age_headers() {
  local f
  for f in $AGE_FILES; do [ "$(head -n 1 "$LOCAL1/$f")" = "age-encryption.org/v1" ] || return 1; done
}
check "every .age file is an age v1 file [X-024 AC1]" age_headers
keys_separated() {
  local f
  for f in $DATA_FILES; do
    decrypts_with "$LOCAL1/$f" "$OFFLINE/data.key" || return 1
    not decrypts_with "$LOCAL1/$f" "$OFFLINE/config.key" || return 1
  done
  decrypts_with "$LOCAL1/config.tar.zst.age" "$OFFLINE/config.key" &&
    not decrypts_with "$LOCAL1/config.tar.zst.age" "$OFFLINE/data.key"
}
check "the four data files open with the data key only, config.tar.zst.age with the config key only [X-024 AC1]" keys_separated
manifest_ok() {
  local m="$LOCAL1/MANIFEST.txt" f
  (cd "$LOCAL1" && grep -E '^[0-9a-f]{64}  ' MANIFEST.txt | sha256sum --quiet --strict -c -) || return 1
  [ "$(grep -cE '^[0-9a-f]{64}  \./' "$m")" = 5 ] || return 1
  for f in $AGE_FILES; do grep -qxF "$(stat -c %s "$LOCAL1/$f")	./$f" "$m" || return 1; done
  grep -qx "created_at=$SET1" "$m" && grep -qx "database=$SRC" "$m" && grep -qx 'redis=included' "$m" &&
    grep -qE '^postgres=16\.' "$m" && [ "$(grep -E "$FIGURE_LINES" "$m")" = "$SRC_FIGURES" ]
}
check "MANIFEST.txt: SHA-256 and size of the five files, the database, PostgreSQL 16, redis=included and the source's figures [X-024 AC1]" \
  manifest_ok
globals_ok() {
  local sql
  sql="$(age -d -i "$OFFLINE/data.key" "$LOCAL1/globals.sql.age")"
  grep -q '^CREATE ROLE velexis_migrator;' <<<"$sql" && not grep -qiE 'password|scram-sha-256' <<<"$sql"
}
check "globals.sql.age holds the roles and no password [X-024 AC1]" globals_ok
check "storage.tar.zst.age holds the storage folder [X-024 AC1]" \
  unpacks_to "$LOCAL1/storage.tar.zst.age" "$OFFLINE/data.key" "$STORAGE"
check "redis-aof.tar.zst.age holds the AOF directory [X-024 AC1]" \
  unpacks_to "$LOCAL1/redis-aof.tar.zst.age" "$OFFLINE/data.key" "$AOF"
check "config.tar.zst.age holds the configuration folder (keys, env files, recipients) [X-024 AC1]" \
  unpacks_to "$LOCAL1/config.tar.zst.age" "$OFFLINE/config.key" "$CONFIG"
marker_ok() { [ "$(cat "$BACKUP_MARKER_FILE")" -ge "$STARTED_AT" ]; }
check "the marker file holds the time of this run [X-024 AC1]" marker_ok
check "no unencrypted file is left in BACKUP_DIR [X-024 AC1]" \
  test -z "$(find "$BACKUP_DIR" -type f ! -name '*.age' ! -name MANIFEST.txt)"
retention_ok() {
  [ ! -e "$BACKUP_DIR/2000-01-01T000000Z" ] && [ -d "$BACKUP_DIR/storage.restore-old" ] &&
    [ -f "$BUCKET/daily/2000-01-01/MANIFEST.txt" ]
}
check "local retention prunes the old set folder only; the old remote set is left to the bucket [X-024 AC1]" retention_ok

# ---- 2. restore.sh list, fetch, drill ---------------------------------------------------------------------------------
step "2. restore.sh list, fetch and drill: the figures match the source database and the MANIFEST"
run list "$RESTORE_SH" list
list_ok() { rc_is 0 && output_has "$DAY1/" && output_has "2000-01-01/"; }
check "restore.sh list shows the daily sets of the remote [X-024 AC1]" list_ok
FETCHED="$PREFIX/root/restore/set"
run fetch "$RESTORE_SH" fetch "daily/$DAY1" "$FETCHED"
fetched_ok() { rc_is 0 && same_files "$LOCAL1" "$FETCHED" && output_has "checksums match its MANIFEST"; }
check "restore.sh fetch daily/$DAY1 downloads the set and checks it against its MANIFEST [X-024 AC1]" fetched_ok
PG_DATABASE="$SRC" run drill "$RESTORE_SH" drill "$FETCHED" --identity "$OFFLINE/data.key"
drill_ok() { rc_is 0 && [ "$(grep -E "$FIGURE_LINES" "$LAST_LOG")" = "$SRC_FIGURES" ]; }
check "restore.sh drill of the fetched set prints the source database's figures [X-024 AC1]" drill_ok
check "the drill reports that its figures match the MANIFEST [X-024 AC1]" output_has "drill OK: the figures above match the set's MANIFEST.txt"
drill_log_ok() { [ "$(grep -hE "$FIGURE_LINES" "$PREFIX"/var/log/velexis/restore-drill-*.log)" = "$SRC_FIGURES" ]; }
check "the drill log holds the figures [X-024 AC1]" drill_log_ok
check "the drill database is dropped afterwards [X-024 AC1]" test "$(db_list)" = "$SRC "

# ---- 3. A flipped byte --------------------------------------------------------------------------------------------
step "3. A flipped byte in an .age file is refused"
copy_set "$FETCHED" "$SETS/flipped"
flip_byte "$SETS/flipped/velexis-db.dump.age"
PG_DATABASE="$SRC" run drill-flipped "$RESTORE_SH" drill "$SETS/flipped" --identity "$OFFLINE/data.key"
flipped_refused() { refused_with "checksums in" && [ "$(db_list)" = "$SRC " ]; }
check "a flipped byte is refused by the MANIFEST check, before any database is created [X-024 AC1]" flipped_refused
copy_set "$SETS/flipped" "$SETS/resealed"
reseal "$SETS/resealed" velexis-db.dump.age
PG_DATABASE="$SRC" run drill-resealed "$RESTORE_SH" drill "$SETS/resealed" --identity "$OFFLINE/data.key"
resealed_refused() {
  refused_with "age: error: failed to decrypt and authenticate payload chunk" && output_has "dropping ${SRC}_drill_" &&
    [ "$(db_list)" = "$SRC " ]
}
check "with the MANIFEST fixed to match, age refuses the flipped byte and the drill database is dropped [X-024 AC1]" \
  resealed_refused

# ---- 4. No delete on the remote -------------------------------------------------------------------------------------
step "4. backup.sh never deletes anything on the remote"
no_delete_commands() {
  not grep -nE 'rclone[[:space:]]+(delete|deletefile|purge|rmdir|rmdirs|cleanup|sync|move|moveto|dedupe|bisync)([[:space:]]|$)|--delete' \
    "$BACKUP_SH" "$RESTORE_SH"
}
check "backup.sh and restore.sh contain no rclone delete, deletefile, purge, rmdir(s), cleanup, sync, move or --delete* [X-024 AC1]" \
  no_delete_commands
BEFORE2="$(inventory)"
SKIP_REDIS=1 PG_DATABASE="$SRC" run backup-2 "$BACKUP_SH"
SET2="$(local_sets | tail -n 1)"
DAY2="${SET2%%T*}"
DEST2="daily/$DAY2"
[ "$DAY2" != "$DAY1" ] || DEST2="daily/$SET2"
check "a second backup.sh run (SKIP_REDIS=1) exits 0 [X-024 AC1]" rc_is 0
second_ok() {
  [ "$SET2" != "$SET1" ] && same_files "$BACKUP_DIR/$SET2" "$BUCKET/$DEST2" &&
    [ "$(listing "$BUCKET/$DEST2")" = "MANIFEST.txt config.tar.zst.age globals.sql.age storage.tar.zst.age velexis-db.dump.age " ] &&
    grep -qx 'redis=skipped' "$BUCKET/$DEST2/MANIFEST.txt"
}
check "it uploads four .age files and a MANIFEST with redis=skipped to $DEST2, beside the first set [X-024 AC1]" second_ok
kept_everything() { [ -z "$(comm -23 <(printf '%s\n' "$BEFORE2") <(inventory))" ]; }
check "every object uploaded before (the first set, the old set) is still there, unchanged: size, time, inode, SHA-256 [X-024 AC1]" \
  kept_everything
check "no rclone call of backup.sh or restore.sh was refused by the wrapper so far [X-024 AC1]" test ! -s "$RCLONE_REFUSED"

# The monthly copy: two more runs whose UTC stamp falls on the 1st of a month (a date stand-in on PATH changes only
# the stamp; every other date call goes to the real one).
REAL_DATE="$(command -v date)"
FAKE_DAY="2031-02-01"
mkdir -p "$PREFIX/datebin"
cat >"$PREFIX/datebin/date" <<EOF
#!/usr/bin/env bash
# date stand-in of backup-restore.test.sh: backup.sh's run stamp falls on $FAKE_DAY; anything else is the real date.
if [ "\$*" = "-u +%Y-%m-%dT%H%M%SZ" ]; then printf '%sT%sZ\n' "$FAKE_DAY" "\$("$REAL_DATE" -u +%H%M%S)"; exit 0; fi
exec "$REAL_DATE" "\$@"
EOF
chmod 0755 "$PREFIX/datebin/date"
MSET=""
monthly_run() { # name: a backup.sh run (SKIP_REDIS=1) stamped on FAKE_DAY; its new set folder in MSET
  local before
  before="$(local_sets)"
  PATH="$PREFIX/datebin:$PATH" SKIP_REDIS=1 PG_DATABASE="$SRC" run "$1" "$BACKUP_SH"
  MSET="$(comm -13 <(printf '%s\n' "$before") <(local_sets) | grep "^${FAKE_DAY}T" | head -n 1 || true)"
  # The next run needs another stamp: backup.sh never reuses a set folder.
  while [ -n "$MSET" ] && [ "$(date -u +%H%M%S)" = "${MSET:11:6}" ]; do sleep 0.2; done
}
BEFORE_MONTHLY="$(inventory)"
monthly_run backup-monthly-1
SET3="$MSET"
monthly_first() {
  rc_is 0 && [ -n "$SET3" ] && same_files "$BACKUP_DIR/$SET3" "$BUCKET/daily/$FAKE_DAY" &&
    same_files "$BACKUP_DIR/$SET3" "$BUCKET/monthly/${FAKE_DAY%-*}" && output_has "monthly copy offsite:$BUCKET/monthly/${FAKE_DAY%-*}"
}
check "a run on the 1st of a month uploads its set to daily/<day>/ and to monthly/<yyyy-mm>/ [X-024 AC1]" monthly_first
MONTHLY_INVENTORY="$(inventory | grep '^monthly/' || true)"
monthly_run backup-monthly-2
SET4="$MSET"
monthly_second() {
  rc_is 0 && [ -n "$SET4" ] && [ "$SET4" != "$SET3" ] && same_files "$BACKUP_DIR/$SET4" "$BUCKET/daily/$SET4" &&
    output_has "monthly/${FAKE_DAY%-*} already holds this month's set" &&
    [ "$(inventory | grep '^monthly/' || true)" = "$MONTHLY_INVENTORY" ]
}
check "a second run on that day goes to daily/<stamp>/ and leaves monthly/<yyyy-mm>/ as it was [X-024 AC1]" monthly_second
kept_everything_monthly() { [ -z "$(comm -23 <(printf '%s\n' "$BEFORE_MONTHLY") <(inventory))" ]; }
check "every object uploaded before the two monthly runs is still there, unchanged [X-024 AC1]" kept_everything_monthly

# ---- 5. Key refusals ------------------------------------------------------------------------------------------------
step "5. backup.sh refuses one key for data and config, and private keys on the VM"
SETS_BEFORE="$(local_sets)"
INVENTORY_BEFORE="$(inventory)"
refused_cleanly() { # message: non-zero exit, the message, no new local set, the bucket as it was
  refused_with "$1" && [ "$(local_sets)" = "$SETS_BEFORE" ] && [ "$(inventory)" = "$INVENTORY_BEFORE" ]
}
cp "$CONFIG/backup/data-recipients.txt" "$PREFIX/same-key.txt"
AGE_CONFIG_RECIPIENTS_FILE="$PREFIX/same-key.txt" PG_DATABASE="$SRC" run same-key "$BACKUP_SH"
check "the data key as the config recipients file is refused, before writing or uploading anything [X-024 AC1]" \
  refused_cleanly "data and config backups must use different age keys"
printf '# the config key, and by mistake the data key\n%s\n\n%s\n' "$CONFIG_PUB" "$DATA_PUB" >"$PREFIX/shared-key.txt"
AGE_CONFIG_RECIPIENTS_FILE="$PREFIX/shared-key.txt" PG_DATABASE="$SRC" run shared-key "$BACKUP_SH"
check "a config recipients file that also lists the data key is refused [X-024 AC1]" \
  refused_cleanly "data and config backups must use different age keys"
AGE_RECIPIENTS_FILE="$OFFLINE/data.key" PG_DATABASE="$SRC" run private-recipients "$BACKUP_SH"
check "a private key given as recipients file is refused [X-024 AC1]" refused_cleanly "holds a PRIVATE age key"
cp "$OFFLINE/config.key" "$CONFIG/backup/forgotten.key"
PG_DATABASE="$SRC" run private-in-config "$BACKUP_SH"
check "a private age key anywhere in /etc/velexis is refused [X-024 AC1]" refused_cleanly "a PRIVATE age key is in"
rm -f "$CONFIG/backup/forgotten.key"

# ---- 6. db --target and --replace-live ------------------------------------------------------------------------------
step "6. restore.sh db --target, then db --replace-live against the scratch live database $LIVE"
PG_DATABASE="$SRC" run db-target "$RESTORE_SH" db "$FETCHED" --identity "$OFFLINE/data.key" --target "$LIVE"
target_ok() {
  rc_is 0 && [ "$(fingerprint "$LIVE")" = "$SRC_FINGERPRINT" ] && [ "$(db_props "$LIVE")" = "$SRC_PROPS" ]
}
check "db --target restores the set into a new database: the source's schema, owners, grants, data and database-level grants [X-024 AC1]" \
  target_ok
PG_DATABASE="$SRC" run db-target-live "$RESTORE_SH" db "$FETCHED" --identity "$OFFLINE/data.key" --target "$SRC"
target_live_refused() { refused_with "refusing to restore over $SRC" && [ "$(fingerprint "$SRC")" = "$SRC_FINGERPRINT" ]; }
check "db --target refuses the live database itself [X-024 AC1]" target_live_refused

admin_psql -d "$LIVE" -c "INSERT INTO platform.platform_audit_log (actor_type, action) VALUES ('system', 'backup_test.live_marker')" \
  >/dev/null
LIVE_FINGERPRINT="$(fingerprint "$LIVE")"
LIVE_PROPS="$(db_props "$LIVE")"
rm -f "$STATE/systemctl.log"
live_unchanged() { # the live database as it was, connectable, no app unit stopped, no staging database left
  connectable "$LIVE" && [ "$(fingerprint "$LIVE")" = "$LIVE_FINGERPRINT" ] && [ "$(db_props "$LIVE")" = "$LIVE_PROPS" ] &&
    [ ! -s "$STATE/systemctl.log" ] && [ "$(db_list)" = "$LIVE $SRC " ]
}
replace_live() { # name set identity [answer]
  PG_DATABASE="$LIVE" run_typing "${4:-$(hostname)}" "$1" "$RESTORE_SH" db "$2" --identity "$3" --replace-live
}
stopped_before_restore() { refused_with "$1" && live_unchanged; } # message: refused before any database is made
stopped_staging_dropped() { refused_with "$1" && output_has "dropping ${LIVE}_restore_" && live_unchanged; } # message
replace_live replace-wrong-host "$FETCHED" "$OFFLINE/data.key" "not-$(hostname)"
check "--replace-live with a wrong hostname typed: aborted, live database unchanged [X-024 AC1]" \
  stopped_before_restore "aborted"
replace_live replace-flipped "$SETS/flipped" "$OFFLINE/data.key"
check "--replace-live with a corrupt .age file (MANIFEST check): stopped, live database unchanged and connectable [X-024 AC1]" \
  stopped_before_restore "checksums in"
replace_live replace-resealed "$SETS/resealed" "$OFFLINE/data.key"
check "--replace-live with a corrupt .age file that passes the MANIFEST (age): stopped, staging dropped, live database unchanged [X-024 AC1]" \
  stopped_staging_dropped "age: error: failed to decrypt and authenticate payload chunk"
replace_live replace-wrong-identity "$FETCHED" "$OFFLINE/config.key"
check "--replace-live with a wrong identity: stopped, staging dropped, live database unchanged and connectable [X-024 AC1]" \
  stopped_staging_dropped "no identity matched any of the recipients"
copy_set "$FETCHED" "$SETS/truncated"
TRUNCATED_PLAIN="$PREFIX/truncated.dump"
age -d -i "$OFFLINE/data.key" "$FETCHED/velexis-db.dump.age" >"$TRUNCATED_PLAIN"
head -c $(($(stat -c %s "$TRUNCATED_PLAIN") - 200)) "$TRUNCATED_PLAIN" | age -R "$AGE_RECIPIENTS_FILE" -o "$SETS/truncated/velexis-db.dump.age"
rm -f "$TRUNCATED_PLAIN"
reseal "$SETS/truncated" velexis-db.dump.age
replace_live replace-pg-restore-fails "$SETS/truncated" "$OFFLINE/data.key"
check "--replace-live with a failing pg_restore (a truncated dump): stopped, staging dropped, live database unchanged [X-024 AC1]" \
  stopped_staging_dropped "pg_restore: error"

replace_live replace-good "$FETCHED" "$OFFLINE/data.key"
BEFORE_DB="$(databases | grep -E "^${LIVE}_before_restore_[0-9]{14}\$" || true)"
swap_reported() { rc_is 0 && output_has "database replaced; the previous one is kept as $BEFORE_DB"; }
check "--replace-live with a good set exits 0 and reports the swap [X-024 AC1]" swap_reported
check "the app units were stopped (once, all seven) before the swap [X-024 AC1]" \
  test "$(cat "$STATE/systemctl.log" 2>/dev/null)" = "stop $APP_UNITS"
names_swapped() { [ -n "$BEFORE_DB" ] && [ "$(db_list)" = "$LIVE $BEFORE_DB $SRC " ]; }
check "the names are swapped: $LIVE, ${LIVE}_before_restore_<stamp>, and no staging database [X-024 AC1]" names_swapped
new_live_is_the_set() { [ "$(fingerprint "$LIVE")" = "$SRC_FINGERPRINT" ]; }
check "the new $LIVE has the set's schema, owners, grants and data (the source's, without the live marker) [X-024 AC1]" \
  new_live_is_the_set
new_live_grants() { [ "$(db_props "$LIVE")" = "$SRC_PROPS" ] && connectable "$LIVE"; }
check "the new $LIVE has the database-level grants of bootstrap.sql (owner, ACL, encoding, collation) and is connectable [X-024 AC1]" \
  new_live_grants
old_live_kept() { [ -n "$BEFORE_DB" ] && [ "$(fingerprint "$BEFORE_DB")" = "$LIVE_FINGERPRINT" ]; }
check "${LIVE}_before_restore_<stamp> keeps the previous live data, for rollback [X-024 AC1]" old_live_kept

# ---- 7. storage and config ----------------------------------------------------------------------------------------
step "7. restore.sh storage and config"
run storage-beside "$RESTORE_SH" storage "$FETCHED" --identity "$OFFLINE/data.key"
storage_beside() { rc_is 0 && diff -r "$STORAGE" "$BACKUP_DIR/storage.restore/storage" >/dev/null; }
check "storage unpacks the set beside the live folder, into BACKUP_DIR/storage.restore [X-024 AC1]" storage_beside
LIVE_STORAGE="$PREFIX/live/var/lib/velexis/storage"
mkdir -p "$(dirname "$LIVE_STORAGE")"
cp -a "$STORAGE" "$LIVE_STORAGE"
echo "written after the backup" >"$LIVE_STORAGE/exports/after-backup.csv"
cp -a "$LIVE_STORAGE" "$PREFIX/live-storage-copy"
storage_live_unchanged() { # the live folder as it was, and nothing beside it (no staging or before-restore folder)
  diff -r "$PREFIX/live-storage-copy" "$LIVE_STORAGE" >/dev/null &&
    [ -z "$(find "$(dirname "$LIVE_STORAGE")" -mindepth 1 -maxdepth 1 ! -name storage)" ]
}
STORAGE_DIR="$LIVE_STORAGE" run_typing "$(hostname)" storage-wrong-key "$RESTORE_SH" storage "$FETCHED" \
  --identity "$OFFLINE/config.key" --replace-live
storage_wrong_key() { refused_with "no identity matched any of the recipients" && storage_live_unchanged; }
check "storage --replace-live with a wrong key: stopped, staging folder removed, live folder unchanged [X-024 AC1]" \
  storage_wrong_key
STORAGE_DIR="$LIVE_STORAGE" run_typing "$(hostname)" storage-replace "$RESTORE_SH" storage "$FETCHED" \
  --identity "$OFFLINE/data.key" --replace-live
storage_replaced() {
  local before
  before="$(find "$(dirname "$LIVE_STORAGE")" -mindepth 1 -maxdepth 1 -name 'storage.before-restore-*')"
  rc_is 0 && diff -r "$STORAGE" "$LIVE_STORAGE" >/dev/null && [ -n "$before" ] &&
    diff -r "$PREFIX/live-storage-copy" "$before" >/dev/null &&
    [ -z "$(find "$(dirname "$LIVE_STORAGE")" -mindepth 1 -maxdepth 1 -name '.restore-*')" ]
}
check "storage --replace-live: the live folder is the backup's, the previous one kept as storage.before-restore-<stamp> [X-024 AC1]" \
  storage_replaced
run config-data-key "$RESTORE_SH" config "$FETCHED" --identity "$OFFLINE/data.key"
check "config with the data key is refused (one stolen key never opens both) [X-024 AC1]" \
  refused_with "no identity matched any of the recipients"
run config "$RESTORE_SH" config "$FETCHED" --identity "$OFFLINE/config.key"
config_restored() { rc_is 0 && diff -r "$CONFIG" "$CONFIG_RESTORE_DIR/velexis" >/dev/null; }
check "config with the config key unpacks /etc/velexis into CONFIG_RESTORE_DIR [X-024 AC1]" config_restored

# ---- over the whole run -------------------------------------------------------------------------------------------
step "Over the whole run"
LAST_LOG=""
no_secret_printed() {
  local s
  for s in "${SECRETS[@]}"; do
    [ -n "$s" ] || continue
    if grep -rqF -- "$s" "$OUT" "$STATE" "$PREFIX/var/log/velexis"; then return 1; fi
    [ -z "$(find "$BACKUP_DIR" "$BUCKET" -name MANIFEST.txt -exec grep -qF -- "$s" {} \; -print)" ] || return 1
  done
}
check "no password, stand-in key, env value or private age key in any script output, log or MANIFEST [X-024 AC1]" no_secret_printed
check "no rclone call of backup.sh or restore.sh was refused by the wrapper [X-024 AC1]" test ! -s "$RCLONE_REFUSED"
only_allowed_calls() { not grep -vE '^(copy|check|lsf) ' "$RCLONE_LOG"; }
check "the scripts called only rclone copy, check and lsf [X-024 AC1]" only_allowed_calls
uploads_immutable() {
  grep -q '^copy .* offsite:' "$RCLONE_LOG" &&
    [ -z "$(awk '$1 == "copy" && $3 ~ /^offsite:/ && !/ --immutable( |$)/' "$RCLONE_LOG")" ]
}
check "every upload used --immutable [X-024 AC1]" uploads_immutable

echo
if [ "$FAILED" -eq 0 ]; then
  echo "backup-restore.test.sh: all checks passed ($RUNS runs of backup.sh and restore.sh)"
else
  echo "backup-restore.test.sh: FAILED"
fi
[ "$FAILED" -eq 0 ]
