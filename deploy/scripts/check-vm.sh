#!/usr/bin/env bash
# =====================================================================================================
# check-vm.sh — read-only check of a Velexis VM that provision-vm.sh provisioned (task X-020).
#
#   sudo bash deploy/scripts/check-vm.sh                          # every group, templates of this deploy/ folder
#   sudo bash deploy/scripts/check-vm.sh --only envfiles,files    # selected groups
#   sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh     # against the templates of the active release
#
# It prints one PASS or FAIL line per item and a total, and exits 0 when every item passes, 1 when one fails and 2
# on a usage error. It changes nothing and writes no file: it reads files and asks systemctl, ufw, sshd, swapon,
# sysctl, timedatectl, ss, psql (as postgres), redis-cli and caddy (as caddy). It never prints a value of an env
# file, a key file or .provision-secrets: env files are compared with their templates by variable name only, key
# copies with cmp, the Redis password reaches redis-cli through its environment, and caddy's messages are shown only
# with every value of caddy.env replaced by <redacted> (bash's own errors about a malformed caddy.env line are dropped).
#
# Groups and their items (docs/mvp/deployment-single-vm.md §2 to §7):
#   system    Ubuntu 24.04; time zone UTC; no swap (swapon --show is empty, no swap line in /etc/fstab); no core
#             dumps (kernel.core_pattern |/bin/false, fs.suid_dumpable 0, apport.service masked); unattended
#             upgrades on; an AIDE database exists
#   services  postgresql, redis-server, caddy and velexis-backup.timer active and enabled, the cluster
#             postgresql@16-main active; fail2ban, auditd and chrony active and enabled; Node.js 22
#   firewall  ufw active, incoming denied by default, and only 22, 80 and 443 allowed (each of them allowed)
#   ssh       sshd -T: no password and no keyboard-interactive authentication, no root login, public keys allowed
#   database  PostgreSQL 16 with conf.d/velexis.conf in effect, listening on loopback only; the database belongs to
#             velexis_migrator; the four roles exist (login, not superuser); velexis_ota_app's search_path is pg_catalog
#   redis     Redis 7.4 on loopback only; clients without the password refused; maxmemory 512mb with
#             maxmemory-policy noeviction; AOF on
#   caddy     Caddy 2.8; caddy validate passes with caddy.env, run as the caddy user; the admin API is not on TCP
#             (ss -ltn shows no :2019); /run/caddy is 0700 caddy and holds the socket admin.sock
#   users     the five zone users of ADR-0026 (no shell, locked); the group velexis has exactly them as members and is
#             nobody's primary group; the deploy user is locked and each of its SSH keys carries restrict
#   files     owners and modes of §4: /etc/velexis, the key folders (0500) and key files (0400) of each zone, identical
#             master-key and pepper copies and no zone-only key in the other zone, env files and .provision-secrets
#             root:root 0600, /srv/velexis with incoming, releases (root:velexis, read-only), current and maintenance,
#             /var/lib/velexis and its storage, the backup and log folders, the root-owned scripts, the sudoers rule
#   envfiles  every /etc/velexis/<app>.env has every variable of its deploy/env/<app>.env.example template (an empty
#             value is fine; missing ones are listed by name); caddy.env and ota-backend.env hold the same edge
#             secret, ota-backend.env and ota-admin.env the same service key (compared, never printed)
#
# Options: --only <group,...>; --templates <folder> (the env templates; default: env/ of this script's deploy/ folder).
# Environment: DEPLOY_USER (deploy), DB_NAME (velexis), PG_MAJOR (16), the same values as for provision-vm.sh.
# Tests only: VELEXIS_ROOT=<absolute folder> reads every file under that folder instead of / (the switch of
# provision-vm.sh); deploy/scripts/test/check-vm.test.sh also puts fake system tools first on PATH.
# =====================================================================================================
set -uo pipefail
umask 077

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATES="$DEPLOY_DIR/env"
: "${DEPLOY_USER:=deploy}"
: "${DB_NAME:=velexis}"
: "${PG_MAJOR:=16}"
: "${VELEXIS_ROOT:=}"
ALL_GROUPS="system services firewall ssh database redis caddy users files envfiles"
SELECTED="$ALL_GROUPS"

