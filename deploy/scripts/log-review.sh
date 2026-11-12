#!/usr/bin/env bash
# =====================================================================================================
# log-review.sh — the automated review of the VM's security logs (task X-038; PCI DSS 10.4.1, 10.4.1.1, 10.4.2,
# 10.7, 11.5; ADR-0027 rows 10.x and 11.5). Root-owned copy: /usr/local/sbin/velexis-logreview, run every hour (at
# :20, after the hour's shipment) by velexis-log-review.service (velexis-log-review.timer). Installed by
# provision-vm.sh (step scripts, which also enables the timer) and by every deploy. Docs:
# docs/mvp/deployment-single-vm.md §12 and §13.
#
#   velexis-logreview            the immediate alerts for what happened since the last run, and the daily summary
#                                once a day (the first run at or after 06:00 UTC, after AIDE's daily check)
#   velexis-logreview --summary  the same, with the summary of the last 24 hours now
#   velexis-logreview --status   the state of the checks and the day of the last summary (changes nothing)
#
# It reads the security entries exactly as they are shipped (velexis-shiplogs export: the WAF's query values already
# blanked), with a journald cursor of its own, so a shipment that fails does not hide an event from it.
#
# Immediate alerts, each kind in a message of its own through `velexis-alert message`, one per event or run of
# events, never repeated for the same event:
#   root-login     an SSH login as root ("Accepted ... for root"), or a root login on the console (login's ROOT LOGIN)
#   ssh-key        an SSH key not seen before: a new key line in any account's ~/.ssh/authorized_keys (or
#                  authorized_keys2), or a login with a key whose fingerprint was never seen; the first run only
#                  records the keys it finds
#   keys-change    an auditd event with the key velexis-keys: a change under /etc/velexis/keys (provision-vm.sh's
#                  audit rules), with the command, the users and the paths of the event
#   aide-change    AIDE's daily check (dailyaidecheck, its log /var/log/aide/aide.log) reports a change that its
#                  previous report did not, and neither a deploy (/var/lib/velexis/deploy-history) nor a run of
#                  provision-vm.sh (/var/log/velexis/provision.log) happened since that previous check (AIDE's
#                  database is not updated after a deploy, so a deploy's changes stay in its reports; only new ones
#                  count)
#   shipment       the log shipment failed, or the last verified shipment is older than two hours (state of
#                  velexis-ship-logs); once when it starts, and once when it recovers
#   egress-burst   30 or more refused outbound connections (X-041's VELEXIS-EGRESS-DENY lines; the kernel logs at
#                  most 10 a minute) since the last run; once until a run sees fewer again
#   folder-size    /var/log/velexis/security/ holds more than 5 GB; once, and once when it is below again
# An alert that cannot be sent keeps every state as it was (the cursor too), so the next run sends it again, and the
# run exits 1 (OnFailure= then mails the unit). Each alert is also logged as one JSON line with "security":true, which
# velexis-ship-logs ships with the other security events.
#
# The daily summary (one message, also on a quiet day) covers the last 24 hours: the log shipment and the security
# log folder; accepted SSH logins by user, source and method; refused SSH logins by user and source; root logins; sudo
# commands by user and command, sudo refusals and su sessions; auditd events on each watched key; AIDE's last check;
# unit failures; the WAF's matches by rule (requests matched, and refused with 403); 4xx and 5xx answers on the
# airline-card route (/v1/checkouts/{id}/airline-card-completion, through Caddy); refused outbound connections by
# destination and user; fail2ban's bans; the apps' security events and the velexis-* units' warnings and errors.
# Neither the summary nor an alert quotes a WAF line's [uri] (a body line that holds one is dropped before sending).
#
# State: /var/lib/velexis/log-review/ (cursor, ssh-keys, aide, shipment, egress-burst, folder-size, summary-day).
#
# Tests only (deploy/scripts/test/log-review.test.sh). With VELEXIS_ROOT=<absolute folder> the paths of this script
# (/etc/velexis, /var/lib/velexis, /var/log/velexis, /var/log/aide and every home folder) move under that folder, it
# runs without root, and it takes these overrides:
#   VELEXIS_ALERT  a command that replaces /usr/local/sbin/velexis-alert (required with VELEXIS_ROOT)
#   SHIP_LOGS      the ship-logs.sh to read the entries with (required; it gets VELEXIS_ROOT and JOURNALCTL as well)
#   PASSWD_FILE    a passwd file instead of `getent passwd` (accounts and their home folders, user names of UIDs)
#   REVIEW_NOW     the time of the run (epoch seconds) instead of the clock
# Without VELEXIS_ROOT (the VM) they have no effect.
# =====================================================================================================
set -euo pipefail
shopt -s lastpipe # `... | add_alert` runs add_alert in this shell, so its count and files stay
umask 077

