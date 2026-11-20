---
id: bug-hunting
title: Hunting bugs with this guide
summary: A method for walking every app, what to capture in a bug report, and how to inspect PostgreSQL, Redis, Mailpit and the logs locally.
order: 40
---

## The method

1. **Start clean.** Follow [[page:getting-started]]; clear Mailpit; note the commit (`git log --oneline -1`). Open the
   browser's developer tools (Network with "Preserve log", Console) before the first click.
2. **Walk the journeys in order** ([[page:overview]] lists the suggested order). Each step says what to do, what should
   happen and what to check in the data. Mark it pass, bug or skipped; the guide remembers your marks in this browser.
3. **Then go wide, app by app.** Each app's usage guide has a "Tour" of every screen and a "Bug-hunting checklist" of
   validations, edge cases and error states. Try the unhappy paths there: empty and over-long fields, double clicks,
   the back button, two tabs, a second user with fewer rights, a suspended OTA, a stub scenario.
4. **Confirm in the data.** A page that says "saved" is not proof: check the row (queries below), the e-mail in
   Mailpit, the queue in Redis and the log line with the request id.
5. **Write the bug down at once** with the template below, then continue: one bug per report.

```tip
Keep two browsers (or one normal and one private window): one for the OTA owner (portal and OTA admin) and one for a
traveller (storefront). Cookies are per host, so `localhost:3000`, `:3001`, `:3002` and `:5173` never share a session,
but two people in one browser profile would.
```

## Known issues and the journey checklists

