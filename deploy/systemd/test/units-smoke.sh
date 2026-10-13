#!/usr/bin/env bash
# =====================================================================================================
# units-smoke.sh — runs the real unit files of deploy/systemd/ under systemd with a stand-in app (task X-021).
#
#   sudo env SMOKE_NODE="$(command -v node)" bash deploy/systemd/test/units-smoke.sh
#
# Needs root, systemd as PID 1, Node 22 (SMOKE_NODE; the units run a root-owned copy of it), PostgreSQL and
# Redis on loopback, outbound DNS and HTTPS, and a Mailpit. CI runs it in the "systemd-units" job of
# .github/workflows/ci.yml (ubuntu-24.04 runner, PostgreSQL, Redis and Mailpit service containers). On a
# throwaway VM, start Mailpit first (mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025). Never run it on
# the production VM: it stops nothing there, but it creates and removes test units and users.
#
# What it proves (docs/mvp/plans/foundation-tasks.md, X-021):
#   1. `systemd-analyze security --offline=true` rates every app unit and velexis-alert@ 2.0 or lower.
#   2. The backend unit velexis-ota-api and the Next.js unit velexis-portal start from the templates with only
#      their paths changed: /srv/velexis, /etc/velexis, /var/lib/velexis and /usr/local/sbin/velexis-* move
#      under a temporary prefix, /usr/bin/node becomes <prefix>/bin/node, CacheDirectory gets a test name, the
#      units are renamed velexis-smoke-*, and OnFailure= points at a renamed copy of velexis-alert@. Every
#      sandboxing line is the production one.
#   3. The stand-in app (dist/main.js, platform/frontend/server.js) checks at start-up what the real apps
#      need: its release folder, the key files named by its env file (backend), PostgreSQL and Redis (a
#      protocol round trip), DNS and an HTTPS host outside the VM, os.cpus() and os.networkInterfaces(). It
#      also tries the paths of SMOKE_FORBIDDEN, which must fail with EACCES ("Permission denied") or ENOENT
#      ("No such file"). The forbidden files exist and their modes would let the app user read them (env files
#      root:velexis 0640, keys owned by the app user), so a denied read proves the unit's sandbox, not the mode.
#   4. Killing the backend unit (at most 11 times within 300 s) puts it in failed through StartLimitBurst=10,
#      and velexis-alert@ mails Mailpit the unit name, its status and its last log lines, exactly once
#      (RestartMode=direct keeps the crashes before the start limit from triggering OnFailure=).
#   A random canary value sits in every test env file; it must appear neither in the journal nor in the mail
#   (the stand-in logs variable names, never values).
#
# Settings (environment), with defaults: SMOKE_NODE (node on PATH), SMOKE_PG (127.0.0.1:5432), SMOKE_REDIS
# (127.0.0.1:6379), SMOKE_HTTPS_URL (https://api.github.com/), SMOKE_SMTP_URL (smtp://127.0.0.1:1025),
# MAILPIT_API_URL (http://127.0.0.1:8025), SMOKE_SMTP_TLS (ALERT_SMTP_TLS of the test alert.env: none),
# SMOKE_NODE_EXTRA_CA_CERTS (a CA bundle, only where an egress proxy re-signs TLS), SMOKE_KEEP=1 (keep the
# prefix, the test units and users for inspection).
# =====================================================================================================
set -euo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$HERE/../.." && pwd)"
UNITS="$DEPLOY/systemd"

PG="${SMOKE_PG:-127.0.0.1:5432}"
REDIS="${SMOKE_REDIS:-127.0.0.1:6379}"
HTTPS_URL="${SMOKE_HTTPS_URL:-https://api.github.com/}"
SMTP_URL="${SMOKE_SMTP_URL:-smtp://127.0.0.1:1025}"
MAILPIT="${MAILPIT_API_URL:-http://127.0.0.1:8025}"
APP_UNITS=(velexis-platform-api velexis-platform-worker velexis-portal velexis-platform-admin
  velexis-ota-api velexis-ota-worker velexis-ota-admin)
SANDBOXED_UNITS=("${APP_UNITS[@]}" velexis-alert@) # the alert unit is held to the same limit
BACKEND=velexis-ota-api
FRONTEND=velexis-portal
MAX_EXPOSURE=20 # systemd-analyze --threshold counts in tenths: 20 is 2.0
MAX_KILLS=11

