# Local development

This runbook gets a developer machine (or an agent's sandbox) from a fresh clone to the whole Velexis stack running locally: the prerequisites, the one-time setup of PostgreSQL, Redis, keys and environment files, the daily commands, the local stand-ins for external services (Mailpit for e-mail, the Stripe CLI for webhooks, the Amadeus stub), how to run each test level, and fixes for common problems. Like the VM, local development uses **native services, no Docker** ([ADR-0007](adr/0007-single-vm-without-docker.md)). Task X-016 in [`plans/foundation-tasks.md`](plans/foundation-tasks.md) creates the helper scripts named here and keeps this page true.

Related: [`AGENTS.md`](../../AGENTS.md) §10 (command cheat sheet), [`architecture.md`](architecture.md) §3 and §6 (ports, configuration matrix), [`deployment-single-vm.md`](deployment-single-vm.md) (production), [`../../packages/README.md`](../../packages/README.md) (shared packages), [ADR-0015](adr/0015-testing-strategy.md) (testing).

## 1. Prerequisites

| Tool | Version | Install (Ubuntu 24.04; macOS with Homebrew in brackets) |
|---|---|---|
| Node.js | 22 LTS (`.nvmrc`) | `nvm install` in the repository root (`brew install nvm`) |
| pnpm | 9 (exact version in `package.json` → `packageManager`) | `corepack enable` (ships with Node 22) |
| PostgreSQL | 16 | PGDG apt repository: `sudo apt install postgresql-16` (`brew install postgresql@16`) |
| Redis | 7.4 | packages.redis.io apt repository: `sudo apt install redis-server` (`brew install redis`) |
| Mailpit | 1.2x | `sudo bash < <(curl -sL https://raw.githubusercontent.com/axllent/mailpit/develop/install.sh)` (`brew install mailpit`) |
| Stripe CLI | 1.x | Stripe's apt repository or the release binary (`brew install stripe/stripe-cli/stripe`); only from M3 |
| age, jq | any | `sudo apt install age jq` (`brew install age jq`); age only for backup work |
| Caddy | 2.8 (optional) | Only to try the Caddyfile locally |

The exact commands for the vendor repositories are the same as in [`provision-vm.sh`](../../deploy/scripts/provision-vm.sh) (`step_packages`).

## 2. One-time setup

```bash
git clone <repository-url> velexis && cd velexis
nvm install && corepack enable
pnpm install                                   # all workspaces, exact versions from pnpm-lock.yaml

cp .env.example .env.local                     # shared local values; never commit .env.local
bash deploy/scripts/dev-setup.sh               # roles, database "velexis", test admin role (X-016)
pnpm dev:keys                                  # .local/keys/: master key, pepper, JWT keys, document URL key
pnpm build                                     # shared packages first (apps import their dist/)
pnpm db:migrate                                # platform + reference migrations
pnpm db:seed:reference                         # airports, airlines, countries, currencies, time zones, aircraft
```

What `dev-setup.sh` does, so you can do it by hand if needed:

1. Starts PostgreSQL and Redis if they are installed but stopped.
2. Runs [`deploy/postgres/bootstrap.sql`](../../deploy/postgres/bootstrap.sql) as the `postgres` superuser with the **development** passwords of `.env.example` (`dev_migrator`, `dev_provisioner`, `dev_platform`, `dev_ota`): creates the database `velexis`, the roles `velexis_migrator`, `velexis_provisioner`, `velexis_platform_app`, `velexis_ota_app`, the `platform` and `reference` schemas and the default privileges.
3. Creates `velexis_test_admin` (`LOGIN CREATEDB`, password `dev_test_admin`) for the integration-test harness, which clones a migrated template database per test file.
4. Sets the local Redis password to `dev_redis` (`CONFIG SET requirepass` and `CONFIG REWRITE`), matching `REDIS_URL`.

Per-app overrides go into `<app>/.env.local` (for example the OTA backend's `DATABASE_URL` with the `velexis_ota_app` role and its own `JWT_PRIVATE_KEY_FILE`). The precedence is: real environment, then `<app>/.env.local`, then the root `.env.local` (`@velexis/config`, task X-002).

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
pnpm --filter @velexis/db exec node dist/cli/migrate.js tenant --schema tenant_demo --dir ../../ota/backend/migrations/tenant --create
pnpm db:codegen                                                                  # after a migration: regenerate Kysely types, commit them
```

To start over: `dropdb -U postgres velexis` (as the `postgres` user), then `bash deploy/scripts/dev-setup.sh && pnpm db:migrate && pnpm db:seed:reference`.

## 4. E-mail with Mailpit

- Apps send to `SMTP_URL=smtp://127.0.0.1:1025` (no TLS, no auth). Nothing ever leaves the machine.
- The UI at `:8025` shows HTML, text and headers. Integration tests read messages through the API (`MAILPIT_API_URL`) with `@velexis/testing/mailpit` (task X-025).
- Clear the inbox: `curl -X DELETE http://127.0.0.1:8025/api/v1/messages`.

## 5. Amadeus stub

[`tools/amadeus-stub`](../../tools/) (task X-026, M1) is a small Node server that implements the Amadeus OAuth token endpoint and the flight operations of [`docs/amadeus-api/`](../amadeus-api/) from recorded, scrubbed fixtures ([ADR-0015](adr/0015-testing-strategy.md)).

- Point the OTA backend at it: `AMADEUS_BASE_URL_TEST=http://127.0.0.1:4900` (already in `.env.example`). The Velexis test Amadeus account in the local database can hold any dummy client id and secret.
- Choose a scenario per request with the header `X-Stub-Scenario` (`sold-out`, `price-changed`, `ticketing-failed`, `version-conflict`, `server-error`, `timeout`), or with magic values in end-to-end runs (destination `ZZZ` returns no offers).
- Every request is validated against the Amadeus specification, so a malformed request from our client fails loudly.
- Recording new fixtures against the real Amadeus test environment (`pnpm --filter @velexis/amadeus-stub record <operation>`, task X-034) uses credentials from your own environment, scrubs names, documents, e-mail addresses and phone numbers, and is **never** run in CI. The stub's fixture scan (`tools/amadeus-stub/test/fixtures-scan.test.ts`) fails on any personal-data pattern left in a committed fixture.

## 6. Stripe with the Stripe CLI (from M3)

```bash
stripe login                                                             # once, test mode only
stripe listen --forward-to localhost:4000/webhooks/stripe/velexis/test   # OTA customer payments
stripe listen --forward-to localhost:3100/webhooks/stripe/billing        # platform billing (M5)
```

- Each `stripe listen` prints a `whsec_…` secret. Put it in `.env.local` (`STRIPE_WEBHOOK_SECRET_VELEXIS_TEST`, `STRIPE_BILLING_WEBHOOK_SECRET`) and restart the backend.
- Use Stripe's documented test cards only (3-D Secure: `4000 0027 6000 3184`). Never type a real card number anywhere in development.
- Trigger events without a browser: `stripe trigger payment_intent.succeeded`. Automated tests do not use the CLI: they sign fixture events with `@velexis/testing/stripe` (task X-028).
- Live keys are never used locally.

## 7. Tests

| Level | Command | Needs |
|---|---|---|
| Unit, contract, UI | `pnpm test` (or `pnpm --filter <pkg> test -- <pattern>`) | nothing running |
| Integration | `pnpm test:int` | PostgreSQL, Redis, Mailpit; the Amadeus stub is started in-process by the tests |
| End-to-end | `pnpm test:e2e` | the whole stack built and running, Mailpit, the stub, Stripe CLI for payment journeys |
| Types and lint | `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | nothing running |
| Plans | `pnpm plan:lint` | nothing |

Integration tests build one migrated template database per run (platform, reference, `tenant_alpha`, `tenant_beta`) as `velexis_test_admin`, then clone it per test file, so tests never touch your `velexis` development data.

## 8. Trying the Caddyfile locally (optional)

```bash
VELEXIS_EDGE_SECRET=dev_edge_secret_change_me caddy validate --config deploy/caddy/Caddyfile --adapter caddyfile
```

Running Caddy locally with real host names needs local DNS entries and `local_certs`; it is rarely worth it. The storefront's Vite proxy already mimics the edge headers.

## 9. Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `ConfigError: … missing` at start-up | `.env.local` missing or an app-specific value not set | Compare with `.env.example`; set the value in `<app>/.env.local` |
| `password authentication failed for user "velexis_…"` | Roles created with other passwords | Re-run `dev-setup.sh` (it resets the development passwords) |
| `permission denied for table …` as the OTA role | Platform read grants not applied, or the table is not on the read list | `pnpm db:migrate` (applies `R__ota_read_access.sql`); the OTA backend may only read the tables of ADR-0004 |
| `relation "bookings" does not exist` in the OTA backend | Query ran outside `tenantTx` (the OTA role's `search_path` is `pg_catalog`) | Use `tenantTx`; never set `search_path` yourself |
| `NOAUTH Authentication required` from Redis | Local Redis has no password yet | `dev-setup.sh` step 4, or remove the password from `REDIS_URL` |
| `OOM command not allowed when used memory > 'maxmemory'` | A cache key without a TTL filled Redis | Find it with `redis-cli --bigkeys`; every cache key needs a TTL |
| Integration tests hang at start | PostgreSQL or Redis not running, or `TEST_DATABASE_ADMIN_URL` wrong | `pg_isready`, `redis-cli ping`, check `.env.local` |
| Stale types after an OpenAPI or migration change | Generated files not rebuilt | `pnpm contracts:generate`, `pnpm db:codegen`, `pnpm build` |
| Webhook signature errors | `whsec_` changed after restarting `stripe listen` | Copy the new secret into `.env.local` and restart the backend |
