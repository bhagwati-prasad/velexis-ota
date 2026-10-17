# SDK extensions to the contract

This page lists everything the Velexis OTA SDK offers beyond the TypeScript contract in [`docs/velexis-sdk/sdk/src/`](../../../docs/velexis-sdk/sdk/src/): new client options, new behaviour, the 32 methods added by the MVP operations, new enum values and error codes, and the response types that differ in cookie mode. [ADR-0019](../../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md) requires this list because the contract files are never edited. Every entry here must also exist in the working OpenAPI document (`ota/backend/openapi/velexis-ota-booking-api.openapi.yaml`); a PR that adds an SDK option or method updates this page in the same PR.

Related: [SDK README](../README.md), [`types-and-builds.md`](types-and-builds.md) (contract test and approved deviations), [`../../docs/api-changes.md`](../../docs/api-changes.md) (part 1), [`../../docs/api-changes-console-and-internal.md`](../../docs/api-changes-console-and-internal.md) (part 2), [OADR-0016](../../docs/adr/0016-sdk-packaging-and-type-contract.md).

## 1. Client options

| Option | Type | Default | Meaning | Spec |
|---|---|---|---|---|
| `session` | `"token" \| "cookie"` | `"token"` | `"cookie"`: hosted-storefront mode. Same-origin `fetch` with cookies, `X-CSRF-Token` on writes, cookie refresh; keys and tokens refused with a `TypeError`. | [ADR-0019](../../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md), [OADR-0006](../../docs/adr/0006-storefront-cookie-sessions-and-csrf.md) |
| `environment` | `"test" \| "live"` | — | Sends `X-Velexis-Environment` on console operations. Used by the OTA admin with its service key; the API refuses the header from other callers. | [`api-changes.md`](../../docs/api-changes.md) §5, [OADR-0011](../../docs/adr/0011-console-access-staff-sessions-and-environments.md) |

`sessionKind` and `onStaffSessionRefreshed` are not extensions: the contract adds them in `console.d.ts`.

## 2. Behaviour the contract does not describe

