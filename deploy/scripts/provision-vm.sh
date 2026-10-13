#!/usr/bin/env bash
# =====================================================================================================
# provision-vm.sh — turn a blank Ubuntu 24.04 LTS VM into the Velexis host (ADR-0007, no Docker).
#
# TEMPLATE: finalised and tested by task X-020 (docs/mvp/plans/foundation-tasks.md). Read
# docs/mvp/deployment-single-vm.md first. Idempotent: re-running never overwrites existing secrets,
# key files or env files; it re-applies packages, configuration, units and root-owned scripts.
#
# Usage (as root, on the VM, from a copy of the repository's deploy/ folder):
#   scp -r deploy/ admin@vm:/tmp/velexis-deploy
#   sudo DEPLOY_SSH_PUBKEY_FILE=/tmp/deploy.pub ADMIN_USER=ubuntu bash /tmp/velexis-deploy/scripts/provision-vm.sh
#   sudo bash /tmp/velexis-deploy/scripts/provision-vm.sh --steps scripts,caddy    # re-run selected steps only
#
# Steps: packages harden users node postgres redis caddy keys database envfiles scripts caddyconf summary
#
# Users (ADR-0026, task X-033): one system user per trust zone (velexis-platform, velexis-ota, velexis-portal,
# velexis-platform-admin, velexis-ota-admin) and the group velexis, which only lets them read releases. Keys live in
# one folder per backend zone; env files are root:root 0600 and read by systemd only.
#
# Tests only: VELEXIS_ROOT=<absolute folder> moves every Velexis path (/etc/velexis, /srv/velexis, /var/lib/velexis,
# /var/log/velexis, /var/backups/velexis, /usr/local/sbin and the deploy sudoers file) under that folder, and allows
# only the steps users, keys and envfiles (deploy/systemd/test/units-smoke.sh). The system users are real.
# =====================================================================================================
set -euo pipefail

# ---- Placeholders: override through the environment ---------------------------------------------------
: "${ADMIN_USER:=ubuntu}"                 # existing sudo user of the cloud image; keeps SSH access
: "${DEPLOY_USER:=deploy}"                # GitHub Actions uploads releases and runs velexis-deploy as this user
: "${DEPLOY_SSH_PUBKEY_FILE:=}"           # public half of the GitHub Actions deploy key (required on first run)
: "${SSH_ALLOW_FROM:=any}"                # CIDR for SSH; "any" because GitHub-hosted runners have changing IPs
: "${DB_NAME:=velexis}"
: "${NODE_MAJOR:=22}"
: "${PNPM_VERSION:=9.15.9}"
: "${PG_MAJOR:=16}"
: "${REDIS_PIN:=6:7.4*}"                  # packages.redis.io version string of Redis 7.4
: "${CADDY_PIN:=2.8*}"
: "${VELEXIS_ROOT:=}"                     # tests only, see the header; empty on the VM

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ETC="$VELEXIS_ROOT/etc/velexis"
SRV="$VELEXIS_ROOT/srv/velexis"
LIB="$VELEXIS_ROOT/var/lib/velexis"
LOGS="$VELEXIS_ROOT/var/log/velexis"
BACKUPS="$VELEXIS_ROOT/var/backups/velexis"
SBIN="$VELEXIS_ROOT/usr/local/sbin"
SUDOERS_DIR="$VELEXIS_ROOT/etc/sudoers.d"
SECRETS_FILE="$ETC/.provision-secrets"   # generated passwords, root 0600, reused on every run

# One system user per trust zone (ADR-0026). An API and its worker share their zone's user.
PLATFORM_USER=velexis-platform             # velexis-platform-api, velexis-platform-worker; keys/platform
OTA_USER=velexis-ota                       # velexis-ota-api, velexis-ota-worker; keys/ota and the storage folder
ZONE_USERS="$PLATFORM_USER $OTA_USER velexis-portal velexis-platform-admin velexis-ota-admin"
RELEASE_GROUP=velexis                      # its only members are the zone users; it only grants reading releases
ALL_STEPS="packages harden users node postgres redis caddy keys database envfiles scripts caddyconf summary"
STEPS="$ALL_STEPS"

log() { printf '\n==> [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
gen_secret() { openssl rand -hex 24; }   # hex: safe inside URLs and env files
apt_install() { DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --steps) STEPS="${2//,/ }"; shift 2 ;;
    -h|--help) sed -n '2,/^# =====/p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"
