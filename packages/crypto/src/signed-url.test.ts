import { describe, expect, it } from "vitest";
import { SIGNED_URL_KEY_MIN_BYTES, signUrl, verifySignedUrl, type SignedUrlVerification } from "./index.js";

/** A 32-byte test key: the bytes 0x00 to 0x1f. Not a real key. */
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const PATH = "/v1/files/tenant_acme/documents/doc_01JABCDEFGHJKMNPQRSTVWXYZ0/itinerary-v1.pdf";
const EXP = 1_760_000_000;
const EXPIRES_AT = new Date(EXP * 1000);
/**
 * `printf '%s' "$PATH?exp=1760000000" | openssl dgst -sha256 -mac HMAC -macopt hexkey:000102…1e1f -binary`,
 * base64url without padding.
 */
const SIG = "XCE5pc1R4yABtcI_x1T7dp2r4EAvEH7MS1dUR-hkMkA";

const at = (seconds: number) => new Date(seconds * 1000);

function reasonOf(result: SignedUrlVerification): string {
  return result.valid ? "valid" : result.reason;
}

describe("signUrl", () => {
  it('appends exp=<unix> and sig=base64url(HMAC-SHA-256(key, "<path>?exp=<unix>"))', () => {
    expect(signUrl(PATH, { expiresAt: EXPIRES_AT, key: KEY })).toBe(`${PATH}?exp=${EXP}&sig=${SIG}`);
  });

  it("rounds the expiry down to whole seconds", () => {
    expect(signUrl(PATH, { expiresAt: new Date(EXP * 1000 + 999), key: KEY })).toBe(
      `${PATH}?exp=${EXP}&sig=${SIG}`,
    );
  });

  it("refuses paths that would need encoding or could be normalised, short keys and invalid dates", () => {
    const options = { expiresAt: EXPIRES_AT, key: KEY };
    for (const path of [
      "",
      "v1/files/x.pdf",
      "/",
      "/v1//files",
      "/v1/files/",
      "/v1/files/../secrets.pdf",
      "/v1/./files/x.pdf",
      "/v1/files/a b.pdf",
      "/v1/files/x.pdf?download=1",
      "/v1/files/x.pdf#top",
      "/v1/files/%2e%2e/x.pdf",
      "/v1/files/é.pdf",
      `/${"a".repeat(2048)}`,
    ]) {
      expect(() => signUrl(path, options), JSON.stringify(path)).toThrow(TypeError);
    }
    expect(() =>
      signUrl(PATH, { expiresAt: EXPIRES_AT, key: Buffer.alloc(SIGNED_URL_KEY_MIN_BYTES - 1) }),
    ).toThrow(TypeError);
    expect(() => signUrl(PATH, { expiresAt: EXPIRES_AT, key: "key" as unknown as Buffer })).toThrow(
      TypeError,
    );
    expect(() => signUrl(PATH, { expiresAt: new Date(Number.NaN), key: KEY })).toThrow(TypeError);
    expect(() => signUrl(PATH, { expiresAt: new Date(0), key: KEY })).toThrow(TypeError);
    expect(() => signUrl(PATH, { expiresAt: EXP as unknown as Date, key: KEY })).toThrow(TypeError);
  });
});

