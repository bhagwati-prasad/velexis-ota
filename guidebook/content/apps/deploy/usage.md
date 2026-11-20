---
id: usage
title: Deploy and operations — usage guide
summary: How the operator provisions the single VM, deploys and rolls back releases, reads health checks, alerts and security logs, backs up and restores, changes the outbound allow-list and the WAF, and how CI, E2E and the Deploy workflow decide what reaches the VM.
---

## What it is

`repo:deploy` is not an app with screens: it is the [[single-vm]] that runs every other Velexis app, and the
commands, timers and workflows around it. Everything runs on one Ubuntu 24.04 VM without Docker (ADR-0007):

- **Edge:** [[caddy]] (the [[velexis-caddy-build]] with the [[coraza-waf]]) on ports 80/443 terminates TLS for the six
  public host patterns, gets certificates [[on-demand-tls|on demand]] for storefronts and proxies to the apps on
  `127.0.0.1`.
- **Apps:** seven systemd units, one system user per [[trust-zone]], each with its [[env-file]] in `/etc/velexis`
  (`root:root 0600`, read by systemd only) and strict [[unit-sandboxing]].
- **Data:** PostgreSQL 16 and Redis 7.4 on loopback only, with four [[database-roles]].
- **Operations:** [[velexis-deploy]] (the only command the [[deploy-user]] may run), [[velexis-run]],
  the [[on-vm-health-check]], nightly [[backup-set|backups]], the [[security-log-shipment]] and
  [[security-log-review]], the [[outbound-allow-list]] and [[velexis-alert]] e-mails.
- **Pipeline:** the [[ci-workflow]] on every pull request, the [[e2e-workflow]] nightly and before each deploy, and
  the [[deploy-workflow]] that builds a [[release-folder]] and activates it on the VM.

```diagram
topology
```

Who uses it: the owner/developer as operator (SSH with a [[ssh-second-factor]]), GitHub Actions as the deploy user,
and you, the bug hunter, to check what a deploy, a health check or a backup actually changed.

## Before you start

You cannot (and should not) run the VM scripts against your own machine: `provision-vm.sh` and `check-vm.test.sh`
change system settings. Locally you use three things:

1. **[[dev-setup]]** for the databases every other app needs:

```try
command: bash deploy/scripts/dev-setup.sh
expect: A summary "Velexis local services" with status ok for every login of .env.example (velexis_migrator/dev_migrator, velexis_provisioner/dev_provisioner, velexis_platform_app/dev_platform, velexis_ota_app/dev_ota, velexis_test_admin/dev_test_admin; development only), the row "password required" with ok and REDIS_URL for Redis (dev_redis), then "Next steps". A second run changes nothing and shows Redis "password already set (unchanged)".
```

```diagram
flow-local-setup
```

2. **The test harnesses** of the VM scripts. They run the real scripts unchanged under a temporary `VELEXIS_ROOT`
   with fake `systemctl`, health ports and buckets, without root (about 1 minute each):

| What | Command | Needs |
|---|---|---|
| [[velexis-deploy]] | `bash deploy/scripts/test/deploy.test.sh` (`DEPLOY_TEST_KEEP=1` keeps its folder) | Node 24 |
| Health check | `bash deploy/scripts/test/healthcheck.test.sh` | curl, jq, openssl, Node ≥ 18 |
| Backup and restore | `bash deploy/scripts/test/backup-restore.test.sh` | local PostgreSQL of dev-setup, age, rclone 1.6x, zstd, pg 16 client |
| Logs | `bash deploy/scripts/test/ship-logs.test.sh && bash deploy/scripts/test/log-review.test.sh` | jq, age, zstd, rclone |
| Caddyfile end to end | `bash deploy/caddy/test/caddy-smoke.sh` | the Caddy build in `/tmp/caddy-build`, Node 24 |
| Release folder | `RELEASE_SHA=$(git rev-parse HEAD) bash deploy/scripts/pack-release.sh /tmp/release` | a built workspace |
| Shell lint | `shellcheck -S style deploy/scripts/*.sh deploy/scripts/test/*.sh deploy/systemd/test/*.sh deploy/caddy/test/*.sh deploy/caddy/build/*.sh` | shellcheck |