FAILED=0
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILED=1; }
die() { printf 'FAIL %s\n' "$*"; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
check() { # description command... -> one PASS or FAIL line
  local what="$1"
  shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}
not() { ! "$@"; }
retry() { # tries command...: run every 0.5 s until it succeeds
  local n="$1"
  shift
  while ! "$@"; do
    n=$((n - 1))
    [ "$n" -gt 0 ] || return 1
    sleep 0.5
  done
}

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ -d /run/systemd/system ] || die "systemd is not the init system here"
NODE="$(readlink -f "${SMOKE_NODE:-$(command -v node || true)}")"
[ -x "$NODE" ] || die "node not found: set SMOKE_NODE"
for tool in curl runuser useradd systemd-analyze; do command -v "$tool" >/dev/null || die "$tool is missing"; done

# ---- 1. sandbox exposure ------------------------------------------------------------------------------------
step "systemd-analyze security --offline=true: every app unit and velexis-alert@ must be 2.0 or lower"
for u in "${SANDBOXED_UNITS[@]}"; do
  if out="$(systemd-analyze security --offline=true --threshold="$MAX_EXPOSURE" --no-pager \
              "$UNITS/$u.service" 2>&1)"; then
    pass "$(printf '%s\n' "$out" | grep 'Overall exposure level' | sed 's/^→ //') [X-021 AC1]"
  else
    printf '%s\n' "$out" | grep -E '✗|Overall' || true
    fail "$u.service is above 2.0 [X-021 AC1]"
  fi
done

# ---- 2. temporary prefix, users, release, keys and env files --------------------------------------------------
mkdir -p /opt
PREFIX="$(mktemp -d /opt/velexis-smoke.XXXXXX)"
chmod 0755 "$PREFIX"
RUN_ID="${PREFIX##*.}"
CACHE_BASE="velexis-smoke.$RUN_ID"
ETC="$PREFIX/etc/velexis"
REL="$PREFIX/srv/velexis/releases/smoke"
ALERT_TO="ops-smoke-$RUN_ID@example.com"
CANARY="canary-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
B_UNIT="velexis-smoke-${BACKEND#velexis-}.service"
F_UNIT="velexis-smoke-${FRONTEND#velexis-}.service"
A_TEMPLATE=velexis-smoke-alert@.service
A_UNIT="velexis-smoke-alert@$B_UNIT.service"
CREATED_USERS=()
CREATED_GROUPS=()

cleanup() {
  local rc=$? u g
  if [ "${SMOKE_KEEP:-0}" = 1 ]; then
    echo "SMOKE_KEEP=1: kept $PREFIX, /etc/systemd/system/velexis-smoke-*, /var/cache/$CACHE_BASE" \
      "and the users ${CREATED_USERS[*]:-(none created)}"
    exit "$rc"
  fi
  systemctl stop "$B_UNIT" "$F_UNIT" "$A_UNIT" >/dev/null 2>&1 || true
  systemctl reset-failed "$B_UNIT" "$F_UNIT" "$A_UNIT" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$B_UNIT" "/etc/systemd/system/$F_UNIT" "/etc/systemd/system/$A_TEMPLATE"
  systemctl daemon-reload || true
  rm -rf --one-file-system "$PREFIX" "/var/cache/$CACHE_BASE"
  for u in "${CREATED_USERS[@]}"; do userdel "$u" >/dev/null 2>&1 || true; done
  for g in "${CREATED_GROUPS[@]}"; do ! getent group "$g" >/dev/null || groupdel "$g" >/dev/null 2>&1 || true; done
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

unit_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; } # file key -> its last value
ensure_group() {
  getent group "$1" >/dev/null && return 0
  groupadd --system "$1"
  CREATED_GROUPS+=("$1")
}
ensure_user() { # user primary-group
  id -u "$1" >/dev/null 2>&1 && return 0
  ensure_group "$2"
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --gid "$2" "$1"
  CREATED_USERS+=("$1")
}

