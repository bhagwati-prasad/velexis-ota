import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * SHA-256 and HMAC-SHA-256 helpers for stored token hashes, API key hashes (PADR-0005) and constant-time
 * comparisons. Strings are hashed as UTF-8. Digests are 64 lower-case hex characters.
 */

/** Minimum pepper length in bytes: the `api-key-pepper` file holds 32 random bytes (PADR-0005, ADR-0010). */
export const API_KEY_PEPPER_MIN_BYTES = 32;

const SHA256_HEX = /^[0-9a-f]{64}$/;

function bytesOf(value: unknown, fn: string, name: string): Uint8Array {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new TypeError(`${fn}(): ${name} must be a string or a Buffer`);
}

function assertPepper(pepper: unknown, fn: string): asserts pepper is Uint8Array {
  if (!(pepper instanceof Uint8Array) || pepper.length < API_KEY_PEPPER_MIN_BYTES) {
    throw new TypeError(
      `${fn}(): pepper must be a Buffer of at least ${API_KEY_PEPPER_MIN_BYTES} bytes (the decoded api-key-pepper file)`,
    );
  }
}

/** SHA-256 of `data` as 64 lower-case hex characters. Used for refresh, reset, verification and SSO tokens. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256")
    .update(bytesOf(data, "sha256Hex", "data"))
    .digest("hex");
}

/** HMAC-SHA-256 of `data` under `key`, as 64 lower-case hex characters. The key must not be empty. */
export function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): string {
  const keyBytes = bytesOf(key, "hmacSha256", "key");
  if (keyBytes.length === 0) {
    throw new TypeError("hmacSha256(): key must not be empty");
  }
  return createHmac("sha256", keyBytes)
    .update(bytesOf(data, "hmacSha256", "data"))
    .digest("hex");
}

/**
 * The `api_keys.key_hash` of a full API key, exactly as PADR-0005 item 3 says:
 * `hex(HMAC-SHA-256(pepper, fullKey))`. `pepper` is the decoded `api-key-pepper` file (at least 32 bytes).
 * The full key is never stored, logged or returned again.
 */
export function hashApiKey(fullKey: string, pepper: Buffer): string {
  assertPepper(pepper, "hashApiKey");
  if (typeof fullKey !== "string" || fullKey.length === 0) {
    throw new TypeError("hashApiKey(): fullKey must be a non-empty string");
  }
  return hmacSha256(pepper, fullKey);
}

/**
 * Whether `fullKey` hashes to `expectedHex` (a stored `key_hash`), compared with `crypto.timingSafeEqual`.
 * A presented key that is not a non-empty string, or a stored hash that is not 64 lower-case hex
 * characters, gives `false`. An invalid pepper is a configuration error and throws.
 */
export function verifyApiKey(fullKey: string, pepper: Buffer, expectedHex: string): boolean {
  assertPepper(pepper, "verifyApiKey");
  if (typeof fullKey !== "string" || fullKey.length === 0) {
    return false;
  }
  if (typeof expectedHex !== "string" || !SHA256_HEX.test(expectedHex)) {
    return false;
  }
  const actual = createHmac("sha256", pepper).update(fullKey, "utf8").digest();
  return timingSafeEqual(actual, Buffer.from(expectedHex, "hex"));
}

/**
 * Constant-time string equality that is also safe for strings of different lengths: both sides are
 * hashed with SHA-256 (over their UTF-16 code units, so every JavaScript string maps to distinct bytes)
 * and the digests are compared with `crypto.timingSafeEqual`. The time taken depends on the lengths of
 * the inputs, never on where they first differ. Anything that is not a string compares unequal.
 *
 * Use it for shared secrets and CSRF values. Stored token hashes are looked up by hash instead.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const digestA = createHash("sha256").update(a, "utf16le").digest();
  const digestB = createHash("sha256").update(b, "utf16le").digest();
  return timingSafeEqual(digestA, digestB);
}
