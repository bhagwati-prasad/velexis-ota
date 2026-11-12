#!/usr/bin/env bash
# =====================================================================================================
# ship-logs.test.sh — tests deploy/scripts/ship-logs.sh (velexis-shiplogs) without root, systemd, a journal or a bucket
# (task X-038).
#
#   bash deploy/scripts/test/ship-logs.test.sh
#
# Needs bash, jq 1.7, age and age-keygen, zstd, rclone (1.60 or newer), flock, sha256sum and GNU coreutils (Linux:
# Ubuntu 24.04 like the VM). No root, no network; a few seconds.
#
# ship-logs.sh runs exactly as it is, with the test overrides of its header:
#   VELEXIS_ROOT   a temporary folder laid out like the VM: /etc/velexis/backup (the age recipients file with the public
#                  half of a key pair made here, and rclone.conf), /var/lib/velexis and /var/log/velexis
#   JOURNALCTL     a fake journalctl that prints the entries of a fake journal export (JSON lines as `journalctl -o json`
#                  writes them, each with a __CURSOR) after the cursor of --cursor-file and writes the cursor of the last
#                  entry back, as journalctl does; --since and --until filter on __REALTIME_TIMESTAMP; without --all a
#                  field of 4096 bytes or more is null, as journalctl's JSON output makes it
# and a wrapper first on PATH that runs the real rclone against a `local` remote (the bucket is a folder), refuses and
# records every command that could delete or replace, and fails `copy` while the flag file rclone-fails exists.
#
# Cases (docs/mvp/plans/foundation-tasks.md, X-038; a check that proves an acceptance criterion ends in [X-038 AC<n>]):
#    1. the first run ships what is security-relevant and nothing else (sshd, sudo, su, logind, auditd, the kernel's
#       VELEXIS-EGRESS-DENY lines, Caddy's access and WAF lines, fail2ban, AIDE, systemd's unit failures, the velexis-*
#       units at warning and above, security events at any level; never Caddy's environment of `caddy run --environ`,
#       its error log or its TLS lines), as one encrypted chunk under logs/<yyyy>/<mm>/<dd>/ that decrypts with the
#       private key alone; the same records go to the daily file of each entry's own UTC day (two days here),
#       root-only; the cursor is the last entry read;
#    2. the WAF's [uri] (AC2, lead decision (17i)): every query value blanked, a percent-encoded, repeated, empty and
#       Go-escaped one, a part without `=` and one after a non-ASCII path and name included, the names and the path
#       kept, and the rest of the line unchanged byte for byte; a line above 4096 bytes is shipped whole (the fake
#       journalctl, like the real one, makes it null without --all); a Caddy line written with other JSON escapes is
#       blanked too; the first part of a WAF line that journald split is a note without its text; no value is in any
#       chunk or daily file;
#    3. a run with nothing new ships nothing and keeps the cursor;
#    4. an upload that fails keeps the cursor, the daily files and the bucket as they were and exits 1; the next run
#       ships the missed entries with the new ones, every entry exactly once in the bucket and in the daily files (AC1);
#    5. a journal that cannot be read and a private age key in the recipients file change nothing and exit 1;
#       SECURITY_LOG_LOCK_DAYS sends the object lock headers; a wrong value is refused;
#    6. daily files older than 90 days are removed, newer ones kept; --status; a run that finds the lock taken stops;
#   and over the whole run: rclone never got a command that deletes or replaces, every upload is --immutable.
#
# Settings (environment): SHIP_LOGS_TEST_TMPDIR (parent of the temporary folder; default TMPDIR or /tmp),
# SHIP_LOGS_TEST_KEEP=1 (keep the temporary folder: the VM tree, the bucket, every output in out/).
# =====================================================================================================
set -euo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIP="$(cd "$HERE/.." && pwd)/ship-logs.sh"