step "Test prefix $PREFIX"
B_USER="$(unit_value "$UNITS/$BACKEND.service" User)"
B_GROUP="$(unit_value "$UNITS/$BACKEND.service" Group)"
F_USER="$(unit_value "$UNITS/$FRONTEND.service" User)"
F_GROUP="$(unit_value "$UNITS/$FRONTEND.service" Group)"
P_USER="$(unit_value "$UNITS/velexis-platform-api.service" User)"
P_GROUP="$(unit_value "$UNITS/velexis-platform-api.service" Group)"
ensure_group velexis # reads releases and, as provision-vm.sh sets them, the app env files
for g in $(unit_value "$UNITS/$BACKEND.service" SupplementaryGroups) \
         $(unit_value "$UNITS/$FRONTEND.service" SupplementaryGroups); do
  ensure_group "$g"
done
ensure_user "$B_USER" "$B_GROUP"
ensure_user "$F_USER" "$F_GROUP"
ensure_user "$P_USER" "$P_GROUP"
pass "users: $B_USER ($BACKEND), $F_USER ($FRONTEND), $P_USER (platform keys); created: ${CREATED_USERS[*]:-none}"

# The stand-in app (CommonJS, no dependencies). It logs check names and results, never values, and listens
# only after its start-up checks.
STANDIN="$(cat <<'JS'
'use strict';
// Stand-in for a Velexis app, written by deploy/systemd/test/units-smoke.sh (X-021).
const fs = require('fs'), os = require('os'), net = require('net'), http = require('http');
const https = require('https'), dns = require('dns').promises;
const env = process.env, results = {};
const tcp = (addr, hello, isReply) => new Promise((resolve, reject) => {
  const [host, port] = addr.split(':'), s = net.connect(Number(port), host, () => s.write(hello));
  s.setTimeout(5000, () => s.destroy(new Error('timeout')));
  s.once('error', reject).once('data', (d) => {
    s.destroy();
    if (isReply(d)) resolve(`reply ${JSON.stringify(d.toString('latin1', 0, 1))}`);
    else reject(new Error('unexpected reply'));
  });
});
const read = (p) => {
  try { fs.readFileSync(p); } catch (e) { if (e.code !== 'EISDIR') throw e; fs.readdirSync(p); }
};
const checks = {
  release: () => `${fs.readdirSync('.').length} entries, ${fs.readFileSync(__filename).length} bytes read`,
  keys: () => {
    const files = Object.keys(env).filter((k) => k.endsWith('_FILE')).map((k) => env[k]);
    if (env.MASTER_KEY_DIR) {
      const masters = fs.readdirSync(env.MASTER_KEY_DIR).filter((f) => /^master-v\d+\.key$/.test(f));
      files.push(...masters.map((f) => `${env.MASTER_KEY_DIR}/${f}`));
    }
    files.forEach(read);
    if (env.SMOKE_ROLE === 'backend' && files.length < 2) throw new Error('no key files configured');
    return `${files.length} key files read`;
  },
  // PostgreSQL SSLRequest: the server answers S or N. Redis PING: +PONG, or -NOAUTH with a password set.
  postgres: () => tcp(env.SMOKE_PG, Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]), (d) => d[0] === 83 || d[0] === 78),
  redis: () => tcp(env.SMOKE_REDIS, 'PING\r\n', (d) => d[0] === 43 || d[0] === 45),
  dns: async () => {
    const addresses = await dns.lookup(new URL(env.SMOKE_HTTPS_URL).hostname, { all: true });
    return `${addresses.length} addresses`;
  },
  https: () => new Promise((resolve, reject) => {
    const options = { headers: { 'user-agent': 'velexis-units-smoke' }, timeout: 15000 };
    https.get(env.SMOKE_HTTPS_URL, options, (r) => { r.resume(); resolve(`HTTP ${r.statusCode}`); })
      .on('timeout', function () { this.destroy(new Error('timeout')); }).on('error', reject);
  }),
  os: () => {
    const c = os.cpus().length, n = Object.keys(os.networkInterfaces()).length;
    if (!c || !n) throw new Error(`${c} cpus, ${n} interfaces`);
    return `${c} cpus, ${n} interfaces`;
  },
  forbidden: () => (env.SMOKE_FORBIDDEN || '').split(':').filter(Boolean).map((p) => {
    try { read(p); } catch (e) {
      if (e.code === 'EACCES' || e.code === 'ENOENT') return `${e.code} ${p}`;
      throw new Error(`${e.code} ${p}`);
    }
    throw new Error(`READABLE ${p}`);
  }),
};
(async () => {
  console.log(JSON.stringify({ level: 30, msg: 'stand-in starting', pid: process.pid }));
  for (const [name, check] of Object.entries(checks)) {
    try {
      results[name] = { ok: true, detail: await check() };
    } catch (e) {
      results[name] = { ok: false, detail: e.message };
    }
  }
  const ok = Object.values(results).every((r) => r.ok);
  const summary = Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.ok]));
  const msg = ok ? 'stand-in ready' : 'stand-in checks failed';
  console.log(JSON.stringify({ level: ok ? 30 : 50, msg, envNames: Object.keys(env).sort(), checks: summary }));
  http.createServer((req, res) => {
    if (req.url === '/health/live') return res.end('ok');
    if (req.url !== '/health/ready') return res.writeHead(404).end();
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok, checks: results }, null, 1));
  }).listen(Number(env.PORT || env.HEALTH_PORT), env.HOSTNAME || '127.0.0.1');
})();
JS
)"

