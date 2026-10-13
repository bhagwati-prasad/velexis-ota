#!/usr/bin/env bash
# =====================================================================================================
# fake-systemctl.sh — the systemctl of deploy/scripts/test/deploy.test.sh (task X-023). deploy.sh calls it as
# SYSTEMCTL; it runs deploy/scripts/test/fake-app.mjs processes instead of units, and needs no root and no systemd.
#
#   daemon-reload        load every unit file of <VELEXIS_ROOT>/etc/systemd/system (*.service, *.timer, drop-ins)
#   restart <unit>       stop the unit's fake app, then start fake-app.mjs in the unit's WorkingDirectory (moved under
#                        VELEXIS_ROOT) on HEALTH_HOST and the unit's health port (Environment=HEALTH_PORT= or PORT=),
#                        and wait until it listens. Like systemd it uses the unit as last loaded: a unit file that
#                        changed on disk without a daemon-reload gives systemd's warning, recorded in stale.log.
#   stop <unit>          stop the unit's fake app
#   is-active <unit>     active (exit 0) or inactive (exit 3)
#   enable <unit>        mark it enabled (a masked or missing unit fails, as with systemd)
#   is-enabled <unit>    masked, enabled (exit 0) or disabled (exit 1); a missing unit fails
#   mask, unmask <unit>  what deploy.test.sh uses to mask a unit
#   reload caddy         recorded with the SHA-256 of the live Caddyfile
# Every call is appended to <FAKE_STATE>/systemctl.log as one line, "<command> <unit> [key=value ...]"; a restart
# records the new pid, the port, the release the unit's folder resolves to and the "# deploy.test.sh marker:" line
# of the loaded unit file, so the test can tell which unit file a restart used.
#
# Environment (required): VELEXIS_ROOT (the test root), FAKE_STATE (state folder: loaded/, run/, logs/, enabled/,
# masked/), HEALTH_HOST. Optional: FAKE_NODE (node binary; default node on PATH), FAKE_START_TIMEOUT (seconds a
# fake app may take to listen; default 10).
# =====================================================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${VELEXIS_ROOT:?VELEXIS_ROOT is required}"
: "${FAKE_STATE:?FAKE_STATE is required}"
: "${HEALTH_HOST:?HEALTH_HOST is required}"
NODE="${FAKE_NODE:-$(command -v node)}"
START_TIMEOUT="${FAKE_START_TIMEOUT:-10}"
UNIT_DIR="$VELEXIS_ROOT/etc/systemd/system"
LOADED="$FAKE_STATE/loaded"
RUN="$FAKE_STATE/run"
mkdir -p "$LOADED" "$RUN" "$FAKE_STATE/logs" "$FAKE_STATE/enabled" "$FAKE_STATE/masked"

record() { printf '%s\n' "$*" >>"$FAKE_STATE/systemctl.log"; }

