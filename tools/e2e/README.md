# `@velexis/e2e`: the Playwright end-to-end harness

The end-to-end suite of Velexis ([ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md) "End-to-end", [PADR-0017](../../platform/docs/adr/0017-platform-test-doubles-and-end-to-end-harness.md) item 3): Playwright journeys in `specs/**/*.e2e.ts` that drive the **built** apps in a real browser, against a stack that the harness starts itself on a fresh database, with Mailpit for e-mail, TOTP codes for MFA and axe for accessibility. Task PFE-014 created it with the `portal` and `platform-admin` projects; PFE-015 and PAD-010 add the platform M1 journeys, and the OTA plan adds its `storefront` and `ota-admin` projects (OFE-008, OAD-016).

- **Test-only.** Every dependency is a `devDependency`; nothing here is shipped or runs on the VM.
- **Not part of `pnpm test` or `pnpm test:int`.** The journeys run with `pnpm test:e2e`, nightly and on pull requests labelled `e2e` ([`.github/workflows/e2e.yml`](../../.github/workflows/e2e.yml)). `pnpm test` runs only the harness's own unit tests (`test/`).

## Run it

Once per machine: the local setup of [`docs/mvp/local-development.md`](../../docs/mvp/local-development.md) §2 (PostgreSQL 16 with the roles of `dev-setup.sh`, Redis, `.env.local`, `pnpm dev:keys`), Mailpit running (§4), and Playwright's Chromium:

```bash
pnpm --filter @velexis/e2e exec playwright install chromium     # add --with-deps on a bare Ubuntu: system libraries
```

Then build the apps and run the journeys:

```bash
pnpm --filter @velexis/platform-backend build && pnpm --filter @velexis/platform-frontend build \
  && pnpm --filter @velexis/platform-admin build                  # or `pnpm build`
pnpm test:e2e -- --project=portal --project=platform-admin specs/smoke.e2e.ts
pnpm test:e2e -- --project=portal                                  # every portal journey
E2E_WITH_OTA=1 pnpm test:e2e -- --project=portal                  # also the Amadeus stub and the OTA worker
pnpm --filter @velexis/e2e exec playwright show-trace test-results/<test>/trace.zip   # after a failure
```

`pnpm test:e2e` is `pnpm --filter @velexis/e2e run test:e2e`: it builds the tooling the harness imports (`@velexis/testing`, `@velexis/reference-data`, `@velexis/amadeus-stub`, a no-op when they are built) and runs `playwright test` with the arguments after `--`. The script drops the `--` that pnpm forwards, because Playwright would take every argument after a `--` for a file filter and so ignore `--project`. It does **not** build the apps: the harness runs what is built, as the VM does, and says which build is missing. With `E2E_WITH_OTA=1` it also needs the OTA backend built with its packages: `pnpm exec turbo run build --filter=@velexis/ota-backend` (or `pnpm build`).

One run at a time per machine: the stack listens on the fixed ports below, and the harness refuses to start when one is taken (a `pnpm dev`, another run).

## Projects

