#!/usr/bin/env bash
# =====================================================================================================
# ship-logs.sh — ship the VM's security logs off the VM every hour (task X-038; PCI DSS 10.3.3, 10.5.1; ADR-0027 rows
# 10.x). Root-owned copy: /usr/local/sbin/velexis-shiplogs, run by velexis-ship-logs.service (velexis-ship-logs.timer,
# every hour at :05). Installed by provision-vm.sh (step scripts, which also enables the timer) and by every deploy.
# Docs: docs/mvp/deployment-single-vm.md §12.
#
#   velexis-shiplogs           ship the security entries the journal got since the saved cursor (the timer)
#   velexis-shiplogs --status  the last shipment, the last failure and the daily files (changes nothing)
#   velexis-shiplogs export [--cursor-file <file>] [--since <epoch>] [--until <epoch>]
#                              print the security entries of the journal, one JSON line each, as they are shipped
#                              (velexis-logreview reads them this way); with --cursor-file, only the entries after
#                              the cursor in that file, and the file then holds the cursor of the last entry read
#
# What is shipped (step 1 of X-038): every journal entry of sshd, sudo and su, login and systemd-logind, auditd (its
# syslog plugin, audisp-syslog, which provision-vm.sh turns on, and the kernel's audit records if journald keeps them),
# Caddy (access logs and the web application firewall's lines, logger http.handlers.waf, X-039), the kernel's refused
# outbound connections (prefix VELEXIS-EGRESS-DENY, X-041), fail2ban, AIDE's daily check, systemd's own warnings about
# units (a unit that failed), the velexis-* units' lines at warning and above (journald priority 4 or lower, or a JSON
# line whose pino level is 40 or more) and every JSON line that marks a security event ("security":true, or the
# "securityEvent" field the backends log). Each becomes one JSON line {"ts","rt","host","cat","unit","ident","pid",
# "uid","prio","msg"} (cat: ssh, sudo, login, auditd, egress, caddy, waf, fail2ban, aide, security, velexis, systemd).
# Of Caddy only its access lines (loggers http.log.access.*, whose secrets and personal query values the Caddyfile's
# filter deletes) and the WAF's lines are shipped, never its other lines: its error log (http.log.error.*: a handler's
# error, such as an unreachable upstream, with the request that caused it, filtered as the access lines are since lead
# decision (20q) of 2026-11-13) and, on a VM whose Caddy still runs with the caddy package's `caddy run --environ`, the
# environment it prints at start (VELEXIS_EDGE_SECRET among it; the repository's drop-in drops --environ). A Caddy line longer than journald's LineMax (48K) reaches the journal in parts
# that are no JSON; the first part of an access or WAF line is shipped as a note with its length, the others not at
# all. journalctl runs with --all: without it, its JSON output turns every field of 4096 bytes or more into null, and
# a long access or WAF line would be shipped empty.
#
# The WAF's query values (lead decision (17i) of 2026-11-11): Coraza quotes the matched request's path and query in
# `[uri "…"]`, so a signed URL's sig, a link's token or a Stripe client secret of a request that also carried an
# attack-shaped value would reach the WAF's line. Every value of that query is blanked before an entry is written
# anywhere (`?sig=&token=`: the parameter names and the path kept; a percent-encoded, repeated or empty value, and a
# part without `=`, which is dropped whole, included; and a path or name with non-ASCII characters, which is why the
# query is cut with split, never with jq 1.7's index/1, which counts bytes where slices count characters), so no chunk
# in the bucket and no daily file holds one; the rest of the line is unchanged byte for byte. The values stay only in
# the VM's own journald (ota/docs/pci/README.md §8 item 7).
#
# Each run, under a lock: the entries after the saved journald cursor (state: /var/lib/velexis/ship-logs/cursor; the
# first run, without a cursor, takes the last 24 hours, and older entries stay in journald for its 30 days) become the
# hour's chunk, compressed (zstd) and encrypted with age to the data key of the backups (AGE_RECIPIENTS_FILE of
# /etc/velexis/backup.env; public keys only, the private half stays off the VM), and uploaded with
# `rclone copy --immutable` to <RCLONE_REMOTE>/logs/<yyyy>/<mm>/<dd>/ (the backup bucket: its endpoint is already on
# the outbound allow-list, rclone:backup.env) as security-<UTC stamp>-<sha256>.jsonl.zst.age.
# Only after `rclone check` confirms the upload is the cursor saved and are the entries appended to the daily file of
# their UTC day, /var/log/velexis/security/security-<yyyy-mm-dd>.jsonl.zst (zstd frames, root 0600, kept 90 days, so
# the last three months stay on the VM). A failed upload saves nothing: the run exits 1 (OnFailure= mails it), and the
# next run ships the missed entries with the new ones, exactly once. (Should the copy succeed and only `rclone check`
# fail, the bucket holds those entries twice, in two chunks, but never none.) A run whose entries hold nothing to ship
# saves the cursor. The bucket keeps the chunks 12 months (its lifecycle rule for logs/ and object lock, a human step:
# deployment-single-vm.md §12); the VM's key cannot delete, and this script never removes anything remotely.
# SECURITY_LOG_LOCK_DAYS=<days> (backup.env, optional) also asks the bucket to lock each chunk that long (S3 object
# lock headers, GOVERNANCE mode), for buckets whose default retention is shorter (the backups' 14 days).
# State files for velexis-log-review and --status: last-success ("<epoch> <entries> <object>") and last-failure
# ("<epoch> <reason>", removed by the next success).
#
# Tests only (deploy/scripts/test/ship-logs.test.sh, log-review.test.sh). With VELEXIS_ROOT=<absolute folder>,
# /etc/velexis, /var/lib/velexis and /var/log/velexis move under that folder, the script runs without root, and
# JOURNALCTL names the stand-in for journalctl (required). SHIP_FIRST_SINCE (epoch seconds) replaces the start of the
# first run's 24 hours. rclone, age and zstd come from PATH. Without VELEXIS_ROOT (the VM) both have no effect.
# =====================================================================================================
set -euo pipefail
umask 077

