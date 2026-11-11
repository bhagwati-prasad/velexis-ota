#!/usr/bin/env bash
# =====================================================================================================
# egress.sh — the VM's outbound allow-list (task X-041; PCI DSS 11.5.1.1, ADR-0027 row 11.5). Root-owned copy:
# /usr/local/sbin/velexis-egress, installed by provision-vm.sh --steps egress (also run by harden), which runs it once;
# velexis-egress-refresh.service runs it at boot and velexis-egress-refresh.timer every 2 minutes.
#
#   velexis-egress [refresh] [--alert-once]  load or repair the nftables table inet velexis_egress and refresh its
#                                            address sets from /etc/velexis/egress/allowed-hosts.conf
#   velexis-egress validate <file>           check an allow-list (provision-vm.sh does before installing one); exit 1
#                                            and one line per problem when it is not valid
#   velexis-egress check-apt <file>          exit 1, naming each, when an apt source of the VM (the hosts apt-get
#                                            update and unattended-upgrades read) has no line in the allow-list
#   velexis-egress apt-hosts                 the hosts and ports of the VM's apt sources, one "host port" per line
#   velexis-egress parse                     `nft list table inet velexis_egress` on stdin -> one line per set, policy,
#                                            rule and set element (check-vm.sh reads the table through it)
# The last four only read; refresh is the only command that changes anything.
#
# The table (docs/mvp/runbooks/outbound-allow-list.md): the chain `output` (hook output, policy drop) accepts loopback,
# replies and other established or related traffic, the destinations of the sets `allow4` and `allow6` (address .
# protocol . port, each element commented with the line of the allow-list it comes from), those of the sets
# `emergency4` and `emergency6` (time-limited openings, never touched by this script: runbook §4), DHCP lease renewals
# and IPv6 neighbour discovery; everything else is logged with the prefix "VELEXIS-EGRESS-DENY " (at most 10 a minute,
# with the user that owns the socket) into the kernel log that journald keeps, and dropped. ufw keeps the inbound rules
# of X-020 and "allow outgoing": a packet must be accepted by every base chain on its hook, so this table's drop is final
# while ufw's own deny would refuse what the table allows too.
#
# A refresh resolves every line through the VM's own resolvers (getent ahosts, all lookups at once, 10 s each) and
# keeps, per line, every address seen in the last 24 hours: CDN-fronted APIs answer with changing addresses, and an
# address an app got a minute ago stays allowed. When a line cannot be resolved its last good addresses stay, however
# old. It changes the table only when it differs from what the list and the addresses ask for (the first run creates
# it; a repaired policy, rule or set is logged), in one nft transaction, and checks the result. Each address that comes
# or goes is logged. State: /var/lib/velexis/egress/addresses (root 0600: "<host> <address> <last seen, epoch>").
#
# A failed run (an invalid list, nft refusing the table) leaves the table as it was and exits 1; --alert-once (the
# unit) exits 1 only for the first failed run in a row, so velexis-alert@ (OnFailure=) mails once, and the next good
# run logs "recovered". /var/lib/velexis/egress/failing marks a run of failures; check-vm.sh reports FAIL while it is
# there. Messages hold host names, tokens and addresses, never a value of an env file or rclone.conf.
#
# Tests only: VELEXIS_ROOT=<absolute folder> reads and writes every path under that folder (/etc/velexis,
# /var/lib/velexis, /run/systemd/resolve, /etc/resolv.conf, /etc/apt); deploy/scripts/test/check-vm.test.sh puts fake
# nft, getent and chronyc first on PATH, and runs it with the real nft in a private network namespace.
# =====================================================================================================
set -euo pipefail
umask 077

: "${VELEXIS_ROOT:=}"
R="$VELEXIS_ROOT"
if [ -n "$R" ]; then
  case "$R" in /?*) ;; *) printf 'velexis-egress: VELEXIS_ROOT must be an absolute path other than /\n' >&2; exit 2 ;; esac
