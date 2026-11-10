# Performance smoke tests

`platform-smoke.mjs` is the M6 performance smoke test of the platform API (PBE-063 of [`platform/docs/plans/agent-tasks.md`](../../platform/docs/plans/agent-tasks.md)). It measures the operations that see the most traffic, and the RSS of the API and its worker against the memory budget of [`docs/mvp/architecture.md` §3](../../docs/mvp/architecture.md#3-hosts-ports-and-the-vm). The recorded runs, the targets and what was decided from them are in [`platform/docs/performance.md`](../../platform/docs/performance.md). The OTA backend's load tests are in [`ota/backend/test/load/`](../../ota/backend/test/load/README.md).

- **Plain Node 22, no dependency.** It uses `fetch`, a small concurrency limiter and the standard library. It has no `package.json` and loads no workspace package.
- **A client of a running API.** It talks to a production build of the platform API (`node dist/main.js`) and its worker, as the portal's server and Caddy do. It opens no database connection.
- **Not part of `pnpm test`, `pnpm test:int` or CI.** It measures the machine it runs on, so it runs by hand. Every recorded run names the machine, `nproc` and the load average.
- **Scratch stacks only.** It signs up accounts and creates OTAs on the API it is given. Run it against the scratch stack below, never against the VM or the development database `velexis`.

## Run it

You need the local setup of [`docs/mvp/local-development.md`](../../docs/mvp/local-development.md) §2: PostgreSQL 16 with the roles of `dev-setup.sh` (`velexis_test_admin` among them), `redis-server` and Mailpit. No other test suite may run on the machine during a run you record. The end-to-end stack uses the same ports (3100 and 3101), and the CPU is what the test measures.

**1. Build, and the key files.**

```bash
pnpm build --filter=@velexis/platform-backend... --filter=@velexis/reference-data...
pnpm dev:keys                                          # .local/keys/, if it is not there yet
set -a; . ./.env.example; set +a                       # TEST_DATABASE_ADMIN_URL of the development roles
```

**2. A scratch database and a private Redis.** The database is built the way the end-to-end harness builds its own ([`tools/e2e/support/stack.ts`](../e2e/support/stack.ts), `createStackDatabase`): created by `velexis_test_admin`, owned by `velexis_migrator`, `schemas.sql`, then the migrations and the reference data. Pick a Redis port where nothing answers (`redis-cli -p <port> ping` must fail).

```bash
DB=velexis_perf_$(date +%s); RP=6390
MIGRATOR=postgres://velexis_migrator:dev_migrator@127.0.0.1:5432/$DB
APP=postgres://velexis_platform_app:dev_platform@127.0.0.1:5432/$DB
redis-server --port $RP --bind 127.0.0.1 --requirepass dev_redis --save '' --appendonly no --daemonize yes
psql "$TEST_DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE $DB OWNER velexis_migrator ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0" \
  -c "REVOKE ALL ON DATABASE $DB FROM PUBLIC" \
  -c "GRANT CONNECT, TEMPORARY ON DATABASE $DB TO velexis_platform_app, velexis_ota_app" \
  -c "GRANT CONNECT, TEMPORARY, CREATE ON DATABASE $DB TO velexis_provisioner" \
  -c "GRANT ALL ON DATABASE $DB TO velexis_migrator"
psql "$MIGRATOR" -v ON_ERROR_STOP=1 -1 -f deploy/postgres/schemas.sql
DATABASE_MIGRATOR_URL=$MIGRATOR pnpm db:migrate
APP_ENV=test DATABASE_URL=$APP pnpm db:seed:reference
```

**3. The environment file.** It is the VM's template, [`deploy/env/platform-backend.env.example`](../../deploy/env/platform-backend.env.example) (`APP_ENV=production`, `LOG_LEVEL=info`, every feature switch off), with these lines appended. A later line wins when the file is read.

```bash
ENV_FILE=$(mktemp)                                     # mode 0600; it holds the BFF key
cat deploy/env/platform-backend.env.example - > "$ENV_FILE" <<EOF
DATABASE_URL=$APP
REDIS_URL=redis://:dev_redis@127.0.0.1:$RP/0
PLATFORM_BFF_KEY=$(openssl rand -hex 32)
MASTER_KEY_DIR=$PWD/.local/keys
API_KEY_PEPPER_FILE=$PWD/.local/keys/api-key-pepper
JWT_PRIVATE_KEY_FILE=$PWD/.local/keys/platform-jwt-ed25519.pem
SMTP_URL=smtp://127.0.0.1:1025
OPS_ALERT_EMAIL=ops@example.com
DNS_RESOLVERS=127.0.0.1:9
AMADEUS_BASE_URL_TEST=https://test.travel.api.amadeus.com
AMADEUS_BASE_URL_LIVE=https://travel.api.amadeus.com
STORAGE_DIR=$PWD/.local/storage
EOF
```

`SMTP_URL` is Mailpit's SMTP port, because the set-up reads the verification e-mails from Mailpit. The Amadeus lines are the official hosts, the only ones `APP_ENV=production` accepts; the run calls neither. `DNS_RESOLVERS` is a loopback port where nothing answers, so no lookup leaves the machine.

**4. The worker and the API, as their systemd units start them.** The units are [`deploy/systemd/velexis-platform-worker.service`](../../deploy/systemd/velexis-platform-worker.service) and [`velexis-platform-api.service`](../../deploy/systemd/velexis-platform-api.service). Each gets a clean environment, `NODE_ENV=production`, its `--max-old-space-size` and `--enable-source-maps`. The ports are the units' defaults: 3100 for the API and 3101 for the worker's health server.

```bash
start() {   # <entry> <max-old-space-size MB> <log file>; prints the pid
  nohup env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production NODE_OPTIONS="--max-old-space-size=$2" \
    bash -c 'cd platform/backend && set -a && . "$0" && set +a && exec node --enable-source-maps "$1"' \
    "$ENV_FILE" "$1" > "$3" 2>&1 < /dev/null &
  echo $!
}
WORKER_PID=$(start dist/worker.js 400 /tmp/platform-worker.log)
API_PID=$(start dist/main.js 640 /tmp/platform-api.log)
until curl -fsS -o /dev/null http://127.0.0.1:3100/health/ready \
  && curl -fsS -o /dev/null http://127.0.0.1:3101/health/ready; do sleep 1; done
```

**5. The test.** Note `nproc` and `uptime` first. The test also prints the load average at the start and end of every phase.

```bash
export PLATFORM_BFF_KEY=$(sed -n 's/^PLATFORM_BFF_KEY=//p' "$ENV_FILE" | tail -n 1)
export MAILPIT_API_URL=http://127.0.0.1:8025
node tools/perf/platform-smoke.mjs --base http://127.0.0.1:3100 --duration 10      # the Verify command of PBE-063
node tools/perf/platform-smoke.mjs --base http://127.0.0.1:3100 --json run.json    # the recorded run: 60 s per phase
node tools/perf/platform-smoke.mjs --help
```

A second run on the same stack works: every run makes accounts and OTAs of its own. A recorded run starts from a fresh stack, so the RSS after start-up is the API's own.

**6. Clean-up.**

```bash
kill $API_PID $WORKER_PID
while kill -0 $API_PID 2>/dev/null || kill -0 $WORKER_PID 2>/dev/null; do sleep 0.5; done
redis-cli -p $RP -a dev_redis --no-auth-warning shutdown nosave
psql "$TEST_DATABASE_ADMIN_URL" -c "DROP DATABASE $DB WITH (FORCE)"
rm -f "$ENV_FILE"
```

| Option | Default | What it does |
|---|---|---|
| `--base <url>` | `http://127.0.0.1:3100` | The API. Loopback only: `ask` answers loopback callers only, and the RSS is read from `/proc`. |
| `--duration <s>` | 60 | Measured seconds of each phase, at most 600 (an access token must outlive a whole phase) |
| `--warmup <s>` | 5 | Seconds of the same traffic before each phase, not counted, at most 60. It compiles the code paths, opens the pool's connections and, for `ask`, fills the caches. |
| `--phases <list>` | all six | A comma-separated subset: `signIn`, `getTenant`, `listApiKeys`, `tlsAskCached`, `tlsAskUncached`, `createTenant` |
| `--accounts <n>` | computed | Portal accounts of the set-up. The default keeps every account under the `authenticated` rate limit (300 per account per minute, using at most 80 % of it) and under `MAX_TENANTS_PER_ACCOUNT` for the run's `createTenant` calls: 33 for the defaults, 8 for `--duration 10`. A smaller value is a usage error. |
| `--max-tenants-per-account <n>` | 3 | The API's `MAX_TENANTS_PER_ACCOUNT` |
| `--concurrency <n>` | 50 | Requests in flight at most. A start that waits more than 50 ms for a free slot counts as late. |
| `--rate-scale <x>` | 1 | Every phase at *x* times its rate (0.1 to 20), to see the headroom above the plan's rates. The accounts grow with it. |
| `--worker-port <port>` | 3101 | The worker's health port, to find the worker's process |
| `--api-pid`, `--worker-pid` | found by port | The processes whose RSS and CPU are sampled |
| `--mailpit <url>` | `MAILPIT_API_URL` or `http://127.0.0.1:8025` | Mailpit's API, where the set-up reads the verification e-mails |
| `--json <file>` | — | Also writes the figures as JSON (no account, password, token or key) |

`PLATFORM_BFF_KEY` must be the API's value. The test sends it with every portal call, as the portal's server does ([PADR-0019](../../platform/docs/adr/0019-end-user-ip-forwarding-from-the-portal-and-admin.md)). It is read from the environment only, so it never shows in the process list, and it is never printed.

Exit codes:

- **0:** every answer was expected, every phase kept its rate, every target was met, and both processes were measured and stayed within their budgets.
- **1:** an unexpected answer, a missed target, a phase that did not keep its rate, a process over its budget or not measured, or a set-up that failed. The `Result:` line names each problem.
- **2:** a usage error.
- **130:** interrupted. The report shows what was measured until then. A second Ctrl-C stops at once.

## What a run does

1. **Checks.** `GET /health/ready` must answer `200`. The test finds the processes that listen on the API's port and on `--worker-port` (`/proc/net/tcp`, then the sockets in `/proc/<pid>/fd`). Then it samples their `VmRSS` and `VmHWM` from `/proc/<pid>/status` once a second until the end.
2. **Set-up (not measured).** It makes `--accounts` portal accounts through the public operations, four at a time. Each one goes through `signUp`, the `/verify-email` link of the e-mail the worker sends to Mailpit, `verifyEmail`, `signIn` and `createTenant`. That gives one OTA per account, in `provisioning` with a manual trial: no OTA worker runs, so its job waits in `ota-tenant-ops`. Every account has its own end-user IP in `198.18.0.0/15` (RFC 2544, never routed), sent as `X-Velexis-End-User-IP` with the BFF key. So the per-IP limits of [api-inventory §2](../../platform/docs/api-inventory.md#2-conventions) never answer.
3. **Six phases, one after the other.** Each phase runs `--warmup` seconds that are not counted, then `--duration` seconds that are. Requests start at a fixed rate (an open loop), the rate of the table times `--rate-scale`: request *i* is due at *i* / rate seconds, whatever the earlier answers took.

   | Phase | Rate | Each request |
   |---|---|---|
   | `signIn` | 10/s | `POST /v1/auth/sign-in` of the next account, with an end-user IP of its own (the limit is 10 per IP per minute). One Argon2id verification. |
   | `getTenant` | 50/s | `GET /v1/tenants/{tenantId}` of the next account's OTA, with its access token |
   | `listApiKeys` | 50/s | `GET /v1/tenants/{tenantId}/api-keys` of the next account's OTA. The list is empty: keys are issued when the OTA worker has provisioned the OTA. |
   | `tlsAsk cached` | 100/s | `GET /internal/tls/ask?domain=…`, as Caddy asks: in turn the OTAs' sub-domains (allowed, `200`, from Redis `tlsask:<host>`) and as many unknown sub-domains (`404`, from the in-process cache of refusals). Each host is asked again and again. Both caches keep an answer 60 seconds, so a host is looked up in PostgreSQL again about once a minute. |
   | `tlsAsk uncached` | 100/s | `ask` for a sub-domain no one asked before: one indexed PostgreSQL lookup each, answered `404` |
   | `createTenant` | 1/s | `POST /v1/tenants` with an `Idempotency-Key`, for an account that owns fewer than `--max-tenants-per-account` OTAs |

   Every phase that needs access tokens first signs in again any account whose token would not outlive the phase by a minute (tokens live 15 minutes).
4. **The report.** The test prints the report and, with `--json`, writes it. It leaves the accounts and OTAs in the scratch database, which the clean-up drops.

## Reading the report

| Column or section | What the figures are |
|---|---|
| Rate/s, Sent, Reached/s | The planned rate, the requests started in the measured seconds, and the rate reached. A rate below the plan means the limiter was full or the test's own event loop was late. **Late starts** counts the requests that started more than 50 ms after their due time. A phase with more than 1 % of its requests late did not keep its rate: a request waiting for a free slot is not timed, so its latencies are those of a lower rate. |
| Expected, Errors | Answers with the expected status (`200`, `202` for `createTenant`, `404` for unknown hosts), and every other answer. The errors are listed below the table by status and error code, or as `timeout` (10 s) or `network …`. A `429` is an error here: the set-up sizes the run so that no limit answers. |
| p50, p95, p99, Max | Client-side milliseconds from sending the request to the last byte of the answer, over the expected answers of the measured seconds. Percentiles are nearest-rank. |
| p95 target, Result | The targets of PBE-063: below 300 ms for the reads (`getTenant`, `listApiKeys`, an uncached `ask`), below 800 ms for `signIn`, below 20 ms for a cached `ask`. `createTenant` has no target. `met` (or `no target`), else what went wrong: `MISSED`, `errors` when an answer was unexpected, `rate not kept`. |
| API CPU s, Worker CPU s | User plus system CPU seconds each process used during the measured seconds (`/proc/<pid>/stat`) |
| Load 1m | The 1-minute load average at the start and the end of the measured seconds. The header line gives `nproc` and the three load averages at the start and end of the whole run. |
| RSS table | `VmRSS` in MiB after start-up (the first sample, before the set-up), at its sampled peak and at the end, and `VmHWM` (the kernel's peak since the process started), against the unit's `MemoryMax` (768 MiB for the API, 512 MiB for the worker). `within` when both the peak and `VmHWM` are at most the budget; `not measured` (a failed run) when the process was not found or its `/proc` files could not be read. The second table gives the RSS at the end of each phase with that phase's peak. |

The figures are what one process uses next to the others on a shared machine. `MemoryMax` limits the unit's cgroup, which also counts the page cache the process causes; `VmRSS` is the process's resident memory, which is what the budget of architecture §3 adds up.