NAME=velexis-logreview
: "${VELEXIS_ROOT:=}"
R="$VELEXIS_ROOT"
if [ -n "$R" ]; then
  case "$R" in /?*) ;; *) echo "$NAME: VELEXIS_ROOT must be an absolute path other than /" >&2; exit 2 ;; esac
  [ -d "$R" ] || { echo "$NAME: VELEXIS_ROOT $R is not a folder" >&2; exit 2; }
  [ -n "${VELEXIS_ALERT:-}" ] || { echo "$NAME: with VELEXIS_ROOT, VELEXIS_ALERT must name the stand-in for velexis-alert" >&2; exit 2; }
  [ -n "${SHIP_LOGS:-}" ] || { echo "$NAME: with VELEXIS_ROOT, SHIP_LOGS must name the ship-logs.sh to read with" >&2; exit 2; }
  PASSWD_FILE="${PASSWD_FILE:-}"
  NOW="${REVIEW_NOW:-$(date -u +%s)}"
else
  VELEXIS_ALERT=/usr/local/sbin/velexis-alert
  SHIP_LOGS=/usr/local/sbin/velexis-shiplogs
  PASSWD_FILE=""
  NOW="$(date -u +%s)"
fi
[[ "$NOW" =~ ^[0-9]{9,11}$ ]] || { echo "$NAME: REVIEW_NOW must be epoch seconds" >&2; exit 2; }

LIB="$R/var/lib/velexis"
STATE_DIR="$LIB/log-review"
SHIP_STATE="$LIB/ship-logs"
SEC_DIR="$R/var/log/velexis/security"
DEPLOY_HISTORY="$LIB/deploy-history"
PROVISION_LOG="$R/var/log/velexis/provision.log"
AIDE_LOG="$R/var/log/aide/aide.log"

# Thresholds (X-038 steps 3 and 4, X-041's note of 2026-11-10); not settings.
SHIP_MAX_AGE=7200                          # the last verified shipment may be two hours old
SEC_DIR_MAX_BYTES=$((5 * 1024 * 1024 * 1024)) # /var/log/velexis/security/ above 5 GB alerts
EGRESS_BURST=30                            # refused outbound connections logged since the last run (about an hour)
SUMMARY_HOUR=6                             # the daily summary: the first run at or after 06:00 UTC
FIRST_RUN_WINDOW=3600                      # the first run looks one hour back
# The keys of provision-vm.sh's auditd rules (deployment-single-vm.md §2): each gets a line in the summary.
WATCHED_KEYS="velexis-config velexis-keys caddy-config systemd-units velexis-scripts caddy-binary sudoers sshd"
KEY_TYPES_RE='^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh[.]com|sk-ecdsa-sha2-nistp256@openssh[.]com)$'

log() { printf '%s\n' "$*"; }
die() { printf '%s: ERROR: %s\n' "$NAME" "$*" >&2; exit 1; }
usage() { echo "usage: $NAME [--summary | --status]" >&2; exit 2; }
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
show() { printf '%s' "${1#"$R"}"; }
passwd_entries() { if [ -n "$PASSWD_FILE" ]; then cat "$PASSWD_FILE"; else getent passwd; fi; }
export_entries() { "$SHIP_LOGS" export "$@"; }
event_line() { # kind subject -> one JSON line in the journal ("security":true: velexis-ship-logs ships it)
  jq -nc --arg kind "$1" --arg subject "$2" '{security: true, event: "log_review.alert", kind: $kind, subject: $subject}'
}

MODE=run
case "${1:-}" in
  "") ;;
  --summary) MODE=summary ;;
  --status) MODE=status ;;
  *) usage ;;