FAILED=0
LOG_SHOWN=""
pass() { printf 'PASS %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*"
  FAILED=1
  if [ -n "${LAST_OUT:-}" ] && [ "$LOG_SHOWN" != "$LAST_OUT" ]; then
    LOG_SHOWN="$LAST_OUT"
    echo "     output of the last ship-logs.sh run ($(basename "$LAST_OUT"), exit $RC):"
    sed -e "s#$PREFIX#<tmp>#g" -e 's/^/       /' "$LAST_OUT"
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
jqe() { jq -e "$@" >/dev/null; } # a jq condition over a file

for tool in jq age age-keygen zstd rclone flock sha256sum awk; do
  command -v "$tool" >/dev/null || die "$tool is missing"
done
[ -f "$SHIP" ] || die "run it from a checkout of the repository"

PREFIX="$(mktemp -d "${SHIP_LOGS_TEST_TMPDIR:-${TMPDIR:-/tmp}}/velexis-ship-logs-test.XXXXXX")"
PREFIX="$(cd "$PREFIX" && pwd -P)"
ROOT="$PREFIX/root"     # the VM
FAKE="$PREFIX/fake"     # the fake journal, the flags and the records of the stand-ins
FAKEBIN="$PREFIX/bin"   # journalctl, rclone
BUCKET="$PREFIX/bucket" # the off-site bucket (rclone local remote)
KEYS="$PREFIX/keys"     # the private age key, off the "VM"
OUT="$PREFIX/out"       # every output of ship-logs.sh
mkdir -p "$ROOT/etc/velexis/backup" "$ROOT/var/lib/velexis" "$ROOT/var/log/velexis" "$FAKE" "$FAKEBIN" "$BUCKET" \
  "$KEYS" "$OUT"
: >"$FAKE/journal.jsonl"
: >"$FAKE/rclone.calls"
: >"$FAKE/rclone.refused"

cleanup() {
  local rc=$?
  if [ "${SHIP_LOGS_TEST_KEEP:-0}" = 1 ]; then
    echo "SHIP_LOGS_TEST_KEEP=1: kept $PREFIX"
  else
    rm -rf --one-file-system "$PREFIX"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

STATE="$ROOT/var/lib/velexis/ship-logs"
SECDIR="$ROOT/var/log/velexis/security"
age-keygen -o "$KEYS/data.key" 2>/dev/null
age-keygen -y "$KEYS/data.key" >"$ROOT/etc/velexis/backup/data-recipients.txt"
printf '[offsite]\ntype = local\n' >"$ROOT/etc/velexis/backup/rclone.conf"
REAL_RCLONE="$(command -v rclone)"

# ---- the stand-ins ------------------------------------------------------------------------------------------------
cat >"$FAKEBIN/journalctl" <<'SH'
#!/usr/bin/env bash
# Fake journalctl: the entries of $FAKE_STATE/journal.jsonl after the cursor of --cursor-file (then the last entry's
# cursor is written to it), filtered by --since/--until (@epoch). Fails while $FAKE_STATE/journal-fails exists.
# Without --all, a field of 4096 bytes or more (its name, "=" and its value) comes out as null, as journalctl's JSON
# output does.
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
printf '%s\n' "$*" >>"$FAKE_STATE/journalctl.calls"
if [ -e "$FAKE_STATE/journal-fails" ]; then echo "fake journalctl: cannot open the journal" >&2; exit 1; fi
after=""
if [ -n "$cursor_file" ] && [ -s "$cursor_file" ]; then after="$(cat "$cursor_file")"; fi
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
cat >"$FAKEBIN/rclone" <<SH
#!/usr/bin/env bash
# rclone wrapper: the real rclone ($REAL_RCLONE), but never a command that could delete or replace an object.
printf '%s\n' "\$*" >>"\$FAKE_STATE/rclone.calls"
case "\${1:-}" in
  copy | check | lsf | lsl | ls | cat | version) ;;
  *) printf '%s\n' "\$*" >>"\$FAKE_STATE/rclone.refused"; echo "rclone wrapper: refused: \$1" >&2; exit 9 ;;
esac
if [ "\$1" = copy ] && [ -e "\$FAKE_STATE/rclone-fails" ]; then echo "rclone wrapper: upload failed (test)" >&2; exit 1; fi
exec "$REAL_RCLONE" "\$@"
SH
chmod +x "$FAKEBIN/journalctl" "$FAKEBIN/rclone"