```warning
`sudo bash deploy/scripts/test/check-vm.test.sh` and `deploy/systemd/test/units-smoke.sh` need root, systemd as PID 1,
`nft` and PostgreSQL/Redis/Mailpit: run them only on a CI runner or a throwaway VM, never on the production VM.
```

3. **A throwaway Ubuntu 24.04 VM** (at least 4 GB RAM) for the real thing: provisioning, `check-vm.sh`, a Deploy run.
   Production hosts in this guide are placeholders (`platform.example.com`, `*.ota.example.com`).

## Tour

There are no screens; the "areas" are the commands, timers, files and workflows. Each row says what to try and what
should happen.

### Commands on the VM

| Command (installed as) | What it shows or does | Try | Expected |
|---|---|---|---|
| `sudo velexis-deploy --status` (`repo:deploy/scripts/deploy.sh`) | Active release and each unit's `is-active` (root only) | run it | `current: /srv/velexis/releases/<sha>` (or `current: none`) and seven `velexis-… active` lines, exit 0. While a deploy runs it prints `[<time>] ERROR: another deploy is running`, exits 1 and appends that line to `deploy.log` (it takes the deploy lock) |
| `sudo velexis-deploy <sha>` | Activate `/srv/velexis/incoming/<sha>` | (CI does this) | `deploy <sha> done` in `/var/log/velexis/deploy.log`, exit 0 |
| `sudo velexis-deploy --rollback` | Back to the previous release (snapshot units, Caddyfile, WAF, Caddy build) | after a deploy | `ROLLBACK to <sha>`; history line `<sha> rollback` |
| `sudo velexis-run <zone> <cmd…>` (`repo:deploy/scripts/run-as.sh`) | One-off command as a zone user with the zone unit's env files and sandbox | `sudo velexis-run platform node -e "process.exit(3)"` | exit code 3; `125` = velexis-run refused |
| `sudo velexis-healthcheck --status` (`repo:deploy/scripts/healthcheck.sh`) | Last state of every check, since when, first problem | run it | every check `ok`; sends nothing |
| `sudo velexis-healthcheck --payment-pages` | One run now including the daily payment-page check | after a deploy | `ok   payment-page-checkout-pay-card` and `…-pay-airline` lines, no alert; a following `--status` ends with `payment pages last checked on: <today> (UTC)` |
| `sudo systemctl start velexis-backup` (`repo:deploy/scripts/backup.sh`) | Backup now | then `journalctl -u velexis-backup -n 30` | last line: duration, destination, size |
| `sudo velexis-restore list / fetch / db / storage / redis / config / drill` (`repo:deploy/scripts/restore.sh`) | Restore tools; scratch database `velexis_restore` by default | `drill` on a scratch VM | figures of the restore beside the live ones, database dropped after |
| `sudo velexis-shiplogs --status` (`repo:deploy/scripts/ship-logs.sh`) | Last shipment, failure, cursor, daily files | run it | last verified shipment < 2 h old |
| `sudo velexis-logreview --status` / `--summary` (`repo:deploy/scripts/log-review.sh`) | Each review check's state; a summary now | `--summary` | one `security log review <date>` e-mail |
| `sudo velexis-egress refresh` / `validate <file>` (`repo:deploy/scripts/egress.sh`) | Load/refresh the nftables table; validate a list | `validate /etc/velexis/egress/allowed-hosts.conf` | exit 0, no output |
| `sudo bash …/check-vm.sh [--only g1,g2] [--templates dir]` (`repo:deploy/scripts/check-vm.sh`) | Read-only `PASS`/`FAIL` per hardening item, groups `system services audit firewall ssh database redis caddy users files envfiles` | `--only envfiles` | all `PASS`, exit 0; never a value |
| `sudo bash …/provision-vm.sh [--steps …]` (`repo:deploy/scripts/provision-vm.sh`) | Idempotent provisioning; steps `packages node harden users postgres redis caddy keys database envfiles scripts caddyconf summary`, plus `ssh`, `egress` by name | `--steps envfiles` on a provisioned VM | lists missing env variables; never rewrites an env file or key |

