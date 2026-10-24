# Platform API inventory (part 1: conventions, identity, tenants, team)

This document lists every endpoint of the platform backend for the portal and the platform admin, with method, path, authentication, purpose, request and response summary, tables touched, error codes and milestone. It is the **source for the platform OpenAPI document** `platform/backend/openapi/velexis-platform-api.openapi.yaml`, written in the first M1 backend tasks ([ADR-0006](../../docs/mvp/adr/0006-contract-first-openapi.md) fixes that file name). This part holds the conventions, the error catalogue and the identity, tenant and team endpoints.

Other parts: [`api-inventory-resources.md`](api-inventory-resources.md) (API keys, domains, Amadeus, payments, settlements, billing) and [`api-inventory-admin.md`](api-inventory-admin.md) (platform admin, webhooks, internal). Related: [`architecture.md`](architecture.md), [`data-model.md`](data-model.md), [PADR-0009](adr/0009-platform-api-surface-and-authentication.md).

## 1. Hosts and versions

| Base | Reached by | Notes |
|---|---|---|
| `https://api.platform.example.com/v1/…` | Portal and admin **servers** (Next.js), through Caddy or `PLATFORM_API_URL=http://127.0.0.1:3100` | Every endpoint below |
| `https://api.platform.example.com/webhooks/…` | Stripe | Raw body, signature verified |
| `http://127.0.0.1:3100/internal/…` | Caddy only | Blocked on public hosts |
| `/health/live`, `/health/ready` | Uptime monitor (`live` only), on-VM checks | [ADR-0016](../../docs/mvp/adr/0016-observability.md) |

## 2. Conventions