fi
ETC="$R/etc/velexis"
LIST="$ETC/egress/allowed-hosts.conf"
STATE="$R/var/lib/velexis/egress"
ADDRESSES="$STATE/addresses"
FAILING="$STATE/failing"
TABLE=velexis_egress
KEEP_SECONDS=86400   # an address stays allowed for 24 hours after a lookup last returned it
LOOKUP_SECONDS=10    # each lookup; they run at once, so a refresh waits about this long at most
# The rules of the chain output, exactly as nft 1.0.9 (Ubuntu 24.04) prints them; check-vm.sh holds the same list.
RULES=(
  'oifname "lo" accept'
  'ct state established,related accept'
  'ct state invalid drop'
  'ip daddr . meta l4proto . th dport @allow4 accept'
  'ip6 daddr . meta l4proto . th dport @allow6 accept'
  'ip daddr . meta l4proto . th dport @emergency4 accept'
  'ip6 daddr . meta l4proto . th dport @emergency6 accept'
  'udp sport 68 udp dport 67 accept'
  'udp sport 546 udp dport 547 accept'
  'icmpv6 type { mld-listener-report, nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert, mld2-listener-report } accept'
  'limit rate 10/minute burst 5 packets log prefix "VELEXIS-EGRESS-DENY " flags skuid'
)

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

# ---- the allow-list ---------------------------------------------------------------------------------------------
valid_ipv4() {
  local IFS=. o
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  for o in $1; do [ "$((10#$o))" -le 255 ] || return 1; done
}
valid_ipv6() { # lower case and compressed as nft prints it (one "::" at most)
  if [[ ! "$1" =~ ^[0-9a-f:]+$ ]] || [[ "$1" != *:*:* ]] || [[ "$1" == *:::* ]]; then return 1; fi
  local rest="${1#*::}"
  [[ "$rest" != *::* ]]
}
valid_name() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] && [ "${#1}" -le 253 ]; }

host_kind() { # host field -> name, ipv4, ipv6, resolvers, chrony, env or rclone (stdout); 1 when it is none
  case "$1" in
    @system-resolvers) echo resolvers ;;
    @chrony-sources) echo chrony ;;
    env:*) [[ "$1" =~ ^env:[a-z0-9][a-z0-9-]*\.env:[A-Z][A-Z0-9_]*$ ]] && echo env ;;
    rclone:*) [[ "$1" =~ ^rclone:[a-z0-9][a-z0-9-]*\.env$ ]] && echo rclone ;;
    *:*) valid_ipv6 "$1" && echo ipv6 ;;
    *) if valid_ipv4 "$1"; then echo ipv4; elif valid_name "$1"; then echo name; else return 1; fi ;;
  esac
}

LINES=() # "host port proto" of every line of the list, in its order
read_list() { # file -> fills LINES; 1, with one "line <n>: ..." per problem on stderr, when the file is not valid
  local file="$1" n=0 bad=0 line host port proto used reason seen=" "
  LINES=()
  if [ ! -f "$file" ]; then printf '%s is missing\n' "$file" >&2; return 1; fi
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    read -r host port proto used reason <<<"$line"
    if ! host_kind "$host" >/dev/null; then
      printf 'line %d: %s is not a lower-case host name, an IPv4 or IPv6 address, @system-resolvers, @chrony-sources, env:<file>.env:<VARIABLE> or rclone:<file>.env\n' "$n" "$host" >&2
      bad=1
    fi
    if [[ ! "${port:-}" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$port" -gt 65535 ]; then
      printf 'line %d: the port %s is not 1 to 65535\n' "$n" "${port:-(none)}" >&2
      bad=1
    fi
    case "${proto:-}" in tcp | udp) ;; *) printf 'line %d: the protocol %s is not tcp or udp\n' "$n" "${proto:-(none)}" >&2; bad=1 ;; esac
    if [ -z "${used:-}" ] || [ -z "${reason:-}" ]; then
      printf 'line %d: names no user (env variable or unit) or no reason\n' "$n" >&2
      bad=1
    fi
    case "$seen" in *" $host/$port/$proto "*) printf 'line %d: %s %s %s is listed twice\n' "$n" "$host" "$port" "$proto" >&2; bad=1 ;; esac
    seen="$seen$host/$port/$proto "
    LINES+=("$host $port $proto")
  done <"$file"
  if [ "${#LINES[@]}" = 0 ] && [ "$bad" = 0 ]; then printf '%s has no line\n' "$file" >&2; bad=1; fi
  [ "$bad" = 0 ]
}

