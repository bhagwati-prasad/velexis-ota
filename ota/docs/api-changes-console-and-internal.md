# OTA API changes, part 2: console and internal

This document is part 2 of the spec-first changes to the OTA OpenAPI document. It adds what the OTA admin needs in M4 and the contract does not have: console settings for markup rules, fee rules, storefront settings (branding, theme, content pages, assets) and notification templates, plus console payments (list, capture, refund). It also adds the public storefront pages and assets the hosted storefront reads, and documents the internal endpoints (health, Stripe webhooks, signed file downloads). For each change it gives the operation ids, `x-sdk-method`, request and response sketches, tables and error codes. The workflow, vendor extensions and new error codes are in [part 1](api-changes.md).

Related: [`scope.md`](scope.md), [`data-model.md`](data-model.md), [OADR-0005](adr/0005-markup-and-fee-engine.md) (markups and fees), [OADR-0012](adr/0012-storefront-settings-assets-and-pages.md) (settings, assets, pages), [OADR-0013](adr/0013-notifications-and-booking-documents.md) (templates), [OADR-0010](adr/0010-stripe-gateway-and-payment-webhooks.md) (payments), [`flows/console-operations.md`](flows/console-operations.md).

## 1. Permissions

`StaffPermission` gains five values. The platform accepts them in key scopes without a change ([PADR-0005](../../platform/docs/adr/0005-api-key-format-and-hashing.md) rule 6). Role mapping is in [`scope.md`](scope.md) §1.3; the `StaffPermission` description is updated with it.

| New value | Allows |
|---|---|
| `settings:read` | Read markup and fee rules, storefront settings, pages, assets, templates |
| `settings:write` | Change them |
| `payments:read` | List and read payments with their events and refunds |
| `payments:capture` | Capture an authorised Stripe payment |
| `payments:refund` | Refund a captured Stripe payment |

Every console operation below carries `x-scope: console`, `x-permission`, the `VelexisEnvironment` header of part 1 §5, writes a `staff_actions` row when it changes something, when it is refused, or when it is a read that returns personal data of one person or a supplier record (viewing a customer, the PNR lookup, the order retrieve, the raw Amadeus reads; any other successful read writes none, [OADR-0011](adr/0011-console-access-staff-sessions-and-environments.md) point 8 as decided on 2026-10-21), and uses the common console errors: `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN` (`details.requiredPermission`), `403 SCOPE_NOT_ALLOWED`, `403 TENANT_SUSPENDED`, `404 NOT_FOUND`, `429 RATE_LIMITED`. Updates take `If-Match` (`412 PRECONDITION_FAILED`) and return `ETag`. Settings changes are environment-independent (one settings row per tenant), so `X-Velexis-Environment` only selects which test/live data a response shows, where it matters.

## 2. (d) Console settings

### 2.1 Markup rules (`markup_rules`)

| operationId | Method and path | `x-sdk-method` | Permission |
|---|---|---|---|
| `consoleListMarkupRules` | `GET /v1/console/settings/markup-rules` | `console.settings.markupRules.list` | `settings:read` |
| `consoleCreateMarkupRule` | `POST /v1/console/settings/markup-rules` | `console.settings.markupRules.create` | `settings:write` |
| `consoleGetMarkupRule` | `GET /v1/console/settings/markup-rules/{markupRuleId}` | `console.settings.markupRules.get` | `settings:read` |
| `consoleUpdateMarkupRule` | `PATCH /v1/console/settings/markup-rules/{markupRuleId}` | `console.settings.markupRules.update` | `settings:write` |
| `consoleDeleteMarkupRule` | `DELETE /v1/console/settings/markup-rules/{markupRuleId}` | `console.settings.markupRules.delete` | `settings:write` |