if [ -n "$VELEXIS_ROOT" ]; then
  case "$VELEXIS_ROOT" in /?*) ;; *) die "VELEXIS_ROOT must be an absolute path other than /" ;; esac
  [ -d "$VELEXIS_ROOT" ] || die "VELEXIS_ROOT $VELEXIS_ROOT is not a folder"
  for step in $STEPS; do
    case "$step" in
      users | keys | envfiles) ;;
      *) die "with VELEXIS_ROOT only the steps users, keys and envfiles run, not $step" ;;
    esac
  done
fi
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  die "Ubuntu 24.04 LTS expected, found ${PRETTY_NAME:-unknown}"
fi
CODENAME="$VERSION_CODENAME"

# ---- packages: base tools and vendor apt repositories ------------------------------------------------
step_packages() {
  log "Base packages and vendor repositories"
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
  apt_install ca-certificates curl gnupg lsb-release jq rsync zstd openssl age rclone \
    ufw fail2ban unattended-upgrades auditd aide aide-common acl logrotate chrony
  install -d -m 0755 /etc/apt/keyrings

  # Node.js (NodeSource)
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  # PostgreSQL (PGDG)
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor --yes -o /etc/apt/keyrings/pgdg.gpg
  echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  # Redis (packages.redis.io), pinned to 7.4
  curl -fsSL https://packages.redis.io/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/redis.gpg
  echo "deb [signed-by=/etc/apt/keyrings/redis.gpg] https://packages.redis.io/deb ${CODENAME} main" \
    > /etc/apt/sources.list.d/redis.list
  printf 'Package: redis redis-server redis-tools\nPin: version %s\nPin-Priority: 1001\n' "$REDIS_PIN" \
    > /etc/apt/preferences.d/velexis-redis
  # Caddy (official repository), pinned to 2.8
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/caddy.gpg
  echo "deb [signed-by=/etc/apt/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    > /etc/apt/sources.list.d/caddy.list
  printf 'Package: caddy\nPin: version %s\nPin-Priority: 1001\n' "$CADDY_PIN" > /etc/apt/preferences.d/velexis-caddy
  apt-get update -y
}

# ---- harden: OS settings, SSH, firewall, patches, audit, file integrity --------------------------------
step_harden() {
  log "OS hardening"
  timedatectl set-timezone UTC
  systemctl enable --now chrony

  # No swap: card data held in memory must never be paged to disk (ADR-0011).
  swapoff -a
  sed -i -E '/^[^#].*\sswap\s/ s/^/#/' /etc/fstab

  cat > /etc/sysctl.d/90-velexis.conf <<'EOF'
# Velexis host settings (deploy/scripts/provision-vm.sh)
vm.overcommit_memory = 1
vm.swappiness = 1
fs.suid_dumpable = 0
kernel.core_pattern = |/bin/false
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
net.core.somaxconn = 4096
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
EOF
  sysctl --system >/dev/null
  # Redis recommends transparent huge pages off.
  echo 'w /sys/kernel/mm/transparent_hugepage/enabled - - - - never' > /etc/tmpfiles.d/velexis-thp.conf
  systemd-tmpfiles --create /etc/tmpfiles.d/velexis-thp.conf || true

  # SSH: keys only, no root, only the admin and deploy users.
  cat > /etc/ssh/sshd_config.d/90-velexis.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers ${ADMIN_USER} ${DEPLOY_USER}
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
  sshd -t
  systemctl reload ssh || systemctl reload sshd || true

  # Firewall: 22, 80, 443 (TCP) and 443/udp (HTTP/3). Everything else closed.
  ufw default deny incoming
  ufw default allow outgoing
  if [ "$SSH_ALLOW_FROM" = "any" ]; then ufw limit 22/tcp; else ufw allow from "$SSH_ALLOW_FROM" to any port 22 proto tcp; fi
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw --force enable

  cat > /etc/fail2ban/jail.d/velexis.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  systemctl enable --now fail2ban
  systemctl restart fail2ban

  # Security patches daily; no automatic reboot (the developer reboots after reading the notice).
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

  # auditd: watch configuration, keys, units and privileged files (PCI controls, ADR-0011).
  cat > /etc/audit/rules.d/velexis.rules <<'EOF'
-w /etc/velexis/ -p wa -k velexis-config
-w /etc/velexis/keys/ -p wa -k velexis-keys
-w /etc/caddy/ -p wa -k caddy-config
-w /etc/systemd/system/ -p wa -k systemd-units
-w /usr/local/sbin/ -p wa -k velexis-scripts
-w /etc/sudoers -p wa -k sudoers
-w /etc/sudoers.d/ -p wa -k sudoers
-w /etc/ssh/sshd_config.d/ -p wa -k sshd
EOF
  augenrules --load >/dev/null || warn "augenrules failed; check auditd"
  systemctl enable --now auditd

  # AIDE file integrity: exclude data and release folders that change by design.
  cat > /etc/aide/aide.conf.d/90_velexis <<'EOF'
!/srv/velexis/releases
!/srv/velexis/incoming
!/var/lib/velexis
!/var/backups/velexis
!/var/lib/postgresql
!/var/lib/redis
!/var/lib/caddy
!/var/log
!/var/cache/velexis
EOF
  if [ ! -f /var/lib/aide/aide.db ]; then
    log "Initialising the AIDE database (takes a few minutes)"
    aideinit -y -f >/dev/null || warn "aideinit failed; run it manually"
  fi

  install -m 0644 "$DEPLOY_DIR/journald/velexis.conf" -D /etc/systemd/journald.conf.d/velexis.conf
  systemctl restart systemd-journald
  install -m 0644 "$DEPLOY_DIR/logrotate/velexis" /etc/logrotate.d/velexis
}

