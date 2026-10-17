# Platform API inventory (part 2: keys, domains, connections, payments, billing)

This document continues the platform API inventory with the tenant resources managed in the portal: API keys, domains, Amadeus connections, payment connections, payout account and settlements, and billing. Conventions, authentication notation and the error catalogue are in [part 1](api-inventory.md); admin, webhook and internal endpoints are in [part 3](api-inventory-admin.md). Together they are the source of `platform/backend/openapi/velexis-platform-api.openapi.yaml`.

Related: [`architecture.md`](architecture.md), [`data-model.md`](data-model.md), flows [API keys](flows/api-keys.md), [custom domains](flows/custom-domains.md), [Amadeus](flows/amadeus-connection.md), [Stripe payments](flows/stripe-payments-account.md), [billing](flows/subscription-billing.md).

All paths below are under `/v1/tenants/{tenantId}` unless they start with `/v1/` themselves. Every write is audited in `platform_audit_log` in the same transaction; "audit" is not repeated in the tables.

## 1. API keys (`ApiKeysModule`)

Format, hashing and scopes: [PADR-0005](adr/0005-api-key-format-and-hashing.md).

| Operation | Method and path | Auth | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|---|
| `listApiKeys` | `GET …/api-keys?environment=&includeRevoked=` | `portal: owner, admin` | List keys | → `{data: [ApiKey {id, name, kind, environment, prefix, last4, allowedOrigins, scopes, createdAt, createdBy, lastUsedAt, expiresAt, revokedAt}]}` | `api_keys` | — | M1 |
| `createApiKey` | `POST …/api-keys` | `portal: owner, admin`; live secret keys MFA↑ | Create a key, shown once | `{name, kind: "publishable" \| "secret", environment, allowedOrigins?, scopes?, expiresAt?}` → `201 {apiKey: ApiKey, key}` (no-store) | `api_keys` | `PLAN_LIMIT_REACHED`, `LIVE_MODE_NOT_ENABLED`, `VALIDATION_FAILED` (origin or scope rules), `TENANT_NOT_ACTIVE`, `REAUTH_REQUIRED` | M1 (live M5) |
| `updateApiKey` | `PATCH …/api-keys/{keyId}` | `portal: owner, admin` | Rename, change origins | `{name?, allowedOrigins?}` → `ApiKey`; `api_key` invalidation | `api_keys` | `CONFLICT` (revoked), `VALIDATION_FAILED`, `TENANT_NOT_ACTIVE` ([PADR-0014](adr/0014-tenant-suspension-and-resume.md) item 5) | M1 |
| `rollApiKey` | `POST …/api-keys/{keyId}/roll` | as `createApiKey` | New key with the same settings; old one expires | `{expireOldIn: "now" \| "1h" \| "24h" \| "7d"}` → `201 {apiKey, key, previous: {id, expiresAt}}` (no-store) | `api_keys` | `CONFLICT` (revoked), `PLAN_LIMIT_REACHED` (only when `expireOldIn` is not `now`), `TENANT_NOT_ACTIVE`, `REAUTH_REQUIRED` | M1 |
| `revokeApiKey` | `POST …/api-keys/{keyId}/revoke` | `portal: owner, admin` | Revoke now | → `200 ApiKey`; `api_key` invalidation | `api_keys` | `CONFLICT` (already revoked), `TENANT_NOT_ACTIVE` | M1 |

Rules: publishable keys take `allowedOrigins` (exact `https://host[:port]`; `http://localhost:<port>` only for test keys; no wildcards) and no scopes. Secret keys take `scopes` from `ConsoleApiKeyScope` and `StaffPermission` of the OTA contract; default `["storefront"]`; permissions only with `console:automation`, which needs at least one. Keys count against `plans.limits.apiKeys` while not revoked and not expired.

## 2. Domains (`DomainsModule`)

Verification rules: [PADR-0004](adr/0004-custom-domain-verification.md).

