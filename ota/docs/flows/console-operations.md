# Flow: console operations

This flow covers what OTA staff do in the OTA admin and how the OTA backend serves it: signing in through SSO from the portal, working the bookings list, retrieving, patching, issuing, cancelling and annotating bookings, looking up and importing PNRs by record locator, reading queues, capturing and refunding Stripe payments, reading customers and the supplier log, and changing settings. It is milestone **M4**. Every console call carries a staff token (or a `console:automation` key), checks a permission and writes one `staff_actions` row.

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
  O->>A: Flight Order Issue
  O->>D: tickets, booking ticketed, booking_events, staff_actions booking.issue (redacted before/after)
  O-->>AD: booking (new ETag)
```

## 2. Operations by area

| Area | SDK methods | Permission | Amadeus | Notes |
|---|---|---|---|---|
| Session | `console.auth.signIn` (portal token), `.refresh`, `.signOut`, `.me` | — | — | Staff families in Redis; `staffdeny:acct:*` honoured; password grant later |
| Bookings list and detail | `console.bookings.list`, `.get` | `bookings:read` | — (`refresh=true`: GET) | Indexes lead with `environment`; filters of db README §10 |
| Amadeus order view | `console.bookings.retrieve` | `bookings:read` | Flight Order Management GET | Net prices, full documents (decrypted for display, never logged) |
| Patch | `console.bookings.patch` | `bookings:write` | PATCH | `If-Match`; 2552 → `409 VERSION_CONFLICT` |
| Issue | `console.bookings.issue` | `bookings:issue` | Flight Order Issue | Captures first; `allowUnpaid` owner/admin only |
| Cancel | `console.bookings.cancel` | `bookings:cancel` | DELETE | Refund modes `none`, `full`, `amount` |
| Resync, notes | `console.bookings.resync`, `.addNote` | `bookings:write` | GET (resync) | Notes are `booking_events` visible to staff only |
| PNR lookup and import | `console.bookings.findByRecordLocator`, `.import` | `bookings:read`, `bookings:write` | Get Flight Order By Record Locator | Only orders owned by the tenant's offices (`403 OFFICE_NOT_ALLOWED`); `409 ORDER_ALREADY_IMPORTED` |
| Queues | `console.queues.list`, `.listSnapshots` | `queues:read` | Queue List | Office of the tenant only; poller stores snapshots every 15 min |
| Customers | `console.customers.list`, `.get` | `customers:read` | — | Search by e-mail and name prefixes |
| Supplier log | `console.supplierRequests.list` | `supplier_requests:read` | — | Redacted bodies |
| Raw Amadeus (read) | `console.amadeus.searchFlightOffers`, `.getFlightOffers`, `.searchFlightAvailabilities`, `.upsellAirOffers`, `.quoteAirOffers`, `.getFlightOrder`, `.getFlightOrderByReference`, `.getQueue` | `amadeus:read` | As named | Net prices; office isolation; raw writes deferred |
| Payments | `console.payments.list`, `.get`, `.capture`, `.refund` | `payments:*` | — | Stripe only for capture and refund |
| Settings | `console.settings.*` | `settings:read` / `settings:write` | — | Markups, fees, storefront, pages, assets, templates |

## 3. Steps for the main tasks

1. **Sign in.** The OTA admin has no sign-in page: without a session it redirects to `https://platform.example.com/console?tenant=<id>`. The portal token is single use and expires in 60 seconds. Live tenants require MFA on the portal account; the platform checks it before it issues the token ([PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md), [PADR-0008](../../../platform/docs/adr/0008-email-verification-and-mfa-policy.md)).
2. **Environment.** The admin's switch sends `X-Velexis-Environment`. `live` needs a live tenant and a role other than `viewer` ([OADR-0011](../adr/0011-console-access-staff-sessions-and-environments.md)).
3. **Work list.** Default filters: `ticketingStatus in (failed, manual_review)`, `reconcile_outcome = manual_review`, deadlines within 24 hours, cancellation requests, schedule changes. These are the "needs attention" views.
4. **PNR import.** Staff enter a record locator. The backend checks the local unique index first, then calls Get Flight Order By Record Locator **with the tenant's office**, verifies the owner or queuing office is one of the tenant's, and creates a booking with `channel = import`, `pricing_mode` chosen by staff (`markup_rules`, `net`, `override`), no payment (`paymentStatus = not_applicable`).
5. **Payments.** Capture is for authorised Stripe payments that were not captured automatically (`manual_review` policy, capture failures). Refunds are partial or full, with a reason; the webhook completes them. Airline-card payments cannot be refunded here (`422`, `details.reason = "refund_via_airline"`).
6. **Settings.** Changes bump the row version, invalidate the storefront caches, and are audited with redacted before/after. A markup change applies to the next search.
7. **Audit.** `staff_actions` row for every call, including reads of sensitive data (`booking.retrieve`, `customer.get`) and denied attempts (`outcome = denied`).

## 4. Failure handling

| Situation | Answer |
|---|---|
| Portal token unknown, used or expired | `401 PORTAL_TOKEN_INVALID` → back to the portal |
| Membership removed or suspended | `403 STAFF_MEMBERSHIP_INACTIVE`; sessions refused within 60 s (`membership` invalidation) |
| "Sign out everywhere" on the portal | `staffdeny:acct:<id>` makes the guard and refresh refuse older families |
| Missing permission | `403 FORBIDDEN` (`details.requiredPermission`), `staff_actions` outcome `denied` |
| Office of another OTA | `403 OFFICE_NOT_ALLOWED` |
| Capture after authorisation expiry | `402 PAYMENT_DECLINED`; staff contact the traveller |
| Amadeus timeout on issue or cancel | `504`; resync before retrying ([`../architecture-booking.md`](../architecture-booking.md) §4) |
| Tenant suspended | Console sign-in refused, existing sessions get `403 TENANT_SUSPENDED` |

## 5. Tables

All booking and payment tables, `queue_snapshots`, `customers` (read), `supplier_requests` (read), `staff_actions`, settings tables, `idempotency_keys`; platform `tenant_memberships`, `accounts`, `supplier_connections` (read-only); Redis `ptk:*`, `staffsess:*`, `staffdeny:*`.

## 6. Tests

- SSO: valid token once, second use `401`, token for another tenant `401`, MFA rule for live tenants.
- Permission matrix of [`../scope.md`](../scope.md) §1.3 as a table-driven integration test over every console operation.
- `staff_actions` row per call with redacted before/after (no full document numbers, no tokens).
- Office isolation for import and raw calls with two tenants on the shared account.
- Service key accepted only from `127.0.0.1` and only with a staff token.