N=0
RUN=0
RC=0
run_ship() { # [args...] -> RC, LAST_OUT
  RUN=$((RUN + 1))
  LAST_OUT="$OUT/run-$RUN.out"
  RC=0
  env VELEXIS_ROOT="$ROOT" JOURNALCTL="$FAKEBIN/journalctl" FAKE_STATE="$FAKE" PATH="$FAKEBIN:$PATH" \
    RCLONE_CONFIG="$ROOT/etc/velexis/backup/rclone.conf" RCLONE_REMOTE="offsite:$BUCKET" \
    AGE_RECIPIENTS_FILE="$ROOT/etc/velexis/backup/data-recipients.txt" \
    SECURITY_LOG_LOCK_DAYS="${LOCK_DAYS:-}" SHIP_FIRST_SINCE="$((BASE - 60))" bash "$SHIP" "$@" >"$LAST_OUT" 2>&1 || RC=$?
}
add_entry() { # json-object [seconds after BASE]: one journal entry with the next cursor
  N=$((N + 1))
  local at="${2:-$N}"
  jq -c --arg c "c$N" --arg rt "$(((BASE + at) * 1000000 + 123456))" \
    '{__CURSOR: $c, __REALTIME_TIMESTAMP: $rt, _HOSTNAME: "vm-test", _PID: "4242", _UID: "0"} + .' <<<"$1" \
    >>"$FAKE/journal.jsonl"
}
plain() { # unit identifier priority transport message -> json object
  jq -nc --arg u "$1" --arg i "$2" --arg p "$3" --arg t "$4" --arg m "$5" \
    '{PRIORITY: $p, _TRANSPORT: $t, MESSAGE: $m} + (if $u == "" then {} else {_SYSTEMD_UNIT: $u} end)
     + (if $i == "" then {} else {SYSLOG_IDENTIFIER: $i} end)'
}
waf_msg() { # Go-quoted uri content -> the msg of a WAF line, as coraza-caddy writes it
  printf '[client "198.51.100.23"] Coraza: Warning. SQL Injection Attack Detected via libinjection [file "@owasp_crs/REQUEST-942-APPLICATION-ATTACK-SQLI.conf"] [line "5206"] [id "942100"] [rev ""] [msg "SQL Injection Attack Detected via libinjection"] [data "ARGS:id"] [severity "critical"] [ver "OWASP_CRS/4.7.0"] [maturity "0"] [accuracy "0"] [tag "attack-sqli"] [tag "paranoia-level/1"] [hostname ""] [uri "%s"] [unique_id "UID%s"]' "$1" "$2"
}
caddy_waf_line() { # Go-quoted uri content, unique id -> Caddy's JSON line with that msg
  jq -nc --arg msg "$(waf_msg "$1" "$2")" '{level: "error", ts: 1794510757.3796947, logger: "http.handlers.waf", msg: $msg} | tojson' | jq -r .
}
objects() { find "$BUCKET" -type f -name '*.jsonl.zst.age' | LC_ALL=C sort; }
object_count() { objects | wc -l; }
decrypt() { [ -f "$1" ] || return 1; age -d -i "$KEYS/data.key" "$1" </dev/null | zstd -dc; } # never reads stdin
all_shipped() { local o; for o in $(objects); do decrypt "$o"; done; }
daily_all() { local f; for f in "$SECDIR"/security-*.jsonl.zst; do [ -f "$f" ] && zstd -dc "$f"; done; }
cursor() { cat "$STATE/cursor" 2>/dev/null || echo none; }

# The entries start 5 seconds before today's midnight (UTC), so the first ones belong to yesterday's daily file.
TODAY="$(date -u +%F)"
YESTERDAY="$(date -u -d "$TODAY -1 day" +%F)"
BASE=$(($(date -u -d "$TODAY 00:00:00" +%s) - 6))
MARK="x038$(od -An -tx1 -N6 /dev/urandom | tr -d ' \n')" # in every value that must never leave the VM

