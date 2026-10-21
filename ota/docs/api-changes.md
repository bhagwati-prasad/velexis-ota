# OTA API changes, part 1

This document lists the spec-first changes to the OTA OpenAPI document that the MVP needs before the code is written: the cookie session mode of the hosted storefront, the airline-card payment method, the payment account modes in the storefront configuration, the OTA admin's first-party service credential, and the new error codes. Part 2, [`api-changes-console-and-internal.md`](api-changes-console-and-internal.md), covers console settings, console payments, public storefront pages and assets, and internal endpoints. For each change it gives the operation ids, `x-sdk-method`, a request and response sketch, the tables and the error codes, so that an agent can edit the document without guessing.

Related: [ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md) (workflow), [ADR-0008](../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [ADR-0011](../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md), [ADR-0018](../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md), [ADR-0019](../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md), [`data-model.md`](data-model.md), [`scope.md`](scope.md).

## 1. Target document and workflow

- **File:** `ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`, copied byte for byte from [`docs/velexis-sdk/openapi/`](../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml) by foundation task X-006. The planning brief called it `ota-api.openapi.yaml`; [ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md), X-006 and [`packages/README.md`](../../packages/README.md) fix the name above, and ADRs win. The copy under `docs/velexis-sdk/` stays frozen.
- **Order:** each change lands in the task that first needs it: §2 and §5 in M2 (the storefront's first POST is `flights.search`), §3 in M3, §4 in M3 (Velexis mode) and M5 (other modes), part 2 in M4.
- **Per change:** edit the YAML → `pnpm contracts:lint` → `pnpm contracts:generate` (types and `@velexis/errors`) → SDK method and JSDoc → handler → tests. New SDK methods and options are listed in `ota/sdk/docs/extensions.md`; the contract files in `docs/velexis-sdk/sdk/src/` are not edited ([ADR-0019](../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md)).
- **New vendor extensions** (documented in the document's `info.description`):

| Extension | On | Meaning |
|---|---|---|
| `x-edge-only: true` | operation | Only the storefront edge may call it; keys and the service key get `403 SCOPE_NOT_ALLOWED` |
| `x-internal: true` | operation, security scheme | Not for SDK users; excluded from the SDK and the public reference ([ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md)) |
| `x-sdk-exclude: true` | operation | Public, but used as a plain URL (images, downloads), so no SDK method; the SDK parity check skips it |
| `x-milestone` | operation | `M2`…`M6`, or `deferred` (route answers `501 NOT_IMPLEMENTED`); drives the route-parity allow-list |
| `x-permission` | console operation | The `StaffPermission` the operation needs, read by the scope guard |

## 2. (a) Cookie session mode for the hosted storefront

**Why.** The hosted storefront calls the API same-origin on `/api/*` through Caddy, with customer sessions in httpOnly cookies and a CSRF header, so no token is readable by JavaScript ([`decisions.md`](../../docs/mvp/decisions.md) §5, [ADR-0018](../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)). The contract only knows API keys and bearer tokens. Decisions in [OADR-0006](adr/0006-storefront-cookie-sessions-and-csrf.md).

### 2.1 Security schemes and parameters (components)

```yaml
components:
  securitySchemes:
    storefrontEdge:            # x-internal: set by Caddy, never by a browser
      type: apiKey
      in: header
      name: X-Velexis-Edge
      x-internal: true
      description: Edge credential of the hosted storefront. The tenant comes from X-Velexis-Host
        (verified storefront domain or <key>.ota.example.com); the environment from the tenant's
        storefront environment. Customer scope only.
    customerCookie:
      type: apiKey
      in: cookie
      name: __Host-vx_at
      description: Customer access token in an httpOnly cookie (edge mode only).
    bookingCookie:
      type: apiKey
      in: cookie
      name: __Host-vx_bt
      description: Guest booking tokens in an httpOnly cookie (edge mode only), up to 5 bookings.
  parameters:
    CsrfToken:
      name: X-CSRF-Token
      in: header
      required: false        # required by the CsrfGuard for edge callers on POST/PUT/PATCH/DELETE
      schema: { type: string, pattern: "^[A-Za-z0-9_-]{43}$" }
      description: Copy of the __Host-vx_csrf cookie. Required on state-changing edge requests.
  headers:
    Set-Cookie:
      description: Session, CSRF or guest cookies (edge mode only). Always HttpOnly (except
        __Host-vx_csrf), Secure, SameSite=Lax, Path=/.
      schema: { type: string }
```

`X-Velexis-Host` already exists as the parameter `StorefrontHostHeader` (for hosting keys); its description gains the edge use.

### 2.2 Operation changes

| Operations | Change |
|---|---|
| Every operation with `x-scope: customer` or `both` (63 contract operations, plus the new ones) | `security` gains `{storefrontEdge: []}`, and, where the operation accepts `customerAuth` or `bookingToken`, `{storefrontEdge: [], customerCookie: []}` and `{storefrontEdge: [], bookingCookie: []}`. State-changing ones reference `CsrfToken`. |
| `getStorefront` (`storefront.get`) | Edge mode: `Set-Cookie: __Host-vx_csrf=<random>` when the cookie is missing or malformed. `Cache-Control: private` in edge mode. |
| `signUp`, `resetPassword` | Edge mode: when a session is opened, tokens are set as `__Host-vx_at` and `__Host-vx_rt`, the CSRF cookie is rotated, and `session` is `null` in the body (`AuthSignUpResult.session` and `PasswordResetResult.session` are already nullable). |
| `signIn`, `refreshSession`, `changePassword` | Edge mode: cookies as above. Their `200` body (`AuthSessionResult`, whose `session` is required) becomes `oneOf: [AuthSessionResult, AuthSessionInfo]`, told apart by the presence of `session.accessToken`: token mode returns `AuthSessionResult` (unchanged), edge mode returns `AuthSessionInfo` (the schema of `auth.getSession`, no token fields). This changes the response type, which ADR-0006 allows only with an ADR: [OADR-0006](adr/0006-storefront-cookie-sessions-and-csrf.md) approves it before launch. |
| `refreshSession` (`auth.refresh`) | `AuthRefreshRequest.refreshToken` becomes optional; in edge mode it comes from `__Host-vx_rt` and a body token is refused (`400 INVALID_REQUEST`). |
| `signOut`, `deleteAccount` | Edge mode: `Set-Cookie` clearing `__Host-vx_at`, `__Host-vx_rt` and rotating `__Host-vx_csrf`; `AuthSignOutRequest.refreshToken` comes from the cookie. |
| `completeCheckout`, `completeCheckoutWithAirlineCard` | Edge mode, guests: the token is added to `__Host-vx_bt`; `bookingToken` and `bookingTokenExpiresAt` are `null` in the body (already nullable for customers). |
| `lookupBooking` | Edge mode: the token is added to `__Host-vx_bt`. `BookingLookupResult.bookingToken` becomes nullable and is `null` in edge mode (same OADR-0006 approval). |
| Every customer-scope operation | Edge mode: `401 TOKEN_EXPIRED` tells the SDK to call `auth.refresh` once with cookies and retry. |

### 2.3 Cookies

| Cookie | HttpOnly | Max-Age | Content |
|---|---|---|---|
| `__Host-vx_at` | yes | 900 s | Customer access JWT |
| `__Host-vx_rt` | yes | Remaining family lifetime (12 h, or 30 days with `rememberMe`) | Refresh token |
| `__Host-vx_csrf` | **no** | 30 days, rotated at sign-in and sign-out | 256-bit random, base64url |
| `__Host-vx_bt` | yes | 30 days | Up to 5 `bkg_<id>.<token>` entries separated by `~`, newest first |

All cookies: `Secure`, `SameSite=Lax`, `Path=/`, no `Domain` (host-only, so a session on `acme.ota.example.com` never reaches another OTA).

### 2.4 Errors and tables

- New code `CSRF_TOKEN_INVALID` (403): the header is missing, differs from the cookie, or `Origin` does not match the verified host (§6).
- Unknown or unverified `X-Velexis-Host` with a valid edge secret → `403 HOST_NOT_ALLOWED` (existing code).
- Tables: `customer_sessions`, `booking_access_tokens` (unchanged). No new tables; the CSRF value is not stored server-side.

## 3. (b) Airline-card payment method

**Why.** [`decisions.md`](../../docs/mvp/decisions.md) §2 method (b): the card goes into `formOfPayments` (CREDIT_CARD) on Flight Create Orders and the airline charges it. [ADR-0011](../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) asks for a dedicated operation that completes the checkout in one request, hosted storefront only. Backend handling in [OADR-0004](adr/0004-airline-card-data-handling.md).

### 3.1 `checkout.createPayment` and `checkout.updatePayment` (existing operations)

| Schema | Change |
|---|---|
| `PaymentCreateRequest.method` | Enum adds `airline_card`. With it, `provider` must be absent, `returnUrl` and `savePaymentMethod` are ignored. |
| `Payment.method` | Enum adds `airline_card` |
| `Payment.provider` | Enum adds `airline` |
| `PaymentNextAction.type` | Enum adds `airline_card_form`: show the card form and call `checkout.completeWithAirlineCard` |
| `Payment.clientSecret`, `providerPublicKey`, `providerPaymentId` | Always `null` for airline payments |

Behaviour of `createPayment {method: "airline_card"}`: refused unless `AIRLINE_CARD_ENABLED` and the tenant setting for the environment are on (`403 FEATURE_DISABLED`, `details.feature = "airlineCard"`) and the caller is the edge (`403 SCOPE_NOT_ALLOWED`). It sets `checkouts.pricing_mode = net`, recomputes the totals as the Amadeus total plus the Amadeus card fee for the brand when known ([OADR-0004](adr/0004-airline-card-data-handling.md) §4), cancels any other active payment of the checkout, and inserts a `payments` row (`provider = airline`, `method = airline_card`, `capture_method = automatic`, status `requires_payment_method`). No provider is called. `updatePayment {card: {brand, bin}}` re-quotes the Amadeus credit-card fee exactly as for Stripe. Choosing `card` again restores `pricing_mode = markup_rules`.

### 3.2 New operation `checkout.completeWithAirlineCard`

```yaml
/v1/checkouts/{checkoutId}/airline-card-completion:
  post:
    operationId: completeCheckoutWithAirlineCard
    x-sdk-method: checkout.completeWithAirlineCard
    x-scope: customer
    x-edge-only: true
    x-milestone: M3
    tags: [Checkout]
    security:
      - { storefrontEdge: [] }
      - { storefrontEdge: [], customerCookie: [] }
    parameters:
      - { $ref: "#/components/parameters/IdempotencyKey" }   # required
      - { $ref: "#/components/parameters/CsrfToken" }
    x-amadeus:
      - { api: FlightOffersPrice, operationId: quoteAirOffers, method: POST, path: /v1/shopping/flight-offers/pricing }
      - { api: FlightCreateOrders, operationId: createFligtOrders, method: POST, path: /v1/booking/flight-orders }
    x-tenant-tables: [checkouts, checkout_travelers, checkout_contacts, checkout_ancillaries, checkout_remarks,
      priced_offers, payments, payment_events, bookings, booking_associated_records, booking_travelers,
      booking_contacts, booking_segments, booking_ancillaries, booking_remarks, booking_tickets,
      booking_events, booking_access_tokens, storefront_settings, notifications, supplier_requests, idempotency_keys]
    requestBody:
      content:
        application/json:
          schema: { $ref: "#/components/schemas/AirlineCardCompletionRequest" }
    responses:
      "201": { content: { application/json: { schema: { $ref: "#/components/schemas/CheckoutCompletion" } } } }
```

```yaml
AirlineCardCompletionRequest:
  type: object
  additionalProperties: false
  required: [paymentId, expectedTotal, card]
  properties:
    paymentId: { type: string, pattern: "^pay_[0-9A-Za-z]{16,40}$" }   # the airline_card payment
    expectedTotal: { $ref: "#/components/schemas/Money" }               # the amount the airline will charge
    card:
      type: object
      additionalProperties: false
      required: [brand, holderName, number, expiryMonth, expiryYear, securityCode]
      x-sensitive: true             # never logged, stored, cached or queued
      properties:
        brand: { $ref: "#/components/schemas/AmadeusPaymentBrand" }      # must be in accepted brands
        holderName: { type: string, minLength: 2, maxLength: 64, pattern: "^[A-Za-z .'-]+$" }
        number: { type: string, pattern: "^[0-9]{12,19}$" }              # Luhn checked by the server
        expiryMonth: { type: integer, minimum: 1, maximum: 12 }
        expiryYear: { type: integer, minimum: 2026, maximum: 2099 }
        securityCode: { type: string, pattern: "^[0-9]{3,4}$" }
```

Mapping to Amadeus: `formOfPayments: [{ creditCard: { brand, holder: holderName (upper case), number, expiryDate: "YYYY-MM", securityCode, flightOfferIds } }]` on Flight Create Orders with `issue=true`; `paymentOperationContext.interactionCondition = ECOMMERCE`; no `threeDomainSecure`. Because tickets are issued in the same call, Flight Order Issue never carries an airline card: if such an order comes back without tickets, the ticketing job does not retry it (the card is gone); the booking goes to manual review and staff decide in the console (another form of payment, or cancel) ([OADR-0004](adr/0004-airline-card-data-handling.md)).

Response: the `201 CheckoutCompletion` of `checkout.complete` (booking normally `ticketed`, payment `captured` with `card: {brand, last4}`). The body never echoes card fields.

| Error | When |
|---|---|
| `400 VALIDATION_FAILED` | Schema, Luhn (`fieldErrors[].code = "luhn"`), expired card (`"expired"`); messages never contain the value |
| `402 PAYMENT_DECLINED` | Amadeus or the airline refused the card; the attempt is counted, the booking row is `failed` |
| `403 FEATURE_DISABLED` | Kill switch or tenant setting off for the environment |
| `403 SCOPE_NOT_ALLOWED` | Caller is not the storefront edge |
| `403 PAYMENT_ATTEMPTS_EXCEEDED` | Three attempts on this checkout already; staff alerted (new code) |
| `403 CSRF_TOKEN_INVALID` | §2.4 |
| `409 PRICE_CHANGED`, `PAYMENT_AMOUNT_MISMATCH`, `SOLD_OUT`, `CHECKOUT_ALREADY_COMPLETED`; `410 CHECKOUT_EXPIRED`; `422 CHECKOUT_INCOMPLETE`, `TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID`, `UNPROCESSABLE` (brand not accepted) | As `checkout.complete`; the card is discarded |
| `429 RATE_LIMITED` | 5 per minute per IP, 60 per hour per tenant |
| `504 SUPPLIER_TIMEOUT` | Order may exist: `details.bookingId`; never retried with the card; reconciliation ends in a booking or manual review ([`architecture-booking.md`](architecture-booking.md) §4) |
| `502 SUPPLIER_ERROR`, `503 SUPPLIER_UNAVAILABLE` | As `checkout.complete` |

`checkout.complete` called on a checkout whose active payment is `airline_card` answers `422 UNPROCESSABLE` with `details.reason = "use_airline_card_completion"`.

## 4. (c) Payment account modes in the storefront configuration

**Why.** Stripe runs on Velexis's account by default, and later on the OTA's own account through Connect Standard or API keys ([ADR-0011](../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md)). The storefront must initialise Stripe.js correctly for each mode and show who the merchant is. The airline card must appear as a method.

`StorefrontPaymentConfig` (part of `storefront.get`) changes:

| Field | Change | Value per mode |
|---|---|---|
| `accountMode` | **new**, enum `velexis`, `connect_standard`, `api_keys` | From `payment_provider_connections.account_mode` |
| `publishableKey` | description | `velexis`, `connect_standard`: Velexis's publishable key of the environment (`STRIPE_PUBLISHABLE_KEY_TEST/LIVE`); `api_keys`: the OTA's own publishable key from the connection |
| `accountId` | description | `connect_standard`: `acct_…` (Stripe.js `stripeAccount`); otherwise `null` |
| `merchantName` | **new**, string | `velexis`: "Velexis on behalf of <OTA name>" (legal text confirmed by the ADR-0011 legal follow-up); otherwise the OTA name |
| `statementDescriptor` | **new**, string or null | `velexis`: `statement_descriptor_suffix` of the connection; otherwise `null` |
| `supportedMethods` | items enum adds `airline_card` | Added **only for the storefront edge** (the completion operation is `x-edge-only`), when the airline card is enabled for the tenant and environment and `AIRLINE_CARD_ENABLED` is on; `pk_` and `sk_` callers never get it |
| `airlineCard` | **new**, object or null | Edge only, under the same conditions: `{enabled, cardBrands: StorefrontCardBrand[], chargedBy: "airline", notice}`; `notice` is the localised text "The airline charges your card. The price is the airline's price." Always `null` for key callers |

- Tables: `storefront_settings` (`accepted_card_brands`, `airline_card_enabled_test/live`), platform `payment_provider_connections` (read-only), `tenants` (name).
- Errors: none new. No active payment connection and no airline card → `payment` stays as today and checkout answers `424 PAYMENT_PROVIDER_NOT_CONFIGURED`.
- M3 implements `velexis` only; the other two values appear when the platform creates such connections in M5, with no OTA code switch ([OADR-0010](adr/0010-stripe-gateway-and-payment-webhooks.md)).
- The response differs per caller (asset URLs, `airline_card`), so the backend caches only the caller-independent part of `storefront.get` and adds the caller-specific fields on each request ([OADR-0012](adr/0012-storefront-settings-assets-and-pages.md) point 7).

## 5. (f) OTA admin first-party service credential

**Why.** The OTA admin server calls the console with a service key and a staff token, and chooses the environment per request ([ADR-0008](../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md)); the contract takes the environment from the key. Decisions in [OADR-0011](adr/0011-console-access-staff-sessions-and-environments.md).

- New parameter on every `x-scope: console` operation:

```yaml
VelexisEnvironment:
  name: X-Velexis-Environment
  in: header
  required: false        # required when the service key is used, refused otherwise
  schema: { type: string, enum: [test, live] }
```

- The service key travels in `X-Api-Key` (the SDK's `secretKey`); the `apiKey` scheme description names it. It is accepted only on a direct loopback connection that did not come through Caddy (socket peer on loopback **and** no `X-Forwarded-For` or `X-Forwarded-Host`, which Caddy adds to every proxied request), only on console operations, and only with a staff token whose `tid` is the tenant (except `consoleSignIn` with `grantType = portal_token`). Sent to `api.ota.example.com` it is an unknown key (`401 INVALID_API_KEY`); sent through a storefront's `/api/*` it meets the edge header (`400 INVALID_REQUEST`) ([OADR-0009](adr/0009-caller-and-tenant-resolution.md) rule 1.2).
- The existing `CustomerEndUserIp` (`X-Velexis-End-User-IP`) and `CustomerEndUserAgent` (`X-Velexis-End-User-Agent`) header parameters are added to every console operation. With the service key they are **required** (a missing or malformed IP answers `400 VALIDATION_FAILED`): the OTA admin sends the staff member's address (the right-most `X-Forwarded-For` entry Caddy gave it) and user agent, and the backend uses them for the `console.auth.signIn` throttle (10 per minute per end-user IP), the lockout and `staff_actions`. For secret keys they keep the contract's meaning; other callers' values are ignored.
- Errors: `403 ENVIRONMENT_NOT_ALLOWED` (new): `live` asked while the tenant is not live, or by a test-only role; `400 VALIDATION_FAILED` when the header is missing with the service key.
- `ConsoleStaffSession` gains `environments: ["test"] | ["test", "live"]`, so the OTA admin can show the switch; `ConsoleStaffProfile` (`console.auth.me`) gains the same field, read on every call (OBE-059).

## 6. Error catalogue additions

Added to `x-error-catalogue` (and so to `@velexis/errors`) in the task that first throws them.

| Code | Status | Description | Thrown by |
|---|---|---|---|
| `CSRF_TOKEN_INVALID` | 403 | The CSRF header is missing or does not match the cookie, or the Origin is not the storefront host. | `CsrfGuard` (M2) |
| `PAYMENT_ATTEMPTS_EXCEEDED` | 403 | Too many airline-card attempts on this checkout; start a new checkout or use another method. | Airline-card route (M3) |
| `ENVIRONMENT_NOT_ALLOWED` | 403 | The requested environment is not available to this tenant or role. | Service-key console calls (M4) |
| `TEMPLATE_INVALID` | 422 | The notification template does not compile or uses a variable that is not allowed (`details.errors`). | Console settings (M4) |
| `ASSET_INVALID` | 422 | The uploaded file has a type, size or dimensions that are not allowed (`details.reason`). | Console settings (M4) |
| `NOT_IMPLEMENTED` | 501 | The operation is part of the contract but not available yet (`details.milestone`). | Route-parity allow-list (M2) |
