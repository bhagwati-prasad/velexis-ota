# ADR-0011: Payments: Stripe and airline card

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (two methods, Velexis Stripe account by default, OTA's own Stripe later), lead architect (account modes, PCI controls, flow details)

## Context

[`decisions.md`](../decisions.md) §2 fixes two customer payment methods:

- **(a) Stripe**: online card payment with 3-D Secure.
- **(b) Credit card passed to the airline through Amadeus**: the card goes into `formOfPayments` (CREDIT_CARD) on Flight Create Orders or Issue, and the airline charges it.

Stripe runs on **Velexis's account by default**, and Velexis settles to the OTA. An OTA can later connect **its own account** through Stripe Connect (Standard, OAuth) or by entering API keys. Method (b) puts card data in transit through the OTA backend, so PCI DSS applies.

The OTA contract is already provider-agnostic. `checkout.createPayment` returns a `clientSecret` for the provider's front-end SDK, manual capture after the order exists, and webhooks update `payments` and `payment_events`. The contract describes card pass-through only through a PSP forwarding service and says "Velexis never receives card numbers". Method (b) changes that, so the contract is extended spec-first.

## Decision

### A. Stripe: three account modes

`platform.payment_provider_connections` gets an `account_mode` column (platform delta): `velexis`, `connect_standard` or `api_keys`. Every tenant gets a `velexis` connection for the test environment at provisioning (M1), and for live when it switches to live (M5).

| Mode | Milestone | API calls | Funds | Webhooks to the OTA backend |
|---|---|---|---|---|
| `velexis` (default) | M3 | Velexis's secret key (test or live) from the environment file. The row holds no secret. | Land on Velexis's Stripe balance. Velexis settles to the OTA. | `/webhooks/stripe/velexis/{test,live}`, one signing secret each |
| `connect_standard` | M5 | Velexis's platform key + `Stripe-Account: acct_…` (direct charges) after Connect OAuth. `account_reference` holds `acct_…`. | Land on the OTA's own Stripe account | `/webhooks/stripe/connect/{test,live}` (Connect endpoint; `event.account` names the OTA) |
| `api_keys` | M5 | The OTA's own secret key, envelope-encrypted ([ADR-0010](0010-secrets-envelope-encryption.md)) | Land on the OTA's own Stripe account | `/webhooks/stripe/c/<ppc_id>`, verified with the OTA's encrypted webhook secret |

Common rules for all modes:

- **PaymentIntents** with `capture_method = manual`, captured after the Amadeus order exists, as the contract specifies.
- 3-D Secure is handled by Stripe (`automatic`, or `any` when the OTA requires it).
- `metadata`: `velexis_tenant_id`, `velexis_environment`, `checkout_id`, `payment_id`.
- In `velexis` mode, a statement descriptor suffix carries the OTA's brand.
- The storefront uses Stripe.js and the Payment Element. Card data goes from the browser to Stripe directly, so the hosted storefront stays out of PCI scope for method (a), apart from the integrity of the page that loads Stripe.js.
- Webhook handling: verify the signature on the raw body, de-duplicate on `payment_events.provider_event_id`, answer `200` at once, process in the `ota-stripe-events` queue.
- Refunds and manual capture by OTA staff come in M4 through the console.

**Settlements (`velexis` mode, M5).**

1. The platform backend builds a monthly statement per OTA from **Stripe balance transactions** filtered by `metadata.velexis_tenant_id`: captured amounts, minus refunds, disputes, Stripe fees and Velexis fees.
2. It stores the statement in a platform settlements table (platform delta).
3. Velexis pays it by bank transfer, marked paid in the platform admin.

The platform never reads tenant schemas for this ([ADR-0003](0003-six-components-two-nestjs-backends.md)).

### B. Airline card through Amadeus

1. **Off by default.** Enabled per OTA and environment in OTA settings. Live airline-card payments are enabled only after the M6 security review.
2. **Only the hosted storefront** may submit an airline card in the MVP. The operation refuses publishable and secret keys. Third-party storefronts would bring their own PCI scope; they are post-MVP.
3. **A dedicated operation**, added spec-first to the OTA document. Its working name is `checkout.completeWithAirlineCard`; the OTA plan fixes the final path. It completes the checkout in one request with the card in the body (brand, holder, number, expiry, security code).
4. **Processing**, entirely in memory inside one request:
   - validate the card (Luhn, expiry, brand against `accepted_card_brands`);
   - call Flight Create Orders with `formOfPayments: [{ creditCard: … }]`;
   - set `issue = true`, so ticketing happens in the same call. The card is never needed again, and nothing has to keep it for a later Flight Order Issue.
5. **Record:** a `payments` row with `provider = 'airline'` (tenant delta: expand the CHECK list) and only brand, BIN (first 6), last 4 and the outcome. PCI truncation rules allow BIN and last 4.
6. **No 3-D Secure on this path** in the MVP, because there is no 3-D Secure server. The airline decides whether to accept. The checkout page tells the customer that the airline charges the card.
7. **Never queued, cached, stored or logged.** See the controls below.

### C. PCI DSS scope and controls (method b)

Velexis receives, processes and transmits card data on behalf of OTAs, so **Velexis is a service provider in scope for PCI DSS v4.0.1**. It completes **SAQ D for Service Providers** while it is under the level-1 threshold. The cardholder data environment is the VM: Caddy, the OTA API process and the hosted storefront's payment page.

| Control | Implementation |
|---|---|
| Card data only in memory | The request body is parsed into a short-lived object, passed to the Amadeus client and dropped. No retries through queues. `LimitCORE=0` on the units and swap disabled on the VM, so memory never reaches disk. |
| Never stored or logged | pino redaction paths for `number`, `securityCode`, `creditCard`, `card` ([ADR-0016](0016-observability.md)). Request-body logging is off everywhere. The exception filter never echoes input values. Ajv errors carry paths, not values. |
| Redaction in `supplier_requests` | The shared redactor (db README §8) masks `creditCard.number` to its last 4 and drops `securityCode` **before** the row is built. A unit test feeds a real-looking PAN through every persistence path and asserts that it is absent. `order_snapshot`, `idempotency_keys` and `staff_actions` use the same redactor. |
| TLS | TLS 1.2+ with HSTS on every public host (Caddy). Amadeus is called over HTTPS. Caddy reaches the API over loopback only. |
| CSP on the storefront | `script-src 'self' https://js.stripe.com`, no inline scripts, `frame-ancestors 'none'`, a tight `connect-src` ([ADR-0018](0018-hosted-storefront-custom-domains.md)). No third-party analytics or tag managers on the payment page. |
| Payment page integrity (req. 6.4.3, 11.6.1) | The scripts of the payment page are inventoried in the repository with their purpose. A daily job fetches the live page, hashes its scripts and security headers, and alerts on any change outside a deploy. |
| Dedicated, rate-limited endpoint | Limits per IP (5 per minute), per checkout (3 attempts in total) and per tenant (60 per hour). Repeated declines block the checkout and alert staff (card-testing defence). |
| Vulnerability management | Quarterly external ASV scans and internal scans. A penetration test before live airline-card payments are enabled. `unattended-upgrades` and weekly dependency updates. |
| Access and monitoring | SSH keys only, MFA on GitHub and the cloud console, `auditd` and AIDE file-integrity monitoring on the VM, alerts per [ADR-0016](0016-observability.md). |
| Documentation | Data-flow diagram, script inventory, incident response plan and responsibility matrix with OTAs, produced in M6. |

### D. Code structure

The OTA backend has a `PaymentGateway` interface with `StripeGateway` (all three modes) and `AirlineCardGateway`. The checkout module depends on the interface only. Stripe secrets are decrypted only inside the gateway.

## Consequences

### Positive

- OTAs can take payments on day one without their own Stripe account.
- Method (a) keeps card data out of Velexis systems entirely.
- The airline-card path is narrow and synchronous, so the PCI controls apply to one endpoint and one page.

### Negative

- **Velexis collects funds for OTAs in `velexis` mode.** Stripe's terms and local payment-services rules may restrict this. **Legal review and Stripe's written confirmation are required before live payments** (follow-up). If refused, the default becomes Stripe Connect with destination charges.
- Method (b) brings SAQ D obligations, scans and a penetration test. That is real recurring cost for a solo team.
- No 3-D Secure on airline-card payments means more declines and no liability shift.
- Forcing `issue = true` on airline-card bookings removes pay-later holds for that method.

### Follow-ups

- Decided during planning; revisit when Stripe card forwarding (Vault and Forward) or a third-party vault (VGS, Basis Theory) is available for the Amadeus endpoint. Card data would then go from the browser to the vault and from the vault to Amadeus, which takes Velexis out of the cardholder data path and back to SAQ A-level scope. The contract already describes this "card pass-through model".
- A 3-D Secure server for the airline-card path, if airlines' decline rates require it.

## Alternatives considered

- **Stripe Connect from day one** (Express or Standard). Cleaner funds flow, but slower OTA onboarding, which the product owner wants to avoid.
- **Only Stripe, no airline card.** Rejected by the product owner. Some airlines and markets need the airline to charge the card.
- **Storing cards for later issuance.** Much larger PCI scope (requirement 3). Rejected.

## References

- [`../decisions.md`](../decisions.md) §2, §5
- [`../../velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml`](../../velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml): `checkout.createPayment`, `checkout.complete`, `x-error-catalogue`
- [`../../velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md) §8 (redaction rule, cards never stored)
- [`../../amadeus-api/FlightCreateOrders_v1_Version_1.16_swagger_specification.json`](../../amadeus-api/FlightCreateOrders_v1_Version_1.16_swagger_specification.json) (`formOfPayments`)
- [ADR-0013](0013-subscription-billing-stripe-billing.md), [ADR-0016](0016-observability.md), [ADR-0018](0018-hosted-storefront-custom-domains.md)
- [`../architecture.md`](../architecture.md), flows (b) and (d)