# ---- 1 and 2. the first run ---------------------------------------------------------------------------------------
step "First run: what is shipped, the chunk, the daily files, the cursor"
SHIPPED_CATS=()
ship_entry() { add_entry "$1"; SHIPPED_CATS+=("$2"); }
# Before the first run's window (SHIP_FIRST_SINCE, the 24 hours of the VM): stays in journald, never shipped.
add_entry "$(plain ssh.service sshd 6 syslog "Accepted publickey for ubuntu from 203.0.113.1 port 49000 ssh2: ED25519 SHA256:old")" -3600
ship_entry "$(plain ssh.service sshd 6 syslog "Accepted publickey for ubuntu from 203.0.113.10 port 50000 ssh2: ED25519 SHA256:abc")" ssh
ship_entry "$(plain ssh.service sshd 6 syslog "Invalid user admin from 198.51.100.7 port 41000")" ssh
ship_entry "$(plain "" sudo 5 syslog "ubuntu : TTY=pts/0 ; PWD=/home/ubuntu ; USER=root ; COMMAND=/usr/bin/systemctl restart caddy")" sudo
ship_entry "$(plain "" su 5 syslog "(to root) ubuntu on pts/0")" sudo
ship_entry "$(plain systemd-logind.service systemd-logind 6 journal "New session 7 of user ubuntu.")" login
add_entry "$(plain cron.service CRON 6 syslog "(root) CMD (command -v debian-sa1 > /dev/null)")"                   # not shipped
ship_entry "$(plain auditd.service audisp-syslog 6 syslog 'type=SYSCALL msg=audit(1794510757.370:1234): arch=c000003e syscall=257 success=yes comm="cp" exe="/usr/bin/cp" auid=1000 uid=0 key="velexis-config"')" auditd
ship_entry '{"_TRANSPORT":"audit","_AUDIT_ID":"1235","_AUDIT_TYPE":"1300","MESSAGE":"SYSCALL arch=c000003e syscall=82 key=\"velexis-keys\""}' auditd
ship_entry "$(plain "" kernel 4 kernel "VELEXIS-EGRESS-DENY IN= OUT=eth0 SRC=10.0.0.5 DST=93.184.216.34 LEN=60 PROTO=TCP SPT=40000 DPT=443 UID=998 GID=998")" egress
add_entry "$(plain "" kernel 6 kernel "eth0: Link is Up - 1Gbps/Full")"                                              # not shipped
ship_entry "$(plain caddy.service caddy 6 stdout '{"level":"info","ts":1794510757.1,"logger":"http.log.access.log0","msg":"handled request","request":{"client_ip":"198.51.100.23","method":"POST","host":"acme.ota.example.com","uri":"/api/v1/checkouts/ck_1/airline-card-completion"},"status":422}')" caddy
ship_entry "$(plain fail2ban.service fail2ban-server 5 stdout "NOTICE  [sshd] Ban 198.51.100.7")" fail2ban
ship_entry "$(plain dailyaidecheck.service dailyaidecheck 4 stderr "WARN: mail or s-nail not installed, cannot send mail.")" aide
add_entry "$(plain velexis-ota-api.service velexis-ota-api 6 stdout '{"level":30,"msg":"request completed","requestId":"r1"}')" # not shipped
ship_entry "$(plain velexis-ota-api.service velexis-ota-api 6 stdout '{"level":40,"msg":"amadeus.timeout","requestId":"r2"}')" velexis
ship_entry "$(plain velexis-platform-api.service velexis-platform-api 6 stdout '{"level":30,"securityEvent":"stripe.webhook_signature_invalid","msg":"refused"}')" security
ship_entry "$(plain velexis-portal.service velexis-portal 6 stdout '{"level":30,"security":true,"event":"auth.sign_in_failed"}')" security
ship_entry "$(plain velexis-backup.service velexis-backup 3 stdout "[02:31:00] ERROR: upload failed")" velexis
ship_entry '{"_PID":"1","SYSLOG_IDENTIFIER":"systemd","PRIORITY":"4","_TRANSPORT":"journal","UNIT":"velexis-ota-worker.service","MESSAGE":"velexis-ota-worker.service: Failed with result '"'"'exit-code'"'"'."}' systemd
add_entry '{"_PID":"1","SYSLOG_IDENTIFIER":"systemd","PRIORITY":"6","_TRANSPORT":"journal","MESSAGE":"Started velexis-healthcheck.service."}' # not shipped
add_entry "$(plain postgresql@16-main.service postgres 6 stderr "LOG: checkpoint complete")"                           # not shipped

# The WAF's lines: raw (Go-quoted [uri] content, as coraza writes it) and what may leave the VM.
declare -a WAF_RAW WAF_WANT
WAF_RAW+=("/api/x?id=1%27%20OR%20%271%27%3D%271&sig=SIG$MARK&token=TOK$MARK")
WAF_WANT+=("/api/x?id=&sig=&token=")
WAF_RAW+=("/checkout/complete.html?payment_intent=pi_$MARK&payment_intent_client_secret=pi_1_secret_CS$MARK&redirect_status=succeeded&q=%3Cscript%3E")
WAF_WANT+=("/checkout/complete.html?payment_intent=&payment_intent_client_secret=&redirect_status=&q=")
WAF_RAW+=("/api/y?t=REPA$MARK&t=REPB$MARK&empty=&BARE$MARK&p%73=PCT%2F$MARK%3D")
WAF_WANT+=("/api/y?t=&t=&empty=&&p%73=")
WAF_RAW+=("/api/z?x=\\\"QUO]TE$MARK\\\\back\\\"&y=1")
WAF_WANT+=("/api/z?x=&y=")
WAF_RAW+=("/v1/checkouts")
WAF_WANT+=("/v1/checkouts")
WAF_RAW+=("/api/w?")
WAF_WANT+=("/api/w?")
# Non-ASCII characters (Go's %q keeps printable ones) before the values: the cut must count characters, not bytes.
MB=""
for ((k = 0; k < 40; k++)); do MB+="é"; done
WAF_RAW+=("/café/$MB/x?ñññ=VAL$MARK&sig=MB$MARK")
WAF_WANT+=("/café/$MB/x?ñññ=&sig=")
# A line above 4096 bytes: journalctl's JSON output would make it null without --all.
WAF_RAW+=("/api/long?pad=$(head -c 4400 /dev/zero | tr '\0' A)$MARK&sig=LONG$MARK")
WAF_WANT+=("/api/long?pad=&sig=")
for i in "${!WAF_RAW[@]}"; do
  ship_entry "$(plain caddy.service caddy 3 stdout "$(caddy_waf_line "${WAF_RAW[$i]}" "$i")")" waf
