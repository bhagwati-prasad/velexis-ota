---
id: architecture
title: Deploy and operations — architecture guide
summary: The single-VM topology (hosts, ports, units, users), the release and deploy pipeline, Caddy with the Coraza WAF and on-demand TLS, PostgreSQL and Redis settings, backups, monitoring, security logs and the outbound allow-list, with the files to change for each.
---

## At a glance

| | |
|---|---|
| Host | One Ubuntu 24.04 VM, 4 vCPU / 8 GB / 160 GB SSD ([[single-vm]], ADR-0007); no Docker |
| Public ports | 80, 443 (tcp + udp for HTTP/3) to [[caddy]]; 22 for SSH (rate-limited, optional `SSH_ALLOW_FROM`) |
| Loopback ports | portal 3000, platform admin 3001, OTA admin 3002, platform API 3100, platform worker health 3101, OTA API 4000, OTA worker health 4001, PostgreSQL 5432, Redis 6379; Caddy admin only on `/run/caddy/admin.sock` |
| Entry points | `repo:deploy/scripts/provision-vm.sh` (once per VM), `repo:deploy/scripts/deploy.sh` (every deploy), `repo:.github/workflows/deploy.yml` (the pipeline) |
| Release layout | `/srv/velexis/releases/<sha>/` (read-only, `root:velexis`), `/srv/velexis/current` symlink, snapshots in `/var/lib/velexis/system/<sha>/` |
| Config | `/etc/velexis/<app>.env` (`root:root 0600`), keys in `/etc/velexis/keys/{platform,ota}/` |
| Tests | `deploy/scripts/test/*.test.sh`, `deploy/systemd/test/units-smoke.sh`, `deploy/caddy/test/caddy-smoke.sh`; CI jobs Deploy files, systemd units smoke test, VM check test, Local development setup |

```diagram
topology
```

## Components

```diagram
components
```

| Folder / file | Job |
|---|---|
| `repo:deploy/scripts/provision-vm.sh` | Idempotent provisioning in steps (`packages node harden users postgres redis caddy keys database envfiles scripts caddyconf summary`; `ssh` and `egress` by name). Generates secrets once into `/etc/velexis/.provision-secrets`, never overwrites a key or env file, records steps in `/var/lib/velexis/provision/steps/`, re-baselines AIDE once. Lockout guard for SSH changes |
| `repo:deploy/scripts/check-vm.sh` | Read-only verifier, one `PASS`/`FAIL` per item, groups `system services audit firewall ssh database redis caddy users files envfiles`; prints no value |
| `repo:deploy/scripts/deploy.sh` | [[velexis-deploy]]: verify, snapshot, stage, migrate, report, switch, restart, [[automatic-rollback]], activate Caddy, prune |
| `repo:deploy/scripts/pack-release.sh` | Builds the [[release-folder]] in CI with `RELEASE.json`, [[sha256sums]] and `caddy/bin/caddy` |
| `repo:deploy/scripts/run-as.sh` | [[velexis-run]]: one-off command as a zone user, copying the installed unit's identity, env files and sandbox |
| `repo:deploy/scripts/healthcheck.sh` | [[on-vm-health-check]] (readiness, jobs, disk, Redis memory, backup age, TLS expiry, [[payment-page-inventory]]) |
| `repo:deploy/scripts/alert.sh` | [[velexis-alert]]: `unit-failed <unit>` and `message <subject> <file>` over SMTP with curl (TLS required unless loopback) |
| `repo:deploy/scripts/backup.sh`, `repo:deploy/scripts/restore.sh` | [[backup-set]] with [[age-encryption]] to the [[off-site-bucket]]; restores, [[restore-drill]] |
| `repo:deploy/scripts/ship-logs.sh`, `repo:deploy/scripts/log-review.sh` | [[security-log-shipment]] and [[security-log-review]] |
| `repo:deploy/scripts/egress.sh`, `repo:deploy/egress/allowed-hosts.conf` | [[outbound-allow-list]] (nftables table `inet velexis_egress`) |
| `repo:deploy/scripts/dev-setup.sh` | [[dev-setup]] for development machines only |
| `repo:deploy/caddy/Caddyfile` | Hosts, snippets `(storefront)`, `(api_common)`, `(waf)`, `(waf_refusal_json)`, `(maintenance_page)`, `(api_unavailable)`, `(log_query_filter)`, `(log_request_fields)`, `(security_headers)`, `(request_id)` |
| `repo:deploy/caddy/waf/coraza.conf`, `repo:deploy/caddy/waf/exclusions.conf`, `repo:deploy/caddy/waf/logdata.conf` | [[coraza-waf]] engine settings, [[waf-exclusion|exclusions]], generated log data that never quotes a value |
| `repo:deploy/caddy/build/build-caddy.sh`, `repo:deploy/caddy/build/versions.env` | Reproducible [[velexis-caddy-build]] pinned by `CADDY_SHA256` |
| `repo:deploy/systemd` | Seven app units, timers, `velexis-alert@.service`, the [[caddy-drop-in]] |
| `repo:deploy/postgres/bootstrap.sql`, `repo:deploy/postgres/velexis.conf`, `repo:deploy/redis/velexis.conf` | Database, roles, privileges; tuning; Redis password, `noeviction`, AOF |
| `repo:deploy/env` | One template per [[env-file]] |
| `repo:deploy/journald/velexis.conf`, `repo:deploy/logrotate/velexis` | 4 GB / 30 days journal; weekly rotation of `/var/log/velexis/*.log` |
| `repo:deploy/demo-deployment.html` | Copy-paste demo guide for Codespaces / an Ubuntu computer (not production) |

