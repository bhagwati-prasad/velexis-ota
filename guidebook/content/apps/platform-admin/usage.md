---
id: usage
title: Platform admin — usage guide
summary: How to run the Velexis staff console, every screen and action (with the reason and step-up rules), what each one should change in PostgreSQL, Redis, BullMQ and Mailpit, and what to test when hunting bugs.
---

## What it is

The [[platform-admin-console]] (`repo:platform/admin`, package `@velexis/platform-admin`) is the staff console of
Velexis at `admin.platform.example.com`. Velexis staff with a [[platform-admin-account]] use it to run the fleet:
OTAs ([[tenant]]s) and their [[suspension]], [[provisioning-job]]s and queues, [[plan]]s and Stripe prices,
[[subscription]]s, invoices and the [[stripe-event-inbox]], the [[velexis-amadeus-account]] and its [[office-pool]],
[[settlement]]s and [[payout-account]]s, [[custom-domain]]s, account support, platform admins and the [[audit-log]].

It is a [[bff]]: the browser talks only to the Next.js server on `127.0.0.1:3001`, which calls the platform API's
`/v1/admin/**` operations from server code with the admin's token (kept in HttpOnly cookies) and the [[bff-key]]. The
console stores nothing itself: every change is an API call, and the API writes exactly one `platform_audit_log` row
per change, with your account, IP, browser and the reason you typed.

```diagram
neighbours
```

Three rules shape every screen:

| Rule | What you see | Where it comes from |
|---|---|---|
| [[reason-action]] | A dialog with a **Reason** field (5-500 characters after trimming); nothing is sent without it | `x-reason-required` in the OpenAPI document |
| [[step-up]] | 'Confirm with your authenticator app' when your last TOTP is older than 15 minutes; the action then runs again with the same reason | `x-mfa-step-up` (`401 REAUTH_REQUIRED`) |
| [[if-match]] | 'reload the page' when someone else changed the row since you opened it (`412`) | versioned rows (tenants, plans, subscriptions, offices, accounts, settlements, payout accounts) |

The M5 areas (Invoices, Stripe events, Settlements, Domains) only appear in the navigation while their
[[feature-switch]] is on in the platform API (`adminGetMe.features`).

## Before you start

You need the platform API and its worker running (see [[app:platform-api]]), with PostgreSQL 16, Redis 7 and Mailpit.
Suspend, resume, migrate and OTA set-up also need the OTA worker ([[app:ota-api]]). The full walk-through:

```diagram
flow-local-setup
```

```try
command: pnpm --filter @velexis/platform-backend dev:seed
command: pnpm --filter @velexis/platform-backend dev
command: pnpm --filter @velexis/platform-admin dev
url: http://localhost:3001/sign-in
login: admin@example.com
password: printed once by dev:seed (development only)
expect: Password step, then a 6-digit code from the otpauth:// URI dev:seed printed, then the Dashboard with a 'Development' badge
```

| What | Where it comes from | Notes (development only) |
|---|---|---|
| Admin `admin@example.com` | [[dev-seed]] (`repo:platform/backend/src/dev/dev-seed.command.ts`) | Random password and TOTP URI printed **once**; lost → `node dist/cli.js admin:reset-mfa admin@example.com` and the portal's "Forgot password" |
| More admins | [[admin-grant-command]] `node dist/cli.js admin:grant <email>` or **Grant admin rights** on `/admins` | The account must be verified, active and have MFA on (enable it in the portal at `/account/security`) |
| Velexis test Amadeus account and offices `DEV1A0001`…`DEV1A0040` | `dev:seed` | Verified against the stub (`pnpm stub:amadeus`, `http://127.0.0.1:4900`) |
| OTAs | Sign up in the [[app:portal]] and create one, or `tenants:create-demo` | Needs the OTA worker to become `active` |
| E-mails | Mailpit | `http://127.0.0.1:8025` |
| Database | `.env.example` | `psql postgres://velexis_platform_app:dev_platform@127.0.0.1:5432/velexis` |
| Redis | `.env.example` | `redis-cli -a dev_redis` |