esac
[ $# -le 1 ] || usage

if [ "$MODE" = status ]; then
  for f in shipment egress-burst folder-size; do
    printf '%-13s %s\n' "$f" "$(cat "$STATE_DIR/$f" 2>/dev/null || echo unknown)"
  done
  printf '%-13s %s\n' summary-day "$(cat "$STATE_DIR/summary-day" 2>/dev/null || echo none)"
  printf '%-13s %s\n' aide-check "$(head -n 1 "$STATE_DIR/aide" 2>/dev/null || echo none)"
  printf '%-13s %s\n' ssh-keys "$(wc -l <"$STATE_DIR/ssh-keys" 2>/dev/null || echo 0) known"
  printf '%-13s %s\n' cursor "$([ -s "$STATE_DIR/cursor" ] && echo saved || echo none)"
  exit 0
fi

[ -n "$R" ] || [ "$(id -u)" -eq 0 ] || die "run as root"
install -d -m 0700 "$STATE_DIR"
exec 9>"$STATE_DIR/lock"
flock -n 9 || { log "another review is running; this one stops"; exit 0; }
WORK="$(mktemp -d "$STATE_DIR/run.XXXXXX")"
# shellcheck disable=SC2064 # the folder of this run
trap "rm -rf '$WORK'" EXIT
mkdir "$WORK/state"   # the new states, moved into STATE_DIR once every alert is sent

ALERTS=0
add_alert() { # kind subject; the body on stdin
  ALERTS=$((ALERTS + 1))
  printf '%s\n' "$1" >"$WORK/alert-$ALERTS.kind"
  printf '%s\n' "$2" >"$WORK/alert-$ALERTS.subject"
  cat >"$WORK/alert-$ALERTS.body"
}
send() { # subject body-file: through velexis-alert; a line with a [uri] never leaves
  {
    sed '/\[uri /d' "$2"
    printf '\n-- \n%s on %s (docs/mvp/deployment-single-vm.md §12)\n' "$NAME" "$(hostname)"
  } >"$WORK/send.body"
  "$VELEXIS_ALERT" message "$1" "$WORK/send.body" >/dev/null
}
transition() { # check bad(0|1) alert-subject [recovery-subject]; the details on stdin. One alert when the check starts
  # failing, nothing while it keeps failing, and one recovery message when it passes again (none without its subject).
  local check="$1" bad="$2" before
  before="$(cat "$STATE_DIR/$check" 2>/dev/null || echo ok)"
  if [ "$bad" = 1 ]; then
    echo failing >"$WORK/state/$check"
    if [ "$before" != failing ]; then add_alert "$check" "$3"; else cat >/dev/null; fi
  else
    echo ok >"$WORK/state/$check"
    if [ "$before" = failing ] && [ -n "${4:-}" ]; then add_alert "$check" "$4"; else cat >/dev/null; fi
  fi
}

# ---- 1. the entries since the last run ----------------------------------------------------------------------------
if [ -s "$STATE_DIR/cursor" ]; then
  cp "$STATE_DIR/cursor" "$WORK/cursor"
  export_entries --cursor-file "$WORK/cursor" >"$WORK/new.jsonl" || die "could not read the journal"
else
  export_entries --cursor-file "$WORK/cursor" --since "$((NOW - FIRST_RUN_WINDOW))" >"$WORK/new.jsonl" \
    || die "could not read the journal"
fi
[ ! -s "$WORK/cursor" ] || cp "$WORK/cursor" "$WORK/state/cursor"

# ---- 2. immediate alerts --------------------------------------------------------------------------------------------
# Root logins.
jq -r 'select((.cat == "ssh" and (.msg | test("^Accepted \\S+ for root from ")))
    or (.cat == "login" and .ident == "login" and (.msg | test("ROOT LOGIN"))))
  | "\(.ts) \(.host): \(.msg[0:300])"' "$WORK/new.jsonl" >"$WORK/root-logins"
if [ -s "$WORK/root-logins" ]; then
  {
    echo "Root logged in on this VM ($(wc -l <"$WORK/root-logins") login(s)). Root logins are refused by sshd's"
    echo "PermitRootLogin no: find out who did it and how (docs/mvp/deployment-single-vm.md §16, incident response)."
    echo
    cat "$WORK/root-logins"
  } | add_alert root-login "security alert: root login"
fi

