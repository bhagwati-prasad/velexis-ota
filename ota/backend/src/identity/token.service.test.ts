// TokenService (OBE-031 step 1): the OTA backend's customer access tokens, EdDSA JWTs with `kid`, `typ: customer`,
// `sub`, `tid` and `sid`, valid 15 minutes, verified with 30 s of clock skew, against the key file of this test
// process (test/helpers/api-env.ts) and the times of a FakeClock, and the previous key of a rotation
// (JWT_PREVIOUS_PUBLIC_KEY_FILE, FIX-W48-OTA). Every token here is made up on the spot; no value is a secret.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigService } from "@nestjs/config";
import { FakeClock } from "@velexis/testing";
import {
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  SignJWT,
  UnsecuredJWT,
  type JWTPayload,
} from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { testApiCredentials } from "../../test/helpers/api-env";
import type { ApiConfig } from "../config";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  bearerTokenOf,
  CLOCK_SKEW_SECONDS,
  loadSigningKey,
  loadVerifyingKey,
  MAX_ACCESS_TOKEN_LENGTH,
  PreviousSigningKey,
  TokenService,
  type CustomerTokenInput,
} from "./token.service";

const CUSTOMER = "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1X";
const TENANT_A = "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1A";
const TENANT_B = "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1B";
const SESSION = "ses_01JA2Z9W5K7Q3M8N4P6R2T0V1S";
const START = "2026-10-18T09:00:00.000Z";
const START_SECONDS = Date.parse(START) / 1000;

const INPUT: CustomerTokenInput = { sub: CUSTOMER, tid: TENANT_A, sid: SESSION };

