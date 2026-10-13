import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_KEY_PEPPER_MIN_BYTES,
  hashApiKey,
  hmacSha256,
  sha256Hex,
  timingSafeEqualStr,
  verifyApiKey,
} from "./index.js";

/** RFC 4231 test cases 6 and 7: a 131-byte key of 0xaa (longer than the SHA-256 block). */
const RFC4231_LONG_KEY = Buffer.alloc(131, 0xaa);
const RFC4231_CASE_6 = {
  data: "Test Using Larger Than Block-Size Key - Hash Key First",
  hmac: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
};
const RFC4231_CASE_7 = {
  data: "This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.",
  hmac: "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
};

/** A 32-byte test pepper: the bytes 0x00 to 0x1f. Not a real key. */
const TEST_PEPPER = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
/**
 * The fake example key of PADR-0005 item 1 (kind `sk`, environment `test`, 40 base62 characters). It is
 * joined from parts so that secret scanners do not mistake the fixture for a real key.
 */
const FAKE_KEY = ["sk", "test", "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90"].join("_");
/** `printf '%s' "$FAKE_KEY" | openssl dgst -sha256 -mac HMAC -macopt hexkey:000102…1e1f` */
const FAKE_KEY_HASH = "d912d13b789face2c52f1a4064ccaaf8c51c2928c8c8d8b239ae66c270389296";

describe("sha256Hex and hmacSha256", () => {
  it("match the FIPS 180-2 and RFC 4231 test vectors as lower-case hex", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(Buffer.from("abc"))).toBe(sha256Hex("abc"));

    // RFC 4231 test cases 1 and 2.
    expect(hmacSha256(Buffer.alloc(20, 0x0b), "Hi There")).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
    expect(hmacSha256("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
    expect(hmacSha256(RFC4231_LONG_KEY, RFC4231_CASE_6.data)).toBe(RFC4231_CASE_6.hmac);
  });

  it("hash strings as UTF-8 and refuse other input and an empty HMAC key", () => {
    expect(sha256Hex("é")).toBe(sha256Hex(Buffer.from([0xc3, 0xa9])));
    expect(() => sha256Hex(42 as unknown as string)).toThrow(TypeError);
    expect(() => hmacSha256("", "data")).toThrow(TypeError);
    expect(() => hmacSha256(Buffer.alloc(0), "data")).toThrow(TypeError);
    expect(() => hmacSha256(undefined as unknown as string, "data")).toThrow(TypeError);
    expect(() => hmacSha256("key", null as unknown as string)).toThrow(TypeError);
  });
});

