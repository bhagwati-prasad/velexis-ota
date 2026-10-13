# PADR-0011: Stripe Connect Standard and API-key connections

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when Stripe retires OAuth for Standard accounts in favour of Account Links only, or when an OTA needs several Stripe accounts per environment.

## Context

[`decisions.md`](../../../docs/mvp/decisions.md) §2 lets an OTA connect its own Stripe account "via Stripe Connect (Standard, OAuth) or by entering API keys". [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) defines the three `account_mode` values (`velexis`, `connect_standard`, `api_keys`), direct charges with `Stripe-Account` for Connect, and the OTA backend's webhook endpoints for payment events. The platform owns `payment_provider_connections` and must keep it accurate when an OTA changes or revokes access in Stripe, but the OTA backend cannot write platform tables. The planning brief named the first mode `velexis_platform`; ADR-0011 fixes the stored value `velexis`, which this document keeps.

## Decision

1. **Rows.** One `payment_provider_connections` row per tenant and environment (`stripe`), updated in place when the mode changes (the unique key allows one), with `version + 1` and an audit row recording the old and new mode. History is in the audit log.
2. **Connect OAuth.**
   - Authorise URL: `https://connect.stripe.com/oauth/authorize` with `response_type=code`, `client_id = STRIPE_CONNECT_CLIENT_ID`, `scope=read_write`, `state`, `redirect_uri = https://platform.example.com/connect/stripe/callback`, `stripe_user[email]`.
   - `state`: 256-bit random; Redis `stripe:oauth:<sha256(state)>` holds `{tenantId, accountId, membershipId}` for 10 minutes; redeemed with `GETDEL`; the callback must come from the same signed-in account, still owner or admin.
   - The code is exchanged by the platform API with Velexis's secret key (`stripe.oauth.token`). Only `stripe_user_id` (`acct_…`) and `livemode` are kept; the returned access and refresh tokens are **discarded**, because direct charges use Velexis's key plus `Stripe-Account`.
   - `livemode` must match the deployment (production live, other environments test). One OAuth connection serves both environments: the test row is updated at once, the live row now if the OTA is live, otherwise at go-live.
   - One `acct_…` per tenant (unique index for `connect_standard`), because Connect events are routed by `event.account`.
3. **Account state.** The platform has its own **Connect webhook endpoint** `/webhooks/stripe/connect-accounts` (secret `STRIPE_CONNECT_WEBHOOK_SECRET`) subscribed only to `account.updated` and `account.application.deauthorized`. `account.updated` refreshes `capabilities` (`chargesEnabled`, `payoutsEnabled`, `detailsSubmitted`) and sets `status` `active` or `pending`. `account.application.deauthorized` sets `disabled` and `disconnected_at` and e-mails the owners. The OTA backend's Connect endpoint keeps receiving the payment events, as [architecture flow (d)](../../../docs/mvp/architecture.md#d-stripe-webhooks-platform-billing-vs-ota-payments) defines; the two endpoints subscribe to disjoint event lists.
4. **No silent fallback.** A disabled Connect connection is not switched back to `velexis` automatically, because that changes who holds the customers' money and who settles it. The owner decides.
5. **API-key mode.** Publishable key, secret or restricted key and webhook signing secret are submitted, verified with `GET /v1/account` and applied as in [PADR-0010](0010-credential-submission-and-verification.md). The OTA configures its own webhook endpoint `https://api.ota.example.com/webhooks/stripe/c/<ppc_id>` in its Stripe dashboard; the `ppc_id` is stable because the row is updated in place. Restricted keys need write access to PaymentIntents and Refunds and read access to Charges and Disputes; the page lists them.
6. **Back to Velexis mode.** Owner with MFA step-up; for Connect, `stripe.oauth.deauthorize` is called (failure is logged, not blocking); keys, secrets and the account reference are cleared. Live requires a verified payout account ([PADR-0003](0003-settlement-of-velexis-collected-payments.md)).
7. **Existing payments are not moved.** The OTA backend processes each payment with the account recorded on the payment; a mode change affects new PaymentIntents only. The OTA plan records the mode and account on each payment row.
8. **Feature switch** `FEATURE_OWN_STRIPE` ([PADR-0015](0015-milestone-feature-switches.md)), on at M5.

## Consequences

### Positive

- Platform-owned connection state stays correct without the OTA backend writing platform tables.
- No OAuth tokens to store or rotate.
- The payments page shows the real capability state of a connected account.

### Negative

- Stripe now steers new platforms towards Account Links and controller properties; OAuth for Standard remains supported but is legacy. A migration may be needed later.
- A second Connect endpoint means one more signing secret to manage.
- An OTA whose Connect access is revoked cannot take card payments until the owner acts.

### Follow-ups

- Legal and Stripe review for `velexis` mode ([ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md)) also covers the Connect platform agreement.
- If Stripe deprecates OAuth for Standard, replace steps 2–3 with Account Links in a new PADR; rows and modes stay the same.

## Alternatives considered

- **Express or Custom connected accounts.** Velexis would carry more onboarding and compliance work; the product owner chose Standard.
- **Destination charges on Velexis's account.** Keeps funds on Velexis's balance; that is what `velexis` mode already is, with settlements.
- **Route account events to the OTA backend.** It cannot update platform rows.

## References

- [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md), [`../flows/stripe-payments-account.md`](../flows/stripe-payments-account.md), [`../api-inventory-admin.md`](../api-inventory-admin.md) §8
- Stripe Connect OAuth for Standard accounts: <https://docs.stripe.com/connect/oauth-standard-accounts>
