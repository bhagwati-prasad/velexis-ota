import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateToken, sha256Hex, TOKEN_MAX_BYTES, TOKEN_MIN_BYTES } from "./index.js";

describe("generateToken", () => {
  it('returns "<prefix>_<base64url>" of 32 random bytes by default and its SHA-256 hex hash', () => {
    const { token, hash } = generateToken("rt");

    expect(token).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token.slice("rt_".length), "base64url")).toHaveLength(32);
    expect(hash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(hash).toBe(sha256Hex(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("takes the number of random bytes", () => {
    const short = generateToken("rt", TOKEN_MIN_BYTES);
    expect(short.token).toMatch(/^rt_[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(short.token.slice("rt_".length), "base64url")).toHaveLength(16);

    const long = generateToken("csrf", 48);
    expect(long.token).toMatch(/^csrf_[A-Za-z0-9_-]{64}$/);
    expect(Buffer.from(long.token.slice("csrf_".length), "base64url")).toHaveLength(48);
  });

  it("gives default tokens that fit the OTA contract's rt_, vt_ and pr_ patterns", () => {
    // The refresh, e-mail verification and password reset token patterns of
    // docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml.
    const contract: Record<string, RegExp> = {
      rt: /^rt_[A-Za-z0-9_-]{20,256}$/,
      vt: /^vt_[A-Za-z0-9_-]{32,64}$/,
      pr: /^pr_[A-Za-z0-9_-]{32,64}$/,
    };
    for (const [prefix, pattern] of Object.entries(contract)) {
      for (let i = 0; i < 50; i += 1) {
        expect(generateToken(prefix).token).toMatch(pattern);
      }
    }
  });

  it("never repeats a token", () => {
    const tokens = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) {
      const { token, hash } = generateToken("rt");
      tokens.add(token);
      hashes.add(hash);
    }
    expect(tokens.size).toBe(1_000);
    expect(hashes.size).toBe(1_000);
  });

  it("refuses bad prefixes and byte counts", () => {
    for (const prefix of ["", "r", "RT", "r_t", "rt_", "r1", "abcdefghi", " rt"]) {
      expect(() => generateToken(prefix), JSON.stringify(prefix)).toThrow(TypeError);
    }
    for (const bytes of [0, TOKEN_MIN_BYTES - 1, TOKEN_MAX_BYTES + 1, 31.5, Number.NaN, -32]) {
      expect(() => generateToken("rt", bytes), String(bytes)).toThrow(TypeError);
    }
    expect(() => generateToken(undefined as unknown as string)).toThrow(TypeError);
    expect(() => generateToken("rt", "32" as unknown as number)).toThrow(TypeError);
  });
});
