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
| Session results (token and server mode) | `auth.signIn`, `auth.refresh` and `auth.changePassword` feed the client's session like an automatic refresh (SDK-008): `onSessionRefreshed` gets `result.session` before the call resolves, and the tokens the client held and the refresh token the call presented count as rotated, so the client sends the new tokens wherever a token source still gives a replaced one. A client without `accessToken` and `refreshToken` only reports them and never starts sending a token; a call with its own `options.accessToken` or an `Authorization` header (the call's or the client's) feeds nothing and calls no hook; a staff client (`sessionKind: "staff"`) keeps its staff session; `auth.signUp` and `auth.resetPassword` are not adopted. |
| Cookie mode, auth results and params | `auth.refresh` sends an empty body; a `refreshToken` in the params of `auth.refresh` or `auth.signOut` is a `TypeError` before any request. Whatever a response says, `auth.signIn`, `auth.refresh` and `auth.changePassword` resolve without `session.accessToken` and `session.refreshToken`, and `auth.signUp` and `auth.resetPassword` with `session: null` (§6). |
| Retries after a refusal | A call sent again after `TOKEN_EXPIRED` or `CSRF_TOKEN_INVALID` keeps its `Idempotency-Key`; `checkout.completeWithAirlineCard` is never sent again (the session still refreshes or re-fetches the CSRF cookie for the next submit). |
| Airline-card completion | `checkout.completeWithAirlineCard` is never retried automatically, whatever `maxRetries` says, and sends a new `Idempotency-Key` with every call (one per submit). Its arguments never appear in errors, hooks or `toJSON()`: `onResponse` gets the method, the API path, the status, the request id and the duration only, and an error of the call is rebuilt without anything of the card that the API or a proxy might have echoed (card-named fields such as `card`, `number`, `holderName`, `securityCode`, `expiryMonth`, `expiryYear` and Amadeus `creditCard` / `holder` leave `details` and `supplier`; field errors keep `path`, `code` and `message`; the card number with or without separators, its last 12 digits, the security code and the holder name are replaced by `[redacted]` in every text and number; a `cause` is dropped when anything in it, its own fields and causes included (a fetch library's error may keep the request), holds a card value or a card-named field, or cannot be checked without running its code). Class, code, status, request id, `retryable`, `retryAfterSeconds` and the other details stay. |
| Long operations | Default timeouts from the route table: 60 s for `flights.search`, `flights.upsell`, `flights.price`, `console.bookings.issue`, `.cancel`, `.import`, `.retrieve`; 90 s for `checkout.complete` and `checkout.completeWithAirlineCard`. `options.timeoutMs` still wins. |
| Deferred operations | The API answers `501 NOT_IMPLEMENTED` (`details.milestone`); the SDK throws `ServerError` with that code and `retryable: false`. |
| Multipart | `console.settings.assets.upload` sends `multipart/form-data` built from a `Blob` or `File` (SDK-012): the parts `kind`, `fileName` (only when given) and `file`, the text parts first, so a server that reads the stream part by part meets `kind` before the file. Its `Idempotency-Key` (generated, or `options.idempotencyKey`) goes with every retry, and a retry sends the same form. The SDK sets no `Content-Type`: `fetch` adds `multipart/form-data` with its boundary, and a `Content-Type` in the call's `headers` is dropped. A `file` that is not a `Blob` (a `File` is one), a missing or blank `kind`, or a `fileName` that is not a non-blank string is a `TypeError` before any request. A plain `Blob` is sent with the file name `blob`; pass `fileName` for the name the console shows. |
| `If-Match` of settings and payments | `console.settings.markupRules.update` and `.delete`, `.feeRules.update` and `.delete`, `.storefront.update`, `.pages.update` and `.delete` and `console.payments.capture` require `ifMatch` like the booking updates (a version number is sent as `"<n>"`, an ETag string as it is; a missing or malformed one is a `TypeError` that names whose version it is, before any request). `console.settings.templates.put` sends `If-Match` only when `ifMatch` is given (the OTA already has its own template) and refuses a malformed one the same way; `console.settings.assets.delete` takes none. |
| Idempotency key fallback | Where `crypto.randomUUID` is missing (a non-secure browser context), keys come from `crypto.getRandomValues` formatted as UUID v4. |
| Option validation | `createVelexisClient`, `withOptions` and every method throw a `TypeError` before any request on an unknown or invalid option, naming the option but never its value: keys must carry their prefix (`pk_`, `sk_`, `hk_`, so a secret key passed as `publishableKey` is refused), only one key is allowed, `idempotencyKey` has 16 to 128 visible ASCII characters. |
| Error mapping details | A response without the error envelope gets a code from its status and is never a `SupplierError`. `retryable` is true for 429, 500, 502, 503, 504, `ACCOUNT_LOCKED`, `DOCUMENT_NOT_READY`, `NETWORK_ERROR` and `TIMEOUT`. `toJSON()` drops secret-named `details` entries (`bookingToken`, `bookingTokenExpiresAt`, …) and redacts API keys, bearer tokens and JWTs in texts. |
| Error constructor | Every error class takes an optional second argument `{ retryAfterSeconds?, cause? }` (the response's `Retry-After` for `RateLimitError`, the underlying failure of a `ConnectionError`). |
| `Page` | `Page<T>` is also exported as a class (`new Page(body, loadNextPage)`); list responses keep their extra fields on the page. |
| Namespace factories | The public modules re-export their namespace factories ([OADR-0016](../../docs/adr/0016-sdk-packaging-and-type-contract.md) point 1), so the package also exports `createStorefrontApi`, `createReferenceApi`, `createFlightsApi` and `createCheckoutApi` (and the factories of the later namespaces). They take the internal request core; applications use `createVelexisClient`. |
| `onResponse` | `path` is the API path without the base URL and the query string; failures of the hook are ignored. |

## 3. Methods added by the MVP

The working OpenAPI document gains these operations (96 + 32 = 128 SDK methods). All take `RequestOptions` as the last argument. Lists return `Page<T>`. Updates take `ifMatch` (the resource `version`) and state-changing calls send an `Idempotency-Key`. SDK-009 wrote `checkout.completeWithAirlineCard`; SDK-012 wrote the other 31 (`storefront.listPages`, `storefront.getPage`, `console.settings.*` and `console.payments.*`) and removed the last entries of the parity test's pending list. The parameter types of the console additions are exported from the package (`ConsoleListMarkupRulesParams` … `ConsoleRefundPaymentParams`, the schema aliases `MarkupRule` … `ConsolePaymentRefundRequest` and the namespace types `ConsoleSettingsApi` … `ConsolePaymentsApi`, after the contract's names in `console.js`); those of the two storefront methods are inferred from `StorefrontApi`.

### 3.1 Storefront and checkout

| `x-sdk-method` | HTTP | Parameters → result | Milestone | Notes |
|---|---|---|---|---|
| `storefront.listPages` | `GET /v1/storefront/pages` | `{ locale? }` → `StorefrontPageList` (`{ data: [{ slug, title, kind, showInFooter, sortOrder }] }`) | M4 | Published pages of the locale, each slug once, by `sortOrder`; a slug without a published page in the locale falls back to its page of the default locale. `locale` is a query parameter; without it the call's `Accept-Language` (the `locale` option), then the storefront's default locale. |
| `storefront.getPage` | `GET /v1/storefront/pages/{slug}` | `{ slug, locale? }` → `StorefrontPageContent` (`{ slug, locale, title, kind, blocks[], updatedAt }`) | M4 | `blocks` is a parsed tree (`StorefrontPageBlock`: `heading`, `paragraph`, `list`, `image`, with inline `text`, `strong`, `em`, `link`); render with `textContent` only. The locale falls back as in `listPages`; a page that is not published answers `404`. An image's `url` is a same-origin `/api/v1/assets/…` path in cookie mode and an absolute URL for key callers. Both page methods are public like `storefront.get` (every session mode) and leave the fetch cache mode to the caller (`options.cache`, `options.next`), since the API sends `Cache-Control: public` to key callers. |
| `checkout.completeWithAirlineCard` | `POST /v1/checkouts/{checkoutId}/airline-card-completion` | `CompleteWithAirlineCardParams`: `{ checkoutId, paymentId, expectedTotal, card: AirlineCard }` with `AirlineCard` = `{ brand, holderName, number, expiryMonth, expiryYear, securityCode }` → `CheckoutCompletion` | M3 | `x-edge-only`: hosted storefront only; key callers get `403 SCOPE_NOT_ALLOWED`. Idempotency key required (a new one per call); 90 s; never retried, never echoed (§2). `bookingToken` is `null` in cookie mode (§6). |

### 3.2 Console settings (`settings:read` / `settings:write`)

| `x-sdk-method` | HTTP | Parameters → result |
|---|---|---|
| `console.settings.markupRules.list` | `GET /v1/console/settings/markup-rules` | `{ active?, cursor?, limit? }` → `Page<MarkupRule>` |
| `console.settings.markupRules.create` | `POST …/markup-rules` | `MarkupRuleInput` → `MarkupRule` (+ `warnings[]`) |
| `console.settings.markupRules.get` | `GET …/markup-rules/{markupRuleId}` | `{ markupRuleId }` → `MarkupRule` |
| `console.settings.markupRules.update` | `PATCH …/markup-rules/{markupRuleId}` | `{ markupRuleId, ifMatch, ...MarkupRuleUpdate }` (any subset of `MarkupRuleInput`) → `MarkupRule` (+ `warnings[]`) |
| `console.settings.markupRules.delete` | `DELETE …/markup-rules/{markupRuleId}` | `{ markupRuleId, ifMatch }` → `void` |
| `console.settings.feeRules.{list,create,get,update,delete}` | `/v1/console/settings/fee-rules[/{feeRuleId}]` | Same shapes with `feeRuleId`, `FeeRule`, `FeeRuleInput`, `FeeRuleUpdate` |
| `console.settings.storefront.get` | `GET /v1/console/settings/storefront` | `{}` → `StorefrontSettings` |
| `console.settings.storefront.update` | `PATCH /v1/console/settings/storefront` | `{ ifMatch, ...StorefrontSettingsUpdate }` (whole sections of `StorefrontSettings`) → `StorefrontSettingsUpdateResult` (`StorefrontSettings` + `warnings[]`) |
| `console.settings.pages.list` | `GET /v1/console/settings/pages` | `{ locale?, published?, cursor?, limit? }` → `Page<StorefrontPage>` (`StorefrontPagePage`, drafts included, by `sortOrder`, `slug`, `locale`) |
| `console.settings.pages.create` | `POST …/pages` | `StorefrontPageInput` (`slug`, `locale`, `title`, `kind?`, `bodyMarkdown?`, `isPublished?`, `showInFooter?`, `sortOrder?`) → `StorefrontPage` |
| `console.settings.pages.get` | `GET …/pages/{pageId}` | `{ pageId }` → `StorefrontPage` |
| `console.settings.pages.update` | `PATCH …/pages/{pageId}` | `{ pageId, ifMatch, ...StorefrontPageUpdate }` (any subset of `kind`, `title`, `bodyMarkdown`, `isPublished`, `showInFooter`, `sortOrder`) → `StorefrontPage` |
| `console.settings.pages.delete` | `DELETE …/pages/{pageId}` | `{ pageId, ifMatch }` → `void` |
| `console.settings.assets.list` | `GET /v1/console/settings/assets` | `{ kind?, cursor?, limit? }` → `Page<StorefrontAsset>` (`StorefrontAssetPage`, newest first) |
| `console.settings.assets.upload` | `POST /v1/console/settings/assets` (multipart) | `{ file: Blob, kind, fileName? }` (`StorefrontAssetUpload`) → `StorefrontAsset` |
| `console.settings.assets.delete` | `DELETE /v1/console/settings/assets/{assetId}` | `{ assetId }` → `void` |
| `console.settings.templates.list` | `GET /v1/console/settings/notification-templates` | `{}` → `NotificationTemplateList` (`{ data: NotificationTemplate[] }`, effective templates) |
| `console.settings.templates.get` | `GET …/{templateKey}/{channel}/{locale}` | `{ templateKey, channel, locale }` → `NotificationTemplate` |
| `console.settings.templates.put` | `PUT …/{templateKey}/{channel}/{locale}` | `{ templateKey, channel, locale, ifMatch?, ...NotificationTemplateInput }` (`subject`, `bodyHtml`, `bodyText`, `isActive?`) → `NotificationTemplate` |
| `console.settings.templates.preview` | `POST …/preview` | `{ templateKey, channel, locale, ...NotificationTemplatePreviewRequest }` (`subject?`, `bodyHtml?`, `bodyText?`, `variables?`) → `NotificationTemplatePreview` (`{ subject, html, text }`) |
| `console.settings.templates.reset` | `POST …/reset` | `{ templateKey, channel, locale }` → `NotificationTemplate` (code default) |

Creates send an `Idempotency-Key`; updates and deletes are guarded by `ifMatch` instead (the SDK requires it, §2), `templates.put` takes `ifMatch` only when the OTA already has its own template, and `templates.preview` and `templates.reset` are safe to repeat (`x-idempotent-by-design`: retried without a key; the `PATCH` updates are never retried). Every `console.settings.*` and `console.payments.*` call sends `cache: "no-store"` unless it sets `cache` or `next`, and `X-Velexis-Environment` with the client's `environment`, like the rest of `console`. `templateKey` is a `NotificationTemplateKey`, `channel` is `email` and the fonts of `branding.fonts` are the `StorefrontFontFamily` values. Every console operation names the permission it needs in `x-permission` (`settings:read` or `settings:write` here; `none` for `console.auth.*`); `console.auth.me` returns the permissions of the signed-in staff member.

Pages and assets (OBE-091; [OADR-0012](../../docs/adr/0012-storefront-settings-assets-and-pages.md)): `bodyMarkdown` is the Markdown subset of `StorefrontPageMarkdown` (headings 2–4, paragraphs, bold, italic, one-level lists, `https:`, `mailto:`, `tel:` and `/p/<slug>` links, images `![alt](ast_…)` of `page_image` assets; alt texts of at most 300 and URLs of at most 2048 characters); anything else answers `422 UNPROCESSABLE` with `details.line`. A page's `slug` and `locale` are fixed at creation; one page per slug and locale (`409 CONFLICT`, `page_exists`), and a page whose slug a legal link names cannot be deleted, in any locale (`page_linked`; change the link first, or unpublish the page). `assets.upload` sends an `Idempotency-Key` and the parts `file` and `kind`, and `fileName` when given; the server sniffs the type (PNG, JPEG, WebP; ICO for favicons; never SVG) and refuses with `422 ASSET_INVALID` (`details.reason`: `type`, `size`, `dimensions`); a request body above 1 MB and 16 KB is refused as `size` without being read. A body that is not `multipart/form-data`, or a broken one, answers `400 INVALID_REQUEST` (`unsupported_media_type`, `malformed_multipart`); the SDK's own form never sends one. The storage key is the file's SHA-256 and one asset holds one file, so the same bytes again answer the existing asset for the same kind, and `409 CONFLICT` (`asset_exists`, with `details.assetId` and `details.kind`) for another kind (OBE-071). Assets never change, so `assets.delete` takes no `ifMatch`; an asset in use answers `409 CONFLICT` (`asset_in_use`). The asset files themselves are plain image URLs (`getPublicAsset`, `x-sdk-exclude`), not SDK methods.

### 3.3 Console payments (`payments:*`)

| `x-sdk-method` | HTTP | Parameters → result |
|---|---|---|
| `console.payments.list` | `GET /v1/console/payments` | `{ status?, provider?, method?, bookingId?, createdFrom?, createdTo?, cursor?, limit? }` → `Page<ConsolePayment>` (`ConsolePaymentPage`, newest first) |
| `console.payments.get` | `GET /v1/console/payments/{paymentId}` | `{ paymentId, refresh? }` → `ConsolePayment` |
| `console.payments.capture` | `POST /v1/console/payments/{paymentId}/capture` | `{ paymentId, ifMatch, amount?, reason }` (`ConsolePaymentCaptureRequest`) → `ConsolePayment` |
| `console.payments.refund` | `POST /v1/console/payments/{paymentId}/refunds` | `{ paymentId, amount, reason, reasonNote? }` (`ConsolePaymentRefundRequest`) → `ConsolePayment` |

OBE-090 fixed the schemas in the OpenAPI document (tag `Console payments`), and the generated types flow into the SDK. `ConsolePayment` is `Payment` with `environment`, `version`, `events` (`ConsolePaymentEvent`, redacted), `refunds` (`ConsolePaymentRefund`), `booking` (`{ id, reference, status }`) and `providerConnection` (`{ accountMode }`); its `clientSecret` is always `null`. `status`, `provider` and `method` of the list take one value or several (sent comma-separated). `capture` and `refund` send an `Idempotency-Key` (pass a stable `options.idempotencyKey` per staff action: a retry with the same key captures or asks for the refund once); `capture` also takes `ifMatch` (the payment's `version`, required by the SDK, §2) and answers the captured payment, `refund` answers `201` with the new `pending` refund in `refunds` (the payments queue sends it to Stripe, so the call makes no Stripe call). `get` with `refresh: true` reads the PaymentIntent from Stripe first. Permissions: `payments:read`, `payments:capture` and `payments:refund`.

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
| `console.bookings.list` params (`consoleListBookings` query) | `reconcileOutcome` (`found` \| `not_found` \| `manual_review`, list), `cancellationRequested`, `hasScheduleChange` (booleans): the needs-attention filters | part 2 §7 |
| `ConsoleTenant` (the `tenant` of `ConsoleStaffSession` and `ConsoleStaffProfile`) | `billingNotice?: "past_due" \| "trial_ending" \| null`: the platform's billing banner (M5; a missing field means none) | part 2 §3.1 |

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