done
# A Caddy line written with other JSON escapes (<, \/) than jq's: still blanked, from its parsed form.
ship_entry "$(plain caddy.service caddy 3 stdout "{\"level\":\"error\",\"ts\":1794510757.5,\"logger\":\"http.handlers.waf\",\"msg\":\"[client \\\"198.51.100.23\\\"] Coraza: Warning. XSS [id \\\"941100\\\"] [data \\\"ARGS:q\\\"] [uri \\\"\\/api\\/v?q=\\u003cscript\\u003eESC$MARK&sig=ESCSIG$MARK\\\"] [unique_id \\\"UIDESC\\\"]\"}")" waf
# Caddy's other lines are never shipped: the environment its package's unit prints at each start (caddy run
# --environ), its error log (the request's whole query and headers, unfiltered) and its TLS messages.
add_entry "$(plain caddy.service caddy 6 stdout "caddy.HomeDir=/var/lib/caddy")"                                  # not shipped
add_entry "$(plain caddy.service caddy 6 stdout "VELEXIS_EDGE_SECRET=EDGE$MARK")"                                 # not shipped
add_entry "$(plain caddy.service caddy 3 stdout '{"level":"error","ts":1794510757.7,"logger":"http.log.error.log1","msg":"dial tcp 127.0.0.1:3200: connect: connection refused","request":{"client_ip":"198.51.100.23","method":"GET","host":"api.ota.example.com","uri":"/v1/documents/d1?sig=ERRSIG'"$MARK"'","headers":{"X-Api-Key":["KEY'"$MARK"'"]}},"status":502}')" # not shipped
add_entry "$(plain caddy.service caddy 6 stdout '{"level":"info","ts":1794510757.8,"logger":"tls.obtain","msg":"certificate obtained successfully","identifier":"acme.ota.example.com"}')" # not shipped
# A WAF line longer than journald's LineMax, which journald splits: the first part (no JSON) is shipped as a note, the
# rest not at all.
ship_entry "$(plain caddy.service caddy 3 stdout '{"level":"error","ts":1794510757.9,"logger":"http.handlers.waf","msg":"[client \"198.51.100.23\"] Coraza: Warning. XSS [id \"941100\"] [uri \"/api/split?a=SPLITA'"$MARK")" waf
add_entry "$(plain caddy.service caddy 3 stdout 'SPLITB'"$MARK"'&sig=SPLITC'"$MARK"'\"] [unique_id \"UIDSPLIT\"]"}')" # not shipped
add_entry "$(plain cron.service CRON 6 syslog "(root) CMD (true)")" # the last entry read: not shipped
LAST_A="c$N"

run_ship
same "the first run succeeds" "$RC" 0
same "one chunk in the bucket" "$(object_count)" 1
OBJ="$(objects | head -n 1)"
[ -n "$OBJ" ] || die "the first run shipped nothing; the later cases need its chunk"
REL="${OBJ#"$BUCKET"/}"
object_path_ok() { # path in the bucket: logs/<yyyy>/<mm>/<dd>/ of the stamp in the object's name
  [[ "$1" =~ ^logs/([0-9]{4})/([0-9]{2})/([0-9]{2})/security-([0-9]{8})T[0-9]{6}Z-[0-9a-f]{12}\.jsonl\.zst\.age$ ]] &&
    [ "${BASH_REMATCH[1]}${BASH_REMATCH[2]}${BASH_REMATCH[3]}" = "${BASH_REMATCH[4]}" ]
}
check "the chunk is logs/<yyyy>/<mm>/<dd>/security-<UTC stamp>-<sha256>.jsonl.zst.age, of the run's day" \
  object_path_ok "$REL"
