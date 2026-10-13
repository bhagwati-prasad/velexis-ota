#!/usr/bin/env bash
# =====================================================================================================
# deploy.sh — activate one release on the Velexis VM (ADR-0007, ADR-0023). Installed root-owned as
# /usr/local/sbin/velexis-deploy by provision-vm.sh, and re-installed from every deployed release.
#
# The deploy user may run only this command with sudo (finalised and tested by task X-023):
#   sudo /usr/local/sbin/velexis-deploy <git-sha>     activate /srv/velexis/incoming/<sha> (uploaded by deploy.yml)
#   sudo /usr/local/sbin/velexis-deploy --rollback    switch back to the previous release
#   sudo /usr/local/sbin/velexis-deploy --status      show the active release and the units
#
# Order (docs/mvp/deployment-single-vm.md §8):
#   verify the upload (SHA256SUMS lists exactly its files, all intact; RELEASE.json; Node major) -> check that
#   /etc/velexis/*.env have every variable of the release's env templates -> snapshot the units, Caddyfile and
#   maintenance page root-owned under /var/lib/velexis/system/<sha>/ -> from the snapshot, validate a changed
#   Caddyfile and install the units, then install the root-owned scripts -> move to releases/<sha> (root:velexis,
#   read-only) -> migrations (platform, reference, tenant fan-out; expand-phase files) -> reference data, both as
#   transient units with a dynamic user (run_transient) -> switch the `current` symlink -> restart workers, APIs,
#   front ends one at a time with health checks -> reload Caddy -> prune old releases (never the active one nor the
#   --rollback target). Any failed health check rolls back: the previous release's snapshot (units, Caddyfile) is
#   re-installed, then `current` is switched back and the units restart.
#
# Tests only (deploy/scripts/test/deploy.test.sh). With VELEXIS_ROOT=<absolute folder> every path of this script
# (/srv/velexis, /etc/velexis, /var/lib/velexis, /var/lib/velexis-migrate, /var/log/velexis, /usr/local/sbin,
# /etc/systemd/system, /etc/caddy and the lock in /run) moves under that folder, the script runs without root and
# hands files over to the calling user and group instead of root:root and root:velexis, and it takes three more
# overrides:
#   SYSTEMCTL      the systemctl to call (required with VELEXIS_ROOT; fake-systemctl.sh in the test)
#   RUN_TRANSIENT  a command that replaces the transient systemd-run unit of run_transient (required with
#                  VELEXIS_ROOT). It gets the env file (under VELEXIS_ROOT), the working folder and the command.
#   HEALTH_HOST    the address of the health checks (default 127.0.0.1)
# Without VELEXIS_ROOT (the VM) the three have no effect: systemctl, systemd-run and 127.0.0.1 are fixed. sudo's
# env_reset drops all four anyway, and the sudoers rule of the deploy user has no SETENV tag.
# HEALTH_TIMEOUT (seconds per unit, default 90) applies in both modes.
# =====================================================================================================
set -euo pipefail
umask 022

: "${VELEXIS_ROOT:=}"
R="$VELEXIS_ROOT"
if [ -n "$R" ]; then
  case "$R" in /?*) ;; *) echo "velexis-deploy: VELEXIS_ROOT must be an absolute path other than /" >&2; exit 2 ;; esac
  [ -d "$R" ] || { echo "velexis-deploy: VELEXIS_ROOT $R is not a folder" >&2; exit 2; }
  [ -n "${SYSTEMCTL:-}" ] || { echo "velexis-deploy: with VELEXIS_ROOT, SYSTEMCTL must name the stand-in for systemctl" >&2; exit 2; }
  [ -n "${RUN_TRANSIENT:-}" ] || { echo "velexis-deploy: with VELEXIS_ROOT, RUN_TRANSIENT must name the stand-in for systemd-run" >&2; exit 2; }
  HEALTH_HOST="${HEALTH_HOST:-127.0.0.1}"
  OWNER="$(id -un)"
  OWNER_GROUP="$(id -gn)"
  RELEASE_GROUP="$OWNER_GROUP"