R="$VELEXIS_ROOT"
ETC="$R/etc/velexis"
SRV="$R/srv/velexis"
LIB="$R/var/lib/velexis"
LOGS="$R/var/log/velexis"
BACKUPS="$R/var/backups/velexis"
SBIN="$R/usr/local/sbin"
SUDOERS_FILE="$R/etc/sudoers.d/velexis-deploy"
SECRETS_FILE="$ETC/.provision-secrets"
CADDY_RUN="$R/run/caddy"
CADDYFILE="$R/etc/caddy/Caddyfile"
ZONE_USERS=(velexis-platform velexis-ota velexis-portal velexis-platform-admin velexis-ota-admin)
RELEASE_GROUP=velexis
ROLES=(velexis_migrator velexis_ota_app velexis_platform_app velexis_provisioner)
ROOT_SCRIPTS=(velexis-deploy velexis-backup velexis-restore velexis-alert velexis-run)

usage() { sed -n '2,/^# =====/p' "$0"; exit "$1"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --only) [ $# -ge 2 ] || usage 2; SELECTED="${2//,/ }"; shift 2 ;;
    --templates) [ $# -ge 2 ] || usage 2; TEMPLATES="$2"; shift 2 ;;
    -h | --help) usage 0 ;;
    *) printf 'check-vm.sh: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
for g in $SELECTED; do
  case " $ALL_GROUPS " in *" $g "*) ;; *) printf 'check-vm.sh: unknown group %s (groups: %s)\n' "$g" "$ALL_GROUPS" >&2; exit 2 ;; esac
done
[ "$(id -u)" -eq 0 ] || { printf 'check-vm.sh: run as root (sudo)\n' >&2; exit 2; }
if [ -n "$R" ]; then
  case "$R" in /?*) ;; *) printf 'check-vm.sh: VELEXIS_ROOT must be an absolute path other than /\n' >&2; exit 2 ;; esac
fi

PASSED=0
FAILED=0
pass() { printf 'PASS %s\n' "$*"; PASSED=$((PASSED + 1)); }
fail() { printf 'FAIL %s\n' "$*"; FAILED=$((FAILED + 1)); }
detail() { printf '     %s\n' "$@"; } # extra lines under a FAIL; never a value
have() { command -v "$1" >/dev/null 2>&1; }
show() { printf '%s' "${1#"$R"}"; }   # a path as it is on the VM (without the test prefix)
mode_of() { stat -c '%U:%G %a' "$1" 2>/dev/null; }
first_line() { printf '%s\n' "$1" | head -n 1; }

expect_mode() { # path "user:group mode"
  local got
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then fail "$(show "$1") exists ($2)"; return; fi
  got="$(mode_of "$1")"
  if [ "$got" = "$2" ]; then pass "$(show "$1") is $2"; else fail "$(show "$1") is $got, expected $2"; fi
}

unit_state() { # unit -> "<active state> <enabled state>"
  local a e
  a="$(systemctl is-active "$1" 2>/dev/null)"
  e="$(systemctl is-enabled "$1" 2>/dev/null)"
  printf '%s %s' "${a:-unknown}" "${e:-unknown}"
}

listening_on() { # port -> the local addresses with a TCP listener on that port, one per line
  ss -Hltn 2>/dev/null | awk -v p=":$1" '{
    a = $4
    if (length(a) > length(p) && substr(a, length(a) - length(p) + 1) == p) print substr(a, 1, length(a) - length(p))
  }'
}

loopback_only() { # port label
  local addrs a bad=""
  if ! have ss; then fail "ss is installed (package iproute2)"; return; fi
  addrs="$(listening_on "$1")"
  if [ -z "$addrs" ]; then fail "$2 listens on 127.0.0.1:$1"; return; fi
  for a in $addrs; do
    case "$a" in 127.0.0.1 | '[::1]' | ::1) ;; *) bad="$bad $a" ;; esac
  done
  if [ -z "$bad" ]; then pass "$2 listens on loopback only (:$1)"; else fail "$2 listens beyond loopback on :$1:$bad"; fi
}