/** A folder for the key files of the refusal tests. */
const scratch = mkdtempSync(join(tmpdir(), "velexis-ota-jwt-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Writes `pem` to a new file of the scratch folder with `mode`, as `pnpm dev:keys` writes a key (0600). */
function keyFile(name: string, pem: string, mode = 0o600): string {
  const path = join(scratch, name);
  writeFileSync(path, pem, { mode });
  // The umask may have removed bits from `mode`; set exactly what the test asked for.
  chmodSync(path, mode);
  return path;
}

const ed25519Pem = (): string =>
  generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;

/** The configuration as ConfigService holds it, with only the key file (the service reads nothing else). */
function configWith(path: string): ConfigService<ApiConfig, true> {
  return { get: () => path } as unknown as ConfigService<ApiConfig, true>;
}

function service(clock = new FakeClock(START), path = testApiCredentials().jwtKeyFile): TokenService {
  return new TokenService(configWith(path), clock);
}

/** The service's own private key, to forge tokens with any header and payload. */
const ownKey = (): KeyObject => loadSigningKey(testApiCredentials().jwtKeyFile).privateKey;

/** A token signed with `key` (default: the service's own) and any header and payload, for the refusal tests. */
function forge(payload: JWTPayload, header: { alg: string; kid?: string }, key: KeyObject = ownKey()) {
  return new SignJWT(payload).setProtectedHeader(header).sign(key);
}

/** The payload `signCustomerToken` writes for INPUT at START, to change one claim at a time. */
const payload = (): JWTPayload => ({
  typ: "customer",
  tid: TENANT_A,
  sid: SESSION,
  sub: CUSTOMER,
  iat: START_SECONDS,
  exp: START_SECONDS + ACCESS_TOKEN_TTL_SECONDS,
});

describe("TokenService.signCustomerToken", () => {
  it("signs a 15-minute EdDSA token whose kid is the JWK thumbprint of the key, with typ, sub, tid and sid", async () => {
    const tokens = service();

    const { token, expiresAt } = await tokens.signCustomerToken(INPUT);

    const thumbprint = await calculateJwkThumbprint(await exportJWK(tokens.publicKey), "sha256");
    expect(tokens.kid).toBe(thumbprint);
    expect(decodeProtectedHeader(token)).toEqual({ alg: "EdDSA", kid: thumbprint });
    expect(decodeJwt(token)).toEqual({
      typ: "customer",
      sub: CUSTOMER,
      tid: TENANT_A,
      sid: SESSION,
      iat: START_SECONDS,
      exp: START_SECONDS + 900,
    });
    expect(expiresAt.toISOString()).toBe("2026-10-18T09:15:00.000Z");
  });

  it("keeps the kid of the key file across instances, so every process of a release signs alike", () => {
    expect(service().kid).toBe(service(new FakeClock(), testApiCredentials().jwtKeyFile).kid);
  });

  it.each([
    ["a sub that is not a customer id", { ...INPUT, sub: "stf_01JA2Z9W5K7Q3M8N4P6R2T0V1X" }],
    ["a tid that is not a tenant id", { ...INPUT, tid: "tenant-a" }],
    ["a sid that is not a session id", { ...INPUT, sid: "asn_01JA2Z9W5K7Q3M8N4P6R2T0V1S" }],
  ] as const)("refuses to sign %s, naming the claim but not its value", async (_case, input) => {
    const error = await service()
      .signCustomerToken(input)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(TypeError);
    for (const value of Object.values(input)) {
      expect(String(error)).not.toContain(value);
    }
  });
});

describe("TokenService.verifyCustomerToken", () => {
  it("answers the claims of a token of the request's tenant", async () => {
    const tokens = service();
    const { token } = await tokens.signCustomerToken(INPUT);

    expect(await tokens.verifyCustomerToken(token, TENANT_A)).toEqual({
      ok: true,
      claims: {
        typ: "customer",
        sub: CUSTOMER,
        tid: TENANT_A,
        sid: SESSION,
        iat: START_SECONDS,
        exp: START_SECONDS + 900,
      },
    });
  });

  it("refuses a token of tenant A presented at tenant B, expired or not [OBE-031 AC1] [OF-01 AC2]", async () => {
    const clock = new FakeClock(START);
    const tokens = service(clock);
    const { token } = await tokens.signCustomerToken(INPUT);

    const fresh = await tokens.verifyCustomerToken(token, TENANT_B);
    clock.advance((ACCESS_TOKEN_TTL_SECONDS + CLOCK_SKEW_SECONDS + 60) * 1000);
    const expired = await tokens.verifyCustomerToken(token, TENANT_B);

    expect(fresh).toEqual({ ok: false, reason: "other_tenant" });
    expect(expired).toEqual({ ok: false, reason: "other_tenant" });
  });

  it("allows 30 s of clock skew past exp, then answers expired", async () => {
    const clock = new FakeClock(START);
    const tokens = service(clock);
    const { token } = await tokens.signCustomerToken(INPUT);

    clock.advance((ACCESS_TOKEN_TTL_SECONDS + CLOCK_SKEW_SECONDS - 1) * 1000);
    const withinSkew = await tokens.verifyCustomerToken(token, TENANT_A);
    clock.advance(1000);
    const pastSkew = await tokens.verifyCustomerToken(token, TENANT_A);

    expect(withinSkew.ok).toBe(true);
    expect(pastSkew).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a token issued by a clock up to 30 s ahead, and refuses one from further ahead", async () => {
    const verifier = service(new FakeClock(START));
    const slightlyAhead = await service(new FakeClock(Date.parse(START) + 30_000)).signCustomerToken(INPUT);
    const farAhead = await service(new FakeClock(Date.parse(START) + 31_000)).signCustomerToken(INPUT);

    expect((await verifier.verifyCustomerToken(slightlyAhead.token, TENANT_A)).ok).toBe(true);
    expect(await verifier.verifyCustomerToken(farAhead.token, TENANT_A)).toEqual({
      ok: false,
      reason: "claims",
    });
  });

  it("answers missing without a token, and malformed for what is no JWT or far too long", async () => {
    const tokens = service();
    const { token } = await tokens.signCustomerToken(INPUT);

    expect(await tokens.verifyCustomerToken(undefined, TENANT_A)).toEqual({ ok: false, reason: "missing" });
    expect(await tokens.verifyCustomerToken("", TENANT_A)).toEqual({ ok: false, reason: "missing" });
    for (const value of ["not-a-jwt", "a.b.c", `${token}x`.replace(/^[^.]+/, "e30"), "x".repeat(4097)]) {
      expect(await tokens.verifyCustomerToken(value, TENANT_A)).toMatchObject({ ok: false });
    }
    expect(await tokens.verifyCustomerToken("not-a-jwt", TENANT_A)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await tokens.verifyCustomerToken("x".repeat(MAX_ACCESS_TOKEN_LENGTH + 1), TENANT_A)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses another key, another kid, another algorithm and an unsigned token as signature failures", async () => {
    const tokens = service();
    const otherKey = createPrivateKey(ed25519Pem());
    const unsigned = new UnsecuredJWT(payload()).encode();
    const { token } = await tokens.signCustomerToken(INPUT);
    const [header = "", body = ""] = token.split(".");

    const cases = {
      otherKeySameKid: await forge(payload(), { alg: "EdDSA", kid: tokens.kid }, otherKey),
      otherKid: await forge(payload(), { alg: "EdDSA", kid: "another-key" }),
      noKid: await forge(payload(), { alg: "EdDSA" }),
      unsigned,
      tamperedPayload: `${header}.${Buffer.from(JSON.stringify({ ...payload(), sub: "cus_01JA2Z9W5K7Q3M8N4P6R2T0V9Z" })).toString("base64url")}.${token.split(".")[2] ?? ""}`,
      hmacHeader: `${Buffer.from(JSON.stringify({ alg: "HS256", kid: tokens.kid })).toString("base64url")}.${body}.c2ln`,
    };

    for (const [name, value] of Object.entries(cases)) {
      expect([name, await tokens.verifyCustomerToken(value, TENANT_A)]).toEqual([
        name,
        { ok: false, reason: "signature" },
      ]);
    }
  });

  it.each([
    ["a staff token", { typ: "staff" }],
    ["a token without typ", { typ: undefined }],
    ["a sub that is not a customer id", { sub: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X" }],
    ["a tid that is not a tenant id", { tid: "alpha" }],
    ["a missing sid", { sid: undefined }],
    ["a lifetime other than 15 minutes", { exp: START_SECONDS + 3600 }],
  ] as const)("refuses %s signed with the service's own key as a claims failure", async (_case, change) => {
    const forged = await forge({ ...payload(), ...change }, { alg: "EdDSA", kid: service().kid });

    expect(await service().verifyCustomerToken(forged, TENANT_A)).toEqual({ ok: false, reason: "claims" });
  });

  it("refuses an expired staff token as a claims failure, not as expired", async () => {
    const forged = await forge({ ...payload(), typ: "staff" }, { alg: "EdDSA", kid: service().kid });
    const clock = new FakeClock(Date.parse(START) + 3_600_000);

    expect(await service(clock).verifyCustomerToken(forged, TENANT_A)).toEqual({
      ok: false,
      reason: "claims",
    });
  });
});

/** The public half of a private key's PEM, as JWT_PREVIOUS_PUBLIC_KEY_FILE holds it (`openssl pkey -pubout`). */
const publicPemOf = (privatePem: string): string =>
  createPublicKey(privatePem).export({ type: "spki", format: "pem" }) as string;

/**
 * The previous key of a rotation as IdentityModule provides it: read from the public key file at `path`, or none when
 * JWT_PREVIOUS_PUBLIC_KEY_FILE is unset (`undefined`).
 */
const previousKeyAt = (path: string | undefined): PreviousSigningKey =>
  new PreviousSigningKey({ get: () => path } as unknown as ConfigService<ApiConfig, true>);

/** Numbers the key files of the rotations, so that each rotation has new files. */
let rotations = 0;

/**
 * A rotation: the API signed with `old` (the test process's key) and now signs with `next`, whose service also holds
 * the public half of `old` as the previous key.
 */
function rotation(clock = new FakeClock(START)) {
  rotations += 1;
  const nextPath = keyFile(`next-${rotations}.pem`, ed25519Pem());
  const previousPath = keyFile(
    `previous-${rotations}.pub.pem`,
    publicPemOf(readFileSync(testApiCredentials().jwtKeyFile, "utf8")),
  );
  return {
    old: service(clock),
    rotating: new TokenService(configWith(nextPath), clock, previousKeyAt(previousPath)),
    // The overlap is over: the variable is removed and the API restarted with the new key alone.
    after: new TokenService(configWith(nextPath), clock, previousKeyAt(undefined)),
  };
}

describe("the previous key of a rotation (JWT_PREVIOUS_PUBLIC_KEY_FILE) [FIX-W48-OTA AC1]", () => {
  it("[FIX-W48-OTA AC1] accepts the old key's tokens while the previous key is configured, and signs with the new key only", async () => {
    const { old, rotating } = rotation();
    const { token: oldToken } = await old.signCustomerToken(INPUT);
    const { token: newToken } = await rotating.signCustomerToken(INPUT);

    expect(rotating.previousKid).toBe(old.kid);
    expect(rotating.kid).not.toBe(old.kid);
    expect(decodeProtectedHeader(newToken)).toEqual({ alg: "EdDSA", kid: rotating.kid });
    for (const token of [oldToken, newToken]) {
      expect(await rotating.verifyCustomerToken(token, TENANT_A)).toEqual({
        ok: true,
        claims: {
          typ: "customer",
          sub: CUSTOMER,
          tid: TENANT_A,
          sid: SESSION,
          iat: START_SECONDS,
          exp: START_SECONDS + 900,
        },
      });
    }
    // The old key's tokens keep every other rule: another tenant, and expiry after their 15 minutes and the skew.
    expect(await rotating.verifyCustomerToken(oldToken, TENANT_B)).toEqual({
      ok: false,
      reason: "other_tenant",
    });
    const later = rotation(
      new FakeClock(Date.parse(START) + (ACCESS_TOKEN_TTL_SECONDS + 31) * 1000),
    ).rotating;
    expect(await later.verifyCustomerToken(oldToken, TENANT_A)).toEqual({ ok: false, reason: "expired" });
  });

  it("[FIX-W48-OTA AC1] refuses the old key's tokens once the previous key is removed, and a token of an unknown kid", async () => {
    const { old, rotating, after } = rotation();
    const { token: oldToken } = await old.signCustomerToken(INPUT);
    const unknownKey = createPrivateKey(ed25519Pem());
    const unknownKid = await forge(payload(), { alg: "EdDSA", kid: "an-unknown-kid" }, unknownKey);
    // A token of another key that claims the previous key's kid: the kid picks the key, the signature fails.
    const previousKidOtherKey = await forge(payload(), { alg: "EdDSA", kid: old.kid }, unknownKey);

    expect(after.previousKid).toBeUndefined();
    expect(await after.verifyCustomerToken(oldToken, TENANT_A)).toEqual({ ok: false, reason: "signature" });
    expect(
      await after.verifyCustomerToken((await after.signCustomerToken(INPUT)).token, TENANT_A),
    ).toMatchObject({
      ok: true,
    });
    for (const tokens of [rotating, after]) {
      expect(await tokens.verifyCustomerToken(unknownKid, TENANT_A)).toEqual({
        ok: false,
        reason: "signature",
      });
      expect(await tokens.verifyCustomerToken(previousKidOtherKey, TENANT_A)).toEqual({
        ok: false,
        reason: "signature",
      });
    }
  });

  it("[FIX-W48-OTA AC1] refuses to start with the current key's public half as the previous key", () => {
    const own = keyFile("own.pub.pem", publicPemOf(readFileSync(testApiCredentials().jwtKeyFile, "utf8")));

    expect(
      () =>
        new TokenService(
          configWith(testApiCredentials().jwtKeyFile),
          new FakeClock(START),
          previousKeyAt(own),
        ),
    ).toThrow(/holds the public half of JWT_PRIVATE_KEY_FILE \(the same kid\)/);
  });

  it("[FIX-W48-OTA AC1] reads only an Ed25519 public key, naming the path but no byte of the file", () => {
    const privatePem = ed25519Pem();
    const privateFile = keyFile("previous-private.pem", privatePem);
    const readable = keyFile("previous-readable.pub.pem", publicPemOf(ed25519Pem()), 0o644);
    const valid = keyFile("previous-valid.pub.pem", publicPemOf(privatePem));

    expect(() => loadVerifyingKey(privateFile)).toThrow(/never a private key/);
    try {
      loadVerifyingKey(privateFile);
    } catch (error) {
      expect(String(error)).toContain(privateFile);
      expect(String(error)).not.toContain(privatePem.split("\n")[1] ?? "unreachable");
    }
    expect(() => loadVerifyingKey(readable)).toThrow(/0400 or 0600/);
    expect(loadVerifyingKey(valid).kid).toBe(loadSigningKey(privateFile).kid);
  });
});

describe("bearerTokenOf", () => {
  it("reads the token of an Authorization: Bearer header and nothing else", () => {
    expect(bearerTokenOf({ authorization: "Bearer abc.DEF-1_2.x~y+z/w=" })).toBe("abc.DEF-1_2.x~y+z/w=");
    expect(bearerTokenOf({ authorization: "bearer abc" })).toBe("abc");
    for (const value of [undefined, "", "Basic abc", "Bearer", "Bearer a b", `Bearer ${"a".repeat(4200)}`]) {
      expect(bearerTokenOf({ authorization: value })).toBeUndefined();
    }
    expect(bearerTokenOf({ authorization: ["Bearer abc"] })).toBeUndefined();
  });
});

describe("loadSigningKey", () => {
  it("refuses a key that is not Ed25519, naming the path but no byte of the file", () => {
    const pem = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const path = keyFile("p256.pem", pem);

    expect(() => loadSigningKey(path)).toThrow(/ec; OTA tokens are signed with Ed25519/);
    try {
      loadSigningKey(path);
    } catch (error) {
      expect(String(error)).toContain(path);
      expect(String(error)).not.toContain(pem.split("\n")[1] ?? "unreachable");
    }
  });

  it("refuses a key file that others may read, and a PEM block that is no private key", () => {
    const readable = keyFile("readable.pem", ed25519Pem(), 0o644);
    const notAKey = keyFile(
      "not-a-key.pem",
      `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----\n`,
    );

    expect(() => loadSigningKey(readable)).toThrow(/0400 or 0600/);
    expect(() => loadSigningKey(notAKey)).toThrow(/does not hold a PEM private key/);
  });
});