unit_value() { # file key -> the value of the last "key=" line
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

unit_env() { # file name -> the value of "Environment=name=value"
  sed -n "s/^Environment=$2=//p" "$1" | tail -n 1
}

running() { # pid -> 0 while the process exists and is not a zombie
  local status
  status="$(awk '{ print $3 }' "/proc/$1/stat" 2>/dev/null)" || return 1
  [ -n "$status" ] && [ "$status" != Z ]
}

app_alive() { # pid -> 0 while the process runs and is a fake app (never another process that got its pid)
  running "$1" && tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null | grep -q 'fake-app\.mjs'
}

stop_app() { # name
  local pidfile="$RUN/$1.pid" pid i
  [ -f "$pidfile" ] || return 0
  pid="$(cat "$pidfile")"
  if app_alive "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    for ((i = 0; i < 100; i++)); do app_alive "$pid" || break; sleep 0.05; done
    if app_alive "$pid"; then kill -KILL "$pid" 2>/dev/null || true; fi
    for ((i = 0; i < 100; i++)); do app_alive "$pid" || break; sleep 0.05; done
  fi
  rm -f "$pidfile" "$RUN/$1.ready" "$RUN/$1.error"
}

restart() { # name
  local name="$1" file="$1.service" disk loaded wd port marker dir release pid i
  disk="$UNIT_DIR/$file"
  loaded="$LOADED/$file"
  if [ -e "$FAKE_STATE/masked/$name" ]; then
    echo "Failed to restart $file: Unit $file is masked." >&2
    record "restart $name refused=masked"
    return 1
  fi
  if [ ! -f "$loaded" ]; then
    if [ ! -f "$disk" ]; then
      echo "Failed to restart $file: Unit $file not found." >&2
      record "restart $name refused=not-found"
      return 5
    fi
    cp "$disk" "$loaded" # systemd loads a unit it has not seen yet on its first use
  elif [ ! -f "$disk" ] || ! cmp -s "$disk" "$loaded"; then
    echo "Warning: The unit file, source configuration file or drop-ins of $file changed on disk. Run 'systemctl daemon-reload' to reload units." >&2
    printf '%s\n' "$name" >>"$FAKE_STATE/stale.log"
  fi

  stop_app "$name"
  wd="$(unit_value "$loaded" WorkingDirectory)"
  port="$(unit_env "$loaded" HEALTH_PORT)"
  [ -n "$port" ] || port="$(unit_env "$loaded" PORT)"
  marker="$(sed -n 's/^# deploy.test.sh marker: //p' "$loaded" | tail -n 1)"
  dir="$VELEXIS_ROOT$wd"
  if [ -z "$wd" ] || [ -z "$port" ] || [ ! -d "$dir" ]; then
    # systemd's start job of a Type=simple unit succeeds; the process then fails (status 200/CHDIR).
    echo "$file: no WorkingDirectory, health port or folder $dir" >&2
    record "restart $name failed=chdir"
    return 0
  fi
  release="$(basename "$(dirname "$(readlink -f "$dir")")")"
  (
    # A unit inherits nothing from the caller: no open descriptor (deploy.sh's lock on fd 9), no environment.
    for fd in /proc/self/fd/*; do
      fd="${fd##*/}"
      if [[ "$fd" =~ ^[0-9]+$ ]] && [ "$fd" -gt 2 ]; then exec {fd}>&- || true; fi
    done
    cd "$dir"
    exec env -i PATH=/usr/bin:/bin FAKE_UNIT="$name" FAKE_HOST="$HEALTH_HOST" FAKE_PORT="$port" FAKE_STATE="$FAKE_STATE" \
      setsid "$NODE" "$HERE/fake-app.mjs" </dev/null >>"$FAKE_STATE/logs/$name.log" 2>&1
  ) &
  pid=$!
  printf '%s\n' "$pid" >"$RUN/$name.pid"
  for ((i = 0; i < START_TIMEOUT * 20; i++)); do
    [ ! -f "$RUN/$name.ready" ] || break
    [ ! -f "$RUN/$name.error" ] || break
    running "$pid" || break
    sleep 0.05
  done
  if [ ! -f "$RUN/$name.ready" ]; then
    echo "$file: the fake app did not listen on $HEALTH_HOST:$port ($(cat "$RUN/$name.error" 2>/dev/null || echo 'no answer'))" >&2
  fi
  record "restart $name pid=$pid port=$port release=$release marker=${marker:-none}"
}

command="${1:-}"
unit="${2:-}"
name="${unit%.service}"
case "$command" in
  daemon-reload)
    rm -rf "$LOADED"
    mkdir -p "$LOADED"
    for f in "$UNIT_DIR"/*.service "$UNIT_DIR"/*.timer; do
      if [ -f "$f" ]; then cp "$f" "$LOADED/"; fi
    done
    if [ -d "$UNIT_DIR/caddy.service.d" ]; then cp -R "$UNIT_DIR/caddy.service.d" "$LOADED/"; fi
    record "daemon-reload"
    ;;
  restart)
    record_rc=0
    restart "$name" || record_rc=$?
    exit "$record_rc"
    ;;
  stop)
    stop_app "$name"
    record "stop $name"
    ;;
  is-active)
    if [ -f "$RUN/$name.pid" ] && app_alive "$(cat "$RUN/$name.pid")"; then echo active; exit 0; fi
    echo inactive
    exit 3
    ;;
  enable)
    if [ -e "$FAKE_STATE/masked/$name" ]; then echo "Failed to enable unit: Unit file $name.service is masked." >&2; exit 1; fi
    if [ ! -f "$UNIT_DIR/$name.service" ]; then echo "Failed to enable unit: Unit file $name.service does not exist." >&2; exit 1; fi
    touch "$FAKE_STATE/enabled/$name"
    record "enable $name"
    ;;
  is-enabled)
    if [ -e "$FAKE_STATE/masked/$name" ]; then echo masked; exit 1; fi
    if [ ! -f "$UNIT_DIR/$name.service" ]; then
      echo "Failed to get unit file state for $name.service: No such file or directory" >&2
      exit 1
    fi
    if [ -e "$FAKE_STATE/enabled/$name" ]; then echo enabled; exit 0; fi
    echo disabled
    exit 1
    ;;
  mask)
    touch "$FAKE_STATE/masked/$name"
    record "mask $name"
    ;;
  unmask)
    rm -f "$FAKE_STATE/masked/$name"
    record "unmask $name"
    ;;
  reload)
    record "reload $name caddyfile=$(sha256sum "$VELEXIS_ROOT/etc/caddy/Caddyfile" 2>/dev/null | cut -c1-64)"
    ;;
  *)
    record "unexpected $*"
    echo "fake-systemctl: unexpected command: $*" >&2
    exit 1
    ;;
esac
