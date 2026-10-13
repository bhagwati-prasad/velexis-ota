import { randomBytes } from "node:crypto";
import { sha256Hex } from "./hash.js";

/**
 * Opaque random tokens that are stored only as hashes (ADR-0008, db README §8): refresh (`rt_`), e-mail
 * verification (`vt_`) and password reset (`pr_`) tokens, booking access tokens and invitations. With the
 * default 32 bytes they fit the OTA contract's patterns for `rt_`, `vt_` and `pr_`.
 *
 * Not for portal SSO tokens or API keys: `ptk_` (PADR-0007) and `pk_`/`sk_` keys (PADR-0005) are base62,
 * and base64url output (`-`, `_`) would break the contract's `^ptk_[A-Za-z0-9]{24,64}$` pattern.
 */

/** Token prefixes are 2 to 8 lower-case ASCII letters, so the `_` after them is always the separator. */
const TOKEN_PREFIX = /^[a-z]{2,8}$/;
/** 128 bits is the floor for a token that grants access on its own. */
export const TOKEN_MIN_BYTES = 16;
export const TOKEN_MAX_BYTES = 256;

export interface GeneratedToken {
  /** `"<prefix>_<base64url>"`: hand it to the user once (cookie, e-mail link, response) and never store it. */
  readonly token: string;
  /** `sha256Hex(token)`: the only form that is stored (a `*_hash` column or a Redis key). */
  readonly hash: string;
}

/**
 * A fresh token of `bytes` random bytes from Node's CSPRNG (default 32, 256 bits), encoded as base64url
 * without padding after `"<prefix>_"`, together with its SHA-256 hash. To look up a presented token,
 * hash it with `sha256Hex` and search by hash.
 */
export function generateToken(prefix: string, bytes = 32): GeneratedToken {
  if (typeof prefix !== "string" || !TOKEN_PREFIX.test(prefix)) {
    throw new TypeError("generateToken(): prefix must be 2 to 8 lower-case letters");
  }
  if (!Number.isSafeInteger(bytes) || bytes < TOKEN_MIN_BYTES || bytes > TOKEN_MAX_BYTES) {
    throw new TypeError(
      `generateToken(): bytes must be an integer from ${TOKEN_MIN_BYTES} to ${TOKEN_MAX_BYTES}`,
    );
  }
  const random = randomBytes(bytes);
  try {
    const token = `${prefix}_${random.toString("base64url")}`;
    return { token, hash: sha256Hex(token) };
  } finally {
    random.fill(0);
  }
}
