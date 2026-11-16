#!/usr/bin/env bash
# =====================================================================================================
# log-review.test.sh — tests deploy/scripts/log-review.sh (velexis-logreview) without root, systemd, a journal or SMTP
# (tasks X-038, X-044 and X-045, and lead decision (25g) of 2026-11-16).
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
#                  aide-common 0.18 writes it, with AIDE 0.18.6's report in the layout the real binary prints: the
#                  added and changed entries, then each one's detail, its values cut into 32-byte pieces) and the home
#                  folders of the accounts with their authorized_keys
#   SHIP_LOGS      the real deploy/scripts/ship-logs.sh, which reads the entries through
#   JOURNALCTL     a fake journalctl over a fake journal export (JSON lines as `journalctl -o json` writes them):
#                  the entries after the cursor of --cursor-file (then the last one's cursor is written to it), or
#                  between --since and --until; without --all a field of 4096 bytes or more is null, as journalctl's
#                  JSON output makes it (the summary's 5xx on the airline-card route is such a long access line)
#   VELEXIS_ALERT  a stand-in for velexis-alert that records every `message <subject> <body>` (and refuses them all
#                  while the flag file alert-fails exists, as an SMTP outage would)
#   SYSTEMCTL      a stand-in for systemctl that answers `is-active` and `is-enabled` of dailyaidecheck.timer from the
#                  file fake/timer ("active enabled" unless a case changes it), with systemctl's exit codes, and refuses
#                  every other call
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
#    8. AIDE entries that change again (task X-044, its checks end in [X-044 AC<n>]), one report a day: the first run
#       after the upgrade reads X-038's state file (entries only) without an alert and keeps each entry's detail; a file
#       a deploy changed, listed again unchanged, raises nothing; the same file changed again outside a deploy (new
#       hashes) raises aide-change, naming what differs, once; a directory whose only new detail is its times follows
#       the same rule; changes after a later deploy raise nothing, and the day after neither; an added entry, which
#       AIDE details with report_level=added_removed_entries (its new values alone), is compared the same way;
#    9. AIDE's own baseline (task X-045, lead decision (24c) of 2026-11-15; its checks end in [X-045 AC<n>]), with AIDE's
#       logs in the layouts aide-common 0.18.6's dailyaidecheck writes (checked with the Ubuntu package's binary and
#       script): a daily check without a database ("database not present.", no exit code) after a deploy and a
#       provisioning run raises aide-error once, with dailyaidecheck's reason and script error, and the summary's AIDE
#       line names it; a check that AIDE ended with the error exit code 17 (its line inside dailyaidecheck's frame of
#       asterisks) raises it with AIDE's error output; neither changes the review's AIDE state, so the next check with a
#       result is compared with the last one that had a result (nothing new: no alert; a change the day after: the
#       aide-change alert); the summary counts the auditd key velexis-aide and lists its events on aide.db, the
#       re-baseline record and other paths (relative names too), not those on the daily check's own work files
#       (aide.db.new, dailyaidecheck/, and its rm -rf of that folder, logged with bare file names and rm's working
#       folder as the PARENT item);
#   10. AIDE's daily check overdue or switched off (lead decision (25g) of 2026-11-16, a fix under X-045; its checks end
#       in [FIX-W56-SHARED 25g]), with AIDE 0.18.6's report in the layout of case 8: a fresh report and an active,
#       enabled timer raise nothing, also when the report is exactly 27 hours old; at 28 hours one aide-stale alert
#       names the report, and the day's summary says so; the same report raises nothing again; a newer report is one
#       recovery message; a timer that is not active, then active but not enabled, raises aide-stale for each, once,
#       and the timer active and enabled again is one recovery message; no report at all raises it once 27 hours after
#       the step harden first completed (provision-vm.sh's record), and at once without that record; a newer report
#       that is late as well, while the older one's alert is still open, is one new aide-stale alert;
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
cat >"$FAKEBIN/systemctl" <<'SH'
#!/usr/bin/env bash
# systemctl stand-in: is-active and is-enabled of dailyaidecheck.timer, from $FAKE_STATE/timer ("<active> <enabled>"),
# with systemctl's exit codes (0 for active or enabled, else 3 or 1); every other call is refused.
set -euo pipefail
read -r active enabled <"$FAKE_STATE/timer"
printf '%s\n' "$*" >>"$FAKE_STATE/systemctl.calls"
case "$*" in
  "is-active dailyaidecheck.timer") echo "$active"; [ "$active" = active ] || exit 3 ;;
  "is-enabled dailyaidecheck.timer") echo "$enabled"; [ "$enabled" = enabled ] || exit 1 ;;
  *) echo "fake systemctl: unexpected arguments: $*" >&2; exit 2 ;;