# SSH keys never seen before: in an authorized_keys file, or used to log in.
key_fp() { # base64 key blob -> SHA256:<base64> as sshd logs it, or nothing
  local fp
  fp="$(printf '%s' "$1" | base64 -d 2>/dev/null | openssl dgst -sha256 -binary 2>/dev/null | base64 -w0 | tr -d '=')" || fp=""
  [ -z "$fp" ] || printf 'SHA256:%s' "$fp"
}
file_keys() { # -> "<fingerprint> <type> in <file> (account <user>)" for every key of every account's authorized_keys
  local user home f type blob fp
  declare -A seen=()
  while IFS=: read -r user _ _ _ _ home _; do
    if [ -z "$home" ] || [ "$home" = / ] || [ -n "${seen[$home]:-}" ]; then continue; fi
    seen[$home]=1
    for f in "$R$home/.ssh/authorized_keys" "$R$home/.ssh/authorized_keys2"; do
      [ -f "$f" ] || continue
      while read -r type blob; do
        fp="$(key_fp "$blob")"
        [ -z "$fp" ] || printf '%s %s in %s (account %s)\n' "$fp" "$type" "$(show "$f")" "$user"
      done < <(awk -v re="$KEY_TYPES_RE" '!/^[[:space:]]*(#|$)/ {
          for (i = 1; i < NF; i++) if ($i ~ re) { print $i, $(i + 1); break } }' "$f")
    done
  done < <(passwd_entries)
}
{
  file_keys
  jq -r 'select(.cat == "ssh") | . as $e | .msg
    | capture("^(Accepted|Partial) publickey for (?<u>\\S+) from (?<s>\\S+) port [0-9]+ ssh2: (?<t>\\S+) (?<fp>SHA256:\\S+)")
    | "\(.fp) \(.t) used to log in as \(.u) from \(.s) at \($e.ts)"' "$WORK/new.jsonl"
} >"$WORK/keys-seen"
if [ -f "$STATE_DIR/ssh-keys" ]; then
  awk 'NR == FNR { known[$1] = 1; next } !($1 in known) && !($1 in shown) { shown[$1] = 1; print }' \
    "$STATE_DIR/ssh-keys" "$WORK/keys-seen" >"$WORK/keys-new"
  if [ -s "$WORK/keys-new" ]; then
    {
      echo "SSH key(s) this VM has not seen before ($(wc -l <"$WORK/keys-new")). If nobody you know added or used it,"
      echo "remove it at once and treat it as an incident (docs/mvp/runbooks/ssh-access.md, deployment-single-vm.md §16)."
      echo
      cat "$WORK/keys-new"
    } | add_alert ssh-key "security alert: new SSH key"
  fi
  cut -d' ' -f1 "$STATE_DIR/ssh-keys" "$WORK/keys-seen" | LC_ALL=C sort -u >"$WORK/state/ssh-keys"
else
  # The first run records the keys it finds as the known ones.
  cut -d' ' -f1 "$WORK/keys-seen" | LC_ALL=C sort -u >"$WORK/state/ssh-keys"
  log "first run: $(wc -l <"$WORK/state/ssh-keys") SSH key(s) recorded as known"
fi

