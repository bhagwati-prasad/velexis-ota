# PADR-0005: API key format and hashing

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when hosting keys (`hk_`) are offered, or when the API key pepper must rotate.

## Context

`platform.api_keys` stores a visible `prefix` (first 14 characters, for example `pk_live_3fA9x2`), `key_hash` (HMAC-SHA-256 with a server pepper), `last4`, `kind`, `environment`, `allowed_origins` and `scopes`, with CHECK constraints on the prefix pattern ([`platform.sql`](../../../docs/velexis-sdk/db/platform.sql)). The OTA backend resolves keys by prefix through Redis, then compares the HMAC in constant time ([db README §5](../../../docs/velexis-sdk/db/README.md)). [ADR-0010](../../../docs/mvp/adr/0010-secrets-envelope-encryption.md) puts the pepper in `/etc/velexis/keys/api-key-pepper`, shared by both backends, with no rotation in the MVP. The exact key format, entropy, encoding of the hash, collision handling and scope rules were not fixed.

## Decision

1. **Format:** `<kind>_<environment>_<secret>`, with `kind` `pk` or `sk` (`hk` reserved for later), `environment` `test` or `live`, and `secret` = **40 characters of base62** from Node's CSPRNG (about 238 bits). Example (fake): `sk_test_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90`, prefix `sk_test_Ab12Cd`.
2. **Prefix:** the first 14 characters (`sk_test_` + 6 secret characters). It is unique (database index); on the rare collision the API generates a new key, at most three times, then fails with `INTERNAL_ERROR`. The prefix is shown in the portal and used as the lookup key.
3. **Hash:** `key_hash = hex(HMAC-SHA-256(pepper, full key))`, 64 lower-case hex characters. The pepper file is 32 random bytes (base64). Verification on the OTA side uses `crypto.timingSafeEqual`. A database dump without the pepper does not allow offline checking of keys, and the high entropy makes brute force pointless anyway. `last4` = last 4 characters of the key.
4. **Shown once.** The full key is returned only in the create or roll response (`Cache-Control: no-store`), never stored in clear, never logged (`apiKey` and `key` are on the redaction list), never kept for idempotent replay. The provisioning test keys are the one exception: kept envelope-encrypted for a single reveal within 24 h ([PADR-0001](0001-tenant-provisioning-orchestration.md)).
5. **Origins** (publishable keys only, as the baseline CHECK requires): exact origins `scheme://host[:port]`; `https` only, except `http://localhost:<port>` and `http://127.0.0.1:<port>` on test keys; no wildcards, paths or trailing slashes; at most 20. An empty list means no browser origin is accepted.
6. **Scopes** (secret keys only): values from the OTA contract's `ConsoleApiKeyScope` and `StaffPermission`. Rules: default `["storefront"]`; `storefront` excludes the console scopes; `console:automation` implies `console` and requires at least one permission; permissions are allowed only with `console:automation`. The validation uses the generated OTA types, so a new permission in the OTA document is accepted without a platform change.
7. **Immutability.** Kind, environment and scopes never change; name, origins and expiry can. Changing scopes means a new key (roll).
8. **Lifecycle.** Revocation sets `revoked_at`; rolling sets `expires_at` on the old key (now, 1 h, 24 h, 7 days). Both publish `vx:invalidate {type: "api_key", prefix}`. Keys are never deleted (the audit trail refers to them).
9. **Limits.** `plans.limits.apiKeys` counts keys that are neither revoked nor expired. Live keys exist only when the tenant is live; live secret keys need an MFA step-up.
10. **Usage.** The OTA backend writes `apikey:used:<keyId>` in Redis; the platform worker flushes it every 5 minutes into `last_used_at` and `last_used_ip`.

## Consequences

### Positive

- Keys are recognisable (kind and environment in the text), which helps secret scanners and support.
- A database leak alone exposes no usable key.
- Scope rules mirror the OTA contract exactly, with one source of truth.

### Negative

- Losing the pepper invalidates every key (it is backed up with `/etc/velexis`, ADR-0007).
- Rotating the pepper means re-issuing every key; accepted for the MVP (ADR-0010).
- Showing keys once means support cannot recover a lost key; users roll it.

### Follow-ups

- Register the `pk_`, `sk_` patterns with GitHub secret scanning when the repository goes public or a partner programme starts.
- Hosting keys and `api_key_tenant_grants` management after the MVP.

## Alternatives considered

- **Argon2 or bcrypt hashes.** Slow hashes defend low-entropy secrets; these keys have 238 bits, and the OTA backend verifies keys on every request.
- **Plain SHA-256.** Works with high entropy, but the pepper adds defence against a dump-only attacker at no cost, and the baseline already specifies HMAC.
- **JWT API keys.** Cannot be revoked without a lookup, and leak claims.

## References

- [`../../../docs/velexis-sdk/db/platform.sql`](../../../docs/velexis-sdk/db/platform.sql) (`api_keys`), [db README §5](../../../docs/velexis-sdk/db/README.md)
- OTA contract `ConsoleApiKeyScope`, `StaffPermission` in [`velexis-ota-booking-api.openapi.yaml`](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml)
- [ADR-0010](../../../docs/mvp/adr/0010-secrets-envelope-encryption.md), [`../flows/api-keys.md`](../flows/api-keys.md)
