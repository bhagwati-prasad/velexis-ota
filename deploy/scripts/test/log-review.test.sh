#!/usr/bin/env bash
# =====================================================================================================
# log-review.test.sh — tests deploy/scripts/log-review.sh (velexis-logreview) without root, systemd, a journal or SMTP
# (task X-038).
#
#   bash deploy/scripts/test/log-review.test.sh
#
# Needs bash, jq 1.7, openssl, base64, flock, truncate and GNU coreutils (Linux: Ubuntu 24.04 like the VM). No root,
# no network; a few seconds.
#
# log-review.sh runs exactly as it is, with the test overrides of its header:
#   VELEXIS_ROOT   a temporary folder laid out like the VM: /var/lib/velexis (the state of velexis-shiplogs, its last
#                  success and failure, which the test sets for each run, and deploy-history), /var/log/velexis
#                  (security/ and provision.log), /var/log/aide/aide.log (AIDE's daily check, as dailyaidecheck of
#                  aide-common 0.18 writes it) and the home folders of the accounts with their authorized_keys
#   SHIP_LOGS      the real deploy/scripts/ship-logs.sh, which reads the entries through
#   JOURNALCTL     a fake journalctl over a fake journal export (JSON lines as `journalctl -o json` writes them):
#                  the entries after the cursor of --cursor-file (then the last one's cursor is written to it), or
#                  between --since and --until; without --all a field of 4096 bytes or more is null, as journalctl's
#                  JSON output makes it (the summary's 5xx on the airline-card route is such a long access line)
#   VELEXIS_ALERT  a stand-in for velexis-alert that records every `message <subject> <body>` (and refuses them all
#                  while the flag file alert-fails exists, as an SMTP outage would)
#   PASSWD_FILE    a passwd file with root, ubuntu, deploy and velexis-ota
#   REVIEW_NOW     the time of each run: the runs walk through a day, from 07:20 UTC of today to 06:20 of tomorrow
#
# Cases (docs/mvp/plans/foundation-tasks.md, X-038 steps 3 and 5 and its note of 2026-11-10; a check that proves an
# acceptance criterion ends in [X-038 AC<n>]):
#    1. a quiet first run at 07:20: no alert (the SSH keys it finds become the known ones), and one summary (AC3);
#    2. 29 refused outbound connections in an hour: no alert, and no second summary that day;
#    3. one of each critical event in an hour: a root login, a new key in an authorized_keys file and a login with an
#       unknown key, a change under /etc/velexis/keys (auditd), an AIDE change with no deploy since the previous check,
#       a failed log shipment, 30 refused outbound connections and a security log folder above 5 GB: exactly one
#       immediate alert for each kind, each in its own message, each also logged as a security event (AC3);
#    4. the next run repeats none of them; the shipment's and the folder's recoveries are one message each;
#    5. an AIDE change after a deploy is not alerted;
#    6. an alert that velexis-alert cannot send keeps every state (the cursor too) and fails the run; the next run sends
#       it once;
#    7. the next day: no summary before 06:00 UTC, then one at 06:20 that counts the day: accepted and refused SSH logins,
#       root logins, sudo and su, auditd events by watched key, AIDE, unit failures, the WAF's matches by rule and which
#       were refused (403), the airline-card route's 4xx and 5xx, refused outbound connections by destination and user,
#       fail2ban, the apps' security events and warnings; --summary sends one at once; --status;
#   and over the whole run: no summary or alert holds a value of a WAF line's query, or any [uri] (AC2, lead decision
#   (17i) of 2026-11-11).
#
# Settings (environment): LOG_REVIEW_TEST_TMPDIR (parent of the temporary folder; default TMPDIR or /tmp),
# LOG_REVIEW_TEST_KEEP=1 (keep the temporary folder: the VM tree, the alerts in fake/alerts/, every output in out/).
# =====================================================================================================
set -euo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVIEW="$(cd "$HERE/.." && pwd)/log-review.sh"
SHIP="$(cd "$HERE/.." && pwd)/ship-logs.sh"

FAILED=0
LOG_SHOWN=""
pass() { printf 'PASS %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*"
  FAILED=1
  if [ -n "${LAST_OUT:-}" ] && [ "$LOG_SHOWN" != "$LAST_OUT" ]; then
    LOG_SHOWN="$LAST_OUT"
    echo "     output of the last log-review.sh run ($(basename "$LAST_OUT"), exit $RC):"
    sed -e "s#$PREFIX#<tmp>#g" -e 's/^/       /' "$LAST_OUT"
    echo "     messages of that run:"
    new_subjects | sed 's/^/       /'
  fi
}
die() { printf 'FAIL %s\n' "$*"; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
check() { # description command... -> one PASS or FAIL line
  local what="$1"
  shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}
same() { # description got want
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got: $2, want: $3)"; fi
}
not() { ! "$@"; }