# ---- users and directories (deployment-single-vm.md §4, ADR-0026) ---------------------------------------
step_users() {
  log "Users and directories"
  local u gid others
  getent group "$RELEASE_GROUP" >/dev/null || groupadd --system "$RELEASE_GROUP"
  for u in $ZONE_USERS; do
    # No home, no shell, no password (locked): systemd starts these users' processes, nobody logs in as them.
    id -u "$u" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin "$u"
    [ "$(getent passwd "$u" | cut -d: -f7)" = /usr/sbin/nologin ] || usermod --shell /usr/sbin/nologin "$u"
    case "$(getent shadow "$u" | cut -d: -f2)" in '!'* | '*'*) ;; *) passwd -l "$u" >/dev/null ;; esac
  done
  # Exactly the five zone users read releases through the group: set the member list, never add to it.
  gpasswd -M "$(echo "$ZONE_USERS" | tr ' ' ',')" "$RELEASE_GROUP" >/dev/null
  gid="$(getent group "$RELEASE_GROUP" | cut -d: -f3)"
  others="$(getent passwd | awk -F: -v gid="$gid" '$4 == gid { printf "%s ", $1 }')"
  [ -z "$others" ] || warn "accounts with the primary group $RELEASE_GROUP can read releases too: ${others}(ADR-0026)"

  id -u "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --user-group --shell /bin/bash "$DEPLOY_USER"
  passwd -l "$DEPLOY_USER" >/dev/null
  install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
  if [ -n "$DEPLOY_SSH_PUBKEY_FILE" ]; then
    # restrict: no PTY, no forwarding. rsync and the sudo call below work without them.
    printf 'restrict %s\n' "$(cat "$DEPLOY_SSH_PUBKEY_FILE")" > "/home/$DEPLOY_USER/.ssh/authorized_keys"
    chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
    chmod 0600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
  elif [ ! -s "/home/$DEPLOY_USER/.ssh/authorized_keys" ]; then
    warn "DEPLOY_SSH_PUBKEY_FILE not set: the deploy workflow cannot log in yet"
  fi

  # The deploy user may run exactly one root command: the root-owned deploy script.
  mkdir -p "$SUDOERS_DIR"
  echo "${DEPLOY_USER} ALL=(root) NOPASSWD: $SBIN/velexis-deploy" > "$SUDOERS_DIR/velexis-deploy"
  chmod 0440 "$SUDOERS_DIR/velexis-deploy"
  visudo -cf "$SUDOERS_DIR/velexis-deploy" >/dev/null

  install -d -m 0755 -o root -g root "$SRV"
  install -d -m 0751 -o root -g "$RELEASE_GROUP" "$SRV/releases"
  install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$SRV/incoming"
  # /etc/velexis and its keys folder can be crossed, not listed: each zone reaches only its own key folder.
  install -d -m 0711 -o root -g root "$ETC" "$ETC/keys"
  install -d -m 0500 -o "$PLATFORM_USER" -g "$PLATFORM_USER" "$ETC/keys/platform"
  install -d -m 0500 -o "$OTA_USER" -g "$OTA_USER" "$ETC/keys/ota"
  install -d -m 0700 -o root -g root "$ETC/backup"
  install -d -m 0711 -o root -g root "$LIB"
  install -d -m 0700 -o "$OTA_USER" -g "$OTA_USER" "$LIB/storage"
  install -d -m 0700 -o root -g root "$BACKUPS"
  install -d -m 0750 -o root -g adm "$LOGS"
}

