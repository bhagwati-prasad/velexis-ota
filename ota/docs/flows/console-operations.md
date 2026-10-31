# Flow: console operations

This flow covers what OTA staff do in the OTA admin and how the OTA backend serves it: signing in through SSO from the portal, working the bookings list, retrieving, patching, issuing, cancelling and annotating bookings, looking up and importing PNRs by record locator, reading queues, capturing and refunding Stripe payments, reading customers and the supplier log, and changing settings. It is milestone **M4**. Every console call carries a staff token (or a `console:automation` key) and checks a permission; it writes one `staff_actions` row when it changes something, when it is refused, and when it is a read that returns personal data of one person or a supplier record (§3 step 7).

Related: [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md), [OADR-0011](../adr/0011-console-access-staff-sessions-and-environments.md), [`../api-changes-console-and-internal.md`](../api-changes-console-and-internal.md), [SDK guide B4](../../../docs/velexis-sdk/sdk/docs/B4.md), [MVP architecture flow (c)](../../../docs/mvp/architecture.md#c-ota-admin-sso-from-the-portal-and-console-booking-actions).

## 1. Sequence: SSO and an issue action

```mermaid
sequenceDiagram
  autonumber
  actor U as OTA staff
  participant P as Portal + platform API
  participant R as Redis
  participant AD as OTA admin (Next.js server)
  participant O as OTA API
  participant PL as platform tables (read-only)
  participant D as tenant_acme
  participant A as Amadeus
  participant S as Stripe

  U->>P: Open console for Acme
  P->>R: SET ptk:{sha256} {accountId, tenantId, membershipId, mfa} EX 60 NX
  P-->>U: auto-submitting POST form to admin.ota.example.com/sso
  U->>AD: POST /sso {portalToken}
  AD->>O: console.auth.signIn {grantType: portal_token} (X-Api-Key = service key)
  O->>R: GETDEL ptk:{sha256}
  O->>PL: membership active, account active, tenant active
  O->>R: staffsess:{familyId} (12 h), check staffdeny:acct:{accountId}
  O->>D: staff_actions staff.sign_in
  O-->>AD: staff access + refresh tokens, permissions, environments
  AD-->>U: __Host- cookies, redirect to /bookings
  U->>AD: Issue tickets for bkg_…
  AD->>O: console.bookings.issue (service key, Bearer staff token, X-Velexis-Environment: live, If-Match, Idempotency-Key)
  O->>O: tid = tenant, permission bookings:issue, live allowed for role
  O->>S: capture authorised payment (capturePayment default true)
  O->>A: Flight Order Management GET (the resync first: tickets already issued are recorded, not issued again)
  O->>A: Flight Order Issue
  O->>D: tickets, booking ticketed, booking_events, staff_actions booking.issue (redacted before/after)
  O-->>AD: booking (new ETag)
```

## 2. Operations by area

| Area | SDK methods | Permission | Amadeus | Notes |
|---|---|---|---|---|
| Session | `console.auth.signIn` (portal token), `.refresh`, `.signOut`, `.me` | — | — | Staff families in Redis; the four `staffdeny` keys honoured ([OADR-0011](../adr/0011-console-access-staff-sessions-and-environments.md) point 3); password grant later |
| Bookings list and detail | `console.bookings.list`, `.get` | `bookings:read` | — (`refresh=true`: GET) | Indexes lead with `environment`; filters of db README §10 |
| Amadeus order view | `console.bookings.retrieve` | `bookings:read` | Flight Order Management GET | Net prices, full documents (decrypted for display, never logged) |
| Patch | `console.bookings.patch` | `bookings:write` | PATCH | `If-Match`; 2552 → `409 VERSION_CONFLICT`; `notifyCustomer` e-mails `booking.updated` (and a notice to a previous contact address) after a change Amadeus answered, a `tags`/`metadata` patch only warns (FIX-W28-NOTIFY) |
| Issue | `console.bookings.issue` | `bookings:issue` | GET (the resync first), Flight Order Issue (GET after an unknown outcome) | Captures first; `allowUnpaid` owner/admin only; the ticketing job's claim; airline card only with `other` `CASH`/`ACCOUNT` (OBE-063) |
| Cancel | `console.bookings.cancel` | `bookings:cancel` | GET, DELETE (`release` and `void` only) | The step of the quote's cancellation-mode rule; refund modes `none`, `full`, `amount` through the money step of bookings.cancel; airline cards never through Stripe (OBE-063); a `request_only` booking gets a request to the airline, no DELETE (FIX-W36-OTA), with refund `none` only and no staff alert, and a booking whose request waits for the staff is refused with `pending` (FIX-W37-OTA) |
| Resync, notes | `console.bookings.resync`, `.addNote` | `bookings:write` | GET (resync) | Notes are `booking_events` visible to staff only |
| PNR lookup and import | `console.bookings.findByRecordLocator`, `.import` | `bookings:read`, `bookings:write` | Get Flight Order By Record Locator | Only orders owned by the tenant's offices (`403 OFFICE_NOT_ALLOWED`); `409 ORDER_ALREADY_IMPORTED` |
| Queues | `console.queues.list`, `.listSnapshots` | `queues:read` | Queue List | Office of the tenant only; each read stored as a snapshot, each PNR linked to the OTA's booking of its record locator or shown as an orphan (OADR-0003's booking queue view); the poller (`queues.poll`) stores snapshots of the monitored queues every 15 min, active tenants only (OBE-065) |
| Customers | `console.customers.list`, `.get` | `customers:read` | — | Search by e-mail and name prefixes |
| Supplier log | `console.supplierRequests.list` | `supplier_requests:read` | — | Redacted bodies |
| Raw Amadeus (read) | `console.amadeus.searchFlightOffers`, `.getFlightOffers`, `.searchFlightAvailabilities`, `.upsellAirOffers`, `.quoteAirOffers`, `.getFlightOrder`, `.getFlightOrderByReference`, `.getQueue` | `amadeus:read` | As named | Net prices; office isolation; raw writes deferred |
| Payments | `console.payments.list`, `.get`, `.capture`, `.refund` | `payments:*` | — | Stripe only for capture and refund |
| Settings | `console.settings.*` | `settings:read` / `settings:write` | — | Markups, fees, storefront, pages, assets, templates |