NAME=velexis-shiplogs
: "${VELEXIS_ROOT:=}"
R="$VELEXIS_ROOT"
if [ -n "$R" ]; then
  case "$R" in /?*) ;; *) echo "$NAME: VELEXIS_ROOT must be an absolute path other than /" >&2; exit 2 ;; esac
  [ -d "$R" ] || { echo "$NAME: VELEXIS_ROOT $R is not a folder" >&2; exit 2; }
  [ -n "${JOURNALCTL:-}" ] || { echo "$NAME: with VELEXIS_ROOT, JOURNALCTL must name the stand-in for journalctl" >&2; exit 2; }
  FIRST_SINCE="${SHIP_FIRST_SINCE:-}"
  [[ "$FIRST_SINCE" =~ ^([0-9]{1,12})?$ ]] || { echo "$NAME: SHIP_FIRST_SINCE must be epoch seconds" >&2; exit 2; }
else
  JOURNALCTL=journalctl
  FIRST_SINCE=""
fi

ETC="$R/etc/velexis"
STATE_DIR="$R/var/lib/velexis/ship-logs"
LOG_DIR="$R/var/log/velexis/security"
KEEP_DAYS=90       # on the VM: three months (PCI DSS 10.5.1); the bucket keeps 12
FIRST_RUN_WINDOW=86400 # the first run, without a cursor, ships the last 24 hours
REMOTE_PREFIX=logs # <RCLONE_REMOTE>/logs/<yyyy>/<mm>/<dd>/

log() { printf '%s\n' "$*"; }
die() { printf '%s: ERROR: %s\n' "$NAME" "$*" >&2; exit 1; }
usage() {
  echo "usage: $NAME [--status] | $NAME export [--cursor-file <file>] [--since <epoch>] [--until <epoch>]" >&2
  exit 2
}
show() { printf '%s' "${1#"$R"}"; } # a path as on the VM

# ---- the security entries of the journal --------------------------------------------------------------------------
# One journalctl JSON object in, at most one record out. jq 1.7 (Ubuntu 24.04).
# shellcheck disable=SC2016 # a jq program: its $names are jq's
FILTER='
def text: if . == null then ""
  elif type == "string" then .
  elif type == "array" then
    (if length > 0 and (.[0] | type) == "number"
     then map(if (. >= 32 and . < 127) or . == 9 then . else 63 end) | implode
     else map(tostring) | join(" ") end)
  else tostring end;