check "the chunk is age-encrypted (no readable JSON in it)" not grep -q '"cat"' "$OBJ"
decrypt "$OBJ" >"$OUT/chunk1.jsonl"
same "the chunk holds exactly the security entries, in journal order (categories)" \
  "$(jq -r .cat "$OUT/chunk1.jsonl" | paste -sd' ' -)" "${SHIPPED_CATS[*]}"
check "every record is one JSON object with ts, rt, host, cat, unit, ident, pid, uid, prio and msg" \
  jqe -s 'all(.[]; (keys - ["about", "audit_id"]) == ["cat", "host", "ident", "msg", "pid", "prio", "rt", "ts", "uid", "unit"])' "$OUT/chunk1.jsonl"
# shellcheck disable=SC2016 # jq's $b
check "ts is the entry's UTC time, rt its microseconds" \
  jqe -s --arg b "$BASE" '.[0].ts == ((($b | tonumber) + 2) | todate) and .[0].rt == ("\((($b | tonumber) + 2) * 1000000 + 123456)")' "$OUT/chunk1.jsonl"
check "a non-WAF message is shipped unchanged (the sudo line)" \
  jqe -s 'any(.[]; .msg == "ubuntu : TTY=pts/0 ; PWD=/home/ubuntu ; USER=root ; COMMAND=/usr/bin/systemctl restart caddy")' "$OUT/chunk1.jsonl"
check "the kernel's audit record keeps its audit id, systemd's unit message the unit it is about" \
  jqe -s 'any(.[]; .audit_id == "1235") and any(.[]; .about == "velexis-ota-worker.service")' "$OUT/chunk1.jsonl"
same "the cursor is the last entry read (a line that is not shipped)" "$(cursor)" "$LAST_A"
check "the first run starts at the beginning of its window (an older entry is not shipped)" \
  not grep -q 'SHA256:old' "$OUT/chunk1.jsonl"
check "it asks journalctl for that window, the later runs for the entries after the cursor" \
  grep -q -- "--cursor-file=.* --since=@$((BASE - 60))\$" "$FAKE/journalctl.calls"
check "the daily files are yesterday's and today's (each entry in the file of its own UTC day)" \
  test -f "$SECDIR/security-$YESTERDAY.jsonl.zst" -a -f "$SECDIR/security-$TODAY.jsonl.zst"
same "yesterday's daily file holds the entries before midnight" \
  "$(zstd -dc "$SECDIR/security-$YESTERDAY.jsonl.zst" | jq -r '.ts[0:10]' | sort -u)" "$YESTERDAY"
same "the daily files hold exactly the chunk's records" "$(daily_all | sha256sum)" "$(sha256sum <"$OUT/chunk1.jsonl")"
same "the security folder and the daily files are root-only (0700, 0600)" \
  "$(stat -c %a "$SECDIR") $(stat -c %a "$SECDIR/security-$TODAY.jsonl.zst")" "700 600"
check "the run reports what it shipped" grep -q "^shipped ${#SHIPPED_CATS[@]} entries to offsite:" "$LAST_OUT"
check "last-success records the shipment" grep -qE "^[0-9]+ ${#SHIPPED_CATS[@]} security-" "$STATE/last-success"

step "The WAF's [uri]: query values blanked, everything else unchanged [X-038 AC2]"
for i in "${!WAF_RAW[@]}"; do
  want="$(caddy_waf_line "${WAF_WANT[$i]}" "$i")"
  got="$(jq -r --arg u "UID$i\\\"" 'select(.cat == "waf") | select(.msg | contains($u)) | .msg' "$OUT/chunk1.jsonl")"
  same "WAF line $((i + 1)): [uri \"${WAF_WANT[$i]}\"], the rest of the line byte for byte [X-038 AC2]" "$got" "$want"
done
check "the line with other JSON escapes is blanked as well, and still parses [X-038 AC2]" \
  jqe -s 'any(.[]; .cat == "waf" and (.msg | startswith("{")) and (.msg | fromjson | .msg | contains("[uri \"/api/v?q=&sig=\"]")))' "$OUT/chunk1.jsonl"
check "the WAF lines keep their rule id, message and variable name [X-038 AC2]" \
  jqe -s '[.[] | select(.cat == "waf" and (.msg | startswith("{"))) | .msg | fromjson | .msg] | length == 9 and all(.[]; test("\\[id \"94[12]100\"\\]") and test("\\[data \"ARGS:(id|q)\"\\]"))
    and any(.[]; contains("[msg \"SQL Injection Attack Detected via libinjection\"]"))' "$OUT/chunk1.jsonl"
