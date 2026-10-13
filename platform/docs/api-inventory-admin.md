# Platform API inventory (part 3: platform admin, webhooks, internal)

This document ends the platform API inventory with the endpoints of the platform admin (`/v1/admin/…`), the Stripe webhook receivers and the internal endpoints used by Caddy and the health checks. Conventions, authentication notation and the error catalogue are in [part 1](api-inventory.md); tenant resources are in [part 2](api-inventory-resources.md). All three parts are the source of `platform/backend/openapi/velexis-platform-api.openapi.yaml`, where these operations carry `x-scope: platform_admin`, `webhook` or `internal`, and webhook and internal ones also `x-internal: true`.

Related: [`flows/platform-admin-operations.md`](flows/platform-admin-operations.md), [PADR-0006](adr/0006-platform-admin-access-and-audit.md), [`../admin/README.md`](../admin/README.md).

## 1. Rules for every admin endpoint

- Auth `admin`: an access token with audience `platform_admin`, issued only after password **and** TOTP; the guard re-reads `is_platform_admin` and `status` on every call.
- Every admin call that changes state writes `platform_audit_log` with `actor_type = 'platform_admin'`, in the same transaction. Reads of sensitive data (payout account reveal, audit export) are audited too.
- Actions marked **reason** require `{reason}` (5–500 characters), stored in the audit `details`.
- Actions marked MFA↑ require a TOTP step-up within the last 15 minutes (`POST /v1/admin/auth/step-up`).
- Admin endpoints never touch tenant schemas. Tenant data such as bookings is out of reach by design.

## 2. Admin auth and dashboard

| Operation | Method and path | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|
| `adminSignIn` | `POST /v1/admin/auth/sign-in` (public) | Password step | `{email, password}` → `200 {mfaChallengeToken, expiresIn: 300}` | `accounts`, audit | `INVALID_CREDENTIALS` (also for non-admins), `MFA_REQUIRED` (admin without MFA), `ACCOUNT_LOCKED`, `RATE_LIMITED` | M1 |
| `adminVerifyMfa` | `POST /v1/admin/auth/mfa/verify` (public) | TOTP step | `{mfaChallengeToken, code \| recoveryCode}` → `200 AdminSession` (12 h family) | `account_sessions` (`audience = platform_admin`), audit | `MFA_CHALLENGE_INVALID`, `MFA_CODE_INVALID` | M1 |
| `adminRefresh` | `POST /v1/admin/auth/refresh` (public) | Rotate | `{refreshToken}` → `AdminSession` | `account_sessions` | `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED` | M1 |
| `adminStepUp` | `POST /v1/admin/auth/step-up` | Fresh TOTP | `{code}` → `AdminSession` | `account_sessions` | `MFA_CODE_INVALID` | M1 |
| `adminSignOut` | `POST /v1/admin/auth/sign-out` | Sign out | `{refreshToken}` → `204` | `account_sessions` | — | M1 |
| `adminGetMe` | `GET /v1/admin/me` | Current admin | → `{id, email, fullName}` | `accounts` | — | M1 |
| `adminGetDashboard` | `GET /v1/admin/dashboard` | Counters | → `{tenantsByStatus, provisioningFailed24h, jobsFailedByQueue, officePool: [{environment, available, assigned}], domainsPending (M5), settlementsToReview (M5), stripeEventsFailed (M5), subscriptionsPastDue (M5)}` | several, read-only; BullMQ counts | — | M1 |

## 3. Tenants, provisioning jobs, queues