| Project | Specs | Base URL | Runs |
|---|---|---|---|
| `portal` | `specs/portal-*.e2e.ts`, `specs/console-*.e2e.ts`, and the tests of `specs/smoke.e2e.ts` not tagged `@platform-admin`; never a test tagged `@stripe` | `http://127.0.0.1:3000` | locally, on labelled pull requests, nightly |
| `platform-admin` | `specs/admin-*.e2e.ts`, and the tests of `specs/smoke.e2e.ts` not tagged `@portal` | `http://127.0.0.1:3001` | the same |
| `portal-stripe` | the tests tagged `@stripe` in `specs/portal-*.e2e.ts` (Stripe Checkout and the Customer Portal in Stripe's test mode, over the network) | `http://127.0.0.1:3000` | nightly only; the project exists only with `E2E_STRIPE=1` ([PADR-0017](../../platform/docs/adr/0017-platform-test-doubles-and-end-to-end-harness.md) item 4) |

A spec file belongs to a project by its name. `smoke.e2e.ts` is shared, so each of its tests carries the tag of its project (`PROJECT_TAGS` of [`support/fixtures.ts`](support/fixtures.ts)): `test("…", { tag: PROJECT_TAGS.portal }, …)`. A portal journey that needs Stripe over the network carries `PROJECT_TAGS.stripe` and so runs only in `portal-stripe`; no test is ever skipped with `.skip`, the project is simply not selected. A new project (the OTA plan's) adds its entry to `projects` in [`playwright.config.ts`](playwright.config.ts) with its own `testMatch` (for example `specs/storefront/**/*.e2e.ts`) and base URL.

Settings of every project: traces kept and screenshots taken for failed tests only, no video, no retries (a failure is a finding, [AGENTS.md](../../AGENTS.md) §7), `.only` refused when `CI` is set, files in parallel (2 workers in CI) and the tests of one file in order.

## The stack

[`support/stack.ts`](support/stack.ts) is Playwright's global setup. For each run it:

1. reads the harness settings (below), after the `.env.local` files of `tools/e2e` and the repository root;
2. checks that every app is built and that every port is free, and fails at once with the command to run when not;
3. empties the stack's Redis database (`E2E_REDIS_DB`), creates the database `velexis_e2e_<runId>` as `TEST_DATABASE_ADMIN_URL` the way [`bootstrap.sql`](../../deploy/postgres/bootstrap.sql) creates `velexis` (owner `velexis_migrator`, the database grants, [`schemas.sql`](../../deploy/postgres/schemas.sql)), then runs `pnpm db:migrate` and `pnpm db:seed:reference` against it (about 5 s);
4. starts the built apps with `node` (the Next.js apps from their standalone `server.js`, with `.next/static` copied into the standalone tree as [`pack-release.sh`](../../deploy/scripts/pack-release.sh) does);
5. waits until each answers `GET /health/ready` with `200` (at most 60 s each); the Amadeus stub has no health route, so its Amadeus-style `404` on that path counts.

| Process | Entry point | Port |
|---|---|---|
| Platform API | `platform/backend/dist/main.js` | 3100 |
| Platform worker | `platform/backend/dist/worker.js` | 3101 (health) |
| Portal | `platform/frontend/.next/standalone/platform/frontend/server.js` | 3000 |
| Platform admin | `platform/admin/.next/standalone/platform/admin/server.js` | 3001 |
| Amadeus stub (`E2E_WITH_OTA=1`) | `tools/amadeus-stub/dist/cli.js` | 4900 |
| OTA worker (`E2E_WITH_OTA=1`) | `ota/backend/dist/worker.js` | 4001 (health) |

The teardown, also after Ctrl-C, stops every process (SIGTERM, SIGKILL after 10 s), drops the database and empties the Redis database. If the stack cannot start, it cleans up the same way and the run fails with the reason and the last lines of the process's output. A whole start takes 6 to 10 s locally.

**Environment of the apps.** Each process gets the values of the root `.env.example` and then of its own `.env.example` (the precedence of the `.env.local` files in development), and on top:

- `APP_ENV=test`, `LOG_LEVEL=info`, the stack's `REDIS_URL`, the harness's `SMTP_URL` and `MAILPIT_API_URL`;
- the stack database's DSN of the process's own role: `velexis_platform_app` for the platform API, worker and CLI, `velexis_ota_app` and `velexis_provisioner` (`DATABASE_PROVISIONER_URL`) for the OTA worker ([ADR-0004](../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md)). The Next.js apps and the stub get no DSN, and no process gets `DATABASE_MIGRATOR_URL` or `TEST_DATABASE_ADMIN_URL`, even when the developer's shell exports them;
- the ports above, and every public and internal URL on `127.0.0.1` (`PUBLIC_PORTAL_URL=http://127.0.0.1:3000`, `PUBLIC_PLATFORM_ADMIN_URL=http://127.0.0.1:3001`, `PLATFORM_API_URL`, `AMADEUS_BASE_URL_TEST` and `_LIVE` on the stub, …). The browser reaches the apps on `127.0.0.1`, so links in e-mails and redirects must name that host: cookies of `localhost` are not sent to `127.0.0.1`;
- with `E2E_STRIPE=1`, the harness's `STRIPE_SECRET_KEY` and `STRIPE_BILLING_WEBHOOK_SECRET` for the platform backend instead of the dummies.

So a variable that a later task adds to an app's `.env.example` reaches the stack without a change here, and a developer's `.env.local` never changes what the apps see. These are the dummy development values of the `.env.example` files.

**Output.** Each process, `pnpm db:migrate` and `pnpm db:seed:reference` write to `test-results/stack/<name>.log` (redacted JSON lines of the apps; never a DSN). Playwright empties `test-results/` before each run, and CI uploads it on failure.

**After an interrupted run** (a killed terminal, not Ctrl-C), a database `velexis_e2e_*` may be left over. It is harmless; drop it when no run is active:

```bash
psql "$TEST_DATABASE_ADMIN_URL" -At -c "SELECT datname FROM pg_database WHERE datname LIKE 'velexis\_e2e\_%'"
psql "$TEST_DATABASE_ADMIN_URL" -c 'DROP DATABASE "velexis_e2e_…" WITH (FORCE)'
```

### Settings

Read through [`@velexis/config`](../../packages/config/README.md) from the environment (CI sets them on the job), else from the `.env.local` files, like `pnpm test:int`. Never printed.

| Variable | Default | What for |
|---|---|---|
| `TEST_DATABASE_ADMIN_URL` | (required; root `.env.example`) | `velexis_test_admin`: creates and drops the stack's database ([ADR-0022](../../docs/mvp/adr/0022-shared-test-support-package.md)) |
| `REDIS_URL` | (required) | The Redis server; the stack uses only database `E2E_REDIS_DB` of it |
| `SMTP_URL`, `MAILPIT_API_URL` | (required) | Mailpit: where the apps send e-mail, where the journeys read it |
| `E2E_WITH_OTA` | `false` | `1` also starts the Amadeus stub and the OTA worker (journeys that provision an OTA) |
| `E2E_REDIS_DB` | `15` | The stack's Redis database (1 to 15, never 0, the developer's `pnpm dev`), emptied at start and stop. `useRedis` of `@velexis/testing` gives Vitest worker *n* database 1 + (*n* % 15), so it reaches 15 only with 14 workers or more |
| `E2E_STRIPE` | `false` | `1` defines the `portal-stripe` project and passes the two Stripe values below to the platform backend |
| `STRIPE_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET` | — | With `E2E_STRIPE=1` only, and only test-mode values (`sk_test_…`, `whsec_…`); a live key is refused |

The global setup passes `E2E_DATABASE_NAME` (the stack's database) to the test workers.

## Writing a journey

```ts
import { expectNoSeriousA11yViolations } from "../support/a11y";
import { expect, test } from "../support/fixtures";
import { uniqueEmail, waitForLink } from "../support/mailpit";
import { PORTAL_URL } from "../support/stack";

test("signs up and verifies the e-mail address [PFE-015 AC1]", async ({ page }) => {
  const email = uniqueEmail("signup");
  await page.goto("/sign-up");
  await expectNoSeriousA11yViolations(page);
  // …fill in the form…
  const link = await waitForLink({ to: email, subject: /verify/i, path: "/verify-email", origin: PORTAL_URL });
  await page.goto(link.href);
});
```

- Import `test` and `expect` from `support/fixtures.ts`. Name a test after the behaviour and end it with the criterion it proves (`[PFE-015 AC1]`, [conventions §10](../../docs/mvp/conventions.md#10-testing)).
- **Own data only.** Every journey creates its own accounts (`uniqueEmail`, `buildAccount()`) and reads only its own e-mail: spec files run in parallel, and other runs may share Mailpit. Never empty Mailpit or a table.
- **Accessibility:** call `expectNoSeriousA11yViolations(page)` on every page a journey visits, once the page shows what the journey came for.
- **No sleeping.** Wait for what the page shows (`expect(locator).toBeVisible()`, `page.waitForURL`), for an e-mail (`waitForEmail`), or poll; never a fixed `waitForTimeout`. No `.only`, no `.skip`, no retries, no longer timeouts to get green ([AGENTS.md](../../AGENTS.md) §7).
- **Secrets:** tokens, passwords, MFA secrets and recovery codes stay in variables; never `console.log` them or put them in a test title.

### Helpers

| File | Exports | For |
|---|---|---|
| [`support/fixtures.ts`](support/fixtures.ts) | `test`, `expect`, `PROJECT_TAGS`; fixtures `portalUser` and `admin`; `createVerifiedAccount`, `enableMfa`, `signInWithApi`, `signInToAdminWithApi`, `addSessionCookies`, `newAccountContext`, `uniqueTestIp`, `PlatformApiError` | Signed-in people, arranged through the platform API |
| [`support/mailpit.ts`](support/mailpit.ts) | `waitForEmail`, `waitForLink`, `mailpit()`, `uniqueEmail`, `extractLinks`, `E2E_MAIL_TIMEOUT_MS` | [`@velexis/testing/mailpit`](../../packages/testing/README.md#mailpit-velexistestingmailpit) with a 15 s wait (outbox, worker, SMTP) |
| [`support/totp.ts`](support/totp.ts) | `totpCode`, `secretFromOtpauthUrl`, `Authenticator` | TOTP codes (SHA-1, 6 digits, 30 s) from a secret; `Authenticator#nextCode()` never repeats a time step, because the platform accepts each code once |
| [`support/a11y.ts`](support/a11y.ts) | `expectNoSeriousA11yViolations(page, { exclude })` | axe with the WCAG 2.2 A and AA rules ([ADR-0014](../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md)); fails on `serious` and `critical` violations and names each rule and element |
| [`support/seed.ts`](support/seed.ts) | `runPlatformCli`, `grantPlatformAdmin`, `withDatabase`, `buildAccount`, `newPassword`, `stack()` | Data no screen or public operation creates (PADR-0017 item 5): the platform CLI with the stack's environment (`admin:grant`), a `pg` client on the stack's database as one of the test roles, builders |
| [`support/stack.ts`](support/stack.ts) | `PORTAL_URL`, `PLATFORM_ADMIN_URL`, `PLATFORM_API_URL`, `STACK_PORTS`, `serviceEnv`, … | The stack itself |

**The fixtures.** `portalUser` is a verified account without MFA, signed in to the portal; `admin` is a verified account with MFA that `admin:grant` made a platform admin, signed in to the platform admin. Each gets its own browser context (`{ account, context, page }`, the page on `about:blank`). They do not drive the sign-in pages (the journeys that test those pages do): they call `signUp`, follow the verification link from Mailpit with `verifyEmail`, sign in through `signIn` (and `verifyMfa`), or `adminSignIn` and `adminVerifyMfa`, and put the session into the context as the httpOnly cookies the app itself sets (`__Host-vxp_at` and `__Host-vxp_rt` of the [portal](../../platform/frontend/README.md#6-auth-cookies-and-session), `__Host-vxa_at` and `__Host-vxa_rt` of the [admin](../../platform/admin/README.md)). Chromium keeps `Secure` `__Host-` cookies on `http://127.0.0.1` and sends them to every port of it; the two apps' cookie names differ.

Each account has its own end-user IP from `198.18.0.0/15` (RFC 2544, never routed): the fixtures' API calls send it as `X-Velexis-End-User-IP` with the development `PLATFORM_BFF_KEY` ([PADR-0019](../../platform/docs/adr/0019-end-user-ip-forwarding-from-the-portal-and-admin.md)), and the account's browser context sends it as `X-Forwarded-For`, whose right-most entry the portal and the admin forward. So parallel journeys do not compete for one per-IP rate-limit bucket (5 sign-ups per IP and hour); two accounts draw the same IP once in about 130 000 draws.

The fixtures use operations that later tasks implement: `signUp` and `verifyEmail` (PBE-013), `signIn` (PBE-014), `startMfaSetup`, `enableMfa` and `verifyMfa` (PBE-015), the portal session cookies (PFE-002), `adminSignIn`, `adminVerifyMfa`, `admin:grant` and the admin cookies (PBE-007, PBE-028, PAD-002). Until those are merged, a fixture fails with a `PlatformApiError` that names the operation and its status (`signUp answered 404`); PFE-015 and PAD-010 are the first journeys that use them.

## CI: `.github/workflows/e2e.yml`

| | |
|---|---|
| When | Nightly (02:23 UTC), on demand (Actions > E2E > Run workflow), and on pull requests with the label `e2e` (adding the label starts a run; while it is on, every push runs again) |
| Services | PostgreSQL 16, Redis 7.4 and Mailpit 1.29 containers, as `ci.yml`'s build-test job |
| Steps | Install, restore the Turborepo cache that `ci.yml` saves, bootstrap the roles (`bootstrap.sql`, `velexis_test_admin`), `pnpm dev:keys`, `pnpm build`, `playwright install --with-deps chromium`, then `pnpm test:e2e -- --project=portal --project=platform-admin` with `E2E_WITH_OTA=1` |
| Stripe | The nightly run also runs `--project=portal-stripe` with `E2E_STRIPE=1` when the repository secrets `E2E_STRIPE_SECRET_KEY` and `E2E_STRIPE_BILLING_WEBHOOK_SECRET` exist (test mode). Until PFE-027 adds the first `@stripe` journey, the step passes with no tests (`--pass-with-no-tests`) |
| On failure | `tools/e2e/test-results/` (traces, screenshots, the stack's logs) and `tools/e2e/playwright-report/` as the artefact `e2e-<run id>-<attempt>`, kept 14 days |

Human steps: create the label `e2e` in the repository, and for the nightly Stripe journeys add the two Stripe test secrets (PFE-027).

## Commands

| Command | Does |
|---|---|
| `pnpm test:e2e -- <playwright args>` | The journeys (above) |
| `pnpm --filter @velexis/e2e test` | Unit tests of the harness (`test/`): settings, the apps' environments, ports, built checks, TOTP against RFC 6238, the axe report, `waitForLink`, the fixtures' platform API calls and cookies against a fake API, the builders, the workflow and the `test:e2e` script. Nothing needs to run |
| `pnpm --filter @velexis/e2e typecheck` / `lint` | `tsc --noEmit` of the configuration, support files, specs and unit tests / ESLint |
| `/path/to/actionlint .github/workflows/e2e.yml` | Validates the workflow ([actionlint](https://github.com/rhysd/actionlint) 1.7, with ShellCheck for its `run:` scripts) |

## Tests of PFE-014

| Acceptance criterion | Test |
|---|---|
| AC1: `pnpm test:e2e -- --project=portal --project=platform-admin specs/smoke.e2e.ts` passes locally against the built apps | [`specs/smoke.e2e.ts`](specs/smoke.e2e.ts): `the portal landing page loads with no serious or critical axe violation [PFE-014 AC1]` (project `portal`) and `the platform admin answers 200 on /health/live [PFE-014 AC1]` (project `platform-admin`), each against the stack the global setup starts from the built apps; also with `E2E_WITH_OTA=1` |
| AC2: the workflow file is valid and runs the two projects | `actionlint` 1.7.7 (with ShellCheck 0.9.0 and 0.11.0) reports nothing on `e2e.yml`, and `node tools/ci/check-package-json.mjs` accepts its pins; [`test/workflow.test.ts`](test/workflow.test.ts) checks the triggers, the label condition, the services, the build before the run of `--project=portal --project=platform-admin`, the nightly-only Stripe step and the upload on failure, and that the `test:e2e` script hands `--project=portal --project=platform-admin` to `playwright test` without pnpm's `--` (`[PFE-014 AC2]`); the CI-like run `CI=true E2E_WITH_OTA=1 pnpm test:e2e -- --project=portal --project=platform-admin` passes locally |

The unit tests in [`test/stack.test.ts`](test/stack.test.ts), [`test/totp.test.ts`](test/totp.test.ts), [`test/a11y.test.ts`](test/a11y.test.ts), [`test/mailpit.test.ts`](test/mailpit.test.ts) and [`test/fixtures.test.ts`](test/fixtures.test.ts) cover the helpers. `fixtures.test.ts` pins what the fixtures send to the platform API (paths, bodies, the PADR-0019 headers), the session cookies they set and that a refusal names only the operation, status and code; against the real API the fixtures run for the first time in PFE-015 and PAD-010, once the operations they call exist.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| `The end-to-end stack runs the built apps, and these are not built` | An app has no build output | The command the message names, or `pnpm build` |
| `port 3000 (portal) is in use` | `pnpm dev` or another run | Stop it; one run at a time per machine |
| `Executable doesn't exist at …/chromium_headless_shell-…` | Playwright's browser is not installed (or is of another Playwright version) | `pnpm --filter @velexis/e2e exec playwright install chromium`. Where `cdn.playwright.dev` is blocked, `PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST` can point at a mirror with the same `builds/cft/<version>/linux64/*.zip` layout (Chrome for Testing publishes the same zips) |
| `<process> exited with code 1 before it was ready` | The app failed at start; the message shows the end of its log | Read `test-results/stack/<process>.log`; a `ConfigError` names the variable |
| `ConfigError: TEST_DATABASE_ADMIN_URL …` | No `.env.local` and no environment | `cp .env.example .env.local` (local-development.md §2) |
| `MailpitError … ECONNREFUSED` | Mailpit is not running | `mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025` |

## Dependencies

All `devDependencies`, exact versions ([`tech-stack.md`](../../docs/mvp/tech-stack.md)):

| Package | Version | Why |
|---|---|---|
| `@playwright/test` | 1.64.1 | The runner and Chromium driver (tech-stack: Playwright 1.6x) |
| `@axe-core/playwright` | 4.13.0 | axe in the page (tech-stack: 4.x) |
| `otplib` | 12.0.1 | TOTP codes, the library the platform backend uses (tech-stack: 12.x; upstream marks 12 deprecated in favour of 13) |
| `@velexis/testing`, `@velexis/config`, `@velexis/api-types` | workspace | Mailpit client, builders, test roles and `dropDatabase`; the harness settings; the platform request and response types |
| `pg`, `@types/pg` | 8.23.1 | Creating the stack's database and `withDatabase` (as in `@velexis/db`) |
| `ioredis` | 5.11.1 | Emptying the stack's Redis database (as in the backends) |
| `yaml` | 2.9.1 | Reading `e2e.yml` in its test |
| `vitest`, `typescript`, `eslint`, `@types/node` | 3.2.7, 5.6.3, 9.39.5, 22.20.5 | The unit tests, `typecheck` and `lint` |