for tool in jq openssl base64 flock truncate sha256sum awk; do
  command -v "$tool" >/dev/null || die "$tool is missing"
done
if [ ! -f "$REVIEW" ] || [ ! -f "$SHIP" ]; then die "run it from a checkout of the repository"; fi

PREFIX="$(mktemp -d "${LOG_REVIEW_TEST_TMPDIR:-${TMPDIR:-/tmp}}/velexis-log-review-test.XXXXXX")"
PREFIX="$(cd "$PREFIX" && pwd -P)"
ROOT="$PREFIX/root"   # the VM
FAKE="$PREFIX/fake"   # the fake journal, the flags and the recorded alerts
FAKEBIN="$PREFIX/bin" # journalctl, velexis-alert
OUT="$PREFIX/out"     # every output of log-review.sh
LIB="$ROOT/var/lib/velexis"
STATE="$LIB/log-review"
SHIPSTATE="$LIB/ship-logs"
SECDIR="$ROOT/var/log/velexis/security"
AIDE_LOG="$ROOT/var/log/aide/aide.log"
mkdir -p "$ROOT/etc/velexis" "$SHIPSTATE" "$SECDIR" "$ROOT/var/log/aide" "$ROOT/root" "$ROOT/home/ubuntu/.ssh" \
  "$ROOT/home/deploy/.ssh" "$FAKE/alerts" "$FAKEBIN" "$OUT"
: >"$FAKE/journal.jsonl"
echo 0 >"$FAKE/alerts.count"

cleanup() {
  local rc=$?
  if [ "${LOG_REVIEW_TEST_KEEP:-0}" = 1 ]; then
    echo "LOG_REVIEW_TEST_KEEP=1: kept $PREFIX"
  else
    rm -rf --one-file-system "$PREFIX"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---- the stand-ins ------------------------------------------------------------------------------------------------
cat >"$FAKEBIN/journalctl" <<'SH'
#!/usr/bin/env bash
# Fake journalctl: the entries of $FAKE_STATE/journal.jsonl after the cursor of --cursor-file (then the last entry's
# cursor is written to it), filtered by --since/--until (@epoch). Without --all, a field of 4096 bytes or more (its
# name, "=" and its value) comes out as null, as journalctl's JSON output does.
set -euo pipefail
cursor_file="" since="" until="" all=false
for a in "$@"; do
  case "$a" in
    --system | --quiet | --no-pager | --output=json) ;;
    --all) all=true ;;
    --cursor-file=*) cursor_file="${a#*=}" ;;
    --since=@*) since="${a#--since=@}" ;;
    --until=@*) until="${a#--until=@}" ;;
    *) echo "fake journalctl: unexpected argument $a" >&2; exit 2 ;;
  esac
done
after=""
if [ -n "$cursor_file" ] && [ -s "$cursor_file" ]; then after="$(cat "$cursor_file")"; since=""; fi
out="$(mktemp "$FAKE_STATE/journalctl.XXXXXX")"
jq -c -n --arg after "$after" --arg since "$since" --arg until "$until" --argjson showall "$all" '
  [inputs] as $all
  | (if $after == "" then $all else (($all | map(.__CURSOR) | index($after)) as $i
      | if $i == null then $all else $all[$i + 1:] end) end)
  | .[]
  | select($since == "" or (.__REALTIME_TIMESTAMP | tonumber) >= ($since | tonumber) * 1000000)
  | select($until == "" or (.__REALTIME_TIMESTAMP | tonumber) <= ($until | tonumber) * 1000000)
  | if $showall then . else with_entries(if (.value | type) == "string"
      and (.key | utf8bytelength) + 1 + (.value | utf8bytelength) >= 4096 then .value = null else . end) end' \
  "$FAKE_STATE/journal.jsonl" >"$out"