| Operation | Method and path | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|
| `adminListTenants` | `GET /v1/admin/tenants?q=&status=&planCode=&cursor=` | Search by key, name or owner e-mail | → `{data: [AdminTenantSummary {id, key, name, status, planCode, ownerEmail, createdAt, activatedAt}], page}` | `tenants`, `tenant_memberships`, `accounts` | — | M1 |
| `adminGetTenant` | `GET /v1/admin/tenants/{tenantId}` | Full control-plane view | → `{tenant, members[], invitations[], subscription, amadeusConnections[], paymentConnections[], domains[], recentJobs[], recentAudit[]}` (secrets never included) | read-only joins | `NOT_FOUND` | M1 |
| `adminUpdateTenant` | `PATCH /v1/admin/tenants/{tenantId}` | Internal notes, legal name | `If-Match`, `{notes?, legalName?}` → tenant (`notes` stored in `metadata.notes`) | `tenants` | `PRECONDITION_FAILED` | M1 |
| `adminSuspendTenant` | `POST /v1/admin/tenants/{tenantId}/suspend` | Suspend (**reason**) | `{suspensionReason: "abuse" \| "request" \| "admin", reason}` → `202 {tenant, job}` ([PADR-0014](adr/0014-tenant-suspension-and-resume.md)) | `tenants`, `provisioning_jobs`; `tenant.suspend`; `tenant` invalidation; `email_outbox` | `CONFLICT` (not active) | M1 |
| `adminResumeTenant` | `POST /v1/admin/tenants/{tenantId}/resume` | Resume (**reason**) | `{reason}` → `202 {tenant, job}` | as above, `tenant.resume` | `CONFLICT` (not suspended, or suspended for billing with no valid subscription) | M1 |
| `adminMigrateTenant` | `POST /v1/admin/tenants/{tenantId}/migrate` | Re-run tenant migrations | `{targetVersion?}` → `202 {job}` | `provisioning_jobs`; `tenant.migrate` | `CONFLICT` (a migrate job is active, tenant not provisioned) | M1 |
| `adminSetConnectionStatus` | `POST /v1/admin/tenants/{tenantId}/connections/{kind}/{environment}/status` | Disable or re-enable an Amadeus (`kind = amadeus`) or payment (`kind = payment`) connection (**reason**) | `{status: "active" \| "disabled", reason}` → connection; `connection` invalidation | `supplier_connections` or `payment_provider_connections` | `CONFLICT` | M1 |
| `adminListProvisioningJobs` | `GET /v1/admin/provisioning-jobs?status=&kind=&tenantId=&cursor=` | Job list | → `{data: [Job {id, tenantId, tenantKey, kind, status, step, attempt, maxAttempts, error, scheduledAt, startedAt, finishedAt}], page}` | `provisioning_jobs` | — | M1 |
| `adminGetProvisioningJob` | `GET /v1/admin/provisioning-jobs/{jobId}` | Step log | → `Job {…, steps[], payload, result (no ciphertext), lockedUntil, bullmqState}` | `provisioning_jobs`; BullMQ | `NOT_FOUND` | M1 |
| `adminRetryProvisioningJob` | `POST /v1/admin/provisioning-jobs/{jobId}/retry` | New job of the same kind for a failed one | → `202 {job}` (tenant `failed` → `provisioning` for `provision`) | `provisioning_jobs`, `tenants` | `PROVISIONING_NOT_RETRYABLE` | M1 |
| `adminCancelProvisioningJob` | `POST /v1/admin/provisioning-jobs/{jobId}/cancel` | Cancel a job not yet dispatched (**reason**) | → `200 {job}` | `provisioning_jobs` | `CONFLICT` (running) | M1 |
| `adminListQueues` | `GET /v1/admin/queues` | Queue health of both backends | → `{data: [{name, owner: "platform" \| "ota", waiting, active, delayed, failed, oldestWaitingSeconds}]}` | BullMQ (read-only) | — | M1 |
| `adminListFailedQueueJobs` | `GET /v1/admin/queues/{queue}/failed?limit=` | Failed jobs | → `{data: [{id, name, failedReason, attemptsMade, failedAt, data}]}` (payloads hold ids only) | BullMQ | `NOT_FOUND` | M1 |
| `adminRetryQueueJob` | `POST /v1/admin/queues/{queue}/jobs/{jobId}/retry` | Retry a failed platform job | → `202` | BullMQ | `FORBIDDEN` (`ota-*` queues are view-only) | M1 |

## 4. Plans, subscriptions, invoices, Stripe events