### Units, users and ports

| Unit | User | Runs | Port | MemoryMax | Heap flags | Restart order |
|---|---|---|---|---|---|---|
| `velexis-platform-worker` | `velexis-platform` | `platform-backend/dist/worker.js` | 3101 (health) | 512M | old 400, semi 1 | 1 |
| `velexis-ota-worker` | `velexis-ota` | `ota-backend/dist/worker.js` (+ `ota-worker.env`) | 4001 (health) | 512M | old 400, semi 1 | 2 |
| `velexis-platform-api` | `velexis-platform` | `platform-backend/dist/main.js` | 3100 | 768M | old 640, semi 16 | 3 |
| `velexis-ota-api` | `velexis-ota` | `ota-backend/dist/main.js` | 4000 | 768M | old 640, semi 32 | 4 |
| `velexis-portal` | `velexis-portal` | `platform/frontend/server.js` | 3000 | 512M | old 384, semi 1 | 5 |
| `velexis-platform-admin` | `velexis-platform-admin` | `platform/admin/server.js` | 3001 | 512M | old 384, semi 1 | 6 |
| `velexis-ota-admin` | `velexis-ota-admin` | `ota/admin/server.js` | 3002 | 512M | old 384, semi 1 | 7 |
| `caddy` (package unit + drop-in) | `caddy` | `/usr/bin/caddy` → `/usr/local/bin/caddy-velexis` | 80, 443 | — | — | reload/restart only when changed |

Workers restart first so new consumers run before new producers (ADR-0009). The storefront has no unit: Caddy serves
`/srv/velexis/current/storefront`.

## Data

The deploy owns no business tables, but it is the only writer of the migration ledgers and it feeds the platform's
mirror of tenant migrations.

```diagram
er-deploy-data
```

| Store | What deploy/ops touches | Who |
|---|---|---|
| `platform.schema_migrations`, `reference.schema_migrations` | [[migration-ledger]] rows per applied file (`id`, `checksum`, `phase`, `status`) | `migrate.js platform|reference` as `velexis_migrator` in a [[transient-unit]] |
| `tenant_<key>.schema_migrations` | the same per [[tenant-schema]] | [[tenant-fan-out]] (`SET LOCAL ROLE velexis_provisioner`) |
| `platform.tenant_schema_migrations`, `platform.tenants.schema_version` | mirror kept by the platform worker from the [[migration-report]] events | `velexis-run ota … tenants:report-migrations` → queue [[platform-tenant-events]] |
| `reference.*` | reference data reload when the datasets' checksum changes (`/var/lib/velexis/reference-data.sha256`) | `reference-data/dist/cli/load.js` as `velexis_platform_app` in a transient unit |
| Redis `tlsask:<host>` (60 s) | cache of **positive** [[tls-ask-endpoint]] answers only (value `1`); refusals sit in the API process's own LRU (10 000 hosts, 60 s) | platform API, asked by Caddy |
| `/var/lib/velexis/` | `deploy-history`, `caddy-dropin.sha256`, `migrate-<sha>.json`, `backup-last-success`, `healthcheck/`, `egress/`, `ship-logs/`, `log-review/`, `provision/`, `storage/` (OTA documents) | root scripts; `storage/` by `velexis-ota` |

