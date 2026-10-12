# ADR-0010: Secrets with envelope encryption

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (envelope encryption, master key outside the database, no raw card data stored or logged), lead architect (algorithms, key files, rotation)

## Context

[`decisions.md`](../decisions.md) §5 requires Amadeus and Stripe credentials to be envelope-encrypted in the database, with a master key held outside it: a file readable only by the service user on the VM, and a KMS later. The schemas already have `*_ciphertext bytea` columns with an `encryption_key_id` ([db README §8](../../velexis-sdk/db/README.md)):

- `platform.supplier_connections.client_secret_ciphertext`;
- `platform.payment_provider_connections.secret_ciphertext` and `webhook_secret_ciphertext`;
- `platform.accounts.mfa_secret_ciphertext`;
- tenant columns for identity documents, discount eligibility, idempotent replays and notification secrets.

## Decision

### Algorithm and format

- **AES-256-GCM** with a fresh random 256-bit **data key (DEK) per value**. The DEK is wrapped with the **key-encryption key (KEK)**, also by AES-256-GCM.
- The stored `bytea` is a versioned envelope: `version (1 byte) | kekId length + kekId | wrapped DEK (iv, tag, ciphertext) | iv | tag | ciphertext`. The `encryption_key_id` column repeats the KEK id for queries such as "everything still under `local:v1`".
- **Associated data** binds each ciphertext to its place: `"<schema>.<table>.<column>:<row id>"`. A ciphertext copied to another row or tenant fails to decrypt.
- Implemented once in `@velexis/crypto` (Node's built-in `crypto`, no third-party crypto library) behind a `KeyProvider` interface with `wrap(dek)`, `unwrap(wrapped, kekId)` and `currentKekId()`.

### Key material on the VM

All files are in `/etc/velexis/keys/`, owned by `velexis`, mode `0400`.

| File | Purpose | Used by |
|---|---|---|
| `master-v1.key` | KEK (32 random bytes, base64). The id is `local:v1`. | Both backends |
| `api-key-pepper` | HMAC-SHA-256 pepper for API key hashes | Platform (creates keys), OTA (verifies keys) |
| `platform-jwt-ed25519.pem` | Signing key for portal and admin tokens | Platform backend |
| `ota-jwt-ed25519.pem` | Signing key for staff and customer tokens | OTA backend |
| `document-url.key` | HMAC key for signed document download URLs | OTA backend |

- Paths come from the environment:
  - `MASTER_KEY_DIR` and `MASTER_KEY_CURRENT` (for example `local:v1` → `master-v1.key`);
  - `API_KEY_PEPPER_FILE`, `JWT_PRIVATE_KEY_FILE`, `DOCUMENT_URL_KEY_FILE`.

  `@velexis/config` refuses to start if a file is missing, readable by others, or the wrong length. The full list is in the [configuration matrix](../architecture.md#6-configuration-matrix).
- Everything else secret (database passwords, Redis password, the Stripe secret keys of the Velexis account, SMTP credentials, the first-party service secrets) is in `/etc/velexis/<app>.env` (`root:velexis`, `0640`). Nothing secret is committed. `.env.example` lists names with dummy values.
- Local development uses generated keys in an ignored `.local/keys/` folder (`pnpm dev:keys`).

### Who encrypts and decrypts

- The **platform backend** encrypts Amadeus and Stripe credentials when they are entered in the portal or platform admin, and encrypts and decrypts MFA secrets.
- The **OTA backend** decrypts Amadeus and Stripe credentials (read-only on platform tables), and only inside its supplier and payment gateway modules. It encrypts and decrypts tenant ciphertext columns.
- Decrypted secrets live in memory only, are never logged ([ADR-0016](0016-observability.md) redaction list) and are never put in queue messages ([ADR-0009](0009-background-jobs-bullmq.md)).
- Amadeus OAuth access tokens are cached in Redis encrypted with the same envelope, with their TTL.

### Rotation

- **KEK rotation:**
  1. Add `master-v2.key` and set `MASTER_KEY_CURRENT=local:v2`.
  2. New values use v2, and both versions can decrypt.
  3. A `rotate_secrets` job re-wraps old DEKs. Only DEKs are re-wrapped; the data is not re-encrypted.
  4. Remove v1 once no row references it.
- JWT keys rotate by `kid`. The old public key stays valid for one token lifetime.
- The API key pepper does not rotate in the MVP. Rotating it means re-issuing all keys.

### Card data

Raw card data (PAN, CVC) is **never stored, never logged and never queued**. It exists only in process memory during one airline-card request ([ADR-0011](0011-payments-stripe-and-airline-card.md)). It is not envelope-encrypted, because it is not stored at all.

## Consequences

### Positive

- A database dump alone reveals no secret. The key is in a different file, backed up separately ([ADR-0007](0007-single-vm-without-docker.md)).
- Moving to a cloud KMS means adding a `KmsKeyProvider` and re-wrapping DEKs. The data and the schema stay as they are.
- Associated data stops copy-paste attacks between rows and tenants.

### Negative

- Anyone with root or `velexis` access on the VM can read the master key. That is the accepted limit of a single-VM MVP.
- One DEK per value means one unwrap per decryption. That is cheap with a local KEK, but it would need caching with a remote KMS.
- Per-tenant data keys (crypto-shredding a tenant's backups by destroying its key, db README §7) are not in the MVP.

### Follow-ups

- Decided during planning; revisit when moving to managed services (KMS-backed `KeyProvider`), or when a customer contract requires per-tenant keys and crypto-shredding.

## Alternatives considered

- **pgcrypto in the database.** The key would have to be sent to the database in queries and could appear in logs.
- **HashiCorp Vault or a cloud KMS now.** Another service to run, or a cloud dependency before we need one. `decisions.md` §5 defers the KMS.
- **libsodium (secretbox).** Fine, but Node's built-in AES-GCM avoids a native dependency.

## References

- [`../decisions.md`](../decisions.md) §5
- [`../../velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md) §8 (security), §7 (deletion and crypto-shredding)
- [ADR-0007](0007-single-vm-without-docker.md), [ADR-0011](0011-payments-stripe-and-airline-card.md), [ADR-0016](0016-observability.md)