```warning
Browse **http://localhost:3001**, the origin of `PUBLIC_PLATFORM_ADMIN_URL` in the root `.env.example`. On
`http://127.0.0.1:3001` the middleware's redirects go to `localhost` (cookies set on the other host are lost) and
**Sign out** answers `403 Forbidden` because the `Origin` header is not the admin's.
```

```note
With every `FEATURE_*` switch `false` (the default in `platform/backend/.env.example`), the nav hides Invoices, Stripe
events, Settlements and Domains, and the dashboard has no "To review" section. The pages still exist: opening
`/settlements` by URL shows "This feature is not switched on yet." Turn a switch on in `platform/backend/.env.local`
and restart the platform API and worker to test that area.
```

## Tour

Every route, in the order of the navigation (`repo:platform/admin/src/components/admin-shell.tsx`). Lists keep their
filters and the page cursor in the URL, so every list is a shareable link; a repeated or invalid parameter shows a
notice with a link to the unfiltered list and calls nothing.

### Sign-in and the shell

| Route | What it shows | Try | Should happen |
|---|---|---|---|
| `/sign-in` | E-mail address, Password, **Continue**; links to the portal's "Forgot password" and the password rule | A portal user without admin rights; wrong password 5 times ([[account-lockout]]); an admin without MFA | Same message for non-admin and wrong password; 5th failure "locked" with the wait from `Retry-After`; `MFA_REQUIRED` explains and links `PUBLIC_PORTAL_URL/account/security` |
| `/sign-in/mfa` | Authentication code, **Verify and sign in**, **Use a recovery code instead** | An old code; the same code twice; wait 5 minutes | "The code is not correct." at the field; after 5 minutes back to `/sign-in?mfa=expired` |
| Shell (every page) | Nav in six groups, your name and e-mail, environment badge (Production in red), **Sign out** | Revoke your rights from another admin's session | The next page goes to plain `/sign-in` (no `next`, cookies kept until the next sign-in); any other `adminGetMe` failure shows "The admin console could not be loaded" with a Sign out button |

```diagram
flow-sign-in
```

### Dashboard `/`

| Block | Shows | Links to |
|---|---|---|
| OTAs by status | Count per [[tenant]] status | `/tenants?status=<status>` |
| Failed provisioning | Tenant jobs failed in the last 24 h | `/provisioning-jobs?status=failed` (every failed job: that list has no time filter, so it can show more) |
| Failed jobs per queue | Failed BullMQ jobs of each [[platform-queue]] | `/queues/<queue>` |
| Amadeus office pool | Available / assigned per environment; warning below 3 available | `/amadeus/offices?environment=…&status=…`; "Set up the Amadeus accounts" without an account |
| Live office requests | OTAs waiting for a live office, oldest first, at most 50 ([[live-office-request]]); at 50 rows "The 50 oldest requests are shown…" appears, also when there are exactly 50 | **Assign office** → `/tenants/<id>?tab=connections#connection-<id>` |
| To review (M5) | Pending custom domains, draft settlements, failed Stripe events, past-due subscriptions (only switched-on counters) | The filtered list of each |

Try stopping Redis: the dashboard should show "The dashboard could not be loaded" (`503 SERVICE_UNAVAILABLE`), not
zeros. See [[admin-dashboard]].

### OTAs