### Timers (all `velexis-*.timer`, root-owned services)

| Timer | Schedule | Writes | Alerts |
|---|---|---|---|
| `velexis-backup.timer` | daily 02:30 UTC (+≤10 min) | `/var/backups/velexis/<stamp>/`, bucket `daily/<date>/`, `/var/lib/velexis/backup-last-success` | unit failure → `velexis-alert@` |
| `velexis-healthcheck.timer` | every 5 min | `/var/lib/velexis/healthcheck/*.state` | one mail per state change |
| `velexis-egress-refresh.timer` | at boot, then every 2 min | `/var/lib/velexis/egress/addresses` | first failure of a run of failures |
| `velexis-ship-logs.timer` | hourly at :05 | bucket `logs/…`, `/var/log/velexis/security/` | unit failure |
| `velexis-log-review.timer` | hourly at :20 (summary after 06:00 UTC) | `/var/lib/velexis/log-review/` | immediate security alerts + daily summary |
| `dailyaidecheck.timer` (Ubuntu's) | daily 01:50–03:50 UTC | `/var/log/aide/aide.log` | through log-review (`aide-change`, `aide-error`, `aide-stale`) |

`systemctl list-timers 'velexis-*'` shows the next runs.

### Public hosts (through Caddy)

| Host | Goes to | Try | Expected |
|---|---|---|---|
| `platform.example.com` | portal 127.0.0.1:3000 | `curl -sI https://platform.example.com/` | 200, HSTS, `X-Frame-Options: DENY`, no `Server`; maintenance page (503) when the portal is down |
| `admin.platform.example.com` | platform admin :3001 | `/health/ready` | `404` (health is loopback-only on the Next.js hosts) |
| `api.platform.example.com` | platform API :3100 | `/health/live` | `{"status":"ok"}`; `/internal/*` and other `/health/*` → 404 |
| `admin.ota.example.com` | OTA admin :3002 | any page | body limit 10 MB; WAF detection only |
| `api.ota.example.com` | OTA API :4000 | `/health/live` | `{"status":"ok"}`; WAF **blocking**; JSON `SERVICE_UNAVAILABLE` 503 when the API is down |
| `*.ota.example.com`, verified custom domains | static storefront + `/api/*` → :4000 | `/`, `/checkout/pay-airline.html` | strict CSP; the airline page has its own CSP and `Cache-Control: no-store` |
| any `http://` | redirect | `curl -sI http://platform.example.com/` | `308` to `https://` |

### Workflows

| Workflow | When | What to look at |
|---|---|---|
| CI (`repo:.github/workflows/ci.yml`) | every PR and push to `main` | Jobs Plan lint, Deploy files, systemd units smoke test, VM check test, Local development setup, Build and test, Integration tests, Integration tests on other hosts and ports, SDK on Node.js 22.12 |
| E2E (`repo:.github/workflows/e2e.yml`) | nightly 02:23 UTC, on demand, label `e2e`, called by Deploy | Projects `portal`, `platform-admin`, `storefront`, `ota-admin`; `storefront-stripe`/`portal-stripe` with Stripe test secrets; artefact `e2e-<run id>-<attempt>` on failure |
| Deploy (`repo:.github/workflows/deploy.yml`) | Actions > Deploy > Run workflow, `main` or `v*` only | build (no secrets) + e2e → deploy (environment `production`, approval) → smoke check |

```diagram
seq-deploy-workflow
```

## How to …

### Provision a new VM

```diagram
flow-provision-vm
```

Steps (deployment guide §3): create the VM and DNS; generate the deploy key; copy `deploy/`, the public key and the
[[velexis-caddy-build]]; run `provision-vm.sh`; enrol and apply the [[ssh-second-factor]]; fill `/etc/velexis/*.env`;
set up backups and the log bucket; run [[check-vm]] until every line is `PASS`; back up `/etc/velexis` offline (it
holds the [[kek|master key]]).

```note
The first daily AIDE report after setup lists your own changes (env files, SSH second factor, backup files): this is
expected after the one-time [[aide-re-baseline]]. Review them, then re-baseline by hand (deployment guide §12).
```

### Do the first deploy

```diagram
flow-first-deploy
```

### Deploy a release and verify it

```diagram
flow-deploy-and-verify
```

1. If the release adds env variables, add them on the VM first (empty is fine), or [[velexis-deploy]] refuses:
   `env files lack variables of this release's templates: <file>:<NAME> …. Nothing was changed.`
2. Run Deploy from `main`, approve. The deploy job fails unless `--status` shows the new sha as current.
3. On the VM: read `/var/log/velexis/deploy.log`, the [[migration-report]] `/var/log/velexis/migrate-<sha>.json`,
   `platform.tenants.schema_version`, then `sudo velexis-healthcheck --payment-pages`.

```bug-hunt
A fan-out with failed tenant schemas still deploys when at most 10 % failed (`MIGRATE_TENANT_MAX_FAILURE_RATIO`
0.1): the run is green and `deploy.log` shows no error. Only `failed[]` of the migration report, one ops alert
e-mail per failed tenant (to `OPS_ALERT_EMAIL`) and an audit row `tenant.migration_failed` in
`platform.platform_audit_log` tell you that those tenants run the new code on the old schema.
```

```diagram
seq-velexis-deploy
```

### Roll back

```diagram
flow-rollback
```

An [[automatic-rollback]] already happens when a unit is not healthy within 90 s; `--rollback` is the manual one.
Migrations are never reversed ([[expand-and-contract]]).

### Run a one-off command (admin grant, demo OTA, backfills)

```diagram
flow-one-off-command
```

### Back up now and check the bucket

```diagram
seq-backup
```

1. `sudo systemctl start velexis-backup && journalctl -u velexis-backup -n 30`: the last line reads
   `[HH:MM:SS] backup <UTC stamp> done in <n>s: offsite:<bucket>/daily/<date> (<size>)`.
2. `sudo rclone --config /etc/velexis/backup/rclone.conf lsl offsite:<bucket>/daily/$(date -u +%F)/` lists
   `velexis-db.dump.age`, `globals.sql.age`, `storage.tar.zst.age`, `redis-aof.tar.zst.age`, `config.tar.zst.age`,
   `MANIFEST.txt`.
3. `date -u -d "@$(sudo cat /var/lib/velexis/backup-last-success)"` is today.
4. A delete of a canary object with the VM's key must fail with `AccessDenied` (deployment guide §10 step 5).

### Restore (drill or real)

```diagram
flow-restore-drill
```

- Default target is a scratch database (`velexis_restore`); `--replace-live` restores beside the live database,
  checks it, then swaps names in one transaction and keeps `velexis_before_restore_<stamp>` for rollback. It does not
  start the apps: run Deploy (pending migrations) or `systemctl start` the units.
- One tenant only: deployment guide §11 and `repo:docs/mvp/runbooks/restore-drill.md` §4.

### Triage an alert

```diagram
flow-alert-triage
```

### Allow a new outbound host, or open one in an emergency

```diagram
flow-egress-change
```

### Run the WAF detection week and switch to blocking

```diagram
flow-waf-detection-week
```

### Review the security logs

```diagram
flow-security-review
```

### Rotate the master key

```diagram
flow-master-key-rotation
```

Other rotations: the OTA API's JWT key (`repo:ota/docs/runbooks/jwt-key-rotation.md`), the platform's
(`repo:platform/docs/runbooks/platform-operations.md` §7), database and Redis passwords (change
`/etc/velexis/.provision-secrets` **first**, then the env files, then `provision-vm.sh --steps database` or
`--steps redis`; deployment guide §7). The [[api-key-pepper]] is never rotated.

### Move to a new Node.js major

`sudo NODE_MAJOR=<n> bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps node`, then
`check-vm.sh` with the same `NODE_MAJOR`, restart the seven app units, and deploy a release built on that major
([[node-major-pin]]; `repo:docs/mvp/runbooks/node-upgrade.md`).

### Get a change through CI to main and the VM

```diagram
flow-ci-pull-request
```

## Roles and permissions

| Who | Can | A forbidden action looks like |
|---|---|---|
| Admin user (developer) | SSH with key + FIDO2 (`ADMIN_MFA=fido2`) or TOTP; sudo everything | A plain key alone is refused once the second factor is applied; `provision-vm.sh --steps harden,ssh` refuses, changing nothing, when run by a user `AllowUsers` would lock out, or from an address outside `SSH_ALLOW_FROM` |
| [[deploy-user]] | `rsync` to `/srv/velexis/incoming/`; `sudo /usr/local/sbin/velexis-deploy` only (key with `restrict`, no TTY, no forwarding) | Any other sudo command is denied; sudo drops `VELEXIS_ROOT`, `SYSTEMCTL` and the other test overrides |
| GitHub [[production-environment]] | Holds the four `DEPLOY_*` secrets; needs your approval | A run from any other branch fails in the build job's first step: `Deploy runs only from main or a v* tag` |
| Zone users (`velexis-platform`, `velexis-ota`, `velexis-portal`, `velexis-platform-admin`, `velexis-ota-admin`) | Run their units; read releases through group `velexis`; backend zones read `/etc/velexis/keys/<zone>/` | `Permission denied` on any env file, on the other zone's keys and on `/proc/<pid>/environ` of other zones (proved by `units-smoke.sh`) |
| Transient migration unit (dynamic user) | Reads the release and `migrator.env` (via systemd) only | No app process ever has `DATABASE_MIGRATOR_URL` in its environment |
| [[database-roles]] | `velexis_migrator` DDL at deploy; `velexis_provisioner` tenant schemas; `velexis_platform_app` DML on `platform`/`reference`; `velexis_ota_app` DML on tenants, read-only platform views | `permission denied for schema …` when an app role touches another zone's schema |

## Bug-hunting checklist

```bug-hunt
**Deploy and rollback**
- Upload a release with an extra file or a flipped byte: `checksum verification failed …`, nothing changes (`deploy.test.sh` does this).
- Add a variable to a template without adding it on the VM: the refusal must name `file:NAME`, and `/srv/velexis/current` must not move.
- Kill a unit's health (stop PostgreSQL on a throwaway VM mid-deploy): automatic rollback, history ends with `<prev> rollback`, exit 1, the Deploy run fails.
- Deploy the same sha twice: no installed file changes (release, snapshot, units, Caddyfile, scripts), but migrations run again as no-ops, the fan-out report is published again and every unit is restarted one by one; the log shows `release <sha> is already on the VM: units and Caddyfile from its snapshot, root scripts stay as installed` and `deploy-history` gets a line.
- `--status` during a running deploy fails with `ERROR: another deploy is running`, exit 1, and writes that line into `deploy.log` (it takes the deploy lock before reading its arguments, `deploy.sh` lines 131-132 and 509-513). A read-only status should not need the lock.
- A release whose env template still holds `CHANGE_ME` or `smtp.example.com` in the VM's file deploys without a word: `velexis-deploy` and `check-vm.sh --only envfiles` check variable **names** only; only `provision-vm.sh --steps envfiles` warns about `CHANGE_ME`.
- `--rollback` (and the automatic rollback) re-checks neither the env variables of the target release's templates nor its Node major: a target whose variable you removed fails with `rollback release <sha> is not healthy either; investigate now`.
- Pruning keeps five releases by folder time; after re-deploying an old sha check that the current and `--rollback` target were not pruned (`ls /srv/velexis/releases`, `ls /var/lib/velexis/system`).
```

```bug-hunt
**Database after a deploy (read-only queries as postgres)**
- `SELECT id, status FROM platform.schema_migrations ORDER BY id;` and the same on `reference.` — no `failed` or `running` rows.
- `SELECT key, status, schema_version FROM platform.tenants WHERE status IN ('provisioning','active','suspended') ORDER BY schema_version;` — every tenant at the newest tenant migration.
- `SELECT tenant_id, version, status FROM platform.tenant_schema_migrations WHERE status <> 'applied';` — empty after a clean fan-out; compare with `SELECT id, status FROM tenant_<key>.schema_migrations ORDER BY id DESC LIMIT 5;`.
- `SELECT kind, status, count(*) FROM platform.provisioning_jobs GROUP BY 1,2;` — no job stuck in `running` after a deploy restarted the workers.
- Redis: the fan-out report's events land on the BullMQ queue `platform-tenant-events` (prefix `vx`) with `jobId = null`; a deploy whose report could not be published stops before the switch.
```

```bug-hunt
**Edge (Caddy and WAF)**
- `/health/ready` on `platform.`, `admin.platform.` and `admin.ota.` must answer 404 without reaching the app; `api.*/health/live` must answer 200.
- `curl -H 'X-Velexis-Edge: forged' https://acme.ota.example.com/api/v1/...`: the API must see only Caddy's value (smoke test checks it once each).
- A storefront `/api` body > 256 KB → 413; a JSON field > 128 KiB through `api.ota.example.com` → 413 (console automations by API key hit this; the OTA admin on loopback does not).
- A WAF refusal on `/api/*` must be the JSON envelope (`FORBIDDEN` or `INVALID_REQUEST` with `requestId`), on `/checkout/*` plain text, both `no-store` and with security headers.
- `curl -sI https://platform.example.com/verify-email` and `https://admin.platform.example.com/`: `Referrer-Policy` is Caddy's `strict-origin-when-cross-origin`, not the app's own `no-referrer` or `same-origin`, because the deferred `(security_headers)` snippet overrides it (known; only the portal's token-link refresh page and console hand-off page keep their policy, through a `<meta name="referrer">` tag).
- Access log lines (`journalctl -u caddy -o cat | jq .request.uri`) must never contain values of `sig`, `token`, `client_secret`, `payment_intent_client_secret`, `setup_intent_client_secret`, `code`, `state`, `q`, `email`, `customerEmail`, `travelerLastName`, `targetId`, `next` — also in `Referer` and redirect `Location`.
- A new storefront host gets a certificate only after `GET 127.0.0.1:3100/internal/tls/ask?domain=<host>` answers 200 (`tlsask:<host>` cached 60 s in Redis); a suspended tenant's sub-domain still gets one.
```

```bug-hunt
**Health check and alerts**
- Stop `velexis-platform-worker`: exactly one `health check failed: velexis-platform-worker readiness` e-mail within 10 min, none while it stays down, one `recovered` after start.
- Fill `/` beyond 80 % on a throwaway VM: `disk-root` alert once. Redis above 70 % of 512 MB: `redis-memory`.
- Delete `/var/lib/velexis/backup-last-success`: `backup-age` alert on the next run.
- Change one byte of `/srv/velexis/current/storefront/checkout/pay-card.html` on a throwaway VM and run `--payment-pages`: one alert naming the page and item.
- Break `alert.env` and make one check change state (stop a worker): the alert cannot be sent, the run logs `could not be sent; the next run sends it again`, exits 1, the state file keeps the old state and `velexis-alert@velexis-healthcheck.service` starts (it reads the same broken `alert.env`, so it fails too). With no state change nothing is sent and the run exits 0.
- TLS expiry is checked only for the five named hosts (`tls-platform.…`, `tls-admin.…`, `tls-api.…`); on-demand storefront and custom-domain certificates have no `tls-` check (`healthcheck.sh` line 386).
- Every alert subject starts with `[velexis][<ALERT_HOST_LABEL>]` and no body contains a secret or an env value.
```

```bug-hunt
**Backups, restores, logs, egress**
- `backup.sh` must refuse when data and config recipients share a key, or an `AGE-SECRET-KEY-` is anywhere in `/etc/velexis`.
- A second manual backup the same day goes to `daily/<UTC stamp>/` beside the nightly set, never replacing it.
- `velexis-restore db … --replace-live` with a wrong hostname, wrong identity or corrupt file must leave `velexis` live and connectable.
- Security log chunks and daily files: no `[uri "…?x=value"]` value, no secret; `cat` values only from `ssh sudo login auditd egress caddy waf fail2ban aide security velexis systemd`.
- `SENTRY_DSN` is offered by five env templates and deployment §13, but no code sends anything to Sentry (the two backends do not even read it; the three Next.js apps only validate it): setting it changes nothing.
- A call to a host missing from the allow-list fails at once with "Operation not permitted" and logs `VELEXIS-EGRESS-DENY` with the UID; 30+ in an hour → one burst alert.
- `check-vm.sh --only firewall` must FAIL while an emergency opening exists.
```

## Troubleshooting

| Symptom | First checks | Fix |
|---|---|---|
| Deploy job fails at "Activate" | `sudo tail -n 80 /var/log/velexis/deploy.log` | Missing env variables → add them; checksum → re-run Deploy; Node major → provision `--steps node`; unhealthy unit → read the journal lines the log copied |
| `migrations failed; the previous release keeps running` | `/var/log/velexis/migrate-<sha>.json` failed schemas (SQLSTATE) | `repo:ota/docs/runbooks/tenant-migration-failures.md`; fix and deploy again (nothing is applied twice) |
| `Caddyfile from … does not validate; nothing was activated` | the redacted `caddy validate` line in the log | Fix the Caddyfile/WAF rules in a PR; on a VM without the link run `provision-vm.sh --steps caddy` |
| `Caddy did not start with …` | `journalctl -u caddy -n 50` | `sudo velexis-deploy --rollback` (previous build/drop-in) |
| One app shows the maintenance page | `systemctl status velexis-<unit>`, `journalctl -u velexis-<unit> -n 100` | `systemctl restart`; after a deploy `--rollback` |
| APIs answer 503 | `curl -s 127.0.0.1:3100/health/ready`, `:4000`; `systemctl status postgresql redis-server` | restart the failed service; check disk |
| New storefront host has no certificate | `journalctl -u caddy --grep ask`; `curl '127.0.0.1:3100/internal/tls/ask?domain=<host>'` | platform API up? tenant active? domain verified? |
| "Operation not permitted" to Stripe/Amadeus/SMTP/bucket | `journalctl -k -g VELEXIS-EGRESS-DENY --since -1h` | allow-list PR + `--steps egress`; emergency opening for an outage |
| Backup alert | `journalctl -u velexis-backup -n 50` | fix credentials/space; `systemctl start velexis-backup` |
| No admin SSH login works | backup key or TOTP scratch code; provider console | `repo:docs/mvp/runbooks/ssh-access.md` §4–§5 |
| `dev-setup.sh` summary shows `FAILED` and ends `ERROR: a check failed (see FAILED above)` | the row names the role, or `password required FAILED` for Redis | another PostgreSQL on 5432, or a role password changed by hand: re-run the script (it resets the four role passwords); Redis with another password shows `other` and needs `REDIS_URL` in `.env.local` |