Same conventions as the OTA document ([`conventions.md` §6](../../docs/mvp/conventions.md#6-error-model)):

- JSON in camelCase; ids are prefixed ULIDs (`acc_`, `ten_`, `stf_`, `ivt_`, `key_`, `dom_`, `sc_`, `ppc_`, `job_`, `sub_`, `inv_`, `stl_`, `crs_`, `ama_`, `amo_`); money is `{ "amount": "49.00", "currency": "EUR" }`; times are ISO 8601 UTC with `Z`.
- Lists use cursor pagination: `?limit=50&cursor=…` → `{ "data": [...], "page": { "nextCursor": "…" | null, "limit": 50 } }`. Default limit 50, maximum 200.
- PATCH takes `If-Match: "<version>"`; a stale version answers `412 PRECONDITION_FAILED`. Responses of versioned resources carry `ETag`.
- Responses that contain a secret shown once (API keys, recovery codes, revealed keys or bank details) carry `Cache-Control: no-store` and are never stored for idempotent replay.
- Every response carries `X-Request-Id`.

**Authentication columns** in the tables below:

| Notation | Meaning |
|---|---|
| `public` | No token. Rate limited. |
| `portal*` | Portal access token, e-mail verification **not** required (account, resend, sign-out only). |
| `portal` | Portal access token of a verified, active account. |
| `portal: owner, admin` | Portal token plus an active membership of `{tenantId}` with one of these roles (`TenantRoleGuard`). Non-members get `404`. `member` means any role. |
| `MFA↑` | Recent MFA step-up: `mfa_at` within 15 minutes (`401 REAUTH_REQUIRED`), or `403 MFA_REQUIRED` if MFA is off ([PADR-0008](adr/0008-email-verification-and-mfa-policy.md)). |
| `F:<switch>` | Milestone feature switch and plan check ([PADR-0015](adr/0015-milestone-feature-switches.md)); `403 FEATURE_DISABLED` when off. |
| `Idem` | `Idempotency-Key` header required; the response is replayed for 24 h. |
| `admin` | Platform admin access token (audience `platform_admin`, MFA done) ([PADR-0006](adr/0006-platform-admin-access-and-audit.md)). |
| `internal` | Loopback only, no token. |
| `webhook` | Stripe signature on the raw body. |

**Rate limits** (Redis throttler, `429 RATE_LIMITED` with `Retry-After`). "Per IP" means the end user's IP. Calls from the portal and admin servers carry it in `X-Velexis-End-User-IP` with the shared key `X-Velexis-Bff-Key`; other calls use the Caddy client IP ([PADR-0019](adr/0019-end-user-ip-forwarding-from-the-portal-and-admin.md), [`architecture.md` §3.2](architecture.md#32-end-user-ip-and-user-agent)).

| Endpoint group | Limit |
|---|---|
| Sign-up | 5 per IP per hour |
| Sign-in, admin sign-in | 10 per IP per minute; 5 consecutive failures lock the account for 15 minutes (`423 ACCOUNT_LOCKED`) |
| MFA verify, step-up | 5 attempts per challenge; 10 per account per 10 minutes |
| Password reset request, resend verification | 3 per e-mail per hour, 10 per IP per hour |
| Invitation lookup | 20 per IP per hour |
| Key availability | 30 per account per minute |
| Console token | 30 per account per minute |
| Domain check now | 1 per domain per minute |
| Everything else authenticated | 300 per account per minute |

## 3. Error catalogue

The platform document has its own `x-error-catalogue`. It reuses the OTA codes and statuses where the meaning is the same, and `@velexis/errors` is generated from it.

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Schema validation failed; `fieldErrors` never echo values |
| `VERIFICATION_TOKEN_INVALID`, `PASSWORD_RESET_TOKEN_INVALID`, `INVITATION_INVALID`, `CONNECT_STATE_INVALID` | 400 | Unknown, used or expired single-use token or OAuth state |
| `MFA_SETUP_EXPIRED` | 400 | The pending TOTP secret expired (10 minutes) |
| `WEBHOOK_SIGNATURE_INVALID` | 400 | Stripe signature check failed |
| `UNAUTHENTICATED`, `TOKEN_EXPIRED` | 401 | No or expired access token |
| `INVALID_CREDENTIALS` | 401 | Wrong e-mail or password (same answer for both) |
| `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED` | 401 | Refresh failed; reuse revokes the family |
| `MFA_CHALLENGE_INVALID`, `MFA_CODE_INVALID` | 401 | MFA challenge unknown or expired; wrong TOTP or recovery code |
| `REAUTH_REQUIRED` | 401 | Sensitive action needs a fresh TOTP step-up |
| `FORBIDDEN` | 403 | Role or rule forbids it (`details.reason`) |
| `EMAIL_NOT_VERIFIED` | 403 | Verify the e-mail address first |
| `ACCOUNT_DISABLED` | 403 | Account disabled by Velexis (only after a correct password) |
| `MFA_REQUIRED` | 403 | The action or the OTA requires MFA to be enabled |
| `INVITATION_EMAIL_MISMATCH` | 403 | Invitation was sent to another address |
| `FEATURE_DISABLED` | 403 | Feature switch off, or the plan does not include it |
| `NOT_FOUND` | 404 | Not found, or not visible to the caller |
| `CONFLICT` | 409 | Generic state conflict (`details.reason`) |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same key, different body |
| `TENANT_KEY_UNAVAILABLE` | 409 | Key taken, reserved or once used |
| `TENANT_NOT_ACTIVE` | 409 | The OTA is provisioning, suspended or failed (`details.status`) |
| `PROVISIONING_NOT_RETRYABLE` | 409 | Retry only applies to failed tenants or failed jobs |
| `LAST_OWNER` | 409 | An OTA must keep one active owner |
| `ALREADY_MEMBER`, `INVITATION_PENDING` | 409 | Duplicate membership or invitation |
| `DOMAIN_TAKEN` | 409 | Host name used by another OTA |
| `DOMAIN_NOT_VERIFIED` | 409 | Action needs a verified domain |
| `AMADEUS_OFFICE_UNAVAILABLE` | 409 | Office not available, or no free office in the pool |
| `STRIPE_ACCOUNT_ALREADY_CONNECTED` | 409 | The Stripe account is connected to another OTA |
| `SETTLEMENT_STATE_INVALID` | 409 | Statement action not allowed in its status |
| `MFA_ALREADY_ENABLED` | 409 | MFA set-up while enabled |
| `KEYS_ALREADY_REVEALED` | 410 | Initial keys revealed already, or 24 h passed |
| `PRECONDITION_FAILED` | 412 | `If-Match` is stale |
| `PASSWORD_TOO_WEAK`, `CURRENT_PASSWORD_INCORRECT` | 422 | Password rules |
| `PLAN_NOT_AVAILABLE` | 422 | Plan inactive, not public, or without a Stripe price for the interval |
| `PLAN_LIMIT_REACHED` | 422 | Seats, keys or domains limit (`details.limit`, `details.used`) |
| `LIVE_MODE_NOT_ENABLED` | 422 | Live resources before the OTA is live |
| `LIVE_PRECONDITIONS_UNMET` | 422 | Go-live blocked; `details.missing[]` |
| `DOMAIN_INVALID` | 422 | Not a valid public host name, or a Velexis host |
| `PAYOUT_ACCOUNT_REQUIRED` | 422 | Live Velexis-mode payments need a verified payout account |
| `UNPROCESSABLE` | 422 | Other business rule (`details.reason`) |
| `ACCOUNT_LOCKED` | 423 | Too many failed sign-ins |
| `RATE_LIMITED` | 429 | Slow down |
| `INTERNAL_ERROR` | 500 | Unexpected; see `requestId` |
| `PROVIDER_ERROR` | 502 | Stripe, Amadeus or DNS failed (`details.provider`) |
| `SERVICE_UNAVAILABLE` | 503 | Database or Redis unavailable |

## 4. Auth (`AuthModule`)

| Operation | Method and path | Auth | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|---|
| `signUp` | `POST /v1/auth/sign-up` | public | Create an account | `{email, password, fullName, acceptTerms: true, termsVersion}` → `202 {status: "verification_sent"}` (same for an existing e-mail) | `accounts`, `account_tokens`, `email_outbox`, `platform_audit_log` | `VALIDATION_FAILED`, `PASSWORD_TOO_WEAK`, `RATE_LIMITED` | M1 |
| `verifyEmail` | `POST /v1/auth/verify-email` | public | Consume the verification token | `{token}` → `200 {accountId, email, emailVerified: true}` | `account_tokens`, `accounts`, audit | `VERIFICATION_TOKEN_INVALID` | M1 |
| `resendVerification` | `POST /v1/auth/resend-verification` | public | New verification e-mail | `{email}` → `202` always | `account_tokens`, `email_outbox` | `RATE_LIMITED` | M1 |
| `signIn` | `POST /v1/auth/sign-in` | public | Password sign-in to the portal | `{email, password}` → `200 PortalSession` or `200 {mfaRequired: true, mfaChallengeToken, expiresIn: 300}` | `accounts`, `account_sessions`, audit | `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `ACCOUNT_DISABLED`, `RATE_LIMITED` | M1 |
| `verifyMfa` | `POST /v1/auth/mfa/verify` | public | Complete an MFA challenge | `{mfaChallengeToken, code}` or `{mfaChallengeToken, recoveryCode}` → `200 PortalSession` | `account_sessions`, `account_recovery_codes`, audit | `MFA_CHALLENGE_INVALID`, `MFA_CODE_INVALID`, `RATE_LIMITED` | M1 |
| `refreshSession` | `POST /v1/auth/refresh` | public | Rotate the refresh token | `{refreshToken}` → `200 PortalSession` | `account_sessions` | `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED` | M1 |
| `signOut` | `POST /v1/auth/sign-out` | `portal*` | Revoke the current family | `{refreshToken}` → `204` | `account_sessions` | — | M1 |
| `signOutEverywhere` | `POST /v1/auth/sign-out-everywhere` | `portal*` | Revoke all portal, admin and OTA staff sessions | — → `204` | `account_sessions`, audit; Redis `staffdeny:acct:<id>` | — | M1 |
| `requestPasswordReset` | `POST /v1/auth/password-reset` | public | E-mail a reset link | `{email}` → `202` always | `account_tokens`, `email_outbox` | `RATE_LIMITED` | M1 |
| `confirmPasswordReset` | `POST /v1/auth/password-reset/confirm` | public | Set a new password | `{token, newPassword}` → `204`; revokes all sessions | `account_tokens`, `accounts`, `account_sessions`, audit; `staffdeny` | `PASSWORD_RESET_TOKEN_INVALID`, `PASSWORD_TOO_WEAK` | M1 |
| `stepUp` | `POST /v1/auth/step-up` | `portal` | Fresh TOTP for sensitive actions | `{code}` → `200 PortalSession` (new access token with `mfa_at` now, same family) | `account_sessions` | `MFA_CODE_INVALID`, `MFA_REQUIRED`, `RATE_LIMITED` | M1 |

`PortalSession` = `{accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, account: Account}`. Tokens appear only here; the portal server moves them into cookies at once.

## 5. Account (`AccountsModule`)

| Operation | Method and path | Auth | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|---|
| `getMe` | `GET /v1/me` | `portal*` | Current account and memberships | → `Account {id, email, emailVerified, fullName, locale, timeZone, mfaEnabled, mfaEnabledAt, isPlatformAdmin, createdAt, version, memberships: [{membershipId, tenantId, tenantKey, tenantName, tenantStatus, role}], features: {stripeBilling, ownStripe, settlements, ownAmadeus, customDomains, liveSwitch}}` (milestone switches, [PADR-0015](adr/0015-milestone-feature-switches.md)) | `accounts`, `tenant_memberships`, `tenants` | — | M1 |
| `updateMe` | `PATCH /v1/me` | `portal*` | Profile | `If-Match`, `{fullName?, locale?, timeZone?}` → `Account` | `accounts`, audit | `VALIDATION_FAILED`, `PRECONDITION_FAILED` | M1 |
| `changePassword` | `POST /v1/me/password` | `portal` | Change password | `{currentPassword, newPassword}` → `204`; other sessions and staff sessions revoked | `accounts`, `account_sessions`, audit; `staffdeny` | `CURRENT_PASSWORD_INCORRECT`, `PASSWORD_TOO_WEAK` | M1 |
| `startMfaSetup` | `POST /v1/me/mfa/setup` | `portal*` | New pending TOTP secret | → `200 {secret, otpauthUrl, expiresIn: 600}` (no-store) | Redis `mfasetup:<accountId>` | `MFA_ALREADY_ENABLED` | M1 |
| `enableMfa` | `POST /v1/me/mfa/enable` | `portal*` | Confirm and enable | `{code}` → `200 {recoveryCodes: string[10]}` (no-store) | `accounts`, `account_recovery_codes`, audit, `email_outbox` | `MFA_CODE_INVALID`, `MFA_SETUP_EXPIRED` | M1 |
| `disableMfa` | `POST /v1/me/mfa/disable` | `portal`, MFA↑ | Turn MFA off | → `204` | `accounts`, `account_recovery_codes`, audit, `email_outbox` | `FORBIDDEN` (platform admin), `REAUTH_REQUIRED` | M1 |
| `regenerateRecoveryCodes` | `POST /v1/me/mfa/recovery-codes` | `portal`, MFA↑ | Replace all codes | → `200 {recoveryCodes}` (no-store) | `account_recovery_codes`, audit | `REAUTH_REQUIRED` | M1 |
| `listSessions` | `GET /v1/me/sessions` | `portal*` | Active sessions | → `{data: [{familyId, audience, userAgent, ipAddress, createdAt, lastUsedAt, current}]}` | `account_sessions` | — | M1 |
| `revokeSession` | `DELETE /v1/me/sessions/{familyId}` | `portal*` | Revoke one family | → `204` | `account_sessions`, audit | `NOT_FOUND` | M1 |

## 6. Plans (`BillingModule`, public part)

| Operation | Method and path | Auth | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|---|
| `listPlans` | `GET /v1/plans` | public | Pricing page and wizard | → `{data: [Plan {code, name, description, monthlyPrice, annualPrice, trialDays, limits, features, checkoutAvailable: {month, year}}]}` (public, active plans, `sort_order`) | `plans` | — | M1 |

## 7. Tenants and lifecycle (`TenantsModule`, `ProvisioningModule`)

| Operation | Method and path | Auth | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|---|
| `checkTenantKey` | `GET /v1/tenants/key-availability?key=` | `portal` | Live key check in the wizard | → `{key, available, reason?: "invalid" \| "reserved" \| "taken", storefrontHost}` | `tenants` | `RATE_LIMITED` | M1 |
| `createTenant` | `POST /v1/tenants` | `portal`, Idem | Create an OTA ([flow](flows/signup-and-create-ota.md)) | `{key, name, countryCode, defaultCurrency, timeZone, planCode?, billingInterval?}` → `202 {tenant, provisioningJob {id, status}, checkoutUrl \| null, checkoutError?}` | `tenants`, `tenant_memberships`, `subscriptions`, `tenant_domains`, `provisioning_jobs`, `billing_customers` and `billing_customer_attempts` (M5), audit | `TENANT_KEY_UNAVAILABLE`, `PLAN_NOT_AVAILABLE`, `UNPROCESSABLE` (`tenant_limit`), `EMAIL_NOT_VERIFIED`, `IDEMPOTENCY_KEY_REUSED` | M1 (M5 Checkout) |
| `listTenants` | `GET /v1/tenants` | `portal*` | My OTAs | → `{data: [TenantSummary {id, key, name, status, role, planCode, storefrontUrl, storefrontEnvironment}]}` | `tenant_memberships`, `tenants`, `tenant_domains` | — | M1 |
| `getTenant` | `GET /v1/tenants/{tenantId}` | `portal: member` | OTA overview | → `Tenant {id, key, name, legalName, status, suspensionReason?, billingNotice?, planCode, defaultCurrency, countryCode, timeZone, supportEmail, storefrontEnvironment, liveEnabledAt, primaryHost, schemaVersion, createdAt, activatedAt, version, myRole}` | `tenants`, `tenant_domains` | `NOT_FOUND` | M1 |
| `updateTenant` | `PATCH /v1/tenants/{tenantId}` | `portal: owner, admin` | OTA profile | `If-Match`, `{name?, legalName?, supportEmail?, countryCode?, timeZone?}` → `Tenant`; publishes `tenant` invalidation | `tenants`, audit | `PRECONDITION_FAILED`, `TENANT_NOT_ACTIVE` | M1 |
| `getProvisioning` | `GET /v1/tenants/{tenantId}/provisioning` | `portal: member` | Setup progress | → `{tenantStatus, job {id, kind, status, step, steps[], attempt, maxAttempts, error?}, initialKeysAvailable}` | `provisioning_jobs`, `tenants` | `NOT_FOUND` | M1 |
| `retryProvisioning` | `POST /v1/tenants/{tenantId}/provisioning/retry` | `portal: owner` | Retry a failed setup | → `202 {job, checkoutUrl \| null}` (M5: a tenant failed by an abandoned Checkout gets a new Checkout) | `tenants`, `provisioning_jobs`, audit | `PROVISIONING_NOT_RETRYABLE` | M1 |
| `revealInitialKeys` | `POST /v1/tenants/{tenantId}/initial-keys/reveal` | `portal: owner` | Show the provisioned test keys once | → `200 {keys: [{id, kind, environment, prefix, key}]}` (no-store) | `provisioning_jobs`, audit | `KEYS_ALREADY_REVEALED` | M1 |
| `getOnboarding` | `GET /v1/tenants/{tenantId}/onboarding` | `portal: member` | Checklist | → `{items: [{id, label, done, href, milestone}]}` (computed, [PADR-0018](adr/0018-onboarding-checklist-computation.md)) | reads `accounts`, `tenants`, `provisioning_jobs`, `api_keys`, `tenant_domains`, `supplier_connections`, `payment_provider_connections`, `tenant_payout_accounts`, `tenant_memberships`, `tenant_invitations`, `subscriptions` | — | M1 |
| `goLive` | `POST /v1/tenants/{tenantId}/go-live` | `portal: owner`, MFA↑, `F:live_switch` | Switch the storefront to live | `{confirm: true}` → `200 Tenant`; creates the live `velexis` payment row when that is the mode | `tenants`, `payment_provider_connections`, audit | `LIVE_PRECONDITIONS_UNMET` (`details.missing`: `amadeus_live`, `payments_live`, `payout_account`, `plan_live_mode`, `subscription`, `mfa`), `TENANT_NOT_ACTIVE` | M5 |

## 8. Team and console (`MembershipsModule`)

| Operation | Method and path | Auth | Purpose | Request → response | Tables | Errors | M |
|---|---|---|---|---|---|---|---|
| `listMembers` | `GET /v1/tenants/{tenantId}/members` | `portal: member` | Team list | → `{data: [Member {id, accountId, fullName, email, role, status, mfaEnabled, createdAt, version}]}` | `tenant_memberships`, `accounts` | — | M1 |
| `updateMember` | `PATCH /v1/tenants/{tenantId}/members/{memberId}` | `portal: owner, admin` (granting owner: MFA↑) | Change a role | `If-Match`, `{role}` → `Member`; `membership` invalidation | `tenant_memberships`, audit | `FORBIDDEN` (admin granting owner or admin), `LAST_OWNER`, `PRECONDITION_FAILED` | M1 |
| `removeMember` | `DELETE /v1/tenants/{tenantId}/members/{memberId}` | `portal: owner, admin`, or the member themself | Remove or leave | → `204`; status `removed`, `membership` invalidation | `tenant_memberships`, audit | `FORBIDDEN`, `LAST_OWNER` | M1 |
| `listInvitations` | `GET /v1/tenants/{tenantId}/invitations` | `portal: owner, admin` | Pending invitations | → `{data: [Invitation {id, email, role, status, invitedBy, expiresAt, createdAt}]}` | `tenant_invitations` | — | M1 |
| `createInvitation` | `POST /v1/tenants/{tenantId}/invitations` | `portal: owner, admin` | Invite by e-mail | `{email, role}` → `201 Invitation` | `tenant_invitations`, `email_outbox`, audit | `FORBIDDEN`, `PLAN_LIMIT_REACHED`, `ALREADY_MEMBER`, `INVITATION_PENDING` | M1 |
| `resendInvitation` | `POST /v1/tenants/{tenantId}/invitations/{invitationId}/resend` | `portal: owner, admin` | New token and 7 more days | → `202` | `tenant_invitations`, `email_outbox` | `CONFLICT` (not pending) | M1 |
| `revokeInvitation` | `DELETE /v1/tenants/{tenantId}/invitations/{invitationId}` | `portal: owner, admin` | Revoke | → `204` | `tenant_invitations`, audit | `CONFLICT` | M1 |
| `lookupInvitation` | `POST /v1/invitations/lookup` | public | Show the accept page | `{token}` → `{tenantName, role, email, inviterName, expiresAt}` | `tenant_invitations` | `INVITATION_INVALID`, `RATE_LIMITED` | M1 |
| `acceptInvitation` | `POST /v1/invitations/accept` | `portal` | Join the OTA | `{token}` → `200 {membership: Member, tenant: TenantSummary}` | `tenant_invitations`, `tenant_memberships`, audit | `INVITATION_INVALID`, `INVITATION_EMAIL_MISMATCH`, `ALREADY_MEMBER` | M1 |
| `createConsoleToken` | `POST /v1/tenants/{tenantId}/console-token` | `portal: member` | One-time token for OTA admin SSO ([PADR-0007](adr/0007-portal-to-ota-admin-sso-token.md)) | → `201 {portalToken, expiresAt, consoleSsoUrl: "https://admin.ota.example.com/sso"}` (no-store) | Redis `ptk:<sha256>`, `tenant_memberships`, `tenants`, audit | `TENANT_NOT_ACTIVE`, `MFA_REQUIRED`, `RATE_LIMITED` | M4 |