| Route | What it shows | Try | Should happen |
|---|---|---|---|
| `/tenants` | Search ([[tenant-key]], name, or an owner's whole e-mail), Status, Plan; columns OTA, Status, Plan, Owner e-mail ("No active owner"), Created, Set up | Search an owner's e-mail; a retired plan in the filter; `?status=bogus` | URL keeps `q`; retired plans marked "(retired)"; invalid filter → notice, no call |
| `/tenants/[tenantId]` | Header + **Suspend** / **Resume** / **Migrate**; seven tabs in `?tab=`: Overview, Members and invitations, Subscription and invoices, Connections, Domains, Provisioning jobs, Audit | Switch tabs, reload; `/tenants/ten_garbage` | Tab survives reload without a new API call per switch; an invalid id renders not-found without calling the API |

Tenant actions (`repo:platform/admin/src/app/(app)/tenants/[tenantId]/actions.ts`):

| Action | Where | Rules | Effect to check |
|---|---|---|---|
| **Suspend** → **Suspend OTA** | header, active OTA only | Kind (abuse, request, admin) + reason | `tenants.status = 'suspended'`, `suspension_reason`, `suspend` job, `tenant.suspended` audit, owner e-mail "<name> has been suspended" |
| **Resume** → **Resume OTA** | header, suspended OTA only | Reason; a `billing` suspension needs a trialing/active subscription | `active`, `resume` job, e-mail "<name> is active again" |
| **Migrate** → **Start migration** | header | Optional **Target version** (empty = latest) | A `migrate` job; `409` if one is active or no schema yet ([[tenant-migration]]) |
| **Edit notes and legal name** → **Save** | Overview | If-Match; empty field clears | `tenants.metadata.notes`, `legal_name`; stale → reload link |
| **Disable connection** / **Enable connection** | Connections, each Amadeus ([[supplier-connection]]) and payment card | Reason | `supplier_connections.status` or `payment_provider_connections.status`; `409 no_office` when its office was released |
| **Assign office** | Connections, a `velexis` card waiting for an office | Pick one of up to 200 available offices | Connection `active`; owners e-mailed for live |
| Payout account (**Reveal bank details**, **Verify**, **Reject**) | Connections | Reveal: reason + step-up; review: If-Match | See [[payout-account-reveal]] and `flow-payout-account` below |

```diagram
flow-suspend-resume
```

### Provisioning jobs and queues

| Route | What it shows | Try | Should happen |
|---|---|---|---|
| `/provisioning-jobs` | Status and Kind filters (`tenantId` kept when you come from a tenant's jobs tab); OTA, kind, status, step, attempts, last error, times | "All jobs of this OTA" from a tenant | "Only the jobs of one OTA are shown." and a link to every OTA |
| `/provisioning-jobs/[jobId]` | OTA, kind, status, step, attempts, last error, scheduled/started/finished, lease (`lockedUntil`, running only), BullMQ state and job `<jobId>-<attempt>` on [[ota-tenant-ops]], step log, input/result JSON | **Retry** on failed; **Cancel job** (reason) on queued; reload a running job | Retry answers a **new** job; cancel → `canceled`; running/succeeded/canceled offer nothing |
| `/queues` | Two tables, Platform queues and OTA queues: waiting, active, delayed, failed, oldest waiting in words | Stop Redis | "the queues cannot be read right now" |
| `/queues/[queue]` | 50 most recent failures: id, name, reason, attempts, failed at, id-only data; an `ota-tenant-ops` attempt links its provisioning job | **Retry** on a `platform-*` queue; open an `ota-*` queue | Platform: job back to waiting, audit `queue_job.retried`; OTA: "OTA queue, view only", no Retry column ([[ota-queue]]) |

```diagram
flow-jobs-and-queues
```

### Plans and billing

| Route | What it shows | Try | Should happen |
|---|---|---|---|
| `/plans` | Every plan: Active/Retired, "On the pricing page" / "Not public" / "Retired, not offered", prices (Money), trial, limits, OTAs (link `/tenants?planCode=`), Stripe link state and warning count; **New plan** | Create with a taken code; 51 feature rows; a yearly price with 3 decimals | `409 code_taken` at the code; "at most 50" message alone; amount pattern refused at the field, nothing sent |
| `/plans/[planCode]` | Fields, Stripe product and prices, whether Checkout can start per interval, warning count; **Edit the plan**, **Retire plan** / **Make the plan active again**, **Link Stripe prices** (**Save the links**, **Check prices**) | Edit in two tabs; link one price to both intervals; link a price another plan uses | Second save `412`; `same_price` at the yearly field; `409 stripe_price_taken`; [[price-warning]]s in words next to each price, never blocking |
| `/subscriptions` | Status, Provider, Plan filters; id, OTA, plan, status, billing, interval, trial end, period end, created | `?provider=manual` | Newest first |
| `/subscriptions/[subscriptionId]` | Detail, invoices (Stripe links only when `https:`), Stripe events, links "All invoices/events of this OTA"; **Edit the manual subscription** (manual rows) or **Resync from Stripe** ([[resync-from-stripe]], Stripe rows with a Stripe subscription) | Move a trial end; set Active; reopen a canceled row while another is current | Only changed fields sent with reason + If-Match; `409 current_exists` at the status; `422 plan_not_active` at the plan ([[manual-subscription]]) |
| `/invoices` (M5) | Status and OTA filters; number, Stripe id, OTA, subscription, status, period, total/paid/due in the invoice currency | A JPY invoice | `¥5,000` (no decimals) |
| `/stripe-events` (M5) | Status, Type, OTA filters; failed and ignored first; **Reprocess** on those two | Reprocess the same event twice quickly | Second answers `409` (event moved) worded ([[stripe-event-reprocess]]) |

```diagram
flow-plans-and-prices
```

```diagram
flow-manual-subscription
```

```diagram
flow-stripe-events
```

### Amadeus

| Route | What it shows | Try | Should happen |
|---|---|---|---|
| `/amadeus/accounts` | One section per environment (Test, Live): name, status, host, client id (last 4), "Stored encrypted, never shown", last verification and error, pool counts; **Set up the … account**, **Verify now** / **Verify and enable**, **Edit details**, **Rotate secret**, **Disable account** | Create, rotate, disable; a host that is neither `https` nor the loopback stub | Verification job on `platform-connections` turns the status Active (the local stub accepts any non-empty id and secret, so `invalid_credentials` needs real Amadeus test credentials); secret fields never pre-filled and emptied after every answer; disabling cuts every OTA on that shared account; bad host refused at the field |
| `/amadeus/offices` | Environment and Status filters; [[amadeus-office]] id, status (since when releasing), OTA, assigned, notes, added; **Add offices**, **Assign**, **Retire**, **Edit notes**, **Release** ([[office-release]]) | 501 lines; a 10-character id; assign by a key that is also a substring of other keys | "at most 500" message alone; line numbers named; exact key match only (up to 5 pages of 200 looked up) |

```diagram
flow-amadeus-pool
```

```diagram
flow-live-office
```

### Payments: settlements, payout accounts, domains (M5)

| Route | What it shows | Try | Should happen |
|---|---|---|---|
| `/settlements` | Status, Month (24 ended months) filters, `tenantId` kept; statement, OTA, month, currency (test marked), status, net, lines, times; **Generate drafts** | Generate the current month; generate for one OTA | `period_not_closed` at the month; confirm says drafts lose their adjustments; `202` "queued" with a link |
| `/settlements/[settlementId]` | Totals, fields, payout account status and link, lines page + **CSV** (plain link); actions by status: draft → **Add an adjustment** ([[settlement-adjustment]]), **Approve**, **Void draft**; approved → **Record the bank transfer** | Adjust a JPY statement by `1500.5`; approve with an unverified payout account; mark paid with a future day | Refused at the field; `PAYOUT_ACCOUNT_REQUIRED`; refused before the call |
| `/settlements/[settlementId]/lines.csv` | Download `velexis-settlement-<key>-<yyyy-mm>-<currency>.csv` | `curl -I` (HEAD) | `405`, `Allow: GET` |
| `/domains` | Kind, DNS verification ([[domain-verification]]), TLS filters; host (Primary), OTA, kind, DNS state and 72-hour window end, last check in words, TLS and expiry, added; **Re-check**, **Remove** (custom only) | Remove a sub-domain via a crafted request; re-check while Redis is down | `409 subdomain`; "The checks could not be queued: the platform API or its Redis does not answer." |

```diagram
flow-settlement-review
```

```diagram
flow-payout-account
```

```diagram
flow-domains
```

### People and audit

| Route | What it shows | Try | Should happen |
|---|---|---|---|
| `/accounts` | Search (e-mail or name), Status; e-mail, status, two-factor, platform admin, last sign-in, created | Search part of an e-mail | Newest first, URL keeps `q` |
| `/accounts/[accountId]` | Fields, active session count, memberships (OTA, status, role), last 50 audit rows, links to the audit log by actor and by target; **Unlock**, **Disable**, **Enable**, **Reset two-factor** | Disable yourself; reset MFA of a platform admin | No Disable on your own account (note says why); no reset for admins (note: revoke first or `admin:reset-mfa`) |
| `/admins` | Name, e-mail, two-factor, last sign-in; **Grant admin rights**, **Revoke** per row | Revoke yourself; grant an account without MFA | Your row and the last admin's button disabled with a description; `422 mfa_not_enabled` worded |
| `/audit` | OTA id, actor account id, actor type, action and target type (selects of the backend's lists), target id, from/to days; table "Audit rows, newest first"; export panel | A period longer than a year; from after to | Export link hidden with the reason; notice and no call |
| `/audit/export.csv` | Streams the CSV with the same filters | Click twice | Two `audit.exported` rows ([[audit-export]]) |

```diagram
flow-account-support
```

```diagram
flow-admins
```

```diagram
flow-audit-export
```

### Route handlers

| Route | Method | Should happen |
|---|---|---|
| `/sign-out` | POST only | `Origin` must be `PUBLIC_PLATFORM_ADMIN_URL`'s origin (else `403`); revokes the family, deletes all `__Host-vxa_*` cookies, `303 /sign-in?signedOut=1`; GET → `405` |
| `/health/live` | GET | `200 {"status":"ok"}`, `Cache-Control: no-store`, `X-Robots-Tag: noindex` |
| `/health/ready` | GET | `200` when the platform API's `/health/live` answers within 2 s, else `503 {"status":"unavailable","checks":{"platformApi":"down"}}`; invalid config → `500` |

## How to …

Each task has a stepper above in the [Tour](#tour); here is the short version with the e2e journey that proves it.

1. **Suspend or resume an OTA** — `/tenants` → OTA → **Suspend** (kind + reason) / **Resume** (reason). Proven by
   `repo:tools/e2e/specs/admin-tenant-lifecycle.e2e.ts` and `repo:tools/e2e/specs/admin-suspension-storefront.e2e.ts`.
   Cross-app: [[journey:suspend-and-resume-ota]].
2. **Retry a failed job** — `/provisioning-jobs?status=failed` → job → **Retry**. A failed `provision` job puts the
   OTA back to "Setting up".
3. **Fix a waiting Amadeus connection** — dashboard pool warning → `/amadeus/offices` → **Add offices** → **Assign**
   by key. Proven by `repo:tools/e2e/specs/admin-amadeus-pool.e2e.ts`; cross-app:
   [[journey:amadeus-and-stripe-connections]].
4. **Serve a live request** — dashboard "Live office requests" → **Assign office**; later **Release** with the box and
   a reason (`repo:tools/e2e/specs/admin-live-office.e2e.ts`).
5. **Pay a settlement** — dashboard "To review" → draft → adjustment → **Approve** → reveal bank details → **Record the
   bank transfer** (`repo:tools/e2e/specs/admin-settlements.e2e.ts`).
6. **Remove an abusive domain** — `/domains` → **Remove** with a reason; suspend the OTA too when the storefront itself
   is the problem (`repo:tools/e2e/specs/admin-domains.e2e.ts`; [[journey:custom-domain-and-go-live]]).
7. **Help a locked-out user** — `/accounts?q=` → **Unlock**, or **Reset two-factor** after an identity check
   (`repo:tools/e2e/specs/admin-signin.e2e.ts`).
8. **Mark an OTA as paying outside Stripe** — `/subscriptions/<id>` → **Edit the manual subscription** → status
   Active → reason. Go-live then accepts the OTA.
9. **Find who did what** — `/audit` with filters → **Download CSV** (`repo:tools/e2e/specs/admin-audit.e2e.ts`).

## Roles and permissions

There is one role in the console, platform admin, and every admin can do everything. The API re-reads
`accounts.is_platform_admin` and `status` on every call, so revoked rights or a disabled account stop working at the
next request.

| Action | Reason | Step-up | Refused when |
|---|---|---|---|
| Suspend / Resume OTA | yes | — | not active / not suspended (`409`), billing suspension without a trialing/active subscription |
| Disable / Enable connection | yes | — | `no_office`, `deauthorized`, not disabled |
| Cancel provisioning job | yes | — | not queued (`409 not_queued`) |
| Retry provisioning job, Migrate | — | — | `PROVISIONING_NOT_RETRYABLE`, `migrate_job_active`, `schema_missing` |
| Retry queue job | — | — | OTA queue (`403 ota_queue`) |
| Create Amadeus account; change its secret, client id or host | — | yes | `environment_exists`; `official_host` with `APP_ENV=production` |
| Retire / Release office | yes | — | `not_available`; `connection_active`, `not_assigned` |
| Edit manual subscription | yes | — | `stripe_billed`, `current_exists`, `plan_not_active` |
| Settlement adjustment, Void draft | yes | — | not draft (`SETTLEMENT_STATE_INVALID`), `amount_precision` |
| Approve, Mark paid | — | yes | `PAYOUT_ACCOUNT_REQUIRED`, stale version |
| Reveal payout account | yes | yes | no account (`404`) |
| Remove domain | yes | — | sub-domain (`409`) |
| Disable / Enable account | yes | — | yourself or the last admin (`403 self`, `last_admin`) |
| Reset two-factor | yes | yes | a platform admin (`403 platform_admin`), MFA off (`409`) |
| Grant admin | yes | yes | not found, already admin, not active, e-mail not verified, MFA off |
| Revoke admin | — (none sent) | yes | yourself, the last admin |
| Plans, prices, resync, reprocess, re-check, generate drafts, unlock, notes, assign | — | — | see each screen |

A forbidden or refused action never shows the API's own text: it shows the admin's sentence for the
[[platform-error-code]] (`repo:platform/admin/src/lib/strings.ts`) next to the field or above the form.

## Bug-hunting checklist

```bug-hunt
**Sign-in and session.** Non-admin and wrong password must look identical. 5 wrong passwords → `ACCOUNT_LOCKED` with a
wait; check `select failed_login_count, locked_until from platform.accounts where email = '…'`. Reusing a TOTP code in
the same 30-second step must fail (`mfastep:<accountId>`). A `next` like `/.//evil.example` must land on `/`. After
**Sign out**, `select revoked_at from platform.account_sessions where account_id = '…' and audience = 'platform_admin'
order by created_at desc limit 3` is set. Cookies: only `__Host-vxa_at`, `__Host-vxa_rt` (and `__Host-vxa_mfa` during
sign-in), all HttpOnly, Secure, SameSite=Strict.
```

```bug-hunt
**Reasons and step-up.** Every reason action refuses an empty or 4-character reason (spaces do not count) without a
network call. Every step-up action asks for a code after 15 minutes and, after the code, runs once with the same
reason; cancelling runs nothing. Check that exactly one audit row was written:
`select action, details->>'reason', created_at from platform.platform_audit_log where actor_type = 'platform_admin'
order by id desc limit 5`.
```

```bug-hunt
**Suspend / resume.** After suspend: `select status, suspension_reason, suspended_at from platform.tenants where key =
'…'`; `select kind, status, step, error from platform.provisioning_jobs where tenant_id = '…' order by created_at desc`;
`select template, status from platform.email_outbox where tenant_id = '…' order by created_at desc`. The storefront
must say "temporarily unavailable" within 60 s and work again within 60 s of resume. The owner's banner wording must
match the kind (abuse, request, admin). Mailpit: one e-mail per active owner.
```

```bug-hunt
**Jobs and queues.** Counts on `/queues` must match BullMQ: `redis-cli -a dev_redis llen vx:platform-emails:wait`,
`zcard vx:platform-emails:failed` (prefix `vx`). The dashboard's "failed in 24 h" can differ from the failed list (no
time filter) — a number that never goes down after a retry is a bug. Retrying an `ota-*` job must be impossible, also
by crafting the form post.
```

```bug-hunt
**Plans and money.** Amounts are decimal strings, never floats: try `0.10`, `999999999.99`, JPY and EUR plans. A plan
edit must not drop features you did not touch (`select limits, features, is_public, is_active from platform.plans`).
Retired plans must disappear from the portal pricing page and the manual-subscription plan list. Price warnings must
show the Stripe amount in the **price's** currency.
```

```bug-hunt
**Manual subscriptions.** Trial end keeps the time of day (UTC). After Active: `select status, trial_ends_at,
canceled_at from platform.subscriptions where tenant_id = '…'` and the tenant's `billing_notice` cleared after the daily
run. Only one current row per OTA (`subscriptions_current_uq`): reopening a canceled row while another exists must give
`current_exists`.
```

```bug-hunt
**Amadeus pool.** Secrets never appear in the HTML or the RSC payload (search the page source for the client id and
secret). `select office_id, status, assigned_tenant_id, release_requested_at from platform.amadeus_offices order by
created_at desc`; an office `assigned`/`releasing` without a tenant is impossible (CHECK). After assign:
`select status, office_ids, credential_source from platform.supplier_connections where tenant_id = '…'`. Pool warning
appears below 3 available offices per environment.
```

```bug-hunt
**Settlements and payouts.** Totals must equal the lines (`select sum(amount) from platform.settlement_lines where
settlement_id = '…'`). Approve with net ≤ 0 → `carried_forward` ([[carried-forward]]), never `paid`. The revealed IBAN must disappear after
60 s and after "Hide now", and must not be in the URL, the page source after hiding, or any log line
(`journalctl -u velexis-platform-admin`). Each reveal adds one `payout_account.revealed` row. The paid e-mail goes to
owners and finance members only.
```

```bug-hunt
**Domains.** Remove: the row is gone from `platform.tenant_domains`, the sub-domain is `is_primary` again, the owner's
e-mail does **not** contain the reason, `redis-cli -a dev_redis get tlsask:<host>` is empty. The "2 of 3" failure count
of verified domains increases at most once per UTC day.
```

```bug-hunt
**Lists and filters.** Every filter round-trips through the URL; "Next page" keeps filters; changing a filter drops the
cursor; a stale cursor shows the notice, not an error page. Dates are UTC everywhere (the console has no local time).
Audit "to" is inclusive in the form but the API gets the next day at 00:00Z — check rows at 23:59 UTC are included.
```

```bug-hunt
**Accessibility and headers.** Every page: `X-Robots-Tag: noindex`, a CSP with a fresh nonce, `<main id="main-content">`
reachable by the skip link, tables scrollable by keyboard, status shown in words not only colour. Proven by
`admin-a11y.e2e.ts` and `admin-headers.e2e.ts`; a page they do not reach is worth checking by hand. Locally
`Referrer-Policy` is `same-origin`; behind Caddy (production) the shared `security_headers` snippet replaces it with
`strict-origin-when-cross-origin` on `admin.platform.example.com`, so other sites can learn the admin's origin.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/health/ready` 500, terminal shows `ConfigError` | Missing or invalid variable (e.g. `PLATFORM_BFF_KEY` shorter than 32 characters) | Copy the root `.env.example` to `.env.local`; the error names the variable |
| `/health/ready` 503 `platformApi: down` | Platform API not on `127.0.0.1:3100` | Start `pnpm --filter @velexis/platform-backend dev` |
| Sign out answers "Forbidden" | Browsing `127.0.0.1` while `PUBLIC_PLATFORM_ADMIN_URL` is `localhost` | Use `http://localhost:3001` |
| Signed out after every page | Cookies not stored (non-localhost HTTP host: `__Host-` cookies need a secure context) | Use `localhost` locally; HTTPS elsewhere |
| "The e-mail address or password is not correct…" for the right password | Account is not a platform admin, or not `active` | `select status, is_platform_admin, mfa_enabled from platform.accounts where email = '…'`; `admin:grant` |
| `MFA_REQUIRED` | Admin without MFA | Enable it in the portal `/account/security` |
| Code always "not correct" | Clock skew, or the code was already used in this 30-second step | Sync the clock; wait for the next code |
| Every action asks for a code | Your session's step-up is older than 15 minutes (expected) | Enter the code; it counts for 15 minutes |
| Suspension job stays `running` | OTA worker not running | Start the OTA worker; see runbook §2 (`repo:platform/docs/runbooks/platform-operations.md`) |
| M5 page says "This feature is not switched on yet." | `FEATURE_*` off in the platform API | Switch it on and restart the API and worker |
| Amadeus account stays "Not verified" | Platform worker or the stub not running | `pnpm stub:amadeus`; check `platform-connections` on `/queues` |
| Dashboard "could not be loaded" | Redis down (`SERVICE_UNAVAILABLE`) | Start Redis |