check "a WAF line that journald split: its first part is a note with its length, without its text [X-038 AC2]" \
  jqe -s '[.[] | select(.cat == "waf" and (.msg | startswith("{") | not))] | length == 1
    and (.[0].msg | test("^\\(the first part, [0-9]+ characters, of a Caddy line that journald split: its text is not shipped;"))' "$OUT/chunk1.jsonl"
check "of Caddy only the access and WAF lines: never its environment (caddy run --environ), error log or TLS lines" \
  not jqe -s 'any(.[]; .unit == "caddy.service" and (.msg | test("VELEXIS_EDGE_SECRET|caddy[.]HomeDir|http[.]log[.]error|tls[.]obtain|X-Api-Key")))' "$OUT/chunk1.jsonl"
check "no value of a WAF query is in the shipped chunk [X-038 AC2]" not grep -q "$MARK" "$OUT/chunk1.jsonl"
daily_holds() { zstd -dc "$SECDIR"/security-*.jsonl.zst | grep -q "$1"; }
check "nor in the daily files [X-038 AC2]" not daily_holds "$MARK"
check "nor anywhere under /var/log/velexis or /var/lib/velexis of the VM [X-038 AC2]" \
  not grep -rqa "$MARK" "$ROOT/var/log/velexis" "$ROOT/var/lib/velexis"
check "(the fake journal itself holds the values: the residual that stays in journald)" grep -q "SIG$MARK" "$FAKE/journal.jsonl"

# ---- 3. nothing new ------------------------------------------------------------------------------------------------
step "A run with nothing new"
run_ship
same "it succeeds" "$RC" 0
same "and ships nothing" "$(object_count)" 1
same "the cursor stays" "$(cursor)" "$LAST_A"
check "it says so" grep -q '^no new security entries$' "$LAST_OUT"

# ---- 4. an upload that fails ----------------------------------------------------------------------------------------
step "An upload that fails, then the next run [X-038 AC1]"
DAILY_BEFORE="$(daily_all | sha256sum)"
add_entry "$(plain ssh.service sshd 6 syslog "Accepted publickey for ubuntu from 203.0.113.11 port 50001 ssh2: ED25519 SHA256:B1$MARK")"
add_entry "$(plain "" sudo 5 syslog "ubuntu : TTY=pts/0 ; PWD=/ ; USER=root ; COMMAND=/usr/bin/true B2$MARK")"
add_entry "$(plain velexis-ota-api.service velexis-ota-api 6 stdout '{"level":50,"msg":"B3'"$MARK"'"}')"
touch "$FAKE/rclone-fails"
run_ship
same "the run fails (exit 1, OnFailure= mails it) [X-038 AC1]" "$RC" 1
same "the cursor stays where it was [X-038 AC1]" "$(cursor)" "$LAST_A"
same "nothing new in the bucket [X-038 AC1]" "$(object_count)" 1
same "the daily files are unchanged [X-038 AC1]" "$(daily_all | sha256sum)" "$DAILY_BEFORE"
check "last-failure says why [X-038 AC1]" grep -q 'failed; the cursor stays' "$STATE/last-failure"
check "the run says the cursor stays [X-038 AC1]" grep -q 'the cursor stays, so the next run ships these entries again' "$LAST_OUT"
rm -f "$FAKE/rclone-fails"
add_entry "$(plain ssh.service sshd 6 syslog "Accepted publickey for deploy from 203.0.113.12 port 50002 ssh2: ED25519 SHA256:C1$MARK")"
add_entry "$(plain velexis-portal.service velexis-portal 6 stdout '{"level":30,"security":true,"event":"C2'"$MARK"'"}')"
LAST_C="c$N"
run_ship
same "the next run succeeds [X-038 AC1]" "$RC" 0
same "with one more chunk [X-038 AC1]" "$(object_count)" 2
same "the cursor is the last entry [X-038 AC1]" "$(cursor)" "$LAST_C"
for m in B1 B2 B3 C1 C2; do
  same "entry $m is in the bucket exactly once (the missed ones too) [X-038 AC1]" \
    "$(all_shipped | grep -c "$m$MARK" || true)" 1
  same "and in the daily files exactly once [X-038 AC1]" "$(daily_all | grep -c "$m$MARK" || true)" 1
done
check "last-failure is gone after the success [X-038 AC1]" test ! -e "$STATE/last-failure"
same "every entry of the bucket is in a daily file, none twice" \
  "$(all_shipped | LC_ALL=C sort | sha256sum)" "$(daily_all | LC_ALL=C sort | sha256sum)"

