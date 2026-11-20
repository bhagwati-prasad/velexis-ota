---
id: getting-started
title: Getting started locally
summary: From a fresh clone to the whole Velexis stack running on your machine, with seeded data, the Amadeus stub, Mailpit and (optionally) the Stripe CLI.
order: 20
---

## The short version

```bash
nvm install && corepack enable                       # Node 24 and pnpm 9.15.9
pnpm install
cp .env.example .env.local && cp ota/backend/.env.example ota/backend/.env.local
bash deploy/scripts/dev-setup.sh && pnpm dev:keys && pnpm build
pnpm db:migrate && pnpm db:seed:reference
mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 &
pnpm stub:amadeus &                                  # the platform seed needs it
pnpm --filter @velexis/platform-backend dev:seed     # keep the printed admin password and TOTP URI
pnpm --filter @velexis/ota-backend dev:seed          # after the platform seed; keep the three printed keys
pnpm dev                                             # the six apps; not Mailpit or the stub
```

Then open <http://localhost:3000> (always `localhost`, never `127.0.0.1`: cookies and redirects use `localhost`),
sign up, confirm the e-mail in Mailpit and create your own OTA: the seeded demo OTA has no owner, so only your own OTA
opens the OTA admin ([[journey:signup-and-provision]]).

```try
url: http://localhost:3000
command: pnpm dev
expect: Portal on :3000, platform admin on :3001, OTA admin on :3002, the demo OTA's storefront on :5173, Mailpit on :8025, platform API on :3100, OTA API on :4000
```

The rest of this page explains each step, what it creates and what to do when it fails. The source runbook is
`repo:docs/mvp/local-development.md`; this page follows it and the real scripts. Like production, local development
uses **native services, no Docker**.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 (`.nvmrc`; `package.json` engines `>=24 <25`) | `nvm install` in the repository root |
| pnpm | 9 (exactly `pnpm@9.15.9`, `packageManager`) | `corepack enable` |
| PostgreSQL | 16 | Must be running; `dev-setup.sh` starts it if installed but stopped |
| Redis | 7.4 | `dev-setup.sh` sets the password `dev_redis` (development only) |
| Mailpit | 1.2x | Catches every e-mail: SMTP 1025, UI and API 8025 |
| Stripe CLI | 1.x | Optional: only for card payments (storefront) and billing webhooks |
| jq, age | any | jq for reading JSON logs; age only for backup work |
| Caddy 2.8 | optional | Only to try the real Caddyfile (`repo:deploy/caddy/test/caddy-smoke.sh`) |
| Chromium or Firefox | recent | `__Host-` cookies work on `http://localhost` there; **Safari refuses them**, so the storefront and console sessions fail in Safari locally |

## One-time setup

Run these as your normal user from the repository root. Both scripts are idempotent.

1. `pnpm install` installs every workspace from `pnpm-lock.yaml`.
2. `cp .env.example .env.local` gives every app the shared development values (`repo:.env.example`). Never commit
   `.env.local`.
3. `cp ota/backend/.env.example ota/backend/.env.local` gives the OTA backend **its own** database role
   (`velexis_ota_app`), its own JWT key (`ota-jwt-ed25519.pem`), the document URL key and `AIRLINE_CARD_ENABLED=true`
   (`repo:ota/backend/.env.example`). Without it the OTA backend would start with the platform's role.
4. `bash deploy/scripts/dev-setup.sh` (`repo:deploy/scripts/dev-setup.sh`) creates the database `velexis`, the roles
   `velexis_migrator`, `velexis_provisioner`, `velexis_platform_app`, `velexis_ota_app` and `velexis_test_admin` with the
   development passwords of `.env.example`, the `platform` and `reference` schemas, and sets the Redis password. It
   refuses to run where `/etc/velexis` exists (a production host).
5. `pnpm dev:keys` (`repo:tools/dev/dev-keys.mjs`) writes `.local/keys/` (mode 0700): `master-v1.key`,
   `api-key-pepper`, `document-url.key`, `platform-jwt-ed25519.pem`, `ota-jwt-ed25519.pem` (each 0600), and creates
   `.local/storage/`. It never overwrites a file unless you pass `--force` (which makes all locally encrypted data
   unreadable).
