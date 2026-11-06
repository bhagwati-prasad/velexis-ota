#!/usr/bin/env bash
# =====================================================================================================
# healthcheck.sh — the on-VM health check (ADR-0016 "On-VM check", task X-030). Root-owned copy:
# /usr/local/sbin/velexis-healthcheck, started every 5 minutes by velexis-healthcheck.timer. Installed by
# provision-vm.sh (step scripts, which also enables the timer) and again by every deploy (deploy.sh).
#
#   velexis-healthcheck                  run every check; the payment page check once per UTC day
#   velexis-healthcheck --payment-pages  the same, with the payment page check now even if it ran today
#   velexis-healthcheck --status         print the last state of every check (checks nothing, sends nothing)
#
# Checks (thresholds of ADR-0016, OADR-0014 point 8 and docs/mvp/deployment-single-vm.md §13), one state each:
#   ready-<unit>          GET http://127.0.0.1:<port>/health/ready of every ENABLED Velexis unit answers 200. Masked,
#                         disabled and missing units are skipped, and so are all of them while velexis-deploy holds its
#                         lock (/run/velexis-deploy.lock, read from /proc/locks and never taken, so no deploy is refused).
#   failed-jobs-<unit>    a worker whose readiness lists `queues` (the OTA worker, OBE-025) had at most 20 jobs that
#                         failed in the last hour, over all its queues. A readiness without `queues` (the platform
#                         worker, or Redis did not answer the queue report) is skipped: unknown, never "no failures".
#   queue-age-<unit>      the same worker has no queue whose oldest waiting job has waited more than 10 minutes.
#   disk-<path>           `/` and `/var/lib/postgresql` are at most 80 % full (each file system once).
#   redis-memory          Redis `used_memory` is at most 70 % of `maxmemory` (password from .provision-secrets, given to
#                         redis-cli in its environment, never on a command line; no answer within 10 s fails).
#   backup-age            the backup marker (BACKUP_MARKER_FILE of backup.env) is at most 26 hours old.
#   tls-<host>            the certificate this VM's Caddy serves for each of the five named hosts (PLATFORM_BASE_DOMAIN,
#                         admin., api. of it, admin. and api. of STOREFRONT_BASE_DOMAIN; caddy.env) expires in more than
#                         14 days (openssl s_client to 127.0.0.1:443 with the host as SNI).
#   payment-page-<page>   once a day (ADR-0011 §C, PCI DSS 6.4.3 and 11.6.1): both payment pages of the demo storefront,
#                         /checkout/pay-card.html and /checkout/pay-airline.html, fetched from this VM's Caddy, against
#                         storefront/payment-page-inventory.json of the current release (OFE-023, format version 1 of
#                         ota/frontend/README.md §10): the ordered <script src> list, the module preloads, no inline
#                         script, the HTML's SHA-256 and every header of the inventory on every path of the page, then
#                         the SHA-256 of every first-party script and stylesheet the page loads (fetched without
#                         Accept-Encoding, as the inventory hashes the stored files). Only URLs of the inventory are
#                         fetched, never one found in a page, and none more in that run once the storefront gave no
#                         answer. A missing inventory skips the check with a warning; one of another format or version
#                         fails `payment-inventory`. While velexis-deploy holds its lock the check waits for the first
#                         run after it (a deploy switches `current` and may reload Caddy).
#
# Alerts only on changes (step 2 of X-030): one state file per check in /var/lib/velexis/healthcheck/. A check that
# goes ok -> fail (or fails on its first run) sends one alert, fail -> ok one recovery, both through
# `velexis-alert message`; a check that stays as it was sends nothing. A check that is skipped keeps its state. When
# velexis-alert fails, the state stays as it was, so the next run sends the alert again, and the run exits 1 (systemd
# then starts velexis-alert@ for the unit). Every other outcome exits 0: a failing check is the alert's business, not
# the unit's. Messages hold names, numbers, paths and the public headers of the storefront, never a secret.
#
# Settings: /etc/velexis/healthcheck.env (optional, root 0600; deploy/env/healthcheck.env.example), read without
# sourcing it: HEALTHCHECK_STOREFRONT_HOST (default demo.<STOREFRONT_BASE_DOMAIN>), the storefront of the payment page
# check, and HEALTHCHECK_PAGES (`payment`, the default: the two payment pages; `all`: every page of the inventory,
# OADR-0017 point 8). SMTP settings stay in alert.env, which only velexis-alert reads.
#
# Tests only (deploy/scripts/test/healthcheck.test.sh). With VELEXIS_ROOT=<absolute folder> the paths of this script
# (/etc/velexis, /srv/velexis, /var/lib/velexis and the deploy lock in /run) move under that folder, it runs without
# root, and it takes these overrides:
#   SYSTEMCTL       the systemctl to call for `is-enabled` (required with VELEXIS_ROOT)
#   VELEXIS_ALERT   a command that replaces /usr/local/sbin/velexis-alert (required with VELEXIS_ROOT)
#   HEALTH_HOST     the address of the unit health checks (default 127.0.0.1)
#   STOREFRONT_URL  the origin the payment pages are fetched from (default https://<storefront host> through
#                   127.0.0.1:443, as on the VM)
#   TLS_CONNECT     the host:port the TLS checks connect to (default 127.0.0.1:443)
# Without VELEXIS_ROOT (the VM) they have no effect. df and redis-cli are taken from PATH (systemd's on the VM).
# =====================================================================================================
set -euo pipefail
umask 077