| Operation | Method and path | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|
| `adminListPlans` | `GET /v1/admin/plans` | All plans with Stripe link state | → `{data: [AdminPlan {…Plan, isPublic, isActive, stripeProductId, stripePriceIdMonth, stripePriceIdYear, settlementFeeBps, priceWarnings[], tenantCount}]}` | `plans`, `tenants` | — | M1 |
| `adminCreatePlan` | `POST /v1/admin/plans` | New plan | `{code, name, description, currency, monthlyPrice, annualPrice?, limits, features, isPublic, trialDays, settlementFeeBps, sortOrder}` → `201 AdminPlan` | `plans` | `CONFLICT` (code exists) | M1 |
| `adminUpdatePlan` | `PATCH /v1/admin/plans/{planCode}` | Edit, link Stripe prices, retire | `If-Match`, any field but `code` and `currency` → `AdminPlan` with `priceWarnings`; `plan` invalidation | `plans` | `PRECONDITION_FAILED`, `VALIDATION_FAILED`, `PROVIDER_ERROR` | M1 (Stripe ids M5) |
| `adminCheckPlanPrices` | `POST /v1/admin/plans/{planCode}/check-prices` | Compare with Stripe | → `{warnings: [{field, expected, actual}]}` (amount, currency, interval, active) | `plans` | `PROVIDER_ERROR` | M5 |
| `adminListSubscriptions` | `GET /v1/admin/subscriptions?status=&provider=&planCode=&cursor=` | Subscriptions | → `{data, page}` | `subscriptions`, `tenants` | — | M1 |
| `adminGetSubscription` | `GET /v1/admin/subscriptions/{subscriptionId}` | Detail and history | → `{subscription, invoices[], events[]}` | `subscriptions`, `invoices`, `stripe_events` | `NOT_FOUND` | M1 |
| `adminResyncSubscription` | `POST /v1/admin/subscriptions/{subscriptionId}/resync` | Re-fetch from Stripe | → `200 subscription` | `subscriptions`, `tenants` | `CONFLICT` (manual), `PROVIDER_ERROR` | M5 |
| `adminUpdateManualSubscription` | `PATCH /v1/admin/subscriptions/{subscriptionId}` | Manual plans only (**reason**) | `If-Match`, `{planCode?, trialEndsAt?, status?: "trialing" \| "canceled", reason}` → subscription | `subscriptions`, `tenants` | `CONFLICT` (Stripe-billed) | M1 |
| `adminListInvoices` | `GET /v1/admin/invoices?tenantId=&status=&cursor=` | Invoices | → `{data, page}` | `invoices` | — | M5 |
| `adminListStripeEvents` | `GET /v1/admin/stripe-events?status=&type=&tenantId=&cursor=` | Webhook inbox | → `{data: [{id, endpoint, type, status, attempts, lastError, tenantId, receivedAt, processedAt}], page}` | `stripe_events` | — | M5 |
| `adminReprocessStripeEvent` | `POST /v1/admin/stripe-events/{eventId}/reprocess` | Re-run a failed or ignored event | → `202` | `stripe_events` | `CONFLICT` (processing) | M5 |

## 5. Velexis Amadeus account and offices