```yaml
MarkupRule:            # one row of markup_rules, camelCase
  required: [id, name, scope, calculation, appliesPer, priority, stackable, isDefault, isActive, version, createdAt, updatedAt]
  properties:
    id: { pattern: "^mkr_[0-9A-Za-z]{16,40}$" }
    name: string, description: string|null
    scope: { $ref: PricingRuleScope }        # {origins, destinations, originCountries, destinationCountries,
                                             #  carriers, cabins, travelerTypes, tripTypes, sources, channels, minNet, maxNet}
    calculation: [percentage, fixed, percentage_plus_fixed]
    percentage: decimal string|null          # "5.0000" = 5 %, -100..1000
    fixed: Money|null                        # amount + currency (fixed_amount, fixed_currency)
    appliesPer: [booking, traveler, segment]
    min: Money|null, max: Money|null
    priority: integer, stackable: boolean, isDefault: boolean, isActive: boolean
    activeFrom: date-time|null, activeUntil: date-time|null
MarkupRuleInput:       # create: name, scope, calculation and its values required; update: any subset
```

List: `?active=true|false`, ordered by `priority, id`, cursor pagination. Rules: the default rule (`isDefault`) cannot be deleted or have its scope narrowed (`409 CONFLICT`, `details.reason = "default_rule"`); deleting a rule keeps history (bookings and priced offers keep amounts, `markup_rule_id` becomes `NULL`). Changes apply to the next search; cached offers keep their prices until they expire ([OADR-0005](adr/0005-markup-and-fee-engine.md)). Errors: `400 VALIDATION_FAILED`, `409 CONFLICT`, `412`.

### 2.2 Fee rules (`fee_rules`)

Same five operations under `/v1/console/settings/fee-rules[/{feeRuleId}]`, operation ids `consoleListFeeRules`, `consoleCreateFeeRule`, `consoleGetFeeRule`, `consoleUpdateFeeRule`, `consoleDeleteFeeRule`, SDK `console.settings.feeRules.{list,create,get,update,delete}`.

```yaml
FeeRule:
  properties: id (fee_…), name, label, feeType [booking_service, payment_card, ticketing, change, cancellation, ancillary_service],
    scope (PricingRuleScope + cardBrands), calculation, percentage (0..100), fixed (Money), appliesPer,
    min, max, refundable, priority, isActive, activeFrom, activeUntil, version, createdAt, updatedAt
```

MVP rule: `change` fees are stored but unused (no exchanges in the MVP); `cancellation` fees feed `bookings.quoteCancellation`. Errors as 2.1.

### 2.3 Storefront settings (`storefront_settings`)

| operationId | Method and path | `x-sdk-method` | Permission |
|---|---|---|---|
| `consoleGetStorefrontSettings` | `GET /v1/console/settings/storefront` | `console.settings.storefront.get` | `settings:read` |
| `consoleUpdateStorefrontSettings` | `PATCH /v1/console/settings/storefront` | `console.settings.storefront.update` | `settings:write` |

```yaml
StorefrontSettings:
  properties:
    brand: { name, legalName, timeZone }
    branding:
      logoAssetId, logoDarkAssetId, logoSquareAssetId, faviconAssetId     # ast_… ids from §2.5
      colors: { primary, secondary, accent, background, text }            # #RRGGBB
      fonts: { heading, body }                                            # from a bundled font list
      cornerRadius: [none, small, medium, large]
    locales: { default, supported[] }            # MVP UI is English; content may be localised
    currencies: { default, supported[] }
    markets: { default, list: StorefrontMarket[] }
    features: { guestCheckout, customerAccounts, ancillaries, brandedFareUpsell, selfServiceCancellation }
    policies:
      ticketingPolicy: [issue_after_payment, issue_at_booking, manual_review]
      paymentTiming: [authorize_before_booking]     # capture_before_booking and pay_later refused in the MVP
      require3ds: boolean, acceptedCardBrands: AmadeusPaymentBrand[]
      requireEmailVerification: boolean
      offerTtlMinutes: 5..240, checkoutTtlMinutes: 5..1440
    airlineCard: { enabledTest: boolean, enabledLive: boolean }   # live writable only after the M6 review
    legal: { termsVersion, privacyVersion, links: [{kind, label, url | pageSlug}] }
    support: { email, phone, hours, helpCenterUrl, emergencyPhone }
    seo: { titleTemplate, defaultTitle, defaultDescription, ogImageAssetId, robots }
    consent: { regime, bannerRequired, policyVersion, categories[] }
    operations: { opsAlertEmail, bookingQueue: { number, category } }
    version: integer, updatedAt: date-time
```