NAME=velexis-healthcheck
: "${VELEXIS_ROOT:=}"
R="$VELEXIS_ROOT"
if [ -n "$R" ]; then
  case "$R" in /?*) ;; *) echo "$NAME: VELEXIS_ROOT must be an absolute path other than /" >&2; exit 2 ;; esac
  [ -d "$R" ] || { echo "$NAME: VELEXIS_ROOT $R is not a folder" >&2; exit 2; }
  [ -n "${SYSTEMCTL:-}" ] || { echo "$NAME: with VELEXIS_ROOT, SYSTEMCTL must name the stand-in for systemctl" >&2; exit 2; }
  [ -n "${VELEXIS_ALERT:-}" ] || { echo "$NAME: with VELEXIS_ROOT, VELEXIS_ALERT must name the stand-in for velexis-alert" >&2; exit 2; }
  HEALTH_HOST="${HEALTH_HOST:-127.0.0.1}"
  STOREFRONT_URL="${STOREFRONT_URL:-}"
  TLS_CONNECT="${TLS_CONNECT:-127.0.0.1:443}"
else
  SYSTEMCTL=systemctl
  VELEXIS_ALERT=/usr/local/sbin/velexis-alert
  HEALTH_HOST=127.0.0.1
  STOREFRONT_URL=""
  TLS_CONNECT=127.0.0.1:443