6. `pnpm build` builds the shared packages first (apps import their `dist/`).
7. `pnpm db:migrate` applies the `platform` and `reference` migrations
   (`repo:platform/backend/migrations/platform`, `repo:platform/backend/migrations/reference`) and the read grants of
   the OTA role (`R__ota_read_access.sql`).
8. `pnpm db:seed:reference` loads airports, airlines, countries, currencies, time zones and aircraft
   (`repo:tools/reference-data`).

```note
Configuration precedence (`repo:packages/config/src/dev-env-files.ts`): the real environment, then `<app>/.env.local`,
then the root `.env.local`. Relative key and storage paths are resolved against the repository root (the folder with
`pnpm-workspace.yaml`), wherever the app runs.
```

## Development data (seeds)

Start the [[amadeus-stub]] first: the platform seed verifies its test Amadeus account against it.

```bash
pnpm stub:amadeus &                                      # 127.0.0.1:4900
pnpm --filter @velexis/platform-backend dev:seed         # platform admin, test Amadeus account, 40 test offices
pnpm --filter @velexis/ota-backend dev:seed              # demo OTA tenant_demo with three test API keys
```

| Seed | Creates (each only if missing) | Prints once |
|---|---|---|
| Platform `dev:seed` (`repo:platform/backend/src/dev/dev-seed.command.ts`) | The platform admin `admin@example.com` (active, verified, `is_platform_admin`, TOTP MFA on); the Velexis **test** Amadeus account pointing at the stub, verified to `active`; forty test offices `DEV1A0001` to `DEV1A0040` in the [[office-pool]] (`available`) | The admin's **random** password and its `otpauth://` TOTP set-up URI |
| OTA `dev:seed` (`repo:ota/backend/src/dev/dev-seed.command.ts`) | The tenant `demo` ("Demo Travel", plan `early_access`, EUR, storefront `test`), its sub-domain `demo.ota.example.com`, an Amadeus test connection on one test office, a Stripe test connection in Velexis mode, then `tenant_demo` provisioned by the worker's real provisioning code and set `active` | `Publishable test key`, `Secret test key` (scope `storefront`) and `Console automation test key` (`console:automation` with `amadeus:read`) |

```warning
Copy what the seeds print **when they print it**. The admin password, the TOTP URI and the three keys are stored
nowhere in clear and a second run prints nothing (it changes nothing either). Lost the admin's password or
authenticator? Run `pnpm --filter @velexis/platform-backend exec node dist/cli.js admin:reset-mfa admin@example.com`
(MFA off, sessions revoked), reset the password with the portal's "Forgot password", sign in to the portal, turn MFA on
again in **Account → Security**, then sign in to the platform admin (the reset e-mail lands in Mailpit). Lost a demo key? The demo OTA has no owner, so no one can roll it in the portal: revoke or
delete its row in `platform.api_keys` locally and run the OTA seed again, which issues a new key of that role.
```

Both seeds refuse `APP_ENV=production`. The OTA seed is a **development-only exception** to "the OTA backend never
writes platform tables": it writes the platform rows as `velexis_migrator` (`DATABASE_MIGRATOR_URL`), what the portal
and the platform worker would write in a real sign-up.

```bug-hunt
The demo OTA has **no owner and no staff**: nobody can open its console. To work in the OTA admin, sign up in the
portal and create your own OTA ([[journey:signup-and-provision]]). The demo OTA is the shared "other OTA" for
isolation checks and the default storefront of the Vite dev server.
```

## Start the stack

Daily, in separate terminals (or `pnpm dev` for all apps at once through Turborepo):

| Process | Command | URL / port | Health |
|---|---|---|---|
| Mailpit | `mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025` | <http://localhost:8025> | the UI loads |
| Amadeus stub | `pnpm stub:amadeus` (`tsc -b && node dist/cli.js`) | `127.0.0.1:4900` | no health route; any path answers an Amadeus-style 404 |
| Platform API + worker | `pnpm --filter @velexis/platform-backend dev` | API `:3100`, worker health `:3101` | `curl -s 127.0.0.1:3100/health/ready`, `curl -s 127.0.0.1:3101/health/ready` |
| OTA API + worker | `pnpm --filter @velexis/ota-backend dev` | API `:4000`, worker health `:4001` | `curl -s 127.0.0.1:4000/health/ready` (loopback only), `curl -s 127.0.0.1:4001/health/ready` |
| Portal | `pnpm --filter @velexis/platform-frontend dev` | <http://localhost:3000> | `/health/ready` |
| Platform admin | `pnpm --filter @velexis/platform-admin dev` | <http://localhost:3001> | `/health/ready` |
| OTA admin | `pnpm --filter @velexis/ota-admin dev` | <http://localhost:3002> | `/health/ready` (503 while the OTA API is down) |
| Storefront (demo OTA) | `pnpm --filter @velexis/ota-frontend dev` | <http://localhost:5173> | the home page shows "Search flights" |
| Storefront, production build | `pnpm --filter @velexis/ota-frontend preview` | <http://localhost:4173> | same, with the production CSP |