- Validation: currencies against `reference.currencies`; `supported` lists contain the default; a font outside the bundled list, or an asset id of the wrong kind, is `422 UNPROCESSABLE`. `airlineCard.enabledLive = true` is refused (`403 FEATURE_DISABLED`) while `AIRLINE_CARD_ENABLED` is off. Turning on the airline card while active markup or fee rules exist returns a `warnings[]` entry: airline-card bookings are sold at the airline's price ([OADR-0004](adr/0004-airline-card-data-handling.md)).
- Effect: bumps `version`, deletes the `storefront.get` caches of both environments; the hosted storefront sees the change within 5 minutes (its `sessionStorage` cache).
- Errors: `400`, `412`, `422 UNPROCESSABLE`, `403 FEATURE_DISABLED`.

### 2.4 Content pages (`storefront_pages`, new table)

| operationId | Method and path | `x-sdk-method` | Permission |
|---|---|---|---|
| `consoleListStorefrontPages` | `GET /v1/console/settings/pages` | `console.settings.pages.list` | `settings:read` |
| `consoleCreateStorefrontPage` | `POST /v1/console/settings/pages` | `console.settings.pages.create` | `settings:write` |
| `consoleGetStorefrontPage` | `GET /v1/console/settings/pages/{pageId}` | `console.settings.pages.get` | `settings:read` |
| `consoleUpdateStorefrontPage` | `PATCH /v1/console/settings/pages/{pageId}` | `console.settings.pages.update` | `settings:write` |
| `consoleDeleteStorefrontPage` | `DELETE /v1/console/settings/pages/{pageId}` | `console.settings.pages.delete` | `settings:write` |

```yaml
StorefrontPage:
  properties: id (stp_…), slug (^[a-z0-9]+(-[a-z0-9]+)*$), locale, kind [content, terms, privacy, cookies,
    refund_policy, imprint, faq, about], title (≤ 120), bodyMarkdown (≤ 50 000 chars), isPublished,
    showInFooter, sortOrder, publishedAt, version, createdAt, updatedAt
```

The body is a **Markdown subset**: headings 2–4, paragraphs, bold, italic, bullet and numbered lists, links (`https:`, `mailto:`, `tel:` and relative `/p/<slug>`), and images that reference a `page_image` asset. Anything else (HTML, tables, code, other schemes) is refused with `422 UNPROCESSABLE` and `details.line`. One page per `(slug, locale)` (`409 CONFLICT`). A page referenced by `legal.links` cannot be deleted (`409 CONFLICT`).

### 2.5 Storefront assets (`storefront_assets`, new table)

| operationId | Method and path | `x-sdk-method` | Permission |
|---|---|---|---|
| `consoleListStorefrontAssets` | `GET /v1/console/settings/assets` | `console.settings.assets.list` | `settings:read` |
| `consoleUploadStorefrontAsset` | `POST /v1/console/settings/assets` (`multipart/form-data`: `file`, `kind`) | `console.settings.assets.upload` | `settings:write` |
| `consoleDeleteStorefrontAsset` | `DELETE /v1/console/settings/assets/{assetId}` | `console.settings.assets.delete` | `settings:write` |

`StorefrontAsset`: `id` (`ast_…`), `kind` (`logo`, `logo_dark`, `logo_square`, `favicon`, `og_image`, `page_image`), `contentType` (`image/png`, `image/jpeg`, `image/webp`; `image/x-icon` for favicons only), `sizeBytes` (≤ 1 MB), `width`, `height`, `fileName`, `url` (public, §4.2), `createdAt`. **No SVG** and no CSS uploads. The server sniffs the type from the magic bytes and reads the dimensions from the file header (logos ≤ 2000 × 2000). It does not re-encode images (no image library in the stack), so the admin tells staff that file metadata is kept; files are served with `nosniff` and `Content-Disposition: inline`. Errors: `422 ASSET_INVALID` (`details.reason`: `type`, `size`, `dimensions`), `409 CONFLICT` when settings or a page reference the asset. Idempotency-Key required on upload.

### 2.6 Notification templates (`notification_templates`)