# ---- the hosts behind the tokens ----------------------------------------------------------------------------------
env_value() { # file key -> ENV_VALUE: the value of the last KEY= line, quotes removed. Never printed.
  local line v=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$2="*) v="${line#"$2="}" ;; esac
  done <"$1"
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  ENV_VALUE="$v"
}

url_host() { # URL (or a bare host) -> its host, without scheme, user info, port or path (stdout); 1 when it has none
  local u="$1" h
  u="${u#*://}"
  u="${u%%/*}"
  u="${u##*@}"
  if [[ "$u" == \[*\]* ]]; then h="${u#\[}"; h="${h%%\]*}"; else h="${u%%:*}"; fi
  h="${h,,}"
  [ -n "$h" ] && host_kind "$h" >/dev/null && printf '%s' "$h"
}

TOKEN_NOTE="" # why a token gave no host (no value is ever part of it)
env_token_host() { # env:<file>:<VAR> -> the host of that URL (stdout); 1 and TOKEN_NOTE otherwise
  local spec="${1#env:}" file var
  file="${spec%%:*}"
  var="${spec#*:}"
  if [ ! -r "$ETC/$file" ]; then TOKEN_NOTE="$ETC/$file is missing"; return 1; fi
  env_value "$ETC/$file" "$var"
  if [ -z "$ENV_VALUE" ]; then TOKEN_NOTE="$file sets no $var"; return 1; fi
  if ! url_host "$ENV_VALUE"; then ENV_VALUE=""; TOKEN_NOTE="$var of $file has no host"; return 1; fi
  ENV_VALUE=""
}

rclone_token_names() { # rclone:<file> -> the endpoint host of the remote of RCLONE_REMOTE, and <bucket>.<host> (stdout)
  local file="${1#rclone:}" remote bucket conf host
  if [ ! -r "$ETC/$file" ]; then TOKEN_NOTE="$ETC/$file is missing"; return 1; fi
  env_value "$ETC/$file" RCLONE_REMOTE
  remote="${ENV_VALUE%%:*}"
  bucket="${ENV_VALUE#*:}"
  bucket="${bucket%%/*}"
  env_value "$ETC/$file" RCLONE_CONFIG
  case "$ENV_VALUE" in "$R"/*) conf="$ENV_VALUE" ;; *) conf="$R$ENV_VALUE" ;; esac   # a test's env files hold VELEXIS_ROOT
  ENV_VALUE=""
  if [ -z "$remote" ] || [ ! -r "$conf" ]; then TOKEN_NOTE="no rclone remote, or its rclone.conf is missing ($file: RCLONE_REMOTE, RCLONE_CONFIG)"; return 1; fi
  # Only the endpoint of [remote] is read from rclone.conf; its keys are never read into a variable.
  host="$(awk -v sect="[$remote]" '
    /^[[:space:]]*\[/ { cur = $0; gsub(/[[:space:]]/, "", cur); next }
    cur == sect && /^[[:space:]]*endpoint[[:space:]]*=/ { sub(/^[^=]*=[[:space:]]*/, ""); sub(/[[:space:]]+$/, ""); print; exit }' "$conf")"
  if [ -z "$host" ] || ! host="$(url_host "$host")"; then
    TOKEN_NOTE="the remote $remote of rclone.conf has no endpoint (docs/mvp/deployment-single-vm.md §10)"
    return 1
  fi
  printf '%s\n' "$host"
  bucket="${bucket,,}"
  if [ -n "$bucket" ] && valid_name "$bucket.$host"; then printf '%s\n' "$bucket.$host"; fi
}