**[[database-roles]]** (`repo:deploy/postgres/bootstrap.sql`): `velexis_migrator` owns the database, `platform` and
`reference`, is a member of `velexis_provisioner`, `lock_timeout 5s`; `velexis_provisioner` has `CREATE` on the
database and owns every `tenant_<key>`; `velexis_platform_app` gets DML on `platform` and `reference` through default
privileges; `velexis_ota_app` gets `SELECT` on `reference`, usage on `platform` (the grants of
`R__ota_read_access.sql`) and `search_path = pg_catalog`. Both app roles have
`idle_in_transaction_session_timeout = 60s`. PostgreSQL: `max_connections 100`, `shared_buffers 1.5GB`,
`max_locks_per_transaction 256`, slow statements ≥ 500 ms, never bound parameters.

**Redis**: loopback, `requirepass`, `maxmemory 512mb`, [[noeviction-policy]], AOF `everysec`, no RDB, `FLUSHALL` and
`DEBUG` disabled; every cache key needs a TTL; BullMQ prefix `vx`.

## Key flows

### Deploy workflow and activation

```diagram
seq-deploy-workflow
```

```diagram
seq-velexis-deploy
```

Points that matter for bugs:

- One-off DSNs never reach an app user: migrations and the reference loader run through `run_transient`
  (`systemd-run --pipe --wait --collect -p DynamicUser=yes -p SupplementaryGroups=velexis -p EnvironmentFile=…`).
- Any failure before the switch re-stages the running release's own units (`restore_running_system_files`).
- The tenant fan-out fails the deploy only when **more than** 10 % of the schemas failed (`migrate.js` exit 3). With
  fewer failures it exits 0, the deploy switches, and the failed schemas stay on the old version until the next
  deploy: read `failed[]` of `/var/log/velexis/migrate-<sha>.json` after every deploy.
- A set whose folder is missing in the release (`migrations/<set>`) is skipped without a message, and `migrate.js`
  treats a `--dir` that does not exist as an empty set (notice on stderr, exit 0).
- Caddy is reloaded for a changed Caddyfile or WAF files, restarted (never both) for a changed build or
  [[caddy-drop-in]], and the restart is recorded in `/var/lib/velexis/caddy-dropin.sha256`.

### A storefront request at the edge

```diagram
seq-storefront-request
```

| Host / path | WAF mode | Body limit | Error page |
|---|---|---|---|
| storefront `/api/*`, `/checkout/*` | blocking `{$VELEXIS_WAF_ENGINE:On}` | 256 KB (`/api`), WAF 256 KiB | JSON envelope on `/api`, text on `/checkout` |
| other storefront paths | DetectionOnly | WAF 256 KiB | storefront `404.html` |
| `api.ota.example.com` | blocking | 1 MB (1100 KiB for `POST /v1/console/settings/assets`), WAF 1200 KiB | JSON `FORBIDDEN` / `INVALID_REQUEST` / `SERVICE_UNAVAILABLE` |
| `api.platform.example.com` | DetectionOnly | 1 MB | JSON `SERVICE_UNAVAILABLE` |
| portal, platform admin | DetectionOnly | 5 MB | maintenance page |
| OTA admin | DetectionOnly | 10 MB | maintenance page |
| `/webhooks/stripe/…` on `api.ota.example.com` | detection only (rule 10001) | 1 MB | — |

Core Rule Set v4 at paranoia level 1, anomaly threshold 5, request rules + RESPONSE-980 only, responses not inspected;
1000+ arguments → 400, arguments above 128 KiB → 413.

### Backup, health check and security logs

```diagram
seq-backup
```

```diagram
seq-healthcheck
```

```diagram
seq-security-logs
```

## Lifecycles

```diagram
release-states
```

```diagram
unit-states
```

```diagram
healthcheck-states
```

```diagram
fanout-states
```

```diagram
backup-set-states
```

```diagram
caddy-dropin-states
```

```diagram
waf-mode-states
```