| Operation | Method and path | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|
| `adminListAmadeusAccounts` | `GET /v1/admin/amadeus-accounts` | Shared accounts | → `{data: [{id, name, environment, baseUrl, clientId, status, lastVerifiedAt, lastError, officeCounts}]}` | `amadeus_accounts`, `amadeus_offices` | — | M1 |
| `adminCreateAmadeusAccount` | `POST /v1/admin/amadeus-accounts` (MFA↑) | Enter shared credentials | `{name, environment, baseUrl, clientId, clientSecret}` → `201` account (`pending_verification`); job `amadeus_account.verify` | `amadeus_accounts` | `CONFLICT` (environment exists) | M1 |
| `adminUpdateAmadeusAccount` | `PATCH /v1/admin/amadeus-accounts/{accountId}` (MFA↑ when the secret changes) | Rotate, rename, disable | `If-Match`, `{name?, baseUrl?, clientId?, clientSecret?, status?: "disabled"}` → account; verify job; `amadeus_account` invalidation | `amadeus_accounts` | `PRECONDITION_FAILED` | M1 |
| `adminVerifyAmadeusAccount` | `POST /v1/admin/amadeus-accounts/{accountId}/verify` | Re-verify | → `202` | job | — | M1 |
| `adminListAmadeusOffices` | `GET /v1/admin/amadeus-offices?accountId=&environment=&status=&cursor=` | Pool | → `{data: [{id, officeId, environment, status, assignedTenant?: {id, key}, assignedAt, releaseRequestedAt, notes}], page}` | `amadeus_offices` | — | M1 |
| `adminAddAmadeusOffices` | `POST /v1/admin/amadeus-offices` | Add offices in bulk | `{amadeusAccountId, officeIds[], notes?}` → `201 {created[], skipped[]}` | `amadeus_offices` | `VALIDATION_FAILED` | M1 |
| `adminUpdateAmadeusOffice` | `PATCH /v1/admin/amadeus-offices/{officeRowId}` | Notes | `If-Match`, `{notes}` → office | `amadeus_offices` | `PRECONDITION_FAILED` | M1 |
| `adminAssignAmadeusOffice` | `POST /v1/admin/amadeus-offices/{officeRowId}/assign` | Assign to a tenant (creates or completes its `velexis` connection) | `{tenantId}` → `200 {office, connection}`; `connection` and `amadeus_account` invalidation; owner e-mailed for live | `amadeus_offices`, `supplier_connections` | `AMADEUS_OFFICE_UNAVAILABLE`, `CONFLICT` (tenant uses own credentials, or already has an assigned office there) | M1 (live M5) |
| `adminReleaseAmadeusOffice` | `POST /v1/admin/amadeus-offices/{officeRowId}/release` | Back to the pool (**reason**) | `{confirmNoOpenBookings: true, reason}` → office `available` | `amadeus_offices` | `CONFLICT` (status `assigned` with an active `velexis` connection) | M5 |
| `adminRetireAmadeusOffice` | `POST /v1/admin/amadeus-offices/{officeRowId}/retire` | Remove from use (**reason**) | → office `retired` | `amadeus_offices` | `CONFLICT` (not available) | M1 |

## 6. Settlements and payout accounts

| Operation | Method and path | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|
| `adminListSettlements` | `GET /v1/admin/settlements?status=&periodStart=&tenantId=&cursor=` | Statements | → `{data, page}` | `settlements` | — | M5 |
| `adminGenerateSettlements` | `POST /v1/admin/settlements/generate` | (Re)build drafts | `{periodStart, tenantId?}` → `202` job `settlement.generate`; existing drafts are rebuilt, other statuses untouched | `settlements`, `settlement_lines` | `VALIDATION_FAILED` (period not closed) | M5 |
| `adminGetSettlement` | `GET /v1/admin/settlements/{settlementId}` | Detail | → `Settlement` with tenant and payout account status | `settlements` | `NOT_FOUND` | M5 |
| `adminListSettlementLines` | `GET /v1/admin/settlements/{settlementId}/lines?cursor=` and `…/lines.csv` | Lines | → `{data, page}` or CSV | `settlement_lines` | — | M5 |
| `adminAddSettlementAdjustment` | `POST /v1/admin/settlements/{settlementId}/adjustments` | Manual line (**reason**) | `{amount, description, reason}` → `Settlement` (totals recomputed) | `settlement_lines`, `settlements` | `SETTLEMENT_STATE_INVALID` (not draft) | M5 |
| `adminApproveSettlement` | `POST /v1/admin/settlements/{settlementId}/approve` | Approve (MFA↑) | `If-Match` → `approved` (net > 0) or `carried_forward` (net ≤ 0) | `settlements` | `SETTLEMENT_STATE_INVALID`, `PAYOUT_ACCOUNT_REQUIRED`, `PRECONDITION_FAILED` | M5 |
| `adminMarkSettlementPaid` | `POST /v1/admin/settlements/{settlementId}/mark-paid` | Record the bank transfer (MFA↑) | `If-Match`, `{paidAt, payoutReference}` → `paid`; owners and finance e-mailed | `settlements`, `email_outbox` | `SETTLEMENT_STATE_INVALID` | M5 |
| `adminVoidSettlement` | `POST /v1/admin/settlements/{settlementId}/void` | Void a draft (**reason**) | `{reason}` → `void`; its lines are deleted so the transactions can be settled again | `settlements`, `settlement_lines` | `SETTLEMENT_STATE_INVALID` | M5 |
| `adminGetPayoutAccount` | `GET /v1/admin/tenants/{tenantId}/payout-account` | Masked view | → `PayoutAccount` | `tenant_payout_accounts` | `NOT_FOUND` | M5 |
| `adminRevealPayoutAccount` | `POST /v1/admin/tenants/{tenantId}/payout-account/reveal` | Full bank details to pay (**reason**, MFA↑) | `{reason}` → `{iban?, bic?, accountNumber?, routingNumber?}` (no-store) | `tenant_payout_accounts`, audit | `NOT_FOUND` | M5 |
| `adminReviewPayoutAccount` | `POST /v1/admin/tenants/{tenantId}/payout-account/review` | Verify or reject | `If-Match`, `{decision: "verified" \| "rejected", note?}` → `PayoutAccount`; owner e-mailed | `tenant_payout_accounts`, `email_outbox` | `PRECONDITION_FAILED` | M5 |

