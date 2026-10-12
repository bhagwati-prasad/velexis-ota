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
# =====================================================================================================
set -euo pipefail

# ---- Placeholders: override through the environment ---------------------------------------------------
: "${ADMIN_USER:=ubuntu}"                 # existing sudo user of the cloud image; keeps SSH access
: "${DEPLOY_USER:=deploy}"                # GitHub Actions uploads releases and runs velexis-deploy as this user
: "${APP_USER:=velexis}"                  # every app runs as this system user (ADR-0007)
: "${DEPLOY_SSH_PUBKEY_FILE:=}"           # public half of the GitHub Actions deploy key (required on first run)
: "${SSH_ALLOW_FROM:=any}"                # CIDR for SSH; "any" because GitHub-hosted runners have changing IPs
: "${DB_NAME:=velexis}"
: "${NODE_MAJOR:=22}"
: "${PNPM_VERSION:=9.15.9}"
: "${PG_MAJOR:=16}"
: "${REDIS_PIN:=6:7.4*}"                  # packages.redis.io version string of Redis 7.4
: "${CADDY_PIN:=2.8*}"

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE=/etc/velexis/.provision-secrets   # generated passwords, root 0600, reused on every run
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
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"
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

# ---- users and directories (ADR-0007 table) -------------------------------------------------------------
step_users() {
  log "Users and directories"
  id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/velexis --shell /usr/sbin/nologin "$APP_USER"
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
  echo "${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/local/sbin/velexis-deploy" > /etc/sudoers.d/velexis-deploy
  chmod 0440 /etc/sudoers.d/velexis-deploy
  visudo -cf /etc/sudoers.d/velexis-deploy >/dev/null

  install -d -m 0755 -o root -g root /srv/velexis
  install -d -m 0751 -o "$APP_USER" -g "$APP_USER" /srv/velexis/releases
  install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /srv/velexis/incoming
  install -d -m 0750 -o root -g "$APP_USER" /etc/velexis
  install -d -m 0500 -o "$APP_USER" -g "$APP_USER" /etc/velexis/keys
  install -d -m 0700 -o root -g root /etc/velexis/backup
  install -d -m 0750 -o "$APP_USER" -g "$APP_USER" /var/lib/velexis
  install -d -m 0700 -o "$APP_USER" -g "$APP_USER" /var/lib/velexis/storage
  install -d -m 0700 -o root -g root /var/backups/velexis
  install -d -m 0750 -o root -g adm /var/log/velexis
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

# ---- keys: master key and other key files (ADR-0010) --------------------------------------------------------
step_keys() {
  log "Key files in /etc/velexis/keys (existing files are kept)"
  local k=/etc/velexis/keys
  umask 077
  [ -f "$k/master-v1.key" ] || head -c 32 /dev/urandom | base64 > "$k/master-v1.key"
  [ -f "$k/api-key-pepper" ] || head -c 32 /dev/urandom | base64 > "$k/api-key-pepper"
  [ -f "$k/document-url.key" ] || head -c 32 /dev/urandom | base64 > "$k/document-url.key"
  [ -f "$k/platform-jwt-ed25519.pem" ] || openssl genpkey -algorithm ed25519 -out "$k/platform-jwt-ed25519.pem"
  [ -f "$k/ota-jwt-ed25519.pem" ] || openssl genpkey -algorithm ed25519 -out "$k/ota-jwt-ed25519.pem"
  chown "$APP_USER:$APP_USER" "$k"/*
  chmod 0400 "$k"/*
  umask 022
}

load_or_create_secrets() {
  if [ ! -f "$SECRETS_FILE" ]; then
    umask 077
    {
      echo "MIGRATOR_DB_PASSWORD=$(gen_secret)"
      echo "PLATFORM_DB_PASSWORD=$(gen_secret)"
      echo "OTA_DB_PASSWORD=$(gen_secret)"
      echo "REDIS_PASSWORD=$(gen_secret)"
      echo "EDGE_SECRET=$(gen_secret)"
      echo "OTA_ADMIN_SERVICE_KEY=sk_svc_$(gen_secret)"
    } > "$SECRETS_FILE"
    umask 022
  fi
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
    printf '\\set platform_password %s\n' "$PLATFORM_DB_PASSWORD"
    printf '\\set ota_password %s\n' "$OTA_DB_PASSWORD"
    cat "$DEPLOY_DIR/postgres/bootstrap.sql"
  } | runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -v db_name="$DB_NAME" -f - >/dev/null
}

# ---- envfiles: /etc/velexis/<app>.env from deploy/env templates (never overwritten) ------------------------
step_envfiles() {
  log "Environment files in /etc/velexis (existing files are kept)"
  load_or_create_secrets
  local tpl name dest owner mode
  for tpl in "$DEPLOY_DIR"/env/*.env.example; do
    name="$(basename "$tpl" .example)"
    dest="/etc/velexis/$name"
    case "$name" in
      migrator.env|backup.env|alert.env) owner=root:root; mode=0600 ;;
      caddy.env) owner=root:caddy; mode=0640 ;;
      *) owner="root:$APP_USER"; mode=0640 ;;
    esac
    if [ -f "$dest" ]; then continue; fi
    sed -e "s/@@MIGRATOR_DB_PASSWORD@@/${MIGRATOR_DB_PASSWORD}/g" \
        -e "s/@@PLATFORM_DB_PASSWORD@@/${PLATFORM_DB_PASSWORD}/g" \
        -e "s/@@OTA_DB_PASSWORD@@/${OTA_DB_PASSWORD}/g" \
        -e "s/@@REDIS_PASSWORD@@/${REDIS_PASSWORD}/g" \
        -e "s/@@EDGE_SECRET@@/${EDGE_SECRET}/g" \
        -e "s/@@OTA_ADMIN_SERVICE_KEY@@/${OTA_ADMIN_SERVICE_KEY}/g" "$tpl" > "$dest"
    chown "$owner" "$dest"
    chmod "$mode" "$dest"
  done
  if grep -l 'CHANGE_ME' /etc/velexis/*.env >/dev/null 2>&1; then
    warn "fill in the CHANGE_ME values: $(grep -l 'CHANGE_ME' /etc/velexis/*.env | tr '\n' ' ')"
  fi
}

# ---- scripts: root-owned scripts, systemd units, timers ---------------------------------------------------
step_scripts() {
  log "Root-owned scripts and systemd units"
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/deploy.sh" /usr/local/sbin/velexis-deploy
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/backup.sh" /usr/local/sbin/velexis-backup
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/restore.sh" /usr/local/sbin/velexis-restore
  install -m 0755 -o root -g root "$DEPLOY_DIR/scripts/alert.sh" /usr/local/sbin/velexis-alert
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