```diagram
egress-states
```

```diagram
aide-baseline-states
```

## Integrations

| With | How | Contract / file |
|---|---|---|
| [[app:platform-api]] | Proxy for `api.platform.example.com`; [[on-demand-tls]] asks `GET /internal/tls/ask?domain=` (200 with no body for a provisioning/active/suspended tenant sub-domain, or a verified custom storefront domain of an active tenant whose plan has `customDomains > 0` while the `custom_domains` switch is on; anything else, malformed input included, `404`) | `repo:platform/backend/src/domains/tls-ask.service.ts` |
| [[app:ota-api]] | Proxy for `api.ota.example.com` and storefront `/api/*` with the [[edge-secret]] (`X-Velexis-Edge`) and `X-Velexis-Host`; deploy publishes the fan-out report with `dist/cli.js tenants:report-migrations` | `repo:ota/backend/src/cli.ts` |
| [[app:storefront]] | Static files; daily [[payment-page-inventory]] check of `checkout/pay-card.html` and `checkout/pay-airline.html` | `storefront/payment-page-inventory.json` of the release |
| [[app:packages]] | `@velexis/db` migration CLI and `@velexis/reference-data` loader inside the release | `repo:packages/db/src/migrate/ledger.ts` |
| Let's Encrypt / ZeroSSL | ACME for named hosts and on-demand storefronts (~50 new certs/week/domain limit) | Caddyfile global options |
| SMTP relay | `velexis-alert` (`alert.env`), app mails (`SMTP_URL`) on port 465 | `repo:deploy/env/alert.env.example` |
| Off-site bucket (S3-compatible, other provider) | `rclone copy --immutable`, object lock, lifecycle `daily/` 14 d, `monthly/` 186 d, `logs/` 400 d | `repo:deploy/env/backup.env.example` |
| GitHub Actions | Deploy key over SSH (`DEPLOY_*` secrets), actions pinned to full SHAs ([[action-pinning]]) | `repo:.github/workflows/deploy.yml` |
| External uptime monitor | `https://api.platform.example.com/health/live`, `https://api.ota.example.com/health/live`, portal `/`, `https://demo.ota.example.com/` every minute | deployment guide §13 |

## Security

- **[[trust-zone]] users** (ADR-0026): five no-shell users, group `velexis` only for reading releases,
  `ProtectProc=invisible`, `InaccessiblePaths=` for other zones' env files and keys (defence in depth).
- **[[unit-sandboxing]]**: `ProtectSystem=strict`, `PrivateTmp`, `PrivateDevices`, no capabilities,
  `SystemCallFilter=@system-service ~@privileged`, `MemoryMax`, `LimitCORE=0`; `systemd-analyze security` ≤ 2.0
  enforced in CI (app units 1.4, `velexis-alert@` 1.7).
- **Secrets**: [[env-file]]s read by systemd only; [[kek|master key]] and [[api-key-pepper]] as identical 0400 copies
  in both backend key folders; the [[edge-secret]] in `caddy.env` and `ota-backend.env`; Caddy runs without
  `--environ` so it never prints its environment. Backups encrypt `/etc/velexis` to a separate config age key.
- **SSH**: keys only, `AllowUsers <admin> deploy`, `MaxAuthTries 3`, fail2ban, [[ssh-second-factor]] for the admin;
  the [[deploy-user]] has `restrict`, no TTY, sudo for `velexis-deploy` only.
- **Network**: ufw inbound 22/80/443; [[outbound-allow-list]] with `policy drop` and logged refusals
  (`VELEXIS-EGRESS-DENY`); [[caddy-admin-socket]] instead of TCP 2019.
- **Edge**: [[coraza-waf]] with [[owasp-core-rule-set]], HSTS, strict storefront CSP, `/internal/*` and private
  `/health/*` → 404, client copies of edge headers removed, [[log-query-filter]] on access, error and WAF logs.
  The `(security_headers)` snippet sets `Referrer-Policy: strict-origin-when-cross-origin`; because the block deletes
  `Server` it is deferred, so it replaces the value the portal (`no-referrer` on token pages) and the platform admin
  (`same-origin`) send (`repo:deploy/caddy/Caddyfile#L139`).