| Operation | Method and path | Auth | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|---|
| `listDomains` | `GET …/domains` | `portal: member` | Sub-domain and custom domains | → `{data: [Domain {id, hostname, kind, purpose, isPrimary, verificationStatus, dnsRecords: [{type, name, value}], verificationDeadlineAt, lastCheckedAt, lastCheckError, tlsStatus, tlsExpiresAt, createdAt}]}` | `tenant_domains` | — | M1 |
| `addDomain` | `POST …/domains` | `portal: owner, admin`, `F:custom_domains` | Add a custom storefront domain | `{hostname}` → `201 Domain` (pending, with the DNS records to create) | `tenant_domains` | `DOMAIN_INVALID`, `DOMAIN_TAKEN`, `PLAN_LIMIT_REACHED`, `FEATURE_DISABLED`, `TENANT_NOT_ACTIVE` ([PADR-0014](adr/0014-tenant-suspension-and-resume.md) item 5) | M5 |
| `checkDomain` | `POST …/domains/{domainId}/check` | `portal: owner, admin` | Check DNS now (`pending` and `failed` custom domains); restarts a failed verification with a new 72 h window | → `202 Domain` | `tenant_domains`; job `domain.verify` | `CONFLICT` (sub-domain, or verified already), `RATE_LIMITED`, `TENANT_NOT_ACTIVE` | M5 |
| `makeDomainPrimary` | `POST …/domains/{domainId}/make-primary` | `portal: owner, admin` | Primary host for links and e-mails | → `200 Domain`; `domain` invalidation for both hosts | `tenant_domains` | `DOMAIN_NOT_VERIFIED`, `TENANT_NOT_ACTIVE` | M5 |
| `removeDomain` | `DELETE …/domains/{domainId}` | `portal: owner, admin` | Remove a custom domain | → `204`; `domain` invalidation; the sub-domain becomes primary again | `tenant_domains` | `CONFLICT` (`details.reason = "subdomain"`), `TENANT_NOT_ACTIVE` | M5 |

## 3. Amadeus connections (`SupplierConnectionsModule`)

Model: [ADR-0012](../../docs/mvp/adr/0012-amadeus-account-model.md), [PADR-0012](adr/0012-amadeus-office-pool.md), [PADR-0010](adr/0010-credential-submission-and-verification.md).

| Operation | Method and path | Auth | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|---|
| `listAmadeusConnections` | `GET …/amadeus-connections` | `portal: owner, admin, finance` | Test and live connections | → `{data: [AmadeusConnection {id, environment, credentialSource, status, officeIds, defaultOfficeId, queuingOfficeId, ownerOfficeId, clientId?, ticketingDefaults, monitoredQueues, lastVerifiedAt, lastError, pendingSubmission?: {id, status, errorCode}, version}]}` (never a secret) | `supplier_connections`, `credential_submissions` | — | M1 |
| `updateAmadeusConnection` | `PATCH …/amadeus-connections/{environment}` | `portal: owner, admin` | Office defaults, ticketing defaults, monitored queues | `If-Match`, `{defaultOfficeId?, queuingOfficeId?, ownerOfficeId?, ticketingDefaults?, monitoredQueues?}` → connection; `connection` invalidation | `supplier_connections` | `VALIDATION_FAILED` (an office of the defaults, `ticketingDefaults.automatedProcess` or `monitoredQueues` not in `officeIds`), `PRECONDITION_FAILED`, `NOT_FOUND`, `TENANT_NOT_ACTIVE` ([PADR-0014](adr/0014-tenant-suspension-and-resume.md) item 5) | M4 |
| `requestLiveAmadeus` | `POST …/amadeus-connections/live/request` | `portal: owner`, `F:live_switch` | Ask Velexis for a live office | `{note?}` → `202` live connection `pending_verification` (no office yet); ops e-mailed | `supplier_connections` | `CONFLICT` (live connection exists, or Velexis has no live Amadeus account yet), `FEATURE_DISABLED` (plan without live mode), `TENANT_NOT_ACTIVE` | M5 |
| `submitAmadeusCredentials` | `PUT …/amadeus-connections/{environment}/credentials` | `portal: owner, admin`, MFA↑, `F:own_amadeus` | Switch to the OTA's own credentials | `{clientId, clientSecret, officeIds[], defaultOfficeId, queuingOfficeId?, ownerOfficeId?}` (`clientSecret` write-only) → `202 {submission}` (the submission of `getCredentialSubmission`, `pending`); an open submission is superseded | `credential_submissions`; job `credentials.verify` | `VALIDATION_FAILED`, `REAUTH_REQUIRED`, `FEATURE_DISABLED`, `TENANT_NOT_ACTIVE` | M5 |
| `getCredentialSubmission` | `GET …/credential-submissions/{submissionId}` | `portal: owner, admin` | Poll a verification | → `{id, kind, environment, status, errorCode?, errorMessage?, createdAt, finishedAt?}` | `credential_submissions` | `NOT_FOUND` | M5 |