## 3. Steps for the main tasks

1. **Sign in.** The OTA admin has no sign-in page: without a session it redirects to `https://platform.example.com/console?tenant=<id>`. The portal token is single use and expires in 60 seconds. Live tenants require MFA on the portal account; the platform checks it before it issues the token ([PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md), [PADR-0008](../../../platform/docs/adr/0008-email-verification-and-mfa-policy.md)), and `console.auth.signIn` checks the token's `mfa` flag again for a live tenant (`403 MFA_REQUIRED`).
2. **Environment.** The admin's switch sends `X-Velexis-Environment`. `live` needs a live tenant and a role other than `viewer` ([OADR-0011](../adr/0011-console-access-staff-sessions-and-environments.md)).
3. **Work list.** Default filters: `ticketingStatus in (failed, manual_review)`, `reconcile_outcome = manual_review`, deadlines within 24 hours, cancellation requests, schedule changes. These are the "needs attention" views.
4. **PNR import.** Staff enter a record locator. The backend checks the local unique index first, then calls Get Flight Order By Record Locator **with the tenant's office**, verifies the owner or queuing office is one of the tenant's, and creates a booking with `channel = import`, `pricing_mode` chosen by staff (`markup_rules`, `net`, `override`), no payment (`paymentStatus = not_applicable`). As built (OBE-064, [`../../backend/README.md`](../../backend/README.md) "Console: PNR lookup and import"): the office that holds an order is its owner office, or its queuing office when Amadeus gives no owner office; another office's orders are left out of the answer and of the tenant's `supplier_requests` row, and none left is `403 OFFICE_NOT_ALLOWED` (ADR-0012 office isolation, OF-09 AC3). An imported order without tickets has `ticketing_status = manual_review` (nothing was paid through Velexis): staff issue it with console.bookings.issue.
5. **Payments.** Capture is for authorised Stripe payments that were not captured automatically (`manual_review` policy, capture failures). Refunds are partial or full, with a reason; the payments queue sends them and the webhook completes them. The customer sees a refund as requested (booking event `refund.requested`) until Stripe's answer makes it refunded (`refund.succeeded`, lead decision 6 of 2026-10-22). Airline-card payments cannot be refunded here (`422`, `details.reason = "refund_via_airline"`).
6. **Settings.** Changes bump the row version, invalidate the storefront caches, and are audited with redacted before/after. A markup change applies to the next search.
7. **Audit.** A `staff_actions` row for every state-changing call, every refused one, and the successful reads that return personal data of one person or a supplier record ([OADR-0011](../adr/0011-console-access-staff-sessions-and-environments.md) point 8, final rule of 2026-10-21):
   - changes: `outcome = succeeded`, or `failed` when they fail; an idempotent replay keeps its row;
   - refusals: denied attempts (`denied`: the permission guard's `403`s, the staff guard's `403 STAFF_MEMBERSHIP_INACTIVE` of a verified token, and the sign-in's `403`s of the staff member its portal token names, `STAFF_MEMBERSHIP_INACTIVE`, `TENANT_SUSPENDED`, `MFA_REQUIRED` and `ENVIRONMENT_NOT_ALLOWED`) and requests refused by validation (`400 VALIDATION_FAILED`, `failed`, with the action and the target only). A refusal before validation takes a path value as its target only when the value passes that parameter's schema;
   - audited reads: viewing a customer (`customer.view`), the PNR lookup (`pnr.lookup`), the order retrieve (`order.retrieve`) and the raw Amadeus reads (`amadeus.<operationId>`); each handler opts in with `@AuditedRead` ([`../../backend/README.md`](../../backend/README.md)).

   Other successful reads (the bookings list and detail, queues, the customer search, the supplier log, settings) and the session calls `console.auth.refresh`, `signOut` and `me` write none. A `429 RATE_LIMITED` writes none either: the rate-limit guard logs the staff member or key, the operation and the limit. Nor does a `429` raised inside a console use case (the console's resync throttle of 10 s per booking, an empty Amadeus bucket): the audit interceptor writes the log line `staff_actions.rate_limited` (the operation, the code, the staff member or key, `Retry-After`'s seconds) instead of its `failed` row (2026-10-30, lead decision (2d) of the third batch, FIX-W36-OTA; [OADR-0011](../adr/0011-console-access-staff-sessions-and-environments.md) point 8 says it of every `429`).

8. **Issue and cancel** (OBE-063, [`../../backend/README.md`](../../backend/README.md) "Console: the booking actions"). `console.bookings.issue` takes the ticketing job's claim (`ticketing_status = in_progress`, OBE-044), so the job and a staff issuance never run together, captures an authorised Stripe payment through console.payments.capture's path (its own `payment.capture` staff action), reads the order first as every attempt of the job does ([OADR-0008](../adr/0008-ticketing-policy.md) point 4: tickets an earlier, timed-out issuance made are recorded, not issued again; the order is never issued without that read), then sends Flight Order Issue once; after a timeout it reads the order back and records tickets it finds, never issuing again in the request ([OADR-0003](../adr/0003-booking-orchestration-and-supplier-timeout-recovery.md) point 7). An airline-card booking whose card the airline did not charge is unpaid: it needs `allowUnpaid` (owner or admin) and an `other` form of payment. `console.bookings.cancel` is bookings.cancel's claim, DELETE, record and money steps with the staff's decision instead of a quote, refused (`409 BOOKING_NOT_MODIFIABLE`, `ticketing_in_progress`) while a staff issuance or the job holds a fresh ticketing claim: `refund.mode` gives the amount that goes back (`none` nothing, `full` all that can be refunded, `amount` that amount); an authorisation is split as for a customer (the rest of the amount captured, lead decision (1) of 2026-10-23, second batch), voided whole when the request has no `refund`. `cancelled_by = staff`, `cancel_reason` `<reasonCode>: <reason>`; the staff member's text stays out of the customer-visible events. A DELETE without an answer is flagged and checked by the worker like a customer's; an order Amadeus no longer has is recorded as cancelled, with a warning, because the staff asked for it. Its step is the quote's (2026-10-30, lead decision (2c) of the third batch, FIX-W36-OTA; before, the DELETE was sent in every mode, as `void` whenever a ticket held a seat): after the GET that refreshes the tickets, cancellation-mode.ts `supplierModeOf` over the stored tickets in `storefront_settings.time_zone`, the `cancellationMode` console.bookings.get shows, decides it. `release` (no ticket holds a seat) and `void` (every ticket that holds a seat was issued today there) send the DELETE as above; `request_only` (a ticket issued before today or at an unknown time, or a ticketed state without stored tickets) sends none and does not ask Amadeus to void: in the claim's transaction the booking records a request to the airline as a customer's `request_only` does (`version + 1`, the customer-visible `booking.cancellation_requested` with `cancelledBy: staff` and without the staff member's text, the traveller's e-mail unless `notifyCustomer: false`, the staff alert), with the `booking.cancel` staff action (after: the booking's own status, `mode: request_only`, `cause: request_only`); no money moves (the refund asked is recorded as `refundMode`, the estimate's refund is 0), the booking stays as it is with a `pending` cancellation by the staff, and the answer carries the warning "CANCELLATION REQUESTED FROM THE AIRLINE". The staff then cancel it with the airline, resync it (an order whose segments the airline cancelled becomes `cancelled`, `cancelled_by = airline`) and refund from the payment (`console.payments.refund`). Every `booking.cancel` staff action records its `mode`. Since 2026-10-31 (lead decisions (2b), (2c) and (2d), FIX-W37-OTA): such a request takes `refund.mode` `none` or no `refund` only, as the airline is asked first and the refund follows from the payment once it answered (`full` and `amount` answer `422 UNPROCESSABLE`, `details.reason = refund_not_available`, by the mode decided after the refresh, and nothing is written or sent but the `failed` staff action); a staff member's request raises no `staff.manual_review` alert (the traveller's `booking.cancellation_requested` e-mail stays unless `notifyCustomer: false`; a customer's request still alerts the staff); and while a request waits for the staff, the customer's or a staff member's own, `console.bookings.cancel` answers the refusal `bookings.cancel` gives a customer (`409 BOOKING_NOT_MODIFIABLE`, `details.reason = pending`, `details.action = canCancel`; `consoleActions.canCancel` shows it and `cancellationMode` is `null`), with no second traveller e-mail or staff alert. The OTA admin's cancel dialog offers no refund choice in `request_only` and says why; after a stale page's `refund_not_available` it shows that message and switches to the no-refund form.

## 4. Failure handling

| Situation | Answer |
|---|---|
| Portal token unknown, used or expired | `401 PORTAL_TOKEN_INVALID` → back to the portal |
| Live tenant, portal token without MFA (`mfa` not true) | `403 MFA_REQUIRED`; the token stays used → set up MFA in the portal, then open the console again |
| Membership removed or suspended | `403 STAFF_MEMBERSHIP_INACTIVE`; sessions refused within 60 s (`membership` invalidation) |
| "Sign out everywhere" on the portal | `staffdeny:acct:<id>` makes the guard and refresh refuse older families |
| "Sign out of every session" in the console (`console.auth.signOut`, `scope: all`) | `staffdeny:member:<staffId>` (epoch ms, 12 h) makes the guard and refresh refuse the staff member's older families in this OTA |
| Missing permission | `403 FORBIDDEN` (`details.requiredPermission`), `staff_actions` outcome `denied` |
| Over the console rate limit (600 per minute per staff session or key) | `429 RATE_LIMITED` with `Retry-After`; a `rate_limit.exceeded` log line, no `staff_actions` row |
| Office of another OTA | `403 OFFICE_NOT_ALLOWED` |
| Capture after authorisation expiry | `402 PAYMENT_DECLINED`; staff contact the traveller |
| Amadeus timeout on issue or cancel | `504`; resync before retrying ([`../architecture-booking.md`](../architecture-booking.md) §4) |
| Tenant suspended | Console sign-in refused, existing sessions get `403 TENANT_SUSPENDED` |

## 5. Tables

All booking and payment tables, `queue_snapshots`, `customers` (read), `supplier_requests` (read), `staff_actions`, settings tables, `idempotency_keys`; platform `tenant_memberships`, `accounts`, `supplier_connections` (read-only); Redis `ptk:*`, `staffsess:*`, `staffdeny:*`.

## 6. Tests

- SSO: valid token once, second use `401`, token for another tenant `401`, MFA rule for live tenants.
- Permission matrix of [`../scope.md`](../scope.md) §1.3 as a table-driven integration test over every console operation.
- `staff_actions` row per state-changing or refused call (validation refusals included) and per audited read, none for other reads or a `429`, with redacted before/after (no full document numbers, no tokens, no value of a refused request, no target that fails its parameter's schema).
- Office isolation for import and raw calls with two tenants on the shared account.
- Service key accepted only on a direct loopback connection without `X-Forwarded-For` (never through Caddy) and only with a staff token; the forwarded `X-Velexis-End-User-IP` and `-Agent` feed the sign-in throttle and `staff_actions` ([OADR-0009](../adr/0009-caller-and-tenant-resolution.md) rule 1.2 and point 8).