system_resolvers() { # -> the upstream DNS servers of systemd-resolved (else of /etc/resolv.conf), one per line
  local f="$R/run/systemd/resolve/resolv.conf"
  [ -r "$f" ] || f="$R/etc/resolv.conf"
  [ -r "$f" ] || return 0
  awk '$1 == "nameserver" && $2 !~ /^127\./ && $2 != "::1" { a = $2; sub(/%.*/, "", a); print tolower(a) }' "$f"
}

chrony_sources() { # -> the addresses of chrony's current sources (chronyc -n -c sources), one per line
  command -v chronyc >/dev/null 2>&1 || return 0
  timeout "$LOOKUP_SECONDS" chronyc -n -c sources 2>/dev/null | awk -F, '$1 == "^" || $1 == "=" { print tolower($3) }' || true
}

# ---- the VM's apt sources -------------------------------------------------------------------------------------
uri_host_port() { # http(s) URI -> "host port" (stdout); nothing for other schemes
  local u="$1" scheme auth host port
  case "$u" in http://* | https://*) ;; *) return 0 ;; esac
  scheme="${u%%://*}"
  auth="${u#*://}"
  auth="${auth%%/*}"
  auth="${auth##*@}"
  host="${auth%%:*}"
  port="${auth#"$host"}"
  port="${port#:}"
  [ -n "$port" ] || { if [ "$scheme" = https ]; then port=443; else port=80; fi; }
  printf '%s %s\n' "${host,,}" "$port"
}

apt_hosts() { # -> "host port" of every enabled apt source (sources.list, *.list, *.sources, mirror+file lists), sorted
  local f uri mirror
  {
    for f in "$R/etc/apt/sources.list" "$R"/etc/apt/sources.list.d/*.list; do
      [ -f "$f" ] || continue
      awk '$1 == "deb" || $1 == "deb-src" { i = 2; if ($i ~ /^\[/) { while (i <= NF && $i !~ /\]$/) i++; i++ } if (i <= NF) print $i }' "$f"
    done
    for f in "$R"/etc/apt/sources.list.d/*.sources; do
      [ -f "$f" ] || continue
      awk 'BEGIN { RS = ""; FS = "\n" } {
        on = 1; u = ""
        for (i = 1; i <= NF; i++) {
          l = $i
          if (tolower(l) ~ /^enabled:[[:space:]]*no/) on = 0
          if (tolower(l) ~ /^uris:/) { sub(/^[^:]*:[[:space:]]*/, "", l); u = u " " l }
        }
        if (on) { n = split(u, a, /[[:space:]]+/); for (j = 1; j <= n; j++) if (a[j] != "") print a[j] }
      }' "$f"
    done
  } | while read -r uri; do
    case "$uri" in
      mirror+file:*)
        mirror="$R${uri#mirror+file:}"
        [ -r "$mirror" ] && awk '$1 ~ /^https?:\/\// { print $1 }' "$mirror" | while read -r uri; do uri_host_port "$uri"; done
        ;;
      *) uri_host_port "$uri" ;;
    esac
  done | sort -u
}

check_apt() { # list file -> 0 when every apt source host has a "<host> <port> tcp" line; else 1 naming the others
  local host port missing=""
  read_list "$1" 2>/dev/null || { printf '%s is not a valid allow-list\n' "$1" >&2; return 1; }
  while read -r host port; do
    [ -n "$host" ] || continue
    case " ${LINES[*]/%/ |} " in *" $host $port tcp |"*) ;; *) missing="$missing $host:$port" ;; esac
  done < <(apt_hosts)
  if [ -n "$missing" ]; then printf 'apt sources without a line in %s:%s\n' "$1" "$missing" >&2; return 1; fi
}