cat "$out"
if [ -n "$cursor_file" ] && [ -s "$out" ]; then tail -n 1 "$out" | jq -r .__CURSOR >"$cursor_file"; fi
rm -f "$out"
SH
cat >"$FAKEBIN/velexis-alert" <<'SH'
#!/usr/bin/env bash
# velexis-alert stand-in: records `message <subject> <body-file>`; refuses while $FAKE_STATE/alert-fails exists.
set -euo pipefail
[ "${1:-}" = message ] && [ $# -eq 3 ] || { echo "fake velexis-alert: unexpected arguments: $*" >&2; exit 2; }
if [ -e "$FAKE_STATE/alert-fails" ]; then echo "fake velexis-alert: SMTP is down" >&2; exit 1; fi
n=$(($(cat "$FAKE_STATE/alerts.count") + 1))
printf '%s\n' "$2" >"$FAKE_STATE/alerts/$n.subject"
cat "$3" >"$FAKE_STATE/alerts/$n.body"
echo "$n" >"$FAKE_STATE/alerts.count"
SH
chmod +x "$FAKEBIN/journalctl" "$FAKEBIN/velexis-alert"
cat >"$PREFIX/passwd" <<'PW'
root:x:0:0:root:/root:/bin/bash
ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash
deploy:x:999:999::/home/deploy:/usr/sbin/nologin
velexis-ota:x:998:998::/nonexistent:/usr/sbin/nologin
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin
PW

N=0
RUN=0
RC=0
SEEN=0 # messages before the last run
run_review() { # epoch [args...] -> RC, LAST_OUT; the messages of the run are those after SEEN
  local at="$1"
  shift
  RUN=$((RUN + 1))
  LAST_OUT="$OUT/run-$RUN.out"
  SEEN="$(cat "$FAKE/alerts.count")"
  RC=0
  env VELEXIS_ROOT="$ROOT" VELEXIS_ALERT="$FAKEBIN/velexis-alert" SHIP_LOGS="$SHIP" JOURNALCTL="$FAKEBIN/journalctl" \
    PASSWD_FILE="$PREFIX/passwd" REVIEW_NOW="$at" FAKE_STATE="$FAKE" bash "$REVIEW" "$@" >"$LAST_OUT" 2>&1 || RC=$?
}
new_count() { echo $(($(cat "$FAKE/alerts.count") - SEEN)); }
new_subjects() { local i; for ((i = SEEN + 1; i <= $(cat "$FAKE/alerts.count"); i++)); do cat "$FAKE/alerts/$i.subject"; done; }
body_of() { # subject prefix -> the body of the run's message with that subject
  local i
  for ((i = SEEN + 1; i <= $(cat "$FAKE/alerts.count"); i++)); do
    case "$(cat "$FAKE/alerts/$i.subject")" in "$1"*) cat "$FAKE/alerts/$i.body"; return 0 ;; esac
  done
  return 1
}
body_has() { body_of "$1" | grep -qF -- "$2"; } # subject-prefix text
add_entry() { # epoch json-object: one journal entry with the next cursor
  N=$((N + 1))
  jq -c --arg c "c$N" --arg rt "$(($1 * 1000000 + 250000))" \
    '{__CURSOR: $c, __REALTIME_TIMESTAMP: $rt, _HOSTNAME: "vm-test", _PID: "4242", _UID: "0"} + .' <<<"$2" \
    >>"$FAKE/journal.jsonl"
}
plain() { # unit identifier priority transport message -> json object
  jq -nc --arg u "$1" --arg i "$2" --arg p "$3" --arg t "$4" --arg m "$5" \
    '{PRIORITY: $p, _TRANSPORT: $t, MESSAGE: $m} + (if $u == "" then {} else {_SYSTEMD_UNIT: $u} end)
     + (if $i == "" then {} else {SYSLOG_IDENTIFIER: $i} end)'
}
sshd() { plain ssh.service sshd 6 syslog "$1"; }
egress_line() { plain "" kernel 4 kernel "VELEXIS-EGRESS-DENY IN= OUT=eth0 SRC=10.0.0.5 DST=$1 LEN=60 PROTO=TCP SPT=40000 DPT=$2 UID=$3 GID=$3"; }
waf_line() { # client uri(Go-quoted) unique-id rule-id rule-message -> Caddy's WAF line
  jq -nc --arg msg "[client \"$1\"] Coraza: Warning. $5 [file \"@owasp_crs/REQUEST-9.conf\"] [line \"1\"] [id \"$4\"] [rev \"\"] [msg \"$5\"] [data \"ARGS:q\"] [severity \"critical\"] [ver \"OWASP_CRS/4.7.0\"] [maturity \"0\"] [accuracy \"0\"] [tag \"attack\"] [hostname \"\"] [uri \"$2\"] [unique_id \"$3\"]" \
    '{level: "error", ts: 1794510757.5, logger: "http.handlers.waf", msg: $msg} | tojson' | jq -r .
}
access_line() { # client uri status [user-agent]
  jq -nc --arg c "$1" --arg u "$2" --argjson s "$3" --arg ua "${4:-Mozilla/5.0}" \
    '{level: "info", ts: 1794510757.6, logger: "http.log.access.log1", msg: "handled request", request: {client_ip: $c, method: "POST", host: "acme.ota.example.com", uri: $u, headers: {"User-Agent": [$ua]}}, status: $s} | tojson' | jq -r .
}
new_key() { head -c 51 /dev/urandom | base64 -w0; }
fp_of() { printf 'SHA256:%s' "$(printf '%s' "$1" | base64 -d | openssl dgst -sha256 -binary | base64 -w0 | tr -d '=')"; }
shipped_ok() { printf '%s 12 security-x.jsonl.zst.age\n' "$(($1 - 600))" >"$SHIPSTATE/last-success"; rm -f "$SHIPSTATE/last-failure"; }
aide_report() { # "YYYY-MM-DD HH:MM:SS" exit-code [kind path]... -> AIDE's log as dailyaidecheck writes it
  local start="$1" code="$2"
  shift 2
  {
    printf 'aide run on vm-test.example.com started at %s.\n' "$start"
    if [ "$code" = 0 ]; then
      printf 'AIDE returned with a zero exit code. No changes detected!\n\nAIDE produced no errors.\nAIDE detected no changes.\n\n'
    else
      printf 'AIDE returned with exit code %s. Changed entries detected!\n\nAIDE produced no errors.\n' "$code"
      printf 'AIDE output (40 lines):\nbegin timestamp %s\nStart timestamp: %s +0000 (AIDE 0.18.6)\n' "$start" "$start"
      printf 'AIDE found differences between database and filesystem!!\n\nSummary:\n  Total number of entries:\t4242\n'
      printf '  Added entries:\t\t0\n  Removed entries:\t\t0\n  Changed entries:\t\t%s\n\n' "$(($# / 2))"
      printf -- '---------------------------------------------------\nChanged entries:\n'
      printf -- '---------------------------------------------------\n\n'
      while [ $# -ge 2 ]; do printf 'f   ...    .C... : %s\n' "$2"; shift 2; done
      printf -- '\n---------------------------------------------------\nDetailed information about changes:\n'
      printf -- '---------------------------------------------------\n\nFile: /etc/hosts\n  SHA256    : a | b\n'
      printf 'End of AIDE output.\n\n'
    fi
    printf 'End of AIDE daily aide check at %s, run time 42 seconds\n' "${start%:*}"
  } >"$AIDE_LOG"
}

TODAY="$(date -u +%F)"
TOMORROW="$(date -u -d "$TODAY +1 day" +%F)"
T0="$(date -u -d "$TODAY 07:20:00" +%s)" # the first run: 07:20 UTC today
H=3600
MARK="x038$(od -An -tx1 -N6 /dev/urandom | tr -d ' \n')" # in every WAF query value: must never reach a message
K1="$(new_key)"
K2="$(new_key)"
K3="$(new_key)"
K4="$(new_key)"
printf 'ssh-ed25519 %s ubuntu@laptop\n' "$K1" >"$ROOT/home/ubuntu/.ssh/authorized_keys"
printf 'restrict ssh-ed25519 %s github-actions-deploy\n' "$K2" >"$ROOT/home/deploy/.ssh/authorized_keys"
printf '%s deploy-1111111\n' "$(date -u -d "$TODAY 01:00:00" +%Y-%m-%dT%H:%M:%SZ)" >"$LIB/deploy-history"
printf '%s provision-vm.sh started by ubuntu: steps scripts, deploy folder /tmp/d\n' \
  "$(date -u -d "$TODAY 00:30:00" +%Y-%m-%dT%H:%M:%SZ)" >"$ROOT/var/log/velexis/provision.log"
printf '{}\n' >"$SECDIR/security-$TODAY.jsonl.zst"
aide_report "$TODAY 02:13:14" 0

# ---- 1. a quiet first run ------------------------------------------------------------------------------------------
step "A quiet first run at 07:20 UTC: no alert, one summary [X-038 AC3]"
add_entry $((T0 - 2 * H)) "$(sshd "Accepted publickey for ubuntu from 203.0.113.9 port 49999 ssh2: ED25519 $(fp_of "$K1")")"
add_entry $((T0 - 1800)) "$(sshd "Accepted publickey for ubuntu from 203.0.113.10 port 50000 ssh2: ED25519 $(fp_of "$K1")")"
add_entry $((T0 - 1700)) "$(plain velexis-ota-api.service velexis-ota-api 6 stdout '{"level":30,"msg":"request completed"}')"
add_entry $((T0 - 1600)) "$(plain caddy.service caddy 6 stdout "$(access_line 203.0.113.10 /api/v1/offers 200)")"
shipped_ok "$T0"
run_review "$T0"
same "the first run succeeds" "$RC" 0
same "a quiet day: exactly one message, the summary [X-038 AC3]" "$(new_count)" 1
is_summary_of() { [[ "$(new_subjects)" == "security log review $1: "* ]]; }
check "it is the daily summary of today [X-038 AC3]" is_summary_of "$TODAY"
check "the summary counts the accepted SSH login of the last 24 hours by user, source and method [X-038 AC3]" \
  body_has "security log review" "  1  ubuntu from 203.0.113.9 by publickey"
check "and the one of the last hour" body_has "security log review" "  1  ubuntu from 203.0.113.10 by publickey"
quiet_sections() { # every section of the summary, with none or 0
  local b s
  b="$(body_of "security log review")"
  for s in "Root logins: 0" "sudo commands (count, user: command):" "sudo refusals: 0" "auditd events by watched key" \
    "  0  velexis-keys" "  0  sudoers" "AIDE: last check ${TODAY}T02:13:14Z: no changes" "Unit failures (count, unit):" \
    "Web application firewall: 0 request(s) matched a rule, 0 refused" "Airline-card route" \
    "Refused outbound connections (VELEXIS-EGRESS-DENY, at most 10 a minute are logged): 0" "fail2ban bans" \
    "Security events of the apps" "Log shipment: last verified shipment" "Immediate alerts of this run: 0"; do
    grep -qF -- "$s" <<<"$b" || { echo "     missing: $s"; return 1; }
  done
}
check "the summary has every section, with none or 0 on a quiet day [X-038 AC3]" quiet_sections
check "the first run records the SSH keys it finds as known (no alert)" test "$(wc -l <"$STATE/ssh-keys")" -eq 2
check "the run logs the summary as a security event" grep -qF '{"security":true,"event":"log_review.summary","day":"'"$TODAY"'"}' "$LAST_OUT"

# ---- 2. below the burst threshold ----------------------------------------------------------------------------------
step "08:20: 29 refused outbound connections, nothing else"
for i in $(seq 1 29); do add_entry $((T0 + 1800 + i)) "$(egress_line 93.184.216.34 443 998)"; done
shipped_ok $((T0 + H))
run_review $((T0 + H))
same "no message: 29 refusals are no burst, and today's summary was sent" "$RC $(new_count)" "0 0"

# ---- 3. one of each critical event -----------------------------------------------------------------------------------
step "09:20: one of each critical event, one immediate alert each [X-038 AC3]"
add_entry $((T0 + H + 1800)) "$(sshd "Accepted publickey for root from 192.0.2.50 port 51000 ssh2: ED25519 $(fp_of "$K1")")"
printf 'ssh-ed25519 %s someone@else\n' "$K3" >>"$ROOT/home/ubuntu/.ssh/authorized_keys"
add_entry $((T0 + H + 1810)) "$(sshd "Accepted publickey for deploy from 192.0.2.60 port 51001 ssh2: ED25519 $(fp_of "$K4")")"
add_entry $((T0 + H + 1820)) "$(plain auditd.service audisp-syslog 6 syslog 'type=SYSCALL msg=audit(1794510757.370:777): arch=c000003e syscall=257 success=yes exit=3 auid=1000 uid=0 tty=pts0 comm="cp" exe="/usr/bin/cp" key="velexis-keys"')"
add_entry $((T0 + H + 1820)) "$(plain auditd.service audisp-syslog 6 syslog 'type=PATH msg=audit(1794510757.370:777): item=1 name="/etc/velexis/keys/ota/master-v9.key" nametype=CREATE')"
add_entry $((T0 + H + 1821)) "$(plain auditd.service audisp-syslog 6 syslog 'type=SYSCALL msg=audit(1794510757.400:778): arch=c000003e syscall=257 success=yes comm="vi" exe="/usr/bin/vim.basic" key="velexis-config"')"
aide_report "$TODAY 08:50:00" 4 changed /etc/ssh/sshd_config.d/00-velexis.conf
printf '%s 3 security-y.jsonl.zst.age\n' $((T0 + 2 * H - 900)) >"$SHIPSTATE/last-success"
printf '%s the upload of security-z.jsonl.zst.age (40 entries) to offsite:b/logs failed\n' $((T0 + 2 * H - 300)) \
  >"$SHIPSTATE/last-failure"
for i in $(seq 1 30); do add_entry $((T0 + H + 1900 + i)) "$(egress_line 203.0.113.99 8443 998)"; done
truncate -s 6G "$SECDIR/big.sparse"
run_review $((T0 + 2 * H))
same "the run succeeds" "$RC" 0
same "seven messages, one per kind of event, no summary [X-038 AC3]" "$(new_count)" 7
same "their subjects [X-038 AC3]" "$(new_subjects | LC_ALL=C sort | paste -sd'|' -)" \
  "security alert: AIDE found changes outside a deploy|security alert: burst of refused outbound connections|security alert: change under /etc/velexis/keys|security alert: log shipment failing|security alert: new SSH key|security alert: root login|security alert: security log folder above 5 GB"
check "root login: the line with its source [X-038 AC3]" body_has "security alert: root login" "Accepted publickey for root from 192.0.2.50 port 51000"
check "new SSH key: the key added to ubuntu's authorized_keys [X-038 AC3]" \
  body_has "security alert: new SSH key" "$(fp_of "$K3") ssh-ed25519 in /home/ubuntu/.ssh/authorized_keys (account ubuntu)"
check "new SSH key: the login with a key never seen [X-038 AC3]" \
  body_has "security alert: new SSH key" "$(fp_of "$K4") ED25519 used to log in as deploy from 192.0.2.60"
check "new SSH key: not the known key root used [X-038 AC3]" not body_has "security alert: new SSH key" "$(fp_of "$K1")"
check "keys change: the event, its command and its path [X-038 AC3]" \
  body_has "security alert: change under" 'audit event 777: comm="cp" exe="/usr/bin/cp" auid=1000 uid=0 paths: "/etc/velexis/keys/ota/master-v9.key"'
check "keys change: only the velexis-keys event [X-038 AC3]" not body_has "security alert: change under" "event 778"
check "AIDE: the new change, no deploy since the previous check [X-038 AC3]" \
  body_has "security alert: AIDE" "changed /etc/ssh/sshd_config.d/00-velexis.conf"
check "shipment: why it fails [X-038 AC3]" body_has "security alert: log shipment" "the last run failed at"
check "egress burst: the destination and the user by name [X-038 AC3]" \
  body_has "security alert: burst" "30 203.0.113.99:8443/TCP by velexis-ota"
check "folder size: the folder [X-038 AC3]" body_has "security alert: security log folder" "/var/log/velexis/security holds"
same "each alert is logged as a security event [X-038 AC3]" \
  "$(grep -c '^{"security":true,"event":"log_review.alert","kind":' "$LAST_OUT")" 7

# ---- 4. no repeats, recoveries ----------------------------------------------------------------------------------------
step "10:20: nothing new: no alert is repeated; then the recoveries"
run_review $((T0 + 3 * H))
same "no message: the shipment and the folder still fail, but were alerted already" "$RC $(new_count)" "0 0"
shipped_ok $((T0 + 4 * H))
mv "$SECDIR/big.sparse" "$PREFIX/big.sparse"
run_review $((T0 + 4 * H))
same "two recoveries, one message each" "$(new_subjects | LC_ALL=C sort | paste -sd'|' -)" \
  "security log folder back below 5 GB|security log shipment recovered"

# ---- 5. AIDE after a deploy -------------------------------------------------------------------------------------------
step "An AIDE change after a deploy is expected"
printf '%s deploy-2222222\n' "$(date -u -d "$TODAY 10:30:00" +%Y-%m-%dT%H:%M:%SZ)" >>"$LIB/deploy-history"
aide_report "$TODAY 11:00:00" 4 changed /etc/ssh/sshd_config.d/00-velexis.conf changed /etc/systemd/system/velexis-ota-api.service
shipped_ok $((T0 + 5 * H))
run_review $((T0 + 5 * H))
same "no message for the deploy's change" "$RC $(new_count)" "0 0"
run_review $((T0 + 5 * H)) --status
status_shows() {
  grep -q "^aide-check *run ${TODAY}T11:00:00Z" "$LAST_OUT" && grep -q "^shipment *ok" "$LAST_OUT" &&
    grep -q "^summary-day *$TODAY" "$LAST_OUT"
}
check "--status shows the AIDE check reviewed and the states" status_shows

# ---- 6. an alert that cannot be sent ---------------------------------------------------------------------------------
step "An alert that cannot be sent is sent by the next run, once"
add_entry $((T0 + 5 * H + 600)) "$(sshd "Accepted publickey for root from 192.0.2.51 port 51010 ssh2: ED25519 $(fp_of "$K1")")"
CURSOR_BEFORE="$(cat "$STATE/cursor")"
touch "$FAKE/alert-fails"
shipped_ok $((T0 + 6 * H))
run_review $((T0 + 6 * H))
same "the run fails (exit 1, OnFailure= reports the unit)" "$RC" 1
same "the cursor stays" "$(cat "$STATE/cursor")" "$CURSOR_BEFORE"
rm -f "$FAKE/alert-fails"
shipped_ok $((T0 + 7 * H))
run_review $((T0 + 7 * H))
same "the next run sends the root login alert" "$RC $(new_subjects)" "0 security alert: root login"
check "for that login" body_has "security alert: root login" "from 192.0.2.51 port 51010"
shipped_ok $((T0 + 8 * H))
run_review $((T0 + 8 * H))
same "and the run after it sends nothing" "$RC $(new_count)" "0 0"

# ---- 7. the next day's summary ----------------------------------------------------------------------------------------
step "The next day's summary counts the day [X-038 AC3]; never a [uri] or a value of its query [X-038 AC2]"
D=$((T0 + 9 * H)) # 16:20
add_entry $((D + 1)) "$(sshd "Invalid user admin from 198.51.100.7 port 41000")"
add_entry $((D + 2)) "$(sshd "Connection closed by authenticating user admin 198.51.100.7 port 41001 [preauth]")"
add_entry $((D + 3)) "$(plain "" sudo 5 syslog "ubuntu : TTY=pts/0 ; PWD=/home/ubuntu ; USER=root ; COMMAND=/usr/bin/systemctl restart caddy")"
add_entry $((D + 4)) "$(plain "" sudo 1 syslog "mallory : 3 incorrect password attempts ; TTY=pts/1 ; PWD=/ ; USER=root ; COMMAND=/bin/sh")"
add_entry $((D + 5)) "$(plain "" su 5 syslog "(to root) ubuntu on pts/0")"
add_entry $((D + 6)) "$(plain fail2ban.service fail2ban-server 5 stdout "NOTICE  [sshd] Ban 198.51.100.7")"
add_entry $((D + 7)) '{"_PID":"1","SYSLOG_IDENTIFIER":"systemd","PRIORITY":"4","_TRANSPORT":"journal","MESSAGE":"velexis-ota-worker.service: Failed with result '"'"'exit-code'"'"'."}'
add_entry $((D + 8)) "$(plain velexis-platform-api.service velexis-platform-api 6 stdout '{"level":30,"securityEvent":"stripe.webhook_signature_invalid"}')"
add_entry $((D + 9)) "$(plain velexis-ota-api.service velexis-ota-api 6 stdout '{"level":50,"msg":"amadeus.unavailable"}')"
add_entry $((D + 10)) "$(plain caddy.service caddy 3 stdout "$(waf_line 198.51.100.23 "/api/x?id=1%27%20OR%20%271%27%3D%271&sig=SIG$MARK&token=TOK$MARK" UA 942100 "SQL Injection Attack Detected via libinjection")")"
add_entry $((D + 11)) "$(plain caddy.service caddy 6 stdout "$(access_line 198.51.100.23 "/api/x?id=1" 403)")"
add_entry $((D + 20)) "$(plain caddy.service caddy 3 stdout "$(waf_line 198.51.100.24 "/portal/search?q=%3Cscript%3E$MARK&client_secret=CS$MARK" UB 942100 "SQL Injection Attack Detected via libinjection")")"
add_entry $((D + 20)) "$(plain caddy.service caddy 3 stdout "$(waf_line 198.51.100.24 "/portal/search?q=%3Cscript%3E$MARK&client_secret=CS$MARK" UB 941100 "XSS Attack Detected via libinjection")")"
add_entry $((D + 21)) "$(plain caddy.service caddy 6 stdout "$(access_line 198.51.100.24 "/portal/search" 200)")"
add_entry $((D + 30)) "$(plain caddy.service caddy 6 stdout "$(access_line 198.51.100.30 /api/v1/checkouts/ck_1/airline-card-completion 200)")"
add_entry $((D + 31)) "$(plain caddy.service caddy 6 stdout "$(access_line 198.51.100.30 /api/v1/checkouts/ck_2/airline-card-completion 422)")"
# An access line above 4096 bytes (a long User-Agent): journalctl's JSON output would make it null without --all.
add_entry $((D + 32)) "$(plain caddy.service caddy 6 stdout "$(access_line 198.51.100.30 /v1/checkouts/ck_3/airline-card-completion 502 "$(head -c 4300 /dev/zero | tr '\0' U)")")"
shipped_ok $((T0 + 22 * H))
run_review $((T0 + 22 * H)) # 05:20 tomorrow
same "05:20 the next day: no summary yet (and no alert for these entries)" "$RC $(new_count)" "0 0"
shipped_ok $((T0 + 23 * H))
run_review $((T0 + 23 * H)) # 06:20 tomorrow
same "06:20: exactly one message, the summary [X-038 AC3]" "$RC $(new_count)" "0 1"
SUMMARY="$(body_of "security log review $TOMORROW: ")"
printf '%s\n' "$SUMMARY" >"$OUT/summary-day2.txt"
summary_has() { grep -qxF -- "$1" <<<"$SUMMARY"; }
for line in \
  "  1  ubuntu from 203.0.113.10 by publickey" \
  "  1  root from 192.0.2.50 by publickey" \
  "  1  deploy from 192.0.2.60 by publickey" \
  "  2  admin from 198.51.100.7" \
  "Root logins: 2" \
  "  1  ubuntu: /usr/bin/systemctl restart caddy" \
  "sudo refusals: 1" \
  "  1  ubuntu to root" \
  "  1  velexis-config" \
  "  1  velexis-keys" \
  "  0  sudoers" \
  "  1  velexis-ota-worker.service" \
  "Web application firewall: 2 request(s) matched a rule, 1 refused with 403 (count matched, refused, rule):" \
  "  2  1  942100 SQL Injection Attack Detected via libinjection" \
  "  1  0  941100 XSS Attack Detected via libinjection" \
  "Airline-card route (/v1/checkouts/{id}/airline-card-completion): 3 request(s), 1 4xx, 1 5xx" \
  "Refused outbound connections (VELEXIS-EGRESS-DENY, at most 10 a minute are logged): 59 (count, destination, user):" \
  "  30  203.0.113.99:8443/TCP by velexis-ota" \
  "  29  93.184.216.34:443/TCP by velexis-ota" \
  "  1  198.51.100.7" \
  "  1  stripe.webhook_signature_invalid (velexis-platform-api.service)" \
  "  1  velexis-ota-api.service"; do
  check "the summary lists: $line [X-038 AC3]" summary_has "$line"
done
check "the summary's AIDE line names the last check [X-038 AC3]" grep -q "^AIDE: last check ${TODAY}T11:00:00Z: 2 change(s)" <<<"$SUMMARY"
same "summary-day is tomorrow" "$(cat "$STATE/summary-day")" "$TOMORROW"
shipped_ok $((T0 + 24 * H))
run_review $((T0 + 24 * H))
same "07:20: no second summary that day" "$RC $(new_count)" "0 0"
run_review $((T0 + 24 * H)) --summary
same "--summary sends one at once" "$RC $(new_count)" "0 1"

step "Over the whole run"
ALL="$(cat "$FAKE"/alerts/*.subject "$FAKE"/alerts/*.body)"
check "messages were sent ($(cat "$FAKE/alerts.count"))" test "$(cat "$FAKE/alerts.count")" -ge 13
check "no message holds a value of a WAF line's query [X-038 AC2]" not grep -qF "$MARK" <<<"$ALL"
check "no message quotes a [uri] [X-038 AC2]" not grep -qF '[uri' <<<"$ALL"
check "no state file of the review holds one either [X-038 AC2]" not grep -rqF "$MARK" "$STATE"
check "(the fake journal holds them: the residual that stays in journald)" grep -qF "SIG$MARK" "$FAKE/journal.jsonl"
check "the review's state is root-only (0700)" test "$(stat -c %a "$STATE")" = 700

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "log-review.test.sh: FAILED"
  exit 1
fi
echo
echo "log-review.test.sh: all checks passed"
