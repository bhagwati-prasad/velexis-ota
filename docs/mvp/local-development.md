# Local development

This runbook gets a developer machine (or an agent's sandbox) from a fresh clone to the whole Velexis stack running locally: the prerequisites, the one-time setup of PostgreSQL, Redis, keys and environment files, the daily commands, the local stand-ins for external services (Mailpit for e-mail, the Stripe CLI for webhooks, the Amadeus stub), how to run each test level, and fixes for common problems. Like the VM, local development uses **native services, no Docker** ([ADR-0007](adr/0007-single-vm-without-docker.md)). Task X-016 in [`plans/foundation-tasks.md`](plans/foundation-tasks.md) creates the helper scripts named here and keeps this page true.

Related: [`AGENTS.md`](../../AGENTS.md) §10 (command cheat sheet), [`architecture.md`](architecture.md) §3 and §6 (ports, configuration matrix), [`deployment-single-vm.md`](deployment-single-vm.md) (production), [`../../packages/README.md`](../../packages/README.md) (shared packages), [ADR-0015](adr/0015-testing-strategy.md) (testing).

## 1. Prerequisites

| Tool | Version | Install (Ubuntu 24.04; macOS with Homebrew in brackets) |
|---|---|---|
| Node.js | 22 LTS (`.nvmrc`) | `nvm install` in the repository root (`brew install nvm`) |
| pnpm | 9 (exact version in `package.json` → `packageManager`) | `corepack enable` (ships with Node 22) |
| PostgreSQL | 16 | PGDG apt repository: `sudo apt install postgresql-16` (`brew install postgresql@16`; keg-only, `dev-setup.sh` finds its `psql` itself) |
| Redis | 7.4 | packages.redis.io apt repository, pinned to 7.4: `sudo apt install redis-server redis-tools` (`brew install redis`) |
| Mailpit | 1.2x | `sudo bash < <(curl -sL https://raw.githubusercontent.com/axllent/mailpit/develop/install.sh)` (`brew install mailpit`) |
| Stripe CLI | 1.x | Stripe's apt repository or the release binary (`brew install stripe/stripe-cli/stripe`); only from M3 |
| age, jq | any | `sudo apt install age jq` (`brew install age jq`); age only for backup work |
| Caddy | 2.8 (optional) | Only to try the Caddyfile locally |

The exact commands for the vendor repositories are the same as in [`provision-vm.sh`](../../deploy/scripts/provision-vm.sh) (`step_packages`); the `dev-setup` job of [`ci.yml`](../../.github/workflows/ci.yml) runs them on a clean `ubuntu-24.04` runner.

## 2. One-time setup

```bash
git clone <repository-url> velexis && cd velexis
nvm install && corepack enable
pnpm install                                   # all workspaces, exact versions from pnpm-lock.yaml

cp .env.example .env.local                     # shared local values; never commit .env.local
bash deploy/scripts/dev-setup.sh               # roles, database "velexis", test admin role, Redis password (sudo on Linux)
pnpm dev:keys                                  # .local/keys/: master key, pepper, JWT keys, document URL key; .local/storage/
pnpm build                                     # shared packages first (apps import their dist/)
pnpm db:migrate                                # platform + reference migrations
pnpm db:seed:reference                         # airports, airlines, countries, currencies, time zones, aircraft
```

Run both scripts as your normal user. They are idempotent: a second run changes nothing, so re-run them whenever something looks wrong. The `dev-setup` job of [`ci.yml`](../../.github/workflows/ci.yml) runs this section up to `pnpm dev:keys` on a clean `ubuntu-24.04` runner, twice, on every pull request.

What [`dev-setup.sh`](../../deploy/scripts/dev-setup.sh) does, so you can do it by hand if needed. It first refuses to run when `/etc/velexis` exists: that folder marks a production host, which [`provision-vm.sh`](../../deploy/scripts/provision-vm.sh) sets up with generated secrets. Then, in order:

1. Starts PostgreSQL and Redis if they are installed but stopped (`systemctl start postgresql` and `redis-server` with sudo on Ubuntu, `service …` without systemd, `brew services start postgresql@16` and `redis` on macOS).
2. Runs [`deploy/postgres/bootstrap.sql`](../../deploy/postgres/bootstrap.sql) as the PostgreSQL superuser (`sudo -u postgres psql` on Linux, your own user with Homebrew) with the **development** passwords of `.env.example` (`dev_migrator`, `dev_provisioner`, `dev_platform`, `dev_ota`), passed as `\set` lines on stdin: creates the database `velexis`, the roles `velexis_migrator`, `velexis_provisioner`, `velexis_platform_app`, `velexis_ota_app`, the `platform` and `reference` schemas and the default privileges. The passwords are reset on every run.
3. Creates `velexis_test_admin` (`LOGIN CREATEDB`, password `dev_test_admin`, member of `velexis_migrator`) for the integration-test harness, which clones a migrated template database per test file ([ADR-0022](adr/0022-shared-test-support-package.md)).
4. If Redis answers without a password, sets it to `dev_redis` (`CONFIG SET requirepass`, then `CONFIG REWRITE` so it survives a restart), matching `REDIS_URL`. A Redis that already has a password is left alone; if the rewrite is refused, it warns and you add `requirepass dev_redis` to `redis.conf` yourself.
5. Logs in over TCP as every role of `.env.example`, checks that Redis needs the `REDIS_URL` password, and prints a summary. It exits with an error if a check fails.

What [`pnpm dev:keys`](../../tools/dev/README.md) does: it creates `.local/keys/` (mode `0700`) with the five key files of [ADR-0010](adr/0010-secrets-envelope-encryption.md) (`master-v1.key`, `api-key-pepper`, `document-url.key`, `platform-jwt-ed25519.pem`, `ota-jwt-ed25519.pem`, each `0600`) and `.local/storage/`. It never overwrites an existing file unless you pass `--force`. The key and storage paths of `.env.example` are relative to the repository root, where `.local/` is.

Per-app overrides go into `<app>/.env.local` (for example the OTA backend's `DATABASE_URL` with the `velexis_ota_app` role and its own `JWT_PRIVATE_KEY_FILE`). The precedence is: real environment, then `<app>/.env.local`, then the root `.env.local` (`@velexis/config`, task X-002).

**Development data** (once, after the setup above; both commands refuse `APP_ENV=production`, write nothing then, and change nothing on a second run):

```bash
pnpm stub:amadeus &                                      # the platform seed verifies its test Amadeus account against it
pnpm --filter @velexis/platform-backend dev:seed         # platform admin admin@example.com (MFA), test Amadeus account, 10 test offices
pnpm --filter @velexis/ota-backend dev:seed              # the demo OTA tenant_demo on demo.ota.example.com, with two test API keys
```

The OTA backend's `dev:seed` ([`ota/backend/README.md`](../../ota/backend/README.md) §5, task OBE-007) needs the platform's first. As a development-only exception to "the OTA backend never writes platform tables", it writes as `velexis_migrator` (`DATABASE_MIGRATOR_URL` of the root `.env.local`): the tenant `demo` ("Demo Travel"), its storefront sub-domain `demo.<STOREFRONT_BASE_DOMAIN>`, an Amadeus test connection through the Velexis test account with one of its test offices, a `velexis` Stripe test payment connection and a `pk_test_…` and an `sk_test_…` key hashed with `.local/keys/api-key-pepper`. It then provisions `tenant_demo` through the OTA worker's own provisioning function (`DATABASE_PROVISIONER_URL`), sets the tenant `active` and prints the two keys **once**: copy them then (SDK callers send `X-Api-Key`; a lost key is revoked or rolled in the portal). The storefront dev server serves the demo OTA without a key.

## 3. Daily work

```bash
mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 &   # or run it as a user service
pnpm stub:amadeus &                                       # Amadeus stub on 127.0.0.1:4900 (from M1)
pnpm dev                                                  # every app in watch mode (Turborepo)
pnpm --filter @velexis/ota-backend dev                    # or one app only
```

| What | Local URL | Notes |
|---|---|---|
| Portal | <http://localhost:3000> | `platform/frontend` |
| Platform admin | <http://localhost:3001> | `platform/admin`; MFA required even locally |
| OTA admin | <http://localhost:3002> | `ota/admin`; reach it through the portal's "Open console" (SSO) |
| Platform API | <http://localhost:3100> | worker health on 3101 |
| OTA API | <http://localhost:4000> | worker health on 4001; SDK users send `X-Api-Key` with a `pk_test_`/`sk_test_` key |
| Storefront | <http://localhost:5173> | Vite dev server; proxies `/api` to 4000 and adds `X-Velexis-Edge` (`VELEXIS_EDGE_SECRET`) and `X-Velexis-Host` like Caddy, so the OTA backend resolves the demo tenant |
| Mailpit | <http://localhost:8025> | Every e-mail sent locally lands here |
| Amadeus stub | <http://localhost:4900> | Scenarios: [§5](#5-amadeus-stub) |

Useful database commands:

```bash
psql postgres://velexis_migrator:dev_migrator@127.0.0.1:5432/velexis            # owner of platform and reference, DDL allowed
pnpm db:migrate:tenants                                                          # apply tenant migrations to every tenant schema
pnpm --filter @velexis/db exec node dist/cli/migrate.js tenants --dir ../../ota/backend/migrations/tenant --report "$PWD/.local/migrate.json"
node ota/backend/dist/cli.js tenants:report-migrations --report .local/migrate.json  # publish the report as a deploy does (OBE-007)
pnpm --filter @velexis/db exec node dist/cli/migrate.js tenant --schema tenant_demo --dir ../../ota/backend/migrations/tenant --create
pnpm db:codegen                                                                  # after a migration: regenerate Kysely types, commit them
```

To start over: `sudo -u postgres dropdb --force velexis` (macOS: `dropdb --force velexis`), then `bash deploy/scripts/dev-setup.sh && pnpm db:migrate && pnpm db:seed:reference`.

## 4. E-mail with Mailpit

- Apps send to `SMTP_URL=smtp://127.0.0.1:1025` (no TLS, no auth). Nothing ever leaves the machine.
- The UI at `:8025` shows HTML, text and headers. Integration tests read messages through the API (`MAILPIT_API_URL`) with `@velexis/testing/mailpit` (task X-025).
- Clear the inbox: `curl -X DELETE http://127.0.0.1:8025/api/v1/messages`.

## 5. Amadeus stub

[`tools/amadeus-stub`](../../tools/) (task X-026, M1) is a small Node server that implements the Amadeus OAuth token endpoint and the flight operations of [`docs/amadeus-api/`](../amadeus-api/) from recorded, scrubbed fixtures ([ADR-0015](adr/0015-testing-strategy.md)).

- Point the OTA backend at it: `AMADEUS_BASE_URL_TEST=http://127.0.0.1:4900` (already in `.env.example`). The Velexis test Amadeus account in the local database can hold any dummy client id and secret.
- Choose a scenario per request with the header `X-Stub-Scenario` (`sold-out`, `price-changed`, `ticketing-failed`, `version-conflict`, `server-error`, `rate-limited`, `timeout`, `timeout-lost`), or with magic values in end-to-end runs (destination `ZZZ` returns no offers; a credit card numbered `4000000000000002` is refused).
- Every request is validated against the Amadeus specification, so a malformed request from our client fails loudly.
- **Recording fixtures** from the real Amadeus Enterprise test environment (task X-034; the human step of OBE-027) uses your own test credentials and is **never** run in CI: the command refuses to start when `CI` is set (or `APP_ENV`/`NODE_ENV` is `production`).

  ```bash
  # In the git-ignored .env.local, or exported by your shell (from your password manager); never in a committed file.
  AMADEUS_RECORD_CLIENT_ID=...
  AMADEUS_RECORD_CLIENT_SECRET=...
  # AMADEUS_RECORD_BASE_URL=https://test.travel.api.amadeus.com   (the default; https only)

  pnpm --filter @velexis/amadeus-stub record quoteAirOffers --request ~/amadeus/price.json
  pnpm --filter @velexis/amadeus-stub record getFlightOrder --request ~/amadeus/order.json --scenario cancelled
  ```

  The request file holds `{ "query"?, "pathParams"?, "body"? }`, with synthetic travellers. The command validates it against the specification, gets a token, sends it, scrubs the response (names, dates of birth, document and ticket numbers, e-mail addresses to `@example.com`, phone numbers to reserved test ranges, postal addresses, record locators, card data), scans the result and writes `tools/amadeus-stub/fixtures/<folder>/<scenario>.json`. It never prints the secret, the token or a body, and writes nothing when the scan still finds personal data. Details: [`tools/amadeus-stub/README.md`](../../tools/amadeus-stub/README.md#record-a-fixture-from-the-amadeus-test-environment).
- **The fixture scan** (`tools/amadeus-stub/test/fixtures-scan.test.ts`, part of `pnpm test`) fails on any personal data left in a committed fixture: an e-mail address outside `example.com`, a run of 13 to 19 digits that does not start with the synthetic prefix `000`, a passport-like document number, a phone number outside the reserved test ranges, or a name that is not in the synthetic name lists ([`fixtures/README.md`](../../tools/amadeus-stub/fixtures/README.md)).

## 6. Stripe with the Stripe CLI (from M3)

```bash
stripe login                                       # once, test mode only
bash tools/dev/stripe-listen.sh                    # both endpoints below; Ctrl-C stops both
bash tools/dev/stripe-listen.sh --only ota         # OTA customer payments only (the platform API is not running)
bash tools/dev/stripe-listen.sh --print-secrets    # only print the .env.local lines
```

[`tools/dev/stripe-listen.sh`](../../tools/dev/stripe-listen.sh) (task X-028) runs one `stripe listen` per webhook endpoint of [`architecture.md`](architecture.md#d-stripe-webhooks-platform-billing-vs-ota-payments) §5 (d), each subscribed to the events its production endpoint receives, with the output prefixed `[ota]` or `[billing]`:

| Listener | Forwards to | Events |
|---|---|---|
| `ota` | `localhost:4000/webhooks/stripe/velexis/test` (OTA API) | `payment_intent.amount_capturable_updated`, `.succeeded`, `.payment_failed`, `.canceled`, `charge.refunded`, `charge.refund.updated`, `charge.dispute.created`, `charge.dispute.closed` ([ADR-0011](adr/0011-payments-stripe-and-airline-card.md), [OTA ADR-0010](../../ota/docs/adr/0010-stripe-gateway-and-payment-webhooks.md)) |
| `billing` (M5) | `localhost:3100/webhooks/stripe/billing` (platform API) | `checkout.session.completed`, `customer.subscription.created`, `.updated`, `.deleted`, `invoice.finalized`, `.paid`, `.payment_failed`, `.voided` ([ADR-0013](adr/0013-subscription-billing-stripe-billing.md)) |

- Before it starts the listeners, the script prints the CLI's `whsec_…` signing secret (`stripe listen --print-secret`; the CLI keeps one per account and device, so both listeners share it) as the lines `STRIPE_WEBHOOK_SECRET_VELEXIS_TEST=…` and `STRIPE_BILLING_WEBHOOK_SECRET=…`. Put them in `.env.local` and restart the backends. Each listener's `Ready!` line shows the secret it signs with; if it ever differs (for example after a new `stripe login`), update `.env.local` (§9, "Webhook signature errors").
- Test mode only: the script never passes `--live`, refuses a live `STRIPE_API_KEY` (`sk_live_`, `rk_live_`) and refuses to run where `/etc/velexis` exists. When one listener exits (not logged in, network gone), it stops the other and exits with that status.
- The plain commands, if you prefer two terminals: `stripe listen --forward-to localhost:4000/webhooks/stripe/velexis/test` and `stripe listen --forward-to localhost:3100/webhooks/stripe/billing` (without the event filters, every event of the account reaches both backends, which acknowledge and ignore what is not theirs).
- Use Stripe's documented test cards only (3-D Secure: `4000 0027 6000 3184`). Never type a real card number anywhere in development.
- Trigger events without a browser: `stripe trigger payment_intent.succeeded`. Objects that `stripe trigger` creates carry no Velexis metadata, so the OTA backend treats their events as events of an unknown tenant: it logs and acknowledges them ([`architecture.md`](architecture.md#d-stripe-webhooks-platform-billing-vs-ota-payments) §5 (d)). Add the metadata with `--add payment_intent:metadata.<key>=<value>` ([`packages/testing/fixtures/README.md`](../../packages/testing/fixtures/README.md#refreshing-a-fixture-from-stripe-trigger) shows the keys).
- Automated tests do not use the CLI: they sign synthetic fixture events with `@velexis/testing/stripe` ([`packages/testing/README.md`](../../packages/testing/README.md#stripe-velexistestingstripe), fixtures and how to refresh them in [`packages/testing/fixtures/README.md`](../../packages/testing/fixtures/README.md)).
- Live keys are never used locally.

## 7. Tests

| Level | Command | Needs |
|---|---|---|
| Unit, contract, UI | `pnpm test` (or `pnpm --filter <pkg> test -- <pattern>`) | nothing running |
| Integration | `pnpm test:int` | PostgreSQL, Redis, Mailpit; the Amadeus stub is started in-process by the tests |
| End-to-end | `pnpm test:e2e` | the apps built (the harness starts them, with `E2E_WITH_OTA=1` also the stub and the OTA worker, on a fresh database), PostgreSQL, Redis, Mailpit, Playwright's Chromium, Stripe CLI for payment journeys; [`tools/e2e/README.md`](../../tools/e2e/README.md) |
| Types and lint | `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | nothing running |
| Plans | `pnpm plan:lint` | nothing |
| Local setup scripts | `node --test tools/dev/dev-keys.test.mjs`, `shellcheck -S style deploy/scripts/dev-setup.sh tools/dev/stripe-listen.sh` | nothing (the `dev-setup` CI job also runs §2 on a clean runner; no CI job checks `stripe-listen.sh` yet) |

Integration tests build one migrated template database per run (platform, reference, `tenant_alpha`, `tenant_beta`) as `velexis_test_admin`, then clone it per test file, so tests never touch your `velexis` development data.

## 8. Trying the Caddyfile locally (optional)

```bash
VELEXIS_EDGE_SECRET=dev_edge_secret_change_me caddy validate --config deploy/caddy/Caddyfile --adapter caddyfile
bash deploy/caddy/test/caddy-smoke.sh   # Caddy 2.8.4 and Node 22; no root, no DNS entries
```

The smoke test runs the real Caddyfile on `127.0.0.1:8443` with Caddy's local CA, `*.localhost` host names and an echo server in place of the apps, and checks the edge headers, blocked paths, on-demand TLS, maintenance page and admin socket ([`deploy/caddy/test/README.md`](../../deploy/caddy/test/README.md)). For day-to-day storefront work you do not need Caddy: the storefront's Vite proxy already mimics the edge headers.

## 9. Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `ConfigError: … missing` at start-up | `.env.local` missing or an app-specific value not set | Compare with `.env.example`; set the value in `<app>/.env.local` |
| `password authentication failed for user "velexis_…"` | Roles created with other passwords | Re-run `dev-setup.sh` (it resets the development passwords) |
| `permission denied for table …` as the OTA role | Platform read grants not applied, or the table is not on the read list | `pnpm db:migrate` (applies `R__ota_read_access.sql`); the OTA backend may only read the tables of ADR-0004 |
| `relation "bookings" does not exist` in the OTA backend | Query ran outside `tenantTx` (the OTA role's `search_path` is `pg_catalog`) | Use `tenantTx`; never set `search_path` yourself |
| `NOAUTH Authentication required` from Redis | The client sends no password (Redis has `dev_redis` since `dev-setup.sh`) | Check `REDIS_URL` in `.env.local`; with redis-cli use `REDISCLI_AUTH=dev_redis redis-cli` |
| `WRONGPASS` from `redis-cli -u "$REDIS_URL"` | redis-cli sends an empty user name for `redis://:password@`; the apps do not | `REDISCLI_AUTH=dev_redis redis-cli` instead of `-u` |
| `dev-setup.sh` warns that Redis refused `CONFIG REWRITE` | Redis runs without a writable configuration file | Add `requirepass dev_redis` to `redis.conf` and restart Redis, or the password is gone after the next restart |
| `dev-setup.sh` warns that Redis has another password | Your Redis had a password before | Put that password in `REDIS_URL` in `.env.local`, or set Redis's password to `dev_redis` |
| `ERROR: /etc/velexis exists` from `dev-setup.sh` | The machine looks like a production host | Never run it there; on a development machine remove the stray folder |
| `invalid LC_COLLATE locale name: "C.UTF-8"` from `dev-setup.sh` on macOS | `bootstrap.sql` creates the database with the `C.UTF-8` locale, which macOS may lack (not yet verified on macOS) | Create the database first, then re-run: `createdb -O velexis_migrator -E UTF8 --locale=C -T template0 velexis` (upper/lower case of non-ASCII letters then differ from the VM) |
| Key file `… is readable by others` or missing at start-up | `.local/keys/` not created, or a file's mode was changed | `pnpm dev:keys` (creates missing files and tightens loose modes; `--force` replaces all keys and invalidates local encrypted data) |
| `OOM command not allowed when used memory > 'maxmemory'` | A cache key without a TTL filled Redis | Find it with `redis-cli --bigkeys`; every cache key needs a TTL |
| Integration tests hang at start | PostgreSQL or Redis not running, or `TEST_DATABASE_ADMIN_URL` wrong | `pg_isready`, `redis-cli ping`, check `.env.local` |
| Stale types after an OpenAPI or migration change | Generated files not rebuilt | `pnpm contracts:generate`, `pnpm db:codegen`, `pnpm build` |
| Webhook signature errors | `whsec_` changed after restarting `stripe listen` | Copy the new secret into `.env.local` and restart the backend |
