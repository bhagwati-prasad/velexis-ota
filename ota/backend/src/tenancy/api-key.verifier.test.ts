// ApiKeyVerifier against a fake repository, a fake clock and a recording logger (OBE-011): the format, the HMAC
// compare, revocation, expiry, kind and environment, scopes and the origins of publishable keys. The same checks
// against PostgreSQL rows inserted as the platform does are in test/integration/tenancy/caller.int.test.ts.
import { randomBytes } from "node:crypto";
import { hashApiKey } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newApiKey, withCharacterChanged } from "../../test/helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../test/helpers/openapi";
import { loadOpenApiDocument } from "../common/http/openapi-validation.interceptor";
import { newId } from "../common/ids";
import {
  API_KEY_PATTERN,
  ApiKeyVerifier,
  CONSOLE_API_KEY_SCOPES,
  scopeProblem,
  STAFF_PERMISSIONS,
} from "./api-key.verifier";
import type { PlatformApiKey, PlatformReadRepository } from "./platform-read.repository";
import { UnexpectedPlatformValueError } from "./platform-read.types";

const PEPPER = randomBytes(32);
const TENANT_ID = newId("ten");
const NOW = "2026-10-15T09:00:00.000Z";

/** The `platform.api_keys` row of `key`, as the platform writes it, valid unless a test overrides a field. */
function rowOf(key: string, overrides: Partial<PlatformApiKey> = {}): PlatformApiKey {
  return {
    id: newId("key"),
    tenantId: TENANT_ID,
    kind: key.startsWith("pk_") ? "publishable" : "secret",
    environment: key.includes("_live_") ? "live" : "test",
    prefix: key.slice(0, 14),
    keyHash: hashApiKey(key, PEPPER),
    allowedOrigins: [],
    scopes: key.startsWith("pk_") ? [] : ["storefront"],
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

interface Harness {
  readonly verifier: ApiKeyVerifier;
  readonly lookup: ReturnType<typeof vi.fn<(prefix: string) => Promise<PlatformApiKey | null>>>;
  readonly clock: FakeClock;
  /** Every log call as `[level, fields, message]`. */
  readonly logs: Array<[string, unknown, string]>;
}

/** A verifier whose repository knows `rows` by prefix. */
function harness(...rows: PlatformApiKey[]): Harness {
  const lookup = vi.fn((prefix: string) =>
    Promise.resolve(rows.find((row) => row.prefix === prefix) ?? null),
  );
  const logs: Array<[string, unknown, string]> = [];
  const logger = {
    setContext: () => undefined,
    info: (fields: unknown, message: string) => logs.push(["info", fields, message]),
    warn: (fields: unknown, message: string) => logs.push(["warn", fields, message]),
  } as unknown as PinoLogger;
  const clock = new FakeClock(NOW);
  const repository = { apiKeyByPrefix: lookup } as unknown as PlatformReadRepository;
  return { verifier: new ApiKeyVerifier(repository, PEPPER, clock, logger), lookup, clock, logs };
}

/** The AppError a promise rejects with. */
async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("a valid secret key", () => {
  it("is accepted: the key's id, tenant, kind, environment and scopes, looked up by its 14-character prefix [OBE-011 AC2]", async () => {
    const key = newApiKey("sk", "test");
    const row = rowOf(key, { scopes: ["console"] });
    const { verifier, lookup } = harness(row);

    const verified = await verifier.verify(key);

    expect(verified).toEqual({
      id: row.id,
      tenantId: TENANT_ID,
      kind: "secret",
      environment: "test",
      scopes: ["console"],
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(key.slice(0, 14));
  });

  it("is accepted until the instant it expires", async () => {
    const key = newApiKey();
    const { verifier, clock } = harness(rowOf(key, { expiresAt: "2026-10-15T09:00:01.000Z" }));

    await expect(verifier.verify(key)).resolves.toMatchObject({ kind: "secret" });
    clock.advance(1_000);
    expect((await refusal(verifier.verify(key))).code).toBe("INVALID_API_KEY");
  });
});

describe("refused keys", () => {
  it("refuses the same key revoked, expired or with a one-character change with 401 INVALID_API_KEY [OBE-011 AC2]", async () => {
    const key = newApiKey();
    const revoked = harness(rowOf(key, { revokedAt: "2026-10-15T08:59:59.000Z" }));
    const expired = harness(rowOf(key, { expiresAt: "2026-10-15T08:00:00.000Z" }));
    const valid = harness(rowOf(key));

    for (const [verifier, presented] of [
      [revoked.verifier, key],
      [expired.verifier, key],
      // In the secret part after the prefix: the row is found, the HMAC differs.
      [valid.verifier, withCharacterChanged(key, key.length - 1)],
      [valid.verifier, withCharacterChanged(key, 20)],
      // In the prefix: no row has it.
      [valid.verifier, withCharacterChanged(key, 10)],
    ] as const) {
      const error = await refusal(verifier.verify(presented));

      expect([error.code, error.status]).toEqual(["INVALID_API_KEY", 401]);
    }
    expect(revoked.logs).toContainEqual([
      "info",
      { reason: "revoked", keyId: expect.any(String) },
      "caller.api_key_refused",
    ]);
    expect(expired.logs).toContainEqual([
      "info",
      { reason: "expired", keyId: expect.any(String) },
      "caller.api_key_refused",
    ]);
    expect(valid.logs.map(([, fields]) => fields)).toEqual([
      { reason: "hash_mismatch" },
      { reason: "hash_mismatch" },
      { reason: "unknown" },
    ]);
  });

  it("checks the hash before the state of the row: a wrong key never learns that a key is revoked", async () => {
    const key = newApiKey();
    const { verifier, logs } = harness(rowOf(key, { revokedAt: "2026-10-15T08:00:00.000Z" }));

    await refusal(verifier.verify(withCharacterChanged(key, 30)));

    expect(logs).toEqual([["info", { reason: "hash_mismatch" }, "caller.api_key_refused"]]);
  });

  it("refuses a value that is not a pk_ or sk_ key of 40 base62 characters without a lookup", async () => {
    const { verifier, lookup } = harness();
    const key = newApiKey();

    for (const value of [
      "",
      `hk_test_${key.slice(8)}`,
      `sk_prod_${key.slice(8)}`,
      key.slice(0, -1),
      `${key}x`,
      `${key.slice(0, -1)}-`,
      ` ${key}`,
      "sk_dev_ota_admin_service_key_change_me",
    ]) {
      expect((await refusal(verifier.verify(value))).code).toBe("INVALID_API_KEY");
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(API_KEY_PATTERN.test(key)).toBe(true);
  });

  it("refuses a row whose kind, environment or tenant does not fit the key", async () => {
    const key = newApiKey("sk", "live");
    for (const overrides of [
      { kind: "publishable" },
      { kind: "hosting" },
      { environment: "test" },
      { tenantId: null },
    ] as const) {
      const { verifier, logs } = harness(rowOf(key, overrides));

      expect((await refusal(verifier.verify(key))).code).toBe("INVALID_API_KEY");
      expect(logs[0]?.[1]).toMatchObject({ reason: "row_mismatch" });
    }
  });

  it("refuses a key whose scopes break the rules, and accepts the documented combinations", async () => {
    const accepted = [
      [],
      ["storefront"],
      ["console"],
      ["console:automation", "bookings:read", "queues:read"],
    ];
    const refused = [
      ["storefront", "console"],
      ["bookings:read"],
      ["console", "bookings:issue"],
      ["console:automation"],
      ["console", "admin"],
    ];
    for (const scopes of accepted) {
      const key = newApiKey("sk");
      await expect(harness(rowOf(key, { scopes })).verifier.verify(key)).resolves.toMatchObject({ scopes });
    }
    for (const scopes of refused) {
      const key = newApiKey("sk");
      const { verifier, logs } = harness(rowOf(key, { scopes }));

      expect([scopes, (await refusal(verifier.verify(key))).code]).toEqual([scopes, "INVALID_API_KEY"]);
      expect(logs[0]?.[1]).toMatchObject({ reason: "invalid_scopes" });
    }
    expect(scopeProblem("publishable", [])).toBeUndefined();
    expect(scopeProblem("publishable", ["storefront"])).toBeUndefined();
    expect(scopeProblem("publishable", ["console"])).toBe("a publishable key has customer scope only");
  });

  it("answers 503 SERVICE_UNAVAILABLE when the platform lookup fails, and lets an unreadable row fail as itself", async () => {
    const key = newApiKey();
    const { verifier, lookup } = harness();
    const outage = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    lookup.mockRejectedValueOnce(outage);

    const error = await refusal(verifier.verify(key));

    expect([error.code, error.status, error.cause]).toEqual(["SERVICE_UNAVAILABLE", 503, outage]);
    const unreadable = new UnexpectedPlatformValueError("platform.api_keys.kind", "key_x", "other", [
      "secret",
    ]);
    lookup.mockRejectedValueOnce(unreadable);
    await expect(verifier.verify(key)).rejects.toBe(unreadable);
  });

  it("never logs the key", async () => {
    const key = newApiKey();
    const { verifier, logs } = harness(rowOf(key, { revokedAt: NOW }));

    await refusal(verifier.verify(key));
    await refusal(verifier.verify(withCharacterChanged(key, 39)));
    await refusal(verifier.verify(`${key}!`));

    expect(JSON.stringify(logs)).not.toContain(key.slice(14));
    expect(JSON.stringify(logs)).not.toContain(key.slice(0, 14));
  });
});

describe("publishable keys and origins", () => {
  const ORIGINS = ["https://travel.example.net", "http://localhost:5173"];

  it("refuses a pk_ key from an origin it does not list with 403 ORIGIN_NOT_ALLOWED [OBE-011 AC2]", async () => {
    const key = newApiKey("pk");
    const { verifier, logs } = harness(rowOf(key, { allowedOrigins: ORIGINS }));

    for (const origin of [
      "https://evil.example.com",
      "https://travel.example.net:8443",
      "null",
      "https://travel.example.net/",
    ]) {
      const error = await refusal(verifier.verify(key, { origin }));

      expect([origin, error.code, error.status]).toEqual([origin, "ORIGIN_NOT_ALLOWED", 403]);
    }
    expect(logs.every(([, fields]) => (fields as { reason: string }).reason === "origin_not_allowed")).toBe(
      true,
    );
  });

  it("accepts a pk_ key from a listed origin (case-insensitive) and from a caller that sends no Origin", async () => {
    const key = newApiKey("pk");
    const { verifier } = harness(rowOf(key, { allowedOrigins: ORIGINS }));

    for (const origin of [
      "https://travel.example.net",
      "HTTPS://Travel.Example.NET",
      "http://localhost:5173",
      undefined,
    ]) {
      await expect(verifier.verify(key, { origin })).resolves.toMatchObject({ kind: "publishable" });
    }
  });

  it("accepts no browser origin for a pk_ key with an empty list, and ignores Origin for sk_ keys", async () => {
    const publishable = newApiKey("pk");
    const secret = newApiKey("sk");
    const { verifier } = harness(rowOf(publishable), rowOf(secret));

    expect((await refusal(verifier.verify(publishable, { origin: "https://travel.example.net" }))).code).toBe(
      "ORIGIN_NOT_ALLOWED",
    );
    await expect(verifier.verify(secret, { origin: "https://travel.example.net" })).resolves.toMatchObject({
      kind: "secret",
    });
  });

  it("refuses a pk_ key with console scopes", async () => {
    const key = newApiKey("pk");
    const { verifier } = harness(rowOf(key, { scopes: ["console"] }));

    expect((await refusal(verifier.verify(key))).code).toBe("INVALID_API_KEY");
  });
});

describe("the scope lists", () => {
  // Parsing and compiling the OTA document is the expensive part: it happens once, in this hook
  // (test/helpers/openapi.ts).
  beforeAll(preloadOpenApiDocument, OPENAPI_SETUP_TIMEOUT_MS);

  it("are the enums of ConsoleApiKeyScope and StaffPermission in the OTA document", () => {
    const document = loadOpenApiDocument();
    const enumOf = (name: string): unknown =>
      (document.resolve({ $ref: `#/components/schemas/${name}` }) as { enum?: unknown }).enum;

    expect([...CONSOLE_API_KEY_SCOPES]).toEqual(enumOf("ConsoleApiKeyScope"));
    expect([...STAFF_PERMISSIONS]).toEqual(enumOf("StaffPermission"));
  });
});