# Release folder as deploy.sh hands it over: root:velexis, u=rX,g=rX,o= (deployment-single-vm.md §4).
install -d -m 0755 "$PREFIX/bin" "$PREFIX/srv" "$PREFIX/srv/velexis" "$PREFIX/sbin" "$PREFIX/var" "$PREFIX/var/lib"
install -d -m 0751 -o root -g velexis "$PREFIX/srv/velexis/releases"
install -d "$REL"
ln -sfn "$REL" "$PREFIX/srv/velexis/current"
# A root-owned copy of node, like /usr/bin/node on the VM: a setup-node or nvm install may not be readable by the
# app user, or may sit under /home, which ProtectHome=yes hides.
install -m 0755 "$NODE" "$PREFIX/bin/node"

# Only the paths change; every other line of the template is kept as it is.
render_unit() { # template-file destination-name
  sed -e "s#/srv/velexis#$PREFIX/srv/velexis#g" \
      -e "s#/etc/velexis#$PREFIX/etc/velexis#g" \
      -e "s#/var/lib/velexis#$PREFIX/var/lib/velexis#g" \
      -e "s#/usr/local/sbin/velexis-#$PREFIX/sbin/velexis-#g" \
      -e "s#^ExecStart=/usr/bin/node #ExecStart=$PREFIX/bin/node #" \
      -e "s#^CacheDirectory=velexis/#CacheDirectory=$CACHE_BASE/#" \
      -e "s#velexis-alert@#velexis-smoke-alert@#g" "$1" > "/etc/systemd/system/$2"
  local production='(^|[^A-Za-z0-9._-])/(srv|etc|var/lib|var/log|var/cache|var/backups|usr/local/sbin)/velexis'
  if grep -nE "$production|^CacheDirectory=velexis/|velexis-alert@|^ExecStart=/usr/bin/" "/etc/systemd/system/$2"
  then
    die "$2 still names a production path that this test does not map; extend render_unit"
  fi
}
render_unit "$UNITS/$BACKEND.service" "$B_UNIT"
render_unit "$UNITS/$FRONTEND.service" "$F_UNIT"
render_unit "$UNITS/velexis-alert@.service" "$A_TEMPLATE"

for f in "$B_UNIT" "$F_UNIT"; do
  wd="$(unit_value "/etc/systemd/system/$f" WorkingDirectory)"
  main="$(sed -n 's/^ExecStart=.* //p' "/etc/systemd/system/$f")" # the last word: dist/main.js, .../server.js
  install -d "$(dirname "$wd/$main")"
  printf '%s\n' "$STANDIN" > "$wd/$main"
done
chown -R root:velexis "$REL"
chmod -R u=rX,g=rX,o= "$REL"
install -d -m 0750 -o "$B_USER" -g "$B_GROUP" "$PREFIX/var/lib/velexis"
install -d -m 0700 -o "$B_USER" -g "$B_GROUP" "$PREFIX/var/lib/velexis/storage"