# ---- 5. refusals ----------------------------------------------------------------------------------------------------
step "A journal that cannot be read, a private key in the recipients file, the object lock headers"
add_entry "$(plain ssh.service sshd 6 syslog "Accepted publickey for ubuntu from 203.0.113.13 port 50003 ssh2: ED25519 SHA256:D1")"
touch "$FAKE/journal-fails"
run_ship
same "a journal that cannot be read fails the run" "$RC" 1
same "and keeps the cursor and the bucket" "$(cursor) $(object_count)" "$LAST_C 2"
check "last-failure says so" grep -q 'could not read the journal' "$STATE/last-failure"
rm -f "$FAKE/journal-fails"
cp "$ROOT/etc/velexis/backup/data-recipients.txt" "$OUT/recipients.good"
cat "$KEYS/data.key" >>"$ROOT/etc/velexis/backup/data-recipients.txt"
run_ship
same "a private age key in the recipients file is refused" "$RC" 1
check "with the reason, before anything is read or shipped" grep -q 'holds a PRIVATE age key' "$LAST_OUT"
same "the cursor and the bucket stay" "$(cursor) $(object_count)" "$LAST_C 2"
cp "$OUT/recipients.good" "$ROOT/etc/velexis/backup/data-recipients.txt"
LOCK_DAYS=abc run_ship
same "a SECURITY_LOG_LOCK_DAYS that is no number of days is refused" "$RC" 1
LOCK_DAYS=366 run_ship
same "with SECURITY_LOG_LOCK_DAYS=366 the run ships the waiting entry" "$RC $(object_count)" "0 3"
check "and sends the object lock headers (GOVERNANCE, retain until a date 366 days ahead)" \
  grep -qE "^copy .* --header-upload x-amz-object-lock-mode: GOVERNANCE --header-upload x-amz-object-lock-retain-until-date: $(date -u -d '+366 days' +%Y-%m-)[0-9]{2}T" "$FAKE/rclone.calls"

# ---- 6. retention, status, the lock --------------------------------------------------------------------------------
step "Local retention (90 days), --status, the lock"
OLD="$(date -u -d '-100 days' +%F)"
KEPT="$(date -u -d '-10 days' +%F)"
printf '{}\n' | zstd -q -c >"$SECDIR/security-$OLD.jsonl.zst"
printf '{}\n' | zstd -q -c >"$SECDIR/security-$KEPT.jsonl.zst"
run_ship
same "a run succeeds" "$RC" 0
check "the daily file of 100 days ago is removed" test ! -e "$SECDIR/security-$OLD.jsonl.zst"
check "the one of 10 days ago is kept" test -e "$SECDIR/security-$KEPT.jsonl.zst"
run_ship --status
same "--status succeeds" "$RC" 0
status_ok() {
  grep -q "^last shipment: " "$LAST_OUT" && grep -q "^daily files in /var/log/velexis/security: " "$LAST_OUT" &&
    grep -q "^cursor: saved" "$LAST_OUT"
}
check "--status names the last shipment and the daily files" status_ok
add_entry "$(plain ssh.service sshd 6 syslog "Accepted publickey for ubuntu from 203.0.113.14 port 50004 ssh2: ED25519 SHA256:E1")"
exec 8>"$STATE/lock"
flock -n 8 || die "could not take the lock for the test"
CURSOR_BEFORE="$(cursor)"
run_ship
exec 8>&-
same "a run that finds the lock taken stops at once (exit 0)" "$RC" 0
check "and says so" grep -q 'another run is shipping' "$LAST_OUT"
same "it ships nothing and keeps the cursor" "$(cursor) $(object_count)" "$CURSOR_BEFORE 3"

step "Over the whole run"
check "rclone never got a command that deletes or replaces" test ! -s "$FAKE/rclone.refused"
uploads_immutable() { ! grep "^copy " "$FAKE/rclone.calls" | grep -qv -- " --immutable"; }
uploads_checked() { [ "$(grep -c "^check .* --one-way" "$FAKE/rclone.calls")" -ge 3 ]; }
check "every upload is rclone copy --immutable" uploads_immutable
check "every upload is checked with rclone check --one-way" uploads_checked
check "no private key under the VM's /etc/velexis" not grep -rq 'AGE-SECRET-KEY-' "$ROOT/etc/velexis"

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "ship-logs.test.sh: FAILED"
  exit 1
fi
echo
echo "ship-logs.test.sh: all checks passed"
