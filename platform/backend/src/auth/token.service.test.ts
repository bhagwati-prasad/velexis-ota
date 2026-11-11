// TokenService (PBE-012): EdDSA access tokens of the portal and the platform admin with the claims of
// platform/docs/architecture.md §3.1, signed with a fresh Ed25519 key file per test file and checked at the time of a
// FakeClock, and the previous key of a rotation (JWT_PREVIOUS_PUBLIC_KEY_FILE, FIX-W48-PLATFORM). Every token here is
// made up on the spot; no value is a secret.
import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestJwtKeyFile, publicKeyPemOf, writeTestKeyFile } from "../../test/support/jwt-key";
import { PlatformOpenApi } from "../common/http/openapi-validation.interceptor";
import type { PlatformBackendConfig } from "../config";
import {
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_TTL_SECONDS,
  bearerTokenOf,
  loadSigningKey,
  loadVerifyingKey,
  MAX_ACCESS_TOKEN_LENGTH,
  TokenService,
  type AccessTokenInput,
} from "./token.service";

const ACCOUNT = "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X";
const FAMILY = "asn_01JA2Z9W5K7Q3M8N4P6R2T0V1Y";
const START = "2026-10-15T09:00:00.000Z";
const START_SECONDS = Date.parse(START) / 1000;

const PORTAL: AccessTokenInput = { aud: "portal", sub: ACCOUNT, sid: FAMILY, ev: true, amr: ["pwd"] };
const ADMIN: AccessTokenInput = {
  aud: "platform_admin",
  sub: ACCOUNT,
  sid: FAMILY,
  ev: true,
  amr: ["pwd", "otp"],
  mfa_at: START_SECONDS,
};

const keyFile = createTestJwtKeyFile();
const otherKeyFile = createTestJwtKeyFile();
/** The public half of otherKeyFile's key, as JWT_PREVIOUS_PUBLIC_KEY_FILE holds it after a rotation from that key. */
const otherPublicKeyFile = writeTestKeyFile(publicKeyPemOf(otherKeyFile.pem));

afterAll(() => {
  keyFile.remove();
  otherKeyFile.remove();
  otherPublicKeyFile.remove();
});

/**
 * The configuration as ConfigService holds it, with only the key files (the service reads nothing else):
 * JWT_PRIVATE_KEY_FILE and, during a rotation, JWT_PREVIOUS_PUBLIC_KEY_FILE.
 */