## 4. Payment connections (`PaymentConnectionsModule`)

Modes: [ADR-0011](../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md), [PADR-0011](adr/0011-stripe-connect-standard-and-api-key-connections.md).

| Operation | Method and path | Auth | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|---|
| `listPaymentConnections` | `GET …/payment-connections` | `portal: owner, admin, finance` | Stripe connection per environment | → `{data: [PaymentConnection {id, environment, provider, accountMode, status, accountReference?, publishableKey?, statementDescriptorSuffix, capabilities, connectedAt?, disconnectedAt?, webhookUrl?, pendingSubmission?, version}]}` | `payment_provider_connections`, `credential_submissions` | — | M1 |
| `updatePaymentConnection` | `PATCH …/payment-connections/{environment}` | `portal: owner, admin` | Statement descriptor suffix | `If-Match`, `{statementDescriptorSuffix}` → connection; `connection` invalidation | `payment_provider_connections` | `VALIDATION_FAILED`, `PRECONDITION_FAILED`, `NOT_FOUND`, `TENANT_NOT_ACTIVE` ([PADR-0014](adr/0014-tenant-suspension-and-resume.md) item 5) | M3 |
| `startStripeConnect` | `POST …/payment-connections/stripe-connect/start` | `portal: owner, admin`, MFA↑, `F:own_stripe` | Begin Connect Standard OAuth | → `200 {authorizeUrl, expiresAt}` (no-store); state in Redis 10 min | Redis `stripe:oauth:<sha256>` | `REAUTH_REQUIRED`, `FEATURE_DISABLED`, `TENANT_NOT_ACTIVE` | M5 |
| `completeStripeConnect` | `POST /v1/payment-connections/stripe-connect/callback` | `portal` (same account that started) | Finish OAuth | `{state, code}` or `{state, error, errorDescription}` → `200 {tenantId, connections: PaymentConnection[]}` | `payment_provider_connections`; Redis state `GETDEL` | `CONNECT_STATE_INVALID`, `STRIPE_ACCOUNT_ALREADY_CONNECTED`, `UNPROCESSABLE` (`access_denied`, `livemode_mismatch`), `PROVIDER_ERROR`, `FORBIDDEN` (no longer owner or admin), `TENANT_NOT_ACTIVE` | M5 |
| `submitStripeApiKeys` | `PUT …/payment-connections/{environment}/api-keys` | `portal: owner, admin`, MFA↑, `F:own_stripe` | Use the OTA's own Stripe keys | `{publishableKey, secretKey, webhookSecret}` (both secrets write-only) → `202 {submission, webhookUrl: "https://api.ota.example.com/webhooks/stripe/c/<ppc_id>", webhookEvents}` | `credential_submissions`; job `credentials.verify` | `VALIDATION_FAILED` (prefix or environment mismatch), `REAUTH_REQUIRED`, `TENANT_NOT_ACTIVE` | M5 |
| `useVelexisPayments` | `POST …/payment-connections/{environment}/use-velexis` | `portal: owner`, MFA↑ | Return to the Velexis account (deauthorises Connect; a failure there is logged and does not block, [PADR-0011](adr/0011-stripe-connect-standard-and-api-key-connections.md) item 6) | → `200 PaymentConnection` | `payment_provider_connections` | `PAYOUT_ACCOUNT_REQUIRED` (live), `TENANT_NOT_ACTIVE` | M5 |

