#!/usr/bin/env bash
# =====================================================================================================
# dev-setup.sh — one-time local setup of PostgreSQL 16 and Redis 7.4 for Velexis development (X-016).
#
# Runbook: docs/mvp/local-development.md §2. Runs on Ubuntu 24.04 and on macOS with Homebrew, as your normal
# user from anywhere in the repository; on Linux it calls sudo for the postgres superuser and for starting
# services. It is for development machines only and refuses to run where /etc/velexis exists (the VM is set
# up by provision-vm.sh with generated secrets).
#
# Usage:
#   bash deploy/scripts/dev-setup.sh
#
# What it does (idempotent: a second run changes nothing):
#   1. starts PostgreSQL and Redis if they are installed but stopped;
#   2. runs deploy/postgres/bootstrap.sql as the PostgreSQL superuser with the development passwords of
#      .env.example: database "velexis", the four roles, schemas and default privileges (passwords are reset);
#   3. creates velexis_test_admin (LOGIN CREATEDB, member of velexis_migrator) for the integration tests;
#   4. sets the Redis password to the development value if Redis has none (CONFIG SET requirepass and
#      CONFIG REWRITE), so REDIS_URL of .env.example works;
#   5. checks every login of .env.example over TCP and prints a summary (exit 1 if a login fails).
# =====================================================================================================
set -euo pipefail

readonly PROD_MARKER=/etc/velexis
readonly DB_NAME=velexis
readonly PG_MAJOR=16
readonly PG_HOST=127.0.0.1
readonly PG_PORT=5432
readonly REDIS_HOST=127.0.0.1
readonly REDIS_PORT=6379
readonly REDIS_EXPECTED=7.4
# Development values of .env.example: dummy, local only, never used on the VM (ADR-0010).
readonly MIGRATOR_PASSWORD=dev_migrator
readonly PROVISIONER_PASSWORD=dev_provisioner
readonly PLATFORM_PASSWORD=dev_platform
readonly OTA_PASSWORD=dev_ota
readonly TEST_ADMIN_PASSWORD=dev_test_admin
readonly REDIS_PASSWORD=dev_redis

log() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  "") ;;
  -h|--help) sed -n '3,20p' "$0"; exit 0 ;;
  *) die "unknown argument: $1 (usage: bash deploy/scripts/dev-setup.sh)" ;;
esac

# ---- Never on a production host ----------------------------------------------------------------------------
if [ -e "$PROD_MARKER" ]; then
  die "$PROD_MARKER exists, so this looks like a Velexis production host. dev-setup.sh only sets up" \
    "development machines; the VM is provisioned by deploy/scripts/provision-vm.sh."
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly REPO_ROOT
readonly BOOTSTRAP_SQL="$REPO_ROOT/deploy/postgres/bootstrap.sql"
[ -f "$BOOTSTRAP_SQL" ] || die "missing $BOOTSTRAP_SQL"

# Connection settings from the caller's shell must not redirect the superuser session or the login checks.
unset PGHOST PGHOSTADDR PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGOPTIONS PGSSLMODE REDISCLI_AUTH

case "$(uname -s)" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) die "unsupported operating system $(uname -s): Ubuntu or macOS expected" ;;
esac
readonly PLATFORM

if [ "$PLATFORM" = macos ]; then
  command -v brew >/dev/null 2>&1 \
    || die "Homebrew not found: install the prerequisites of docs/mvp/local-development.md §1"
  # postgresql@16 is keg-only: its psql and pg_isready are not on the PATH by default.
  BREW_PG_PREFIX="$(brew --prefix "postgresql@${PG_MAJOR}" 2>/dev/null || true)"
  if [ -n "$BREW_PG_PREFIX" ] && [ -d "$BREW_PG_PREFIX/bin" ]; then
    PATH="$BREW_PG_PREFIX/bin:$PATH"
  fi
fi
for tool in psql pg_isready redis-cli; do
  command -v "$tool" >/dev/null 2>&1 \
    || die "$tool not found: install PostgreSQL ${PG_MAJOR} and Redis ${REDIS_EXPECTED}" \
      "(docs/mvp/local-development.md §1)"
done

# ---- Helpers -----------------------------------------------------------------------------------------------
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

# psql as the PostgreSQL superuser over the local socket: the postgres OS user (peer authentication) on Linux,
# the current user (the superuser Homebrew's initdb creates) on macOS. Notices such as "already exists,
# skipping" are hidden; warnings and errors are shown.
su_psql() {
  if [ "$PLATFORM" = macos ]; then
    PGOPTIONS='-c client_min_messages=warning' psql -X -q -v ON_ERROR_STOP=1 -p "$PG_PORT" -d postgres "$@"
  elif [ "$(id -u)" -eq 0 ] && command -v runuser >/dev/null 2>&1; then
    (cd / && runuser -u postgres -- env 'PGOPTIONS=-c client_min_messages=warning' \
      psql -X -q -v ON_ERROR_STOP=1 -p "$PG_PORT" -d postgres "$@")
  else
    (cd / && sudo -u postgres env 'PGOPTIONS=-c client_min_messages=warning' \
      psql -X -q -v ON_ERROR_STOP=1 -p "$PG_PORT" -d postgres "$@")
  fi
}