- **Check the list first.** [Known issues](#/issues) holds the bugs already found while this guide was checked against
  the code, each with its evidence, severity and where to fix it. Confirm one there instead of filing it again; report
  only what is new or behaves differently.
- **When a bug is fixed.** The fix updates or removes its entry in `repo:guidebook/content/issues/issues.json`, and a
  change to a screen, endpoint, table, flow or term updates this guide; both rebuild the bundle
  (`node guidebook/tools/build.mjs`) in the same change (the definition of done in `repo:AGENTS.md`, lead decision (35d)).
- **Every journey step has Pass / Bug / Skip.** Your marks and notes stay in this browser. "Copy bug report for this
  step" (and "Copy bug report" for the whole journey) copies a report with the journey, the step, the expected result
  and your notes as "Actual".

## What to capture in a bug report

```note
The journey checklist's "copy bug report" button fills the first lines for you. Add the actual result and the evidence.
```

| Field | What to write |
|---|---|
| Title | `[app] what is wrong`, for example `[storefront] card fee missing from the confirmation total` |
| Where | App, URL, role (owner, agent, viewer, guest, customer), OTA key, test or live environment |
| Steps | Numbered, from a known state ("signed in as owner of `acme`, demo data seeded") |
| Expected | What the guide (or common sense) says should happen |
| Actual | What happened: the text on screen, the HTTP status, the error code |
| Evidence | The `X-Request-Id` of the failing response, the error envelope (`error.code`, `error.details`), a screenshot, the relevant log lines, the row before and after (`psql`), the e-mail subject in Mailpit |
| Data ids | `ten_…`, `bkg_…` and the booking reference `VX…`, `pay_…`, `chk_…`, `job_…` |
| Kind | UI bug / wrong data / DB fix needed / security / performance / copy (text) |
| Severity | Blocker (data leak between tenants, money wrong, card data exposed, cannot book) · Major (a feature does not work) · Minor (workaround exists) · Cosmetic |

```warning
Never paste a card number (even a test one typed by mistake into the wrong field), a password, a token, an API key or
an MFA secret into a report. Name the kind of value instead ("the secret key was shown on the page after a reload").
```

## Inspecting PostgreSQL

Connect as the migrator (development password, development only); it can read `platform`, `reference` and every
`tenant_<key>` schema:

```bash
psql postgres://velexis_migrator:dev_migrator@127.0.0.1:5432/velexis
```

Platform side:

```sql
-- OTAs, newest first
SELECT id, key, name, status, storefront_environment, plan_code, schema_version, activated_at
FROM platform.tenants ORDER BY created_at DESC LIMIT 10;

-- Provisioning and other cross-backend jobs of one OTA (steps holds each post-step's outcome)
SELECT id, kind, status, step, attempt, max_attempts, error, steps
FROM platform.provisioning_jobs WHERE tenant_id = 'ten_…' ORDER BY created_at DESC;

-- E-mails the platform queued (the secret link is never readable here)
SELECT template, to_email, status, attempts, last_error, sent_at
FROM platform.email_outbox ORDER BY created_at DESC LIMIT 20;

-- The audit trail of a tenant
SELECT created_at, actor_type, actor_label, action, target_type, target_id, request_id
FROM platform.platform_audit_log WHERE tenant_id = 'ten_…' ORDER BY created_at DESC LIMIT 30;

-- Keys, connections, domains, the office pool
SELECT name, kind, environment, prefix, scopes, last_used_at, revoked_at, expires_at FROM platform.api_keys WHERE tenant_id = 'ten_…';
SELECT provider, environment, status, default_office_id, last_error FROM platform.supplier_connections WHERE tenant_id = 'ten_…';
SELECT hostname, kind, is_primary, verification_status, tls_status FROM platform.tenant_domains WHERE tenant_id = 'ten_…';
SELECT office_id, status, assigned_tenant_id FROM platform.amadeus_offices ORDER BY office_id;
```

Tenant side (replace `tenant_acme` with `tenant_<your key>`; the demo OTA is `tenant_demo`):

```sql
-- Bookings with their money and ticketing state
SELECT id, reference, environment, channel, status, ticketing_status, ticketing_error_code, record_locator,
       currency, net_amount, markup_amount, fees_amount, card_fee_amount, total_amount, amount_paid, amount_refunded,
       reconcile_outcome, cancelled_by, cancel_reason
FROM tenant_acme.bookings ORDER BY created_at DESC LIMIT 10;

-- What happened to one booking, in order
SELECT created_at, type, actor_type, status_from, status_to, summary, visible_to_customer
FROM tenant_acme.booking_events WHERE booking_id = 'bkg_…' ORDER BY created_at;

-- Payments, their events and refunds
SELECT id, provider, method, status, amount, card_fee_amount, amount_captured, amount_refunded, card_brand, provider_payment_id
FROM tenant_acme.payments WHERE booking_id = 'bkg_…';
SELECT created_at, type, source, status_from, status_to, amount FROM tenant_acme.payment_events WHERE payment_id = 'pay_…' ORDER BY created_at;
SELECT amount, reason, status, failure_reason FROM tenant_acme.refunds WHERE booking_id = 'bkg_…';

-- E-mails and documents of a booking
SELECT template_key, recipient, status, attempts, last_error, sent_at FROM tenant_acme.notifications WHERE booking_id = 'bkg_…';
SELECT kind, status, file_name, size_bytes, storage_key FROM tenant_acme.booking_documents WHERE booking_id = 'bkg_…';

-- Every Amadeus call (bodies are redacted), and the staff audit
SELECT created_at, operation, http_status, outcome, error_codes, duration_ms, office_id, request_id
FROM tenant_acme.supplier_requests ORDER BY created_at DESC LIMIT 20;
SELECT created_at, staff_email, staff_role, action, target_type, target_id, outcome, reason
FROM tenant_acme.staff_actions ORDER BY created_at DESC LIMIT 20;

-- Settings that drive the storefront
SELECT brand_name, primary_color, ticketing_policy, airline_card_enabled_test, time_zone, features FROM tenant_acme.storefront_settings;
SELECT name, calculation, percentage, fixed_amount, is_default, is_active FROM tenant_acme.markup_rules;
```

```warning
Read, do not write. Changing rows by hand skips the caches (60 s TTL in Redis), the audit trail, the outbox and the
invariants the services keep. If a fix needs a data change, write down the exact `UPDATE` you would run in the bug
report (that is the "DB fix" the developer will turn into a migration or a script).
```

## Inspecting Redis

```bash
export REDISCLI_AUTH=dev_redis            # development only
redis-cli -n 0 --scan --pattern 'tenant:*'          # cached platform rows (also host:*, apikey:*, conn:*, member:*)
redis-cli -n 0 --scan --pattern 't:ten_*'           # tenant-scoped caches (offers, storefront configuration)
redis-cli -n 0 --scan --pattern 'staffsess:*'       # console staff sessions (hashes of refresh tokens only)
redis-cli -n 0 --scan --pattern 'staffdeny:*'       # revocation cut-offs (account, member, tenant)
redis-cli -n 0 TTL tenant:ten_…                      # every cache key must have a TTL (-1 means a bug)
redis-cli -n 0 SUBSCRIBE vx:invalidate               # watch platform invalidations live while you change things
```

BullMQ queues live under `vx:<queue>:…` (`wait`, `active`, `delayed`, `failed`, `completed`):

```bash
redis-cli -n 0 LLEN vx:ota-notifications:wait        # e-mails waiting to be sent
redis-cli -n 0 ZCARD vx:ota-ticketing:delayed         # ticketing retries scheduled
redis-cli -n 0 ZRANGE vx:platform-emails:failed 0 -1  # ids of failed e-mail jobs
redis-cli -n 0 HGETALL vx:platform-emails:<job id>    # one job: data, attemptsMade, failedReason
```

The platform admin's **Queues** page (<http://localhost:3001/queues>) shows the same counts and failed jobs with their
reasons; platform queues can be retried there, OTA queues are view-only.

## Inspecting Mailpit

- UI: <http://localhost:8025>. Check the recipient, the subject, both HTML and text parts, links (they must point at
  `localhost` locally, at the OTA's storefront host for traveller e-mails), the brand name, and attachments (itinerary
  and e-ticket PDFs open and show the right booking).