# Key files: the paths of the env templates, owned by the zone's user, 0400 in 0500 folders (provision-vm.sh).
install -d -m 0750 -o root -g velexis "$ETC"
key_vars() { # template -> its MASTER_KEY_DIR and *_FILE lines, under the prefix
  grep -E '^(MASTER_KEY_DIR|[A-Z0-9_]+_FILE)=' "$DEPLOY/env/$1.env.example" | sed "s#/etc/velexis#$ETC#g"
}
make_keys() { # template user group
  local line path files=()
  while IFS= read -r line; do
    path="${line#*=}"
    if [ "${line%%=*}" = MASTER_KEY_DIR ]; then files+=("$path/master-v1.key"); else files+=("$path"); fi
  done < <(key_vars "$1")
  for path in "${files[@]}"; do
    install -d -m 0500 -o "$2" -g "$3" "$(dirname "$path")"
    head -c 32 /dev/urandom | base64 > "$path"
    chown "$2:$3" "$path"
    chmod 0400 "$path"
  done
}
make_keys platform-backend "$P_USER" "$P_GROUP"
make_keys ota-backend "$B_USER" "$B_GROUP"
B_KEY_VARS="$(key_vars ota-backend)"
MASTER_KEY="$(sed -n 's/^MASTER_KEY_DIR=//p' <<<"$B_KEY_VARS")/master-v1.key"
PLATFORM_JWT="$(key_vars platform-backend | sed -n 's/^JWT_PRIVATE_KEY_FILE=//p')"
if [ -z "$PLATFORM_JWT" ] || [ ! -f "$MASTER_KEY" ]; then die "key paths not found in the deploy/env templates"; fi