describe("verifySignedUrl", () => {
  const url = signUrl(PATH, { expiresAt: EXPIRES_AT, key: KEY });

  it("accepts a signed URL before exp and up to exp, and refuses it one second after [X-005 AC2]", () => {
    expect(verifySignedUrl(url, { key: KEY, now: at(EXP - 300) })).toEqual({
      valid: true,
      path: PATH,
      expiresAt: EXPIRES_AT,
    });
    expect(verifySignedUrl(url, { key: KEY, now: at(EXP - 1) }).valid).toBe(true);
    expect(verifySignedUrl(url, { key: KEY, now: at(EXP) }).valid).toBe(true);
    expect(verifySignedUrl(url, { key: KEY, now: at(EXP + 1) })).toEqual({ valid: false, reason: "expired" });
    expect(reasonOf(verifySignedUrl(url, { key: KEY, now: new Date(EXP * 1000 + 1) }))).toBe("expired");
  });

  it("refuses a changed path [X-005 AC2]", () => {
    const now = at(EXP - 60);
    const query = url.slice(url.indexOf("?"));
    for (const path of [
      "/v1/files/tenant_acme/documents/doc_01JABCDEFGHJKMNPQRSTVWXYZ0/itinerary-v2.pdf",
      "/v1/files/tenant_other/documents/doc_01JABCDEFGHJKMNPQRSTVWXYZ0/itinerary-v1.pdf",
      "/v1/files/tenant_acme/documents/doc_01JABCDEFGHJKMNPQRSTVWXYZ0/Itinerary-v1.pdf",
      "/v1/files/tenant_acme/documents/doc_01JABCDEFGHJKMNPQRSTVWXYZ0",
      `${PATH}.zip`,
    ]) {
      expect(reasonOf(verifySignedUrl(`${path}${query}`, { key: KEY, now })), path).toBe("signature");
    }
    // A path that only means the same after normalisation is not accepted either.
    expect(
      reasonOf(verifySignedUrl(`/v1/files/./${PATH.slice("/v1/files/".length)}${query}`, { key: KEY, now })),
    ).toBe("malformed");
  });

  it("refuses a changed exp [X-005 AC2]", () => {
    const now = at(EXP - 60);
    for (const exp of [EXP + 1, EXP + 3600, EXP - 1, EXP * 10]) {
      const changed = url.replace(`exp=${EXP}`, `exp=${exp}`);
      expect(changed).not.toBe(url);
      expect(reasonOf(verifySignedUrl(changed, { key: KEY, now })), String(exp)).toBe("signature");
    }
    expect(reasonOf(verifySignedUrl(url.replace(`exp=${EXP}`, `exp=0${EXP}`), { key: KEY, now }))).toBe(
      "malformed",
    );
  });

  it("refuses a changed signature, another key and a bad query", () => {
    const now = at(EXP - 60);
    const lastChar = SIG.charAt(SIG.length - 1);
    const otherLast = lastChar === "A" ? "B" : "A";
    expect(reasonOf(verifySignedUrl(`${url.slice(0, -1)}${otherLast}`, { key: KEY, now }))).toBe("signature");
    expect(reasonOf(verifySignedUrl(url, { key: Buffer.alloc(32, 7), now }))).toBe("signature");

    for (const bad of [
      PATH,
      `${PATH}?exp=${EXP}`,
      `${PATH}?sig=${SIG}&exp=${EXP}`,
      `${PATH}?exp=${EXP}&sig=${SIG}&download=1`,
      `${PATH}?exp=${EXP}&sig=${SIG}=`,
      `${PATH}?exp=${EXP}&sig=${SIG.slice(0, -1)}`,
      `${PATH}?exp=-1&sig=${SIG}`,
      `${PATH}?exp=${EXP}&sig=${SIG}#x`,
      `?exp=${EXP}&sig=${SIG}`,
      "",
    ]) {
      expect(reasonOf(verifySignedUrl(bad, { key: KEY, now })), bad).toBe("malformed");
    }
    expect(reasonOf(verifySignedUrl(undefined as unknown as string, { key: KEY, now }))).toBe("malformed");
  });

  it("accepts the same link on any origin, because only the path and exp are signed", () => {
    const now = at(EXP - 60);
    expect(verifySignedUrl(`https://api.ota.example.com${url}`, { key: KEY, now })).toEqual({
      valid: true,
      path: PATH,
      expiresAt: EXPIRES_AT,
    });
    expect(reasonOf(verifySignedUrl(`https://acme.example.com/api${url}`, { key: KEY, now }))).toBe(
      "signature",
    );
  });

  it("throws for a short key or an invalid now, which are programming errors", () => {
    expect(() => verifySignedUrl(url, { key: Buffer.alloc(16), now: at(EXP) })).toThrow(TypeError);
    expect(() => verifySignedUrl(url, { key: KEY, now: new Date(Number.NaN) })).toThrow(TypeError);
    expect(() => verifySignedUrl(url, { key: KEY, now: EXP as unknown as Date })).toThrow(TypeError);
  });
});