Each backend `dev` script builds once, then runs `tsc --watch` plus `node --watch` on `dist/main.js` and
`dist/worker.js`. The Next.js apps run `next dev` bound to `127.0.0.1`. `pnpm dev` does **not** start Mailpit or the
stub.

```tip
Use `localhost` consistently in the browser. E-mail links and redirects name `localhost` (`PUBLIC_PORTAL_URL`,
`PUBLIC_OTA_ADMIN_URL`), and cookies set for `localhost` are not sent to `127.0.0.1`.
```

## Sign in everywhere (development only)

| Where | Account | How |
|---|---|---|
| Platform admin <http://localhost:3001/sign-in> | `admin@example.com` + the password the platform seed printed | Then a TOTP code: add the printed `otpauth://` URI to an authenticator app (development only; never a real account), or print a code from its `secret=` value with `cd platform/backend && node -e "console.log(require('otplib').authenticator.generate('<secret>'))"`. MFA is mandatory even locally; a code works once per 30-second window. |
| Portal <http://localhost:3000/sign-up> | Any address you invent, for example `owner1@example.com`; a password of 12+ characters with a letter and a digit, not in the breached list | Verify through the link in Mailpit, then sign in. Turn on MFA in **Account → Security** if you will test live features or step-ups. |
| OTA admin <http://localhost:3002> | No sign-in page | Portal → your OTA → **Open console** ([[sso]]). Without a session the OTA admin sends you to the portal's `/console?tenant=…` page. |
| Storefront <http://localhost:5173> | Guests need nothing; customers sign up on `/account/sign-up.html` with a password of 10+ characters, not in the breached list (a different rule from the portal's) | Sign-up signs you in at once; the verification link arrives in Mailpit. |
| SDK / API | `X-Api-Key: pk_test_…` or `sk_test_…` | Keys from the OTA seed (demo OTA) or the portal's API keys page (your OTA). Try `curl -H "X-Api-Key: pk_test_…" http://localhost:4000/v1/storefront`. |
| PostgreSQL | `psql postgres://velexis_migrator:dev_migrator@127.0.0.1:5432/velexis` | Development password from `.env.example`. The migrator owns `platform` and `reference` and is a member of `velexis_provisioner`, so it can read every `tenant_*` schema. |
| Redis | `REDISCLI_AUTH=dev_redis redis-cli` | Database 0 is `pnpm dev`'s; the e2e harness uses database 15. |

## The Amadeus stub

`repo:tools/amadeus-stub` is a Node server on `127.0.0.1:4900` that implements the Amadeus OAuth token endpoint and
the twelve flight operations from recorded, scrubbed fixtures. Both backends point at it through
`AMADEUS_BASE_URL_TEST` and `AMADEUS_BASE_URL_LIVE`.

| Behaviour | Value |
|---|---|
| Every search | The five offers of its fixture (Madrid to Paris); use `MAD` → `PAR` with a date about 40 days ahead |
| No offers | Destination `ZZZ` |
| Upsell | Fare families BASIC, CLASSIC, FLEXIBLE |
| Airline-card test PAN | `4111 1111 1111 1111` (VISA, card fee €1.20); `4000 0000 0000 0002` is declined |
| Scenarios (header `X-Stub-Scenario`, forwarded by the OTA API outside production) | `sold-out`, `price-changed`, `ticketing-failed`, `version-conflict`, `server-error`, `rate-limited`, `timeout` (holds 30 s), `timeout-lost` |
| Orders | Remembered in memory until the stub restarts (needed for retrieve, PNR import, queues and reconciliation) |
| Validation | Every request is validated against `repo:docs/amadeus-api`; a malformed request gets 400 |