# Env files: one per template; root:velexis 0640 below, the loosest mode provision-vm.sh gives app env files.
for tpl in "$DEPLOY"/env/*.env.example; do
  printf '# units-smoke.sh test file\nSMOKE_CANARY=%s\n' "$CANARY" > "$ETC/$(basename "$tpl" .example)"
done
install -d -m 0700 "$ETC/backup"
common_env() { # role
  printf 'SMOKE_ROLE=%s\nSMOKE_PG=%s\nSMOKE_REDIS=%s\nSMOKE_HTTPS_URL=%s\nSMOKE_CANARY=%s\n' \
    "$1" "$PG" "$REDIS" "$HTTPS_URL" "$CANARY"
  [ -z "${SMOKE_NODE_EXTRA_CA_CERTS:-}" ] || printf 'NODE_EXTRA_CA_CERTS=%s\n' "$SMOKE_NODE_EXTRA_CA_CERTS"
}
join() { local IFS=:; echo "$*"; }
env_file_of() { unit_value "/etc/systemd/system/$1" EnvironmentFile | sed 's/^-//'; }
# What each app must not read: the OTA API the worker's provisioner DSN, the migrator DSN, root's files and the
# platform's secrets; a Next.js app every key and every backend secret.
B_FORBIDDEN=(ota-worker.env migrator.env alert.env backup.env caddy.env platform-backend.env platform-worker.env)
F_FORBIDDEN=(platform-backend.env platform-worker.env ota-backend.env ota-worker.env migrator.env alert.env
  backup.env caddy.env)
B_FORBIDDEN_PATHS=("${B_FORBIDDEN[@]/#/$ETC/}" "$PLATFORM_JWT")
F_FORBIDDEN_PATHS=("$ETC/keys" "$MASTER_KEY" "${F_FORBIDDEN[@]/#/$ETC/}")
{
  common_env backend
  printf '%s\n' "$B_KEY_VARS"
  echo "SMOKE_FORBIDDEN=$(join "${B_FORBIDDEN_PATHS[@]}")"
} > "$(env_file_of "$B_UNIT")"
{
  common_env frontend
  echo "SMOKE_FORBIDDEN=$(join "${F_FORBIDDEN_PATHS[@]}")"
} > "$(env_file_of "$F_UNIT")"
cat > "$ETC/alert.env" <<EOF
ALERT_SMTP_URL=$SMTP_URL
ALERT_SMTP_USER=
ALERT_SMTP_PASSWORD=
ALERT_SMTP_TLS=${SMOKE_SMTP_TLS:-none}
ALERT_FROM=velexis-smoke@example.com
ALERT_TO=$ALERT_TO
ALERT_HOST_LABEL=units-smoke-$RUN_ID
SMOKE_CANARY=$CANARY
EOF
chown root:velexis "$ETC"/*.env
chmod 0640 "$ETC"/*.env
install -m 0755 "$DEPLOY/scripts/alert.sh" "$PREFIX/sbin/velexis-alert"

step "Forbidden paths: they exist, and the file mode alone would let the unit's user read them or not"
show_forbidden() { # unit user path...
  local unit="$1" user="$2" p
  shift 2
  for p in "$@"; do
    [ -e "$p" ] || die "forbidden path $p does not exist, so ENOENT would prove nothing"
    if runuser -u "$user" -- test -r "$p"; then
      echo "     $unit: $p (file mode: readable by $user, so only the sandbox can deny it)"
    else
      echo "     $unit: $p (file mode: not readable by $user)"
    fi
  done
}
show_forbidden "$B_UNIT" "$B_USER" "${B_FORBIDDEN_PATHS[@]}"
show_forbidden "$F_UNIT" "$F_USER" "${F_FORBIDDEN_PATHS[@]}"

systemctl daemon-reload
step "systemd-analyze verify of the installed test units (node and the alert script exist: no message allowed)"
if out="$(systemd-analyze verify --man=no "/etc/systemd/system/$B_UNIT" "/etc/systemd/system/$F_UNIT" \
            "/etc/systemd/system/$A_TEMPLATE" 2>&1)" && [ -z "$out" ]; then
  pass "systemd-analyze verify is clean"
else
  printf '%s\n' "$out"
  fail "systemd-analyze verify reported problems"
fi

# ---- 3. start both units and read the stand-in's checks -------------------------------------------------------
port_of() { sed -n 's/^Environment=\(PORT\|HEALTH_PORT\)=//p' "/etc/systemd/system/$1" | tail -n 1; }
B_PORT="$(port_of "$B_UNIT")"
F_PORT="$(port_of "$F_UNIT")"
for port in "$B_PORT" "$F_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then die "port $port is already in use"; fi
done

diagnose() { # unit
  systemctl status --no-pager --lines=0 "$1" || true
  journalctl -u "$1" -n 30 --no-pager -o cat || true
}
wait_ready() { # port -> prints the /health/ready body; fails on 503 (a check failed) or after 60 s
  local _ body url="http://127.0.0.1:$1/health/ready"
  for _ in $(seq 1 60); do
    if body="$(curl -fsS --max-time 5 "$url" 2>/dev/null)"; then
      printf '%s\n' "$body"
      return 0
    fi
    if curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null | grep -x 503 >/dev/null; then
      curl -sS --max-time 5 "$url" || true
      echo
      return 1
    fi
    sleep 1
  done
  return 1
}

step "Start $B_UNIT (port $B_PORT) and $F_UNIT (port $F_PORT)"
if ! systemctl start "$B_UNIT" "$F_UNIT"; then
  diagnose "$B_UNIT"
  diagnose "$F_UNIT"
  die "systemctl start failed"
fi
for pair in "$B_UNIT:$B_PORT" "$F_UNIT:$F_PORT"; do
  unit="${pair%%:*}"
  if body="$(wait_ready "${pair#*:}")"; then
    printf '%s\n' "$body"
    pass "$unit: the stand-in passed its start-up checks (release folder, key files for a backend, PostgreSQL," \
      "Redis, DNS, HTTPS, os.cpus(), os.networkInterfaces()) and every forbidden path was denied [X-021 AC2]"
  else
    printf '%s\n' "${body:-}"
    diagnose "$unit"
    fail "$unit: the stand-in is not ready [X-021 AC2]"
  fi
done
[ "$FAILED" -eq 0 ] || die "the units did not start cleanly; not killing anything"

# ---- 4. kill the backend unit into failed and check the alert ----------------------------------------------
wait_new_pid() { # unit old-pid -> prints the new main PID; fails when the unit is failed
  local _ state pid
  for _ in $(seq 1 60); do
    state="$(systemctl show -P ActiveState "$1")"
    pid="$(systemctl show -P MainPID "$1")"
    [ "$state" = failed ] && return 1
    if [ "$state" = active ] && [ "$pid" != 0 ] && [ "$pid" != "$2" ]; then
      echo "$pid"
      return 0
    fi
    sleep 0.5
  done
  return 1
}
is_live() { curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$1/health/live" 2>/dev/null; }
is_failed() { [ "$(systemctl show -P ActiveState "$1")" = failed ]; }

step "Kill $B_UNIT with SIGKILL at most $MAX_KILLS times within 300 s"
burst="$(unit_value "/etc/systemd/system/$B_UNIT" StartLimitBurst)"
interval="$(unit_value "/etc/systemd/system/$B_UNIT" StartLimitIntervalSec)"
t0="$(date +%s)"
kills=0
pid=0
while [ "$kills" -lt "$MAX_KILLS" ]; do
  pid="$(wait_new_pid "$B_UNIT" "$pid")" || break
  # The stand-in listens only after its start-up checks, so every run has logged before it dies.
  retry 60 is_live "$B_PORT" || { diagnose "$B_UNIT"; die "the restarted stand-in (PID $pid) did not come up"; }
  kill -KILL "$pid"
  kills=$((kills + 1))
done
retry 60 is_failed "$B_UNIT" || true
elapsed=$(($(date +%s) - t0))
state="$(systemctl show -P ActiveState "$B_UNIT")"
result="$(systemctl show -P Result "$B_UNIT")"
# The start limit keeps the result of the last run (Result=signal after a kill) and logs this line instead.
limit_hit() {
  journalctl -u "$B_UNIT" --since "@$t0" --no-pager -o cat \
    | grep -F 'Start request repeated too quickly' >/dev/null
}
if [ "$state" = failed ] && retry 20 limit_hit && [ "$elapsed" -le 300 ]; then
  pass "$B_UNIT is failed by its start limit (StartLimitBurst=$burst, StartLimitIntervalSec=$interval)" \
    "after $kills kills in ${elapsed}s (Result=$result) [X-021 AC3]"
else
  diagnose "$B_UNIT"
  die "$B_UNIT is $state (Result=$result) after $kills kills in ${elapsed}s; start limit message:" \
    "$(limit_hit && echo found || echo missing) [X-021 AC3]"
fi

step "Alert mail for $B_UNIT in Mailpit ($MAILPIT, to $ALERT_TO)"
search() { curl -fsS --max-time 5 --get --data-urlencode "query=to:$ALERT_TO" "$MAILPIT/api/v1/search"; }
messages() { # field: ID of the newest message, or count
  "$NODE" -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
    const m = JSON.parse(s).messages || [];
    process.stdout.write(process.argv[1] === "count" ? String(m.length) : (m.length ? m[0].ID : ""));
  });' "$1"
}
id=""
for _ in $(seq 1 60); do
  id="$(search 2>/dev/null | messages ID || true)"
  [ -n "$id" ] && break
  sleep 1
done
if [ -z "$id" ]; then
  diagnose "$A_UNIT"
  die "no alert mail for $ALERT_TO in Mailpit"
fi
mail="$(curl -fsS --max-time 10 "$MAILPIT/api/v1/message/$id/raw" | tr -d '\r')"
printf '%s\n' "$mail" | sed -n '1,/^$/p' | grep -E '^(From|To|Subject):' || true
mail_has() { printf '%s\n' "$mail" | grep -F -- "$1" >/dev/null; }
mail_log_has() { printf '%s\n' "$mail" | sed -n '/^Last log lines:/,$p' | grep -F -- "$1" >/dev/null; }
check "the subject names $B_UNIT [X-021 AC3]" mail_has "Subject: [velexis][units-smoke-$RUN_ID] $B_UNIT failed"
check "the mail carries the unit status (Active: failed) [X-021 AC3]" mail_has "Active: failed"
check "the mail's last log lines show the start limit [X-021 AC3]" mail_log_has "Start request repeated too quickly"
check "the mail's last log lines include the app's own output [X-021 AC3]" mail_log_has '"msg":"stand-in ready"'
check "$A_UNIT finished with Result=success [X-021 AC3]" test "$(systemctl show -P Result "$A_UNIT")" = success
check "exactly one alert mail for $kills kills (RestartMode=direct: no mail per crash) [X-021 AC3]" \
  test "$(search | messages count)" = 1

step "No env value reaches the journal or the mail"
journal_has_canary() {
  journalctl -u "$B_UNIT" -u "$F_UNIT" -u "$A_UNIT" --no-pager -o cat | grep -F -- "$CANARY" >/dev/null
}
check "the canary value of the env files is not in the journal" not journal_has_canary
check "the canary value of the env files is not in the mail" not mail_has "$CANARY"

if [ "$FAILED" -ne 0 ]; then
  printf '\nunits-smoke: FAILED\n'
  exit 1
fi
printf '\nunits-smoke: all checks passed\n'