## 7. Domains, accounts, platform admins, audit

| Operation | Method and path | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|
| `adminListDomains` | `GET /v1/admin/domains?kind=&verificationStatus=&tlsStatus=&cursor=` | All domains | → `{data, page}` | `tenant_domains` | — | M5 |
| `adminRecheckDomain` | `POST /v1/admin/domains/{domainId}/recheck` | DNS check and TLS probe now | → `202` | jobs | — | M5 |
| `adminRemoveDomain` | `POST /v1/admin/domains/{domainId}/remove` | Remove an abusive custom domain (**reason**) | `{reason}` → `204`; `domain` invalidation; owner e-mailed | `tenant_domains` | `CONFLICT` (sub-domain) | M5 |
| `adminListAccounts` | `GET /v1/admin/accounts?q=&status=&cursor=` | Accounts | → `{data: [{id, email, fullName, status, mfaEnabled, isPlatformAdmin, lastLoginAt, createdAt}], page}` | `accounts` | — | M1 |
| `adminGetAccount` | `GET /v1/admin/accounts/{accountId}` | Detail | → `{account, memberships[], activeSessions, recentAudit[]}` | `accounts`, `tenant_memberships`, `account_sessions`, audit | `NOT_FOUND` | M1 |
| `adminDisableAccount` / `adminEnableAccount` | `POST /v1/admin/accounts/{accountId}/disable` / `enable` | Block or unblock (**reason**) | `{reason}` → account; disable revokes sessions, writes `staffdeny`, publishes `account` invalidation | `accounts`, `account_sessions` | `FORBIDDEN` (self, last admin) | M1 |
| `adminUnlockAccount` | `POST /v1/admin/accounts/{accountId}/unlock` | Clear a lockout | → account | `accounts` | — | M1 |
| `adminResetAccountMfa` | `POST /v1/admin/accounts/{accountId}/reset-mfa` | Support case after identity check (**reason**, MFA↑) | `{reason}` → account (MFA off, recovery codes deleted, sessions revoked, `staffdeny`, user e-mailed) | `accounts`, `account_recovery_codes`, `account_sessions` | `FORBIDDEN` (platform admin target: another admin must first revoke admin rights) | M1 |
| `adminListAdmins` | `GET /v1/admin/admins` | Platform admins | → `{data: [{accountId, email, fullName, mfaEnabled, lastLoginAt}]}` | `accounts` | — | M1 |
| `adminGrantAdmin` | `POST /v1/admin/admins` | Grant (**reason**, MFA↑) | `{email, reason}` → `201` | `accounts` | `NOT_FOUND`, `UNPROCESSABLE` (`email_not_verified`, `mfa_not_enabled`) | M1 |
| `adminRevokeAdmin` | `DELETE /v1/admin/admins/{accountId}?reason=` | Revoke (MFA↑) | → `204`; admin sessions revoked | `accounts`, `account_sessions` | `FORBIDDEN` (self or last admin) | M1 |
| `adminListAudit` | `GET /v1/admin/audit-log?tenantId=&actorAccountId=&actorType=&action=&targetType=&targetId=&from=&to=&cursor=` | Audit search | → `{data: [AuditEntry], page}` | `platform_audit_log` | — | M1 |
| `adminExportAudit` | `GET /v1/admin/audit-log.csv?…` | CSV export (audited, at most 100 000 rows) | → `text/csv` | `platform_audit_log` | `VALIDATION_FAILED` (range over 1 year) | M1 |