- **Integrity and audit**: [[aide]] daily, [[auditd]] watches (`velexis-keys`, `velexis-aide`, `caddy-config`,
  `caddy-binary` …), [[security-log-shipment]] off the VM with 12-month object lock, [[security-log-review]] hourly.
- **Host**: swap off and core dumps off (card data in memory must never reach disk), UTC with chrony,
  `unattended-upgrades` without reboots.
- **PCI**: the whole VM is the [[cardholder-data-environment]]; the [[pci-evidence-pack]]
  (`repo:ota/docs/pci/README.md`) maps controls to this folder. Live [[airline-card]] payments stay off
  (`AIRLINE_CARD_ENABLED=false`) until `repo:ota/docs/runbooks/airline-card-go-live.md` is signed off.

## Configuration

| File | Key variables (names only) |
|---|---|
| `platform-backend.env` | `APP_ENV`, `TRUST_PROXY`, `DATABASE_URL`, `REDIS_URL`, `PLATFORM_BFF_KEY`, `MASTER_KEY_DIR`, `MASTER_KEY_CURRENT`, `API_KEY_PEPPER_FILE`, `JWT_PRIVATE_KEY_FILE`, `SMTP_URL`, `MAIL_FROM`, `OPS_ALERT_EMAIL`, `PUBLIC_*_URL`, `STOREFRONT_BASE_DOMAIN`, `STOREFRONT_IPV4/IPV6`, `DNS_RESOLVERS`, `STRIPE_*`, `AMADEUS_BASE_URL_TEST/LIVE`, `MAX_TENANTS_PER_ACCOUNT`, `FEATURE_*`; the template also lists `STORAGE_DRIVER`, `STORAGE_DIR` and `SENTRY_DSN`, which the platform backend never reads (they must exist, or `velexis-deploy` refuses) |
| `ota-backend.env` (+ `ota-worker.env`: `DATABASE_PROVISIONER_URL`) | `DATABASE_URL`, `REDIS_URL`, key files, `DOCUMENT_URL_KEY_FILE`, `SMTP_URL`, `PUBLIC_OTA_API_URL`, `OTA_ADMIN_SERVICE_KEY`, `VELEXIS_EDGE_SECRET`, `STRIPE_*_TEST/LIVE`, webhook secrets, `AMADEUS_BASE_URL_*`, `AIRLINE_CARD_ENABLED`, `STORAGE_DRIVER` (`local`; `s3` passes validation but the API and worker then fail at start with `createStorage: the s3 storage driver is not implemented yet`), `STORAGE_DIR`; `SENTRY_DSN` is in the template but not read |
| `platform-frontend.env`, `platform-admin.env`, `ota-admin.env` | `APP_ENV`, `PUBLIC_*_URL`, `PLATFORM_API_URL` + `PLATFORM_BFF_KEY` or `OTA_API_URL` + `OTA_ADMIN_SERVICE_KEY` |
| `caddy.env` | `PLATFORM_BASE_DOMAIN`, `STOREFRONT_BASE_DOMAIN`, `ACME_EMAIL`, `VELEXIS_EDGE_SECRET`, optional `VELEXIS_WAF_ENGINE=DetectionOnly` |
| `migrator.env`, `reference-loader.env` | `DATABASE_MIGRATOR_URL`, `MIGRATE_TENANT_CONCURRENCY` (4), `MIGRATE_TENANT_MAX_FAILURE_RATIO` (0.1); `DATABASE_URL` |
| `backup.env` | `BACKUP_DIR`, `AGE_RECIPIENTS_FILE`, `AGE_CONFIG_RECIPIENTS_FILE`, `RCLONE_CONFIG`, `RCLONE_REMOTE`, `RETENTION_LOCAL_DAYS`, `PG_DATABASE`, `REDIS_AOF_DIR`, `REDIS_PASSWORD`, `STORAGE_DIR`, `BACKUP_MARKER_FILE`, optional `SECURITY_LOG_LOCK_DAYS` |
| `alert.env` | `ALERT_SMTP_URL`, `ALERT_SMTP_USER`, `ALERT_SMTP_PASSWORD`, `ALERT_SMTP_TLS`, `ALERT_FROM`, `ALERT_TO`, `ALERT_HOST_LABEL` |
| `healthcheck.env` (optional) | `HEALTHCHECK_STOREFRONT_HOST` (default `demo.<STOREFRONT_BASE_DOMAIN>`), `HEALTHCHECK_PAGES` (`payment` or `all`) |
| provision-vm.sh environment | `ADMIN_USER`, `ADMIN_MFA` (`fido2`/`totp`), `DEPLOY_SSH_PUBKEY_FILE`, `CADDY_BINARY`, `SSH_ALLOW_FROM`, `NODE_MAJOR` (24), `NEW_MASTER_KEY` |