# ---- node: Node.js 22 and pnpm (pnpm only for emergency builds; releases are pre-built) ----------------
step_node() {
  log "Node.js ${NODE_MAJOR} and pnpm ${PNPM_VERSION}"
  apt_install nodejs
  node --version | grep -q "^v${NODE_MAJOR}\." || die "Node.js ${NODE_MAJOR} expected, got $(node --version)"
  corepack enable
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
}

# ---- postgres: PostgreSQL 16 with the Velexis tuning ----------------------------------------------------
step_postgres() {
  log "PostgreSQL ${PG_MAJOR}"
  apt_install "postgresql-${PG_MAJOR}" "postgresql-client-${PG_MAJOR}"
  install -m 0644 -o postgres -g postgres "$DEPLOY_DIR/postgres/velexis.conf" "/etc/postgresql/${PG_MAJOR}/main/conf.d/velexis.conf"
  systemctl enable postgresql
  systemctl restart postgresql
  runuser -u postgres -- psql -tAc 'SELECT version()' | grep -q "PostgreSQL ${PG_MAJOR}\." || die "PostgreSQL ${PG_MAJOR} is not running"
}

# ---- redis: Redis 7.4, password, noeviction, AOF ------------------------------------------------------------
step_redis() {
  log "Redis 7.4"
  apt_install redis-server redis-tools
  load_or_create_secrets
  sed "s/@@REDIS_PASSWORD@@/${REDIS_PASSWORD}/" "$DEPLOY_DIR/redis/velexis.conf" > /etc/redis/velexis.conf
  chown redis:redis /etc/redis/velexis.conf
  chmod 0640 /etc/redis/velexis.conf
  grep -q '^include /etc/redis/velexis.conf' /etc/redis/redis.conf || echo 'include /etc/redis/velexis.conf' >> /etc/redis/redis.conf
  systemctl enable redis-server
  systemctl restart redis-server
  REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h 127.0.0.1 ping | grep -q PONG || die "Redis does not answer"
}

# ---- caddy: Caddy 2.8 -------------------------------------------------------------------------------------
step_caddy() {
  log "Caddy 2.8"
  apt_install caddy
  caddy version | grep -q '^v2\.8\.' || warn "Caddy 2.8 expected, got $(caddy version)"
}

# ---- keys: one key folder per backend zone (ADR-0010, ADR-0026) ----------------------------------------------
# Never overwrites a key file. Each file is 0400 and owned by its zone's user; the folders are 0500.
new_key_file() { # path owner command... -> writes the command's output to path, unless path exists
  local path="$1" owner="$2" tmp
  shift 2
  [ -e "$path" ] && return 0
  tmp="$(dirname "$path")/.$(basename "$path").new"
  rm -f "$tmp"
  ( umask 077; "$@" > "$tmp" ) || { rm -f "$tmp"; die "could not generate $path"; }
  [ -s "$tmp" ] || { rm -f "$tmp"; die "could not generate $path"; }
  chown "$owner:$owner" "$tmp"
  chmod 0400 "$tmp"
  ln "$tmp" "$path" 2>/dev/null || true   # a hard link never replaces an existing file
  rm -f "$tmp"
  [ -e "$path" ] || die "could not install $path"
}

copy_key_file() { # source destination owner -> installs a copy of source, unless destination exists
  local tmp
  [ -e "$2" ] && return 0
  tmp="$(dirname "$2")/.$(basename "$2").new"
  install -m 0400 -o "$3" -g "$3" "$1" "$tmp"
  ln "$tmp" "$2" 2>/dev/null || true
  rm -f "$tmp"
  [ -e "$2" ] || die "could not install $2"
}

# Fixes owner and mode only where they differ, so that a re-run leaves every correct file untouched (even its ctime).
ensure_owner_mode() { # user:group octal-mode file...
  local want="$1" mode="$2" f
  shift 2
  for f in "$@"; do
    [ "$(stat -c '%U:%G %a' "$f")" = "$want $mode" ] && continue
    chown "$want" "$f"
    chmod "$mode" "$f"
  done
}

random_key() { head -c 32 /dev/urandom | base64; }
ed25519_key() { openssl genpkey -algorithm ed25519; }

