# @velexis/crypto

Envelope encryption for secrets at rest, as decided in [ADR-0010](../../docs/mvp/adr/0010-secrets-envelope-encryption.md): Amadeus and Stripe credentials, MFA secrets, and the tenant `*_ciphertext` columns ([db README §8](../../docs/velexis-sdk/db/README.md)). It also holds the token, hashing, signed-URL and id helpers (see [Tokens, hashes, signed URLs and ids](#tokens-hashes-signed-urls-and-ids)). All cryptography uses Node's built-in `crypto`. There is no third-party crypto library (a test checks `package.json`). The only runtime dependency is `ulid` (tech-stack §2), which formats ids.

Used by both backends: the platform backend encrypts credentials and MFA secrets, and the OTA backend decrypts credentials inside its supplier and payment gateway modules and encrypts and decrypts the tenant columns. The Next.js apps never import this package and have no keys.

## Usage

```ts
import { LocalFileKeyProvider, aadFor, encryptValue, decryptValue, rewrapValue } from "@velexis/crypto";

// Once at start-up, from @velexis/config (MASTER_KEY_DIR, MASTER_KEY_CURRENT).
const keys = await LocalFileKeyProvider.fromDir(config.MASTER_KEY_DIR, config.MASTER_KEY_CURRENT);

const aad = aadFor("platform", "supplier_connections", "client_secret_ciphertext", row.id);
const { ciphertext, kekId } = await encryptValue(clientSecret, { aad, keys });
// INSERT … client_secret_ciphertext = ciphertext, encryption_key_id = kekId

const secret = await decryptValue(row.client_secret_ciphertext, { aad, keys }); // Buffer: never log it
```

| Export | What it does |
|---|---|
| `encryptValue(plaintext, { aad, keys })` | Encrypts a string (UTF-8) or Buffer. Returns `{ ciphertext: Buffer, kekId }`: store `ciphertext` in the `*_ciphertext` column and `kekId` in `encryption_key_id`. |
| `decryptValue(ciphertext, { aad, keys })` | Returns the plaintext as a `Buffer`. Any KEK the provider has loaded can unwrap, not only the current one. Every failure throws `DecryptionError`. |
| `rewrapValue(ciphertext, { keys, aad? })` | Re-wraps only the data key under the current KEK and returns `{ ciphertext, kekId }`. The encrypted data is copied byte for byte. A value already under the current KEK comes back unchanged. With `aad`, the value must also authenticate at that place first. |
| `envelopeKekId(ciphertext)` | Reads the KEK id from an envelope without decrypting it, for checks against `encryption_key_id` and for rotation reports. |
| `aadFor(schema, table, column, rowId)` | Returns `"<schema>.<table>.<column>:<rowId>"`. It refuses identifiers that are not lower-case SQL names, and row ids that are not 1 to 255 printable ASCII characters, so two places can never produce the same string. |
| `KeyProvider` | The seam for key-encryption keys (KEKs): `currentKekId()`, `wrap(dek)` (returns `{ kekId, wrapped }`) and `unwrap(wrapped, kekId)`. |
| `LocalFileKeyProvider.fromDir(dir, current)` | The file-based provider (see below). `kekIds()` lists the versions it loaded. |
| `DecryptionError` | Always the message `Decryption failed`, with no cause and no detail. `decryptValue` and `rewrapValue` create it at their own boundary, so its stack trace does not show which check failed either. An error or a log line cannot be used as a decryption oracle. |
| `KeyProviderError` | A key folder or key file is unusable. The message names the file and the reason, never key material. |

Rules for callers:

- **Always pass the associated data of the value's own place.** Use the column that holds the value and the row's id. A ciphertext copied to another row, column or tenant schema then fails to decrypt. A value with no table row (the encrypted Amadeus token cache in Redis) still needs associated data that names its place. The task that writes it documents that string.
- **Decrypted secrets stay in memory.** Never log them ([ADR-0016](../../docs/mvp/adr/0016-observability.md)), never put them in queue messages ([ADR-0009](../../docs/mvp/adr/0009-background-jobs-bullmq.md)), and `fill(0)` the Buffer when you are done.
- **Card data is never encrypted here**, because it is never stored ([ADR-0011](../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md)).
- Do not catch `DecryptionError` to retry with another key or AAD. Map it to a generic server error.

## Envelope format (version 1)

Each value gets a fresh random 32-byte data key (DEK). The value is encrypted with AES-256-GCM (12-byte random IV, 16-byte tag) and the associated data. The DEK is then wrapped with the current KEK, also with AES-256-GCM, using the KEK id as associated data. The stored `bytea` is:

```text
0x01 | kekId length (1 byte) | kekId (ASCII) | wrapped DEK: iv (12) | tag (16) | ct (32) | iv (12) | tag (16) | ciphertext
```

- The `encryption_key_id` column repeats the KEK id, so queries such as "everything still under `local:v1`" need no decryption.
- The KEK id is 1 to 255 printable ASCII characters. The wrapped DEK is always 60 bytes in version 1. A provider whose wrapped keys have another size (a cloud KMS) needs a new version byte. Version 1 values then move to it with a re-wrap, without re-encrypting any data.
- Overhead: 90 bytes plus the length of the KEK id (98 bytes for `local:v1`).

## Key files (`LocalFileKeyProvider`)

`LocalFileKeyProvider.fromDir(dir, current)` loads every `master-v<N>.key` in the zone's key folder as KEK `local:v<N>` ([ADR-0026](../../docs/mvp/adr/0026-system-users-per-trust-zone.md): `/etc/velexis/keys/platform/` or `/etc/velexis/keys/ota/` on the VM, `.local/keys/` from `pnpm dev:keys` in development). Other files in the folder (`api-key-pepper`, JWT keys, `document-url.key`) are ignored.

It throws `KeyProviderError` when:

- `current` is not `local:v<N>` (N ≥ 1, no leading zeros), or there is no file for it;
- a file named `master-v….key` is not exactly `master-v<N>.key` (for example `master-v01.key`). Such a file is refused, not ignored, so a key cannot silently go missing;
- a key file is not a regular file, or grants any access to group or others (`mode & 0o077`). This refuses group- or world-readable files, and also group- or world-writable ones. Use mode `0400` (VM) or `0600` (development);
- a key file is not base64, or does not decode to exactly 32 bytes. Whitespace and line breaks are allowed, as written by `openssl rand -base64 32`.

The KEKs are kept as Node `KeyObject`s in private fields. `util.inspect`, `JSON.stringify` and error messages never show them.

## KEK rotation

This is the procedure of ADR-0010 (Rotation). The runbook `docs/mvp/runbooks/master-key-rotation.md` and the shared batch helper `rewrapBatch` come with X-040.

1. **Add the new key.** Install `master-v2.key` (32 random bytes, base64, `0400`) as an identical copy in both zone folders (`provision-vm.sh --steps keys` with `NEW_MASTER_KEY=v2`, X-040). Set `MASTER_KEY_CURRENT=local:v2` in both backend env files and restart them.
2. **Both versions decrypt.** `fromDir` loads `master-v1.key` and `master-v2.key`. New values are wrapped with v2, and existing v1 values still decrypt, because `decryptValue` unwraps with the KEK named in each envelope.
3. **Re-wrap the old data keys with `rewrapValue`.** Only the data keys are re-wrapped; the data is not re-encrypted. Write the returned `ciphertext` and `kekId` together, with an optimistic check on the old ciphertext. Each owner re-wraps its own data:
   - the platform backend's `secrets:rewrap` covers the platform ciphertext columns;
   - the OTA backend's `secrets:rewrap` covers the ciphertext columns of every tenant schema;
   - the Redis caches of Amadeus tokens are flushed (`amadeus:token:*`) instead of re-wrapped.

   Both commands use the shared batch helper of X-040 and report the remaining count per `kekId` (`encryption_key_id`).
4. **Remove the old key** from both folders only when both commands report zero rows under `local:v1`. Then back up `/etc/velexis`. After a suspected compromise, also rotate every credential an attacker could have read ([`deployment-single-vm.md`](../../docs/mvp/deployment-single-vm.md) §7 and §16).

A random 96-bit IV per wrap keeps one KEK safe for far more data keys than the MVP will ever create (the AES-GCM limit is about 2³² wraps per key). Rotation is for key hygiene and compromise, not for that limit.

## Moving to a KMS

Implement `KeyProvider` with the KMS (`currentKekId()` returns the KMS key id; `unwrap` rejects with `DecryptionError` for an unauthentic key and lets outages through as ordinary errors). Then re-wrap every value with `rewrapValue`. During the move, the provider passed to `rewrapValue` must still unwrap the `local:v<N>` ids, for example by choosing the KMS or the key files by KEK id prefix. If the KMS returns wrapped keys that are not 60 bytes, a new envelope version comes first (see the envelope format above). The data and the schema stay as they are ([`deployment-single-vm.md`](../../docs/mvp/deployment-single-vm.md) §15). With a remote KMS, one unwrap per decryption may need caching (ADR-0010, Consequences).

## Tokens, hashes, signed URLs and ids

```ts
import { generateToken, sha256Hex, hashApiKey, verifyApiKey, timingSafeEqualStr,
         signUrl, verifySignedUrl, newId } from "@velexis/crypto";

const { token, hash } = generateToken("rt");          // "rt_<43 base64url chars>"; store only `hash`
const lookup = sha256Hex(presentedToken);             // find the row or Redis key by hash

const keyHash = hashApiKey(fullKey, pepper);          // api_keys.key_hash; pepper = readKeyFile(API_KEY_PEPPER_FILE)
verifyApiKey(presentedKey, pepper, row.key_hash);     // true or false, constant time

const expiresAt = new Date(clock.now().getTime() + 5 * 60_000);       // valid 5 minutes (ADR-0017)
const url = signUrl(`/v1/files/${storageKey}`, { expiresAt, key: documentUrlKey });
const check = verifySignedUrl(req.originalUrl, { key: documentUrlKey, now: clock.now() });
// !check.valid: answer 403 whatever check.reason is; otherwise serve check.path

newId("bkg");                                         // "bkg_01J…": 26 Crockford base32 characters
```

| Export | What it does |
|---|---|
| `generateToken(prefix, bytes = 32)` | A fresh token `"<prefix>_<base64url>"` of `bytes` CSPRNG bytes (16 to 256; default 256 bits) and `hash = sha256Hex(token)`. The prefix is 2 to 8 lower-case letters (`rt`, `vt`, `pr`). For refresh, verification, reset, invitation and booking access tokens ([ADR-0008](../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [db README §8](../../docs/velexis-sdk/db/README.md)); with the default 32 bytes they fit the OTA contract's `rt_`, `vt_` and `pr_` patterns. Only the hash is stored; the token is shown or sent once. Not for portal SSO tokens (`ptk_`, [PADR-0007](../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md)) or API keys ([PADR-0005](../../platform/docs/adr/0005-api-key-format-and-hashing.md)): those are base62, and the `-` and `_` of base64url break their patterns. |
| `sha256Hex(data)` | SHA-256 of a string (UTF-8) or Buffer as 64 lower-case hex characters. |
| `hmacSha256(key, data)` | HMAC-SHA-256 as 64 lower-case hex characters. An empty key throws. |
| `hashApiKey(fullKey, pepper)` | `hex(HMAC-SHA-256(pepper, fullKey))`, the `key_hash` of [PADR-0005](../../platform/docs/adr/0005-api-key-format-and-hashing.md) item 3. `pepper` is the decoded `api-key-pepper` file and must be at least 32 bytes (`API_KEY_PEPPER_MIN_BYTES`). |
| `verifyApiKey(fullKey, pepper, expectedHex)` | Recomputes the HMAC and compares it with `crypto.timingSafeEqual`. A presented key that is not a non-empty string, or a stored hash that is not 64 lower-case hex characters, gives `false`; a bad pepper throws. |
| `timingSafeEqualStr(a, b)` | Constant-time equality for strings of any lengths (SHA-256 of both, then `timingSafeEqual`). Non-strings compare unequal. For shared secrets such as service keys and CSRF values. |
| `signUrl(path, { expiresAt, key })` | Returns `"<path>?exp=<unix>&sig=<sig>"` with `sig = base64url(HMAC-SHA-256(key, "<path>?exp=<unix>"))` ([ADR-0017](../../docs/mvp/adr/0017-email-documents-storage.md), Signed URLs). `exp` is `expiresAt` rounded down to seconds. `key` is the decoded `document-url.key` (at least 32 bytes). |
| `verifySignedUrl(url, { key, now })` | `{ valid: true, path, expiresAt }` or `{ valid: false, reason }` with `reason` `malformed`, `signature` or `expired`. The signature is compared in constant time, and the link is valid up to and including `exp`. `now` comes from the injected clock, so tests are deterministic. |
| `newId(prefix, now?)` | `"<prefix>_<ULID>"` with a fresh 80-bit random part from Node's CSPRNG for every id. The prefix must match `^[a-z]{2,4}$`. `now` (default: the current time) sets the time-sortable timestamp part. |
| `IdPrefix<P>` | `P` when it is a literal of 2 to 4 lower-case letters, otherwise `never`, so `newId("BKG")` does not compile. Unions of literals keep their valid members. An app's own generator keeps the check with `new<P extends string>(prefix: IdPrefix<P>) { return newId(prefix); }`. |

Rules for callers:

- **Ids are never monotonic.** `srch_`, `off_`, `prc_`, `chk_` and `pay_` ids grant guest access on their own, and their secret is the 80 random bits ([db README §2.1](../../docs/velexis-sdk/db/README.md)). Never use the `ulid` package's `monotonicFactory` (it increments the random part within one millisecond) or another id generator.
- **Tokens and API keys are never logged** and never stored in clear. Hash a presented token with `sha256Hex` and look it up by hash.
- **Signed paths** are `/`-separated segments of `A-Z a-z 0-9 - . _ ~`, none of them empty, `.` or `..`. Such a path needs no percent-encoding, so the server sees exactly the string that was signed. Storage keys are generated by the application and fit this rule. The query of a signed URL must be exactly `exp=<unix>&sig=<sig>`; extra parameters make it `malformed`.
- **Only the path and `exp` are signed, not the host**, so the same link works same-origin under `/api` on the hosted storefront (Caddy strips the prefix) and on the API host. Map every `valid: false` to the same `403`; `reason` is for logs and metrics.

## Scripts

| Command | Does |
|---|---|
| `pnpm --filter @velexis/crypto build` | `tsc -b` to `dist/` (CommonJS and `.d.ts`) |
| `pnpm --filter @velexis/crypto test` | Unit tests (Vitest): round trip, tampering, AAD, rotation, key files and no third-party crypto; HMAC and SHA-256 test vectors, API key verification, tokens, signed URLs and ids |
| `pnpm --filter @velexis/crypto typecheck` / `lint` | `tsc --noEmit` / ESLint |