```bug-hunt
Restarting the stub forgets every order it created: bookings made before the restart then fail on retrieve, resync,
issue and cancel with a supplier "not found". That is the stub, not a bug; re-book after a stub restart.
```

## Mailpit

Every app sends to `SMTP_URL=smtp://127.0.0.1:1025`; nothing leaves your machine. Open <http://localhost:8025> to see
HTML, text, headers and attachments (itinerary and e-ticket PDFs). Clear it with
`curl -X DELETE http://127.0.0.1:8025/api/v1/messages`. The platform sends from its worker through `email_outbox`; the
OTA sends from its worker through `notifications`. No e-mail at all usually means a worker is not running.

## Stripe CLI (optional)

Needed for **card payments on the storefront** (Stripe.js, 3-D Secure) and for **Stripe Billing**. Use test mode only.

1. Put your own Stripe **test** keys in `ota/backend/.env.local`: `STRIPE_SECRET_KEY_TEST=sk_test_…`,
   `STRIPE_PUBLISHABLE_KEY_TEST=pk_test_…`. The committed `…_replace_me` dummies pass the format check, so the
   storefront still offers card payment, but paying fails. Without real keys, empty both values: the card method then
   disappears, and the only way to pay is the airline card, once it is switched on in the OTA admin's storefront
   settings (it is off by default, also for the demo OTA).
2. `stripe login` once, then `bash tools/dev/stripe-listen.sh` (`repo:tools/dev/stripe-listen.sh`): one listener to
   `localhost:4000/webhooks/stripe/velexis/test` (OTA payments) and one to `localhost:3100/webhooks/stripe/billing`
   (platform billing). `--only ota` runs the first only.
3. Copy the printed `STRIPE_WEBHOOK_SECRET_VELEXIS_TEST=whsec_…` and `STRIPE_BILLING_WEBHOOK_SECRET=whsec_…` into
   `.env.local` and restart the backends.
4. Pay with Stripe's test cards only: `4242 4242 4242 4242` (no challenge) or `4000 0027 6000 3184` (3-D Secure).

The script refuses live keys and refuses to run on a production host. Without the CLI, use the airline-card method
against the stub ([[journey:book-with-airline-card]]), which needs no Stripe at all.

## The demo storefront and your own OTA's storefront

The storefront is **one static build for every OTA**; the OTA is chosen by the host name. Locally the Vite dev server
plays Caddy's role (`repo:ota/frontend/vite.config.js`, `repo:ota/frontend/scripts/vite-plugins.js`): it proxies
`/api/*` to `OTA_API_URL` (`127.0.0.1:4000`), strips `/api`, and adds `X-Velexis-Edge: <VELEXIS_EDGE_SECRET>`,
`X-Velexis-Host: <STOREFRONT_DEV_HOST>` and a matching `Origin`. The default host is `demo.ota.example.com`, the demo
OTA.

To see **your own OTA** (key `acme`), create `ota/frontend/.env.local` with
`STOREFRONT_DEV_HOST=acme.ota.example.com` and restart the dev server. One dev server serves one OTA at a time; run a
second one with `STOREFRONT_DEV_PORT=5174` for another OTA.

```note
No DNS or `/etc/hosts` entry is needed: the browser talks to `localhost:5173`, and only the proxy names the OTA host to
the API. The storefront has no runtime environment of its own; everything tenant-specific comes from `storefront.get`
(`GET /v1/storefront`).
```

## Turning on the M5 features locally

The platform's milestone switches are `false` in `.env.example`. To test a feature, set it in
`platform/backend/.env.local` and restart the platform backend (the portal and admin read them from `GET /v1/me`):

| Switch | Unlocks | Also needs |
|---|---|---|
| `FEATURE_LIVE_SWITCH` | Go-live page and `goLive` | A plan with live mode, an active subscription, a live Amadeus office, live payments, payout account, MFA |
| `FEATURE_CUSTOM_DOMAINS` | Domains page "Add a custom domain", the DNS verification schedules | `STOREFRONT_IPV4` (set in `.env.example`); a plan with `limits.customDomains` above 0 (the seeded `early_access` has 0) |
| `FEATURE_SETTLEMENTS` | Payout account, settlements | `STRIPE_SECRET_KEY` (a test-mode value) |
| `FEATURE_STRIPE_BILLING` | Stripe Checkout at create-OTA, Customer Portal, invoices | Real test `STRIPE_SECRET_KEY`, the billing webhook secret, the Stripe CLI |
| `FEATURE_OWN_STRIPE` | Connect Standard or the OTA's own Stripe keys | Connect client id and webhook secret |
| `FEATURE_OWN_AMADEUS` | The OTA's own Amadeus credentials | A verifiable credential (the stub accepts any) |