`@@NAME@@` values are generated by `provision-vm.sh`; `CHANGE_ME` values are yours. `velexis-deploy` refuses a release
whose templates name a variable the VM's file lacks, but it checks names only: a value still `CHANGE_ME` (or
`smtp.example.com`) passes the deploy and `check-vm.sh --only envfiles`; only `provision-vm.sh --steps envfiles` warns.
`SENTRY_DSN` has no client in the code: setting it sends nothing anywhere.

## Testing

| Test | Where | CI job |
|---|---|---|
| `deploy.test.sh` (fake systemctl, fake apps, fake Caddy builds and drop-ins) | `repo:deploy/scripts/test/deploy.test.sh` | Deploy files |
| `healthcheck.test.sh` | `repo:deploy/scripts/test/healthcheck.test.sh` | Deploy files |
| `ship-logs.test.sh`, `log-review.test.sh` | `repo:deploy/scripts/test/ship-logs.test.sh`, `repo:deploy/scripts/test/log-review.test.sh` | Deploy files |
| Caddy build + `caddy-smoke.sh` | `repo:deploy/caddy/test/caddy-smoke.sh` | Deploy files |
| `units-smoke.sh` (real units under systemd, user boundary, alert to Mailpit, egress table in a netns) | `repo:deploy/systemd/test/units-smoke.sh` | systemd units smoke test |
| `check-vm.test.sh` (real sshd, real nft) | `repo:deploy/scripts/test/check-vm.test.sh` | VM check test |
| `backup-restore.test.sh` | `repo:deploy/scripts/test/backup-restore.test.sh` | not in CI: run when either script changes |
| dev-setup twice on a clean runner | `repo:deploy/scripts/dev-setup.sh` | Local development setup |
| Release dry run | `repo:deploy/scripts/pack-release.sh` | Build and test |
| Unit heap flags | `repo:tools/perf/unit-node-options.test.mjs` | Build and test |

## Where to change things

| To change … | Look at |
|---|---|
| A public host, header, CSP, body limit, proxy target | `repo:deploy/caddy/Caddyfile` (then `caddy-smoke.sh`) |
| A WAF false positive | `repo:deploy/caddy/waf/exclusions.conf` (+ the request in `repo:deploy/caddy/test/caddy-smoke.sh`) |
| WAF engine settings, argument and body limits | `repo:deploy/caddy/waf/coraza.conf` |
| Caddy, Coraza or CRS versions | `repo:deploy/caddy/build/versions.env` (new `CADDY_SHA256`), `repo:deploy/caddy/build/build-caddy.sh` |
| Which URL query values are scrubbed from logs | `(log_query_filter)` in `repo:deploy/caddy/Caddyfile` |
| Deploy order, health timeout, rollback, pruning, Caddy activation | `repo:deploy/scripts/deploy.sh` (+ `repo:deploy/scripts/test/deploy.test.sh`) |
| What goes into a release | `repo:deploy/scripts/pack-release.sh` |
| The pipeline (refs, approval, e2e gate, smoke check) | `repo:.github/workflows/deploy.yml` (owner only; agents never edit workflows to pass) |
| CI jobs | `repo:.github/workflows/ci.yml`, `repo:tools/ci/README.md` |
| E2E schedule and projects | `repo:.github/workflows/e2e.yml`, `repo:tools/e2e/README.md` |
| A unit's memory, heap, sandbox, env files, port | `repo:deploy/systemd` (`velexis-<app>.service`) |
| Timer schedules | `repo:deploy/systemd/velexis-backup.timer`, `repo:deploy/systemd/velexis-healthcheck.timer`, `repo:deploy/systemd/velexis-ship-logs.timer`, `repo:deploy/systemd/velexis-log-review.timer`, `repo:deploy/systemd/velexis-egress-refresh.timer` |
| Health check thresholds and checks | `repo:deploy/scripts/healthcheck.sh` (`DISK_MAX_PERCENT`, `BACKUP_MAX_AGE`, `FAILED_JOBS_MAX`, `QUEUE_AGE_MAX`, `TLS_MIN_SECONDS`) |
| Alert e-mail format / SMTP handling | `repo:deploy/scripts/alert.sh`, `repo:deploy/env/alert.env.example` |
| Backup contents, MANIFEST | `repo:deploy/scripts/backup.sh`; restore commands `repo:deploy/scripts/restore.sh` |
| What security logs are shipped, alerts, summary | `repo:deploy/scripts/ship-logs.sh`, `repo:deploy/scripts/log-review.sh` |
| An outbound host | `repo:deploy/egress/allowed-hosts.conf` (then `provision-vm.sh --steps egress`) |
| Roles, schemas, default privileges | `repo:deploy/postgres/bootstrap.sql`, `repo:deploy/postgres/schemas.sql` |
| PostgreSQL / Redis tuning | `repo:deploy/postgres/velexis.conf`, `repo:deploy/redis/velexis.conf` |
| A new env variable | `repo:deploy/env` template + a human step to add it on the VM before the deploy |
| Hardening, users, SSH, AIDE, auditd, packages | `repo:deploy/scripts/provision-vm.sh` and the matching check in `repo:deploy/scripts/check-vm.sh` |
| One-off command zones | `repo:deploy/scripts/run-as.sh` |
| Local database bootstrap | `repo:deploy/scripts/dev-setup.sh`, `repo:.env.example` |
| Maintenance page | `repo:deploy/caddy/maintenance/index.html` |

