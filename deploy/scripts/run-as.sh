#!/usr/bin/env bash
# =====================================================================================================
# run-as.sh — run a one-off command as a trust zone's system user (ADR-0026 item 6, task X-033). Installed
# root-owned as /usr/local/sbin/velexis-run by provision-vm.sh (step scripts) and by every deploy.
#
#   sudo velexis-run <zone> <command...>
#   sudo velexis-run platform node dist/cli.js admin:grant <email>
#
# Zones and the installed unit each one copies:
#   platform        velexis-platform-worker   user velexis-platform, platform-backend.env (+ platform-worker.env)
#   ota             velexis-ota-worker        user velexis-ota, ota-backend.env + ota-worker.env
#   portal          velexis-portal            user velexis-portal, platform-frontend.env
#   platform-admin  velexis-platform-admin    user velexis-platform-admin, platform-admin.env
#   ota-admin       velexis-ota-admin         user velexis-ota-admin, ota-admin.env
#
# The command runs through systemd-run as a transient service with the [Service] settings of the zone's installed
# unit file (/etc/systemd/system/<unit>.service, root-owned, the version of the active release): User=, Group=,
# SupplementaryGroups=, EnvironmentFile= (root:root 0600; systemd reads them, this script never does),
# Environment=, WorkingDirectory= (the zone's folder in /srv/velexis/current, so `node dist/cli.js` works) and every
# sandboxing and resource line. A backend zone copies its worker unit, so it gets both env files of the zone; the
# migrator DSN is never among them. Lines that only make sense for a long-running service (Type=, ExecStart=,
# Restart=, timeouts, SyslogIdentifier=) and the [Unit] section (OnFailure= alerts, start limits) are left out.
#
# Standard input, output and error are the caller's (systemd-run --pipe), and the exit code is the command's.
# velexis-run itself exits 125 when it refuses to start (bad arguments, no unit, no release folder).
# deploy/systemd/test/units-smoke.sh runs this script against the real unit files under systemd.
# =====================================================================================================
set -euo pipefail

UNIT_DIR=/etc/systemd/system
UNIT_PREFIX=velexis-

refuse() { printf 'velexis-run: %s\n' "$*" >&2; exit 125; }
usage() { refuse "usage: velexis-run <platform|ota|portal|platform-admin|ota-admin> <command...>"; }

[ $# -ge 2 ] || usage
zone="$1"
shift
case "$zone" in
  platform) unit=platform-worker ;;
  ota) unit=ota-worker ;;
  portal | platform-admin | ota-admin) unit="$zone" ;;
  *) usage ;;
esac
[ "$(id -u)" -eq 0 ] || refuse "run as root (sudo velexis-run ...)"
unit_file="$UNIT_DIR/$UNIT_PREFIX$unit.service"
[ -f "$unit_file" ] || refuse "$unit_file is not installed"

props=()
workdir=""
section=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '' | '#'* | ';'*) continue ;;
    '['*']') section="$line"; continue ;;
  esac
  [ "$section" = "[Service]" ] || continue
  case "$line" in
    *\\) refuse "$unit_file: continued lines are not supported" ;;
    [A-Za-z]*=*) ;;
    *) refuse "$unit_file: cannot read the line '$line'" ;;
  esac
  key="${line%%=*}"
  case "$key" in
    Type | Exec* | Restart | RestartSec | RestartMode | KillSignal | KillMode | Timeout* | SyslogIdentifier) continue ;;
    WorkingDirectory) workdir="${line#*=}"; workdir="${workdir#-}" ;;
    *[!A-Za-z]*) refuse "$unit_file: cannot read the line '$line'" ;;
  esac
  props+=(-p "$line")
done < "$unit_file"
[ -n "$workdir" ] || refuse "$unit_file has no WorkingDirectory="
[ -d "$workdir" ] || refuse "the active release has no $workdir"

exec systemd-run --quiet --pipe --wait --collect \
  --unit="velexis-run-$zone-$(date -u +%Y%m%d%H%M%S)-$$" \
  --description="velexis-run $zone: one-off command" \
  "${props[@]}" -- "$@"
