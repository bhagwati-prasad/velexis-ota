#!/usr/bin/env bash
# =====================================================================================================
# deploy.sh — activate one release on the Velexis VM (ADR-0007). Installed root-owned as
# /usr/local/sbin/velexis-deploy by provision-vm.sh, and re-installed from every deployed release.
#
# TEMPLATE: finalised and tested by task X-023 (docs/mvp/plans/foundation-tasks.md).
# The deploy user may run only this command with sudo:
#   sudo /usr/local/sbin/velexis-deploy <git-sha>     activate /srv/velexis/incoming/<sha> (uploaded by deploy.yml)
#   sudo /usr/local/sbin/velexis-deploy --rollback    switch back to the previous release
#   sudo /usr/local/sbin/velexis-deploy --status      show the active release and the units
#
# Order (docs/mvp/deployment-single-vm.md §8):
#   verify checksums -> move to releases/<sha> -> install root-owned scripts, units, Caddyfile ->
#   migrations (platform, reference, tenant fan-out; expand-phase files) -> reference data ->
#   switch the `current` symlink -> restart workers, APIs, front ends one at a time with health checks ->
#   reload Caddy -> prune old releases. Any failed health check switches `current` back (rollback).
# =====================================================================================================
set -euo pipefail
umask 022

BASE=/srv/velexis
INCOMING="$BASE/incoming"
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
APP_USER=velexis
HISTORY=/var/lib/velexis/deploy-history          # "<utc-time> <sha>" per successful activation
LOG_DIR=/var/log/velexis
KEEP_RELEASES=5
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"            # seconds per unit

# unit | release folder | health port. Restart order: workers, then APIs, then front ends (ADR-0009:
# new consumers run before new producers).
UNITS=(
  "velexis-platform-worker platform-backend 3101"
  "velexis-ota-worker ota-backend 4001"
  "velexis-platform-api platform-backend 3100"
  "velexis-ota-api ota-backend 4000"
  "velexis-portal platform-frontend 3000"
  "velexis-platform-admin platform-admin 3001"
  "velexis-ota-admin ota-admin 3002"
)

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_DIR/deploy.log"; }
die() { log "ERROR: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo /usr/local/sbin/velexis-deploy)"
mkdir -p "$LOG_DIR" /var/lib/velexis
exec 9>/run/velexis-deploy.lock
flock -n 9 || die "another deploy is running"

# ---- helpers ----------------------------------------------------------------------------------------------
load_env_file() { # export KEY=VALUE lines of a root-only env file into this process
  set -a
  # shellcheck disable=SC1090
  . "$1"
  set +a
}

as_app() { runuser -u "$APP_USER" -- "$@"; }   # keeps the exported environment

wait_healthy() { # port
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  until curl -fsS --max-time 3 "http://127.0.0.1:$1/health/ready" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 2
  done
}

switch_current() { # release dir
  ln -sfn "$1" "$CURRENT.new"
  mv -T "$CURRENT.new" "$CURRENT"
}

install_if_changed() { # src dest mode -> returns 0 when the file changed
  if [ -f "$2" ] && cmp -s "$1" "$2"; then return 1; fi
  install -m "$3" -o root -g root "$1" "$2"
}

restart_units() { # release dir; returns 1 on the first unhealthy unit
  local rel="$1" entry unit dir port
  for entry in "${UNITS[@]}"; do
    read -r unit dir port <<<"$entry"
    [ -d "$rel/$dir" ] || continue
    systemctl enable "$unit" >/dev/null 2>&1
    log "restart $unit"
    systemctl restart "$unit"
    if ! wait_healthy "$port"; then
      log "$unit is not healthy on 127.0.0.1:$port after ${HEALTH_TIMEOUT}s"
      journalctl -u "$unit" -n 30 --no-pager | tee -a "$LOG_DIR/deploy.log" >/dev/null
      return 1
    fi
  done
}

previous_sha() { # last activated sha different from the current one
  local cur
  cur="$(basename "$(readlink -f "$CURRENT" 2>/dev/null || echo none)")"
  [ -f "$HISTORY" ] || return 0
  awk -v cur="$cur" '$2 != cur { sha = $2 } END { if (sha) print sha }' "$HISTORY"
}

rollback_to() { # sha
  local rel="$RELEASES/$1"
  [ -d "$rel" ] || die "release $1 is not on this VM"
  log "ROLLBACK to $1"
  switch_current "$rel"
  restart_units "$rel" || die "rollback release $1 is not healthy either; investigate now"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1 rollback" >> "$HISTORY"
}

# ---- commands ----------------------------------------------------------------------------------------------
case "${1:-}" in
  --status)
    echo "current: $(readlink -f "$CURRENT" 2>/dev/null || echo none)"
    for entry in "${UNITS[@]}"; do read -r unit _ _ <<<"$entry"; printf '%-28s %s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || true)"; done
    exit 0 ;;
  --rollback)
    prev="$(previous_sha)"
    [ -n "$prev" ] || die "no previous release recorded in $HISTORY"
    rollback_to "$prev"
    exit 0 ;;
  "" | -*) die "usage: velexis-deploy <git-sha> | --rollback | --status" ;;