## 5. Payout account and settlements (`SettlementsModule`)

Rules: [PADR-0003](adr/0003-settlement-of-velexis-collected-payments.md).

| Operation | Method and path | Auth | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|---|
| `getPayoutAccount` | `GET …/payout-account` | `portal: owner, finance` | Masked bank account | → `PayoutAccount {accountHolderName, countryCode, currency, scheme, last4, status, reviewNote?, updatedAt, version}` | `tenant_payout_accounts` | `NOT_FOUND` | M5 |
| `setPayoutAccount` | `PUT …/payout-account` | `portal: owner`, MFA↑, `F:settlements` | Set or replace it | `{accountHolderName, countryCode, currency, scheme: "iban", iban, bic?}` or `{…, scheme: "local", accountNumber, routingNumber}` (bank fields write-only) → `200 PayoutAccount` (status back to `pending_review`) | `tenant_payout_accounts`, `email_outbox` (ops) | `VALIDATION_FAILED` (IBAN checksum), `REAUTH_REQUIRED` | M5 |
| `listSettlements` | `GET …/settlements` | `portal: owner, finance` | Statements (not drafts) | → `{data: [SettlementSummary {id, periodStart, periodEnd, currency, status, netAmount, paidAt?}]}` | `settlements` | — | M5 |
| `getSettlement` | `GET …/settlements/{settlementId}` | `portal: owner, finance` | Statement totals | → `Settlement {…summary, grossAmount, refundsAmount, disputesAmount, stripeFeesAmount, velexisFeesAmount, adjustmentsAmount, feeBps, lineCount, payoutReference?, notes?}` | `settlements` | `NOT_FOUND` | M5 |
| `downloadSettlementLines` | `GET …/settlements/{settlementId}/lines.csv` | `portal: owner, finance` | Lines for reconciliation | → `text/csv` (type, occurredAt, amount, stripeFee, paymentIntentId, velexisPaymentId, checkoutId, description) | `settlement_lines` | `NOT_FOUND` | M5 |

## 6. Billing (`BillingModule`)

Rules: [ADR-0013](../../docs/mvp/adr/0013-subscription-billing-stripe-billing.md), [PADR-0002](adr/0002-stripe-billing-integration.md).

| Operation | Method and path | Auth | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|---|
| `getSubscription` | `GET …/subscription` | `portal: owner, finance` | Plan and status | → `Subscription {id, planCode, planName, status, billingProvider, billingInterval, trialEndsAt, currentPeriodEnd, cancelAtPeriodEnd, banner: null \| "past_due" \| "trial_ending" \| "canceled", canManageInStripe}` | `subscriptions`, `plans` | `NOT_FOUND` | M1 |
| `createCheckoutSession` | `POST …/billing/checkout-session` | `portal: owner`, Idem, `F:stripe_billing` | Choose or restart a paid plan | `{planCode, billingInterval}` → `201 {url, expiresAt}` | `billing_customers`, `subscriptions` | `CONFLICT` (an active Stripe subscription exists: use the Customer Portal), `PLAN_NOT_AVAILABLE`, `PROVIDER_ERROR` | M5 |
| `createCustomerPortalSession` | `POST …/billing/portal-session` | `portal: owner`, `F:stripe_billing` | Manage plan, card, cancellation in Stripe | → `201 {url}` (no-store) | `billing_customers` | `CONFLICT` (no Stripe customer yet), `PROVIDER_ERROR` | M5 |
| `listInvoices` | `GET …/invoices` | `portal: owner, finance` | Invoice history | → `{data: [Invoice {id, number, status, total, amountDue, amountPaid, periodStart, periodEnd, issuedAt, paidAt, hostedInvoiceUrl, invoicePdfUrl}]}` | `invoices` | — | M5 |
