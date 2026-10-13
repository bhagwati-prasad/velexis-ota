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
#   verify checksums -> check that /etc/velexis/*.env have every variable of the release's env templates ->
#   snapshot the units, Caddyfile and maintenance page root-owned under /var/lib/velexis/system/<sha>/ ->
#   install root-owned scripts and, from the snapshot, units and Caddyfile -> move to releases/<sha> (root:velexis,
#   read-only) -> migrations (platform, reference, tenant fan-out; expand-phase files) -> reference data, both as
#   transient units with a dynamic user (run_transient) ->
#   switch the `current` symlink -> restart workers, APIs, front ends one at a time with health checks ->
#   reload Caddy -> prune old releases. Any failed health check rolls back: the previous release's snapshot
#   (units, Caddyfile) is re-installed, then `current` is switched back and the units restart.
# =====================================================================================================
set -euo pipefail
umask 022

BASE=/srv/velexis
INCOMING="$BASE/incoming"
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
RELEASE_GROUP=velexis                             # group of the five app users (ADR-0026): reading releases only
HISTORY=/var/lib/velexis/deploy-history          # "<utc-time> <sha>" per successful activation
MIGRATE_STATE=/var/lib/velexis-migrate           # StateDirectory= of the transient migration unit (fan-out report)
SYSTEM_SNAPSHOTS=/var/lib/velexis/system          # root-owned copies of each release's units and Caddyfile
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