def int: (tonumber? // 99);
def payload: if startswith("{") then (try fromjson catch null) else null end;
# The query of a Go-quoted [uri "..."] value: every value blanked, the names and the path kept. Cut with split only:
# jq 1.7 index/1 counts bytes and slices count characters, so a non-ASCII path or name would leave part of a value.
def blankq: split("?") as $s
  | if ($s | length) < 2 then .
    else $s[0] + "?" + ($s[1:] | join("?") | split("&")
      | map(if contains("=") then (split("=") | .[0]) + "=" else "" end) | join("&")) end;
def blankuri: gsub("\\[uri \"(?<u>(?:[^\"\\\\]|\\\\.)*)\"\\]"; "[uri \"\(.u | blankq)\"]");
# A message with a [uri]: Caddy writes the WAF line as JSON, its msg holding the [uri]. Only the msg text inside the
# line changes; when it cannot be found as written, the line is written again from its parsed form (still blanked).
def blankmsg:
  if contains("[uri ") | not then .
  else . as $raw | payload as $p
    | if ($p | type) == "object" and ($p.msg | type) == "string" and ($p.msg | contains("[uri ")) then
        ($p.msg | tojson) as $old | ($p.msg | blankuri | tojson) as $new
        | if ($raw | index($old)) != null then ($raw | split($old) | join($new))
          else ($p | .msg |= blankuri | tojson) end
      else blankuri end
  end;
def category:
  (.SYSLOG_IDENTIFIER | text) as $i | (._SYSTEMD_UNIT | text) as $u | (.MESSAGE | text) as $m
  | (._TRANSPORT | text) as $t | (.PRIORITY | text | int) as $p | ($m | payload) as $j
  | if $i == "sshd" or $i == "sshd-session" or $u == "ssh.service" or $u == "sshd.service" then "ssh"
    elif $i == "sudo" or $i == "su" then "sudo"
    elif $i == "login" or $i == "systemd-logind" then "login"
    elif $t == "audit" or $i == "audisp-syslog" or $i == "auditd" or $i == "augenrules" or $u == "auditd.service" then "auditd"
    elif $t == "kernel" and ($m | contains("VELEXIS-EGRESS-DENY")) then "egress"
    elif $u == "caddy.service" then
      # Its access and WAF lines only (the header says why); a first part of one that journald split is no JSON.
      (if ($j | type) == "object" then ($j.logger | if type == "string" then . else "" end) else "" end) as $l
      | if $l == "http.handlers.waf" then "waf"
        elif ($l | startswith("http.log.access")) then "caddy"
        elif ($j | type) == "object" or ($m | startswith("{\"") | not) then empty
        elif ($m | contains("\"logger\":\"http.handlers.waf\"")) then "waf"
        elif ($m | contains("\"logger\":\"http.log.access")) then "caddy"
        else empty end
    elif $i == "fail2ban-server" or $u == "fail2ban.service" then "fail2ban"
    elif $i == "dailyaidecheck" or $u == "dailyaidecheck.service" then "aide"
    elif ($j | type) == "object" and ($j.security == true or ($j.securityEvent | type) == "string") then "security"
    elif ($u | startswith("velexis-")) or ($i | startswith("velexis-")) then
      (if $p <= 4 or (($j | type) == "object" and
          ((($j.level | type) == "number" and $j.level >= 40) or ($j.level | IN("warn", "error", "fatal"))))
       then "velexis" else empty end)
    elif ((._PID | text) == "1" or $i == "systemd") and $p <= 4 then "systemd"
    else empty end;
category as $cat
| (.__REALTIME_TIMESTAMP | text) as $rt
| (.MESSAGE | text) as $m
| (if ($cat == "caddy" or $cat == "waf") and ($m | payload | type) != "object"
   then "(the first part, \($m | length) characters, of a Caddy line that journald split: its text is not shipped;"
     + " journalctl -u caddy on the VM holds it)"
   else $m | blankmsg end) as $msg
| {ts: (($rt | tonumber? // 0) / 1000000 | floor | todate), rt: $rt, host: (._HOSTNAME | text), cat: $cat,
   unit: (._SYSTEMD_UNIT | text), ident: (.SYSLOG_IDENTIFIER | text), pid: (._PID | text), uid: (._UID | text),
   prio: (.PRIORITY | text), msg: $msg}
  + (if ._AUDIT_ID then {audit_id: (._AUDIT_ID | text)} else {} end)
  + (if .UNIT then {about: (.UNIT | text)} else {} end)
'

export_entries() { # [--cursor-file <file>] [--since <epoch>] [--until <epoch>] -> one record per line on stdout
  # --all: without it journalctl's JSON output turns every field of 4096 bytes or more into null (a long access or WAF
  # line would be shipped empty).
  local args=(--system --quiet --no-pager --output=json --all)
  while [ $# -gt 0 ]; do
    case "$1" in
      --cursor-file)
        if [ $# -lt 2 ] || [ -z "$2" ]; then usage; fi
        args+=("--cursor-file=$2")
        shift 2 ;;
      --since | --until)
        if [ $# -lt 2 ] || ! [[ "$2" =~ ^[0-9]{1,12}$ ]]; then usage; fi
        args+=("$1=@$2")
        shift 2 ;;
      *) usage ;;
    esac
  done
  # Only JSON lines reach jq (journalctl's own notes would not parse); a journal jq cannot read fails the run.
  "$JOURNALCTL" "${args[@]}" | awk '/^\{/' | jq -c "$FILTER"
}

# ---- state --------------------------------------------------------------------------------------------------------
record_failure() { # reason
  printf '%s %s\n' "$(date -u +%s)" "$1" >"$STATE_DIR/last-failure.new"
  mv -f "$STATE_DIR/last-failure.new" "$STATE_DIR/last-failure"
}
record_success() { # entries object
  printf '%s %s %s\n' "$(date -u +%s)" "$1" "$2" >"$STATE_DIR/last-success.new"
  mv -f "$STATE_DIR/last-success.new" "$STATE_DIR/last-success"
  rm -f "$STATE_DIR/last-failure"
}
fail() { record_failure "$1"; die "$1"; }

status() {
  local line when rest files size
  if line="$(cat "$STATE_DIR/last-success" 2>/dev/null)" && [ -n "$line" ]; then
    read -r when rest <<<"$line"
    log "last shipment: $(date -u -d "@$when" +%Y-%m-%dT%H:%M:%SZ) ($rest)"
  else
    log "last shipment: none"
  fi
  if line="$(cat "$STATE_DIR/last-failure" 2>/dev/null)" && [ -n "$line" ]; then
    read -r when rest <<<"$line"
    log "last failure: $(date -u -d "@$when" +%Y-%m-%dT%H:%M:%SZ): $rest"
  fi
  if [ -s "$STATE_DIR/cursor" ]; then log "cursor: saved"; else log "cursor: none (the next run takes the last 24 hours of the journal)"; fi
  files="$(find "$LOG_DIR" -maxdepth 1 -type f -name 'security-*.jsonl.zst' 2>/dev/null | wc -l)"
  size="$(du -sh "$LOG_DIR" 2>/dev/null | cut -f1 || true)"
  log "daily files in $(show "$LOG_DIR"): $files (${size:-0})"
}

# ---- shipping -----------------------------------------------------------------------------------------------------
load_settings() {
  if [ -z "${RCLONE_REMOTE:-}" ] && [ -f "$ETC/backup.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$ETC/backup.env"
    set +a
  fi
  : "${AGE_RECIPIENTS_FILE:?set in /etc/velexis/backup.env}"
  : "${RCLONE_CONFIG:?set in /etc/velexis/backup.env}"
  : "${RCLONE_REMOTE:?set in /etc/velexis/backup.env}"
  : "${SECURITY_LOG_LOCK_DAYS:=}"
  export RCLONE_CONFIG
  [[ "$SECURITY_LOG_LOCK_DAYS" =~ ^([1-9][0-9]{0,3})?$ ]] || die "SECURITY_LOG_LOCK_DAYS must be empty or a number of days"
  # The data key of the backups: public keys only, as backup.sh checks them.
  local f="$AGE_RECIPIENTS_FILE"
  [ -r "$f" ] || die "cannot read $f (deployment-single-vm.md §10)"
  if grep -qE 'AGE-SECRET-KEY-1[0-9A-Z]{58}' "$f"; then
    die "$f holds a PRIVATE age key: only public keys (age1...) belong on the VM"
  fi
  grep -qE '^age1[0-9a-z]+' "$f" || die "no age public key in $f (deployment-single-vm.md §10)"
  awk '!/^[[:space:]]*(#|$)/ && !/^age1[0-9a-z]+[[:space:]]*$/ { bad = 1 } END { exit bad }' "$f" \
    || die "$f may hold only age1 public keys, comments and empty lines"
}

append_daily() { # chunk: each record to the daily file of its own UTC day, one zstd frame per day and run
  local chunk="$1" day
  cut -c8-17 "$chunk" | LC_ALL=C sort -u | while read -r day; do
    [[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "a record without its day in $chunk"
    awk -v p="{\"ts\":\"$day" 'substr($0, 1, length(p)) == p' "$chunk" | zstd -q -c >>"$LOG_DIR/security-$day.jsonl.zst"
  done
}

prune_daily() { # daily files older than KEEP_DAYS, by the day in their name
  local cutoff f day
  cutoff="$(date -u -d "-$KEEP_DAYS days" +%F)"
  for f in "$LOG_DIR"/security-????-??-??.jsonl.zst; do
    [ -f "$f" ] || continue
    day="${f##*/security-}"
    day="${day%.jsonl.zst}"
    if [[ "$day" < "$cutoff" ]]; then rm -f "$f" && log "removed $(show "$f") (older than $KEEP_DAYS days)"; fi
  done
}

ship() {
  local work stamp entries name dest sha lock_args=()
  load_settings
  [ -n "$R" ] || [ "$(id -u)" -eq 0 ] || die "run as root"
  install -d -m 0700 "$STATE_DIR" "$LOG_DIR"
  exec 8>"$STATE_DIR/lock"
  flock -n 8 || { log "another run is shipping; this one stops"; return 0; }
  work="$(mktemp -d "$STATE_DIR/run.XXXXXX")"
  # shellcheck disable=SC2064 # the folder of this run
  trap "rm -rf '$work'" EXIT
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  if [ -s "$STATE_DIR/cursor" ]; then
    cp "$STATE_DIR/cursor" "$work/cursor"
    export_entries --cursor-file "$work/cursor" >"$work/chunk.jsonl" || fail "could not read the journal"
  else
    export_entries --cursor-file "$work/cursor" --since "${FIRST_SINCE:-$(($(date -u +%s) - FIRST_RUN_WINDOW))}" \
      >"$work/chunk.jsonl" || fail "could not read the journal"
  fi
  entries="$(wc -l <"$work/chunk.jsonl")"
  if [ "$entries" -eq 0 ]; then
    # Nothing to ship: the cursor may move on, nothing is lost.
    if [ -s "$work/cursor" ]; then mv -f "$work/cursor" "$STATE_DIR/cursor"; fi
    record_success 0 none
    log "no new security entries"
    prune_daily
    return 0
  fi
  [ -s "$work/cursor" ] || fail "journalctl gave entries but no cursor"
  sha="$(sha256sum "$work/chunk.jsonl" | cut -c1-12)"
  name="security-$stamp-$sha.jsonl.zst.age"
  mkdir "$work/out"
  zstd -q -c -6 "$work/chunk.jsonl" | age -R "$AGE_RECIPIENTS_FILE" -o "$work/out/$name" \
    || fail "could not compress and encrypt the chunk"
  dest="$RCLONE_REMOTE/$REMOTE_PREFIX/${stamp:0:4}/${stamp:4:2}/${stamp:6:2}"
  if [ -n "$SECURITY_LOG_LOCK_DAYS" ]; then
    lock_args=(--header-upload "x-amz-object-lock-mode: GOVERNANCE"
      --header-upload "x-amz-object-lock-retain-until-date: $(date -u -d "+$SECURITY_LOG_LOCK_DAYS days" +%Y-%m-%dT%H:%M:%SZ)")
  fi
  if ! rclone copy "$work/out" "$dest" --immutable --retries 3 "${lock_args[@]}" ||
    ! rclone check "$work/out" "$dest" --one-way; then
    fail "the upload of $name ($entries entries) to $dest failed; the cursor stays, so the next run ships these entries again"
  fi
  # Verified: from now on these entries are off the VM.
  mv -f "$work/cursor" "$STATE_DIR/cursor"
  append_daily "$work/chunk.jsonl"
  record_success "$entries" "$name"
  prune_daily
  log "shipped $entries entries to $dest/$name"
}

case "${1:-}" in
  "") ship ;;
  --status) [ $# -eq 1 ] || usage; status ;;
  export) shift; export_entries "$@" ;;
  *) usage ;;
esac
