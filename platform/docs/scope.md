# Platform MVP scope

This document fixes what the platform group (platform backend, portal, platform admin) delivers in the MVP: what is in, out and later for each component, who the users are and what each role may do, and every feature with acceptance-level criteria and its milestone. Plans and tests derive from it. It follows [`decisions.md`](../../docs/mvp/decisions.md) and the shared milestones M0–M6 in [`docs/mvp/README.md`](../../docs/mvp/README.md#1-shared-milestones).

Related: [`architecture.md`](architecture.md), [`api-inventory.md`](api-inventory.md), [`data-model.md`](data-model.md), [flows](README.md#flows), [platform ADRs](adr/README.md).

## 1. Users and roles

### 1.1 Kinds of users

| User | Identity | Where they work | Notes |
|---|---|---|---|
| **Portal account** | `platform.accounts` (`acc_…`), e-mail + Argon2id password, optional TOTP | Portal `platform.example.com` | Anyone who signs up. Owns or joins OTAs through memberships. |
| **OTA member** | `platform.tenant_memberships` (`stf_…`) with a role | Portal (management) and OTA admin `admin.ota.example.com` (operations, through SSO) | One membership per account and OTA. |
| **Platform admin** | Same account with `accounts.is_platform_admin = true`, TOTP mandatory | Platform admin `admin.platform.example.com` | Velexis staff. Granted by another platform admin, the first one by a CLI command ([PADR-0006](adr/0006-platform-admin-access-and-audit.md)). |

### 1.2 Membership roles in the portal

The roles are the five of `tenant_memberships.role`. In the OTA admin they map to `StaffPermission` values as the OTA contract defines (owner and admin all; agent all but `amadeus:write`; finance and viewer read-only sets). In the portal they mean:

| Portal action | owner | admin | agent | finance | viewer |
|---|---|---|---|---|---|
| See the OTA overview, status, storefront link, onboarding checklist | ✓ | ✓ | ✓ | ✓ | ✓ |
| Open console (SSO into the OTA admin) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Edit the OTA profile (name, legal name, support e-mail, country, time zone) | ✓ | ✓ | | | |
| Create, roll and revoke API keys | ✓ | ✓ | | | |
| Add, verify, make primary and remove custom domains | ✓ | ✓ | | | |
| See Amadeus and payment connections (masked) | ✓ | ✓ | | ✓ | |
| Change Amadeus or Stripe connections, enter credentials (MFA step-up) | ✓ | ✓ | | | |
| Invite and manage agent, finance and viewer members | ✓ | ✓ | | | |
| Grant or remove owner and admin roles | ✓ | | | | |
| See subscription, plan and invoices | ✓ | | | ✓ | |
| Choose a plan, open the Stripe Customer Portal (change plan, card, cancel) | ✓ | | | | |
| See settlements and the payout account (masked) | ✓ | | | ✓ | |
| Set the payout bank account (MFA step-up) | ✓ | | | | |
| Switch the storefront to live (MFA step-up) | ✓ | | | | |

An OTA always keeps at least one active owner. Several owners are allowed.

### 1.3 Platform admin

A platform admin can read every tenant's control-plane data and perform the admin operations of [`flows/platform-admin-operations.md`](flows/platform-admin-operations.md). There are no admin sub-roles in the MVP. Every admin action is audited with `actor_type = 'platform_admin'`, and destructive ones require a reason. A platform admin has **no** access to tenant data (bookings, customers) through the platform; that would go through an OTA membership like anyone else.

## 2. Scope per component

### 2.1 Platform backend (`platform/backend`)

| In the MVP | Out of the MVP | Later (named trigger) |
|---|---|---|
| Accounts, e-mail verification, password reset, sign-in, TOTP MFA with recovery codes, sessions with rotating refresh tokens (M1) | Social sign-in, SAML/OIDC for portal accounts | When an enterprise customer asks ([ADR-0008](../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md)) |
| Tenants, memberships, invitations, the provisioning orchestration, suspend and resume (M1) | Tenant export and deletion jobs (`tenant.export`, `tenant.delete`) | After the MVP, with the data retention policy |
| API keys `pk_` and `sk_`, test and live (M1, live in M5) | Hosting keys `hk_` and `api_key_tenant_grants` management | When an agency serving several OTAs from one deployment signs up |
| Sub-domain per OTA, custom domains with DNS verification, the TLS `ask` endpoint (sub-domains M1, custom M5) | Custom API hosts (`purpose = 'api'`), console hosts | When a third-party storefront needs a branded API host |
| Velexis Amadeus account and office pool, test office at provisioning (M1); live offices and OTA-owned credentials (M5) | Automated Amadeus office ordering | When more than 20 OTAs are live ([ADR-0012](../../docs/mvp/adr/0012-amadeus-account-model.md)) |
| Payment connections: Velexis mode (M1 rows, used from M3), Connect Standard and API keys (M5) | Other PSPs (Adyen, Checkout.com, PayPal) | When an OTA brings one |
| Stripe Billing: plans ↔ prices, Checkout, Customer Portal, webhook sync, dunning suspension (M5); manual trial before M5 (M1) | Metered per-booking usage fees, Stripe Tax | After the MVP ([ADR-0013](../../docs/mvp/adr/0013-subscription-billing-stripe-billing.md)) |
| Monthly settlement statements for Velexis-collected payments, manual payout (M5) | Automated payouts (Stripe Connect transfers, bank API) | When settlement volume makes manual transfers a burden |
| Platform audit log, platform e-mails (M1); reference data loaded by the foundation loader `tools/reference-data` (M0, [ADR-0024](../../docs/mvp/adr/0024-reference-data-sources-and-loader.md)) | Bounce and complaint webhooks | After the MVP ([ADR-0017](../../docs/mvp/adr/0017-email-documents-storage.md)) |
| Admin API for all admin pages | Admin sub-roles, impersonation | When Velexis has more than two staff |

### 2.2 Portal (`platform/frontend`)

| In the MVP | Out | Later |
|---|---|---|
| Marketing landing and pricing page (static content plus public plans) | CMS, blog, localisation | After launch |
| Sign-up, sign-in, MFA, verify e-mail, password reset, account security page | Account deletion self-service (support handles it) | With the GDPR tooling |
| Create OTA wizard, setup progress page, onboarding checklist, OTA dashboard | Booking statistics on the dashboard | Needs live OTA data, revisit with [ADR-0003](../../docs/mvp/adr/0003-six-components-two-nestjs-backends.md) follow-up |
| API keys, domains, Amadeus, payments (connections, settlements, payout account), team, billing, OTA settings | Storefront branding, markups, templates (these are in the OTA admin) | — |
| "Open console" SSO and the OTA picker for the OTA admin | — | — |

### 2.3 Platform admin (`platform/admin`)

| In the MVP | Out | Later |
|---|---|---|
| Dashboard, tenants (list, detail, suspend, resume, migrate), provisioning jobs (retry, cancel), queues view, audit log, platform admins, accounts support (M1) | Editing tenant data inside tenant schemas | Never through the platform |
| Velexis Amadeus accounts and office pool (M1 test, M5 live) | — | — |
| Plans ↔ Stripe prices, subscriptions, invoices, Stripe events, settlements, domains (M5) | Revenue reporting, charts | After the MVP |

## 3. Features with acceptance criteria

Each feature has an id used by the plans and by test names. "AC" lines are what the integration or end-to-end tests prove. Errors use the codes of [`api-inventory.md`](api-inventory.md#3-error-catalogue).

### 3.1 Identity (M1)

**PF-01 Sign-up.** Form: full name, e-mail, password, acceptance of the terms.
- AC1: A new e-mail creates an account in `pending_verification` with an Argon2id hash and `terms_accepted_at`, and queues a verification e-mail. The response is `202` whether or not the e-mail exists; an existing address receives a "you already have an account" e-mail instead (no enumeration).
- AC2: A password shorter than 10 characters or on the breached list is refused with `PASSWORD_TOO_WEAK`.
- AC3: More than 5 sign-ups per IP per hour answer `429 RATE_LIMITED`.

**PF-02 E-mail verification.**
- AC1: The link `https://platform.example.com/verify-email?token=…` activates the account once; a second use, an expired (24 h) or unknown token answers `VERIFICATION_TOKEN_INVALID`.
- AC2: Resend is possible 3 times per hour and always answers `202`.
- AC3: An unverified account can sign in, but every endpoint except the account, resend and sign-out answers `403 EMAIL_NOT_VERIFIED`, and the portal shows the "check your e-mail" page.

**PF-03 Sign-in and lockout.**
- AC1: Valid credentials return a 15-minute access token and a rotating refresh token, stored by the portal in `__Host-vxp_at` and `__Host-vxp_rt` httpOnly cookies.
- AC2: Wrong e-mail and wrong password give the same `401 INVALID_CREDENTIALS`. Five consecutive failures lock the account for 15 minutes (`423 ACCOUNT_LOCKED` with `Retry-After`).
- AC3: Reusing a rotated refresh token revokes the whole family (`REFRESH_TOKEN_REUSED`).

**PF-04 MFA (TOTP).**
- AC1: Set-up shows a QR code and the base32 secret; enabling requires a valid code and returns 10 recovery codes shown once.
- AC2: With MFA on, sign-in returns an MFA challenge; a valid TOTP (±1 step) or an unused recovery code completes it; five wrong codes end the challenge.
- AC3: Disabling MFA requires a fresh TOTP code. Platform admins cannot disable it.

**PF-05 Password reset.** AC1: The request always answers `202`; the link is valid 1 hour and once. AC2: A reset revokes every session of the account and every OTA admin staff session ([PADR-0007](adr/0007-portal-to-ota-admin-sso-token.md)).

**PF-06 Sessions.** AC1: The security page lists active sessions (device, IP, last use) and revokes one. AC2: "Sign out everywhere" revokes all portal and admin sessions and all OTA admin staff sessions of the account.

**PF-07 Profile.** AC1: Full name, locale and time zone are editable with optimistic locking (`If-Match`, `412 PRECONDITION_FAILED` when stale).

### 3.2 OTA lifecycle

**PF-10 Create OTA (M1; Checkout added in M5).** Wizard: OTA name, key (shown live as `<key>.ota.example.com`), country, default currency, time zone, plan.
- AC1: The key must match `^[a-z][a-z0-9]{2,29}$`, not be reserved, and never have been used; availability is checked as the user types (`GET /v1/tenants/key-availability`).
- AC2: Submitting creates, in one transaction, the tenant (`provisioning`), the owner membership, the subscription, the sub-domain, the provisioning job and an audit row, and is idempotent per `Idempotency-Key`.
- AC3: Before M5 (`FEATURE_STRIPE_BILLING=false`) the subscription is `trialing` with `billing_provider = 'manual'` on the `early_access` plan and provisioning starts at once. From M5 the user is sent to Stripe Checkout, and provisioning starts on the `checkout.session.completed` webhook.
- AC4: An account may own at most `MAX_TENANTS_PER_ACCOUNT` (default 3) OTAs that are not `failed` (`422 UNPROCESSABLE`, `details.reason = "tenant_limit"`).

**PF-11 Provisioning progress.** AC1: The setup page shows the job steps and becomes "live" when the tenant is `active`, normally within one minute. AC2: A failed tenant shows "setup failed" with a retry button for owners; the retry creates a new job. AC3: The test API keys issued during provisioning are revealed once, within 24 hours.

**PF-12 Onboarding checklist.** Computed, never stored: account verified, MFA on, OTA active, first API key created or revealed, storefront opened, Amadeus test office active, team member invited, (M5) plan chosen, custom domain verified, own Stripe or payout account set, live requested. AC1: Each item links to the page that completes it.

**PF-13 OTA profile.** AC1: Owners and admins edit name, legal name, support e-mail, country and time zone; the key and currency are read-only after creation (branding and currencies of the storefront are OTA admin settings).

**PF-14 Live switch (M5).** AC1: "Go live" requires an active live Amadeus connection, an active live payment connection, a plan with `limits.liveMode = true`, a subscription `trialing` or `active` on Stripe, and owner MFA step-up; otherwise `422 LIVE_PRECONDITIONS_UNMET` lists what is missing. AC2: Success sets `tenants.storefront_environment = 'live'` and publishes a cache invalidation; the hosted storefront serves live within 60 seconds.

### 3.3 Team and console

**PF-20 Invitations (M1).** AC1: Owners and admins invite by e-mail with a role; only owners invite owners or admins. AC2: Active members plus pending invitations may not exceed `limits.staffSeats` (`PLAN_LIMIT_REACHED`). AC3: The link is valid 7 days and only for an account with the same verified e-mail (`INVITATION_EMAIL_MISMATCH`). AC4: Revoke and resend are available.

**PF-21 Roles and removal (M1).** AC1: Role changes and removals follow §1.2. AC2: The last active owner cannot be demoted or removed (`409 LAST_OWNER`). AC3: A removed member loses OTA admin access within 60 seconds.

**PF-22 Open console (M4).** AC1: Any active member gets a one-time portal token and lands signed in on `admin.ota.example.com` for that OTA. AC2: The token is single use, valid 60 seconds, never in a URL, and its issue is audited. AC3: When the OTA is live, members without MFA get `403 MFA_REQUIRED` and are sent to MFA set-up ([PADR-0008](adr/0008-email-verification-and-mfa-policy.md)).

### 3.4 API keys (M1; live keys M5)

**PF-30.** AC1: Create a publishable or secret key for test (live once the OTA is live); the full key is shown once and only its HMAC is stored ([PADR-0005](adr/0005-api-key-format-and-hashing.md)). AC2: Publishable keys carry an origin allow-list; secret keys carry scopes (`storefront` by default, or `console`, or `console:automation` plus permissions). AC3: Revoke takes effect on the OTA API within 60 seconds. AC4: "Roll" creates a new key and expires the old one after a chosen delay (now, 1 h, 24 h, 7 days). AC5: `last used` is shown, at most 5 minutes stale. AC6: Creating a live secret key needs MFA step-up.

### 3.5 Domains

**PF-40 Sub-domain (M1).** AC1: Every OTA gets `<key>.ota.example.com`, verified at creation; the `ask` endpoint allows it for tenants in `provisioning`, `active` or `suspended`.

**PF-41 Custom domains (M5).** AC1: Adding `travel.acme.com` shows a CNAME (or A/AAAA for an apex) and a TXT `_velexis` record. AC2: The domain becomes `verified` within 5 minutes of correct DNS, or `failed` after 72 hours. AC3: The first HTTPS request obtains a certificate; `tls_status` and expiry are shown after the daily probe. AC4: A verified domain can be made primary. AC5: Plans without `limits.customDomains` answer `FEATURE_DISABLED`.

**PF-42 TLS ask (M1).** AC1: `GET /internal/tls/ask?domain=` answers `200` only per [ADR-0018](../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md) rules, from `127.0.0.1` only, with a 60 s cache.

### 3.6 Amadeus connection

**PF-50 Shared test office (M1).** AC1: Provisioning assigns a free test office of the Velexis test account and creates an `active` `velexis` connection. AC2: With no free office, provisioning still succeeds, the connection is `pending_verification`, and admins are alerted.

**PF-51 Live office (M5).** AC1: An owner requests live access; a platform admin assigns a live office; the connection becomes `active`.

**PF-52 Own credentials (M5).** AC1: Owner or admin enters client id, secret and office ids (MFA step-up). AC2: The platform verifies them with an OAuth token request in a worker job; success switches the connection to `tenant` credentials and releases the shared office later; failure leaves the connection unchanged and e-mails the submitter.

**PF-53 Connection settings (M4).** AC1: Default, queuing and owner offices (within the connection's offices), ticketing defaults and monitored queues are editable and invalidate the OTA cache.

### 3.7 Payments

**PF-60 Velexis Stripe by default (M1 rows, used in M3).** AC1: Every OTA has a `velexis`-mode test connection after provisioning, and a live one at go-live.

**PF-61 Stripe Connect Standard (M5).** AC1: "Connect Stripe" runs OAuth and switches the connection to `connect_standard` with the `acct_…` id. AC2: Deauthorisation in Stripe disables the connection and e-mails the owners; there is no silent fallback to Velexis mode.

**PF-62 Stripe API keys (M5).** AC1: Publishable key, secret (or restricted) key and webhook signing secret are verified against Stripe and stored encrypted; the page shows the webhook URL to configure.

**PF-63 Settlements (M5).** AC1: On the 3rd of each month a draft statement per OTA and currency is built from the Velexis Stripe balance transactions of the previous month. AC2: An admin approves and marks it paid with a bank reference; the owners and finance members are e-mailed. AC3: The portal lists statements and downloads their lines as CSV.

**PF-64 Payout account (M5).** AC1: The owner enters holder name, country, currency and IBAN or account number (encrypted, shown masked). AC2: A platform admin marks it verified before the first payout; revealing it in the admin is audited.

### 3.8 Billing

**PF-70 Plans and pricing page (M1).** AC1: The pricing page lists public, active plans with monthly and annual prices and limits.

**PF-71 Checkout (M5).** AC1: Choosing a plan opens Stripe Checkout; the webhook, not the redirect, activates the subscription. AC2: An abandoned Checkout leaves the tenant `provisioning`; after 48 hours it becomes `failed` and the key stays reserved.

**PF-72 Customer Portal (M5).** AC1: The billing page opens a Stripe Customer Portal session for owners.

**PF-73 Sync and invoices (M5).** AC1: Duplicate or out-of-order webhook events leave the same final state (handlers re-fetch from Stripe). AC2: Invoices list number, period, total, status and Stripe-hosted links.

**PF-74 Dunning (M5).** AC1: `past_due` shows a banner in the portal. AC2: `canceled` or `unpaid` suspends the tenant with reason `billing`; a new active subscription resumes it.

**PF-75 Manual trial before M5 (M1).** AC1: Pre-M5 tenants run on `early_access` with `billing_provider = 'manual'`; at M5 owners are asked to choose a plan 14 days before `trial_ends_at` and suspended 14 days after it if they do not.

### 3.9 Platform admin

| Id | Feature | Milestone | Acceptance |
|---|---|---|---|
| PF-80 | Admin sign-in | M1 | Only accounts with `is_platform_admin` and MFA enabled; TOTP on every sign-in; sessions last at most 12 hours. |
| PF-81 | Tenants | M1 | Search by key, name, owner e-mail, status, plan; detail shows members, subscription, connections, domains, jobs and recent audit. |
| PF-82 | Suspend and resume | M1 | Reason required; storefront and OTA API answer `TENANT_SUSPENDED` within 60 s; audited; `tenant.suspend` sent to the OTA backend. |
| PF-83 | Provisioning jobs | M1 | Filter by status and kind; step log; retry a failed job; cancel a queued one. |
| PF-84 | Queues view | M1 | Waiting, active, delayed and failed counts for every queue of both backends; failed job reasons; retry for platform queues only. |
| PF-85 | Audit log | M1 | Filter by tenant, actor, action, period; CSV export (itself audited). |
| PF-86 | Platform admins | M1 | Grant to an existing account with MFA; revoke; never the last admin or oneself. |
| PF-87 | Account support | M1 | Unlock, disable, enable, reset MFA (reason required, owner e-mailed). |
| PF-90 | Amadeus accounts and offices | M1 (test), M5 (live) | Enter and verify shared credentials; add offices in bulk; assign, release, retire; pool level alert below 3 free offices. |
| PF-88 | Plans ↔ Stripe prices | M5 | Link product and price ids; mismatches in amount, currency or interval are shown as warnings. |
| PF-89 | Subscriptions, invoices, Stripe events | M5 | Lists with filters; resync a subscription; reprocess a failed event. |
| PF-91 | Settlements | M5 | Generate, review lines, approve, mark paid, void a draft; reveal a payout account (audited). |
| PF-92 | Domains | M5 | All custom domains with status; re-check; remove an abusive domain. |

### 3.10 Cross-cutting

| Id | Feature | Milestone | Acceptance |
|---|---|---|---|
| PF-95 | Audit | M1 | Every state change of §3 writes one `platform_audit_log` row with actor, action, target, request id and redacted before/after. The app role cannot update or delete audit rows. |
| PF-96 | Rate limits | M1 | Limits of [`api-inventory.md`](api-inventory.md#2-conventions) on auth, key-availability, console token, domain checks; `429` with `Retry-After`. |
| PF-97 | Platform e-mails | M1 | Templates: verify e-mail, account exists, password reset, password changed, MFA changed, invitation, welcome (OTA live), provisioning failed, (M5) payment failed, trial ending, tenant suspended or resumed, domain verified or failed, credentials verified or failed, settlement paid, Stripe disconnected. |
| PF-98 | Reference data | M0 | The foundation loader `tools/reference-data` (`pnpm db:seed:reference`, [ADR-0024](../../docs/mvp/adr/0024-reference-data-sources-and-loader.md)) fills `reference` (currencies, countries, time zones, cities, airports, airlines, aircraft) idempotently from vendored files in the repository. The platform backend owns the schema's migrations and has no loader of its own. |