## Further reading

- `repo:deploy/README.md` — file map, units, release flow, first deploy, local checks.
- `repo:docs/mvp/deployment-single-vm.md` — the operations guide (§1 sizing … §16 incident quick reference).
- Runbooks: `repo:docs/mvp/runbooks/outbound-allow-list.md`, `repo:docs/mvp/runbooks/restore-drill.md`,
  `repo:docs/mvp/runbooks/ssh-access.md`, `repo:docs/mvp/runbooks/master-key-rotation.md`,
  `repo:docs/mvp/runbooks/node-upgrade.md`, `repo:docs/mvp/runbooks/second-agent-review.md`,
  `repo:ota/docs/runbooks/README.md`, `repo:ota/docs/runbooks/tenant-migration-failures.md`,
  `repo:ota/docs/runbooks/stripe-incidents.md`, `repo:ota/docs/runbooks/supplier-timeout-and-reconciliation.md`,
  `repo:ota/docs/runbooks/ticketing-failures.md`, `repo:ota/docs/runbooks/jwt-key-rotation.md`,
  `repo:ota/docs/runbooks/launch-checklist.md`, `repo:platform/docs/runbooks/platform-operations.md`,
  `repo:platform/docs/runbooks/launch-checklist.md`.
- PCI: `repo:ota/docs/pci/README.md` (scope = the whole VM; calendar of ASV scans, internal scans, penetration tests,
  daily payment-page and AIDE checks, log review, quarterly reviews, restore drill), `repo:ota/docs/pci/data-flow.md`,
  `repo:ota/docs/pci/script-inventory.md`, `repo:ota/docs/pci/incident-response.md`,
  `repo:ota/docs/pci/responsibility-matrix.md`.
- ADRs: `repo:docs/mvp/adr/0007-single-vm-without-docker.md`, `repo:docs/mvp/adr/0009-background-jobs-bullmq.md`,
  `repo:docs/mvp/adr/0010-secrets-envelope-encryption.md`, `repo:docs/mvp/adr/0016-observability.md`,
  `repo:docs/mvp/adr/0018-hosted-storefront-custom-domains.md`,
  `repo:docs/mvp/adr/0023-release-artefact-and-deploy-user.md`,
  `repo:docs/mvp/adr/0026-system-users-per-trust-zone.md`, `repo:docs/mvp/adr/0027-pci-scope-and-vm-controls.md`,
  `repo:docs/mvp/adr/0028-how-work-reaches-main.md`, `repo:docs/mvp/adr/0029-nodejs-24-runtime.md`.
- Tests: `repo:deploy/caddy/test/README.md`, `repo:tools/ci/README.md`.