# ---- reading the table ------------------------------------------------------------------------------------------
parse_table() { # `nft list table inet velexis_egress` on stdin -> "set <name>", "policy <p>", "rule <text>" and
  awk '          #  "elem <set> <element>" lines (an element: "<address> . <proto> . <port>[ timeout …][ comment "…"]")
    function emit(set, buf,   i, c, q, item) {
      q = 0; item = ""
      for (i = 1; i <= length(buf); i++) {
        c = substr(buf, i, 1)
        if (c == "\"") q = !q
        if (c == "," && !q) { put(set, item); item = "" } else item = item c
      }
      put(set, item)
    }
    function put(set, item) {
      gsub(/[[:space:]]+/, " ", item); sub(/^ /, "", item); sub(/ $/, "", item)
      if (item != "") print "elem " set " " item
    }
    /^[[:space:]]*set [A-Za-z0-9_]+ \{$/ { inset = $2; print "set " inset; next }
    inset != "" && collecting { buf = buf " " $0; if (buf ~ /\}[[:space:]]*$/) { sub(/\}[[:space:]]*$/, "", buf); emit(inset, buf); collecting = 0 } next }
    inset != "" && /^[[:space:]]*elements = \{/ {
      buf = $0; sub(/^[[:space:]]*elements = \{/, "", buf)
      if (buf ~ /\}[[:space:]]*$/) { sub(/\}[[:space:]]*$/, "", buf); emit(inset, buf) } else collecting = 1
      next
    }
    inset != "" && /^[[:space:]]*\}$/ { inset = ""; next }
    /^[[:space:]]*chain output \{$/ { inchain = 1; next }
    inchain && /^[[:space:]]*type filter hook output / { if (match($0, /policy [a-z]+;/)) print "policy " substr($0, RSTART + 7, RLENGTH - 8); next }
    inchain && /^[[:space:]]*\}$/ { inchain = 0; next }
    inchain { r = $0; sub(/^[[:space:]]+/, "", r); sub(/[[:space:]]+$/, "", r); if (r != "") print "rule " r }
  '
}

# ---- refresh ----------------------------------------------------------------------------------------------------
WORK=""
cleanup() { [ -z "$WORK" ] || rm -rf "$WORK"; }

FAILED_BEFORE=0
ALERT_ONCE=0
fail_run() { # reason -> leaves the table as it is, marks the run of failures, and exits (see the header)
  say "FAILED: $*"
  if [ "$FAILED_BEFORE" = 1 ] && [ "$ALERT_ONCE" = 1 ]; then
    say "still failing since $(head -c 20 "$FAILING" 2>/dev/null); velexis-alert@ mailed when it began"
    exit 0
  fi
  [ -e "$FAILING" ] || printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >"$FAILING" 2>/dev/null || true
  exit 1
}

elements_of() { # parsed table, set -> its elements, sorted
  printf '%s\n' "$1" | awk -v s="$2" '$1 == "elem" && $2 == s { sub(/^elem [^ ]+ /, ""); print }' | sort
}

