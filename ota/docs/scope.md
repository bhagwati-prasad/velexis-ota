# OTA MVP scope

This document fixes what the OTA group (OTA backend, hosted storefront, OTA admin, JS SDK) delivers in the MVP: who the users are and what each role may do, what is in, out and later for each part, and which of the 96 operations of the OTA contract are built in which milestone and which are deferred. Plans and tests derive from it. It follows [`decisions.md`](../../docs/mvp/decisions.md) and the shared milestones M0–M6 of the [MVP index](../../docs/mvp/README.md#1-shared-milestones). The operations added by the MVP are specified in [`api-changes.md`](api-changes.md) and [`api-changes-console-and-internal.md`](api-changes-console-and-internal.md).

Related: [`architecture.md`](architecture.md), [platform scope](../../platform/docs/scope.md), [OpenAPI contract](../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml), [SDK guides B1–B4](../../docs/velexis-sdk/sdk/docs/).

## 1. Users, callers and roles

### 1.1 People

| Who | Identity | Reaches the OTA through | Notes |
|---|---|---|---|
| **Visitor** | none | Hosted storefront (`<key>.ota.example.com`) or a third-party frontend | Searches, prices, opens a checkout and books as a guest. |
| **Guest** | Booking access token (`booking_access_tokens`) | Hosted storefront: `__Host-vx_bt` cookie. Third party: `X-Booking-Token` | Access to one booking only, after booking or after a lookup by reference and last name. |
| **Customer** | `tenant_<key>.customers` + `customer_sessions` | Hosted storefront: `__Host-vx_at` / `__Host-vx_rt` cookies + CSRF. Third party: bearer tokens | Customers belong to one OTA. The same e-mail at two OTAs is two customers. |
| **OTA staff** | Portal account + `platform.tenant_memberships` (`stf_…`, role) | OTA admin `admin.ota.example.com`, signed in by SSO from the portal | Staff sessions are bound to one tenant ([OADR-0011](adr/0011-console-access-staff-sessions-and-environments.md)). |

### 1.2 Programs

| Caller | Credential | Scope |
|---|---|---|
| Hosted storefront | Edge secret + verified host, added by Caddy ([ADR-0018](../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)) | Customer scope only; the only caller allowed to submit an airline card |
| Third-party frontend (browser) | `pk_test_` / `pk_live_` with allowed origins | Customer scope |
| Third-party server | `sk_…` scoped `storefront` | Customer scope |
| Custom console | `sk_…` scoped `console` + staff token | Console scope, staff permissions |
| Automation job | `sk_…` scoped `console:automation` + explicit permissions, header `X-Velexis-Scope: console` | Console scope, the key's permissions only, audited as the key |
| OTA admin server | First-party service key from `127.0.0.1` + staff token + `X-Velexis-Environment` | Console scope ([ADR-0008](../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md)) |
| Stripe | Webhook signature | Webhook endpoints only |

Hosting keys (`hk_`) and `storefront.resolve` are **later**, as in the [platform scope](../../platform/docs/scope.md).

### 1.3 Staff roles and permissions

The five roles are those of `tenant_memberships.role`. The contract's `StaffPermission` gains five values in the MVP (`settings:read`, `settings:write`, `payments:read`, `payments:capture`, `payments:refund`; see [`api-changes-console-and-internal.md`](api-changes-console-and-internal.md) §1).

| Permission | owner | admin | agent | finance | viewer |
|---|---|---|---|---|---|
| `bookings:read`, `customers:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `bookings:write`, `bookings:issue`, `bookings:cancel` | ✓ | ✓ | ✓ | | |
| `queues:read`, `amadeus:read` | ✓ | ✓ | ✓ | | |
| `supplier_requests:read` | ✓ | ✓ | ✓ | ✓ | |
| `amadeus:write` (deferred raw writes) | ✓ | ✓ | | | |
| `payments:read`, `settings:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `payments:capture` | ✓ | ✓ | ✓ | ✓ | |
| `payments:refund` | ✓ | ✓ | | ✓ | |
| `settings:write` (markups, fees, storefront, pages, assets, templates) | ✓ | ✓ | | | |
| Live environment in the OTA admin | ✓ | ✓ | ✓ | ✓ | test only |

`allowUnpaid` issuance stays owner/admin only, as the contract says.

## 2. Scope per part

### 2.1 OTA backend (`ota/backend`)

| In the MVP | Out of the MVP | Later (trigger) |
|---|---|---|
| Tenant resolution by edge, `pk_`/`sk_` keys and the OTA admin service key, with Redis caches and `vx:invalidate` | Hosting keys `hk_`, custom API hosts | When an agency hosts several OTAs on one deployment |
| Customer auth with cookies (storefront) and bearer tokens (third party) | Social sign-in, passwordless | After launch |
| Staff sign-in by portal token; staff sessions in Redis | Console password grant (`console.auth.signIn` with password) | When third-party consoles are requested |
| Shopping: synchronous search, offers, upsell, price, ancillaries, fare rules | Asynchronous search mode, availability search | When serverless frontends need async search |
| Checkout, Stripe (Velexis account in M3; Connect and API keys in M5), airline card (M3 test, live after M6) | PayPal, Adyen, Checkout.com, wallets as separate methods | Per customer demand |
| Booking orchestration: create order, capture, issue, sync, reconcile, cancel (release, void, request only) | Automatic airline refunds after the void window, exchanges | When Amadeus refund APIs are added |
| Itinerary and e-ticket receipt PDFs, transactional e-mails | Invoices and credit notes as legal documents, SMS | When OTAs need invoicing in Velexis |
| Console: bookings, PNR import, queues, customers, supplier log, read-only raw Amadeus, payments, settings | Raw Amadeus writes, console-created bookings, data exports | When staff-assisted sales are required |
| Provisioning worker, tenant migrations, suspend and resume housekeeping | Tenant export and deletion jobs | Post-MVP ([PADR-0014](../../platform/docs/adr/0014-tenant-suspension-and-resume.md)) |

### 2.2 Hosted storefront (`ota/frontend`)

| In the MVP | Out of the MVP | Later |
|---|---|---|
| Home and search form, results with filters and sort, offer details, branded-fare upsell, price summary with ancillaries (M2) | Seat maps | When Amadeus seat map is added |
| Checkout: travellers, contacts, extras, special requests, Stripe Payment Element, airline-card form, confirmation (M3) | Pay later (holds) | After the ticketing deadline handling is proven |
| Sign-up, sign-in, e-mail verification, password reset, account page, delete account (M3) | Saved travellers, preferences, data export page | After launch |
| My bookings: upcoming, past, cancelled; booking detail, documents, change contacts, cancel; guest lookup (M3) | Changing traveller documents, buying extras after booking | After launch |
| OTA branding, content pages (terms, privacy, FAQ), test-mode banner (M2–M4) | Custom CSS, custom scripts, analytics tags | Never on payment pages ([ADR-0011](../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md)) |
| English UI, currencies from settings | Other UI languages | When the first non-English OTA signs |

### 2.3 OTA admin (`ota/admin`)

| In the MVP (M4) | Out of the MVP | Later |
|---|---|---|
| SSO from the portal, tenant shown, test/live switch | Sign-in without the portal | With third-party identity providers |
| Bookings list and detail; retrieve from Amadeus, patch, issue, cancel with refund, resync, notes | Creating bookings from the console | Staff-assisted sales |
| PNR lookup and import, queues and queue history | Queue item actions (remove, move) | Not in the 12 Amadeus operations |
| Payments list, capture, refund | Disputes handling | With Stripe dispute webhooks UI |
| Customers list and detail | Editing customers, GDPR export | After launch |
| Markup rules, fee rules, storefront settings and branding, content pages, assets, e-mail templates | Reports and dashboards beyond counts | After launch |
| Supplier request log, read-only raw Amadeus calls | Raw Amadeus create, issue, patch, cancel | When needed by support |

### 2.4 JS SDK (`ota/sdk`)

| In the MVP | Out of the MVP |
|---|---|
| Core (`createVelexisClient`, errors, retries, pagination), token mode and cookie mode (M2) | `next` and `react` helpers (post-MVP references) |
| `storefront`, `reference`, `flights` (M2); `auth`, `account`, `checkout`, `bookings` (M3); `console` (M4) | Behaviour of deferred operations: the methods exist (one per `x-sdk-method`) and surface the API's `501 NOT_IMPLEMENTED` |
| ESM and IIFE bundles, `.d.ts`, contract check | npm publication (M6 launch checklist) |

## 3. The 96 contract operations

"MVP Mx" means the operation is implemented and tested in milestone Mx. "Deferred" means the route answers `501 NOT_IMPLEMENTED` from the route-parity allow-list ([ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md); the code is added to the catalogue in [`api-changes.md`](api-changes.md) §6) and the SDK method exists. A **part** of an MVP operation that is switched off (a grant type, a mode, a field) answers `403 FEATURE_DISABLED` with `details.feature`. Totals: **77 MVP, 19 deferred**.

### 3.1 B1 Storefront, auth, account, reference (30: 20 MVP, 10 deferred)

| `x-sdk-method` | MVP | Note |
|---|---|---|
| `storefront.get` | M2 | Also issues the CSRF cookie in edge mode |
| `storefront.resolve` | Deferred | Hosting keys are later |
| `auth.signUp`, `auth.verifyEmail`, `auth.resendVerification`, `auth.signIn`, `auth.refresh`, `auth.signOut` | M3 | Cookie mode on the storefront |
| `auth.requestPasswordReset`, `auth.resetPassword`, `auth.changePassword`, `auth.getSession` | M3 | |
| `account.get`, `account.update` | M3 | |
| `account.delete` | M3 | Immediate soft delete (db README §7); the 30-day erasure job is M6 |
| `account.preferences.get`, `account.preferences.update` | Deferred | Defaults from storefront settings |
| `account.dataExports.create`, `account.dataExports.get` | Deferred | Access requests handled by the OTA manually |
| `account.savedTravelers.list`, `.create`, `.get`, `.update`, `.delete` | Deferred | `features.savedTravelers = false` |
| `reference.locations.search`, `reference.airports.get`, `reference.airlines.list`, `reference.airlines.get`, `reference.countries.list`, `reference.currencies.list` | M2 | |

### 3.2 B2 Flights (10: 9 MVP, 1 deferred)

| `x-sdk-method` | MVP | Note |
|---|---|---|
| `flights.search` | M2 | Synchronous only; `resultOptions.async` → `403 FEATURE_DISABLED` ([OADR-0002](adr/0002-offer-and-priced-offer-caching.md)) |
| `flights.getSearch`, `flights.listResults`, `flights.getOffer` | M2 | |
| `flights.upsell` | M2 | Branded Fares Upsell |
| `flights.availability` | Deferred | Console only; needed for console bookings |
| `flights.price`, `flights.getPricedOffer`, `flights.getAncillaries`, `flights.getFareRules` | M2 | |

### 3.3 B3 Checkout, payments, bookings (24: 21 MVP, 3 deferred)

| `x-sdk-method` | MVP | Note |
|---|---|---|
| `checkout.create`, `checkout.get`, `checkout.setTravelers`, `checkout.setContacts`, `checkout.setAncillaries`, `checkout.setRemarks` | M3 | |
| `checkout.createPayment`, `checkout.getPayment`, `checkout.updatePayment` | M3 | Methods `card` (Stripe) and `airline_card` |
| `checkout.complete` | M3 | Stripe path; airline card uses the new `checkout.completeWithAirlineCard` |
| `bookings.list`, `bookings.get`, `bookings.lookup`, `bookings.getTicketingStatus` | M3 | |
| `bookings.update` | M3 | `contacts` and `remarks` only; traveller documents and loyalty → `403 FEATURE_DISABLED` until later |
| `bookings.quoteCancellation`, `bookings.cancel` | M3 | Modes `release`, `void`, `request_only`, `not_allowed`; automatic `refund` mode later |
| `bookings.getFareRules`, `bookings.listDocuments`, `bookings.getDocumentDownloadUrl`, `bookings.listEvents` | M3 | |
| `bookings.getAncillaries`, `bookings.addAncillaries`, `bookings.createPayment` | Deferred | Extras after booking |

### 3.4 B4 Console (32: 27 MVP, 5 deferred)

| `x-sdk-method` | MVP | Note |
|---|---|---|
| `console.auth.signIn`, `console.auth.refresh`, `console.auth.signOut`, `console.auth.me` | M4 | Grant `portal_token` only; `password` → `403 FEATURE_DISABLED` |
| `console.bookings.list`, `.get`, `.patch`, `.issue`, `.cancel`, `.resync`, `.addNote`, `.retrieve` | M4 | |
| `console.bookings.findByRecordLocator`, `console.bookings.import` | M4 | Only orders owned by the tenant's offices |
| `console.bookings.create` | Deferred | Staff-assisted sales later |
| `console.queues.list`, `console.queues.listSnapshots` | M4 | Plus the queue poller |
| `console.customers.list`, `console.customers.get` | M4 | |
| `console.supplierRequests.list` | M4 | |
| `console.amadeus.searchFlightOffers`, `.getFlightOffers`, `.searchFlightAvailabilities`, `.upsellAirOffers`, `.quoteAirOffers`, `.getFlightOrder`, `.getFlightOrderByReference`, `.getQueue` | M4 | Read-only raw calls, permission `amadeus:read`, office isolation enforced |
| `console.amadeus.createFlightOrders`, `.issueFlightOrder`, `.patchFlightOrder`, `.cancelFlightOrder` | Deferred | They bypass booking orchestration and payments; bookings are changed through `console.bookings.*` |

### 3.5 Operations added by the MVP

| Area | Operations | Milestone | Specified in |
|---|---|---|---|
| Airline card | `checkout.completeWithAirlineCard` | M3 (test), live after M6 | [`api-changes.md`](api-changes.md) §3 |
| Storefront content | `storefront.listPages`, `storefront.getPage`; public asset download | M4 | [`api-changes-console-and-internal.md`](api-changes-console-and-internal.md) §4 |
| Console settings | `console.settings.markupRules.*` (5), `console.settings.feeRules.*` (5), `console.settings.storefront.get/update`, `console.settings.pages.*` (5), `console.settings.assets.list/upload/delete`, `console.settings.templates.list/get/put/preview/reset` | M4 | [`api-changes-console-and-internal.md`](api-changes-console-and-internal.md) §2 |
| Console payments | `console.payments.list`, `.get`, `.capture`, `.refund` | M4 | [`api-changes-console-and-internal.md`](api-changes-console-and-internal.md) §3 |
| Internal (no SDK method) | Health, Stripe webhooks, signed file download | M0–M5 | [`api-changes-console-and-internal.md`](api-changes-console-and-internal.md) §5 |

## 4. Features and acceptance (summary)

Acceptance criteria are refined per task in the plans. These are the ones every plan must keep.

| Id | Feature | Milestone | Key acceptance |
|---|---|---|---|
| OF-01 | Tenant resolution | M2 | AC1: edge requests resolve the tenant from a verified host and the tenant's storefront environment. AC2: a token of tenant A is rejected at tenant B. AC3: a suspended tenant answers `403 TENANT_SUSPENDED` within 60 s. |
| OF-02 | Search and price | M2 | AC1: search, results, offer, upsell and price work against the Amadeus stub with selling prices only in customer scope. AC2: expired results answer `410 SEARCH_EXPIRED` / `OFFER_EXPIRED`. |
| OF-03 | Customer auth in cookies | M3 | AC1: no token ever appears in a storefront response body or in JS-readable cookies. AC2: a state-changing call without a matching `X-CSRF-Token` answers `403 CSRF_TOKEN_INVALID`. |
| OF-04 | Stripe checkout | M3 | AC1: authorise with 3-D Secure, create the order, capture, issue. AC2: an Amadeus rejection voids the authorisation and keeps the checkout open. AC3: a timeout yields `504` and a reconciled booking within 15 minutes. |
| OF-05 | Airline-card checkout | M3, M6 | AC1: the card number never reaches a log, a table, Redis or a queue (tested with a test PAN through every path). AC2: only the hosted storefront may call it. AC3: off unless `AIRLINE_CARD_ENABLED` and the tenant setting for that environment are both on. |
| OF-06 | Ticketing | M3 | AC1: failed issuance is retried until 2 hours before the deadline, then staff are alerted. AC2: tickets are never issued twice (resync before every retry). |
| OF-07 | My bookings and guest access | M3 | AC1: upcoming, past and cancelled lists match db README §10. AC2: guest lookup answers the same `404` for a wrong reference and a wrong name, and is rate limited. |
| OF-08 | Change and cancel | M3 | AC1: contacts change at Amadeus and in the booking. AC2: release and void cancel the order and void or refund the payment once. |
| OF-09 | Console | M4 | AC1: every console call writes `staff_actions`. AC2: permissions follow §1.3. AC3: PNR import accepts only the tenant's offices. |
| OF-10 | Settings | M4 | AC1: markup and fee changes apply to the next search. AC2: storefront settings changes appear on the storefront within 5 minutes. AC3: templates that do not compile are refused with `422 TEMPLATE_INVALID`. |
| OF-11 | Provisioning worker | M1 | AC1: `tenant.provision` creates the schema, applies all migrations, seeds defaults and grants in one transaction, and reports `tenant.provisioned`. AC2: re-running it is harmless. |
| OF-12 | Own Stripe and own Amadeus | M5 | AC1: the gateways follow `account_mode` and `credential_source` with no code path per tenant. AC2: orders owned by a releasing Velexis office keep using the Velexis account. |