step_keys() {
  log "Key files in $ETC/keys/platform and $ETC/keys/ota (existing files are kept)"
  local k="$ETC/keys" name p o
  install -d -m 0711 -o root -g root "$ETC" "$k"
  install -d -m 0500 -o "$PLATFORM_USER" -g "$PLATFORM_USER" "$k/platform"
  install -d -m 0500 -o "$OTA_USER" -g "$OTA_USER" "$k/ota"
  if [ -e "$k/master-v1.key" ]; then
    die "$k/master-v1.key belongs to the shared-user layout that ADR-0026 replaced; move it into both zone folders by hand"
  fi

  # Keys both backends need: generated once, then an identical copy in each zone's folder.
  for name in master-v1.key api-key-pepper; do
    p="$k/platform/$name"
    o="$k/ota/$name"
    if [ ! -e "$p" ] && [ ! -e "$o" ]; then new_key_file "$p" "$PLATFORM_USER" random_key; fi
    if [ -e "$p" ]; then copy_key_file "$p" "$o" "$OTA_USER"; else copy_key_file "$o" "$p" "$PLATFORM_USER"; fi
    cmp -s "$p" "$o" || die "$name differs between $k/platform and $k/ota; the copies must be identical (ADR-0026)"
  done
  # Keys of one zone only.
  new_key_file "$k/platform/platform-jwt-ed25519.pem" "$PLATFORM_USER" ed25519_key
  new_key_file "$k/ota/ota-jwt-ed25519.pem" "$OTA_USER" ed25519_key
  new_key_file "$k/ota/document-url.key" "$OTA_USER" random_key

  ensure_owner_mode "$PLATFORM_USER:$PLATFORM_USER" 400 "$k/platform"/*
  ensure_owner_mode "$OTA_USER:$OTA_USER" 400 "$k/ota"/*
}

load_or_create_secrets() {
  # Each generated value is created once and kept; values added in later versions of this script are appended.
  local name
  [ -d "$ETC" ] || install -d -m 0711 -o root -g root "$ETC"
  umask 077
  [ -e "$SECRETS_FILE" ] || : > "$SECRETS_FILE"
  for name in MIGRATOR_DB_PASSWORD PROVISIONER_DB_PASSWORD PLATFORM_DB_PASSWORD OTA_DB_PASSWORD REDIS_PASSWORD EDGE_SECRET; do
    grep -q "^${name}=" "$SECRETS_FILE" || echo "${name}=$(gen_secret)" >> "$SECRETS_FILE"
  done
  grep -q '^OTA_ADMIN_SERVICE_KEY=' "$SECRETS_FILE" || echo "OTA_ADMIN_SERVICE_KEY=sk_svc_$(gen_secret)" >> "$SECRETS_FILE"
  umask 022
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
}

# ---- database: database, roles, schemas, default privileges (deploy/postgres/bootstrap.sql) -------------------
step_database() {
  log "Database ${DB_NAME} and roles"
  load_or_create_secrets
  # Passwords go through stdin, never on a command line (visible in ps).
  {
    printf '\\set migrator_password %s\n' "$MIGRATOR_DB_PASSWORD"
    printf '\\set provisioner_password %s\n' "$PROVISIONER_DB_PASSWORD"
    printf '\\set platform_password %s\n' "$PLATFORM_DB_PASSWORD"
    printf '\\set ota_password %s\n' "$OTA_DB_PASSWORD"
    cat "$DEPLOY_DIR/postgres/bootstrap.sql"
  } | runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v db_name="$DB_NAME" -f - >/dev/null
}

# ---- envfiles: /etc/velexis/<app>.env from deploy/env templates (never overwritten) ------------------------
# Every env file is root:root 0600: systemd reads it as root before it starts a unit as the zone's user, so no app
# user can open any of them (ADR-0026). migrator.env and reference-loader.env are read the same way for the transient
# units of velexis-deploy, each with exactly one DSN.
step_envfiles() {
  log "Environment files in $ETC (existing files are kept)"
  load_or_create_secrets
  local tpl name dest missing
  for tpl in "$DEPLOY_DIR"/env/*.env.example; do
    name="$(basename "$tpl" .example)"
    dest="$ETC/$name"
    if [ -f "$dest" ]; then
      # Never overwritten, but drift is reported: a later release may need variables the file does not have yet.
      # (A template with only comments, such as platform-worker.env.example, names no variable.)
      missing="$({ grep -oE '^[A-Z][A-Z0-9_]*=' "$tpl" || true; } | tr -d '=' |
        while read -r key; do grep -qE "^${key}=" "$dest" || printf '%s ' "$key"; done)"
      [ -z "$missing" ] || warn "$dest lacks variables of its template: ${missing}(add them; velexis-deploy refuses a release until they exist)"
      continue
    fi
    # Paths move with VELEXIS_ROOT (tests); on the VM the two path expressions change nothing.
    ( umask 077; sed -e "s/@@MIGRATOR_DB_PASSWORD@@/${MIGRATOR_DB_PASSWORD}/g" \
        -e "s/@@PROVISIONER_DB_PASSWORD@@/${PROVISIONER_DB_PASSWORD}/g" \
        -e "s/@@PLATFORM_DB_PASSWORD@@/${PLATFORM_DB_PASSWORD}/g" \
        -e "s/@@OTA_DB_PASSWORD@@/${OTA_DB_PASSWORD}/g" \
        -e "s/@@REDIS_PASSWORD@@/${REDIS_PASSWORD}/g" \
        -e "s/@@EDGE_SECRET@@/${EDGE_SECRET}/g" \
        -e "s/@@OTA_ADMIN_SERVICE_KEY@@/${OTA_ADMIN_SERVICE_KEY}/g" \
        -e "s#/etc/velexis/#${ETC}/#g" -e "s#/var/lib/velexis/#${LIB}/#g" "$tpl" > "$dest" )
  done
  ensure_owner_mode root:root 600 "$ETC"/*.env "$SECRETS_FILE"
  if grep -l 'CHANGE_ME' "$ETC"/*.env >/dev/null 2>&1; then
    warn "fill in the CHANGE_ME values: $(grep -l 'CHANGE_ME' "$ETC"/*.env | tr '\n' ' ')"
  fi
}

# ---- scripts: root-owned scripts, systemd units, timers ---------------------------------------------------
step_scripts() {
  log "Root-owned scripts and systemd units"
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/deploy.sh" /usr/local/sbin/velexis-deploy
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/backup.sh" /usr/local/sbin/velexis-backup
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/restore.sh" /usr/local/sbin/velexis-restore
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/alert.sh" /usr/local/sbin/velexis-alert
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/run-as.sh" /usr/local/sbin/velexis-run
  install -m 0644 -o root -g root "$DEPLOY_DIR"/systemd/*.service "$DEPLOY_DIR"/systemd/*.timer /etc/systemd/system/
  install -d -m 0755 /etc/systemd/system/caddy.service.d
  install -m 0644 "$DEPLOY_DIR/systemd/caddy.service.d/velexis.conf" /etc/systemd/system/caddy.service.d/velexis.conf
  systemctl daemon-reload
  # App units are enabled by velexis-deploy when a release contains the app. Backups start now.
  systemctl enable --now velexis-backup.timer
}

# ---- caddyconf: Caddyfile, validated with the real environment ----------------------------------------------
step_caddyconf() {
  log "Caddyfile"
  install -d -m 0755 /srv/velexis/maintenance
  install -m 0644 "$DEPLOY_DIR/caddy/maintenance/index.html" /srv/velexis/maintenance/index.html
  install -m 0644 "$DEPLOY_DIR/caddy/Caddyfile" /etc/caddy/Caddyfile.new
  (
    set -a
    # shellcheck disable=SC1091
    . /etc/velexis/caddy.env
    set +a
    caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/dev/null
  )
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  systemctl enable caddy
  systemctl restart caddy
}

step_summary() {
  cat <<EOF

================================================================================================
Velexis VM provisioned. Next steps (docs/mvp/deployment-single-vm.md §3):
  1. Fill the CHANGE_ME values in /etc/velexis/*.env (SMTP, Stripe when needed, real host names).
  2. Put the age PUBLIC keys in /etc/velexis/backup/data-recipients.txt and config-recipients.txt,
     and the rclone remote in /etc/velexis/backup/rclone.conf. Then: systemctl start velexis-backup
  3. Back up /etc/velexis NOW (master key!) to the offline password manager, encrypted.
  4. Create the DNS records (A/AAAA) for every host of decisions.md §4 and *.ota.example.com.
  5. Run the "Deploy" workflow in GitHub Actions (workflow_dispatch) for the first release.
================================================================================================
EOF
}

for step in $STEPS; do
  case " $ALL_STEPS " in *" $step "*) ;; *) die "unknown step: $step" ;; esac
  "step_${step}"
done
