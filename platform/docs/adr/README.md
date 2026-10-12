# Platform architecture decision records

This folder holds the decision records that concern only the platform group (platform backend, portal, platform admin). They are numbered `PADR-NNNN` so they never clash with the cross-cutting `ADR-NNNN` of [`docs/mvp/adr/`](../../../docs/mvp/adr/README.md), use the same MADR-lite format ([ADR-0001](../../../docs/mvp/adr/0001-record-architecture-decisions.md)), and must not contradict [`decisions.md`](../../../docs/mvp/decisions.md) or any cross-cutting ADR. Precedence: `decisions.md` → cross-cutting ADRs → platform ADRs → plans → code.

Related: [platform docs index](../README.md), [`../architecture.md`](../architecture.md).

## Index

| PADR | Title | Status | In one line |
|---|---|---|---|
| [0001](0001-tenant-provisioning-orchestration.md) | Tenant provisioning orchestration | Accepted | OTA worker builds the schema, platform worker runs idempotent post-steps; dispatch gate, attempt-suffixed BullMQ ids, reconciler. |
| [0002](0002-stripe-billing-integration.md) | Stripe Billing integration details | Accepted | One Stripe Customer per tenant, plans ↔ prices with warnings, fixed Checkout parameters, inbox + re-fetch, manual-trial migration. |
| [0003](0003-settlement-of-velexis-collected-payments.md) | Settlement of Velexis-collected payments | Accepted | Monthly statements per tenant and currency from balance transactions, immutable once approved, carry-forward, manual bank payout. |
| [0004](0004-custom-domain-verification.md) | Custom-domain verification | Accepted | TXT ownership plus CNAME or A/AAAA routing, public resolvers, 72 h window, daily three-strike re-check, `ask` rules, TLS warm-up. |
| [0005](0005-api-key-format-and-hashing.md) | API key format and hashing | Accepted | `<pk\|sk>_<env>_` + 40 base62, 14-character prefix, HMAC-SHA-256 with pepper, shown once, scope and origin rules from the OTA contract. |
| [0006](0006-platform-admin-access-and-audit.md) | Platform admin access and audit | Accepted | Separate audience, MFA always, step-up and reasons for sensitive actions, CLI bootstrap, append-only audit by privilege. |
| [0007](0007-portal-to-ota-admin-sso-token.md) | Portal to OTA admin SSO token | Accepted | `ptk_` 256-bit in Redis for 60 s, POST-only hand-off page, preconditions, `staffdeny:acct:<id>` for cross-boundary revocation. |
| [0008](0008-email-verification-and-mfa-policy.md) | E-mail verification and MFA policy | Accepted | Limited session before verification; MFA optional except admins, sensitive actions (step-up) and live OTAs' console access. |
| [0009](0009-platform-api-surface-and-authentication.md) | Platform API surface and authentication | Accepted | `/v1` portal, `/v1/admin`, webhooks and internal surfaces; path-based tenant roles; lifetimes; idempotency; error catalogue. |
| [0010](0010-credential-submission-and-verification.md) | Credential submission and verification | Accepted | Own Amadeus and Stripe credentials staged encrypted, verified by a worker, applied atomically, secrets purged. |
| [0011](0011-stripe-connect-standard-and-api-key-connections.md) | Stripe Connect Standard and API-key connections | Accepted | OAuth with discarded tokens, one account per tenant, platform Connect endpoint for account events, no silent fallback. |
| [0012](0012-amadeus-office-pool.md) | Amadeus office pool | Accepted | `available → assigned → releasing → available`; manual release after the OTA confirms no open bookings. |
| [0013](0013-platform-email-outbox.md) | Platform e-mail outbox | Accepted | Outbox row in the business transaction, encrypted secret links purged at a final status, template list. |
| [0014](0014-tenant-suspension-and-resume.md) | Tenant suspension and resume | Accepted | Status switch blocks traffic at once; `tenant.suspend` only cleans up; paid travellers keep tickets and e-mails. |
| [0015](0015-milestone-feature-switches.md) | Milestone feature switches | Accepted | Six `FEATURE_*` booleans, default off, enforced in the backend, removed one release after M5. |

## Adding a platform ADR

1. Copy the template of [ADR-0001](../../../docs/mvp/adr/0001-record-architecture-decisions.md) into `NNNN-kebab-title.md` with the next free number and the heading `# PADR-NNNN: Title`.
2. Use status `Proposed` in the pull request; the developer sets `Accepted` on merge.
3. Add a row to the index above and, if it changes a document, update that document in the same pull request.
4. If the decision needs behaviour from the OTA group (a queue message consumer, a shared Redis key, a resolver rule), name that requirement under **Follow-ups** so the OTA plan picks it up, as PADR-0007, 0012 and 0014 do. If it changes a cross-cutting decision, write a cross-cutting ADR in `docs/mvp/adr/` instead.
