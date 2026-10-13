# PADR-0010: Credential submission and verification

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when more providers (another PSP, another GDS) need the same flow, or when verification needs more than one call.

## Context

From M5 an OTA can replace a working connection with its own credentials: Amadeus client id, secret and office ids ([ADR-0012](../../../docs/mvp/adr/0012-amadeus-account-model.md): verified "with an OAuth token request through a platform worker job"), or Stripe publishable key, secret key and webhook secret ([ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) `api_keys` mode). The secret must reach the worker without passing through a queue message ([ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md) point 10), and a typo must not break the OTA's working connection. The connection tables allow one row per tenant, provider and environment.

## Decision

1. **Staging table** `platform.credential_submissions` (`crs_…`): `kind` (`amadeus`, `stripe_api_keys`), `environment`, `public_data` (non-secret fields), `secret_ciphertext`, `webhook_secret_ciphertext`, `status`, error fields. The OTA backend has no access to it.
2. **Lifecycle:** `pending` → `verifying` → `applied` or `failed`; a newer submission for the same tenant, kind and environment marks an open one `superseded`. One open submission per tenant, kind and environment (partial unique index).
3. **Secrets are erased** when the submission reaches a final status. A CHECK constraint refuses a final status that still holds ciphertext. Final rows are deleted after 90 days.
4. **Verification job** `credentials.verify {submissionId}` on `platform-connections` (attempts 5, backoff):
   - Amadeus: token request to the environment's Amadeus host with `client_credentials`; the token is discarded. Office ids are validated by format (9 characters) and the defaults must be among them. Amadeus offers no cheap check that the credentials may act for an office, so office access is proved by the OTA's first calls; the OTA admin's supplier log shows `OFFICE_NOT_ALLOWED` errors.
   - Stripe: `GET /v1/account` with the secret or restricted key; `livemode` must match the environment; the account id becomes `account_reference`. Key prefixes are checked on submit (`pk_test_`/`pk_live_`, `sk_`/`rk_`, `whsec_`).
5. **Apply in one transaction** with the verified result: update the tenant's connection row in place (or insert it), **re-encrypting** the secret with the connection's associated data ([ADR-0010](../../../docs/mvp/adr/0010-secrets-envelope-encryption.md)); for Amadeus move the shared office of that environment to `releasing`; mark the submission `applied` and erase its secrets; audit (no secrets). After commit publish `vx:invalidate connection` and e-mail the submitter.
6. **Failure** leaves the connection untouched. The submission stores a stable `error_code` for the portal (`AMADEUS_CREDENTIALS_INVALID`, `STRIPE_KEY_INVALID`, `STRIPE_LIVEMODE_MISMATCH`, `PROVIDER_UNAVAILABLE`) and a sanitised message (HTTP status and provider error code, never a body or a secret). These are submission result codes, not HTTP error codes of the API.
7. **Sensitive action.** Submitting requires owner or admin role and an MFA step-up ([PADR-0008](0008-email-verification-and-mfa-policy.md)). The request body fields `clientSecret`, `secretKey`, `webhookSecret` are on the logger's redaction list.
8. **Shared Velexis Amadeus credentials** (platform admin) are verified by the same worker code path (`amadeus_account.verify`) but stored directly in `amadeus_accounts`, because there is no working connection to protect and only admins edit them.

## Consequences

### Positive

- A wrong key never breaks a live OTA: the switch happens only after a successful check.
- Secrets exist in clear only inside the worker during the check and the re-encryption.
- One mechanism for both providers, easy to extend.

### Negative

- Verification proves the credentials authenticate, not that every office or every Stripe capability works.
- Asynchronous: the portal polls the submission for a few seconds instead of getting an immediate answer.

### Follow-ups

- Optional Amadeus office probe (a cheap read with the office id) if the stub and real behaviour show a reliable one.

## Alternatives considered

- **Verify synchronously in the API request.** Simpler, but ties an HTTP request to an external call and contradicts ADR-0012's worker job; the staging row is still needed for retries.
- **Write the new credentials straight into the connection and roll back on failure.** The OTA backend would read the untested values in the meantime.
- **Pending columns on the connection tables.** Doubles every credential column and grants the OTA role read access to pending secrets.

## References

- [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md), [ADR-0012](../../../docs/mvp/adr/0012-amadeus-account-model.md), [ADR-0010](../../../docs/mvp/adr/0010-secrets-envelope-encryption.md), [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md)
- [`../flows/amadeus-connection.md`](../flows/amadeus-connection.md) §D, [`../flows/stripe-payments-account.md`](../flows/stripe-payments-account.md) §D