| Behaviour | Rule |
|---|---|
| Cookie mode, CSRF | Copies `__Host-vx_csrf` into `X-CSRF-Token` on `POST`, `PUT`, `PATCH`, `DELETE`. Missing cookie → one `GET /v1/storefront` first (shared by concurrent writes; `cache: "no-store"`, since a cached copy sets no cookie). `403 CSRF_TOKEN_INVALID` → one `GET /v1/storefront`, then one retry; never a loop. |
| Cookie mode, refresh | `401 TOKEN_EXPIRED` → one `POST /v1/auth/refresh` with an empty body (shared by concurrent calls), then one retry. Refused with `401` → `onSessionExpired`, `AuthenticationError`. |
| Cookie mode, environment | Needs `document`; `fetch` runs with `credentials: "same-origin"` and `mode: "same-origin"`; `baseUrl` defaults to `/api`. Keys (`hostingKey` included), tokens and `X-Api-Key` / `Authorization` headers are refused, at construction and per call; `withOptions` cannot leave the mode. |
| Secret key in a browser | `createVelexisClient({ secretKey })` throws a `TypeError` when `globalThis.document` exists. |
| Automatic refresh (token and server mode) | The refresh carries the API key only (never the expired access token) and the call's host and end user. The client keeps the rotated tokens: a token source that still gives a rotated token (a string always does) is replaced by the new one, so a rotated refresh token is never presented twice; `withOptions` starts from the new string tokens. A call with its own `options.accessToken` or an `Authorization` header (the call's or the client's) is not refreshed. Hook errors are ignored. |
| Retries after a refusal | A call sent again after `TOKEN_EXPIRED` or `CSRF_TOKEN_INVALID` keeps its `Idempotency-Key`; `checkout.completeWithAirlineCard` is never sent again (the session still refreshes or re-fetches the CSRF cookie for the next submit). |
| Airline-card completion | `checkout.completeWithAirlineCard` is never retried automatically, whatever `maxRetries` says, and its arguments never appear in errors, hooks or `toJSON()`. |
| Long operations | Default timeouts from the route table: 60 s for `flights.search`, `flights.upsell`, `flights.price`, `console.bookings.issue`, `.cancel`, `.import`, `.retrieve`; 90 s for `checkout.complete` and `checkout.completeWithAirlineCard`. `options.timeoutMs` still wins. |
| Deferred operations | The API answers `501 NOT_IMPLEMENTED` (`details.milestone`); the SDK throws `ServerError` with that code and `retryable: false`. |
| Multipart | `console.settings.assets.upload` sends `multipart/form-data` built from a `Blob` or `File`. |
| Idempotency key fallback | Where `crypto.randomUUID` is missing (a non-secure browser context), keys come from `crypto.getRandomValues` formatted as UUID v4. |
| Option validation | `createVelexisClient`, `withOptions` and every method throw a `TypeError` before any request on an unknown or invalid option, naming the option but never its value: keys must carry their prefix (`pk_`, `sk_`, `hk_`, so a secret key passed as `publishableKey` is refused), only one key is allowed, `idempotencyKey` has 16 to 128 visible ASCII characters. |
| Error mapping details | A response without the error envelope gets a code from its status and is never a `SupplierError`. `retryable` is true for 429, 500, 502, 503, 504, `ACCOUNT_LOCKED`, `DOCUMENT_NOT_READY`, `NETWORK_ERROR` and `TIMEOUT`. `toJSON()` drops secret-named `details` entries (`bookingToken`, `bookingTokenExpiresAt`, …) and redacts API keys, bearer tokens and JWTs in texts. |
| Error constructor | Every error class takes an optional second argument `{ retryAfterSeconds?, cause? }` (the response's `Retry-After` for `RateLimitError`, the underlying failure of a `ConnectionError`). |
| `Page` | `Page<T>` is also exported as a class (`new Page(body, loadNextPage)`); list responses keep their extra fields on the page. |
| `onResponse` | `path` is the API path without the base URL and the query string; failures of the hook are ignored. |

## 3. Methods added by the MVP

The working OpenAPI document gains these operations (96 + 32 = 128 SDK methods). All take `RequestOptions` as the last argument. Lists return `Page<T>`. Updates take `ifMatch` (the resource `version`) and state-changing calls send an `Idempotency-Key`.

### 3.1 Storefront and checkout

| `x-sdk-method` | HTTP | Parameters → result | Milestone | Notes |
|---|---|---|---|---|
| `storefront.listPages` | `GET /v1/storefront/pages` | `{ locale? }` → `{ data: [{ slug, title, kind, showInFooter, sortOrder }] }` | M4 | Published pages of the locale |
| `storefront.getPage` | `GET /v1/storefront/pages/{slug}` | `{ slug, locale? }` → `{ slug, locale, title, kind, blocks[], updatedAt }` | M4 | `blocks` is a parsed tree; render with `textContent` only |
| `checkout.completeWithAirlineCard` | `POST /v1/checkouts/{checkoutId}/airline-card-completion` | `{ checkoutId, paymentId, expectedTotal, card: { brand, holderName, number, expiryMonth, expiryYear, securityCode } }` → `CheckoutCompletion` | M3 | `x-edge-only`: hosted storefront only; key callers get `403 SCOPE_NOT_ALLOWED`. Idempotency key required. |

### 3.2 Console settings (`settings:read` / `settings:write`)

| `x-sdk-method` | HTTP | Parameters → result |
|---|---|---|
| `console.settings.markupRules.list` | `GET /v1/console/settings/markup-rules` | `{ active?, cursor?, limit? }` → `Page<MarkupRule>` |
| `console.settings.markupRules.create` | `POST …/markup-rules` | `MarkupRuleInput` → `MarkupRule` |
| `console.settings.markupRules.get` | `GET …/markup-rules/{markupRuleId}` | `{ markupRuleId }` → `MarkupRule` |
| `console.settings.markupRules.update` | `PATCH …/markup-rules/{markupRuleId}` | `{ markupRuleId, ifMatch, ...Partial<MarkupRuleInput> }` → `MarkupRule` |
| `console.settings.markupRules.delete` | `DELETE …/markup-rules/{markupRuleId}` | `{ markupRuleId, ifMatch }` → `void` |
| `console.settings.feeRules.{list,create,get,update,delete}` | `/v1/console/settings/fee-rules[/{feeRuleId}]` | Same shapes with `FeeRule` / `FeeRuleInput` |
| `console.settings.storefront.get` | `GET /v1/console/settings/storefront` | `{}` → `StorefrontSettings` |
| `console.settings.storefront.update` | `PATCH /v1/console/settings/storefront` | `{ ifMatch, ...Partial<StorefrontSettings> }` → `StorefrontSettings` (+ `warnings[]`) |
| `console.settings.pages.{list,create,get,update,delete}` | `/v1/console/settings/pages[/{pageId}]` | `StorefrontPage` (Markdown subset in `bodyMarkdown`) |
| `console.settings.assets.list` | `GET /v1/console/settings/assets` | `{ kind?, cursor?, limit? }` → `Page<StorefrontAsset>` |
| `console.settings.assets.upload` | `POST /v1/console/settings/assets` (multipart) | `{ file: Blob, kind, fileName? }` → `StorefrontAsset` |
| `console.settings.assets.delete` | `DELETE /v1/console/settings/assets/{assetId}` | `{ assetId }` → `void` |
| `console.settings.templates.list` | `GET /v1/console/settings/notification-templates` | `{}` → `{ data: NotificationTemplate[] }` (effective templates) |
| `console.settings.templates.get` | `GET …/{templateKey}/{channel}/{locale}` | `{ templateKey, channel, locale }` → `NotificationTemplate` |
| `console.settings.templates.put` | `PUT …/{templateKey}/{channel}/{locale}` | `{ templateKey, channel, locale, ifMatch?, subject, bodyHtml, bodyText, isActive? }` → `NotificationTemplate` |
| `console.settings.templates.preview` | `POST …/preview` | `{ templateKey, channel, locale, subject?, bodyHtml?, bodyText?, variables? }` → `{ subject, html, text }` |
| `console.settings.templates.reset` | `POST …/reset` | `{ templateKey, channel, locale }` → `NotificationTemplate` (code default) |

### 3.3 Console payments (`payments:*`)

| `x-sdk-method` | HTTP | Parameters → result |
|---|---|---|
| `console.payments.list` | `GET /v1/console/payments` | `{ status?, provider?, method?, bookingId?, createdFrom?, createdTo?, cursor?, limit? }` → `Page<ConsolePayment>` |
| `console.payments.get` | `GET /v1/console/payments/{paymentId}` | `{ paymentId, refresh? }` → `ConsolePayment` |
| `console.payments.capture` | `POST /v1/console/payments/{paymentId}/capture` | `{ paymentId, ifMatch, amount?, reason }` → `ConsolePayment` |
| `console.payments.refund` | `POST /v1/console/payments/{paymentId}/refunds` | `{ paymentId, amount, reason, reasonNote? }` → `ConsolePayment` |

The exact schema names and fields are fixed in the OpenAPI document by the API tasks; the generated types flow into the SDK automatically.

## 4. Enum values and fields added to existing schemas

These need no SDK code (they come with the generated types), but storefront and admin code must handle them.

| Schema | Addition | Spec |
|---|---|---|
| `PaymentCreateRequest.method`, `Payment.method` | `airline_card` | [`api-changes.md`](../../docs/api-changes.md) §3.1 |
| `Payment.provider` | `airline` | §3.1 |
| `PaymentNextAction.type` | `airline_card_form` | §3.1 |
| `StorefrontPaymentConfig` | `accountMode`, `merchantName`, `statementDescriptor`, `airlineCard`, `supportedMethods` + `airline_card` (both airline-card fields only for the hosted storefront's edge calls; key callers never see them) | §4 |
| `StaffPermission` | `settings:read`, `settings:write`, `payments:read`, `payments:capture`, `payments:refund` | part 2 §1 |
| `ConsoleStaffSession` | `environments: ["test"] \| ["test", "live"]` | §5 |
| `BookingLookupResult.bookingToken` | nullable (`null` in cookie mode) | §2.2 |

## 5. Error codes added to the catalogue

`ErrorCode` in the contract is open (`string & {}`), so these need no type change. The SDK maps them by status.

| Code | Status | SDK class | Who sees it |
|---|---|---|---|
| `CSRF_TOKEN_INVALID` | 403 | `PermissionError` | Cookie mode; handled once automatically (§2) |
| `PAYMENT_ATTEMPTS_EXCEEDED` | 403 | `PermissionError` | Airline-card completion |
| `ENVIRONMENT_NOT_ALLOWED` | 403 | `PermissionError` | OTA admin console calls |
| `TEMPLATE_INVALID` | 422 | `ValidationError` | `console.settings.templates.put` |
| `ASSET_INVALID` | 422 | `ValidationError` | `console.settings.assets.upload` |
| `NOT_IMPLEMENTED` | 501 | `ServerError` | Deferred operations |

## 6. Cookie-mode response types (approved deviations)

| Method | Token mode (contract) | Cookie mode | Approved by |
|---|---|---|---|
| `auth.signIn`, `auth.refresh`, `auth.changePassword` | `AuthSessionResult` (with tokens) | `AuthSessionInfo` (no tokens); typed as the union | [OADR-0006](../../docs/adr/0006-storefront-cookie-sessions-and-csrf.md) |
| `auth.signUp`, `auth.resetPassword` | `session` may be `null` | `session: null` | already nullable |
| `checkout.complete`, `checkout.completeWithAirlineCard`, `bookings.lookup` | `bookingToken` for guests | `bookingToken: null` (token in `__Host-vx_bt`) | already nullable / OADR-0006 |

The contract test lists only the first row in `test/contract/deviations.ts`; the others are compatible with the contract types.