env_value() { # file key -> sets ENV_VALUE to the value of the last KEY= line, quotes removed. Never printed.
  local line v=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$2="*) v="${line#"$2="}" ;; esac
  done <"$1"
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  ENV_VALUE="$v"
}

# ---- system -----------------------------------------------------------------------------------------------
group_system() {
  local os tz swaps fstab state v
  # shellcheck disable=SC1091
  os="$(. /etc/os-release 2>/dev/null && printf '%s %s' "${ID:-}" "${VERSION_ID:-}")"
  if [ "$os" = "ubuntu 24.04" ]; then pass "Ubuntu 24.04 LTS"; else fail "Ubuntu 24.04 LTS (found: ${os:-unknown})"; fi

  tz="$(timedatectl show -p Timezone --value 2>/dev/null)"
  case "$tz" in UTC | Etc/UTC) pass "time zone is UTC" ;; *) fail "time zone is UTC (found: ${tz:-unknown})" ;; esac

  if have swapon; then
    swaps="$(swapon --show --noheadings 2>&1 | awk '{ print $1 }' | paste -sd' ' -)"
    if [ -z "$swaps" ]; then pass "swapon --show is empty (no swap)"; else fail "swap is on: $swaps"; fi
  else
    fail "swapon is installed"
  fi
  fstab="$(awk '$0 !~ /^[[:space:]]*#/ && $3 == "swap" { print $1 }' "$R/etc/fstab" 2>/dev/null | paste -sd' ' -)"
  if [ -z "$fstab" ]; then pass "/etc/fstab activates no swap"; else fail "/etc/fstab activates swap at boot: $fstab"; fi

  v="$(sysctl -n kernel.core_pattern 2>/dev/null)"
  if [ "$v" = "|/bin/false" ]; then pass "kernel.core_pattern is |/bin/false (no core dumps)"; else fail "kernel.core_pattern is |/bin/false (found: ${v:-unknown})"; fi
  v="$(sysctl -n fs.suid_dumpable 2>/dev/null)"
  if [ "$v" = 0 ]; then pass "fs.suid_dumpable is 0"; else fail "fs.suid_dumpable is 0 (found: ${v:-unknown})"; fi
  state="$(systemctl is-enabled apport.service 2>/dev/null)"
  case "$state" in
    masked | masked-runtime) pass "apport.service is masked (it would replace kernel.core_pattern at boot)" ;;
    '' | not-found) pass "apport.service is not installed" ;;
    *) fail "apport.service is $state: it replaces kernel.core_pattern at every boot (mask it)" ;;
  esac

  if grep -qE '^APT::Periodic::Unattended-Upgrade "1";' "$R/etc/apt/apt.conf.d/20auto-upgrades" 2>/dev/null; then
    pass "unattended-upgrades runs daily"
  else
    fail "unattended-upgrades runs daily (/etc/apt/apt.conf.d/20auto-upgrades)"
  fi
  if [ -s "$R/var/lib/aide/aide.db" ]; then pass "the AIDE database exists"; else fail "the AIDE database exists (/var/lib/aide/aide.db; run aideinit)"; fi
}

# ---- services ---------------------------------------------------------------------------------------------
group_services() {
  local u s v
  if ! have systemctl; then fail "systemctl is installed"; return; fi
  for u in postgresql redis-server caddy velexis-backup.timer fail2ban auditd chrony; do
    s="$(unit_state "$u")"
    if [ "$s" = "active enabled" ]; then pass "$u is active and enabled"; else fail "$u is active and enabled (found: $s)"; fi
  done
  # postgresql.service only groups the clusters; this is the server (started through postgresql.service).
  s="$(systemctl is-active "postgresql@${PG_MAJOR}-main" 2>/dev/null)"
  if [ "$s" = active ]; then pass "postgresql@${PG_MAJOR}-main is active"; else fail "postgresql@${PG_MAJOR}-main is active (found: ${s:-unknown})"; fi
  v="$(node --version 2>/dev/null)"
  case "$v" in v22.*) pass "Node.js $v" ;; *) fail "Node.js 22 (found: ${v:-none})" ;; esac
}