function configWith(path: string, previousPath?: string): ConfigService<PlatformBackendConfig, true> {
  const values: Record<string, string | undefined> = {
    JWT_PRIVATE_KEY_FILE: path,
    JWT_PREVIOUS_PUBLIC_KEY_FILE: previousPath,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<PlatformBackendConfig, true>;
}

function service(clock = new FakeClock(START), path = keyFile.path, previousPath?: string): TokenService {
  return new TokenService(configWith(path, previousPath), clock);
}

/** The AppError code a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("the promise resolved");
}

/** A token signed with `key` (default: the service's own) and any header and payload, for the refusal tests. */
function forge(
  payload: JWTPayload,
  header: { alg: string; kid?: string },
  key: KeyObject = createPrivateKey(keyFile.pem),
): Promise<string> {
  return new SignJWT(payload).setProtectedHeader(header).sign(key);
}

/** The payload `sign` writes for PORTAL at START, to change one claim at a time. */
const portalPayload = (): JWTPayload => ({
  iss: ACCESS_TOKEN_ISSUER,
  aud: "portal",
  sub: ACCOUNT,
  typ: "portal",
  sid: FAMILY,
  ev: true,
  amr: ["pwd"],
  iat: START_SECONDS,
  exp: START_SECONDS + ACCESS_TOKEN_TTL_SECONDS,
});

describe("TokenService.sign", () => {
  it("signs a 15-minute EdDSA token whose kid is the JWK thumbprint of the key", async () => {
    const tokens = service();

    const { token, expiresAt } = await tokens.sign({ ...PORTAL, mfa_at: START_SECONDS - 60 });

    const thumbprint = await calculateJwkThumbprint(await exportJWK(tokens.publicKey), "sha256");
    expect(tokens.kid).toBe(thumbprint);
    expect(decodeProtectedHeader(token)).toEqual({ alg: "EdDSA", kid: thumbprint });
    expect(decodeJwt(token)).toEqual({
      iss: "https://api.platform.example.com",
      aud: "portal",
      sub: ACCOUNT,
      typ: "portal",
      sid: FAMILY,
      ev: true,
      amr: ["pwd"],
      mfa_at: START_SECONDS - 60,
      iat: START_SECONDS,
      exp: START_SECONDS + 900,
    });
    expect(expiresAt.toISOString()).toBe("2026-10-15T09:15:00.000Z");
  });

  it("writes typ admin for the platform_admin audience and leaves mfa_at out when there is none", async () => {
    const admin = decodeJwt((await service().sign(ADMIN)).token);
    const portal = decodeJwt((await service().sign(PORTAL)).token);

    expect(admin).toMatchObject({ aud: "platform_admin", typ: "admin", amr: ["pwd", "otp"] });
    expect(portal).not.toHaveProperty("mfa_at");
  });

  it.each([
    ["an admin token without otp", { ...ADMIN, amr: ["pwd"] }],
    ["an admin token for an unverified address", { ...ADMIN, ev: false }],
    ["a sub that is not an account id", { ...PORTAL, sub: "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1X" }],
    ["a sid with a character outside SessionFamilyId", { ...PORTAL, sid: "family 1" }],
    ["a sid longer than 64 characters", { ...PORTAL, sid: "a".repeat(65) }],
    ["an empty sid", { ...PORTAL, sid: "" }],
    ["an empty amr", { ...PORTAL, amr: [] }],
    ["an mfa_at in the future", { ...PORTAL, mfa_at: START_SECONDS + 1 }],
  ] as const)("refuses to sign %s", async (_case, input) => {
    await expect(service().sign(input as AccessTokenInput)).rejects.toThrow(TypeError);
  });

  /** The platform document's `SessionFamilyId`, read in the hook below. */
  let schema: { pattern: string; maxLength: number; examples: string[] };

  /**
   * The budget of reading the platform document: `PlatformOpenApi.load()` parses some 20 000 lines of YAML on its first
   * call in a worker, under a second idle but several seconds next to the other packages' tests on a loaded runner
   * (FIX-W36-PLATFORM, lead decision (2j)). The hook only stops if it hangs; the test body keeps the default budget.
   */
  const DOCUMENT_LOAD_TIMEOUT_MS = 30_000;

  beforeAll(() => {
    const document = PlatformOpenApi.load().document as {
      components: {
        schemas: { SessionFamilyId: { pattern: string; maxLength: number; examples: string[] } };
      };
    };
    schema = document.components.schemas.SessionFamilyId;
  }, DOCUMENT_LOAD_TIMEOUT_MS);

  it("takes any SessionFamilyId of the platform document as sid, which is opaque", async () => {
    const tokens = service();

    // The check of TokenService is the schema's, so every familyId that listSessions answers can be a sid.
    expect([schema.pattern, schema.maxLength]).toEqual(["^[A-Za-z0-9_-]+$", 64]);
    for (const sid of [...schema.examples, "f", "fam_0123-abc", "a".repeat(64)]) {
      const { token } = await tokens.sign({ ...PORTAL, sid });
      await expect(tokens.verify(token, "portal"), sid).resolves.toMatchObject({ sid });
    }
  });
});

describe("TokenService.verify", () => {
  it("returns the claims of its own token for the token's audience", async () => {
    const tokens = service();
    const { token } = await tokens.sign(ADMIN);

    await expect(tokens.verify(token, "platform_admin")).resolves.toEqual({
      iss: ACCESS_TOKEN_ISSUER,
      aud: "platform_admin",
      sub: ACCOUNT,
      typ: "admin",
      sid: FAMILY,
      ev: true,
      amr: ["pwd", "otp"],
      mfa_at: START_SECONDS,
      iat: START_SECONDS,
      exp: START_SECONDS + 900,
    });
  });

  it("[PBE-012 AC1] refuses a portal token for the admin audience and an admin token for the portal (401)", async () => {
    const tokens = service();
    const portal = (await tokens.sign(PORTAL)).token;
    const admin = (await tokens.sign(ADMIN)).token;

    expect(await rejection(tokens.verify(portal, "platform_admin"))).toBe("UNAUTHENTICATED");
    expect(await rejection(tokens.verify(admin, "portal"))).toBe("UNAUTHENTICATED");
    expect(new AppError("UNAUTHENTICATED").status).toBe(401);
  });

  it("answers TOKEN_EXPIRED from the 15th minute on, UNAUTHENTICATED for an expired token of the other surface", async () => {
    const clock = new FakeClock(START);
    const tokens = service(clock);
    const { token } = await tokens.sign(PORTAL);

    clock.advance((ACCESS_TOKEN_TTL_SECONDS - 1) * 1000);
    await expect(tokens.verify(token, "portal")).resolves.toMatchObject({ sub: ACCOUNT });
    clock.advance(1000);
    expect(await rejection(tokens.verify(token, "portal"))).toBe("TOKEN_EXPIRED");
    expect(await rejection(tokens.verify(token, "platform_admin"))).toBe("UNAUTHENTICATED");
    expect(new AppError("TOKEN_EXPIRED").status).toBe(401);
  });

  it("refuses a token signed by another key, a changed payload, another kid, another issuer or no signature", async () => {
    const tokens = service();
    const other = service(new FakeClock(START), otherKeyFile.path);
    const [header, , signature] = (await tokens.sign(PORTAL)).token.split(".");
    const changedPayload = Buffer.from(
      JSON.stringify({ ...portalPayload(), sub: ACCOUNT.replace("X", "Y") }),
    ).toString("base64url");
    const forged = [
      (await other.sign(PORTAL)).token,
      `${header ?? ""}.${changedPayload}.${signature ?? ""}`,
      await forge(portalPayload(), { alg: "EdDSA", kid: "another-key" }),
      await forge(portalPayload(), { alg: "EdDSA" }),
      await forge(
        { ...portalPayload(), iss: "https://api.ota.example.com" },
        { alg: "EdDSA", kid: tokens.kid },
      ),
      new UnsecuredJWT(portalPayload()).encode(),
      // HMAC with a made-up shared key: only EdDSA is accepted.
      await new SignJWT(portalPayload())
        .setProtectedHeader({ alg: "HS256", kid: tokens.kid })
        .sign(new TextEncoder().encode("made-up-hmac-key-for-this-test-only")),
    ];

    for (const token of forged) {
      expect(await rejection(tokens.verify(token, "portal")), token).toBe("UNAUTHENTICATED");
    }
  });

  it.each([
    ["typ of the other audience", { typ: "admin" }],
    ["a sub that is not an account id", { sub: "acc_short" }],
    ["no sid", { sid: undefined }],
    ["a sid outside SessionFamilyId", { sid: "family 1" }],
    ["ev that is not a boolean", { ev: "true" }],
    ["an unknown method in amr", { amr: ["pwd", "sms"] }],
    ["an mfa_at that is not epoch seconds", { mfa_at: "2026-10-15T09:00:00Z" }],
  ])("refuses a correctly signed token with %s", async (_case, change) => {
    const tokens = service();
    const token = await forge({ ...portalPayload(), ...change }, { alg: "EdDSA", kid: tokens.kid });

    expect(await rejection(tokens.verify(token, "portal"))).toBe("UNAUTHENTICATED");
  });

  it("refuses a correctly signed admin token without otp or for an unverified address", async () => {
    const tokens = service();
    const admin = { ...portalPayload(), aud: "platform_admin", typ: "admin", amr: ["pwd", "otp"] };

    for (const change of [{ amr: ["pwd"] }, { ev: false }]) {
      const token = await forge({ ...admin, ...change }, { alg: "EdDSA", kid: tokens.kid });
      expect(await rejection(tokens.verify(token, "platform_admin"))).toBe("UNAUTHENTICATED");
    }
  });

  it("answers UNAUTHENTICATED for no token, an empty one, garbage and an oversized one", async () => {
    const tokens = service();

    for (const token of [undefined, "", "not-a-token", "a.b.c", "x".repeat(MAX_ACCESS_TOKEN_LENGTH + 1)]) {
      expect(await rejection(tokens.verify(token, "portal"))).toBe("UNAUTHENTICATED");
    }
  });
});

describe("the previous key of a rotation (JWT_PREVIOUS_PUBLIC_KEY_FILE)", () => {
  it("[FIX-W48-PLATFORM AC2] accepts the tokens of the previous key while it is configured, and signs with the current key only", async () => {
    // Before the rotation the API signed with otherKeyFile's key; after it, keyFile's key signs and the old public key
    // only verifies.
    const before = service(new FakeClock(START), otherKeyFile.path);
    const after = service(new FakeClock(START), keyFile.path, otherPublicKeyFile.path);
    const oldToken = (await before.sign(PORTAL)).token;
    const oldAdminToken = (await before.sign(ADMIN)).token;
    const newToken = (await after.sign(PORTAL)).token;

    expect(after.previousKid).toBe(before.kid);
    expect(after.kid).not.toBe(before.kid);
    expect(decodeProtectedHeader(newToken).kid).toBe(after.kid);
    expect(await after.verify(oldToken, "portal")).toMatchObject({
      aud: "portal",
      sub: ACCOUNT,
      sid: FAMILY,
    });
    expect(await after.verify(oldAdminToken, "platform_admin")).toMatchObject({
      aud: "platform_admin",
      typ: "admin",
    });
    expect(await after.verify(newToken, "portal")).toMatchObject({ aud: "portal", sub: ACCOUNT });
    // The previous key's tokens keep every other rule: the audience, and the 15 minutes from their own iat.
    expect(await rejection(after.verify(oldToken, "platform_admin"))).toBe("UNAUTHENTICATED");
    const later = service(new FakeClock("2026-10-15T09:15:00.000Z"), keyFile.path, otherPublicKeyFile.path);
    expect(await rejection(later.verify(oldToken, "portal"))).toBe("TOKEN_EXPIRED");
  });

  it("[FIX-W48-PLATFORM AC2] refuses the previous key's tokens once the variable is removed, and refuses an unknown kid", async () => {
    const before = service(new FakeClock(START), otherKeyFile.path);
    const removed = service(new FakeClock(START), keyFile.path);
    const during = service(new FakeClock(START), keyFile.path, otherPublicKeyFile.path);
    const oldToken = (await before.sign(PORTAL)).token;
    const third = createTestJwtKeyFile();
    try {
      const unknown = (await service(new FakeClock(START), third.path).sign(PORTAL)).token;
      expect(removed.previousKid).toBeUndefined();
      expect(await rejection(removed.verify(oldToken, "portal"))).toBe("UNAUTHENTICATED");
      expect(await rejection(during.verify(unknown, "portal"))).toBe("UNAUTHENTICATED");
      // A token that names the previous kid but is signed by another key, and one of the current kid signed by the
      // previous key: the kid picks the key, and the signature must be that key's.
      const wrongKey = await forge(
        portalPayload(),
        { alg: "EdDSA", kid: before.kid },
        createPrivateKey(third.pem),
      );
      const swapped = await forge(
        portalPayload(),
        { alg: "EdDSA", kid: during.kid },
        createPrivateKey(otherKeyFile.pem),
      );
      const noKid = await forge(portalPayload(), { alg: "EdDSA" }, createPrivateKey(otherKeyFile.pem));
      for (const token of [wrongKey, swapped, noKid]) {
        expect(await rejection(during.verify(token, "portal")), token).toBe("UNAUTHENTICATED");
      }
    } finally {
      third.remove();
    }
  });

  it("[FIX-W48-PLATFORM AC2] refuses at start-up a previous key with the current kid, a private key, a key that is not Ed25519 and a file others may read, without its content", () => {
    const own = writeTestKeyFile(publicKeyPemOf(keyFile.pem));
    const readable = writeTestKeyFile(publicKeyPemOf(otherKeyFile.pem), 0o644);
    const ec = writeTestKeyFile(
      generateKeyPairSync("ec", {
        namedCurve: "P-256",
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).publicKey,
    );
    try {
      expect(() => service(new FakeClock(START), keyFile.path, own.path)).toThrow(
        /holds the public half of JWT_PRIVATE_KEY_FILE \(the same kid\)/,
      );
      expect(() => service(new FakeClock(START), keyFile.path, otherKeyFile.path)).toThrow(
        /must hold only a public key .*never a private key/,
      );
      expect(() => loadVerifyingKey(ec.path)).toThrow(
        /holds a key of type ec; platform tokens are signed with Ed25519/,
      );
      expect(() => loadVerifyingKey(readable.path)).toThrow(/accessible by group or others/);
      expect(() => loadVerifyingKey(`${readable.path}.missing`)).toThrow(/does not exist/);
      // Every refusal stops the service; none quotes a line of the key (the current key's public half is a valid key
      // file on its own, so only the service refuses it).
      for (const file of [own, readable, ec, otherKeyFile]) {
        const body = file.pem.split("\n")[1] ?? "";
        const start = () => service(new FakeClock(START), keyFile.path, file.path);
        expect(start).toThrow();
        expect(start).not.toThrow(body);
        if (file !== own) {
          expect(() => loadVerifyingKey(file.path)).not.toThrow(body);
        }
      }
    } finally {
      own.remove();
      readable.remove();
      ec.remove();
    }
  });

  it("gives the previous key the kid its private key signed with", () => {
    expect(loadVerifyingKey(otherPublicKeyFile.path).kid).toBe(loadSigningKey(otherKeyFile.path).kid);
  });
});

describe("loadSigningKey", () => {
  it("refuses a key file others may read, a missing one and a key that is not Ed25519, without its content", () => {
    const readable = writeTestKeyFile(keyFile.pem, 0o644);
    const ec = writeTestKeyFile(
      generateKeyPairSync("ec", {
        namedCurve: "P-256",
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey,
    );
    try {
      expect(() => loadSigningKey(readable.path)).toThrow(/accessible by group or others/);
      expect(() => loadSigningKey(`${readable.path}.missing`)).toThrow(/does not exist/);
      expect(() => loadSigningKey(ec.path)).toThrow(
        /holds a key of type ec; platform tokens are signed with Ed25519/,
      );
      for (const file of [readable, ec]) {
        const body = file.pem.split("\n")[1] ?? "";
        expect(() => loadSigningKey(file.path)).not.toThrow(body);
      }
    } finally {
      readable.remove();
      ec.remove();
    }
  });

  it("gives the same kid for the same key and another for another key", () => {
    expect(loadSigningKey(keyFile.path).kid).toBe(service().kid);
    expect(loadSigningKey(otherKeyFile.path).kid).not.toBe(service().kid);
  });
});

describe("bearerTokenOf", () => {
  it.each([
    ["Bearer abc.def.ghi", "abc.def.ghi"],
    ["bearer abc.def.ghi", "abc.def.ghi"],
    ["Bearer  abc-_.def~+/=", "abc-_.def~+/="],
    ["Basic dXNlcjpwYXNz", undefined],
    ["Bearer", undefined],
    ["Bearer abc def", undefined],
    ["abc.def.ghi", undefined],
    [`Bearer ${"a".repeat(MAX_ACCESS_TOKEN_LENGTH + 32)}`, undefined],
  ])("%s gives %s", (authorization, expected) => {
    expect(bearerTokenOf({ authorization })).toBe(expected);
  });

  it("gives undefined without an Authorization header", () => {
    expect(bearerTokenOf({})).toBeUndefined();
  });
});