| operationId | Method and path | `x-sdk-method` | Permission |
|---|---|---|---|
| `consoleListNotificationTemplates` | `GET /v1/console/settings/notification-templates` | `console.settings.templates.list` | `settings:read` |
| `consoleGetNotificationTemplate` | `GET /v1/console/settings/notification-templates/{templateKey}/{channel}/{locale}` | `console.settings.templates.get` | `settings:read` |
| `consolePutNotificationTemplate` | `PUT …/{templateKey}/{channel}/{locale}` | `console.settings.templates.put` | `settings:write` |
| `consolePreviewNotificationTemplate` | `POST …/{templateKey}/{channel}/{locale}/preview` | `console.settings.templates.preview` | `settings:read` |
| `consoleResetNotificationTemplate` | `POST …/{templateKey}/{channel}/{locale}/reset` | `console.settings.templates.reset` | `settings:write` |

- The list shows the **effective** template for every key the code knows: the tenant row if it exists, otherwise the code default (`customised: false`). `NotificationTemplate`: `key`, `channel` (`email` in the MVP), `locale`, `subject`, `bodyHtml`, `bodyText`, `variables[]` (the allow-list of that key, with descriptions), `customised`, `isActive`, `version`, `updatedAt`.
- `put` upserts the row (`If-Match` when it exists); the server compiles subject, HTML and text with Handlebars in strict mode and checks every variable against the allow-list → `422 TEMPLATE_INVALID` with `details.errors[{part, line, message}]`.
- `preview` renders with the template's `sample_data`, or with variables in the body, and returns `{subject, html, text}`. The OTA admin shows the HTML in a sandboxed `iframe` (`sandbox` without scripts).
- `reset` deletes the row, so the code default applies again.
- MVP keys: `auth.verify_email`, `auth.password_reset`, `booking.confirmed`, `booking.ticketed`, `booking.ticketing_delayed`, `booking.cancelled`, `booking.cancellation_requested`, `booking.not_confirmed`, `staff.ticketing_failed`, `staff.manual_review`, `staff.airline_card_alert`; since 2026-10-23 (OADR-0013 point 4 as revised, FIX-W28-NOTIFY) also `booking.updated`, after `booking.not_confirmed`; since 2026-10-24 (OADR-0013 point 4 as revised, FIX-W29-OTA) also `account.email_changed` and `account.deleted`, after `auth.password_reset`.

## 3. Console payments (`payments`, `payment_events`, `refunds`)

| operationId | Method and path | `x-sdk-method` | Permission | Stripe call |
|---|---|---|---|---|
| `consoleListPayments` | `GET /v1/console/payments` | `console.payments.list` | `payments:read` | none |
| `consoleGetPayment` | `GET /v1/console/payments/{paymentId}` | `console.payments.get` | `payments:read` | none (`?refresh=true` re-reads the PaymentIntent) |
| `consoleCapturePayment` | `POST /v1/console/payments/{paymentId}/capture` | `console.payments.capture` | `payments:capture` | capture |
| `consoleRefundPayment` | `POST /v1/console/payments/{paymentId}/refunds` | `console.payments.refund` | `payments:refund` | refund |

- List filters: `status`, `provider`, `method`, `bookingId`, `createdFrom`, `createdTo`; sort `-createdAt`; cursor. Only the selected environment's rows (`payments_status_idx`).
- `ConsolePayment` = `Payment` + `events[]` (`payment_events`, redacted), `refunds[]`, `booking: {id, reference, status}`, `providerConnection: {accountMode}`.
- `capture {amount?, reason}`: Stripe payments in `authorized` only; `amount` ≤ authorised (partial capture releases the rest). `Idempotency-Key` and `If-Match` required. Errors: `409 CONFLICT` (wrong status), `402 PAYMENT_DECLINED` (authorisation expired), `502 PAYMENT_PROVIDER_ERROR`.
- `refund {amount, reason, reasonNote?}`: Stripe payments `captured` or `partially_refunded`; `amount` ≤ captured − refunded − the refunds still in flight. Creates a `refunds` row (`pending`, `requested_by_type = staff`) and answers `201` with the payment and its new `pending` refund. The request makes no Stripe call: the payments queue sends the refund (`refund.submit`, idempotency key `refund:<rfd_id>`) and the webhooks finish it, so Stripe being down delays a refund and never refuses it, and there is no `502`. Errors: `422 UNPROCESSABLE` (`details.reason`: `amount_exceeds_captured`, `refund_via_airline` for airline-card payments, `currency_mismatch`), `409 CONFLICT` (`payment_not_refundable`).
- Captures and refunds that belong to a booking also write `booking_events`: `payment.captured` for a capture; `refund.requested` for a refund request, shown to the customer as a refund asked for; and `refund.succeeded` only when Stripe reports the refund `succeeded` (the webhook), because only Stripe's answer makes it refunded (lead decision 6 of 2026-10-22). A refund request never writes `payment.refunded` or `refund.succeeded`.