# ---- firewall ---------------------------------------------------------------------------------------------
group_firewall() {
  local out rules to port p seen="" extra="" missing=""
  if ! have ufw; then fail "ufw is installed"; return; fi
  out="$(ufw status verbose 2>&1)"
  if printf '%s\n' "$out" | grep -q '^Status: active'; then pass "ufw is active"; else fail "ufw is active (found: $(first_line "$out"))"; fi
  if printf '%s\n' "$out" | grep -q '^Default: deny (incoming)'; then
    pass "ufw denies incoming connections by default"
  else
    fail "ufw denies incoming connections by default"
  fi
  # Rules below the "--" line: To, Action, From, separated by two or more spaces. Only ALLOW and LIMIT rules for
  # incoming traffic open a port; "Anywhere" (all ports), app profiles and ranges count as more than allowed.
  rules="$(printf '%s\n' "$out" | awk '
    /^--/ { body = 1; next }
    body && NF {
      split($0, col, /  +/)
      if (col[2] ~ /OUT/ || col[2] !~ /^(ALLOW|LIMIT)/) next
      to = col[1]
      sub(/ \(v6\)$/, "", to)
      sub(/ on [^ ]+$/, "", to)
      gsub(/ /, "_", to)
      print to
    }' | sort -u)"
  for to in $rules; do
    port="${to%%/*}"
    [ "$port" != OpenSSH ] || port=22   # the ufw application profile of openssh-server
    for p in ${port//,/ }; do
      case "$p" in
        22 | 80 | 443) case " $seen " in *" $p "*) ;; *) seen="$seen $p" ;; esac ;;
        *) case " $extra " in *" $to "*) ;; *) extra="$extra $to" ;; esac ;;
      esac
    done
  done
  if [ -z "$extra" ]; then
    pass "ufw allows only 22, 80 and 443 (rules: $(printf '%s' "$rules" | paste -sd' ' -))"
  else
    fail "ufw allows more than 22, 80 and 443:$extra"
  fi
  for p in 22 80 443; do case " $seen " in *" $p "*) ;; *) missing="$missing $p" ;; esac; done
  if [ -z "$missing" ]; then pass "ufw allows 22, 80 and 443"; else fail "ufw does not allow:$missing"; fi
}

# ---- ssh --------------------------------------------------------------------------------------------------
group_ssh() {
  local out key want got
  if ! have sshd; then fail "sshd is installed"; return; fi
  if ! out="$(sshd -T 2>&1)"; then fail "sshd -T runs ($(first_line "$out"))"; return; fi
  for key in passwordauthentication:no kbdinteractiveauthentication:no permitrootlogin:no pubkeyauthentication:yes; do
    want="${key#*:}"
    key="${key%%:*}"
    got="$(printf '%s\n' "$out" | awk -v k="$key" '$1 == k { print $2; exit }')"
    if [ "$got" = "$want" ]; then pass "sshd -T: $key $want"; else fail "sshd -T: $key $want (found: ${got:-unset})"; fi
  done
}

# ---- database ---------------------------------------------------------------------------------------------
pg() { # sql -> rows; psql as postgres over the local socket (peer authentication), read-only queries only
  (cd / && runuser -u postgres -- psql -X -A -t -q -v ON_ERROR_STOP=1 -d postgres -c "$1") 2>&1
}