fi
[[ "$HEALTH_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "$NAME: HEALTH_HOST is not a host name or IPv4 address" >&2; exit 2; }
[[ "$TLS_CONNECT" =~ ^[A-Za-z0-9.-]+:[0-9]{1,5}$ ]] || { echo "$NAME: TLS_CONNECT must be host:port" >&2; exit 2; }
if [ -n "$STOREFRONT_URL" ] && ! [[ "$STOREFRONT_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  echo "$NAME: STOREFRONT_URL must be an origin (http[s]://host[:port])" >&2
  exit 2
fi

ETC="$R/etc/velexis"
LIB="$R/var/lib/velexis"
STATE_DIR="$LIB/healthcheck"
CURRENT="$R/srv/velexis/current"
DEPLOY_LOCK="$R/run/velexis-deploy.lock"
SECRETS_FILE="$ETC/.provision-secrets"
INVENTORY_FORMAT=velexis-storefront-payment-page-inventory
INVENTORY_VERSION=1

# Thresholds: ADR-0016 (On-VM check), X-030 step 1, OADR-0014 point 8 (queue age).
DISK_MAX_PERCENT=80
REDIS_MAX_PERCENT=70
BACKUP_MAX_AGE=$((26 * 3600))
FAILED_JOBS_MAX=20
QUEUE_AGE_MAX=600
TLS_MIN_SECONDS=$((14 * 86400))
# Time limits, so that a service that accepts connections but never answers cannot hold the run past the unit's
# TimeoutStartSec (4 min): 7 health ports x 5 s, Redis 10 s, 5 TLS hosts x 15 s and the storefront 20 s at most, as a
# storefront that gives no answer is asked nothing more in that run.
REDIS_TIMEOUT=10

# unit | health port: the units and ports of deploy.sh (deployment-single-vm.md §4).
UNITS=(
  "velexis-platform-worker 3101"
  "velexis-ota-worker 4001"
  "velexis-platform-api 3100"
  "velexis-ota-api 4000"
  "velexis-portal 3000"
  "velexis-platform-admin 3001"
  "velexis-ota-admin 3002"
)
DISK_PATHS=(/ /var/lib/postgresql)
# The two payment pages of ADR-0011 §C (files of the inventory, dist-relative).
PAYMENT_PAGES=(checkout/pay-card.html checkout/pay-airline.html)

log() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
show() { printf '%s' "${1#"$R"}"; }                        # a path as on the VM
clean() { printf '%s' "$1" | tr -cd '[:print:]' | cut -c1-400; } # text from a page or an answer, one safe line
slug() { # text -> a file-name-safe id part
  local s
  s="$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-' | sed -e 's/^-*//' -e 's/-*$//')"
  printf '%s' "${s:-root}"
}
env_value() { # file key -> the value of the last KEY= line, read without sourcing the file (it may hold secrets)
  { sed -n "s/^$2=//p" "$1" 2>/dev/null || true; } | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

usage() { echo "usage: $NAME [--payment-pages | --status]" >&2; exit 2; }
MODE=run
FORCE_PAYMENT=0
case "${1:-}" in
  "") ;;
  --payment-pages) FORCE_PAYMENT=1 ;;
  --status) MODE=status ;;
  -h | --help) sed -n '2,/^# =====/p' "$0"; exit 0 ;;
  *) usage ;;
esac
[ $# -le 1 ] || usage
if [ -z "$R" ] && [ "$(id -u)" -ne 0 ]; then echo "$NAME: run as root (sudo $0)" >&2; exit 2; fi

if [ "$MODE" = status ]; then
  found=0
  for f in "$STATE_DIR"/*.state; do
    [ -f "$f" ] || continue
    found=1
    status="" since="" summary=""
    { read -r status; read -r since; read -r summary; } <"$f" || true
    printf '%-48s %-4s since %s%s\n' "$(basename "$f" .state)" "${status:-?}" "${since:-?}" "${summary:+  $summary}"
  done
  [ "$found" = 1 ] || echo "no check has run yet ($(show "$STATE_DIR") has no state)"
  echo "payment pages last checked on: $(cat "$STATE_DIR/payment-pages.day" 2>/dev/null || echo never) (UTC)"
  exit 0
fi

install -d -m 0700 "$STATE_DIR"
exec 8>"$STATE_DIR/.lock"
if ! flock -n 8; then log "another $NAME run is still going; nothing to do"; exit 0; fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
NOW="$(date -u +%s)"
RUN_FAILED=0

# ---- state and alerts -------------------------------------------------------------------------------------
CHECK_ID=""
CHECK_LABEL=""
begin_check() { CHECK_ID="$1"; CHECK_LABEL="$2"; : >"$WORK/problems"; }
# One problem per call. The first line of a check's problems is its summary (subject of the alert); lines that start
# with two spaces are details of the line above.
problem() { printf '%s\n' "$*" >>"$WORK/problems"; }

write_state() { # status summary
  local file="$STATE_DIR/$CHECK_ID.state"
  printf '%s\n%s\n%s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" >"$file.tmp"
  mv -f "$file.tmp" "$file"
}

send_alert() { # subject body-file -> 0 when velexis-alert sent it (stdin closed: callers loop over lists on stdin)
  "$VELEXIS_ALERT" message "$1" "$2" </dev/null
}

end_check() { # compares the outcome with the check's last state; alerts only when it changed
  local file="$STATE_DIR/$CHECK_ID.state" previous="" status summary="" subject body="$WORK/alert.txt"
  [ ! -f "$file" ] || previous="$(head -n 1 "$file")"
  case "$previous" in ok | fail) ;; *) previous="" ;; esac
  if [ -s "$WORK/problems" ]; then
    status=fail
    summary="$(head -n 1 "$WORK/problems")"
    log "FAIL $CHECK_ID: $summary"
  else
    status=ok
    log "ok   $CHECK_ID"
  fi
  if [ "$status" = "$previous" ]; then return 0; fi # no change: nothing to send
  if [ "$status" = ok ] && [ -z "$previous" ]; then write_state ok ""; return 0; fi # a first run that passes
  {
    if [ "$status" = fail ]; then
      subject="health check failed: $CHECK_LABEL: $(printf '%s' "$summary" | cut -c1-160)"
      echo "$CHECK_LABEL failed at $(date -u +%Y-%m-%dT%H:%M:%SZ) (previous state: ${previous:-none})."
      echo
      cat "$WORK/problems"
    else
      subject="health check recovered: $CHECK_LABEL"
      echo "$CHECK_LABEL is ok again at $(date -u +%Y-%m-%dT%H:%M:%SZ) (previous state: fail)."
    fi
    echo
    echo "Check: $CHECK_ID (state file $(show "$file"))"
    echo "Release: $(show "$(readlink -f "$CURRENT" 2>/dev/null || echo none)")"
    echo "$NAME alerts once when a check fails and once when it recovers; sudo $NAME --status lists every check."
    echo "Runbook: docs/mvp/deployment-single-vm.md §13 and §16."
  } >"$body"
  if send_alert "$subject" "$body"; then
    write_state "$status" "$summary"
    log "     alert sent: $subject"
  else
    RUN_FAILED=1
    log "     the alert for $CHECK_ID (${previous:-none} -> $status) could not be sent; the next run sends it again"
  fi
}

skip_check() { log "skip $1: $2"; } # the state stays as it was

# ---- 1. units: readiness, failed jobs and waiting jobs of the workers --------------------------------------
deploy_running() { # 0 while velexis-deploy holds its flock (seen in /proc/locks; the lock is never taken here)
  local dev ino id
  [ -f "$DEPLOY_LOCK" ] || return 1
  read -r dev ino < <(stat -c '%d %i' "$DEPLOY_LOCK" 2>/dev/null) || return 1
  [[ "$dev" =~ ^[0-9]+$ && "$ino" =~ ^[0-9]+$ ]] || return 1
  # /proc/locks names the file as MAJOR:MINOR:INODE with the device numbers in hex (fs/locks.c), so the device is
  # compared too: an inode number alone can be another file system's, such as this script's own lock in its state folder.
  id="$(printf '%02x:%02x:%s' $((((dev >> 8) & 0xfff) | ((dev >> 32) & ~0xfff))) \
    $(((dev & 0xff) | ((dev >> 12) & ~0xff))) "$ino")"
  awk -v id="$id" '$2 == "FLOCK" && $6 == id { found = 1 } END { exit found ? 0 : 1 }' /proc/locks 2>/dev/null
}

check_queues() { # unit readiness-body
  local unit="$1" body="$2" total lines
  total="$(jq -r '[.queues[] | .failedLastHour | numbers] | add // 0' "$body" 2>/dev/null || echo "?")"
  begin_check "failed-jobs-$unit" "failed jobs of $unit"
  if ! [[ "$total" =~ ^[0-9]+$ ]]; then
    problem "the queue report of $unit's readiness cannot be read"
  elif [ "$total" -gt "$FAILED_JOBS_MAX" ]; then
    problem "$total jobs of $unit failed in the last hour (more than $FAILED_JOBS_MAX)"
    lines="$(jq -r '.queues | to_entries[] | select((.value.failedLastHour // 0) > 0)
      | "  \(.key): \(.value.failedLastHour) failed"' "$body" 2>/dev/null || true)"
    [ -z "$lines" ] || problem "$(clean_lines "$lines")"
  fi
  end_check

  begin_check "queue-age-$unit" "waiting jobs of $unit"
  lines="$(jq -r --argjson max "$QUEUE_AGE_MAX" '.queues | to_entries[]
    | select((.value.oldestWaitingSeconds // 0 | numbers) > $max)
    | "  \(.key): the oldest of \(.value.waiting) waiting jobs has waited \(.value.oldestWaitingSeconds) s"' \
    "$body" 2>/dev/null || echo "  (the queue report cannot be read)")"
  if [ -n "$lines" ]; then
    problem "a job of $unit has waited more than $((QUEUE_AGE_MAX / 60)) minutes for a worker"
    problem "$(clean_lines "$lines")"
  fi
  end_check
}

clean_lines() { # text -> the text with only printable characters per line, at most 40 lines
  printf '%s\n' "$1" | head -n 40 | while IFS= read -r line; do clean "$line"; echo; done | sed '/^$/d'
}

check_units() {
  local entry unit port enabled code body="$WORK/ready.json" deploying=0
  if deploy_running; then deploying=1; fi
  for entry in "${UNITS[@]}"; do
    read -r unit port <<<"$entry"
    enabled="$("$SYSTEMCTL" is-enabled "$unit" 2>/dev/null || true)"
    if [ "$enabled" != enabled ]; then skip_check "ready-$unit" "$unit is ${enabled:-not installed}"; continue; fi
    if [ "$deploying" = 1 ]; then skip_check "ready-$unit" "velexis-deploy is running (it restarts and checks the units)"; continue; fi
    rm -f "$body"
    begin_check "ready-$unit" "$unit readiness"
    code="$(curl -sS --noproxy '*' --max-time 5 -o "$body" -w '%{http_code}' \
      "http://$HEALTH_HOST:$port/health/ready" 2>"$WORK/curl.err" || true)"
    if [ "$code" = 200 ]; then
      :
    elif [ -z "$code" ] || [ "$code" = 000 ]; then
      problem "$unit does not answer on $HEALTH_HOST:$port/health/ready"
      problem "  $(clean "$(head -n 1 "$WORK/curl.err")")"
    else
      problem "$unit is not ready: /health/ready on $HEALTH_HOST:$port answered $code"
      problem "  $(clean "$(jq -c '{status, checks}' "$body" 2>/dev/null || head -c 400 "$body" 2>/dev/null || true)")"
    fi
    end_check
    if [ -s "$body" ] && jq -e '.queues | type == "object"' "$body" >/dev/null 2>&1; then
      check_queues "$unit" "$body"
    elif [ "${unit%-worker}" != "$unit" ]; then
      skip_check "failed-jobs-$unit, queue-age-$unit" "its readiness lists no queues (unknown, or a worker without a queue report)"
    fi
  done
}

# ---- 2. disk, Redis memory, backup age -----------------------------------------------------------------------
check_disks() {
  local path id out pct mount seen=" "
  for path in "${DISK_PATHS[@]}"; do
    id="disk-$(slug "$path")"
    out="$(df -P "$path" 2>/dev/null | awk 'NR == 2 { print $5, $6 }' || true)"
    pct="${out%% *}"
    pct="${pct%\%}"
    mount="${out#* }"
    if [ -n "$out" ] && [ "${seen#* "$mount" }" != "$seen" ]; then
      skip_check "$id" "$path is on the file system $mount, checked above"
      continue
    fi
    begin_check "$id" "disk $path"
    if ! [[ "$pct" =~ ^[0-9]+$ ]]; then
      problem "df cannot read the use of $path"
    else
      seen="$seen$mount "
      if [ "$pct" -gt "$DISK_MAX_PERCENT" ]; then
        problem "$path is $pct % full (more than $DISK_MAX_PERCENT %; file system $mount)"
      fi
    fi
    end_check
  done
}

check_redis() {
  local pw info used max
  begin_check redis-memory "Redis memory"
  pw="$(env_value "$SECRETS_FILE" REDIS_PASSWORD)"
  [ -n "$pw" ] || pw="$(env_value "$ETC/backup.env" REDIS_PASSWORD)"
  if [ -z "$pw" ]; then
    problem "no REDIS_PASSWORD in $(show "$SECRETS_FILE") or $(show "$ETC/backup.env")"
  else
    # Bounded: a Redis that accepts the connection but never answers must not hold up the checks after this one.
    info="$(REDISCLI_AUTH="$pw" timeout "$REDIS_TIMEOUT" redis-cli -h 127.0.0.1 -p 6379 --no-auth-warning INFO memory 2>&1 |
      tr -d '\r' || true)"
    used="$(printf '%s\n' "$info" | sed -n 's/^used_memory://p' | head -n 1)"
    max="$(printf '%s\n' "$info" | sed -n 's/^maxmemory://p' | head -n 1)"
    if ! [[ "$used" =~ ^[0-9]+$ && "$max" =~ ^[0-9]+$ ]]; then
      problem "Redis does not answer INFO memory on 127.0.0.1:6379 (within $REDIS_TIMEOUT s)"
      [ -z "$info" ] || problem "  $(clean "$(printf '%s\n' "$info" | head -n 1)")"
    elif [ "$max" -eq 0 ]; then
      problem "Redis has no maxmemory (0), so its use cannot be checked against $REDIS_MAX_PERCENT % (redis/velexis.conf sets 512mb)"
    elif [ $((used * 100)) -gt $((max * REDIS_MAX_PERCENT)) ]; then
      problem "Redis uses $((used * 100 / max)) % of maxmemory ($used of $max bytes; more than $REDIS_MAX_PERCENT %)"
    fi
  fi
  pw=""
  end_check
}

check_backup() {
  local marker stamp age
  marker="$(env_value "$ETC/backup.env" BACKUP_MARKER_FILE)"
  marker="$R${marker:-/var/lib/velexis/backup-last-success}"
  begin_check backup-age "backup age"
  if [ ! -f "$marker" ]; then
    problem "no successful backup is recorded ($(show "$marker") does not exist)"
  else
    stamp="$(head -n 1 "$marker" | tr -d '[:space:]')"
    if ! [[ "$stamp" =~ ^[0-9]{1,12}$ ]]; then
      problem "$(show "$marker") holds no time"
    else
      age=$((NOW - stamp))
      if [ "$age" -gt "$BACKUP_MAX_AGE" ]; then
        problem "the last successful backup is $((age / 3600)) hours old (more than $((BACKUP_MAX_AGE / 3600)); $(date -u -d "@$stamp" +%Y-%m-%dT%H:%M:%SZ))"
      fi
    fi
  fi
  end_check
}

# ---- 3. TLS expiry of the five named hosts ---------------------------------------------------------------------
PLATFORM_DOMAIN="$(env_value "$ETC/caddy.env" PLATFORM_BASE_DOMAIN)"
STOREFRONT_DOMAIN="$(env_value "$ETC/caddy.env" STOREFRONT_BASE_DOMAIN)"
PLATFORM_DOMAIN="${PLATFORM_DOMAIN:-platform.example.com}" # the Caddyfile's defaults
STOREFRONT_DOMAIN="${STOREFRONT_DOMAIN:-ota.example.com}"

check_tls() {
  local host pem end
  for host in "$PLATFORM_DOMAIN" "admin.$PLATFORM_DOMAIN" "api.$PLATFORM_DOMAIN" "admin.$STOREFRONT_DOMAIN" \
    "api.$STOREFRONT_DOMAIN"; do
    if ! [[ "$host" =~ ^[A-Za-z0-9.-]+$ ]]; then
      warn "caddy.env names a host that is not a host name: $(clean "$host"); its TLS check is skipped"
      continue
    fi
    begin_check "tls-$host" "TLS certificate of $host"
    pem="$(timeout 15 openssl s_client -connect "$TLS_CONNECT" -servername "$host" </dev/null 2>/dev/null |
      openssl x509 2>/dev/null || true)"
    if [ -z "$pem" ]; then
      problem "no certificate for $host from $TLS_CONNECT (Caddy is down, or it has no certificate for the host yet)"
    else
      end="$(printf '%s\n' "$pem" | openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
      if ! printf '%s\n' "$pem" | openssl x509 -noout -checkend "$TLS_MIN_SECONDS" >/dev/null 2>&1; then
        problem "the certificate of $host expires within $((TLS_MIN_SECONDS / 86400)) days (not after $(clean "$end"))"
      fi
    fi
    end_check
  done
}

# ---- 4. payment pages against the release's inventory (daily) -------------------------------------------------
SF_ORIGIN=""
SF_CURL=()
fetch() { # url-path prefix -> prints the HTTP status (000: no answer); headers in <prefix>.h, body in <prefix>.b
  local code
  # Once a request got no HTTP answer (no connection, TLS refused, nothing within --max-time), the run asks the storefront
  # nothing more, as each further wait could last --max-time: the remaining paths and files of every page are reported
  # as not fetched.
  if [ -e "$WORK/storefront-silent" ]; then
    printf 'not fetched: an earlier request of this run got no HTTP answer from %s\n' "$SF_ORIGIN" >"$2.e"
    printf '000'
    return 0
  fi
  code="$(curl -sS --noproxy '*' --connect-timeout 5 --max-time 20 --max-filesize 10485760 -A "$NAME" "${SF_CURL[@]}" \
    -D "$2.h" -o "$2.b" -w '%{http_code}' "$SF_ORIGIN$1" 2>"$2.e" || true)"
  code="${code:-000}"
  [ "$code" != 000 ] || : >"$WORK/storefront-silent"
  printf '%s' "$code"
}

fetch_problem() { # what url-path code prefix
  if [ "$3" = 000 ]; then
    problem "$1 $2 cannot be fetched from $SF_ORIGIN"
    problem "  $(clean "$(head -n 1 "$4.e" 2>/dev/null || true)")"
  else
    problem "$1 $2 answered HTTP $3"
  fi
}

tags() { # html-file tag -> every <tag ...> element, one per line (line breaks inside elements removed)
  tr '\r\n\t' '   ' <"$1" | grep -oiE "<$2([[:space:]][^>]*)?>" || true
}

attr() { # element attribute -> the attribute's value (quoted or not), empty when the element has none
  printf '%s\n' "$1" | sed -nE "s/.*[[:space:]]$2[[:space:]]*=[[:space:]]*(\"([^\"]*)\"|'([^']*)'|([^[:space:]\"'>]+)).*/\2\3\4/Ip" |
    head -n 1
}

compare_lists() { # path what expected-file found-file -> problems for extra, missing and reordered entries
  local p="$1" what="$2" expected="$3" found="$4" extra missing
  cmp -s "$expected" "$found" && return 0
  extra="$(awk 'NR == FNR { e[$0] = 1; next } !($0 in e)' "$expected" "$found")"
  missing="$(awk 'NR == FNR { f[$0] = 1; next } !($0 in f)' "$found" "$expected")"
  while IFS= read -r item; do [ -z "$item" ] || problem "$p: extra $what $(clean "$item") (not in the inventory)"; done <<<"$extra"
  while IFS= read -r item; do [ -z "$item" ] || problem "$p: $what $(clean "$item") of the inventory is missing"; done <<<"$missing"
  [ -n "$extra$missing" ] || problem "$p: the ${what}s are not in the order of the inventory (or one appears twice)"
  problem "  inventory: $(clean "$(paste -sd' ' "$expected")")"
  problem "  page:      $(clean "$(paste -sd' ' "$found")")"
}

compare_scripts() { # path html-file page-json
  local p="$1" html="$2" page="$3" tag src rel inline=0
  jq -r '.scripts[]?.src' "$page" >"$WORK/scripts.expected"
  jq -r '.modulePreloads[]?.href' "$page" >"$WORK/preloads.expected"
  : >"$WORK/scripts.found"
  : >"$WORK/preloads.found"
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    src="$(attr "$tag" src)"
    if [ -n "$src" ]; then printf '%s\n' "$src" >>"$WORK/scripts.found"; else inline=$((inline + 1)); fi
  done < <(tags "$html" script)
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    rel="$(attr "$tag" rel | tr '[:upper:]' '[:lower:]')"
    [ "$rel" != modulepreload ] || attr "$tag" href >>"$WORK/preloads.found"
  done < <(tags "$html" link)
  compare_lists "$p" script "$WORK/scripts.expected" "$WORK/scripts.found"
  [ "$inline" -eq 0 ] || problem "$p: $inline inline <script> element(s) (the inventory allows none)"
  compare_lists "$p" "module preload" "$WORK/preloads.expected" "$WORK/preloads.found"
}

compare_headers() { # path headers-file page-json
  local p="$1" page="$3" name expected lname values count value
  tr -d '\r' <"$2" >"$WORK/headers"
  while IFS=$'\t' read -r name expected; do
    if ! [[ "$name" =~ ^[A-Za-z0-9-]+$ ]]; then problem "the inventory names a header that is not a header name"; continue; fi
    lname="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
    values="$(awk -v n="$lname" 'index($0, ":") > 1 {
        k = tolower(substr($0, 1, index($0, ":") - 1)); v = substr($0, index($0, ":") + 1)
        sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v); if (k == n) print v }' "$WORK/headers")"
    count="$(printf '%s' "$values" | grep -c '' || true)"
    value="$(printf '%s\n' "$values" | head -n 1)"
    if [ "$expected" = "-" ]; then
      [ "$count" -eq 0 ] || problem "$p: header $name must not be sent, found: $(clean "$value")"
    elif [ "$count" -eq 0 ]; then
      problem "$p: header $name is missing"
      problem "  inventory: $(clean "${expected#=}")"
    elif [ "$count" -gt 1 ]; then
      problem "$p: header $name is sent $count times (the inventory has it once)"
    elif [ "$value" != "${expected#=}" ]; then
      problem "$p: header $name differs from the inventory"
      problem "  inventory: $(clean "${expected#=}")"
      problem "  page:      $(clean "$value")"
    fi
  done < <(jq -r '.headers // {} | to_entries[] | "\(.key)\t\(if .value == null then "-" else "=\(.value)" end)"' "$page")
}

check_files() { # what jq-filter page-json -> fetch every first-party file of the list and compare its SHA-256
  local what="$1" filter="$2" page="$3" src expected code found n=0
  while IFS=$'\t' read -r src expected; do
    n=$((n + 1))
    if ! [[ "$src" =~ ^/[A-Za-z0-9._~/-]+$ ]] || [ "${src#//}" != "$src" ] || ! [[ "$expected" =~ ^[0-9a-f]{64}$ ]]; then
      problem "the inventory lists a $what that is not a first-party path with a SHA-256: $(clean "$src")"
      continue
    fi
    code="$(fetch "$src" "$WORK/file$n")"
    if [ "$code" != 200 ]; then fetch_problem "$what" "$src" "$code" "$WORK/file$n"; continue; fi
    found="$(sha256sum <"$WORK/file$n.b" | cut -c1-64)"
    if [ "$found" != "$expected" ]; then
      problem "$what $src: its SHA-256 differs from the inventory (its content changed under the same name)"
      problem "  inventory: $expected"
      problem "  served:    $found"
    fi
  done < <(jq -r "$filter" "$page")
}

check_page() { # inventory dist-relative-file
  local inv="$1" file="$2" page="$WORK/page.json" path kind p code found expected i=0
  jq -c --arg f "$file" '[.pages[]? | select(.file == $f)] | first // empty' "$inv" >"$page" 2>/dev/null || : >"$page"
  path="$(jq -r '.path // empty' "$page" 2>/dev/null || true)"
  [ -n "$path" ] || path="/$file"
  kind="storefront page"
  if [ "$(jq -r '.payment // false' "$page" 2>/dev/null || true)" = true ] || [ ! -s "$page" ]; then kind="payment page"; fi
  begin_check "payment-page-$(slug "${file%.html}")" "$kind $(clean "$path")"
  if [ ! -s "$page" ]; then
    problem "/$file is not in $(show "$inv")"
    end_check
    return
  fi
  while IFS= read -r p; do
    if ! [[ "$p" =~ ^/[A-Za-z0-9._~/-]*$ ]]; then problem "the inventory lists a path that is not a path: $(clean "$p")"; continue; fi
    i=$((i + 1))
    code="$(fetch "$p" "$WORK/page$i")"
    if [ "$code" != 200 ]; then fetch_problem page "$p" "$code" "$WORK/page$i"; continue; fi
    [ "$i" -ne 1 ] || compare_scripts "$p" "$WORK/page$i.b" "$page"
    found="$(sha256sum <"$WORK/page$i.b" | cut -c1-64)"
    expected="$(jq -r '.sha256 // empty' "$page")"
    if [ "$found" != "$expected" ]; then
      problem "$p: the HTML differs from the inventory"
      problem "  inventory: $(clean "$expected")"
      problem "  served:    $found"
    fi
    compare_headers "$p" "$WORK/page$i.h" "$page"
  done < <(jq -r '.paths[]? // empty' "$page")
  [ "$i" -gt 0 ] || problem "the inventory lists no path for /$file"
  check_files script '.firstPartyScripts[]? | "\(.src)\t\(.sha256)"' "$page"
  check_files stylesheet '.stylesheets[]? | "\(.href)\t\(.sha256)"' "$page"
  end_check
}

check_payment_pages() {
  local inv="$CURRENT/storefront/payment-page-inventory.json" host scope file failed_before="$RUN_FAILED"
  if [ ! -f "$inv" ]; then
    warn "payment pages: $(show "$inv") does not exist (the current release has no inventory): check skipped until tomorrow"
    date -u +%F >"$STATE_DIR/payment-pages.day"
    return 0
  fi
  begin_check payment-inventory "payment page inventory"
  if ! jq -e --arg f "$INVENTORY_FORMAT" --argjson v "$INVENTORY_VERSION" \
    '.format == $f and .version == $v and (.pages | type == "array")' "$inv" >/dev/null 2>&1; then
    problem "$(show "$inv") is not an inventory of format $INVENTORY_FORMAT, version $INVENTORY_VERSION"
  fi
  end_check
  if [ -s "$WORK/problems" ]; then
    [ "$RUN_FAILED" != "$failed_before" ] || date -u +%F >"$STATE_DIR/payment-pages.day"
    return 0
  fi

  host="$(env_value "$ETC/healthcheck.env" HEALTHCHECK_STOREFRONT_HOST)"
  host="${host:-demo.$STOREFRONT_DOMAIN}"
  scope="$(env_value "$ETC/healthcheck.env" HEALTHCHECK_PAGES)"
  case "${scope:-payment}" in
    payment | all) scope="${scope:-payment}" ;;
    *) warn "HEALTHCHECK_PAGES must be payment or all, not $(clean "$scope"): the payment pages are checked"; scope=payment ;;
  esac
  if ! [[ "$host" =~ ^[A-Za-z0-9.-]+$ ]]; then
    begin_check payment-storefront "payment page storefront"
    problem "HEALTHCHECK_STOREFRONT_HOST is not a host name: $(clean "$host")"
    end_check
    return 0
  fi
  if [ -n "$STOREFRONT_URL" ]; then
    SF_ORIGIN="$STOREFRONT_URL"
    SF_CURL=()
  else
    # This VM's Caddy, with the real host name for SNI, the Host header and the certificate check.
    SF_ORIGIN="https://$host"
    SF_CURL=(--proto "=https" --resolve "$host:443:127.0.0.1")
  fi
  log "payment pages of $host ($scope) against $(show "$inv")"
  {
    printf '%s\n' "${PAYMENT_PAGES[@]}"
    if [ "$scope" = all ]; then jq -r '.pages[]?.file // empty' "$inv"; else jq -r '.pages[]? | select(.payment == true) | .file // empty' "$inv"; fi
  } | awk '!seen[$0]++' >"$WORK/pages"
  while IFS= read -r file; do
    if [[ "$file" =~ ^[A-Za-z0-9._/-]+\.html$ ]]; then
      check_page "$inv" "$file"
    else
      warn "the inventory lists a page that is not an HTML file: $(clean "$file")"
    fi
  done <"$WORK/pages"
  # A day is done once its alerts went out; when one could not be sent, the next run checks the pages again.
  [ "$RUN_FAILED" != "$failed_before" ] || date -u +%F >"$STATE_DIR/payment-pages.day"
}

# ---- run ---------------------------------------------------------------------------------------------------------
log "$NAME: release $(show "$(readlink -f "$CURRENT" 2>/dev/null || echo none)")"
check_units
check_disks
check_redis
check_backup
check_tls
if [ "$FORCE_PAYMENT" = 0 ] && [ "$(cat "$STATE_DIR/payment-pages.day" 2>/dev/null || true)" = "$(date -u +%F)" ]; then
  log "skip payment pages: checked today already (--payment-pages checks them now)"
elif deploy_running; then
  # A deploy switches `current` and may reload Caddy: the pages could be compared with another release's inventory.
  # The day stays open, so the first run after the deploy checks them.
  skip_check "payment pages" "velexis-deploy is running; the first run after it checks them"
else
  check_payment_pages
fi
exit "$RUN_FAILED"