pg_ready() { pg_isready -q -h "$PG_HOST" -p "$PG_PORT"; }

# Prints Redis's answer to PING without a password: PONG, a NOAUTH error, or nothing when nobody listens.
redis_ping() { redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping 2>/dev/null || true; }
redis_up() { [ -n "$(redis_ping)" ]; }
# Runs one Redis command read from stdin (passwords never go on a command line) with the development password.
redis_auth() {
  REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" 2>/dev/null || true
}

wait_for() {
  local what="$1"
  shift
  for _ in $(seq 1 30); do
    if "$@"; then return 0; fi
    sleep 1
  done
  die "$what did not become ready on 127.0.0.1 within 30 s"
}

# ---- 1. Services -------------------------------------------------------------------------------------------
start_postgres() {
  if pg_ready; then
    log "PostgreSQL is running on $PG_HOST:$PG_PORT"
    return
  fi
  log "Starting PostgreSQL"
  if [ "$PLATFORM" = macos ]; then
    brew services start "postgresql@${PG_MAJOR}"
  elif [ -d /run/systemd/system ]; then
    as_root systemctl start postgresql
  else
    as_root service postgresql start # containers and WSL without systemd
  fi
  wait_for PostgreSQL pg_ready
}

start_redis() {
  if redis_up; then
    log "Redis is running on $REDIS_HOST:$REDIS_PORT"
    return
  fi
  log "Starting Redis"
  if [ "$PLATFORM" = macos ]; then
    brew services start redis
  elif [ -d /run/systemd/system ]; then
    as_root systemctl start redis-server
  else
    as_root service redis-server start
  fi
  wait_for Redis redis_up
}

check_superuser() {
  local row
  row="$(su_psql -At -c "SELECT rolsuper, current_setting('server_version_num')::int / 10000
                          FROM pg_roles WHERE rolname = current_user")" \
    || die "cannot connect to PostgreSQL as the superuser (sudo -u postgres psql on Linux," \
      "your own user with Homebrew)"
  [ "${row%%|*}" = t ] || die "the local PostgreSQL connection is not a superuser"
  PG_SERVER_MAJOR="${row##*|}"
  [ "$PG_SERVER_MAJOR" = "$PG_MAJOR" ] \
    || warn "PostgreSQL ${PG_MAJOR} expected, the server on port $PG_PORT is ${PG_SERVER_MAJOR}"
}

# ---- 2. bootstrap.sql --------------------------------------------------------------------------------------
bootstrap_database() {
  log "Database $DB_NAME, roles, schemas and default privileges (deploy/postgres/bootstrap.sql)"
  # Passwords go through stdin as \set lines, never on a command line (visible in ps), like provision-vm.sh.
  {
    printf '\\set migrator_password %s\n' "$MIGRATOR_PASSWORD"
    printf '\\set provisioner_password %s\n' "$PROVISIONER_PASSWORD"
    printf '\\set platform_password %s\n' "$PLATFORM_PASSWORD"
    printf '\\set ota_password %s\n' "$OTA_PASSWORD"
    cat "$BOOTSTRAP_SQL"
  } | su_psql -v db_name="$DB_NAME" -f - >/dev/null
}

# ---- 3. Integration-test admin role (ADR-0022: local and CI only, never on the VM) -------------------------
create_test_admin() {
  log "Role velexis_test_admin (LOGIN CREATEDB, member of velexis_migrator)"
  {
    printf '\\set test_admin_password %s\n' "$TEST_ADMIN_PASSWORD"
    cat <<'SQL'
SELECT format('CREATE ROLE velexis_test_admin LOGIN CREATEDB PASSWORD %L', :'test_admin_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velexis_test_admin') \gexec
SELECT format('ALTER ROLE velexis_test_admin WITH LOGIN CREATEDB NOSUPERUSER NOCREATEROLE PASSWORD %L',
              :'test_admin_password') \gexec
SELECT 'GRANT velexis_migrator TO velexis_test_admin'
WHERE NOT EXISTS (SELECT 1 FROM pg_auth_members
                  WHERE roleid = 'velexis_migrator'::regrole AND member = 'velexis_test_admin'::regrole) \gexec
SQL
  } | su_psql -f - >/dev/null
}