group_database() {
  local out row r settings bad=""
  if ! have psql || ! have runuser; then fail "psql and runuser are installed"; return; fi
  case "$DB_NAME" in '' | [0-9]* | *[!a-z0-9_]*) fail "DB_NAME is a plain identifier (found: $DB_NAME)"; return ;; esac
  if ! settings="$(pg "/* check:settings */ SELECT name || '=' || setting FROM pg_settings WHERE name IN
      ('server_version_num', 'listen_addresses', 'shared_preload_libraries', 'max_locks_per_transaction',
       'log_parameter_max_length') ORDER BY 1")"; then
    fail "PostgreSQL answers psql as postgres ($(first_line "$settings"))"
    return
  fi
  for row in $settings; do
    case "$row" in
      server_version_num=*) [ "$(( ${row#*=} / 10000 ))" = "$PG_MAJOR" ] || bad="$bad $row" ;;
      listen_addresses=*) [ "$row" = listen_addresses=localhost ] || bad="$bad $row" ;;
      shared_preload_libraries=*) case "$row" in *pg_stat_statements*) ;; *) bad="$bad $row" ;; esac ;;
      max_locks_per_transaction=*) [ "$row" = max_locks_per_transaction=256 ] || bad="$bad $row" ;;
      log_parameter_max_length=*) [ "$row" = log_parameter_max_length=0 ] || bad="$bad $row" ;;
    esac
  done
  if [ -z "$bad" ] && [ "$(printf '%s\n' "$settings" | grep -c .)" = 5 ]; then
    pass "PostgreSQL $PG_MAJOR runs with conf.d/velexis.conf (listen_addresses, max_locks_per_transaction, pg_stat_statements, log_parameter_max_length)"
  else
    fail "PostgreSQL $PG_MAJOR runs with conf.d/velexis.conf (found:$bad)"
  fi
  loopback_only 5432 PostgreSQL

  out="$(pg "/* check:database */ SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$DB_NAME'")"
  if [ "$out" = velexis_migrator ]; then pass "database $DB_NAME belongs to velexis_migrator"; else fail "database $DB_NAME belongs to velexis_migrator (found: ${out:-no such database})"; fi

  out="$(pg "/* check:roles */ SELECT rolname || ' ' || CASE WHEN rolcanlogin THEN 'login' ELSE 'nologin' END || ' ' ||
      CASE WHEN rolsuper THEN 'superuser' ELSE 'nosuperuser' END FROM pg_roles
      WHERE rolname IN ('velexis_migrator', 'velexis_provisioner', 'velexis_platform_app', 'velexis_ota_app') ORDER BY 1")"
  for r in "${ROLES[@]}"; do
    row="$(printf '%s\n' "$out" | awk -v r="$r" '$1 == r { print $2, $3 }')"
    case "$row" in
      "login nosuperuser") pass "role $r exists (login, not superuser)" ;;
      '') fail "role $r exists" ;;
      *) fail "role $r is login and not superuser (found: $row)" ;;
    esac
  done

  # The effective setting: a per-database ALTER ROLE ... IN DATABASE wins over the role-wide one (ADR-0004 leak guard).
  out="$(pg "/* check:search_path */ SELECT coalesce(
      (SELECT c FROM pg_db_role_setting s CROSS JOIN unnest(s.setconfig) c
        WHERE s.setrole = r.oid AND s.setdatabase = d.oid AND c LIKE 'search_path=%'),
      (SELECT c FROM pg_db_role_setting s CROSS JOIN unnest(s.setconfig) c
        WHERE s.setrole = r.oid AND s.setdatabase = 0 AND c LIKE 'search_path=%'), 'search_path unset')
    FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname = 'velexis_ota_app' AND d.datname = '$DB_NAME'")"
  if [ "$out" = "search_path=pg_catalog" ]; then
    pass "velexis_ota_app's search_path is pg_catalog"
  else
    fail "velexis_ota_app's search_path is pg_catalog (found: ${out:-no role or database})"
  fi
}

# ---- redis ------------------------------------------------------------------------------------------------
REDIS_PW=""
rcli() { REDISCLI_AUTH="$REDIS_PW" redis-cli -h 127.0.0.1 -p 6379 --no-auth-warning "$@" 2>&1 | tr -d '\r'; }

group_redis() {
  local out k v
  if ! have redis-cli; then fail "redis-cli is installed"; return; fi
  loopback_only 6379 Redis
  out="$(env -u REDISCLI_AUTH redis-cli -h 127.0.0.1 -p 6379 PING 2>&1)"
  case "$out" in *NOAUTH*) pass "Redis refuses clients without the password" ;; *) fail "Redis refuses clients without the password (found: $(first_line "$out"))" ;; esac
  REDIS_PW=""
  if [ -r "$SECRETS_FILE" ]; then
    while IFS='=' read -r k v; do [ "$k" != REDIS_PASSWORD ] || REDIS_PW="$v"; done <"$SECRETS_FILE"
  fi
  if [ -z "$REDIS_PW" ]; then fail "REDIS_PASSWORD is in $(show "$SECRETS_FILE")"; return; fi
  out="$(rcli INFO server | sed -n 's/^redis_version://p')"
  case "$out" in 7.4.*) pass "Redis $out" ;; *) fail "Redis 7.4 (found: ${out:-no answer})" ;; esac
  out="$(rcli CONFIG GET maxmemory-policy | sed -n 2p)"
  if [ "$out" = noeviction ]; then pass "maxmemory-policy is noeviction"; else fail "maxmemory-policy is noeviction (found: ${out:-no answer})"; fi
  out="$(rcli CONFIG GET maxmemory | sed -n 2p)"
  if [ "$out" = 536870912 ]; then pass "maxmemory is 512mb"; else fail "maxmemory is 512mb (found: ${out:-no answer})"; fi
  out="$(rcli CONFIG GET appendonly | sed -n 2p)"
  if [ "$out" = yes ]; then pass "AOF persistence is on"; else fail "AOF persistence is on (found: ${out:-no answer})"; fi
  REDIS_PW=""
}