- API: `curl -s 'http://127.0.0.1:8025/api/v1/messages?limit=20' | jq '.messages[] | {Subject, To: .To[0].Address, Created}'`
  and `curl -s http://127.0.0.1:8025/api/v1/search?query=to:owner1@example.com | jq '.messages_count'`.

Subjects worth knowing (from the e2e suite): "Confirm your e-mail address for Velexis", "You already have a Velexis
account", "`<OTA name>` is ready on Velexis", "Your booking `VX…` with `<OTA>` has been updated", "The contact details
of booking `VX…` with `<OTA>` were changed", "Your booking `VX…` is cancelled".

## Logs: where each app writes

Every Node process writes **JSON lines** (pino) to stdout with the fields `app`, `env`, `level`, `msg`, and, inside a
request, `requestId`, `tenantId` and the actor (`repo:packages/logger/src/create-logger.ts`). Secrets, tokens,
passwords and card data are redacted by a central list (`repo:packages/logger/src/redact-paths.ts`).

| Where you run it | Where the lines go | How to read |
|---|---|---|
| `pnpm dev` (Turborepo) | The terminal, each line prefixed with the package name | `pnpm --filter @velexis/ota-backend dev 2>&1 \| grep -v '^>' \| jq -R 'fromjson? \| select(.level >= 40)'` (warnings and errors) |
| One app (`pnpm --filter … dev`) | That terminal | Pipe through `jq -R 'fromjson?'`; filter by `select(.requestId == "…")` |
| e2e harness (`pnpm test:e2e`) | `tools/e2e/test-results/stack/<process>.log` (or `test-results/<subdir>/stack/`) | One file per process: `platform-api.log`, `ota-api.log`, `ota-worker.log`, …; seeds in `platform-dev-seed.log`, `ota-dev-seed.log` |
| Production VM | journald, one unit per process | `journalctl -u velexis-ota-api -o cat \| jq …`; units `velexis-platform-api`, `velexis-platform-worker`, `velexis-ota-api`, `velexis-ota-worker`, `velexis-portal`, `velexis-platform-admin`, `velexis-ota-admin`, `caddy` (WAF lines: logger `http.handlers.waf`) |