env_value() { # file key -> the value of the last KEY= line, read without sourcing the file (it holds secrets)
  { sed -n "s/^$2=//p" "$1" 2>/dev/null || true; } | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# One-off release processes (migrations, reference data) run as a transient unit with a dynamic user whose only
# extra right is the velexis group (reading the release). systemd reads the root-only env file, so its DSN never
# reaches a process of an app user, the environment of this script or a command line (ADR-0026). Output goes to
# this script's stdout and stderr; the return code is the command's. deploy/systemd/test/units-smoke.sh runs this
# function as it is, so it uses nothing but its arguments, RELEASE_GROUP and MIGRATE_STATE.
run_transient() { # env-file working-dir command...
  local env_file="$1" dir="$2"
  shift 2
  systemd-run --quiet --pipe --wait --collect \
    --description="velexis-deploy one-off ($(basename "$env_file"))" \
    -p DynamicUser=yes -p SupplementaryGroups="$RELEASE_GROUP" \
    -p EnvironmentFile="$env_file" -p Environment=NODE_ENV=production \
    -p WorkingDirectory="$dir" -p StateDirectory="${MIGRATE_STATE#/var/lib/}" \
    -p ProtectProc=invisible -p PrivateDevices=yes -p CapabilityBoundingSet= -p LimitCORE=0 -p UMask=0077 \
    -- "$@"
}

keep_migrate_report() { # the fan-out report, from the transient unit's state folder to root-only copies
  local f="$MIGRATE_STATE/migrate-$SHA.json"
  # The dynamic user owns that folder: a link there would make root copy a file that the migration cannot read.
  if [ -L "$f" ]; then rm -f "$f"; log "ignored $f: a symbolic link, not a report"; return 0; fi
  [ -f "$f" ] || return 0
  install -m 0600 -o root -g root "$f" "/var/lib/velexis/migrate-$SHA.json"
  install -m 0600 -o root -g root "$f" "$LOG_DIR/migrate-$SHA.json"
  rm -f "$f"
}

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
    # A masked unit (for example the workers during a restore drill on a scratch VM) is never started.
    if [ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" = "masked" ]; then log "skip $unit (masked)"; continue; fi
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

check_env_files() { # dir with the release's env/*.env.example: every template variable must exist on the VM
  local tpl dest keys key missing=""
  for tpl in "$1"/*.env.example; do
    [ -f "$tpl" ] || continue
    keys="$(grep -oE '^[A-Z][A-Z0-9_]*=' "$tpl" | tr -d '=' || true)"
    [ -n "$keys" ] || continue                     # templates with only comments describe optional files
    dest="/etc/velexis/$(basename "$tpl" .example)"
    if [ ! -f "$dest" ]; then missing="$missing $(basename "$dest")"; continue; fi
    for key in $keys; do
      grep -qE "^${key}=" "$dest" || missing="$missing $(basename "$dest"):$key"
    done
  done
  [ -z "$missing" ] || die "env files lack variables of this release's templates:$missing. Add them to /etc/velexis (empty is allowed), then deploy again. Nothing was changed."
}

snapshot_system_files() { # uploaded dir, sha: root-owned copy of everything root installs from a release
  local src="$1" dst="$SYSTEM_SNAPSHOTS/$2"
  rm -rf --one-file-system "$dst"
  install -d -m 0755 -o root -g root "$SYSTEM_SNAPSHOTS" "$dst" "$dst/maintenance"
  cp -R -P "$src/deploy/systemd" "$dst/systemd"
  cp -P "$src/deploy/caddy/Caddyfile" "$dst/Caddyfile"
  cp -P "$src/deploy/caddy/maintenance/index.html" "$dst/maintenance/index.html"
  chown -R root:root "$dst"
  chmod -R u=rwX,go=rX "$dst"
}

UNITS_CHANGED=0
CADDY_CHANGED=0
stage_system_files() { # root-owned snapshot dir (never a folder the deploy user or the app user can write)
  local src="$1" f
  UNITS_CHANGED=0
  CADDY_CHANGED=0
  rm -f /etc/caddy/Caddyfile.next
  # Validate a changed Caddyfile first, so that a bad one changes nothing at all.
  if ! cmp -s "$src/Caddyfile" /etc/caddy/Caddyfile; then
    install -m 0644 -o root -g root "$src/Caddyfile" /etc/caddy/Caddyfile.next
    ( load_env_file /etc/velexis/caddy.env || exit 1; caddy validate --config /etc/caddy/Caddyfile.next --adapter caddyfile >/dev/null ) \
      || { rm -f /etc/caddy/Caddyfile.next; die "Caddyfile from $src does not validate; nothing was activated"; }
    CADDY_CHANGED=1
  fi

  for f in "$src"/systemd/*.service "$src"/systemd/*.timer; do
    install_if_changed "$f" "/etc/systemd/system/$(basename "$f")" 0644 && UNITS_CHANGED=1
  done
  install -d -m 0755 /etc/systemd/system/caddy.service.d
  install_if_changed "$src/systemd/caddy.service.d/velexis.conf" /etc/systemd/system/caddy.service.d/velexis.conf 0644 && UNITS_CHANGED=1
  if [ "$UNITS_CHANGED" -eq 1 ]; then systemctl daemon-reload; log "systemd units updated from $src"; fi

  install -d -m 0755 "$BASE/maintenance"
  install -m 0644 -o root -g root "$src/maintenance/index.html" "$BASE/maintenance/index.html"
}

activate_caddyfile() { # after the units are healthy: the staged Caddyfile goes live
  if [ "$CADDY_CHANGED" -eq 1 ]; then
    mv /etc/caddy/Caddyfile.next /etc/caddy/Caddyfile
    systemctl reload caddy
    log "Caddyfile reloaded"
    CADDY_CHANGED=0
  fi
}

restore_running_system_files() { # failure before the switch: the running release keeps its own units
  local prev
  prev="$(basename "${PREV_REL:-none}")"
  if [ -d "$SYSTEM_SNAPSHOTS/$prev" ]; then stage_system_files "$SYSTEM_SNAPSHOTS/$prev"; fi
  rm -f /etc/caddy/Caddyfile.next
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
  # The target runs under its own units and Caddyfile (sandboxing, ExecStart, payment-page CSP), not the newer ones.
  # Root-owned scripts stay at the newest version: they are backward compatible by design (ADR-0023).
  if [ -d "$SYSTEM_SNAPSHOTS/$1" ]; then
    stage_system_files "$SYSTEM_SNAPSHOTS/$1"
  else
    log "no system-file snapshot for $1: the installed units and Caddyfile stay"
    UNITS_CHANGED=0; CADDY_CHANGED=0; rm -f /etc/caddy/Caddyfile.next
  fi
  switch_current "$rel"
  restart_units "$rel" || die "rollback release $1 is not healthy either; investigate now"
  activate_caddyfile
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

# ---- 1. verify the upload, install root-used files from it, then hand it over read-only ----------------
if [ ! -d "$REL" ]; then
  SRC="$INCOMING/$SHA"
  [ -d "$SRC" ] || die "nothing uploaded at $SRC"
  ( cd "$SRC" && sha256sum --quiet -c SHA256SUMS ) || die "checksum verification failed for $SRC"
  node -e 'const m=require(process.argv[1]); if(m.sha!==process.argv[2]) process.exit(1)' "$SRC/RELEASE.json" "$SHA" \
    || die "RELEASE.json does not match $SHA"
  BUILT_NODE="$(node -p 'require(process.argv[1]).node.split(".")[0]' "$SRC/RELEASE.json")"
  [ "$BUILT_NODE" = "$(node -p 'process.version.split(".")[0]')" ] || die "release built with Node $BUILT_NODE, VM runs $(node --version)"
  check_env_files "$SRC/deploy/env"

  # Everything root will use (scripts, units, Caddyfile, maintenance page) is taken from the uploaded copy
  # BEFORE the folder is handed over, so neither the deploy user nor an app process can change it (ADR-0023).
  # Units and Caddyfile go through a root-owned snapshot that a later rollback re-installs.
  snapshot_system_files "$SRC" "$SHA"
  install_if_changed "$SRC/deploy/scripts/deploy.sh" /usr/local/sbin/velexis-deploy 0755 && log "velexis-deploy updated (used from the next deploy)"
  install_if_changed "$SRC/deploy/scripts/backup.sh" /usr/local/sbin/velexis-backup 0755 || true
  install_if_changed "$SRC/deploy/scripts/restore.sh" /usr/local/sbin/velexis-restore 0755 || true
  install_if_changed "$SRC/deploy/scripts/alert.sh" /usr/local/sbin/velexis-alert 0755 || true
  if [ -f "$SRC/deploy/scripts/run-as.sh" ]; then
    install_if_changed "$SRC/deploy/scripts/run-as.sh" /usr/local/sbin/velexis-run 0755 || true
  fi
  stage_system_files "$SYSTEM_SNAPSHOTS/$SHA"

  mv -T "$SRC" "$REL"
  # root:velexis and read-only: every app user reads it through the velexis group, none can change it (ADR-0026).
  chown -R "root:$RELEASE_GROUP" "$REL"
  chmod -R u=rX,g=rX,o= "$REL"
  chmod o+x "$REL"
  if [ -d "$REL/storefront" ]; then chmod -R o+rX "$REL/storefront"; fi   # Caddy (user caddy) serves these files
else
  check_env_files "$REL/deploy/env"
  if [ -d "$SYSTEM_SNAPSHOTS/$SHA" ]; then
    log "release $SHA is already on the VM: units and Caddyfile from its snapshot, root scripts stay as installed"
    stage_system_files "$SYSTEM_SNAPSHOTS/$SHA"
  else
    log "release $SHA is already on the VM without a snapshot: scripts, units and Caddyfile stay as installed"
  fi
fi

# ---- 2. migrations (DDL as velexis_migrator) ---------------------------------------------------------------
# The DSN is only in the root-only migrator.env, which systemd reads for each transient unit (run_transient).
# Note: errexit is off inside a subshell followed by `||`, so every step ends with `|| exit 1`.
if [ -f "$REL/db/dist/cli/migrate.js" ]; then
  CONCURRENCY="$(env_value /etc/velexis/migrator.env MIGRATE_TENANT_CONCURRENCY)"
  FAILURE_RATIO="$(env_value /etc/velexis/migrator.env MIGRATE_TENANT_MAX_FAILURE_RATIO)"
  CONCURRENCY="${CONCURRENCY:-4}"
  FAILURE_RATIO="${FAILURE_RATIO:-0.1}"
  [[ "$CONCURRENCY" =~ ^[1-9][0-9]*$ ]] || die "MIGRATE_TENANT_CONCURRENCY in migrator.env is not a positive integer"
  [[ "$FAILURE_RATIO" =~ ^(0(\.[0-9]+)?|1(\.0+)?)$ ]] \
    || die "MIGRATE_TENANT_MAX_FAILURE_RATIO in migrator.env is not a number from 0 to 1"
  rm -f "$MIGRATE_STATE/migrate-$SHA.json"
  (
    for set in platform reference; do
      if [ -d "$REL/migrations/$set" ]; then
        log "migrate $set"
        run_transient /etc/velexis/migrator.env "$REL/db" node dist/cli/migrate.js "$set" --dir "$REL/migrations/$set" \
          || exit 1
      fi
    done
    if [ -d "$REL/migrations/tenant" ]; then
      log "migrate tenants (fan-out, concurrency $CONCURRENCY)"
      run_transient /etc/velexis/migrator.env "$REL/db" \
        node dist/cli/migrate.js tenants --dir "$REL/migrations/tenant" \
        --concurrency "$CONCURRENCY" --max-failure-ratio "$FAILURE_RATIO" \
        --report "$MIGRATE_STATE/migrate-$SHA.json" || exit 1
    fi
  ) || {
    keep_migrate_report
    restore_running_system_files
    die "migrations failed; the previous release keeps running (expand-only migrations are N-1 compatible)"
  }
  keep_migrate_report
fi

# ---- 3. reference data (only when the vendored datasets changed) -------------------------------------------
# Same transient unit, with reference-loader.env: the platform role's DSN only, never the migrator's.
if [ -f "$REL/reference-data/dist/cli/load.js" ]; then
  NEW_SUM="$(cd "$REL/reference-data" && find data -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
  if [ "$NEW_SUM" != "$(cat /var/lib/velexis/reference-data.sha256 2>/dev/null || true)" ]; then
    log "load reference data"
    run_transient /etc/velexis/reference-loader.env "$REL/reference-data" node dist/cli/load.js --data data \
      || { restore_running_system_files; die "reference data load failed"; }
    echo "$NEW_SUM" > /var/lib/velexis/reference-data.sha256
  fi
fi

# ---- 4. switch and restart with health checks --------------------------------------------------------------
switch_current "$REL"
if ! restart_units "$REL"; then
  if [ -n "$PREV_REL" ] && [ "$PREV_REL" != "$REL" ]; then
    rollback_to "$(basename "$PREV_REL")"
  fi
  die "deploy of $SHA failed health checks; rolled back"
fi

activate_caddyfile

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $SHA" >> "$HISTORY"

# ---- 5. prune: keep the last $KEEP_RELEASES releases and never the active one ------------------------------
ACTIVE="$(readlink -f "$CURRENT")"
find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk -v keep="$KEEP_RELEASES" 'NR > keep { print $2 }' |
  while read -r old; do
    [ "$old" = "$ACTIVE" ] && continue
    log "prune $old"
    rm -rf --one-file-system "$old" "${SYSTEM_SNAPSHOTS:?}/$(basename "$old")"
  done
find "$INCOMING" -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf --one-file-system {} +

log "deploy $SHA done"