# ---- caddy ------------------------------------------------------------------------------------------------
redact() { # text file -> the text with every value of the env file (6 characters or more) replaced
  local text="$1" line v
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in [A-Za-z_]*=*) ;; *) continue ;; esac
    v="${line#*=}"
    case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
    [ "${#v}" -lt 6 ] || text="${text//"$v"/"<redacted>"}"
  done <"$2"
  printf '%s' "$text"
}

group_caddy() {
  local out rc bin v addrs
  if ! have caddy; then fail "caddy is installed"; return; fi
  bin="$(command -v caddy)"
  v="$(caddy version 2>/dev/null | awk '{ print $1; exit }')"
  case "$v" in v2.8.*) pass "Caddy $v" ;; *) fail "Caddy 2.8 (found: ${v:-unknown})" ;; esac

  if [ ! -r "$ETC/caddy.env" ]; then
    fail "caddy validate passes with $(show "$ETC/caddy.env") (the file is missing)"
  elif ! id -u caddy >/dev/null 2>&1; then
    fail "caddy validate passes with caddy.env (there is no caddy user)"
  else
    # As the caddy service runs it: the caddy user, with caddy.env in its environment (never on a command line).
    # Errors of the file itself are dropped: for a malformed line bash would print part of a value ("<value>: command
    # not found"), which the redaction below cannot recognise. caddy validate then names what is missing.
    out="$(
      set -a
      # shellcheck disable=SC1090,SC1091
      . "$ETC/caddy.env" 2>/dev/null
      set +a
      cd / && runuser -u caddy -- "$bin" validate --config "$CADDYFILE" --adapter caddyfile 2>&1
    )"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      pass "caddy validate passes for $(show "$CADDYFILE") with caddy.env (as the caddy user)"
    else
      fail "caddy validate passes for $(show "$CADDYFILE") with caddy.env (as the caddy user)"
      out="$(redact "$out" "$ETC/caddy.env")"
      printf '%s\n' "$out" | tail -n 5 | while IFS= read -r v; do detail "$v"; done
    fi
  fi

  if have ss; then
    addrs="$(listening_on 2019 | paste -sd' ' -)"
    if [ -z "$addrs" ]; then pass "Caddy's admin API is not on TCP (ss -ltn shows no :2019)"; else fail "something listens on TCP :2019: $addrs"; fi
  else
    fail "ss is installed (package iproute2)"
  fi
  expect_mode "$CADDY_RUN" "caddy:caddy 700"
  if [ -S "$CADDY_RUN/admin.sock" ]; then pass "$(show "$CADDY_RUN")/admin.sock is a unix socket"; else fail "$(show "$CADDY_RUN")/admin.sock is a unix socket (is Caddy running with the Velexis Caddyfile?)"; fi
}

# ---- users ------------------------------------------------------------------------------------------------
locked() { case "$(getent shadow "$1" | cut -d: -f2)" in '!'* | '*'*) return 0 ;; *) return 1 ;; esac; }

group_users() {
  local u shell members want gid others home keys bad
  for u in "${ZONE_USERS[@]}"; do
    if ! id -u "$u" >/dev/null 2>&1; then fail "user $u exists"; continue; fi
    shell="$(getent passwd "$u" | cut -d: -f7)"
    if [ "$shell" = /usr/sbin/nologin ] && locked "$u"; then
      pass "user $u: no shell, password locked"
    else
      fail "user $u: no shell, password locked (shell $shell)"
    fi
  done
  if getent group "$RELEASE_GROUP" >/dev/null; then
    members="$(getent group "$RELEASE_GROUP" | cut -d: -f4 | tr ',' '\n' | sort | paste -sd, -)"
    want="$(printf '%s\n' "${ZONE_USERS[@]}" | sort | paste -sd, -)"
    if [ "$members" = "$want" ]; then pass "group $RELEASE_GROUP has exactly the five zone users"; else fail "group $RELEASE_GROUP has exactly the five zone users (found: ${members:-none})"; fi
    gid="$(getent group "$RELEASE_GROUP" | cut -d: -f3)"
    others="$(getent passwd | awk -F: -v gid="$gid" '$4 == gid { printf "%s ", $1 }')"
    if [ -z "$others" ]; then pass "group $RELEASE_GROUP is nobody's primary group"; else fail "group $RELEASE_GROUP is the primary group of: $others"; fi
  else
    fail "group $RELEASE_GROUP exists"
  fi

  if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then fail "deploy user $DEPLOY_USER exists"; return; fi
  if locked "$DEPLOY_USER"; then pass "deploy user $DEPLOY_USER: password locked"; else fail "deploy user $DEPLOY_USER: password locked"; fi
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  if [ ! -s "$home/.ssh/authorized_keys" ]; then
    fail "$home/.ssh/authorized_keys holds the deploy key (set DEPLOY_SSH_PUBKEY_FILE and run provision-vm.sh --steps users)"
    return
  fi
  expect_mode "$home/.ssh/authorized_keys" "$DEPLOY_USER:$DEPLOY_USER 600"
  keys="$(grep -cvE '^[[:space:]]*(#|$)' "$home/.ssh/authorized_keys")"
  bad="$(grep -vE '^[[:space:]]*(#|$)' "$home/.ssh/authorized_keys" | grep -cvE '^restrict[ ,]')"
  if [ "$bad" = 0 ]; then pass "every key of $DEPLOY_USER carries restrict ($keys)"; else fail "$bad of $keys keys of $DEPLOY_USER lack restrict"; fi
}