# Changes under /etc/velexis/keys (auditd key velexis-keys), one line per audit event with its paths.
# shellcheck disable=SC2016 # jq's $names
jq -rn '[inputs | select(.cat == "auditd")
    | . + {id: ((.msg | capture("audit\\([0-9.]+:(?<i>[0-9]+)\\)") | .i) // .audit_id // .rt)}] as $all
  | ($all | map(select(.msg | test("key=\"?velexis-keys\"?(\\s|$)")) | .id) | unique) as $ids
  | $ids[] as $id
  | ($all | map(select(.id == $id))) as $r
  | (($r | map(select(.msg | test("SYSCALL"))) | first) // $r[0]) as $s
  | ([$r[] | .msg | capture("(?:^|\\s)name=(?<n>\"[^\"]*\"|\\S+)") | .n] | unique | join(" ")) as $names
  | ([["comm", "exe", "auid", "uid"][] as $f
      | $s.msg | capture("(?:^|\\s)" + $f + "=(?<v>\"[^\"]*\"|\\S+)") | "\($f)=\(.v)"] | join(" ")) as $who
  | "\($s.ts) audit event \($id): \($who)" + (if $names == "" then "" else " paths: \($names)" end)' \
  "$WORK/new.jsonl" >"$WORK/keys-changes"
if [ -s "$WORK/keys-changes" ]; then
  {
    echo "Files under /etc/velexis/keys changed ($(wc -l <"$WORK/keys-changes") audit event(s)). Only a master key"
    echo "rotation (docs/mvp/runbooks/master-key-rotation.md) or provisioning changes them: if neither ran, treat it as a"
    echo "compromise of the keys (deployment-single-vm.md §16)."
    echo
    cat "$WORK/keys-changes"
  } | add_alert keys-change "security alert: change under /etc/velexis/keys"
fi

# AIDE: a change its previous report did not hold, with no deploy or provisioning since that report.
AIDE_NOTE="no report of AIDE's daily check ($(show "$AIDE_LOG"))"
aide_check() {
  local start code entries prev_start window_start changes since
  [ -r "$AIDE_LOG" ] || return 0
  start="$(sed -n 's/^aide run on .* started at \([0-9]\{4\}-[0-9][0-9]-[0-9][0-9]\) \([0-9][0-9]:[0-9][0-9]:[0-9][0-9]\)\.$/\1T\2Z/p' "$AIDE_LOG" | awk 'NR == 1')"
  [ -n "$start" ] || { AIDE_NOTE="AIDE's log has no run"; return 0; }
  code="$(sed -n 's/^AIDE returned with exit code \([0-9][0-9]*\)\..*/\1/p' "$AIDE_LOG" | awk 'NR == 1')"
  if grep -q '^AIDE returned with a zero exit code' "$AIDE_LOG"; then code=0; fi
  # The entries of the report's Added, Removed and Changed sections (never its detailed section).
  awk '/^(Added|Removed|Changed) entries:$/ { sec = tolower($1); next }
       /^-+$/ || /^$/ { next }
       /^(Detailed information about changes|End of AIDE output|Summary)/ { sec = ""; next }
       sec != "" && /: \// { p = $0; sub(/^[^:]*: /, "", p); print sec " " p }' "$AIDE_LOG" | LC_ALL=C sort -u >"$WORK/aide-entries"
  if [ ! -s "$WORK/aide-entries" ] && [[ "${code:-0}" =~ ^[1-7]$ ]]; then echo "changes (exit code $code)" >"$WORK/aide-entries"; fi
  entries="$(wc -l <"$WORK/aide-entries")"
  case "${code:-}" in
    0) AIDE_NOTE="last check $start: no changes" ;;
    [1-7]) AIDE_NOTE="last check $start: $entries change(s) since AIDE's database was made (exit code $code)" ;;
    "") AIDE_NOTE="last check $start: no result in its log" ;;
    *) AIDE_NOTE="last check $start: AIDE reported an error (exit code $code)" ;;
  esac
  { echo "run $start"; cat "$WORK/aide-entries"; } >"$WORK/state/aide"
  prev_start="$(sed -n '1s/^run //p' "$STATE_DIR/aide" 2>/dev/null || true)"
  [ "$prev_start" != "$start" ] || return 0   # this report was reviewed already
  if [ -n "$prev_start" ]; then
    window_start="$prev_start"
    tail -n +2 "$STATE_DIR/aide" | LC_ALL=C sort -u >"$WORK/aide-before"
  else
    window_start="$(iso "$(($(date -u -d "$start" +%s) - 26 * 3600))")"
    : >"$WORK/aide-before"
  fi
  LC_ALL=C comm -13 "$WORK/aide-before" "$WORK/aide-entries" >"$WORK/aide-new"
  [ -s "$WORK/aide-new" ] || return 0
  # Deploys (deploy-history: "<UTC time> <sha>") and provisioning runs (provision.log) between the two checks.
  since="$( {
    awk -v a="$window_start" -v b="$start" '$1 > a && $1 <= b { print $1 " deploy of " $2 }' "$DEPLOY_HISTORY" 2>/dev/null || true
    awk -v a="$window_start" -v b="$start" '$1 > a && $1 <= b && $2 == "provision-vm.sh" && $3 == "started" { print $1 " provision-vm.sh" }' \
      "$PROVISION_LOG" 2>/dev/null || true
  } | LC_ALL=C sort | tail -n 1)"
  changes="$(wc -l <"$WORK/aide-new")"
  if [ -n "$since" ]; then
    AIDE_NOTE="$AIDE_NOTE; $changes new since the previous check, after the $since (expected)"
    return 0
  fi
  AIDE_NOTE="$AIDE_NOTE; $changes new since the previous check, outside a deploy (alerted)"
  {
    echo "AIDE's daily check of $start found $changes change(s) that its previous report did not hold, and no deploy"
    echo "or provisioning ran since $window_start. Find out what changed them; if nobody did, treat it as a compromise"
    echo "(deployment-single-vm.md §16). Full report: sudo less /var/log/aide/aide.log"
    echo
    head -n 50 "$WORK/aide-new"
    [ "$changes" -le 50 ] || echo "... and $((changes - 50)) more"
  } | add_alert aide-change "security alert: AIDE found changes outside a deploy"
}
aide_check

# The log shipment.
SHIP_NOTE=""
shipment_check() {
  local ok_at="" ok_rest="" failed_at="" failed_rest="" bad=0
  if [ -f "$SHIP_STATE/last-success" ]; then read -r ok_at ok_rest <"$SHIP_STATE/last-success" || true; fi
  if [ -f "$SHIP_STATE/last-failure" ]; then read -r failed_at failed_rest <"$SHIP_STATE/last-failure" || true; fi
  [[ "$ok_at" =~ ^[0-9]+$ ]] || ok_at=""
  [[ "$failed_at" =~ ^[0-9]+$ ]] || failed_at=""
  if [ -z "$ok_at" ]; then
    bad=1
    SHIP_NOTE="no verified shipment yet"
  else
    SHIP_NOTE="last verified shipment $(iso "$ok_at"), $(((NOW - ok_at) / 60)) min before this review ($ok_rest)"
    if [ $((NOW - ok_at)) -gt "$SHIP_MAX_AGE" ]; then bad=1; fi
  fi
  if [ -n "$failed_at" ] && { [ -z "$ok_at" ] || [ "$failed_at" -ge "$ok_at" ]; }; then
    bad=1
    SHIP_NOTE="$SHIP_NOTE; the last run failed at $(iso "$failed_at"): $failed_rest"
  fi
  {
    echo "The shipment of the security logs off the VM is failing: $SHIP_NOTE."
    echo "Until it works again they exist only on the VM (journald, 30 days). See journalctl -u velexis-ship-logs and"
    echo "sudo velexis-shiplogs --status (docs/mvp/deployment-single-vm.md §12)."
  } | transition shipment "$bad" "security alert: log shipment failing" "security log shipment recovered"
}
shipment_check

