// TokenService (PBE-012): EdDSA access tokens of the portal and the platform admin with the claims of
// platform/docs/architecture.md §3.1, signed with a fresh Ed25519 key file per test file and checked at the time of a
// FakeClock. Every token here is made up on the spot; no value is a secret.
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
import { afterAll, describe, expect, it } from "vitest";
import { createTestJwtKeyFile, writeTestKeyFile } from "../../test/support/jwt-key";
import { PlatformOpenApi } from "../common/http/openapi-validation.interceptor";
import type { PlatformBackendConfig } from "../config";
import {
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_TTL_SECONDS,
  bearerTokenOf,
  loadSigningKey,
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

afterAll(() => {
  keyFile.remove();
  otherKeyFile.remove();
});

/** The configuration as ConfigService holds it, with only the key file (the service reads nothing else). */
function configWith(path: string): ConfigService<PlatformBackendConfig, true> {
  return { get: () => path } as unknown as ConfigService<PlatformBackendConfig, true>;
}

function service(clock = new FakeClock(START), path = keyFile.path): TokenService {
  return new TokenService(configWith(path), clock);
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

  it("takes any SessionFamilyId of the platform document as sid, which is opaque", async () => {
    const document = PlatformOpenApi.load().document as {
      components: {
        schemas: { SessionFamilyId: { pattern: string; maxLength: number; examples: string[] } };
      };
    };
    const schema = document.components.schemas.SessionFamilyId;
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