# ---- files ------------------------------------------------------------------------------------------------
key_folder() { # folder owner required-file... -> the required files exist, and every file is 0400 owner:owner
  local dir="$1" owner="$2" f missing="" bad=""
  shift 2
  expect_mode "$dir" "$owner:$owner 500"
  [ -d "$dir" ] || return 0
  for f in "$@"; do [ -e "$dir/$f" ] || missing="$missing $f"; done
  for f in "$dir"/* "$dir"/.[!.]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    [ "$(mode_of "$f")" = "$owner:$owner 400" ] && [ -f "$f" ] && [ ! -L "$f" ] || bad="$bad $(basename "$f") ($(mode_of "$f"))"
  done
  if [ -n "$missing" ]; then fail "$(show "$dir") holds$missing"; else pass "$(show "$dir") holds $*"; fi
  if [ -z "$bad" ]; then pass "every file in $(show "$dir") is a plain file, 0400 $owner"; else fail "files in $(show "$dir") that are not 0400 $owner:$bad"; fi
}

group_files() {
  local k="$ETC/keys" f name rel target bad
  expect_mode "$ETC" "root:root 711"
  expect_mode "$k" "root:root 711"
  key_folder "$k/platform" velexis-platform master-v1.key api-key-pepper platform-jwt-ed25519.pem
  key_folder "$k/ota" velexis-ota master-v1.key api-key-pepper ota-jwt-ed25519.pem document-url.key
  # Keys both backends need are identical copies (ADR-0026), including every master key of a rotation.
  for name in $( (cd "$k/platform" 2>/dev/null && ls -1 master-v*.key api-key-pepper 2>/dev/null
                  cd "$k/ota" 2>/dev/null && ls -1 master-v*.key api-key-pepper 2>/dev/null) | sort -u); do
    if [ -f "$k/platform/$name" ] && [ -f "$k/ota/$name" ] && cmp -s "$k/platform/$name" "$k/ota/$name"; then
      pass "$name: identical copies in keys/platform and keys/ota"
    else
      fail "$name: identical copies in keys/platform and keys/ota"
    fi
  done
  bad=""
  for f in ota-jwt-ed25519.pem document-url.key; do [ ! -e "$k/platform/$f" ] || bad="$bad platform/$f"; done
  [ ! -e "$k/ota/platform-jwt-ed25519.pem" ] || bad="$bad ota/platform-jwt-ed25519.pem"
  if [ -z "$bad" ]; then pass "no zone holds the other zone's own keys"; else fail "keys in the wrong zone:$bad"; fi
  expect_mode "$ETC/backup" "root:root 700"

  bad=""
  for f in "$ETC"/*.env "$SECRETS_FILE"; do
    [ -e "$f" ] || continue
    [ "$(mode_of "$f")" = "root:root 600" ] || bad="$bad $(basename "$f") ($(mode_of "$f"))"
  done
  if [ ! -e "$SECRETS_FILE" ]; then fail "$(show "$SECRETS_FILE") exists"; fi
  if [ -z "$bad" ]; then pass "every env file and .provision-secrets is root:root 600"; else fail "env files that are not root:root 600:$bad"; fi

  expect_mode "$SRV" "root:root 755"
  expect_mode "$SRV/incoming" "$DEPLOY_USER:$DEPLOY_USER 750"
  expect_mode "$SRV/releases" "root:$RELEASE_GROUP 751"
  for rel in "$SRV"/releases/*; do
    [ -e "$rel" ] || continue
    bad="$(find "$rel" \( ! -user root -o ! -group "$RELEASE_GROUP" -o -perm /222 \) -print -quit 2>/dev/null)"
    if [ -d "$rel" ] && [ -z "$bad" ]; then
      pass "$(show "$rel") is root:$RELEASE_GROUP and read-only"
    else
      fail "$(show "$rel") is root:$RELEASE_GROUP and read-only (first exception: $(show "${bad:-$rel}"))"
    fi
  done
  if [ -L "$SRV/current" ]; then
    target="$(readlink "$SRV/current")"
    case "$target" in
      "$SRV"/releases/?* | releases/?*) if [ -d "$SRV/current/" ]; then pass "$(show "$SRV/current") points at $(show "$target")"; else fail "$(show "$SRV/current") points at a missing release"; fi ;;
      *) fail "$(show "$SRV/current") points outside $(show "$SRV/releases")" ;;
    esac
  elif [ -e "$SRV/current" ]; then
    fail "$(show "$SRV/current") is a symlink"
  else
    pass "$(show "$SRV/current"): no release deployed yet"
  fi
  expect_mode "$SRV/maintenance" "root:root 755"
  expect_mode "$SRV/maintenance/index.html" "root:root 644"

  expect_mode "$LIB" "root:root 711"
  expect_mode "$LIB/storage" "velexis-ota:velexis-ota 700"
  expect_mode "$BACKUPS" "root:root 700"
  expect_mode "$LOGS" "root:adm 750"
  for f in "${ROOT_SCRIPTS[@]}"; do expect_mode "$SBIN/$f" "root:root 755"; done
  expect_mode "$SUDOERS_FILE" "root:root 440"
  if [ "$(cat "$SUDOERS_FILE" 2>/dev/null)" = "$DEPLOY_USER ALL=(root) NOPASSWD: $SBIN/velexis-deploy" ]; then
    pass "$DEPLOY_USER may run only $(show "$SBIN")/velexis-deploy with sudo"
  else
    fail "$(show "$SUDOERS_FILE") allows $DEPLOY_USER exactly $(show "$SBIN")/velexis-deploy"
  fi
}

# ---- envfiles ---------------------------------------------------------------------------------------------
same_value() { # key file-a file-b: compares the two values without printing them
  local a b
  if [ ! -f "$ETC/$2" ] || [ ! -f "$ETC/$3" ]; then fail "$1 is the same in $2 and $3 (a file is missing)"; return; fi
  env_value "$ETC/$2" "$1"
  a="$ENV_VALUE"
  env_value "$ETC/$3" "$1"
  b="$ENV_VALUE"
  ENV_VALUE=""
  if [ -n "$a" ] && [ "$a" = "$b" ]; then pass "$1 is the same in $2 and $3"; else fail "$1 is the same, and not empty, in $2 and $3"; fi
}

group_envfiles() {
  local tpl name dest keys key missing n=0
  for tpl in "$TEMPLATES"/*.env.example; do
    [ -f "$tpl" ] || continue
    n=$((n + 1))
    name="$(basename "$tpl" .example)"
    dest="$ETC/$name"
    keys="$(grep -oE '^[A-Z][A-Z0-9_]*=' "$tpl" | tr -d '=')"
    if [ ! -f "$dest" ]; then
      if [ -z "$keys" ]; then pass "$(show "$dest") is optional (its template names no variable)"; else fail "$(show "$dest") exists (template $name.example)"; fi
      continue
    fi
    missing=""
    for key in $keys; do grep -qE "^${key}=" "$dest" || missing="$missing $key"; done
    if [ -z "$missing" ]; then
      pass "$(show "$dest") has every variable of $name.example ($(printf '%s\n' "$keys" | grep -c .))"
    else
      fail "$(show "$dest") lacks variables of $name.example:$missing"
    fi
  done
  if [ "$n" = 0 ]; then fail "env templates found in $TEMPLATES"; return; fi
  same_value VELEXIS_EDGE_SECRET caddy.env ota-backend.env
  same_value OTA_ADMIN_SERVICE_KEY ota-backend.env ota-admin.env
}

printf 'check-vm.sh on %s (%s)\n' "$(hostname 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
for g in $SELECTED; do
  printf '\n== %s\n' "$g"
  "group_$g"
done
printf '\ncheck-vm: %d PASS, %d FAIL\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
