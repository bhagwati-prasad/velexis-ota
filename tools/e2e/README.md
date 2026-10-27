# `@velexis/e2e`: the Playwright end-to-end harness

The end-to-end suite of Velexis ([ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md) "End-to-end", [PADR-0017](../../platform/docs/adr/0017-platform-test-doubles-and-end-to-end-harness.md) item 3): Playwright journeys in `specs/**/*.e2e.ts` that drive the **built** apps in a real browser, against a stack that the harness starts itself on a fresh database, with Mailpit for e-mail, TOTP codes for MFA and axe for accessibility. Task PFE-014 created it with the `portal` and `platform-admin` projects; PFE-015 and PAD-010 add the platform M1 journeys. The OTA plan adds its projects: `storefront` (OFE-008: the OTA API, the storefront previews and the demo OTA in the stack, the [storefront guards](#storefront-journeys) and the M2 search journey) and `ota-admin` (OAD-016).

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
E2E_WITH_OTA=1 pnpm test:e2e -- --project=portal                  # every portal journey, with the Amadeus stub, the OTA worker and API, the previews, the demo OTA
pnpm test:e2e -- --project=portal specs/portal-account-security.e2e.ts   # a journey that needs no OTA
pnpm exec turbo run build --filter=@velexis/ota-backend --filter=@velexis/ota-frontend   # for the storefront
E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront specs/storefront/search.e2e.ts      # the M2 search journey
pnpm --filter @velexis/e2e exec playwright show-trace test-results/<test>/trace.zip   # after a failure
```

The portal journeys that need an active OTA (`portal-signup`, `portal-api-keys`, `portal-team`) provision one on the OTA worker, so they need `E2E_WITH_OTA=1`; without it they fail at once with that message (never skipped). `pnpm test:e2e` is `pnpm --filter @velexis/e2e run test:e2e`: it builds the tooling the harness imports (`@velexis/testing`, `@velexis/reference-data`, `@velexis/amadeus-stub`, a no-op when they are built) and runs `playwright test` with the arguments after `--`. The script drops the `--` that pnpm forwards, because Playwright would take every argument after a `--` for a file filter and so ignore `--project`. It does **not** build the apps: the harness runs what is built, as the VM does, and says which build is missing. With `E2E_WITH_OTA=1` it also needs the OTA backend built with its packages and the storefront's production build: `pnpm exec turbo run build --filter=@velexis/ota-backend --filter=@velexis/ota-frontend` (or `pnpm build`).

One run at a time per machine: the stack listens on the fixed ports below, and the harness refuses to start when one is taken (a `pnpm dev`, another run).

## Projects

| Project | Specs | Base URL | Runs |
|---|---|---|---|
| `portal` | `specs/portal-*.e2e.ts`, `specs/console-*.e2e.ts`, and the tests of `specs/smoke.e2e.ts` not tagged `@platform-admin`; never a test tagged `@stripe` | `http://127.0.0.1:3000` | locally, on labelled pull requests, nightly |
| `platform-admin` | `specs/admin-*.e2e.ts`, and the tests of `specs/smoke.e2e.ts` not tagged `@portal` | `http://127.0.0.1:3001` | the same |
| `portal-stripe` | the tests tagged `@stripe` in `specs/portal-*.e2e.ts` (Stripe Checkout and the Customer Portal in Stripe's test mode, over the network) | `http://127.0.0.1:3000` | nightly only; the project exists only with `E2E_STRIPE=1` ([PADR-0017](../../platform/docs/adr/0017-platform-test-doubles-and-end-to-end-harness.md) item 4) |
| `storefront` | `specs/storefront/**/*.e2e.ts`: the hosted storefront's journeys ([`ota/frontend/README.md`](../../ota/frontend/README.md) §13) | `http://127.0.0.1:4173` (the demo OTA) | locally, on labelled pull requests, nightly; the project exists only with `E2E_WITH_OTA=1`, which starts what it needs ([OADR-0015](../../ota/docs/adr/0015-storefront-build-urls-and-hosting.md) point 11) |

A spec file belongs to a project by its name. `smoke.e2e.ts` is shared, so each of its tests carries the tag of its project (`PROJECT_TAGS` of [`support/fixtures.ts`](support/fixtures.ts)): `test("…", { tag: PROJECT_TAGS.portal }, …)`. A portal journey that needs Stripe over the network carries `PROJECT_TAGS.stripe` and so runs only in `portal-stripe`; no test is ever skipped with `.skip`, the project is simply not selected. A new project (the OTA plan's) adds its entry to `projects` in [`playwright.config.ts`](playwright.config.ts) with its own `testMatch` (for example `specs/storefront/**/*.e2e.ts`) and base URL.

Settings of every project: traces kept and screenshots taken for failed tests only, no video, no retries (a failure is a finding, [AGENTS.md](../../AGENTS.md) §7), `.only` refused when `CI` is set, files in parallel (2 workers in CI) and the tests of one file in order.

## The stack

[`support/stack.ts`](support/stack.ts) is Playwright's global setup. For each run it:

1. reads the harness settings (below), after the `.env.local` files of `tools/e2e` and the repository root;
2. checks that every app (and each seed's CLI) is built and that every port is free, and fails at once with the command to run when not;
3. empties the stack's Redis database (`E2E_REDIS_DB`), creates the database `velexis_e2e_<runId>` as `TEST_DATABASE_ADMIN_URL` the way [`bootstrap.sql`](../../deploy/postgres/bootstrap.sql) creates `velexis` (owner `velexis_migrator`, the database grants, [`schemas.sql`](../../deploy/postgres/schemas.sql)), then runs `pnpm db:migrate` and `pnpm db:seed:reference` against it (about 5 s);
4. starts the built apps with `node` (the Next.js apps from their standalone `server.js`, with `.next/static` copied into the standalone tree as [`pack-release.sh`](../../deploy/scripts/pack-release.sh) does; the storefront with `vite preview` of its `dist/`);
5. waits until each answers `GET /health/ready` with `200` (at most 60 s each); the Amadeus stub has no health route, so its Amadeus-style `404` on that path counts, and a storefront preview is ready when it serves its home page;
6. with `E2E_WITH_OTA=1`, runs the platform's `dev:seed` and then the OTA backend's from their built CLIs (about 2 s): the platform admin `admin@example.com`, the Velexis test Amadeus account (verified against the stub) and its ten test offices, then the demo OTA `tenant_demo` ("Demo Travel", storefront `test`) on `demo.ota.example.com` with an Amadeus test connection, as in development ([`ota/backend/README.md`](../../ota/backend/README.md) §5). What they print on stdout (the admin's password and TOTP set-up URI, two API keys, each shown once) is discarded, never logged; their stderr goes to `test-results/stack/platform-dev-seed.log` and `ota-dev-seed.log`. Both are idempotent, so a journey that runs one again changes nothing.

| Process | Entry point | Port |
|---|---|---|
| Platform API | `platform/backend/dist/main.js` | 3100 |
| Platform worker | `platform/backend/dist/worker.js` | 3101 (health) |
| Portal | `platform/frontend/.next/standalone/platform/frontend/server.js` | 3000 |
| Platform admin | `platform/admin/.next/standalone/platform/admin/server.js` | 3001 |
| Amadeus stub (`E2E_WITH_OTA=1`) | `tools/amadeus-stub/dist/cli.js` | 4900 |
| OTA worker (`E2E_WITH_OTA=1`) | `ota/backend/dist/worker.js` | 4001 (health) |
| OTA API (`E2E_WITH_OTA=1`) | `ota/backend/dist/main.js` | 4000 |
| Storefront, demo OTA (`E2E_WITH_OTA=1`) | `vite preview` of `ota/frontend/dist/` with `STOREFRONT_DEV_HOST=demo.ota.example.com` | 4173 |
| Storefront, suspended OTA (`E2E_WITH_OTA=1`) | the same build with `STOREFRONT_DEV_HOST=suspended.ota.example.com` | 4174 |

Each preview is the one of [`ota/frontend/README.md`](../../ota/frontend/README.md) §11: the production build, the proxy of `/api/*` to the OTA API with the edge headers Caddy adds (`X-Velexis-Edge` with the development `VELEXIS_EDGE_SECRET`, `X-Velexis-Host` and `Origin` of its host), and the Caddyfile's headers, the CSP among them. The second one serves the host of the OTA `suspended`, which only the journey that needs a suspended OTA creates (`withSuspendedTenant` of [`support/ota.ts`](support/ota.ts)), so that no other journey ever sees the demo OTA suspended.

The teardown, also after Ctrl-C, stops every process (SIGTERM, SIGKILL after 10 s), drops the database and empties the Redis database. If the stack cannot start, it cleans up the same way and the run fails with the reason and the last lines of the process's output. A whole start takes 6 to 10 s locally, and about 30 s with `E2E_WITH_OTA=1` (nine processes and the two seeds).

**Environment of the apps.** Each process gets the values of the root `.env.example` and then of its own `.env.example` (the precedence of the `.env.local` files in development), and on top:

- `APP_ENV=test`, `LOG_LEVEL=info`, the stack's `REDIS_URL`, the harness's `SMTP_URL` and `MAILPIT_API_URL`;
- the stack database's DSN of the process's own role: `velexis_platform_app` for the platform API, worker and CLI, `velexis_ota_app` for the OTA API and worker, and `velexis_provisioner` (`DATABASE_PROVISIONER_URL`) for the OTA worker ([ADR-0004](../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md)). The Next.js apps, the stub and the previews get no DSN, and no process gets `DATABASE_MIGRATOR_URL` or `TEST_DATABASE_ADMIN_URL`, even when the developer's shell exports them. The one exception is the OTA backend's `dev:seed`, a development command and no app: it gets the stack database's `velexis_migrator` DSN, as its development-only platform writes need, besides those of `velexis_ota_app` and `velexis_provisioner`;
- the ports above, and every public and internal URL on `127.0.0.1` (`PUBLIC_PORTAL_URL=http://127.0.0.1:3000`, `PUBLIC_PLATFORM_ADMIN_URL=http://127.0.0.1:3001`, `PLATFORM_API_URL`, `OTA_API_URL`, `AMADEUS_BASE_URL_TEST` and `_LIVE` on the stub, …), and `STOREFRONT_BASE_DOMAIN=ota.example.com`, so the OTA API, the seed and the previews agree on the storefront hosts. The browser reaches the apps on `127.0.0.1`, so links in e-mails and redirects must name that host: cookies of `localhost` are not sent to `127.0.0.1`;
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
| `E2E_WITH_OTA` | `false` | `1` also starts the Amadeus stub, the OTA worker and API and the two storefront previews, seeds the demo OTA, and defines the `storefront` project (journeys that provision an OTA, and the storefront's) |
| `E2E_REDIS_DB` | `15` | The stack's Redis database (1 to 15, never 0, the developer's `pnpm dev`), emptied at start and stop. `useRedis` of `@velexis/testing` gives Vitest worker *n* database 1 + (*n* % 15), so it reaches 15 only with 14 workers or more |
| `E2E_STRIPE` | `false` | `1` defines the `portal-stripe` project and passes the two Stripe values below to the platform backend |
| `STRIPE_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET` | — | With `E2E_STRIPE=1` only, and only test-mode values (`sk_test_…`, `whsec_…`); a live key is refused |
| `E2E_CHROMIUM_EXECUTABLE` | — | A Chromium binary to launch instead of the revision the pinned Playwright installs, on a machine whose image holds another revision and cannot run `playwright install` (for example `/opt/pw-browsers/chromium`). CI leaves it unset |

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
- **Accessibility:** call `expectNoSeriousA11yViolations(page)` on every page a journey visits, once the page shows what the journey came for. Wait for the page's title first (`await expect(page).toHaveTitle("Sign in · Velexis")`): Next.js 15 streams a page's metadata after its content, so right after a client-side navigation a page can be on screen a moment before its `<title>`, and axe would report `document-title`. The PFE-015 specs wrap both in `expectAccessible(page, title)`.
- **One journey, one file.** A journey whose steps build on each other is a file of tests in order (`test.describe.configure({ mode: "serial" })`, one browser context made in `beforeAll`): each step keeps Playwright's default 30-second budget, and a failed step stops the steps after it. One-time arrangements in `beforeAll` (an active OTA: about 2 s locally, PF-11 allows a minute) set their own budget there with `test.setTimeout`, commented; a test's own budget is never raised.
- **Middleware redirects name `localhost`.** Next.js writes the loopback host of a redirect made in `middleware.ts` (a signed-out visitor sent to `/sign-in?next=…`) as `localhost` (its `NextURL` turns `127.0.0.1` into `localhost`), and the browser's cookies of `127.0.0.1` are not sent there. Compare only the path and query of such a redirect (`page.waitForURL((url) => url.pathname + url.search === "/sign-in?next=%2Fdashboard")`) and come back to the stack's host before signing in. Redirects of route handlers and server actions keep `127.0.0.1`; on the VM the portal's domain is kept.
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
| [`support/stack.ts`](support/stack.ts) | `PORTAL_URL`, `PLATFORM_ADMIN_URL`, `PLATFORM_API_URL`, `OTA_API_URL`, `STOREFRONT_URL`, `SUSPENDED_STOREFRONT_URL`, `DEMO_STOREFRONT_HOST`, `STACK_PORTS`, `serviceEnv`, `seedCommands`, … | The stack itself |
| [`support/storefront-guards.ts`](support/storefront-guards.ts) | `test`, `expect` with the automatic `guards` fixture (`StorefrontGuards`: `checkA11y(page)`, `problems`, `verify()`, `forget()`); `isThirdPartyRequest`, `unexpectedCookieNames`, `CSRF_COOKIE` | The guards of every storefront journey ([below](#storefront-journeys)) |
| [`support/ota.ts`](support/ota.ts) | `searchIdOf`, `expireSearch`, `withSuspendedTenant`, `withTenantTx`, `publishTenantInvalidation`, `customerScopeLeaks` | OTA data no page creates: a search of the demo OTA moved past its expiry (`tenantTx` of `@velexis/db` as `velexis_ota_app`, never schema-qualified SQL), the suspended OTA of the second preview (its platform row as `velexis_migrator`, then the platform's `tenant` invalidation); the check that the storefront gets selling prices only, with the rules of the OTA backend's own walk (OBE-026): no `net*`, `markup*`, `margin*`, `diagnostics` or `supplier*` key, no `dictionaries.amadeus`, and every embedded Amadeus offer at the selling total (OF-02 AC1) |

**The fixtures.** `portalUser` is a verified account without MFA, signed in to the portal; `admin` is a verified account with MFA that `admin:grant` made a platform admin, signed in to the platform admin. Each gets its own browser context (`{ account, context, page }`, the page on `about:blank`). They do not drive the sign-in pages (the journeys that test those pages do): they call `signUp`, follow the verification link from Mailpit with `verifyEmail`, sign in through `signIn` (and `verifyMfa`), or `adminSignIn` and `adminVerifyMfa`, and put the session into the context as the httpOnly cookies the app itself sets (`__Host-vxp_at` and `__Host-vxp_rt` of the [portal](../../platform/frontend/README.md#6-auth-cookies-and-session), `__Host-vxa_at` and `__Host-vxa_rt` of the [admin](../../platform/admin/README.md)). Chromium keeps `Secure` `__Host-` cookies on `http://127.0.0.1` and sends them to every port of it; the two apps' cookie names differ.

Each account has its own end-user IP from `198.18.0.0/15` (RFC 2544, never routed): the fixtures' API calls send it as `X-Velexis-End-User-IP` with the development `PLATFORM_BFF_KEY` ([PADR-0019](../../platform/docs/adr/0019-end-user-ip-forwarding-from-the-portal-and-admin.md)), and the account's browser context sends it as `X-Forwarded-For`, whose right-most entry the portal and the admin forward. So parallel journeys do not compete for one per-IP rate-limit bucket (5 sign-ups per IP and hour); two accounts draw the same IP once in about 130 000 draws.

The fixtures use operations that later tasks implement: `signUp` and `verifyEmail` (PBE-013), `signIn` (PBE-014), `startMfaSetup`, `enableMfa` and `verifyMfa` (PBE-015), the portal session cookies (PFE-002), `adminSignIn`, `adminVerifyMfa`, `admin:grant` and the admin cookies (PBE-007, PBE-028, PAD-002). Until those are merged, a fixture fails with a `PlatformApiError` that names the operation and its status (`signUp answered 404`); PFE-015 and PAD-010 are the first journeys that use them.

### Storefront journeys

Specs in `specs/storefront/` run in the `storefront` project against the demo OTA (base URL `STOREFRONT_URL`, `E2E_WITH_OTA=1`). They import `test` and `expect` from [`support/storefront-guards.ts`](support/storefront-guards.ts), whose automatic `guards` fixture watches every test's browser context from before its first navigation and fails the test at its end on ([`ota/frontend/README.md`](../../ota/frontend/README.md) §13, "Assertions in every journey"):

| Guard | How |
|---|---|
| A `securitypolicyviolation` | A listener that a script added to every document (all frames) before its own scripts registers; the preview sends the Caddyfile's CSP and the build has no inline script or style ([OADR-0015](../../ota/docs/adr/0015-storefront-build-urls-and-hosting.md) points 2 and 11) |
| A request to a third-party host | Every request of the context: only the storefront's origins (`STOREFRONT_URL`, `SUSPENDED_STOREFRONT_URL`), and Stripe's hosts (`*.stripe.com`, `*.stripe.network`, `*.stripecdn.com`, over https) only on `/checkout/pay-card.html` and the frames inside it ([OADR-0017](../../ota/docs/adr/0017-airline-card-form-isolation.md): none at all on the airline-card page) |
| A cookie JavaScript can read other than `__Host-vx_csrf` | The names of `document.cookie` of every top-level storefront document when it has loaded and when it is left, and every cookie of the context that is not httpOnly at the end ([OADR-0006](../../ota/docs/adr/0006-storefront-cookie-sessions-and-csrf.md)). Values never leave the page |
| A serious or critical axe violation | `guards.checkA11y(page)` on every page a journey visits, and on the page each test ends on |

```ts
import { expect, test } from "../../support/storefront-guards";

test("shows the results [OFE-0xx AC1]", async ({ page, guards }) => {
  await page.goto("/search.html?trip=oneway&from=MAD&to=PAR&depart=…");
  await expect(page.getByRole("heading", { level: 2, name: "5 flights" })).toBeVisible();
  await guards.checkA11y(page);
});
```

- **The demo OTA** is shared by every storefront journey: it stays `active`, and a journey changes only its own data (its own searches, checkouts, customers). A journey that needs a suspended OTA uses `withSuspendedTenant` and the second preview (`SUSPENDED_STOREFRONT_URL`), never the demo OTA.
- **The Amadeus stub** answers every search with the five offers of its fixture (Madrid to Paris), the destination `ZZZ` with none, and every upsell with the fare families BASIC, CLASSIC and FLEXIBLE ([`tools/amadeus-stub/README.md`](../amadeus-stub/README.md)). Dates are computed from today (a departure 40 days ahead), never fixed.
- **Searches are shared for 30 s.** The API answers an identical search (same criteria, channel and customer) within 30 s with the search already running or just made (single flight, [OADR-0002](../../ota/docs/adr/0002-offer-and-priced-offer-caching.md) point 2), so two guest journeys of the same trip can get the same `srch_` id. A journey that changes its search (`expireSearch`) therefore searches a departure date of its own (the expired-search test: 61 days ahead).
- **Provoking a guard on purpose** (the guard tests of `search.e2e.ts`): read `guards.problems`, expect `guards.verify()` to throw, then `guards.forget()`, so the test's own end is clean. A page served with an inline script uses `page.route` with `route.fetch()`, so it keeps the preview's production headers; Stripe.js comes from a `page.route` answer, never from the network.

## CI: `.github/workflows/e2e.yml`

| | |
|---|---|
| When | Nightly (02:23 UTC), on demand (Actions > E2E > Run workflow), and on pull requests with the label `e2e` (adding the label starts a run; while it is on, every push runs again) |
| Services | PostgreSQL 16, Redis 7.4 and Mailpit 1.29 containers, as `ci.yml`'s build-test job |
| Steps | Install, restore the Turborepo cache that `ci.yml` saves, bootstrap the roles (`bootstrap.sql`, `velexis_test_admin`), `pnpm dev:keys`, `pnpm build`, `playwright install --with-deps chromium`, then `pnpm test:e2e -- --project=portal --project=platform-admin --project=storefront` with `E2E_WITH_OTA=1`: one stack for the three projects (OFE-008 added `storefront`) |
| Stripe | The nightly run also runs `--project=portal-stripe` with `E2E_STRIPE=1` when the repository secrets `E2E_STRIPE_SECRET_KEY` and `E2E_STRIPE_BILLING_WEBHOOK_SECRET` exist (test mode). Until PFE-027 adds the first `@stripe` journey, the step passes with no tests (`--pass-with-no-tests`) |
| On failure | `tools/e2e/test-results/` (traces, screenshots, the stack's logs) and `tools/e2e/playwright-report/` as the artefact `e2e-<run id>-<attempt>`, kept 14 days |

Human steps: create the label `e2e` in the repository, and for the nightly Stripe journeys add the two Stripe test secrets (PFE-027).

## Commands

| Command | Does |
|---|---|
| `pnpm test:e2e -- <playwright args>` | The journeys (above) |
| `pnpm --filter @velexis/e2e test` | Unit tests of the harness (`test/`): settings, the apps' environments, ports, built checks, the seeds' discarded stdout, TOTP against RFC 6238, the axe report, `waitForLink`, the fixtures' platform API calls and cookies against a fake API, the builders, the storefront guards (third-party hosts, cookie names, the document script, the end-of-test check) and the OTA helpers, the workflow and the `test:e2e` script. Nothing needs to run |
| `pnpm --filter @velexis/e2e typecheck` / `lint` | `tsc --noEmit` of the configuration, support files, specs and unit tests / ESLint |
| `/path/to/actionlint .github/workflows/e2e.yml` | Validates the workflow ([actionlint](https://github.com/rhysd/actionlint) 1.7, with ShellCheck for its `run:` scripts) |

## Tests of PFE-014

| Acceptance criterion | Test |
|---|---|
| AC1: `pnpm test:e2e -- --project=portal --project=platform-admin specs/smoke.e2e.ts` passes locally against the built apps | [`specs/smoke.e2e.ts`](specs/smoke.e2e.ts): `the portal landing page loads with no serious or critical axe violation [PFE-014 AC1]` (project `portal`) and `the platform admin answers 200 on /health/live [PFE-014 AC1]` (project `platform-admin`), each against the stack the global setup starts from the built apps; also with `E2E_WITH_OTA=1` |
| AC2: the workflow file is valid and runs the two projects | `actionlint` 1.7.7 (with ShellCheck 0.9.0 and 0.11.0) reports nothing on `e2e.yml`, and `node tools/ci/check-package-json.mjs` accepts its pins; [`test/workflow.test.ts`](test/workflow.test.ts) checks the triggers, the label condition, the services, the build before the run of `--project=portal --project=platform-admin`, the nightly-only Stripe step and the upload on failure, and that the `test:e2e` script hands `--project=portal --project=platform-admin` to `playwright test` without pnpm's `--` (`[PFE-014 AC2]`); the CI-like run `CI=true E2E_WITH_OTA=1 pnpm test:e2e -- --project=portal --project=platform-admin` passes locally |

The unit tests in [`test/stack.test.ts`](test/stack.test.ts), [`test/totp.test.ts`](test/totp.test.ts), [`test/a11y.test.ts`](test/a11y.test.ts), [`test/mailpit.test.ts`](test/mailpit.test.ts) and [`test/fixtures.test.ts`](test/fixtures.test.ts) cover the helpers. `fixtures.test.ts` pins what the fixtures send to the platform API (paths, bodies, the PADR-0019 headers), the session cookies they set and that a refusal names only the operation, status and code; against the real API the fixtures run for the first time in PFE-015 and PAD-010, once the operations they call exist.

## Tests of OFE-008

| Acceptance criterion | Test |
|---|---|
| AC1: the journey passes locally and in the nightly workflow against the production build [OF-02 AC1] | [`specs/storefront/search.e2e.ts`](specs/storefront/search.e2e.ts), project `storefront`, against `vite preview` of the built storefront proxied to the built OTA API and the Amadeus stub: `searches, filters and sorts the results, opens an offer, chooses a branded fare and prices it [OFE-008 AC1] [OF-02 AC1]` (home → search → direct flights only → cheapest first → offer → FLEXIBLE → price, axe on every page, and no console-scope value in the search, offer and priced-offer answers: `customerScopeLeaks`, the rules of OBE-026's walk), `destination ZZZ shows No flights found`, `an expired search shows Prices have expired` (a search of a departure date of its own whose `expires_at` `expireSearch` moved into the past, opened from a bookmark) and `a suspended OTA shows temporarily unavailable` (`withSuspendedTenant`, the second preview); passes locally with `E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront specs/storefront/search.e2e.ts`, and in the CI-like run `CI=true E2E_WITH_OTA=1 pnpm test:e2e -- --project=portal --project=platform-admin --project=storefront`. The workflow runs the project next to the platform's ([`test/workflow.test.ts`](test/workflow.test.ts): `runs the storefront project in the same run, against the stack with the OTA backend [OFE-008 AC1]`); the nightly run itself is proven on GitHub. [`test/stack.test.ts`](test/stack.test.ts) and [`test/ota.test.ts`](test/ota.test.ts) pin the stack's OTA processes, their environments, the seeds (their stdout discarded) and the helpers |
| AC2: every guard of step 3 is active and a deliberately inline script in a test page makes the run fail | `search.e2e.ts`, "the storefront guards": `an inline script in a page is a CSP violation that fails the test` (the home page served by the preview with an inline script added: the browser refuses it, the guard records `script-src-elem` refused `inline`, `verify()` throws), `the inline script fails the test through the guards alone` (`test.fail()`: the guards' end-of-test check alone fails it, else the run fails), `a third-party script is refused off the card page and allowed on it`, `a cookie that JavaScript can read, other than the CSRF token, fails the test` and `a serious accessibility violation fails the axe guard`; [`test/storefront-guards.test.ts`](test/storefront-guards.test.ts) covers the rules, the document script and the end-of-test check without a browser |

## Tests of PFE-015

The portal's M1 journeys, each a file of steps in order. Every page they visit passes `expectNoSeriousA11yViolations` after its title is in place; the journeys found two portal defects, fixed with them: the description of a destructive alert had a contrast of 4.49:1 (`text-destructive/90`, now `text-destructive`, `components/ui/alert.tsx`), and a table wider than its column (the sessions table) scrolled without keyboard access (`components/ui/table.tsx`: its scroll container takes the focus, with a focus ring).

| Spec | Steps | Features |
|---|---|---|
| [`specs/portal-signup.e2e.ts`](specs/portal-signup.e2e.ts) (`E2E_WITH_OTA=1`) | Sign up in the browser (a short password is refused first); a second sign-up with the address reads the same and sends "You already have a Velexis account"; the verification link from Mailpit verifies once (`/sign-in?verified=1`, then `/verify-pending?error=token`); sign in (httpOnly `Secure` session cookies); turn on MFA with the base32 secret read from the page (QR code shown, ten recovery codes shown once, gone after a reload); sign out (the signed-in area sends to sign-in); sign in with a TOTP code; create an OTA in the wizard (live key check, early access plan, review); the set-up page shows it active (it polls on its own; the step waits at most 25 s); reveal the two test keys once (gone after a reload, with the explanation); the onboarding checklist with its states; the welcome e-mail | PF-01 AC1, AC2; PF-02 AC1; PF-03 AC1; PF-04 AC1, AC2; PF-10 AC1–AC3; PF-11 AC1, AC3; PF-12; PFE-005 AC3 |
| [`specs/portal-account-security.e2e.ts`](specs/portal-account-security.e2e.ts) | "Forgot your password?" sends the reset link (an address without an account gets the same confirmation, word for word); the link from Mailpit opens the form (token moved into its cookie), the new password is saved, the link works once; the old password is refused; sign in with the new one; the profile is saved with `If-Match`, and a save from a second tab on the old version is refused with the reload message; two other browsers sign in, the security page lists three sessions (this browser marked, without "Revoke") and revokes one, which then cannot renew its session; "Sign out everywhere" signs out this browser and the other one (once its 15-minute access token is gone, its refresh is refused and its cookies deleted) | PF-03 AC2; PF-05 AC1; PF-06 AC1, AC2; PF-07 AC1 |
| [`specs/portal-api-keys.e2e.ts`](specs/portal-api-keys.e2e.ts) (`E2E_WITH_OTA=1`) | An owner's active OTA (arranged in `beforeAll` through the wizard); create a secret test key scoped Storefront, shown once with the warning and its `prefix…last4`; after a reload the key is in no field and nowhere in the markup, only its `prefix…last4` and "Never" used; revoke it after the confirmation: listed as revoked, without actions, also after a reload | PF-30 AC1, AC2, AC5 |
| [`specs/portal-team.e2e.ts`](specs/portal-team.e2e.ts) (`E2E_WITH_OTA=1`) | An owner's active OTA; the owner invites an address as agent (pending invitation listed); the owner, signed in with another address, opens the link and is told the address it was sent to, with no "Accept"; the invited person, in a second browser context, opens the link from Mailpit ("Join …", the token moved into its cookie), creates an account from it with the address prefilled, verifies it, signs in, opens the link again and accepts (lands on the OTA as agent); the owner makes them finance (their dashboard follows); the owner removes them (confirmation), after which the OTA answers `404` for them and their dashboard lists no OTA | PF-20 AC1, AC3; PF-21 AC1 |

| Acceptance criterion | Proof |
|---|---|
| AC1: the four specs pass locally and in the `e2e` workflow, covering PF-01 to PF-07, PF-10, PF-11, PF-20, PF-21 and PF-30 from the browser | `E2E_WITH_OTA=1 pnpm test:e2e -- --project=portal` (the four specs and the smoke test) and the CI-like `CI=true E2E_WITH_OTA=1 pnpm test:e2e -- --project=portal --project=platform-admin` pass locally against the built apps; the `e2e` workflow runs the same projects with `E2E_WITH_OTA=1` |
| AC2: no serious or critical accessibility violation on the visited pages | `expectAccessible` on every page each step visits, the dialogs included |

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| `The end-to-end stack runs the built apps, and these are not built` | An app has no build output | The command the message names, or `pnpm build` |
| `port 3000 (portal) is in use` | `pnpm dev` or another run | Stop it; one run at a time per machine |
| `Executable doesn't exist at …/chromium_headless_shell-…` | Playwright's browser is not installed (or is of another Playwright version) | `pnpm --filter @velexis/e2e exec playwright install chromium`. Where `cdn.playwright.dev` is blocked, `PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST` can point at a mirror with the same `builds/cft/<version>/linux64/*.zip` layout (Chrome for Testing publishes the same zips) |
| `<process> exited with code 1 before it was ready` | The app failed at start; the message shows the end of its log | Read `test-results/stack/<process>.log`; a `ConfigError` names the variable |
| `ConfigError: TEST_DATABASE_ADMIN_URL …` | No `.env.local` and no environment | `cp .env.example .env.local` (local-development.md §2) |
| `MailpitError … ECONNREFUSED` | Mailpit is not running | `mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025` |
| `Project(s) "storefront" not found` | The project exists only with `E2E_WITH_OTA=1` | `E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront` |
| `port 4173 (storefront) is in use` | `pnpm --filter @velexis/ota-frontend preview`, or another run | Stop it; one run at a time per machine |
| `node ota/backend/dist/cli.js dev:seed exited with code 1` | The demo OTA could not be seeded; the message shows `test-results/stack/ota-dev-seed.log` (stderr only: the seeds' stdout, with the keys, is never kept) | Usually a missing `pnpm dev:keys` (the pepper file) or a build of the OTA backend older than its migrations |

## Dependencies

All `devDependencies`, exact versions ([`tech-stack.md`](../../docs/mvp/tech-stack.md)):

| Package | Version | Why |
|---|---|---|
| `@playwright/test` | 1.64.1 | The runner and Chromium driver (tech-stack: Playwright 1.6x) |
| `@axe-core/playwright` | 4.13.0 | axe in the page (tech-stack: 4.x) |
| `otplib` | 12.0.1 | TOTP codes, the library the platform backend uses (tech-stack: 12.x; upstream marks 12 deprecated in favour of 13) |
| `@velexis/testing`, `@velexis/config`, `@velexis/api-types`, `@velexis/db` | workspace | Mailpit client, builders, test roles and `dropDatabase`; the harness settings; the platform request and response types and the invalidation channel; `tenantTx` for the demo OTA's data (OFE-008) |
| `pg`, `@types/pg` | 8.23.1 | Creating the stack's database and `withDatabase` (as in `@velexis/db`) |
| `ioredis` | 5.11.1 | Emptying the stack's Redis database (as in the backends) |
| `yaml` | 2.9.1 | Reading `e2e.yml` in its test |
| `vitest`, `typescript`, `eslint`, `@types/node` | 3.2.7, 5.6.3, 9.39.5, 22.20.5 | The unit tests, `typecheck` and `lint` |