Messages are event-style names with the ids as fields (`logger.info({ bookingId, status }, "booking.created")`), so
filter on the id you care about (`bookingId`, `tenantId`, `jobId`); the APIs also log one line per request with its
status and `durationMs`.

## Following one request across apps

1. In the browser's Network tab, open the failing request and copy the **`X-Request-Id`** response header (or
   `error.requestId` from the JSON body).
2. Search the API's log for it: `… | jq -R 'fromjson? | select(.requestId == "<id>")'`.
3. Search the tenant tables that keep it: `supplier_requests.request_id`, `staff_actions.request_id`,
   `booking_events.request_id`, and `platform.platform_audit_log.request_id`.
4. Calls of the OTA admin and the portal go through their servers: the browser sees a Next.js server action, the API
   log shows the request the server made. Look at the Next.js terminal for its own error first.

## Tricks that make bugs show

| Trick | How |
|---|---|
| Force an Amadeus outcome | Send `X-Stub-Scenario: sold-out` (or `price-changed`, `ticketing-failed`, `server-error`, `rate-limited`, `timeout`) with one request, for example with a browser extension that adds headers, or with `curl` against the OTA API; destination `ZZZ` gives no results |
| Decline a card | Airline card `4000 0000 0000 0002` (stub); Stripe's documented decline test cards |
| Hit a rate limit | Six failed guest lookups in 15 minutes from one IP or for one reference (`429`), six customer sign-ups in an hour from one IP (four with one e-mail address), more than 5 airline-card completions a minute |
| Expire things | Leave a checkout open past its TTL (`storefront_settings.checkout_ttl_minutes`); wait 60 s with a console link before posting it; let the access cookie (15 min) expire and click |
| Test isolation | Use the demo OTA as "the other OTA": its ids, its PNRs (office `DEV1A00…` assigned to it), its keys |
| Test roles | Invite a second account as viewer, agent and finance ([[journey:team-and-console-sso]]) and repeat an action |
| Test time zones | Set the OTA's time zone in the storefront settings far from yours; check dates in e-mails, the "issued today" void rule and ticketing deadlines |
| Watch invalidations | `redis-cli SUBSCRIBE vx:invalidate` while changing keys, domains, members or suspending an OTA |

## Where bugs usually hide

```bug-hunt
- **Money**: totals that disagree between pages, e-mail, PDF and console; card fee lines; partial refunds; rounding.
- **Tenancy**: any id from another OTA that answers 200; a PNR of another office that shows data.
- **State machines**: double clicks on Pay, Issue, Cancel, Refund (idempotency); actions offered that the API then
  refuses (`allowedActions` vs the real rule); a booking stuck in `pending` or `manual_review`.
- **Sessions**: two tabs refreshing at once; sign out everywhere; removed members keeping access; Safari.
- **Caches**: settings or key changes that take longer than about a second to apply.
- **E-mails**: missing, duplicated, wrong recipient, wrong language, links to the wrong host, missing attachments.
- **Accessibility**: keyboard-only use, focus after errors, screen-reader labels, 360 px phone width.
- **Copy**: messages that leak internals (stack traces, SQL, raw Amadeus errors outside the console).
```

## Severity and what counts as a DB fix

- **Blocker**: cross-tenant data, money wrong, card data or tokens visible, booking impossible, data loss.
- **Major**: a feature broken with no workaround in the UI (for example a refund that never completes).
- **Minor**: a workaround exists, or only an edge case fails.
- **Cosmetic**: layout, wording, alignment.
- **DB fix**: wrong or missing rows (a booking left `pending` after the order exists, a payment `authorized` after a
  capture, a domain `verified` without records). Report the ids, the current values and the values they should have;
  the fix becomes a migration (`repo:ota/backend/migrations/tenant` or `repo:platform/backend/migrations/platform`) or a
  one-off script, never a hand edit on production.
