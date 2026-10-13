import { randomBytes } from "node:crypto";
import { ulid } from "ulid";

/**
 * Prefixed ULID ids (db README §2.1): `"<prefix>_<ULID>"`, for example `bkg_01J…` (26 characters after the `_`).
 * The 48-bit timestamp makes ids time-sortable, so `(created_at, id)` cursors are stable. The 80 random
 * bits come fresh from Node's CSPRNG for every id: `srch_`, `off_`, `prc_`, `chk_` and `pay_` ids grant
 * guest access on their own, and their secret is those 80 bits. The monotonic ULID factory, which
 * increments the random part of ids made in the same millisecond and so makes neighbours predictable, is
 * never used.
 */

/** The characters of a string literal as a union: `Characters<"ab">` is `"a" | "b"`. */
type Characters<S extends string> = S extends `${infer C}${infer Rest}` ? C | Characters<Rest> : never;
type LowerLetter = Characters<"abcdefghijklmnopqrstuvwxyz">;

/**
 * An id prefix checked at compile time: `P` itself when it is 2 to 4 lower-case ASCII letters
 * (`^[a-z]{2,4}$`), otherwise `never`. A union of prefixes keeps its valid members. A plain `string` is
 * not a prefix: keep prefixes as literals (`"bkg"`) or unions of literals.
 *
 * ```ts
 * type Booking = IdPrefix<"bkg">; // "bkg"
 * type Bad = IdPrefix<"BKG">;     // never
 * ```
 */
export type IdPrefix<P extends string> = P extends `${infer A}${infer B}${infer Rest}`
  ? [A, B] extends [LowerLetter, LowerLetter]
    ? Rest extends "" | LowerLetter | `${LowerLetter}${LowerLetter}`
      ? P
      : never
    : never
  : never;

const ID_PREFIX = /^[a-z]{2,4}$/;
/** Characters of the random part of a ULID (16 Crockford base32 characters of 5 bits each). */
const RANDOM_CHARS = 16;
/** Largest timestamp a ULID can hold (2^48 - 1 ms). */
const ULID_TIME_MAX = 2 ** 48 - 1;

/**
 * A one-id random source for `ulid()`. It draws 16 fresh bytes from Node's CSPRNG and returns
 * `(byte & 31) / 32` for each of the 16 random characters. `ulid()` maps that value to the character
 * `byte & 31` exactly, so the random part is 80 uniform bits that no other id shares.
 */
function freshRandomSource(): () => number {
  const bytes = randomBytes(RANDOM_CHARS);
  let next = 0;
  return () => {
    if (next >= RANDOM_CHARS) {
      throw new Error("newId(): the random source was asked for more than 16 characters");
    }
    const value = (bytes[next] ?? 0) & 31;
    next += 1;
    return value / 32;
  };
}

/**
 * A new id `"<prefix>_<ULID>"` (26 Crockford base32 characters) with 80 fresh random bits.
 * `now` sets the timestamp part (default: the current time), so an injected clock gives ids that sort
 * with its `created_at` values. The prefix must match `^[a-z]{2,4}$` at run time too.
 */
export function newId<P extends string>(prefix: IdPrefix<P>, now?: Date): string {
  if (typeof prefix !== "string" || !ID_PREFIX.test(prefix)) {
    throw new TypeError("newId(): prefix must be 2 to 4 lower-case letters");
  }
  const time = now === undefined ? Date.now() : now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isSafeInteger(time) || time < 1 || time > ULID_TIME_MAX) {
    throw new TypeError("newId(): now must be a valid Date after 1970-01-01T00:00:00.001Z");
  }
  return `${prefix}_${ulid(time, freshRandomSource())}`;
}