refresh() {
  local now key kind h a i n line host port proto addr fam entry tmp live parsed want4 want6 have4 have6 why=""
  local -A names=() direct=() failed=() seen=() taken=() lookup_of=()
  local -a want4_list=() want6_list=() lookups=()
  install -d -m 0700 "$STATE"
  [ ! -e "$FAILING" ] || FAILED_BEFORE=1
  exec 9>>"$STATE/.lock"
  flock -w 60 9 || fail_run "another velexis-egress run holds $STATE/.lock"
  WORK="$(mktemp -d)"
  trap cleanup EXIT
  command -v nft >/dev/null 2>&1 || fail_run "nft is missing (package nftables)"
  read_list "$LIST" 2>"$WORK/list.err" || fail_run "$LIST is not a valid allow-list: $(paste -sd';' "$WORK/list.err")"
  now="$(date +%s)"

  # The hosts and addresses behind every line: tokens and addresses now, names through one lookup each, all at once.
  for line in "${LINES[@]}"; do
    key="${line%% *}"
    [ -z "${names[$key]+x}${direct[$key]+x}${failed[$key]+x}" ] || continue
    kind="$(host_kind "$key")"
    TOKEN_NOTE=""
    case "$kind" in
      name) names[$key]="$key" ;;
      ipv4 | ipv6) direct[$key]="$key" ;;
      resolvers) direct[$key]="$(system_resolvers | paste -sd' ' -)"; TOKEN_NOTE="no nameserver in /run/systemd/resolve/resolv.conf or /etc/resolv.conf" ;;
      chrony) direct[$key]="$(chrony_sources | paste -sd' ' -)"; TOKEN_NOTE="chronyc -n -c sources lists no server" ;;
      env) if h="$(env_token_host "$key")"; then
             if [ "$(host_kind "$h")" = name ]; then names[$key]="$h"; else direct[$key]="$h"; fi
           else failed[$key]="$TOKEN_NOTE"; fi ;;
      rclone) if h="$(rclone_token_names "$key")"; then names[$key]="$(printf '%s' "$h" | paste -sd' ' -)"; else failed[$key]="$TOKEN_NOTE"; fi ;;
    esac
    if [ -n "${direct[$key]+x}" ] && [ -z "${direct[$key]}" ]; then unset "direct[$key]"; failed[$key]="$TOKEN_NOTE"; fi
  done
  n=0
  for key in "${!names[@]}"; do
    for h in ${names[$key]}; do
      [ -z "${lookup_of[$h]+x}" ] || continue
      lookup_of[$h]="$n"
      lookups+=("$h")
      ( timeout "$LOOKUP_SECONDS" getent ahosts "$h" >"$WORK/lookup.$n" 2>/dev/null || true ) &
      n=$((n + 1))
    done
  done
  wait
  for key in "${!names[@]}"; do
    a=""
    for h in ${names[$key]}; do
      a="$a $(awk '{ a = tolower($1); if (a !~ /^::ffff:/) print a }' "$WORK/lookup.${lookup_of[$h]}" | sort -u | paste -sd' ' -)"
    done
    a="$(printf '%s' "$a" | xargs)"
    if [ -n "$a" ]; then direct[$key]="$a"; else failed[$key]="no address for ${names[$key]}"; fi
  done

  # The addresses to allow per line: those seen in the last 24 hours, or all of a line's last good ones when its
  # lookup failed now.
  if [ -f "$ADDRESSES" ]; then
    while read -r key addr i; do
      # Only a host of the list, an address and a time: the file is root's, but its values reach arithmetic below.
      [[ "${i:-}" =~ ^[0-9]{1,12}$ ]] || continue
      valid_ipv4 "$addr" || valid_ipv6 "$addr" || continue
      [ -n "${names[$key]+x}${direct[$key]+x}${failed[$key]+x}" ] || continue
      seen["$key $addr"]="$i"
    done <"$ADDRESSES"
  fi
  for key in "${!direct[@]}"; do
    for addr in ${direct[$key]}; do
      case "$(host_kind "$addr" 2>/dev/null || true)" in ipv4 | ipv6) seen["$key $addr"]="$now" ;; *) warn "$key: $addr is no address; skipped" ;; esac
    done
  done
  for entry in "${!seen[@]}"; do
    key="${entry%% *}"
    if [ -z "${failed[$key]+x}" ] && [ "$((now - seen[$entry]))" -gt "$KEEP_SECONDS" ]; then unset "seen[$entry]"; fi
  done
  for key in "${!failed[@]}"; do
    i=0
    for entry in "${!seen[@]}"; do [ "${entry%% *}" != "$key" ] || i=$((i + 1)); done
    if [ "$i" -gt 0 ]; then warn "$key: ${failed[$key]}; its last good addresses stay allowed ($i)"; else warn "$key: ${failed[$key]}; no address is allowed for it yet"; fi
  done

  # The elements: per line in the list's order, each address once per protocol and port (an address several lines
  # share keeps the comment of the first).
  for line in "${LINES[@]}"; do
    read -r host port proto <<<"$line"
    while read -r addr; do
      [ -n "$addr" ] || continue
      [ -z "${taken["$addr $proto $port"]+x}" ] || continue
      taken["$addr $proto $port"]=1
      if [[ "$addr" == *:* ]]; then fam=6; else fam=4; fi
      entry="$addr . $proto . $port comment \"$host\""
      if [ "$fam" = 4 ]; then want4_list+=("$entry"); else want6_list+=("$entry"); fi
    done < <(for entry in "${!seen[@]}"; do [ "${entry%% *}" != "$host" ] || printf '%s\n' "${entry#* }"; done | sort -V)
  done
  want4="$(printf '%s\n' "${want4_list[@]}" | sed '/^$/d' | sort)"
  want6="$(printf '%s\n' "${want6_list[@]}" | sed '/^$/d' | sort)"

  # The live table, and what differs.
  if live="$(nft list table inet "$TABLE" 2>/dev/null)"; then
    parsed="$(printf '%s\n' "$live" | parse_table)"
  else
    parsed=""
    why="created"
  fi
  if [ -n "$parsed" ]; then
    for i in allow4 allow6 emergency4 emergency6; do
      grep -qx "set $i" <<<"$parsed" || why="${why:+$why; }the set $i was missing"
    done
    [ "$(printf '%s\n' "$parsed" | awk '$1 == "policy" { print $2; exit }')" = drop ] || why="${why:+$why; }the policy of the chain output was not drop"
    [ "$(printf '%s\n' "$parsed" | sed -n 's/^rule //p')" = "$(printf '%s\n' "${RULES[@]}")" ] || why="${why:+$why; }the rules of the chain output differed"
  fi
  have4="$(elements_of "$parsed" allow4)"
  have6="$(elements_of "$parsed" allow6)"
  if [ -z "$why" ] && [ "$have4" = "$want4" ] && [ "$have6" = "$want6" ]; then
    save_addresses
    finish_ok "unchanged: $(count "$want4") IPv4 and $(count "$want6") IPv6 destinations for ${#LINES[@]} lines"
    return 0
  fi

  # One transaction: the table, the chain with its rules and the two allow sets are replaced; the emergency sets keep
  # their elements.
  tmp="$WORK/egress.nft"
  {
    printf 'add table inet %s\n' "$TABLE"
    printf 'add set inet %s allow4 { type ipv4_addr . inet_proto . inet_service; }\n' "$TABLE"
    printf 'add set inet %s allow6 { type ipv6_addr . inet_proto . inet_service; }\n' "$TABLE"
    printf 'add set inet %s emergency4 { type ipv4_addr . inet_proto . inet_service; flags timeout; }\n' "$TABLE"
    printf 'add set inet %s emergency6 { type ipv6_addr . inet_proto . inet_service; flags timeout; }\n' "$TABLE"
    printf 'add chain inet %s output { type filter hook output priority filter; policy drop; }\n' "$TABLE"
    printf 'flush chain inet %s output\n' "$TABLE"
    for i in "${RULES[@]}"; do printf 'add rule inet %s output %s\n' "$TABLE" "$i"; done
    printf 'flush set inet %s allow4\n' "$TABLE"
    printf 'flush set inet %s allow6\n' "$TABLE"
    [ -z "$want4" ] || printf '%s\n' "$want4" | while IFS= read -r entry; do printf 'add element inet %s allow4 { %s }\n' "$TABLE" "$entry"; done
    [ -z "$want6" ] || printf '%s\n' "$want6" | while IFS= read -r entry; do printf 'add element inet %s allow6 { %s }\n' "$TABLE" "$entry"; done
  } >"$tmp"
  if ! nft -f "$tmp" >"$WORK/nft.err" 2>&1; then
    fail_run "nft refused the table, which stays as it was: $(head -n 3 "$WORK/nft.err" | paste -sd' ' -)"
  fi
  case "$why" in
    "") ;;
    created) say "created the table inet $TABLE (outgoing connections denied by default, refusals logged)" ;;
    *) say "repaired: $why" ;;
  esac
  diff_lines "$have4" "$want4"
  diff_lines "$have6" "$want6"
  # The table as nft shows it now must be what this run asked for (another nft version could print it otherwise,
  # and every later run would then load it again).
  parsed="$(nft list table inet "$TABLE" 2>/dev/null | parse_table)" || true
  if [ "$(printf '%s\n' "$parsed" | sed -n 's/^rule //p')" != "$(printf '%s\n' "${RULES[@]}")" ] ||
    [ "$(elements_of "$parsed" allow4)" != "$want4" ] || [ "$(elements_of "$parsed" allow6)" != "$want6" ] ||
    [ "$(printf '%s\n' "$parsed" | awk '$1 == "policy" { print $2; exit }')" != drop ]; then
    fail_run "nft loaded the table, but lists it otherwise than it was written (nft $(nft --version 2>/dev/null | awk '{ print $2 }'); the rules of egress.sh need its notation)"
  fi
  save_addresses
  finish_ok "loaded: $(count "$want4") IPv4 and $(count "$want6") IPv6 destinations for ${#LINES[@]} lines"
}

