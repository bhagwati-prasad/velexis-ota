# Platform flows at a glance

This document gives one compact sequence diagram for every platform flow, so the whole control plane can be read on one page. Each section links to the detailed flow document, which has the full steps, failure handling and tables. It complements [`architecture.md`](architecture.md) and the cross-cutting flows (a), (c), (d) and (e) of [`docs/mvp/architecture.md`](../../docs/mvp/architecture.md#5-request-flows), which it follows.

Participants used below: **U** user's browser, **FE** portal server (Next.js), **AD** platform admin server, **PA** platform API, **PW** platform worker, **P** PostgreSQL `platform`, **R** Redis, **OW** OTA worker, **O** OTA API, **S** Stripe, **A** Amadeus, **DNS**, **C** Caddy.

## 1. Sign-up and create OTA

Details: [`flows/signup-and-create-ota.md`](flows/signup-and-create-ota.md).

```mermaid
sequenceDiagram
  autonumber
  actor U
  participant FE
  participant PA
  participant P
  participant PW
  participant S
  U->>FE: Sign up
  FE->>PA: POST /v1/auth/sign-up
  PA->>P: accounts (pending_verification), account_tokens, email_outbox
  PW-->>U: Verification e-mail
  U->>FE: Open link, sign in (TOTP if enabled)
  FE->>PA: POST /v1/auth/verify-email, /v1/auth/sign-in
  U->>FE: Create OTA wizard
  FE->>PA: POST /v1/tenants (Idempotency-Key)
  PA->>P: tenant, owner membership, subscription, sub-domain, provisioning job, audit
  alt Before M5
    PA->>R: dispatch tenant.provision
  else M5
    PA->>S: Checkout Session
    PA-->>FE: checkoutUrl
    U->>S: Pay or start trial
    S->>PA: checkout.session.completed
    PW->>R: dispatch tenant.provision
  end
```

## 2. Provisioning

Details: [`flows/provisioning.md`](flows/provisioning.md), [PADR-0001](adr/0001-tenant-provisioning-orchestration.md).

```mermaid
sequenceDiagram
  autonumber
  participant PA
  participant P
  participant R as Redis (BullMQ)
  participant OW
  participant PW
  PA->>P: provisioning_jobs queued → running (attempt 1, lease 15 min)
  PA->>R: ota-tenant-ops tenant.provision (job id job_x-1)
  OW->>OW: create_schema, run_migrations, seed_defaults (one transaction)
  OW->>R: platform-tenant-events tenant.provisioned
  PW->>P: record_migrations
  PW->>P: assign_amadeus_office, create_payment_connection
  PW->>P: issue_api_keys (pk_test, sk_test, reveal once)
  PW->>P: activate: tenants.status active, audit
  PW->>R: publish vx:invalidate tenant, queue welcome e-mail
  Note over PW,P: Reconciler every 5 min re-dispatches lost jobs
```

## 3. Amadeus connection

Details: [`flows/amadeus-connection.md`](flows/amadeus-connection.md), [PADR-0012](adr/0012-amadeus-office-pool.md), [PADR-0010](adr/0010-credential-submission-and-verification.md).

```mermaid
sequenceDiagram
  autonumber
  actor Admin as Platform admin
  actor Owner as OTA owner
  participant PA
  participant PW
  participant P
  participant A
  Admin->>PA: Velexis account credentials, office pool
  PW->>A: OAuth token request (verify)
  PW->>P: amadeus_accounts active, amadeus_offices available
  Note over PW,P: At provisioning: test office assigned, connection velexis/active
  Owner->>PA: Own credentials (M5, MFA step-up)
  PA->>P: credential_submissions pending (secret encrypted)
  PW->>A: OAuth token request with the OTA's credentials
  PW->>P: supplier_connections credential_source tenant, office → releasing
  PW->>PW: publish vx:invalidate connection
```

## 4. Stripe payments account and settlements

Details: [`flows/stripe-payments-account.md`](flows/stripe-payments-account.md), [PADR-0011](adr/0011-stripe-connect-standard-and-api-key-connections.md), [PADR-0003](adr/0003-settlement-of-velexis-collected-payments.md).

```mermaid
sequenceDiagram
  autonumber
  actor Owner as OTA owner
  participant FE
  participant PA
  participant S
  participant P
  participant PW
  Note over PA,P: Provisioning: payment connection test, account_mode velexis
  Owner->>FE: Connect Stripe (M5)
  FE->>PA: POST …/stripe-connect/start
  PA-->>Owner: connect.stripe.com authorize URL (state in Redis)
  Owner->>S: Authorise Velexis
  S-->>FE: /connect/stripe/callback?code&state
  FE->>PA: POST /v1/payment-connections/stripe-connect/callback
  PA->>S: oauth.token, accounts.retrieve
  PA->>P: account_mode connect_standard, acct_…
  Note over PW,S: Monthly (velexis mode): balance transactions → settlements draft
  PW->>S: list balance transactions of last month
  PW->>P: settlements + settlement_lines (draft)
```

## 5. Subscription billing

Details: [`flows/subscription-billing.md`](flows/subscription-billing.md), [PADR-0002](adr/0002-stripe-billing-integration.md).

```mermaid
sequenceDiagram
  autonumber
  participant S
  participant C
  participant PA
  participant P
  participant R
  participant PW
  S->>C: POST /webhooks/stripe/billing
  C->>PA: raw body + Stripe-Signature
  PA->>P: stripe_events insert (event id unique)
  PA->>R: platform-stripe-events stripe.event
  PA-->>S: 200
  PW->>S: re-fetch subscription / invoice / session
  PW->>P: subscriptions, invoices, tenants.plan_code
  alt canceled or unpaid
    PW->>P: tenant suspended (billing), provisioning_jobs suspend
    PW->>R: tenant.suspend, vx:invalidate tenant
  end
```

## 6. Custom domains

Details: [`flows/custom-domains.md`](flows/custom-domains.md), [PADR-0004](adr/0004-custom-domain-verification.md).

```mermaid
sequenceDiagram
  autonumber
  actor Owner
  participant PA
  participant PW
  participant DNS
  participant C
  actor B as Traveller
  Owner->>PA: POST …/domains travel.acme.com
  PA-->>Owner: CNAME → acme.ota.example.com, TXT _velexis
  loop every 5 min, up to 72 h
    PW->>DNS: TXT and CNAME (or A/AAAA)
  end
  PW->>PW: verified, publish vx:invalidate domain
  B->>C: TLS handshake travel.acme.com
  C->>PA: GET /internal/tls/ask?domain=travel.acme.com
  PA-->>C: 200
  C-->>B: certificate (Let's Encrypt) and storefront
```

## 7. API keys

Details: [`flows/api-keys.md`](flows/api-keys.md), [PADR-0005](adr/0005-api-key-format-and-hashing.md).

```mermaid
sequenceDiagram
  autonumber
  actor Owner
  participant FE
  participant PA
  participant P
  participant R
  participant O
  Owner->>FE: Create secret key (test, scope storefront)
  FE->>PA: POST /v1/tenants/{id}/api-keys
  PA->>P: api_keys (prefix, HMAC, last4), audit
  PA-->>FE: full key once (no-store)
  O->>R: apikey:used:<keyId> on each request
  Note over PA,R: Worker flushes usage every 5 min
  Owner->>FE: Revoke
  PA->>P: revoked_at
  PA->>R: vx:invalidate api_key
```

## 8. Team and OTA admin SSO

Details: [`flows/team-and-ota-admin-sso.md`](flows/team-and-ota-admin-sso.md), [PADR-0007](adr/0007-portal-to-ota-admin-sso-token.md).

```mermaid
sequenceDiagram
  autonumber
  actor M as Member
  participant FE
  participant PA
  participant R
  participant OA as OTA admin server
  participant O
  M->>FE: POST Open console (Acme)
  FE->>PA: POST /v1/tenants/{id}/console-token
  PA->>PA: active membership, tenant active, MFA policy
  PA->>R: SET ptk:sha256 {account, tenant, membership} EX 60 NX
  PA-->>FE: ptk_…
  FE-->>M: auto-submitting POST form to admin.ota.example.com/sso
  M->>OA: POST /sso portalToken
  OA->>O: console.auth.signIn portal_token
  O->>R: GETDEL ptk:sha256
  O-->>OA: staff tokens
```

## 9. Platform admin operations

Details: [`flows/platform-admin-operations.md`](flows/platform-admin-operations.md), [PADR-0006](adr/0006-platform-admin-access-and-audit.md), [PADR-0014](adr/0014-tenant-suspension-and-resume.md).

```mermaid
sequenceDiagram
  autonumber
  actor V as Velexis staff
  participant AD
  participant PA
  participant P
  participant R
  participant OW
  V->>AD: Sign in + TOTP
  AD->>PA: POST /v1/admin/auth/sign-in, /mfa/verify
  V->>AD: Suspend tenant (reason)
  AD->>PA: POST /v1/admin/tenants/{id}/suspend
  PA->>P: tenants suspended, provisioning_jobs suspend, audit (platform_admin)
  PA->>R: vx:invalidate tenant, ota-tenant-ops tenant.suspend
  OW->>R: platform-tenant-events tenant.suspended
```