## Resetting data

| To reset… | Do |
|---|---|
| Everything | Stop all apps; `sudo -u postgres dropdb --force velexis` (macOS: `dropdb --force velexis`); `REDISCLI_AUTH=dev_redis redis-cli -n 0 FLUSHDB`; then `bash deploy/scripts/dev-setup.sh && pnpm db:migrate && pnpm db:seed:reference`, start the stub and run both seeds again |
| E-mails | `curl -X DELETE http://127.0.0.1:8025/api/v1/messages` |
| Caches only | `REDISCLI_AUTH=dev_redis redis-cli -n 0 --scan --pattern 'tenant:*'` (also `host:*`, `apikey:*`, `conn:*`, `member:*`, `t:*`) and delete them; they refill from PostgreSQL within one request |
| Generated documents | Empty `.local/storage/` (the rows in `booking_documents` then point at missing files) |
| Tenant migrations after a pull | `pnpm db:migrate` then `pnpm db:migrate:tenants` |

```warning
Flush Redis together with a database drop: queued BullMQ jobs (`vx:*` keys) and cached rows refer to ids that no
longer exist. Never `--force` the dev keys while you keep the database: every envelope-encrypted secret (Amadeus
credentials, MFA secrets, payout details) becomes undecryptable.
```

## Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| `ConfigError: … missing` at start-up | No `.env.local`, or an app-specific value missing | Compare with `.env.example` and the app's `.env.example` |
| `password authentication failed for user "velexis_…"` | Roles created with other passwords | Re-run `bash deploy/scripts/dev-setup.sh` |
| OTA backend: `permission denied` on `platform` tables, or provisioning fails | `ota/backend/.env.local` missing (wrong role), or the read grants missing | Create it from `ota/backend/.env.example`; `pnpm db:migrate` |
| `relation "bookings" does not exist` | A query outside [[tenant-tx]] (the OTA role's `search_path` is `pg_catalog`) | A code bug: tenant queries must use `tenantTx` |
| `NOAUTH` or `WRONGPASS` from Redis | No password sent | `REDISCLI_AUTH=dev_redis redis-cli` (not `-u`) |
| Platform `dev:seed` exits 1, account `pending_verification` | The stub was not running | Start `pnpm stub:amadeus`, run the seed again |
| OTA `dev:seed` exits 1: no test Amadeus account or no free office | Platform seed not run (or all forty offices assigned) | Run the platform seed first; add offices in the platform admin |
| New OTA stays "Setting up" | OTA worker not running (it consumes `ota-tenant-ops`), or the platform worker not running (post-steps) | Start `pnpm --filter @velexis/ota-backend dev`; check the provisioning job in the platform admin |
| No e-mail in Mailpit | Platform or OTA worker down, or Mailpit not on 1025 | Start the worker; check `email_outbox` / `notifications` rows |
| Storefront: "This travel site is temporarily unavailable" | The OTA is suspended (or `STOREFRONT_DEV_HOST` names an OTA that is not active) | Resume it in the platform admin; check the host |
| Console link "expired or was already used" | The portal token is single use and lives 60 s | Press "Open console" again |
| Cookies missing, endless redirects to sign-in | Mixed `localhost` / `127.0.0.1`, or Safari | Use `localhost` and Chromium or Firefox |
| Card payment offered but fails on the storefront | The committed dummy Stripe keys (`sk_test_replace_me` passes validation) | Real test keys + Stripe CLI, or empty both keys and use the airline card |
| `OOM command not allowed` from Redis | A cache key without TTL | `redis-cli --bigkeys`; every cache key needs a TTL (a bug) |
| Port already in use | Another stack (for example an e2e run) holds 3000–4001 | Stop it; the e2e harness refuses to start on busy ports too |
| Stale types after a contract or migration change | Generated files not rebuilt | `pnpm contracts:generate`, `pnpm db:codegen`, `pnpm build` |