count() { if [ -z "$1" ]; then echo 0; else printf '%s\n' "$1" | grep -c .; fi; }

diff_lines() { # old new -> one line per element that came or went
  comm -13 <(printf '%s\n' "$1" | sed '/^$/d') <(printf '%s\n' "$2" | sed '/^$/d') | sed 's/^/allowed: /'
  comm -23 <(printf '%s\n' "$1" | sed '/^$/d') <(printf '%s\n' "$2" | sed '/^$/d') | sed 's/^/no longer allowed: /'
}

save_addresses() { # the addresses of every line with the time a lookup last returned them, written when they changed
  local entry tmp="$STATE/.addresses.new"
  for entry in "${!seen[@]}"; do printf '%s %s\n' "$entry" "${seen[$entry]}"; done | sort >"$tmp"
  if cmp -s "$tmp" "$ADDRESSES"; then rm -f "$tmp"; else mv -f "$tmp" "$ADDRESSES"; fi
}

finish_ok() {
  if [ -e "$FAILING" ]; then
    say "recovered (failing since $(head -c 20 "$FAILING"))"
    rm -f "$FAILING"
  fi
  say "$*"
}

case "${1:-refresh}" in
  refresh)
    shift || true
    case "${1:-}" in --alert-once) ALERT_ONCE=1 ;; "") ;; *) printf 'velexis-egress: unknown option %s\n' "$1" >&2; exit 2 ;; esac
    [ "$(id -u)" -eq 0 ] || { printf 'velexis-egress: run as root\n' >&2; exit 2; }
    refresh
    ;;
  validate) [ $# = 2 ] || { printf 'usage: velexis-egress validate <file>\n' >&2; exit 2; }; read_list "$2" ;;
  check-apt) [ $# = 2 ] || { printf 'usage: velexis-egress check-apt <file>\n' >&2; exit 2; }; check_apt "$2" ;;
  apt-hosts) apt_hosts ;;
  parse) parse_table ;;
  -h | --help) sed -n '2,/^# =====/p' "$0" ;;
  *) printf 'velexis-egress: unknown command %s (refresh, validate, check-apt, apt-hosts, parse)\n' "$1" >&2; exit 2 ;;
esac