else
  SYSTEMCTL=systemctl
  RUN_TRANSIENT=""
  HEALTH_HOST=127.0.0.1
  OWNER=root                                     # owner of everything root installs
  OWNER_GROUP=root
  RELEASE_GROUP=velexis                          # group of the five app users (ADR-0026): reading releases only
fi
[[ "$HEALTH_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "velexis-deploy: HEALTH_HOST is not a host name or IPv4 address" >&2; exit 2; }
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"            # seconds per unit
[[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "velexis-deploy: HEALTH_TIMEOUT must be 1 to 9999 seconds" >&2; exit 2; }

BASE="$R/srv/velexis"
INCOMING="$BASE/incoming"
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
ETC="$R/etc/velexis"
LIB="$R/var/lib/velexis"
HISTORY="$LIB/deploy-history"                     # "<utc-time> <sha>" per successful activation
SYSTEM_SNAPSHOTS="$LIB/system"                    # root-owned copies of each release's units and Caddyfile
MIGRATE_STATE="$R/var/lib/velexis-migrate"        # StateDirectory= of the transient migration unit (fan-out report)
LOG_DIR="$R/var/log/velexis"
SBIN="$R/usr/local/sbin"
SYSTEMD_DIR="$R/etc/systemd/system"
CADDY_DIR="$R/etc/caddy"
LOCK_FILE="$R/run/velexis-deploy.lock"
KEEP_RELEASES=5

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

if [ -z "$R" ]; then [ "$(id -u)" -eq 0 ] || die "run as root (sudo /usr/local/sbin/velexis-deploy)"; fi
mkdir -p "$LOG_DIR" "$LIB" "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || die "another deploy is running"

# ---- helpers ----------------------------------------------------------------------------------------------
env_value() { # file key -> the value of the last KEY= line, read without sourcing the file (it holds secrets)
  { sed -n "s/^$2=//p" "$1" 2>/dev/null || true; } | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

redact() { # text env-file -> the text with every value of the env file (6 characters or more) replaced
  local text="$1" line v
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in [A-Za-z_]*=*) ;; *) continue ;; esac
    v="${line#*=}"
    case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
    [ "${#v}" -lt 6 ] || text="${text//"$v"/"<redacted>"}"
  done <"$2"
  printf '%s' "$text"
}

# One-off release processes (migrations, reference data) run as a transient unit with a dynamic user whose only
# extra right is the velexis group (reading the release). systemd reads the root-only env file, so its DSN never
# reaches a process of an app user, the environment of this script or a command line (ADR-0026). Output goes to
# this script's stdout and stderr; the return code is the command's. deploy/systemd/test/units-smoke.sh runs this
# function as it is, so it uses nothing but its arguments, RELEASE_GROUP and MIGRATE_STATE. The call sites name the
# env file by its path on the VM, where systemd reads it; units-smoke.sh checks those call sites too.
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
if [ -n "$RUN_TRANSIENT" ]; then
  # Tests only (VELEXIS_ROOT): the stand-in replaces systemd-run and gets the env file where the test keeps it.
  run_transient() {
    local env_file="$R$1" dir="$2"
    shift 2
    "$RUN_TRANSIENT" "$env_file" "$dir" "$@"
  }
fi

keep_migrate_report() { # the fan-out report, from the transient unit's state folder to root-only copies
  local f="$MIGRATE_STATE/migrate-$SHA.json"
  # The dynamic user owns that folder: a link there would make root copy a file that the migration cannot read.
  if [ -L "$f" ]; then rm -f "$f"; log "ignored $f: a symbolic link, not a report"; return 0; fi
  [ -f "$f" ] || return 0
  install -m 0600 -o "$OWNER" -g "$OWNER_GROUP" "$f" "$LIB/migrate-$SHA.json"
  install -m 0600 -o "$OWNER" -g "$OWNER_GROUP" "$f" "$LOG_DIR/migrate-$SHA.json"
  rm -f "$f"
}

wait_healthy() { # port; health checks are local, so no proxy of the environment applies
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  until curl -fsS --noproxy '*' --max-time 3 "http://$HEALTH_HOST:$1/health/ready" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 2
  done
}

current_sha() { # the sha of the release that `current` points at, or nothing (no link, or a dangling one)
  local target
  target="$(readlink -e "$CURRENT" 2>/dev/null || true)"
  [ -z "$target" ] || basename "$target"
}

switch_current() { # release dir; a link that already points there stays as it is
  [ "$(readlink "$CURRENT" 2>/dev/null || true)" != "$1" ] || return 0
  ln -sfn "$1" "$CURRENT.new"
  mv -T "$CURRENT.new" "$CURRENT"
}

install_if_changed() { # src dest mode -> 0 when the file changed, 1 when it was already the same
  if [ -f "$2" ] && cmp -s "$1" "$2"; then return 1; fi
  install -m "$3" -o "$OWNER" -g "$OWNER_GROUP" "$1" "$2" || die "could not install $2"
}

remove_tree() { # path, also a read-only release
  if [ -L "$1" ]; then rm -f -- "$1"; return 0; fi
  [ -e "$1" ] || return 0
  # Root ignores the modes, and never runs chmod -R over an upload that the deploy user can still change. Only the
  # test (VELEXIS_ROOT, no root) needs write rights to remove a read-only release.
  if [ -n "$R" ]; then chmod -R u+w -- "$1" 2>/dev/null || true; fi
  rm -rf --one-file-system -- "$1"
}

restart_units() { # release dir; returns 1 on the first unhealthy unit
  local rel="$1" entry unit dir port
  for entry in "${UNITS[@]}"; do
    read -r unit dir port <<<"$entry"
    [ -d "$rel/$dir" ] || continue
    # A masked unit (for example the workers during a restore drill on a scratch VM) is never started.
    if [ "$("$SYSTEMCTL" is-enabled "$unit" 2>/dev/null || true)" = "masked" ]; then log "skip $unit (masked)"; continue; fi
    "$SYSTEMCTL" enable "$unit" >/dev/null 2>&1
    log "restart $unit"
    "$SYSTEMCTL" restart "$unit"
    if ! wait_healthy "$port"; then
      log "$unit is not healthy on $HEALTH_HOST:$port after ${HEALTH_TIMEOUT}s"
      { journalctl -u "$unit" -n 30 --no-pager 2>&1 || true; } | tee -a "$LOG_DIR/deploy.log" >/dev/null
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
    dest="$ETC/$(basename "$tpl" .example)"
    if [ ! -f "$dest" ]; then missing="$missing $(basename "$dest")"; continue; fi
    for key in $keys; do
      grep -qE "^${key}=" "$dest" || missing="$missing $(basename "$dest"):$key"
    done
  done
  [ -z "$missing" ] || die "env files lack variables of this release's templates:$missing. Add them to /etc/velexis (empty is allowed), then deploy again. Nothing was changed."
}

verify_upload() { # dir: SHA256SUMS lists exactly the regular files of the folder (but itself), all intact
  local dir="$1" listed present extra odd
  ( cd "$dir" && sha256sum --quiet --strict -c SHA256SUMS ) || die "checksum verification failed for $dir"
  # A file that SHA256SUMS does not list would run unverified (a unit, a script, a module): it is refused too.
  listed="$(sed -E 's/^[0-9a-f]{64} [ *]//' "$dir/SHA256SUMS" | LC_ALL=C sort)"
  present="$(cd "$dir" && find . -type f ! -path ./SHA256SUMS | LC_ALL=C sort)"
  if [ "$listed" != "$present" ]; then
    extra="$(LC_ALL=C comm -13 <(printf '%s\n' "$listed") <(printf '%s\n' "$present") | head -n 5 | paste -sd' ' -)"
    die "checksum verification failed for $dir: files that SHA256SUMS does not list: ${extra:-(none; a malformed line)}"
  fi
  odd="$(cd "$dir" && find . ! -type f ! -type d ! -type l | head -n 5 | paste -sd' ' -)"
  [ -z "$odd" ] || die "checksum verification failed for $dir: special files: $odd"
}

snapshot_system_files() { # uploaded dir, sha: root-owned copy of everything root installs from a release
  local src="$1" dst="$SYSTEM_SNAPSHOTS/$2"
  remove_tree "$dst"
  install -d -m 0755 -o "$OWNER" -g "$OWNER_GROUP" "$SYSTEM_SNAPSHOTS" "$dst" "$dst/maintenance"
  cp -R -P "$src/deploy/systemd" "$dst/systemd"
  cp -P "$src/deploy/caddy/Caddyfile" "$dst/Caddyfile"
  cp -P "$src/deploy/caddy/maintenance/index.html" "$dst/maintenance/index.html"
  chown -R "$OWNER:$OWNER_GROUP" "$dst"
  chmod -R u=rwX,go=rX "$dst"
}

caddy_validates() { # Caddyfile -> 0 when caddy validates it with caddy.env, as the caddy service reads it
  local out rc=0
  [ -r "$ETC/caddy.env" ] || { log "cannot read $ETC/caddy.env"; return 1; }
  # Errors of caddy.env itself are dropped: bash would quote part of a value for a malformed line. Caddy's own
  # messages can quote a substituted value (the edge secret), so every value of caddy.env is redacted from them.
  out="$(
    set -a
    # shellcheck disable=SC1090,SC1091
    . "$ETC/caddy.env" 2>/dev/null
    set +a
    caddy validate --config "$1" --adapter caddyfile 2>&1
  )" || rc=$?
  [ "$rc" -eq 0 ] || log "caddy validate failed: $(redact "$out" "$ETC/caddy.env" | tail -n 5)"
  return "$rc"
}

UNITS_CHANGED=0
CADDY_CHANGED=0
stage_system_files() { # root-owned snapshot dir (never a folder the deploy user or the app user can write)
  local src="$1" f
  UNITS_CHANGED=0
  CADDY_CHANGED=0
  rm -f "$CADDY_DIR/Caddyfile.next"
  # Validate a changed Caddyfile first, so that a bad one changes nothing at all.
  if ! cmp -s "$src/Caddyfile" "$CADDY_DIR/Caddyfile"; then
    install -m 0644 -o "$OWNER" -g "$OWNER_GROUP" "$src/Caddyfile" "$CADDY_DIR/Caddyfile.next"
    caddy_validates "$CADDY_DIR/Caddyfile.next" \
      || { rm -f "$CADDY_DIR/Caddyfile.next"; die "Caddyfile from $src does not validate; nothing was activated"; }
    CADDY_CHANGED=1
  fi

  for f in "$src"/systemd/*.service "$src"/systemd/*.timer; do
    [ -f "$f" ] || continue
    install_if_changed "$f" "$SYSTEMD_DIR/$(basename "$f")" 0644 && UNITS_CHANGED=1
  done
  install -d -m 0755 "$SYSTEMD_DIR/caddy.service.d"
  install_if_changed "$src/systemd/caddy.service.d/velexis.conf" "$SYSTEMD_DIR/caddy.service.d/velexis.conf" 0644 && UNITS_CHANGED=1
  if [ "$UNITS_CHANGED" -eq 1 ]; then "$SYSTEMCTL" daemon-reload; log "systemd units updated from $src"; fi

  install -d -m 0755 "$BASE/maintenance"
  install_if_changed "$src/maintenance/index.html" "$BASE/maintenance/index.html" 0644 || true
}

activate_caddyfile() { # after the units are healthy: the staged Caddyfile goes live
  if [ "$CADDY_CHANGED" -eq 1 ]; then
    mv "$CADDY_DIR/Caddyfile.next" "$CADDY_DIR/Caddyfile"
    "$SYSTEMCTL" reload caddy
    log "Caddyfile reloaded"
    CADDY_CHANGED=0
  fi
}

restore_running_system_files() { # failure before the switch: the running release keeps its own units
  if [ -n "$PREV_SHA" ] && [ -d "$SYSTEM_SNAPSHOTS/$PREV_SHA" ]; then
    log "re-install the units and Caddyfile of the running release $PREV_SHA"
    stage_system_files "$SYSTEM_SNAPSHOTS/$PREV_SHA"
  fi
  rm -f "$CADDY_DIR/Caddyfile.next"
}

previous_sha() { # last activated sha different from the current one
  local cur
  cur="$(current_sha)"
  [ -f "$HISTORY" ] || return 0
  awk -v cur="${cur:-none}" '$2 != cur { sha = $2 } END { if (sha) print sha }' "$HISTORY"
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
    UNITS_CHANGED=0; CADDY_CHANGED=0; rm -f "$CADDY_DIR/Caddyfile.next"
  fi
  switch_current "$rel"
  restart_units "$rel" || die "rollback release $1 is not healthy either; investigate now"
  activate_caddyfile
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1 rollback" >> "$HISTORY"
}

# ---- commands ----------------------------------------------------------------------------------------------
case "${1:-}" in
  --status)
    echo "current: $(readlink -e "$CURRENT" 2>/dev/null || echo none)"
    for entry in "${UNITS[@]}"; do read -r unit _ _ <<<"$entry"; printf '%-28s %s\n' "$unit" "$("$SYSTEMCTL" is-active "$unit" 2>/dev/null || true)"; done
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
PREV_SHA="$(current_sha)"
log "deploy $SHA (previous: ${PREV_SHA:-none})"

# ---- 1. verify the upload, install root-used files from it, then hand it over read-only ----------------
if [ ! -d "$REL" ]; then
  SRC="$INCOMING/$SHA"
  if [ ! -d "$SRC" ] || [ -L "$SRC" ]; then die "nothing uploaded at $SRC"; fi
  verify_upload "$SRC"
  node -e 'const m=require(process.argv[1]); if(m.sha!==process.argv[2]) process.exit(1)' "$SRC/RELEASE.json" "$SHA" \
    || die "RELEASE.json does not match $SHA"
  BUILT_NODE="$(node -p 'require(process.argv[1]).node.split(".")[0]' "$SRC/RELEASE.json")"
  [ "$BUILT_NODE" = "$(node -p 'process.version.split(".")[0]')" ] || die "release built with Node $BUILT_NODE, VM runs $(node --version)"
  check_env_files "$SRC/deploy/env"

  # Everything root will use (scripts, units, Caddyfile, maintenance page) is taken from the uploaded copy
  # BEFORE the folder is handed over, so neither the deploy user nor an app process can change it (ADR-0023).
  # Units and Caddyfile go through a root-owned snapshot that a later rollback re-installs.
  # The scripts come after stage_system_files, so a Caddyfile that does not validate changes no installed file.
  snapshot_system_files "$SRC" "$SHA"
  stage_system_files "$SYSTEM_SNAPSHOTS/$SHA"
  install_if_changed "$SRC/deploy/scripts/deploy.sh" "$SBIN/velexis-deploy" 0755 && log "velexis-deploy updated (used from the next deploy)"
  install_if_changed "$SRC/deploy/scripts/backup.sh" "$SBIN/velexis-backup" 0755 || true
  install_if_changed "$SRC/deploy/scripts/restore.sh" "$SBIN/velexis-restore" 0755 || true
  install_if_changed "$SRC/deploy/scripts/alert.sh" "$SBIN/velexis-alert" 0755 || true
  if [ -f "$SRC/deploy/scripts/run-as.sh" ]; then
    install_if_changed "$SRC/deploy/scripts/run-as.sh" "$SBIN/velexis-run" 0755 || true
  fi

  mv -T "$SRC" "$REL"
  # root:velexis and read-only: every app user reads it through the velexis group, none can change it (ADR-0026).
  chown -R "$OWNER:$RELEASE_GROUP" "$REL"
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
  # deploy.yml uploads every time; the copy on the VM was verified when it arrived, so a new upload is not used.
  if [ -e "$INCOMING/$SHA" ] || [ -L "$INCOMING/$SHA" ]; then
    remove_tree "$INCOMING/$SHA"
    log "removed the unused upload $INCOMING/$SHA"
  fi
fi

# ---- 2. migrations (DDL as velexis_migrator) ---------------------------------------------------------------
# The DSN is only in the root-only migrator.env, which systemd reads for each transient unit (run_transient).
# Note: errexit is off inside a subshell followed by `||`, so every step ends with `|| exit 1`.
if [ -f "$REL/db/dist/cli/migrate.js" ]; then
  CONCURRENCY="$(env_value "$ETC/migrator.env" MIGRATE_TENANT_CONCURRENCY)"
  FAILURE_RATIO="$(env_value "$ETC/migrator.env" MIGRATE_TENANT_MAX_FAILURE_RATIO)"
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
  if [ "$NEW_SUM" != "$(cat "$LIB/reference-data.sha256" 2>/dev/null || true)" ]; then
    log "load reference data"
    run_transient /etc/velexis/reference-loader.env "$REL/reference-data" node dist/cli/load.js --data data \
      || { restore_running_system_files; die "reference data load failed"; }
    echo "$NEW_SUM" > "$LIB/reference-data.sha256"
  fi
fi

# ---- 4. switch and restart with health checks --------------------------------------------------------------
switch_current "$REL"
if ! restart_units "$REL"; then
  if [ -n "$PREV_SHA" ] && [ "$PREV_SHA" != "$SHA" ]; then
    rollback_to "$PREV_SHA"
    die "deploy of $SHA failed health checks; rolled back to $PREV_SHA"
  fi
  die "deploy of $SHA failed health checks; no other release was active, so there is nothing to roll back to"
fi

activate_caddyfile

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $SHA" >> "$HISTORY"

# ---- 5. prune: keep the last $KEEP_RELEASES releases, never the active one nor the --rollback target -------
# Releases are kept for rollback (ADR-0007): the release `--rollback` would switch to stays even when it is older
# than the newest five (for example after a re-deploy of an old release). Compared by sha, not by path: a path
# through a symbolic link (/srv -> /data/srv) must never prune the active one.
ACTIVE_SHA="$(current_sha)"
ROLLBACK_SHA="$(previous_sha)"
find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn | awk -v keep="$KEEP_RELEASES" 'NR > keep { print $2 }' |
  while read -r old; do
    if [ "$old" = "$ACTIVE_SHA" ] || [ "$old" = "$ROLLBACK_SHA" ]; then continue; fi
    log "prune $old"
    remove_tree "$RELEASES/$old"
    remove_tree "$SYSTEM_SNAPSHOTS/$old"
  done
# A snapshot without its release (a deploy refused after the snapshot, for example by caddy validate) goes too.
for snapshot in "$SYSTEM_SNAPSHOTS"/*; do
  [ -d "$snapshot" ] || continue
  old="$(basename "$snapshot")"
  [ -d "$RELEASES/$old" ] || [ "$old" = "$ACTIVE_SHA" ] || { log "prune the snapshot $old (no release)"; remove_tree "$snapshot"; }
done
if [ -d "$INCOMING" ]; then
  find "$INCOMING" -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf --one-file-system {} +
fi

log "deploy $SHA done"