describe("hashApiKey and verifyApiKey", () => {
  it("hashApiKey is hex(HMAC-SHA-256(pepper, fullKey)) and matches known HMAC test vectors [X-005 AC1]", () => {
    expect(hashApiKey(RFC4231_CASE_6.data, RFC4231_LONG_KEY)).toBe(RFC4231_CASE_6.hmac);
    expect(hashApiKey(RFC4231_CASE_7.data, RFC4231_LONG_KEY)).toBe(RFC4231_CASE_7.hmac);
    expect(hashApiKey(FAKE_KEY, TEST_PEPPER)).toBe(FAKE_KEY_HASH);
    expect(hashApiKey(FAKE_KEY, TEST_PEPPER)).toBe(
      createHmac("sha256", TEST_PEPPER).update(FAKE_KEY).digest("hex"),
    );
    expect(hashApiKey(FAKE_KEY, TEST_PEPPER)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifyApiKey accepts the key and rejects every key that differs in one character [X-005 AC1]", () => {
    expect(verifyApiKey(FAKE_KEY, TEST_PEPPER, FAKE_KEY_HASH)).toBe(true);

    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_";
    for (let i = 0; i < FAKE_KEY.length; i += 1) {
      const original = FAKE_KEY.charAt(i);
      const replacement = alphabet.charAt((alphabet.indexOf(original) + 1) % alphabet.length);
      const changed = FAKE_KEY.slice(0, i) + replacement + FAKE_KEY.slice(i + 1);
      expect(changed).not.toBe(FAKE_KEY);
      expect(verifyApiKey(changed, TEST_PEPPER, FAKE_KEY_HASH), `character ${i} changed`).toBe(false);
    }
    expect(verifyApiKey(FAKE_KEY.slice(0, -1), TEST_PEPPER, FAKE_KEY_HASH)).toBe(false);
    expect(verifyApiKey(`${FAKE_KEY}0`, TEST_PEPPER, FAKE_KEY_HASH)).toBe(false);
  });

  it("verifyApiKey rejects the right key under another pepper", () => {
    const otherPepper = Buffer.from(TEST_PEPPER);
    otherPepper.writeUInt8(otherPepper.readUInt8(31) ^ 0x01, 31);
    expect(verifyApiKey(FAKE_KEY, otherPepper, FAKE_KEY_HASH)).toBe(false);
  });

  it("verifyApiKey returns false for a malformed presented key or stored hash instead of throwing", () => {
    expect(verifyApiKey("", TEST_PEPPER, FAKE_KEY_HASH)).toBe(false);
    expect(verifyApiKey(undefined as unknown as string, TEST_PEPPER, FAKE_KEY_HASH)).toBe(false);
    expect(verifyApiKey(FAKE_KEY, TEST_PEPPER, FAKE_KEY_HASH.toUpperCase())).toBe(false);
    expect(verifyApiKey(FAKE_KEY, TEST_PEPPER, FAKE_KEY_HASH.slice(0, 63))).toBe(false);
    expect(verifyApiKey(FAKE_KEY, TEST_PEPPER, `${FAKE_KEY_HASH}00`)).toBe(false);
    expect(verifyApiKey(FAKE_KEY, TEST_PEPPER, "")).toBe(false);
    expect(verifyApiKey(FAKE_KEY, TEST_PEPPER, null as unknown as string)).toBe(false);
  });

  it("refuses a missing or short pepper as a configuration error", () => {
    const short = Buffer.alloc(API_KEY_PEPPER_MIN_BYTES - 1, 1);
    expect(() => hashApiKey(FAKE_KEY, short)).toThrow(TypeError);
    expect(() => verifyApiKey(FAKE_KEY, short, FAKE_KEY_HASH)).toThrow(TypeError);
    expect(() => hashApiKey(FAKE_KEY, "pepper-as-text" as unknown as Buffer)).toThrow(TypeError);
    expect(() => hashApiKey(FAKE_KEY, undefined as unknown as Buffer)).toThrow(TypeError);
    expect(() => hashApiKey("", TEST_PEPPER)).toThrow(TypeError);
  });

  it("never puts the key or the pepper into an error message", () => {
    const messages: string[] = [];
    for (const call of [
      () => hashApiKey(FAKE_KEY, Buffer.alloc(8, 0x41)),
      () => verifyApiKey(FAKE_KEY, Buffer.alloc(8, 0x41), FAKE_KEY_HASH),
    ]) {
      try {
        call();
      } catch (error) {
        messages.push((error as Error).message);
      }
    }
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).not.toContain(FAKE_KEY);
      expect(message).not.toContain("AAAAAAAA");
    }
  });
});

describe("timingSafeEqualStr", () => {
  it("compares strings of equal and different lengths", () => {
    expect(timingSafeEqualStr("csrf-value", "csrf-value")).toBe(true);
    expect(timingSafeEqualStr("", "")).toBe(true);
    expect(timingSafeEqualStr("csrf-value", "csrf-valuf")).toBe(false);
    expect(timingSafeEqualStr("csrf-value", "csrf-value-longer")).toBe(false);
    expect(timingSafeEqualStr("csrf-value", "")).toBe(false);
    expect(timingSafeEqualStr("", "x")).toBe(false);
    expect(timingSafeEqualStr("a".repeat(10_000), "a".repeat(10_001))).toBe(false);
  });

  it("tells apart strings whose UTF-8 forms would collide and refuses non-strings", () => {
    // Two different lone surrogates both become U+FFFD in UTF-8; the comparison must still see them apart.
    expect(Buffer.from("\ud800", "utf8").equals(Buffer.from("\udc00", "utf8"))).toBe(true);
    expect(timingSafeEqualStr("\ud800", "\udc00")).toBe(false);
    expect(timingSafeEqualStr("é", "é")).toBe(true);
    expect(timingSafeEqualStr(undefined as unknown as string, undefined as unknown as string)).toBe(false);
    expect(timingSafeEqualStr("x", ["x"] as unknown as string)).toBe(false);
  });
});

describe("dependencies of the token, hashing, signed-URL and id helpers", () => {
  it("use Node's crypto only; ids.ts alone imports ulid, and only to format ids", async () => {
    const allowed: Record<string, RegExp> = {
      "hash.ts": /^(node:|\.\/)/,
      "tokens.ts": /^(node:|\.\/)/,
      "signed-url.ts": /^(node:|\.\/)/,
      "ids.ts": /^(node:|\.\/|ulid$)/,
    };
    for (const [source, pattern] of Object.entries(allowed)) {
      const text = await readFile(join(__dirname, source), "utf8");
      const specifiers = [...text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)].map(
        (m) => m[1],
      );
      expect(specifiers.length, source).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier, `${source} imports ${specifier}`).toMatch(pattern);
      }
    }
    // Only the plain ulid() function is imported, never the monotonic factory.
    const ids = await readFile(join(__dirname, "ids.ts"), "utf8");
    expect(ids).toMatch(/import \{ ulid \} from "ulid";/);
    expect(ids).not.toMatch(/monotonicFactory/);
  });
});