esac
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
chmod +x "$FAKEBIN/journalctl" "$FAKEBIN/systemctl" "$FAKEBIN/velexis-alert"
echo "active enabled" >"$FAKE/timer"
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
    SYSTEMCTL="$FAKEBIN/systemctl" PASSWD_FILE="$PREFIX/passwd" REVIEW_NOW="$at" FAKE_STATE="$FAKE" bash "$REVIEW" "$@" \
    >"$LAST_OUT" 2>&1 || RC=$?
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
aide_attr() { # name old new -> one attribute of AIDE 0.18.6's "Detailed information about changes", as its
  # report_plain.c prints it: ` %-10s%c %-33.32s| %.32s`, each value cut into 32-byte pieces on the lines below
  local name="$1" old="$2" new="$3" k=0 c
  while [ $((${#old} - 33 * k)) -ge 0 ] || [ $((${#new} - 33 * k)) -ge 0 ]; do
    c=$((k * 32))
    if [ "$k" = 0 ]; then
      printf ' %-10s: %-33.32s| %.32s\n' "$name" "${old:c}" "${new:c}"
    else
      printf ' %-10s  %-33.32s| %.32s\n' "" "${old:c}" "${new:c}"
    fi
    k=$((k + 1))
  done
}
aide_attr_new() { # name value... -> one attribute of an added entry, which AIDE 0.18.6 details only with
  # report_level=added_removed_entries: no old value, ` %-10s%c %-33c  %.32s`, each value cut into 32-byte pieces, a
  # second value (an ACL's next line) on lines of its own with no name
  local name="$1" v i=0 k c
  shift
  for v in "$@"; do
    k=0
    while [ $((${#v} - 33 * k)) -ge 0 ]; do
      c=$((k * 32))
      if [ $((i + k)) = 0 ]; then
        printf ' %-10s: %-33s  %.32s\n' "$name" "" "${v:c}"
      else
        printf ' %-10s  %-33s  %.32s\n' "" "" "${v:c}"
      fi
      k=$((k + 1))
    done
    i=$((i + 1))
  done
}
aide_time() { date -u -d "@$(($(date -u -d "$TODAY" +%s) - 30 * 86400 + $1 * 86400))" '+%Y-%m-%d %H:%M:%S +0000'; }
aide_hash() { printf '%s %s' "$2" "$3" | openssl dgst "-$1" -binary | base64 -w0; } # algorithm path version
aide_detail() { # f|d|t|a path version -> the path's block of the detailed section (a file, a directory, a file only
  # touched, as systemd touches a timer's stamp file, or an added file: its new values alone); version 0 is AIDE's
  # database
  local p="$2" v="$3"
  echo
  if [ "$1" = a ]; then
    printf 'File: %s\n' "$p"
    aide_attr_new 'File type' File
    aide_attr_new Size "$((1200 + v))"
    aide_attr_new Perm -rwxr-xr-x
    aide_attr_new Uid 0
    aide_attr_new Gid 0
    aide_attr_new Mtime "$(aide_time "$v")"
    aide_attr_new Ctime "$(aide_time "$v")"
    aide_attr_new Inode 4242
    aide_attr_new Linkcount 1
    aide_attr_new SHA256 "$(aide_hash sha256 "$p" "$v")"
    aide_attr_new SHA512 "$(aide_hash sha512 "$p" "$v")"
    aide_attr_new ACL 'A: user::rwx' 'A: group::r-x' 'A: other::r-x'
    aide_attr_new XAttrs num=0
  elif [ "$1" = d ]; then
    printf 'Directory: %s\n' "$p"
    aide_attr Mtime "$(aide_time 0)" "$(aide_time "$v")"
    aide_attr Ctime "$(aide_time 0)" "$(aide_time "$v")"
    aide_attr Linkcount 3 4
  elif [ "$1" = t ]; then
    printf 'File: %s\n' "$p"
    aide_attr Mtime "$(aide_time 0)" "$(aide_time "$v")"
    aide_attr Ctime "$(aide_time 0)" "$(aide_time "$v")"
  else
    printf 'File: %s\n' "$p"
    aide_attr Size 1200 "$((1200 + v))"
    aide_attr Mtime "$(aide_time 0)" "$(aide_time "$v")"
    aide_attr Ctime "$(aide_time 0)" "$(aide_time "$v")"
    aide_attr SHA256 "$(aide_hash sha256 "$p" 0)" "$(aide_hash sha256 "$p" "$v")"
    aide_attr SHA512 "$(aide_hash sha512 "$p" 0)" "$(aide_hash sha512 "$p" "$v")"
  fi
}
aide_report() { # "YYYY-MM-DD HH:MM:SS" exit-code [f|d|t|a path version]... -> AIDE's log as dailyaidecheck writes
  # it, with AIDE 0.18.6's report (its layout as the real binary prints it): each path in Added entries (a: then the
  # report has report_level=added_removed_entries) or Changed entries, then its detail, the new values those of the
  # given version of the file (f), directory (d), touched file (t) or added file (a)
  local start="$1" code="$2" i na=0 nc=0
  shift 2
  local -a e=("$@")
  for ((i = 0; i < ${#e[@]}; i += 3)); do
    if [ "${e[i]}" = a ]; then na=$((na + 1)); else nc=$((nc + 1)); fi
  done
  {
    printf 'aide run on vm-test.example.com started at %s.\n' "$start"
    if [ "$code" = 0 ]; then
      printf 'AIDE returned with a zero exit code. No changes detected!\n\nAIDE produced no errors.\nAIDE detected no changes.\n\n'
    else
      printf 'AIDE returned with exit code %s. Changed entries detected!\n\nAIDE produced no errors.\n' "$code"
      printf 'AIDE output (40 lines):\nbegin timestamp %s\nStart timestamp: %s +0000 (AIDE 0.18.6)\n' "$start" "$start"
      printf 'AIDE found differences between database and filesystem!!\n'
      [ "$na" = 0 ] || printf 'Report level: added_removed_entries\n'
      printf '\nSummary:\n  Total number of entries:\t4242\n'
      printf '  Added entries:\t\t%s\n  Removed entries:\t\t0\n  Changed entries:\t\t%s\n' "$na" "$nc"
      if [ "$na" != 0 ]; then
        printf -- '\n---------------------------------------------------\nAdded entries:\n'
        printf -- '---------------------------------------------------\n\n'
        for ((i = 0; i < ${#e[@]}; i += 3)); do
          if [ "${e[i]}" = a ]; then printf 'f+++++++++++++++++: %s\n' "${e[i + 1]}"; fi
        done
      fi
      if [ "$nc" != 0 ]; then
        printf -- '\n---------------------------------------------------\nChanged entries:\n'
        printf -- '---------------------------------------------------\n\n'
        for ((i = 0; i < ${#e[@]}; i += 3)); do
          case "${e[i]}" in
            a) ;;
            d) printf 'd =.... mc.. .. . : %s\n' "${e[i + 1]}" ;;
            t) printf 'f =.... mc.. .. . : %s\n' "${e[i + 1]}" ;;
            *) printf 'f >.... mc..H.. . : %s\n' "${e[i + 1]}" ;;
          esac
        done
      fi
      printf -- '\n---------------------------------------------------\nDetailed information about changes:\n'
      printf -- '---------------------------------------------------\n'
      for ((i = 0; i < ${#e[@]}; i += 3)); do aide_detail "${e[i]}" "${e[i + 1]}" "${e[i + 2]}"; done
      printf -- '\n\n---------------------------------------------------\nThe attributes of the (uncompressed) database(s):\n'
      printf -- '---------------------------------------------------\n\n/var/lib/aide/aide.db\n'
      printf ' %-10s: %.32s\n' SHA256 "$(aide_hash sha256 aide.db "$start")"
      printf '\n\nEnd timestamp: %s +0000 (run time: 4m 2s)\nEnd of AIDE output.\n\n' "$start"
    fi
    printf 'End of AIDE daily aide check at %s, run time 42 seconds\n' "${start%:*}"
  } >"$AIDE_LOG"
}

frame() { # text... -> the texts in the frame of asterisks of aide-common 0.18.6's dailyaidecheck: a border of 78
  # asterisks, then each text without its leading and trailing blanks (its frame reads it with `read`) centred between
  # two asterisks in 76 columns, one space less on the left than the centre (so a text of 77 characters loses its first
  # one), then the border again
  local border text half
  border="$(printf '%78s' '' | tr ' ' '*')"
  printf '%s\n' "$border"
  for text in "$@"; do
    text="$(sed 's/^[[:space:]]*//; s/[[:space:]]*$//' <<<"$text")"
    half=$(((78 - ${#text}) / 2))
    if [ "$half" -gt 0 ]; then text="$(printf '%*s' "$half" '')$text"; fi
    printf '*%-76.76s*\n' "${text:1}"
  done
  printf '%s\n' "$border"
}
DOTLOCK_NOTE='no dotlockfile binary in path, not checking for already running daily aide check' # aide-common's note
aide_report_nodb() { # "YYYY-MM-DD HH:MM:SS" -> AIDE's log of a daily check without a database, as dailyaidecheck of
  # aide-common 0.18.6 writes it (checked with the Ubuntu package): no "AIDE returned" line, its reasons in frames, and
  # its script errors (it joins its lock note and the next error with a literal \n)
  {
    printf 'aide run on vm-test.example.com started at %s.\n' "$1"
    frame 'database not present.'
    echo
    frame ' the daily aide check was interrupted before AIDE could return an exit code.'
    echo
    frame 'script errors'
    printf '%s\\n%s\n' "$DOTLOCK_NOTE" "Fatal error: The AIDE database '/var/lib/aide/aide.db' does not exist!"
    echo "This may mean you haven't created it or that the initialization process is still running, or it may mean that someone has removed it."
    echo 'End of script errors'
    echo 'AIDE produced no errors.'
    echo 'AIDE detected no changes.'
    echo
    printf 'End of AIDE daily aide check at %s, run time 0 seconds\n' "${1%:*}"
    echo 'funny, AIDE did not leave a log.'
  } >"$AIDE_LOG"
}
aide_report_error() { # "YYYY-MM-DD HH:MM:SS" code meaning error-line -> AIDE's log of a daily check that AIDE ended
  # with an error exit code, as dailyaidecheck of aide-common 0.18.6 writes it (checked with the Ubuntu package: an
  # invalid line in a configuration file gives 17): its "AIDE returned" line in a frame, then AIDE's error output
  {
    printf 'aide run on vm-test.example.com started at %s.\n' "$1"
    frame "AIDE returned with exit code $2. $3"
    echo
    frame 'script errors'
    printf '%s\\nEnd of script errors\n' "$DOTLOCK_NOTE"
    echo 'AIDE error output (1 lines):'
    printf '  %s\n' "$4"
    echo 'End of AIDE error output'
    printf 'AIDE output (1 lines):\nbegin timestamp %s\nEnd of AIDE output.\n\n' "$1"
    printf 'End of AIDE daily aide check at %s, run time 1 seconds\n' "${1%:*}"
  } >"$AIDE_LOG"
}
audit_event() { # epoch id comm exe auid uid nametype:path... -> one auditd event of the key velexis-aide as
  # audisp-syslog puts it into the journal: its SYSCALL record, its CWD record, then a PATH record per path with its
  # nametype (PARENT, CREATE, DELETE, NORMAL). As the kernel writes them (seen with this machine's kernel and a watch on a
  # scratch tree): a PARENT of a path given as a relative name is the process's working folder, not the folder the name
  # is in (rm -rf removes the files of a folder by names relative to that folder)
  local at="$1" id="$2" comm="$3" exe="$4" auid="$5" uid="$6" i=0 p
  shift 6
  add_entry "$at" "$(plain auditd.service audisp-syslog 6 syslog "type=SYSCALL msg=audit($at.123:$id): arch=c000003e syscall=257 success=yes exit=3 auid=$auid uid=$uid tty=pts0 comm=\"$comm\" exe=\"$exe\" key=\"velexis-aide\"")"
  add_entry "$at" "$(plain auditd.service audisp-syslog 6 syslog "type=CWD msg=audit($at.123:$id): cwd=\"/root\"")"
  for p in "$@"; do
    add_entry "$at" "$(plain auditd.service audisp-syslog 6 syslog "type=PATH msg=audit($at.123:$id): item=$i name=\"${p#*:}\" inode=$((4000 + i)) dev=fe:00 mode=0100600 ouid=0 ogid=0 rdev=00:00 nametype=${p%%:*} cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0")"
    i=$((i + 1))
  done
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
quiet_aide_key() { # the key velexis-aide: counted, and its listing empty
  local b
  b="$(body_of "security log review")"
  grep -qxF "  0  velexis-aide" <<<"$b" &&
    grep -A1 -F 'velexis-aide events (AIDE database and re-baseline record): 0 in all;' <<<"$b" | grep -qxF '  none'
}
check "the summary counts the auditd key velexis-aide, and lists none of its events on a quiet day [X-045 AC2]" quiet_aide_key
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
aide_report "$TODAY 08:50:00" 4 f /etc/ssh/sshd_config.d/00-velexis.conf 1
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
aide_report "$TODAY 11:00:00" 4 f /etc/ssh/sshd_config.d/00-velexis.conf 1 f /etc/systemd/system/velexis-ota-api.service 1
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

# ---- 8. AIDE: an entry that changed again (X-044) ---------------------------------------------------------------------
# One AIDE report a day at 02:13 (day N after today), reviewed at 03:20 (before the 06:00 summary): T0 + N days - 4 h.
day() { date -u -d "$TODAY +$1 day" +%F; }
at_day() { echo $((T0 + $1 * 24 * H - 4 * H + ${2:-0})); }
review_day() { shipped_ok "$(at_day "$@")"; run_review "$(at_day "$@")"; }
SSHD_CONF=/etc/ssh/sshd_config.d/00-velexis.conf
UNIT=/etc/systemd/system/velexis-ota-api.service # changed by deploy-2222222 (case 5)
SBIN=/usr/local/sbin
STAMP=/var/lib/systemd/timers/stamp-velexis-log-review.timer # systemd touches it at every run: new times each day
T=$'\t'
step "X-044: the first run after the upgrade reads X-038's state file (entries only) without a false alert [X-044 AC2]"
# The state as X-038's log-review.sh left it after a report of tomorrow: section and path, no detail.
printf 'run %sT02:13:14Z\nchanged %s\nchanged %s\nchanged %s\nchanged %s\n' "$TOMORROW" "$SSHD_CONF" "$UNIT" "$STAMP" "$SBIN" \
  >"$STATE/aide"
aide_report "$(day 2) 02:13:14" 4 f "$SSHD_CONF" 1 f "$UNIT" 1 d "$SBIN" 1 t "$STAMP" 2
review_day 2
same "no message: the old state holds no detail to compare [X-044 AC2]" "$RC $(new_count)" "0 0"
same "the state now keeps the detail of each entry" "$(grep -c "^detail${T}changed " "$STATE/aide")" 4
check "with the new values of the file's attributes (each hash joined from AIDE's 32-byte pieces)" grep -qxF \
  "detail${T}changed $UNIT${T}File${T}Size=1201${T}Mtime=$(aide_time 1)${T}Ctime=$(aide_time 1)${T}SHA256=$(aide_hash sha256 "$UNIT" 1)${T}SHA512=$(aide_hash sha512 "$UNIT" 1)" \
  "$STATE/aide"
check "and of the directory's" \
  grep -qxF "detail${T}changed $SBIN${T}Directory${T}Mtime=$(aide_time 1)${T}Ctime=$(aide_time 1)${T}Linkcount=4" "$STATE/aide"

step "X-044: a file a deploy changed, listed again unchanged, raises nothing [X-044 AC2]"
aide_report "$(day 3) 02:13:14" 4 f "$SSHD_CONF" 1 f "$UNIT" 1 d "$SBIN" 1 t "$STAMP" 3
review_day 3
same "no message: the same entries with the same detail [X-044 AC2]" "$RC $(new_count)" "0 0"
check "(the timer's stamp file has new times, nothing else: a file only touched raises nothing)" \
  grep -qxF "detail${T}changed $STAMP${T}File${T}Mtime=$(aide_time 3)${T}Ctime=$(aide_time 3)" "$STATE/aide"

step "X-044: the same file changed again outside a deploy (new hashes) raises aide-change [X-044 AC1]"
aide_report "$(day 4) 02:13:14" 4 f "$SSHD_CONF" 1 f "$UNIT" 2 d "$SBIN" 1 t "$STAMP" 4
review_day 4
same "one message, the AIDE alert [X-044 AC1]" "$RC $(new_subjects)" "0 security alert: AIDE found changes outside a deploy"
check "it names the file and what differs from the previous report [X-044 AC1]" body_has "security alert: AIDE" \
  "changed $UNIT (again: Size, Mtime, Ctime, SHA256, SHA512 differ from the previous report)"
check "and no unchanged entry [X-044 AC1]" not body_has "security alert: AIDE" "$SSHD_CONF"
check "(the directory neither)" not body_has "security alert: AIDE" "$SBIN"
check "nor the timer's stamp file, only touched again [X-044 AC2]" not body_has "security alert: AIDE" "$STAMP"
check "the alert is logged as a security event of the kind aide-change [X-044 AC1]" \
  grep -qF '{"security":true,"event":"log_review.alert","kind":"aide-change",' "$LAST_OUT"
review_day 4 3600
same "the next run repeats nothing (the report was reviewed)" "$RC $(new_count)" "0 0"

step "X-044: a directory whose only new detail is its times (an entry renamed or replaced in it) follows the same rule"
aide_report "$(day 5) 02:13:14" 4 f "$SSHD_CONF" 1 f "$UNIT" 2 d "$SBIN" 2 t "$STAMP" 5
review_day 5
same "one message, the AIDE alert" "$RC $(new_subjects)" "0 security alert: AIDE found changes outside a deploy"
check "it names the directory and its times" body_has "security alert: AIDE" \
  "changed $SBIN (again: Mtime, Ctime differ from the previous report)"
check "and not the file it alerted yesterday" not body_has "security alert: AIDE" "$UNIT"

step "X-044: changes after a later deploy raise nothing [X-044 AC2]"
printf '%s deploy-3333333\n' "$(day 6)T01:00:00Z" >>"$LIB/deploy-history"
aide_report "$(day 6) 02:13:14" 4 f "$SSHD_CONF" 2 f "$UNIT" 3 d "$SBIN" 3 t "$STAMP" 6
shipped_ok "$(at_day 6)"
run_review "$(at_day 6)" --summary
same "no alert, only the summary asked for [X-044 AC2]" "$RC $(new_count)" "0 1"
check "the summary's AIDE line counts them as the deploy's [X-044 AC2]" body_has "security log review $(day 6)" \
  "AIDE: last check $(day 6)T02:13:14Z: 4 change(s) since AIDE's database was made (exit code 4); 3 new or changed again since the previous check, after the $(day 6)T01:00:00Z deploy of deploy-3333333 (expected)"
aide_report "$(day 7) 02:13:14" 4 f "$SSHD_CONF" 2 f "$UNIT" 3 d "$SBIN" 3 t "$STAMP" 7
review_day 7
same "the day after, the same detail again: no message [X-044 AC2]" "$RC $(new_count)" "0 0"

step "X-044: an added entry's detail (AIDE's report_level=added_removed_entries) is compared the same way [X-044 AC1]"
# provision-vm.sh makes AIDE's database before it installs the Velexis scripts and units, so on a VM provisioned from
# scratch they are added entries. AIDE 0.18.6 details them only with report_level=added_removed_entries: the new values
# alone, no database value (checked with the Ubuntu package's binary).
SCRIPT=$SBIN/velexis-backup
printf '%s deploy-4444444\n' "$(day 8)T01:00:00Z" >>"$LIB/deploy-history"
aide_report "$(day 8) 02:13:14" 5 f "$SSHD_CONF" 2 f "$UNIT" 3 d "$SBIN" 3 t "$STAMP" 8 a "$SCRIPT" 1
review_day 8
same "the deploy that installed the script: no message" "$RC $(new_count)" "0 0"
check "the state keeps the added entry's new values (hashes joined from their pieces, the ACL from its lines)" \
  grep -qxF "detail${T}added $SCRIPT${T}File${T}File type=File${T}Size=1201${T}Perm=-rwxr-xr-x${T}Uid=0${T}Gid=0${T}Mtime=$(aide_time 1)${T}Ctime=$(aide_time 1)${T}Inode=4242${T}Linkcount=1${T}SHA256=$(aide_hash sha256 "$SCRIPT" 1)${T}SHA512=$(aide_hash sha512 "$SCRIPT" 1)${T}ACL=A: user::rwxA: group::r-xA: other::r-x${T}XAttrs=num=0" \
  "$STATE/aide"
aide_report "$(day 9) 02:13:14" 5 f "$SSHD_CONF" 2 f "$UNIT" 3 d "$SBIN" 3 t "$STAMP" 9 a "$SCRIPT" 1
review_day 9
same "the added script listed again unchanged: no message" "$RC $(new_count)" "0 0"
aide_report "$(day 10) 02:13:14" 5 f "$SSHD_CONF" 2 f "$UNIT" 3 d "$SBIN" 3 t "$STAMP" 10 a "$SCRIPT" 2
review_day 10
same "the added script rewritten in place outside a deploy: one message, the AIDE alert [X-044 AC1]" \
  "$RC $(new_subjects)" "0 security alert: AIDE found changes outside a deploy"
check "it names the added script and what differs [X-044 AC1]" body_has "security alert: AIDE" \
  "added $SCRIPT (again: Size, Mtime, Ctime, SHA256, SHA512 differ from the previous report)"
check "and nothing else" not body_has "security alert: AIDE" "$UNIT"

# ---- 9. AIDE's daily check without a result, and the auditd key velexis-aide (X-045) ---------------------------------
step "X-045: a daily check without a database raises aide-error once, also after a deploy and a provisioning run [X-045 AC1]"
AIDE_STATE_GOOD="$(cat "$STATE/aide")" # the review's state after the last check with a result (day 10)
printf '%s deploy-5555555\n' "$(day 11)T01:00:00Z" >>"$LIB/deploy-history"
printf '%s provision-vm.sh started by ubuntu: steps harden\n' "$(day 11)T01:30:00Z" >>"$ROOT/var/log/velexis/provision.log"
aide_report_nodb "$(day 11) 02:13:14"
review_day 11
NO_RESULT="security alert: AIDE's daily check gave no result"
same "one message, the aide-error alert, although a deploy and a provisioning run came before the check [X-045 AC1]" \
  "$RC $(new_subjects)" "0 $NO_RESULT"
check "it says the check stopped before AIDE returned an exit code [X-045 AC1]" \
  body_has "$NO_RESULT" "AIDE's daily check of $(day 11)T02:13:14Z gave no result: it stopped before AIDE returned an exit code."
alert_lines() { body_of "$NO_RESULT" | grep -qxF -- "$1"; }
check "with dailyaidecheck's reason from its frame [X-045 AC1]" alert_lines "database not present."
check "and its script error, apart from the note dailyaidecheck joined it to [X-045 AC1]" \
  alert_lines "Fatal error: The AIDE database '/var/lib/aide/aide.db' does not exist!"
check "and the way out: deployment §12 [X-045 AC1]" body_has "$NO_RESULT" "When the database is missing after the"
check "the alert is logged as a security event of the kind aide-error [X-045 AC1]" \
  grep -qF '{"security":true,"event":"log_review.alert","kind":"aide-error",' "$LAST_OUT"
same "the review's AIDE state is still that of the last check with a result [X-045 AC1]" "$(cat "$STATE/aide")" "$AIDE_STATE_GOOD"
review_day 11 3600
same "the next run repeats nothing: that check was alerted [X-045 AC1]" "$RC $(new_count)" "0 0"
shipped_ok "$(at_day 11 7200)"
run_review "$(at_day 11 7200)" --summary
check "the daily summary's AIDE line names it and the alert [X-045 AC1]" body_has "security log review $(day 11)" \
  "AIDE: last check $(day 11)T02:13:14Z: no result (database not present.); the immediate alert aide-error was sent for it"
same "and that run sends nothing else" "$RC $(new_count)" "0 1"
run_review "$(at_day 11 7200)" --status
check "--status names the last check without a result that was alerted" grep -q "^aide-error *$(day 11)T02:13:14Z" "$LAST_OUT"

step "X-045: a check that AIDE ended with an error exit code raises aide-error, with AIDE's error output [X-045 AC1]"
CONF_ERROR="ERROR: /etc/aide/aide.conf.d/90_velexis:18: unknown config option: 'this' (line: 'this line is no rule')"
aide_report_error "$(day 12) 02:13:14" 17 'Invalid configuration!' "$CONF_ERROR"
review_day 12
same "one message, the aide-error alert [X-045 AC1]" "$RC $(new_subjects)" "0 $NO_RESULT"
check "it names the exit code and its meaning, read from dailyaidecheck's frame [X-045 AC1]" body_has "$NO_RESULT" \
  "AIDE's daily check of $(day 12)T02:13:14Z gave no result: AIDE ended it with the error exit code 17 (Invalid configuration!)."
check "and AIDE's error output [X-045 AC1]" alert_lines "  $CONF_ERROR"
same "the review's AIDE state is still that of the last check with a result [X-045 AC1]" "$(cat "$STATE/aide")" "$AIDE_STATE_GOOD"
review_day 12 3600
same "the next run repeats nothing [X-045 AC1]" "$RC $(new_count)" "0 0"

step "X-045: the next check with a result is compared with the last check that had one [X-045 AC1]"
aide_report "$(day 13) 02:13:14" 5 f "$SSHD_CONF" 2 f "$UNIT" 3 d "$SBIN" 3 t "$STAMP" 13 a "$SCRIPT" 2
review_day 13
same "day 10's entries and detail again (the timer's stamp only touched): no message [X-045 AC1]" "$RC $(new_count)" "0 0"
check "the review's AIDE state is that check's [X-045 AC1]" grep -q "^run $(day 13)T02:13:14Z$" "$STATE/aide"
aide_report "$(day 14) 02:13:14" 5 f "$SSHD_CONF" 2 f "$UNIT" 4 d "$SBIN" 3 t "$STAMP" 14 a "$SCRIPT" 2
review_day 14
same "a change the day after, outside a deploy: the aide-change alert, as before [X-045 AC1]" \
  "$RC $(new_subjects)" "0 security alert: AIDE found changes outside a deploy"

step "X-045: the summary counts the key velexis-aide and lists its events on AIDE's database, the record and other paths [X-045 AC2]"
A="$(at_day 14 600)"
audit_event $((A + 1)) 9001 cp /usr/bin/cp 1000 0 PARENT:/var/lib/aide/ NORMAL:/var/lib/aide/aide.db
audit_event $((A + 2)) 9002 tee /usr/bin/tee 1000 0 NORMAL:/var/lib/velexis/provision/aide-rebaseline
audit_event $((A + 3)) 9003 aide /usr/bin/aide 4294967295 105 PARENT:/var/lib/aide/ CREATE:/var/lib/aide/aide.db.new
audit_event $((A + 4)) 9004 dailyaidecheck /usr/bin/bash 4294967295 105 PARENT:/var/lib/aide/dailyaidecheck/ \
  CREATE:/var/lib/aide/dailyaidecheck/mailfile
audit_event $((A + 5)) 9005 sh /usr/bin/dash 1000 0 PARENT:/var/lib/aide/ CREATE:/var/lib/aide/dropped
# dailyaidecheck's own clean-up, rm -rf /var/lib/aide/dailyaidecheck from its working folder /run/aide (lock): each
# file by a name relative to the folder, the PARENT item the working folder; then the folder itself
audit_event $((A + 6)) 9006 rm /usr/bin/rm 4294967295 105 PARENT:/run/aide DELETE:errorlog
audit_event $((A + 7)) 9007 rm /usr/bin/rm 4294967295 105 PARENT:/var/lib/aide/ DELETE:/var/lib/aide/dailyaidecheck
# relative names of another kind: a file made in /var/lib/aide from that folder, and the database removed from it
audit_event $((A + 8)) 9008 sh /usr/bin/dash 1000 0 PARENT:/var/lib/aide CREATE:planted
audit_event $((A + 9)) 9009 rm /usr/bin/rm 1000 0 PARENT:/var/lib/aide DELETE:aide.db
shipped_ok "$(at_day 14 1200)"
run_review "$(at_day 14 1200)" --summary
same "no immediate alert for them, the summary only [X-045 AC2]" "$RC $(new_count)" "0 1"
SUMMARY="$(body_of "security log review $(day 14)")"
check "the key's count among the watched keys [X-045 AC2]" summary_has "  9  velexis-aide"
check "how many touched the database or the record, other paths and AIDE's work files [X-045 AC2]" summary_has \
  "velexis-aide events (AIDE database and re-baseline record): 9 in all; 3 on /var/lib/aide/aide.db or /var/lib/velexis/provision/aide-rebaseline and 2 elsewhere, listed below; 4 only on the work files of the daily AIDE check (aide.db.new, dailyaidecheck/):"
listed() { grep -E "^  \S+ audit event $1: " <<<"$SUMMARY" | grep -qF -- "$2"; } # id text
check "the database replaced by hand: its command, users and paths [X-045 AC2]" \
  listed 9001 'comm="cp" exe="/usr/bin/cp" auid=1000 uid=0 paths: "/var/lib/aide/" "/var/lib/aide/aide.db"'
check "the record appended to [X-045 AC2]" listed 9002 'comm="tee" exe="/usr/bin/tee" auid=1000 uid=0 paths: "/var/lib/velexis/provision/aide-rebaseline"'
check "a file dropped elsewhere in /var/lib/aide [X-045 AC2]" listed 9005 'paths: "/var/lib/aide/" "/var/lib/aide/dropped"'
check "a file made there by a relative name [X-045 AC2]" listed 9008 'paths: "/var/lib/aide" "planted"'
check "the database removed by a relative name [X-045 AC2]" listed 9009 'comm="rm" exe="/usr/bin/rm" auid=1000 uid=0 paths: "/var/lib/aide" "aide.db"'
check "not the daily check's aide.db.new, its work folder or its clean-up of that folder (names relative to it) [X-045 AC2]" \
  not grep -qE 'audit event 900[3467]:' <<<"$SUMMARY"

step "X-045: a log that holds only the check's start raises aide-error, and the summary says so [X-045 AC1]"
printf 'aide run on vm-test.example.com started at %s.\n' "$(day 15) 02:13:14" >"$AIDE_LOG"
review_day 15
same "one message, the aide-error alert [X-045 AC1]" "$RC $(new_subjects)" "0 $NO_RESULT"
check "its body says the log holds nothing but the start [X-045 AC1]" alert_lines "(nothing but its start)"
shipped_ok "$(at_day 15 7200)"
run_review "$(at_day 15 7200)" --summary
check "the summary's AIDE line says the log holds nothing after the start [X-045 AC1]" body_has "security log review $(day 15)" \
  "AIDE: last check $(day 15)T02:13:14Z: no result (its log holds nothing after its start); the immediate alert aide-error was sent for it"

# ---- 10. AIDE's daily check overdue or switched off (lead decision (25g) of 2026-11-16) ----------------------------
step "FIX-W56-SHARED (25g): a fresh report and an active, enabled timer raise nothing [FIX-W56-SHARED 25g]"
STALE="security alert: AIDE's daily check is overdue or switched off"
CURRENT="AIDE's daily check is current again"
stale_line() { body_of "$STALE" | grep -qxF -- "$1"; } # one line of the run's aide-stale alert
R16="$(day 16)T02:13:14Z"
R16_AT="$(date -u -d "$R16" +%s)"
at16() { echo $((R16_AT + $1 * H)); } # hours after the day-16 report started
review16() { shipped_ok "$(at16 "$1")"; shift; run_review "$(at16 "$1")" "${@:2}"; }
# The report of day 16, in AIDE 0.18.6's layout: day 14's entries and detail again (the timer's stamp only touched).
aide_report "$(day 16) 02:13:14" 5 f "$SSHD_CONF" 2 f "$UNIT" 4 d "$SBIN" 3 t "$STAMP" 16 a "$SCRIPT" 2
: >"$FAKE/systemctl.calls"
review16 1 1
same "the report an hour old, dailyaidecheck.timer active and enabled: no message [FIX-W56-SHARED 25g]" "$RC $(new_count)" "0 0"
same "the review asks systemctl only whether dailyaidecheck.timer is active and enabled [FIX-W56-SHARED 25g]" \
  "$(LC_ALL=C sort -u "$FAKE/systemctl.calls" | paste -sd'|' -)" "is-active dailyaidecheck.timer|is-enabled dailyaidecheck.timer"
review16 2 2 --summary
check "the summary says how old the newest report is and the timer's state [FIX-W56-SHARED 25g]" \
  body_has "security log review $(day 16)" "Daily AIDE check: the newest report started $R16, 2 h 0 min before this review (alert above 27 h); dailyaidecheck.timer active, enabled"
review16 27 27
same "exactly 27 hours after the report started (the bound): no message [FIX-W56-SHARED 25g]" "$RC $(new_count)" "0 0"

step "FIX-W56-SHARED (25g): a 28-hour-old report raises aide-stale once, and the summary says so [FIX-W56-SHARED 25g]"
review16 28 28 # 06:13 the next day: also that day's summary
same "28 hours: the aide-stale alert and the day's summary [FIX-W56-SHARED 25g]" "$RC $(new_subjects | LC_ALL=C sort | paste -sd'|' -)" \
  "0 $STALE|security log review $(day 17): 0 SSH login(s), 0 as root, 0 sudo command(s), 0 WAF match(es) (0 refused), 0 refused outbound connection(s)"
check "it names the report, its age and the bound [FIX-W56-SHARED 25g]" \
  stale_line "- its newest report (/var/log/aide/aide.log) started $R16, 28 h 0 min before this review: more than 27 hours (new)"
check "and no timer problem: the timer is active and enabled [FIX-W56-SHARED 25g]" not body_has "$STALE" "dailyaidecheck.timer is "
check "and what to do (deployment §12) [FIX-W56-SHARED 25g]" body_has "$STALE" "sudo systemctl enable --now dailyaidecheck.timer"
check "the alert is logged as a security event of the kind aide-stale [FIX-W56-SHARED 25g]" \
  grep -qF '{"security":true,"event":"log_review.alert","kind":"aide-stale",' "$LAST_OUT"
check "the day's summary says so [FIX-W56-SHARED 25g]" body_has "security log review $(day 17)" \
  "Daily AIDE check: the newest report started $R16, 28 h 0 min before this review (alert above 27 h); dailyaidecheck.timer active, enabled; overdue or switched off: the immediate alert aide-stale was sent for it"
review16 29 29
same "the same report an hour later: no message [FIX-W56-SHARED 25g]" "$RC $(new_count)" "0 0"
run_review "$(at16 29)" --status
check "--status shows the condition alerted [FIX-W56-SHARED 25g]" grep -qx "aide-stale *report $R16" "$LAST_OUT"
review16 30 30
same "and two hours later neither [FIX-W56-SHARED 25g]" "$RC $(new_count)" "0 0"

step "FIX-W56-SHARED (25g): a newer report is one recovery message [FIX-W56-SHARED 25g]"
aide_report "$(day 17) 07:30:00" 5 f "$SSHD_CONF" 2 f "$UNIT" 4 d "$SBIN" 3 t "$STAMP" 17 a "$SCRIPT" 2 # a check that ran late
review16 31 31 # 09:13
same "one message, the recovery [FIX-W56-SHARED 25g]" "$RC $(new_subjects)" "0 $CURRENT"
check "it names the new report [FIX-W56-SHARED 25g]" body_has "$CURRENT" \
  "AIDE's daily check is current again: the newest report started $(day 17)T07:30:00Z, 1 h 43 min before this review (alert above 27 h); dailyaidecheck.timer active, enabled."
review16 32 32
same "and the next run sends nothing [FIX-W56-SHARED 25g]" "$RC $(new_count)" "0 0"

step "FIX-W56-SHARED (25g): dailyaidecheck.timer not active, then not enabled: aide-stale for each, once [FIX-W56-SHARED 25g]"
echo "inactive enabled" >"$FAKE/timer"
review16 33 33
same "a timer that is not active: one message, aide-stale [FIX-W56-SHARED 25g]" "$RC $(new_subjects)" "0 $STALE"
check "it names the timer's state [FIX-W56-SHARED 25g]" stale_line "- dailyaidecheck.timer is inactive, not active: no daily check starts (new)"
check "and not the report, which is fresh [FIX-W56-SHARED 25g]" not body_has "$STALE" "newest report"
review16 34 34
same "the timer still not active an hour later: no message [FIX-W56-SHARED 25g]" "$RC $(new_count)" "0 0"
echo "active disabled" >"$FAKE/timer"
review16 35 35
same "active again but not enabled: one message, aide-stale [FIX-W56-SHARED 25g]" "$RC $(new_subjects)" "0 $STALE"
check "it names the timer not enabled [FIX-W56-SHARED 25g]" \
  stale_line "- dailyaidecheck.timer is disabled, not enabled: no daily check starts after the next reboot (new)"
echo "inactive disabled" >"$FAKE/timer"
review16 36 36
same "stopped too: one message, for the condition that is new again [FIX-W56-SHARED 25g]" "$RC $(new_subjects)" "0 $STALE"
check "it marks the new condition, and names the one alerted before without the mark [FIX-W56-SHARED 25g]" eval \
  'stale_line "- dailyaidecheck.timer is inactive, not active: no daily check starts (new)" && stale_line "- dailyaidecheck.timer is disabled, not enabled: no daily check starts after the next reboot"'
review16 37 37
same "both still there an hour later: no message [FIX-W56-SHARED 25g]" "$RC $(new_count)" "0 0"
echo "active enabled" >"$FAKE/timer"
review16 38 38
same "the timer active and enabled again: one message, the recovery [FIX-W56-SHARED 25g]" "$RC $(new_subjects)" "0 $CURRENT"

step "FIX-W56-SHARED (25g): no report at all raises aide-stale 27 hours after the step harden first completed [FIX-W56-SHARED 25g]"
mv "$AIDE_LOG" "$PREFIX/aide.log.away"
HARDEN_DONE="$LIB/provision/steps/harden" # provision-vm.sh's record of the step's first completion
mkdir -p "$LIB/provision/steps"
date -u -d "@$(at16 12)" +%Y-%m-%dT%H:%M:%SZ >"$HARDEN_DONE"
review16 39 39
same "no report, the step harden first completed exactly 27 hours ago: no message [FIX-W56-SHARED 25g]" "$RC $(new_count)" "0 0"
review16 40 40
same "28 hours after it: one message, aide-stale [FIX-W56-SHARED 25g]" "$RC $(new_subjects)" "0 $STALE"
check "it says there is no report, and since when the step harden completed [FIX-W56-SHARED 25g]" stale_line \
  "- there is no report in /var/log/aide/aide.log, and provision-vm.sh's step harden first completed $(date -u -d "@$(at16 12)" +%Y-%m-%dT%H:%M:%SZ), 28 h 0 min before this review (new)"
mv "$PREFIX/aide.log.away" "$AIDE_LOG"
review16 41 41
same "the report back: one message, the recovery [FIX-W56-SHARED 25g]" "$RC $(new_subjects)" "0 $CURRENT"
mv "$AIDE_LOG" "$PREFIX/aide.log.away"
mv "$HARDEN_DONE" "$PREFIX/harden.away"
review16 42 42
same "no report and no record of the step harden: aide-stale at once [FIX-W56-SHARED 25g]" "$RC $(new_subjects)" "0 $STALE"
check "it says no record tells when the step harden completed [FIX-W56-SHARED 25g]" stale_line \
  "- there is no report in /var/log/aide/aide.log, and no record says when provision-vm.sh's step harden first completed (/var/lib/velexis/provision/steps/harden) (new)"
mv "$PREFIX/aide.log.away" "$AIDE_LOG"

step "FIX-W56-SHARED (25g): a newer report that is late as well is a new condition, alerted once [FIX-W56-SHARED 25g]"
review16 43 43 # day 17, 21:13: the report of day 17 back, 13 h 43 min old
same "the report back: one message, the recovery [FIX-W56-SHARED 25g]" "$RC $(new_subjects)" "0 $CURRENT"
review16 57 57 # day 18, 11:13: the report of day 17 is 27 h 43 min old (and day 18's summary goes out)
same "the report of day 17 late: two messages, aide-stale and day 18's summary [FIX-W56-SHARED 25g]" "$RC $(new_count)" "0 2"
check "aide-stale names the report of day 17 [FIX-W56-SHARED 25g]" stale_line \
  "- its newest report (/var/log/aide/aide.log) started $(day 17)T07:30:00Z, 27 h 43 min before this review: more than 27 hours (new)"
# A newer report that is late already when it appears (a check that ran for hours), while the older one's alert is
# still open: the condition is the report, so the newer one is alerted, once.
aide_report "$(day 17) 08:30:00" 5 f "$SSHD_CONF" 2 f "$UNIT" 4 d "$SBIN" 3 t "$STAMP" 17 a "$SCRIPT" 2
review16 58 58
same "a newer report that is late as well: one message, aide-stale [FIX-W56-SHARED 25g]" "$RC $(new_subjects)" "0 $STALE"
check "it names the newer report as new [FIX-W56-SHARED 25g]" stale_line \
  "- its newest report (/var/log/aide/aide.log) started $(day 17)T08:30:00Z, 27 h 43 min before this review: more than 27 hours (new)"
review16 59 59
same "the newer report an hour later: no message [FIX-W56-SHARED 25g]" "$RC $(new_count)" "0 0"

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