# ---- 4. Redis password -------------------------------------------------------------------------------------
REDIS_STATE=""
REDIS_OTHER_PASSWORD=0
configure_redis() {
  local reply
  reply="$(redis_ping)"
  case "$reply" in
    PONG)
      log "Redis has no password: setting the development password of REDIS_URL"
      reply="$(printf 'CONFIG SET requirepass %s\n' "$REDIS_PASSWORD" \
        | redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" 2>&1 || true)"
      [ "$reply" = OK ] || die "Redis refused CONFIG SET requirepass: $reply"
      reply="$(printf 'CONFIG REWRITE\n' | redis_auth)"
      if [ "$reply" = OK ]; then
        REDIS_STATE="password set and saved in the Redis configuration file"
      else
        REDIS_STATE="password set until Redis restarts (CONFIG REWRITE refused)"
        warn "Redis refused CONFIG REWRITE (${reply:-no answer}): the password is lost when Redis" \
          "restarts. Add 'requirepass' with the REDIS_URL password to redis.conf."
      fi
      ;;
    NOAUTH*)
      if [ "$(printf 'PING\n' | redis_auth)" = PONG ]; then
        REDIS_STATE="password already set (unchanged)"
      else
        REDIS_STATE="has another password: set REDIS_URL in .env.local to it"
        REDIS_OTHER_PASSWORD=1
        warn "Redis requires a password other than the one in REDIS_URL of .env.example;" \
          "dev-setup.sh does not change it."
      fi
      ;;
    *) die "unexpected answer from Redis on $REDIS_HOST:$REDIS_PORT: $reply" ;;
  esac
}

# ---- 5. Checks and summary ---------------------------------------------------------------------------------
FAILED=0
check_login() { # <role> <password> <database> <where .env.example uses it>
  local status=ok
  if ! PGPASSWORD="$2" psql -X -q -At -h "$PG_HOST" -p "$PG_PORT" -U "$1" -d "$3" -c 'SELECT 1' >/dev/null 2>&1; then
    status=FAILED
    FAILED=1
  fi
  printf '    %-22s %-7s %s\n' "$1" "$status" "$4"
}

summary() {
  local pg_version redis_version redis_status=ok
  pg_version="$(su_psql -At -c "SELECT split_part(current_setting('server_version'), ' ', 1)")"
  redis_version="$(printf 'INFO server\n' | redis_auth | tr -d '\r' | sed -n 's/^redis_version://p')"
  case "$redis_version" in
    "$REDIS_EXPECTED".*) ;;
    *) warn "Redis ${REDIS_EXPECTED} expected, found ${redis_version:-an unknown version}" ;;
  esac
  if [ "$(redis_ping)" = PONG ]; then
    redis_status=FAILED
    FAILED=1
  elif [ "$REDIS_OTHER_PASSWORD" -eq 1 ]; then
    redis_status=other
  elif [ "$(printf 'PING\n' | redis_auth)" != PONG ]; then
    redis_status=FAILED
    FAILED=1
  fi

  printf '\n================================================================================================\n'
  printf 'Velexis local services (docs/mvp/local-development.md §2)\n'
  printf '  PostgreSQL %s on %s:%s, database %s; logins with the .env.example passwords:\n' \
    "$pg_version" "$PG_HOST" "$PG_PORT" "$DB_NAME"
  check_login velexis_migrator "$MIGRATOR_PASSWORD" "$DB_NAME" "DATABASE_MIGRATOR_URL"
  check_login velexis_provisioner "$PROVISIONER_PASSWORD" "$DB_NAME" "DATABASE_PROVISIONER_URL"
  check_login velexis_platform_app "$PLATFORM_PASSWORD" "$DB_NAME" "DATABASE_URL (platform/backend)"
  check_login velexis_ota_app "$OTA_PASSWORD" "$DB_NAME" "DATABASE_URL (ota/backend/.env.local)"
  check_login velexis_test_admin "$TEST_ADMIN_PASSWORD" postgres "TEST_DATABASE_ADMIN_URL"
  printf '  Redis %s on %s:%s: %s\n' "${redis_version:-?}" "$REDIS_HOST" "$REDIS_PORT" "$REDIS_STATE"
  printf '    %-22s %-7s %s\n' "password required" "$redis_status" "REDIS_URL"
  printf '\nNext steps:\n'
  [ -f "$REPO_ROOT/.env.local" ] || printf '  cp .env.example .env.local\n'
  printf '  pnpm dev:keys\n  pnpm build && pnpm db:migrate && pnpm db:seed:reference\n'
  printf '================================================================================================\n'
  [ "$FAILED" -eq 0 ] || die "a check failed (see FAILED above): re-run after fixing PostgreSQL or Redis"
}

start_postgres
start_redis
check_superuser
bootstrap_database
create_test_admin
configure_redis
summary