## 4. Public storefront pages and assets

### 4.1 Pages

| operationId | Method and path | `x-sdk-method` | `x-scope` | Milestone |
|---|---|---|---|---|
| `listStorefrontPages` | `GET /v1/storefront/pages` | `storefront.listPages` | both | M4 |
| `getStorefrontPage` | `GET /v1/storefront/pages/{slug}` | `storefront.getPage` | both | M4 |

- Published pages of the request locale (`Accept-Language`, falling back to the default locale). The list returns `{slug, title, kind, showInFooter, sortOrder}`.
- `getPage` returns `{slug, locale, title, kind, blocks[], updatedAt}`. `blocks` is the Markdown subset parsed **on the server** into a small JSON tree (`heading`, `paragraph`, `list`, `image`, with inline `text`, `strong`, `em`, `link`), so the storefront renders it with `createElement` and `textContent` and never with `innerHTML` ([`conventions.md` §4](../../docs/mvp/conventions.md#4-vanilla-storefront-otafrontend)).
- Cached like `storefront.get` (5 minutes per tenant, environment and locale). Errors: `404 NOT_FOUND`, `403 TENANT_SUSPENDED`.

### 4.2 Assets

| operationId | Method and path | Extensions |
|---|---|---|
| `getPublicAsset` | `GET /v1/assets/{tenantKey}/{assetId}.{ext}` | `x-sdk-exclude: true`, `security: []` |

- Used as a plain image URL. `storefront.get` returns same-origin paths for the edge (`/api/v1/assets/acme/ast_….png`) and absolute URLs on `api.ota.example.com` for key callers, so `img-src 'self'` holds on the hosted storefront ([ADR-0018](../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)).
- Served for `active` and `suspended` tenants (a suspended storefront still shows its logo on the maintenance page). Headers: `Cache-Control: public, max-age=31536000, immutable` (ids never change content), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`. Unknown tenant or asset → `404`.

## 5. (e) Internal endpoints

Documented under the tag `Internal` with `x-internal: true`; no SDK methods; blocked publicly by Caddy where noted ([ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md), [ADR-0016](../../docs/mvp/adr/0016-observability.md)).

| operationId | Method and path | Who calls | Milestone | Notes |
|---|---|---|---|---|
| `healthLive` | `GET /health/live` | Uptime monitor, deploy script | M0 | Public on `api.ota.example.com` only; `200 {status: "ok"}` |
| `healthReady` | `GET /health/ready` | Deploy script, on-VM check | M0 | Blocked publicly (and `/api/health/ready` on storefront hosts); PostgreSQL, Redis, oldest waiting job per queue |
| `receiveStripeVelexisWebhook` | `POST /webhooks/stripe/velexis/{environment}` | Stripe (Velexis account) | M3 | Raw body, `Stripe-Signature` verified with `STRIPE_WEBHOOK_SECRET_VELEXIS_<ENV>`; tenant from `metadata.velexis_tenant_id` (only Velexis creates PaymentIntents on this account) |
| `receiveStripeConnectWebhook` | `POST /webhooks/stripe/connect/{environment}` | Stripe Connect endpoint | M5 (documented in M4 by OBE-090) | Tenant **only** from `event.account` → `payment_provider_connections.account_reference`; metadata never selects the tenant |
| `receiveStripeConnectionWebhook` | `POST /webhooks/stripe/c/{connectionId}` | The OTA's own Stripe account (API-key mode) | M5 (documented in M4 by OBE-090) | Verified with that connection's encrypted webhook secret; tenant **only** from the path's connection |
| `downloadFile` | `GET /v1/files/{storageKey}?exp=…&sig=…` | Browsers following `bookings.getDocumentDownloadUrl` | M3 | `x-sdk-exclude`; HMAC-SHA-256 with `document-url.key`, valid 5 minutes; re-checks the tenant ([ADR-0017](../../docs/mvp/adr/0017-email-documents-storage.md)). Done by OBE-054 under the tag `Booking documents`, not `x-internal`: like `getPublicAsset` it is a public plain URL, part of the public reference |

Webhook answers: `200` once the event is stored as a `payment_events` row (or is a known duplicate, or has no known tenant: logged and acknowledged); `400` on a bad signature. On every endpoint, `metadata.velexis_tenant_id` and `metadata.velexis_environment`, when present, must match the tenant and environment the endpoint resolved, `event.livemode` must match the environment, and the payment is looked up only inside that tenant; a mismatch is logged as a security event and acknowledged with `200` without effect. Processing happens in `ota-stripe-events` ([OADR-0010](adr/0010-stripe-gateway-and-payment-webhooks.md)).

**No Caddy `ask` endpoint in the OTA backend.** On-demand TLS for custom domains asks the **platform** backend (`GET 127.0.0.1:3100/internal/tls/ask`), which owns `tenant_domains` ([ADR-0018](../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md), [PADR-0004](../../platform/docs/adr/0004-custom-domain-verification.md)). The OTA backend only resolves verified hosts for edge requests. Adding a second `ask` here would split one rule across two owners.

## 6. Summary of new operations

| Group | Count | SDK namespace | Milestone |
|---|---|---|---|
| Airline card (part 1) | 1 | `checkout.completeWithAirlineCard` | M3 |
| Markup rules, fee rules | 10 | `console.settings.markupRules`, `console.settings.feeRules` | M4 |
| Storefront settings | 2 | `console.settings.storefront` | M4 |
| Pages, assets | 8 | `console.settings.pages`, `console.settings.assets` | M4 |
| Templates | 5 | `console.settings.templates` | M4 |
| Console payments | 4 | `console.payments` | M4 |
| Public pages | 2 | `storefront.listPages`, `storefront.getPage` | M4 |
| Public asset, file download | 2 | none (`x-sdk-exclude`) | M3, M4 |
| Health, webhooks | 5 | none (`x-internal`) | M0, M3, M5 |

After the changes the document has 96 + 39 = **135 operations**, of which 128 have an `x-sdk-method` (96 + 32). They arrive in M3 (OBE-029: 1, OBE-039: 1, OBE-054: 1) and M4 (OBE-058: 17 settings operations; OBE-090: 4 console payments, the 2 health endpoints and the 2 M5 webhooks, documented ahead of their handler; OBE-091: 8 page and asset operations and the 3 public ones). So the M4 document is complete at 135 operations; the M5 spec task OBE-076 adds only the billing notice field, and `pending-operations.ts` holds the 19 deferred operations and the two M5 webhooks at the M4 exit.

## 7. Console bookings list: the needs-attention filters (OBE-061)

The work list of the OTA admin ([`flows/console-operations.md`](flows/console-operations.md) §3 step 3) needs filters the original `consoleListBookings` (`console.bookings.list`) does not have. Three optional query parameters are added; the operation, its answers and the SDK method stay as they are (additive: [ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md) Workflow step 1, and for the SDK's types [ADR-0019](../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md)):

| Parameter | Schema | Meaning (tables) |
|---|---|---|
| `reconcileOutcome` | array of `found`, `not_found`, `manual_review` (comma-separated, OR-ed) | `bookings.reconcile_outcome` after a supplier timeout ([OADR-0003](adr/0003-booking-orchestration-and-supplier-timeout-recovery.md)); `manual_review` is the "staff decide" view |
| `cancellationRequested` | boolean | `true`: a `booking_events` row `booking.cancellation_requested` and the booking not `cancelled` since; `false`: none open |
| `hasScheduleChange` | boolean | `true`: a `booking_events` row `booking.schedule_changed` (the row's `hasScheduleChange`); `false`: none |

With the existing `ticketingStatus=failed,manual_review` and `ticketingDeadlineBefore` = now + 24 h (with `status=confirmed,partially_ticketed`) they make the five needs-attention views; each is a filter of its own, AND-ed with the others. No new error code; the operation's description names the views, `booking_events` joins its `x-tenant-tables`, and the change-log row is in [`../backend/openapi/README.md`](../backend/openapi/README.md) §6.