esac

SHA="$1"
[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || die "invalid release id: $SHA"
REL="$RELEASES/$SHA"
PREV_REL="$(readlink -f "$CURRENT" 2>/dev/null || true)"
log "deploy $SHA (previous: ${PREV_REL:-none})"

# ---- 1. verify and move the uploaded release -------------------------------------------------------------
if [ ! -d "$REL" ]; then
  SRC="$INCOMING/$SHA"
  [ -d "$SRC" ] || die "nothing uploaded at $SRC"
  ( cd "$SRC" && sha256sum --quiet -c SHA256SUMS ) || die "checksum verification failed for $SRC"
  node -e 'const m=require(process.argv[1]); if(m.sha!==process.argv[2]) process.exit(1)' "$SRC/RELEASE.json" "$SHA" \
    || die "RELEASE.json does not match $SHA"
  BUILT_NODE="$(node -p 'require(process.argv[1]).node.split(".")[0]' "$SRC/RELEASE.json")"
  [ "$BUILT_NODE" = "$(node -p 'process.version.split(".")[0]')" ] || die "release built with Node $BUILT_NODE, VM runs $(node --version)"

  # Root-owned copies of the scripts are installed BEFORE the release is handed to the app user.
  install_if_changed "$SRC/deploy/scripts/deploy.sh" /usr/local/sbin/velexis-deploy 0755 && log "velexis-deploy updated (used from the next deploy)"
  install_if_changed "$SRC/deploy/scripts/backup.sh" /usr/local/sbin/velexis-backup 0755 || true
  install_if_changed "$SRC/deploy/scripts/restore.sh" /usr/local/sbin/velexis-restore 0755 || true
  install_if_changed "$SRC/deploy/scripts/alert.sh" /usr/local/sbin/velexis-alert 0755 || true

  mv -T "$SRC" "$REL"
  chown -R "$APP_USER:$APP_USER" "$REL"
  chmod -R u=rX,g=rX,o= "$REL"                    # read-only after deploy (ADR-0007)
  chmod o+x "$REL"
  if [ -d "$REL/storefront" ]; then chmod -R o+rX "$REL/storefront"; fi   # Caddy serves these files
fi

# ---- 2. systemd units, Caddyfile and the maintenance page --------------------------------------------------
UNITS_CHANGED=0
for f in "$REL"/deploy/systemd/*.service "$REL"/deploy/systemd/*.timer; do
  install_if_changed "$f" "/etc/systemd/system/$(basename "$f")" 0644 && UNITS_CHANGED=1
done
install -d -m 0755 /etc/systemd/system/caddy.service.d
install_if_changed "$REL/deploy/systemd/caddy.service.d/velexis.conf" /etc/systemd/system/caddy.service.d/velexis.conf 0644 && UNITS_CHANGED=1
if [ "$UNITS_CHANGED" -eq 1 ]; then systemctl daemon-reload; log "systemd units updated"; fi

install -d -m 0755 "$BASE/maintenance"
install -m 0644 "$REL/deploy/caddy/maintenance/index.html" "$BASE/maintenance/index.html"

CADDY_CHANGED=0
if ! cmp -s "$REL/deploy/caddy/Caddyfile" /etc/caddy/Caddyfile; then
  ( load_env_file /etc/velexis/caddy.env || exit 1; caddy validate --config "$REL/deploy/caddy/Caddyfile" --adapter caddyfile >/dev/null ) \
    || die "new Caddyfile does not validate; nothing changed"
  CADDY_CHANGED=1
fi

# ---- 3. migrations (DDL as velexis_migrator; credentials only in root-only migrator.env) ---------------------
# Note: errexit is off inside a subshell followed by `||`, so every step ends with `|| exit 1`.
if [ -f "$REL/db/dist/cli/migrate.js" ]; then
  (
    load_env_file /etc/velexis/migrator.env || exit 1
    export DATABASE_MIGRATOR_URL
    cd "$REL/db" || exit 1
    for set in platform reference; do
      if [ -d "$REL/migrations/$set" ]; then
        log "migrate $set"
        as_app node dist/cli/migrate.js "$set" --dir "$REL/migrations/$set" || exit 1
      fi
    done
    if [ -d "$REL/migrations/tenant" ]; then
      log "migrate tenants (fan-out, concurrency ${MIGRATE_TENANT_CONCURRENCY:-4})"
      as_app node dist/cli/migrate.js tenants --dir "$REL/migrations/tenant" \
        --concurrency "${MIGRATE_TENANT_CONCURRENCY:-4}" \
        --max-failure-ratio "${MIGRATE_TENANT_MAX_FAILURE_RATIO:-0.1}" \
        --report "/var/lib/velexis/migrate-$SHA.json" || exit 1
    fi
  ) || die "migrations failed; the previous release keeps running (expand-only migrations are N-1 compatible)"
  if [ -f "/var/lib/velexis/migrate-$SHA.json" ]; then cp "/var/lib/velexis/migrate-$SHA.json" "$LOG_DIR/"; fi
fi

# ---- 4. reference data (only when the vendored datasets changed) -------------------------------------------
if [ -f "$REL/reference-data/dist/cli/load.js" ]; then
  NEW_SUM="$(cd "$REL/reference-data" && find data -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
  if [ "$NEW_SUM" != "$(cat /var/lib/velexis/reference-data.sha256 2>/dev/null || true)" ]; then
    (
      load_env_file /etc/velexis/migrator.env || exit 1
      export DATABASE_URL="$REFERENCE_DATABASE_URL"
      cd "$REL/reference-data" || exit 1
      log "load reference data"
      as_app node dist/cli/load.js --data data || exit 1
    ) || die "reference data load failed"
    echo "$NEW_SUM" > /var/lib/velexis/reference-data.sha256
  fi
fi

# ---- 5. switch and restart with health checks --------------------------------------------------------------
switch_current "$REL"
if ! restart_units "$REL"; then
  if [ -n "$PREV_REL" ] && [ "$PREV_REL" != "$REL" ]; then
    rollback_to "$(basename "$PREV_REL")"
  fi
  die "deploy of $SHA failed health checks; rolled back"
fi

if [ "$CADDY_CHANGED" -eq 1 ]; then
  install -m 0644 "$REL/deploy/caddy/Caddyfile" /etc/caddy/Caddyfile
  systemctl reload caddy
  log "Caddyfile reloaded"
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $SHA" >> "$HISTORY"

# ---- 6. prune: keep the last $KEEP_RELEASES releases and never the active one ------------------------------
ACTIVE="$(readlink -f "$CURRENT")"
find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk -v keep="$KEEP_RELEASES" 'NR > keep { print $2 }' |
  while read -r old; do
    [ "$old" = "$ACTIVE" ] && continue
    log "prune $old"
    rm -rf --one-file-system "$old"
  done
find "$INCOMING" -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf --one-file-system {} +

log "deploy $SHA done"
