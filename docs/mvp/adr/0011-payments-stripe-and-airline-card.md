# ADR-0011: Payments: Stripe and airline card

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (two methods, Velexis Stripe account by default, OTA's own Stripe later), lead architect (account modes, PCI controls, flow details)
**Revisions:** 2026-10-12 (planning review): §C states the real scope (the whole VM and the systems that can change it, no segmentation) and every environment control has an owning task in [ADR-0027](0027-pci-scope-and-vm-controls.md).

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

Velexis receives, processes and transmits card data on behalf of OTAs, so **Velexis is a service provider in scope for PCI DSS v4.0.1**. It completes **SAQ D for Service Providers** while it is under the level-1 threshold.

**Scope.** There is no network segmentation inside the single VM, so the cardholder data environment (CDE) is **the whole VM**:

- every process on it: Caddy (including its admin endpoint), the OTA API and OTA worker, the platform API and worker, the portal, the platform admin, the OTA admin, PostgreSQL, Redis, and the storefront files with the payment pages;
- the systems that can change it or hold its data, which are in scope as connected or security-impacting systems: the GitHub repository and the Actions deploy job (the deploy key is root-equivalent, [ADR-0023](0023-release-artefact-and-deploy-user.md)), the developer's SSH path and workstation, the off-site backup bucket, and the accounts at the cloud provider, the DNS provider and the SMTP provider.

The card path itself stays narrow (below). The environment controls apply to everything listed above; [ADR-0027](0027-pci-scope-and-vm-controls.md) lists them per PCI DSS requirement, each with the task that builds it.

| Control | Implementation |
|---|---|
| Card data only in memory | The request body is parsed into a short-lived object, passed to the Amadeus client and dropped. No retries through queues. `LimitCORE=0` on the units and swap disabled on the VM, so memory never reaches disk. |
| Never stored or logged | pino redaction censors the whole `card`, `creditCard` and `formOfPayments` objects and `securityCode`/`cvc` at every depth the apps log, and the `err` serializer never includes request or response bodies (X-003, [ADR-0016](0016-observability.md)). Request-body logging is off everywhere. The exception filter never echoes input values. Ajv errors carry paths, not values. |
| Redaction in `supplier_requests` | The shared redactor (db README §8) masks `creditCard.number` to its last 4 and drops `securityCode` **before** the row is built. A unit test feeds a real-looking PAN through every persistence path and asserts that it is absent. `order_snapshot`, `idempotency_keys` and `staff_actions` use the same redactor. |
| TLS | TLS 1.2+ with HSTS on every public host (Caddy). Amadeus is called over HTTPS. Caddy reaches the API over loopback only. |
| CSP on the storefront | `script-src 'self' https://js.stripe.com`, no inline scripts, `frame-ancestors 'none'`, a tight `connect-src` ([ADR-0018](0018-hosted-storefront-custom-domains.md)). No third-party analytics or tag managers on the payment page. |
| Payment page integrity (req. 6.4.3, 11.6.1) | The scripts of both payment pages (`/checkout/pay-card.html`, `/checkout/pay-airline.html`) are inventoried in the repository with their purpose and the SHA-256 of each first-party script (OFE-023). A daily job fetches both live pages and every first-party script they load, compares each script's SHA-256 and each path's full CSP and security headers with the inventory, and alerts on any difference (X-030). |
| Dedicated, rate-limited endpoint | Limits per IP (5 per minute), per checkout (3 attempts in total) and per tenant (60 per hour). Repeated declines block the checkout and alert staff (card-testing defence). |
| Vulnerability management | A recurring calendar: quarterly external ASV scans and internal scans, a penetration test before live airline-card payments and then yearly and after every significant change (req. 11.3, 11.4), recorded in `ota/docs/pci/README.md` (OBE-085, OBE-086). `unattended-upgrades` and weekly dependency updates. |
| Web attacks (req. 6.4.2) | A web application firewall in Caddy (Coraza with the OWASP Core Rule Set) in front of every public host, blocking on the storefront `/api/*` and the payment pages (X-039, [ADR-0027](0027-pci-scope-and-vm-controls.md)). |
| Access | SSH keys plus a second factor for people (req. 8.4.2, X-037); the `deploy` key is a restricted service account with one sudo command. MFA on GitHub, the cloud console and the backup bucket. One system user per trust zone ([ADR-0026](0026-system-users-per-trust-zone.md), X-033). Caddy's admin API only on a unix socket that only the `caddy` user can open. |
| Monitoring and log retention (req. 10) | `auditd` and AIDE on the VM, alerts per [ADR-0016](0016-observability.md). Security logs (auditd, sshd, sudo, Caddy, app security events) kept 3 months on the VM and shipped off the VM with 12-month retention, with a daily automated review that alerts the developer (X-038). |
| Change control of the CDE | Releases built in a job without secrets and deployed by a separate job behind the `production` environment (main and release tags only); actions pinned by commit SHA ([ADR-0023](0023-release-artefact-and-deploy-user.md)). |
| Documentation | Data-flow diagram, script inventory, incident response plan, scan and test calendar, and responsibility matrix with OTAs that references the controls of ADR-0027, produced in M6 (OBE-085). |

### D. Code structure

The OTA backend has a `PaymentGateway` interface with `StripeGateway` (all three modes) and `AirlineCardGateway`. The checkout module depends on the interface only. Stripe secrets are decrypted only inside the gateway.

## Consequences

### Positive

- OTAs can take payments on day one without their own Stripe account.
- Method (a) keeps card data out of Velexis systems entirely.
- The card data path is narrow and synchronous (one operation, two pages, memory only), so the data-handling controls stay small and testable.

### Negative

- **Velexis collects funds for OTAs in `velexis` mode.** Stripe's terms and local payment-services rules may restrict this. **Legal review and Stripe's written confirmation are required before live payments** (follow-up). If refused, the default becomes Stripe Connect with destination charges.
- Method (b) brings SAQ D obligations, scans and a penetration test. That is real recurring cost for a solo team.
- Without segmentation, **every component on the VM and every system that can change it is in scope**: the portal and both admins, the platform backend, PostgreSQL, Redis, Caddy, the deploy pipeline and the backup bucket get the full environment controls of ADR-0027. A vault or forwarding service (follow-up), or a separate segmented host for the card path, would shrink that scope.
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