## 8. Webhooks

| Operation | Method and path | Auth | Purpose | Behaviour | Tables | Errors | M |
|---|---|---|---|---|---|---|---|
| `receiveStripeBillingEvent` | `POST /webhooks/stripe/billing` | `webhook` (`STRIPE_BILLING_WEBHOOK_SECRET`) | Stripe Billing sync | Events: `checkout.session.completed`, `customer.subscription.created`, `…updated`, `…deleted`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`. Verify the signature on the raw body, check `livemode` matches the deployment, insert into `stripe_events` (`ON CONFLICT DO NOTHING`), enqueue `stripe.event`, answer `200 {received: true}`. Unknown types are stored as `ignored`. | `stripe_events` | `400 WEBHOOK_SIGNATURE_INVALID` | M5 |
| `receiveStripeConnectAccountEvent` | `POST /webhooks/stripe/connect-accounts` | `webhook` (`STRIPE_CONNECT_WEBHOOK_SECRET`) | Connected account state | A Stripe **Connect** endpoint subscribed only to `account.updated` and `account.application.deauthorized`. Same inbox handling; the processor updates `payment_provider_connections` by `event.account`. Payment events of connected accounts go to the OTA backend's own Connect endpoint, not here ([architecture flow (d)](../../docs/mvp/architecture.md#d-stripe-webhooks-platform-billing-vs-ota-payments)). | `stripe_events`, `payment_provider_connections` | `400 WEBHOOK_SIGNATURE_INVALID` | M5 |

Both receivers answer within 2 seconds and never call Stripe inline. A database failure answers `500`, and Stripe retries for up to 3 days.

## 9. Internal and health

| Operation | Method and path | Auth | Purpose | Behaviour | Tables | M |
|---|---|---|---|---|---|---|
| `tlsAsk` | `GET /internal/tls/ask?domain=<host>` | `internal` | Caddy on-demand TLS gate ([ADR-0018](../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)) | `200` (empty) if the host is `<key>.ota.example.com` of a tenant in `provisioning`, `active` or `suspended`, or a verified custom storefront domain of an `active` tenant whose plan has `customDomains > 0` and `F:custom_domains` on; else `404`. Invalid host syntax (over 253 characters, bad labels, an IP) → `404` before any lookup, never cached. A `200` is cached 60 s in Redis `tlsask:<host>`; a `404` only in a bounded in-process LRU (10 000 entries, 60 s), so random SNI names create no Redis keys ([PADR-0004](adr/0004-custom-domain-verification.md) item 6). | `tenants`, `tenant_domains`, `plans` | M1 |
| `healthLive` | `GET /health/live` | public | Process up | `200 {status: "ok"}` | — | M0 |
| `healthReady` | `GET /health/ready` | `internal` | Dependencies | `200` or `503` with PostgreSQL, Redis and oldest waiting job age per platform queue | — | M0 |

The worker exposes the same two health endpoints on port 3101. There is no other internal HTTP endpoint: the backends talk through queues and Redis only ([ADR-0003](../../docs/mvp/adr/0003-six-components-two-nestjs-backends.md)).