# A burst of refused outbound connections (X-041).
users_json="$(passwd_entries | awk -F: '$3 ~ /^[0-9]+$/ { print $3 "\t" $1 }' \
  | jq -Rn '[inputs | split("\t") | {(.[0]): .[1]}] | add // {}')"
# shellcheck disable=SC2016 # jq's $names
EGRESS_LINES='def who($u): if $u == "" then "the kernel" else ($users[$u] // "uid \($u)") end;
  [inputs | select(.cat == "egress") | .msg
    | {d: ((capture("DST=(?<v>\\S+)") | .v) // "?"), p: ((capture("PROTO=(?<v>\\S+)") | .v) // "?"),
       t: ((capture("DPT=(?<v>[0-9]+)") | .v) // "-"), u: ((capture("UID=(?<v>[0-9]+)") | .v) // "")}
    | "\(.d):\(.t)/\(.p) by \(who(.u))"]
  | group_by(.) | map({k: .[0], n: length}) | sort_by(-.n, .k) | .[] | "\(.n) \(.k)"'
egress_count="$(jq -c 'select(.cat == "egress")' "$WORK/new.jsonl" | wc -l)"
burst=0
[ "$egress_count" -lt "$EGRESS_BURST" ] || burst=1
{
  echo "$egress_count outbound connections were refused and logged (VELEXIS-EGRESS-DENY) since the last review, at most"
  echo "10 a minute (docs/mvp/runbooks/outbound-allow-list.md §3). By destination and user:"
  echo
  jq -rn --argjson users "$users_json" "$EGRESS_LINES" "$WORK/new.jsonl" | awk 'NR <= 30' # reads all: no SIGPIPE
} | transition egress-burst "$burst" "security alert: burst of refused outbound connections"

# The size of the security log folder.
sec_bytes="$(du -sb "$SEC_DIR" 2>/dev/null | cut -f1 || true)"
sec_bytes="${sec_bytes:-0}"
big=0
[ "$sec_bytes" -le "$SEC_DIR_MAX_BYTES" ] || big=1
{
  echo "$(show "$SEC_DIR") holds $((sec_bytes / 1024 / 1024)) MiB, more than 5 GB. velexis-ship-logs keeps 90 days there;"
  echo "find out which source grew (sudo velexis-shiplogs --status, then zstdcat the newest daily file | jq -r .cat | sort | uniq -c)."
} | transition folder-size "$big" "security alert: security log folder above 5 GB" \
  "security log folder back below 5 GB"

# ---- 3. send the alerts, then keep the new states ------------------------------------------------------------------
i=1
while [ "$i" -le "$ALERTS" ]; do
  subject="$(cat "$WORK/alert-$i.subject")"
  send "$subject" "$WORK/alert-$i.body" || die "velexis-alert could not send \"$subject\"; every state stays, the next run sends it again"
  event_line "$(cat "$WORK/alert-$i.kind")" "$subject"
  i=$((i + 1))
done
for f in "$WORK"/state/*; do
  [ -e "$f" ] || continue
  mv -f "$f" "$STATE_DIR/${f##*/}"
done
log "review done: $ALERTS alert(s), $(wc -l <"$WORK/new.jsonl") new security entries"

# ---- 4. the daily summary -------------------------------------------------------------------------------------------
TODAY="$(date -u -d "@$NOW" +%F)"
if [ "$MODE" != summary ]; then
  [ "$(date -u -d "@$NOW" +%-H)" -ge "$SUMMARY_HOUR" ] || exit 0
  [ "$(cat "$STATE_DIR/summary-day" 2>/dev/null || true)" != "$TODAY" ] || exit 0
fi
FROM=$((NOW - 86400))
export_entries --since "$FROM" --until "$NOW" >"$WORK/day.jsonl" || die "could not read the journal for the summary"

# shellcheck disable=SC2016 # a jq program: its $names are jq's
SUMMARY='
def bump(f; k): f[k] += 1;
def cap(re): (capture(re) // null);
def path_of: sub("\\?.*$"; "");
def secs: tonumber / 1000000 | floor;
def rows(o; n): o | to_entries | sort_by(-.value, .key) | if length == 0 then ["  none"]
  else .[0:n] | map("  \(.value)  \(.key)") end;
reduce inputs as $e (
  {n: 0, acc: {}, fail: {}, root: 0, sudo: {}, sudoref: 0, su: {}, audit: {}, units: {}, waf: {}, rules: {},
   a403: {}, air: {n: 0, c4: 0, c5: 0}, egn: 0, egress: {}, sec: {}, warn: {}, bans: {}};
  .n += 1
  | ($e.msg // "") as $m
  | if $e.cat == "ssh" then
      ($m | cap("^Accepted (?<m>\\S+) for (?<u>\\S+) from (?<s>\\S+) port")) as $a
      | if $a then bump(.acc; "\($a.u) from \($a.s) by \($a.m)") | (if $a.u == "root" then .root += 1 else . end)
        else ([$m | capture("^Failed \\S+ for (invalid user )?(?<u>\\S+) from (?<s>\\S+) port"),
                    capture("^Invalid user (?<u>\\S*) from (?<s>\\S+)"),
                    capture("^Connection closed by authenticating user (?<u>\\S+) (?<s>\\S+) port"),
                    capture("^User (?<u>\\S+) from (?<s>\\S+) not allowed"),
                    capture("maximum authentication attempts exceeded for (invalid user )?(?<u>\\S+) from (?<s>\\S+)")]
              | .[0]) as $f
             | if $f then bump(.fail; "\($f.u) from \($f.s)") else . end end
    elif $e.cat == "login" then
      (if $e.ident == "login" and ($m | test("ROOT LOGIN")) then .root += 1 else . end)
    elif $e.cat == "sudo" then
      if $e.ident == "su" then ($m | cap("^\\(to (?<t>\\S+)\\) (?<u>\\S+) on")) as $s
        | if $s then bump(.su; "\($s.u) to \($s.t)") else . end
      elif ($m | test("incorrect password attempt|NOT in sudoers|command not allowed")) then .sudoref += 1
      else ($m | cap("^\\s*(?<u>\\S+) : .*COMMAND=(?<c>.*)$")) as $s
        | if $s then bump(.sudo; "\($s.u): \($s.c[0:100])") else . end end
    elif $e.cat == "auditd" then
      (($m | cap("key=\"(?<k>[^\"]+)\"") | .k?) // null) as $k
      | if $k then ((($m | capture("audit\\([0-9.]+:(?<i>[0-9]+)\\)") | .i) // $e.audit_id // $e.rt) as $id
          | .audit[$k][$id] = 1) else . end
    elif $e.cat == "systemd" then
      ($m | cap("^(?<u>\\S+): Failed with result")) as $f | if $f then bump(.units; $f.u) else . end
    elif $e.cat == "waf" then
      ((($m | try fromjson catch null) // {}) | .msg // "") as $w
      | ($w | cap("\\[id \"(?<id>[0-9]+)\"\\]")) as $id
      | if $id == null then . else
          (($w | capture("\\[unique_id \"(?<u>[^\"]*)\"\\]") | .u) // $e.rt) as $uid
          | (($w | capture("^\\[client \"(?<c>[^\"]*)\"\\]") | .c) // "") as $c
          | (($w | capture("\\[uri \"(?<p>(?:[^\"\\\\]|\\\\.)*)\"\\]") | .p | path_of) // "") as $p
          | (($w | capture("\\[msg \"(?<m>(?:[^\"\\\\]|\\\\.)*)\"\\]") | .m) // "") as $rm
          | .rules[$id.id] = $rm[0:80]
          | .waf[$uid] = ((.waf[$uid] // {t: ($e.rt | secs), k: "\($c) \($p)", r: []}) | .r = (.r + [$id.id] | unique))
        end
    elif $e.cat == "caddy" then
      (($m | if startswith("{") then (try fromjson catch null) else null end) // {}) as $j
      | if (($j.logger // "") | startswith("http.log.access")) then
          (($j.request.uri // "") | path_of) as $p | ($j.status // 0) as $st
          | (if ($p | test("^(/api)?/v1/checkouts/[^/]+/airline-card-completion$")) then
               .air.n += 1 | (if $st >= 500 then .air.c5 += 1 elif $st >= 400 then .air.c4 += 1 else . end)
             else . end)
          | (if $st == 403 then .a403["\($j.request.client_ip // $j.request.remote_ip // "") \($p)"] += [$e.rt | secs]
             else . end)
        else . end
    elif $e.cat == "egress" then
      .egn += 1
      | bump(.egress; ($m | "\((capture("DST=(?<v>\\S+)") | .v) // "?"):\((capture("DPT=(?<v>[0-9]+)") | .v) // "-")/\((capture("PROTO=(?<v>\\S+)") | .v) // "?") by \(((capture("UID=(?<v>[0-9]+)") | .v) // "") as $u | if $u == "" then "the kernel" else ($users[$u] // "uid \($u)") end)"))
    elif $e.cat == "fail2ban" then
      ($m | cap("\\] Ban (?<ip>\\S+)")) as $b | if $b then bump(.bans; $b.ip) else . end
    elif $e.cat == "security" then
      ((($m | try fromjson catch null) // {}) as $j | bump(.sec; "\($j.securityEvent // $j.event // "security event") (\(if $e.unit == "" then $e.ident else $e.unit end))"))
    elif $e.cat == "velexis" then bump(.warn; (if $e.unit == "" then $e.ident else $e.unit end))
    else . end
)
| . as $s
| ($s.waf | to_entries | map(.value as $v
    | $v + {refused: (($s.a403[$v.k] // []) | any(. >= $v.t - 2 and . <= $v.t + 60))})) as $reqs
| ($reqs | map(select(.refused)) | length) as $refused
| ([$reqs[] | .r[]] | unique) as $ids
| ($ids | map(. as $id | {id: $id, n: ([$reqs[] | select(.r | index($id))] | length),
    x: ([$reqs[] | select(.refused and (.r | index($id)))] | length)}) | sort_by(-.n, .id)) as $byrule
| ($s.acc | add // 0) as $logins
| ($s.sudo | add // 0) as $sudos
| "\($logins) SSH login(s), \($s.root) as root, \($sudos) sudo command(s), \($reqs | length) WAF match(es) (\($refused) refused), \($s.egn) refused outbound connection(s)",
  "",
  "SSH logins accepted (count, user, source, method):", rows($s.acc; 30)[],
  "SSH logins refused (count, user, source):", rows($s.fail; 20)[],
  "Root logins: \($s.root)",
  "sudo commands (count, user: command):", rows($s.sudo; 40)[],
  "sudo refusals: \($s.sudoref)",
  "su sessions (count, user to user):", rows($s.su; 20)[],
  "auditd events by watched key (count, key):",
  (($watched | split(" ") | map({key: ., value: ($s.audit[.] // {} | length)}) | from_entries)
    + ($s.audit | map_values(length)) | to_entries | sort_by(.key) | map("  \(.value)  \(.key)") | .[]),
  "AIDE: \($aide)",
  "Unit failures (count, unit):", rows($s.units; 30)[],
  "Web application firewall: \($reqs | length) request(s) matched a rule, \($refused) refused with 403 (count matched, refused, rule):",
  (if ($byrule | length) == 0 then "  none" else ($byrule[0:30][] | "  \(.n)  \(.x)  \(.id) \($s.rules[.id] // "")") end),
  "Airline-card route (/v1/checkouts/{id}/airline-card-completion): \($s.air.n) request(s), \($s.air.c4) 4xx, \($s.air.c5) 5xx",
  "Refused outbound connections (VELEXIS-EGRESS-DENY, at most 10 a minute are logged): \($s.egn) (count, destination, user):",
  rows($s.egress; 30)[],
  "fail2ban bans (count, source):", rows($s.bans; 20)[],
  "Security events of the apps (count, event, unit):", rows($s.sec; 30)[],
  "Warnings and errors of the velexis-* units (count, unit):", rows($s.warn; 30)[]
'
jq -rn --argjson users "$users_json" --arg watched "$WATCHED_KEYS" --arg aide "$AIDE_NOTE" "$SUMMARY" \
  "$WORK/day.jsonl" >"$WORK/summary-lines" || die "could not build the summary"
sec_files="$(find "$SEC_DIR" -maxdepth 1 -type f -name 'security-*.jsonl.zst' 2>/dev/null | wc -l)"
{
  echo "Security log review of $(hostname), $(iso "$FROM") to $(iso "$NOW") (UTC)."
  echo
  echo "$(head -n 1 "$WORK/summary-lines")."
  echo
  echo "Log shipment: $SHIP_NOTE ($(cat "$STATE_DIR/shipment" 2>/dev/null || echo unknown))."
  echo "Security log folder $(show "$SEC_DIR"): $((sec_bytes / 1024 / 1024)) MiB in $sec_files daily file(s) (alert above 5 GB)."
  echo "Immediate alerts of this run: $ALERTS (each was sent on its own)."
  tail -n +2 "$WORK/summary-lines"
} >"$WORK/summary"
send "security log review $TODAY: $(head -n 1 "$WORK/summary-lines")" "$WORK/summary" \
  || die "velexis-alert could not send the daily summary; the next run sends it again"
jq -nc --arg day "$TODAY" '{security: true, event: "log_review.summary", day: $day}'
echo "$TODAY" >"$STATE_DIR/summary-day"
log "daily summary of $TODAY sent"
