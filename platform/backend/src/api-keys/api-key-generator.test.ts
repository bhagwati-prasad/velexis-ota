// The API key generator (PADR-0005 items 1 to 4): the key format and prefix, the HMAC with the pepper, the uniform
// base62 secret, the three tries on a prefix collision, and the initial test keys of provisioning. The repository and
// the audit service are stand-ins: the rows they receive are checked for the key, which must never reach them.
import { createHmac, randomBytes } from "node:crypto";
import { verifyApiKey } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import { describe, expect, it, vi } from "vitest";
import type { PlatformTransaction } from "../audit/audit.repository";
import type { AuditEntry, AuditService } from "../audit/audit.service";
import { IdGenerator } from "../common/ids";
import {
  API_KEY_MAX_TRIES,
  API_KEY_PATTERN,
  API_KEY_PREFIX_LENGTH,
  ApiKeyGenerator,
  apiKeyAuditFacts,
  generateApiKey,
  INITIAL_TEST_KEY_NAMES,
  randomBase62,
  type NewApiKey,
} from "./api-key-generator";
import type { ApiKeyInsert, ApiKeyRecord, ApiKeysRepository } from "./api-keys.repository";

const PEPPER = randomBytes(32);
const TENANT_ID = "ten_01JATESTRW0000000000000001";
const ACCOUNT_ID = "acc_01JATESTRW0000000000000001";
const TRX = {} as PlatformTransaction;
const BASE62 = /^[0-9A-Za-z]+$/;

/** The row PostgreSQL would return for an insert. */
function stored(row: ApiKeyInsert): ApiKeyRecord {
  return {
    ...row,
    owner_account_id: null,
    revoked_by_account_id: null,
    last_used_at: null,
    last_used_ip: null,
    revoked_at: null,
  };
}

/** A generator over a repository whose `insertIfNew` answers `outcomes` in turn (`true`: inserted). */
function generatorWith(outcomes: readonly boolean[]) {
  const inserts: ApiKeyInsert[] = [];
  const audits: AuditEntry[] = [];
  let call = 0;
  const repository = {
    insertIfNew: vi.fn((_trx: PlatformTransaction, row: ApiKeyInsert) => {
      inserts.push(row);
      const inserted = outcomes[Math.min(call, outcomes.length - 1)] ?? true;
      call += 1;
      return Promise.resolve(inserted ? stored(row) : undefined);
    }),
  } as unknown as ApiKeysRepository;
  const audit = {
    record: vi.fn((_trx: PlatformTransaction, entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve({});
    }),
  } as unknown as AuditService;
  const clock = new FakeClock();
  const generator = new ApiKeyGenerator(repository, new IdGenerator(clock), clock, audit, PEPPER);
  return { generator, inserts, audits };
}

const NEW_KEY: NewApiKey = {
  tenantId: TENANT_ID,
  name: "Storefront production",
  kind: "secret",
  environment: "test",
  allowedOrigins: [],
  scopes: ["storefront"],
  expiresAt: null,
  createdByAccountId: ACCOUNT_ID,
};

describe("generateApiKey", () => {
  it.each([
    ["publishable", "test", "pk_test_"],
    ["publishable", "live", "pk_live_"],
    ["secret", "test", "sk_test_"],
    ["secret", "live", "sk_live_"],
  ] as const)(
    "[PBE-021 AC1] makes a %s %s key <kind>_<env>_ + 40 base62, its 14-character prefix, last4 and HMAC",
    (kind, environment, start) => {
      const generated = generateApiKey(kind, environment, PEPPER);

      expect(generated.key).toMatch(API_KEY_PATTERN);
      expect(generated.key.startsWith(start)).toBe(true);
      expect(generated.key).toHaveLength(start.length + 40);
      expect(generated.prefix).toBe(generated.key.slice(0, API_KEY_PREFIX_LENGTH));
      expect(generated.prefix).toMatch(/^(pk|sk)_(test|live)_[A-Za-z0-9]{6}$/);
      expect(generated.last4).toBe(generated.key.slice(-4));
      expect(generated.keyHash).toBe(createHmac("sha256", PEPPER).update(generated.key).digest("hex"));
      expect(generated.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyApiKey(generated.key, PEPPER, generated.keyHash)).toBe(true);
    },
  );

  it("hashes with the pepper: another pepper gives another hash, and the hash never contains the key", () => {
    const generated = generateApiKey("secret", "test", PEPPER);

    expect(verifyApiKey(generated.key, randomBytes(32), generated.keyHash)).toBe(false);
    expect(generated.keyHash).not.toContain(generated.key.slice(8));
  });

  it("never makes the same key twice in 2,000 tries", () => {
    const keys = new Set(Array.from({ length: 2000 }, () => generateApiKey("secret", "test", PEPPER).key));

    expect(keys.size).toBe(2000);
  });
});

describe("randomBase62", () => {
  it("draws every one of the 62 characters about equally often (rejection sampling, no modulo bias)", () => {
    const text = randomBase62(62_000);
    const counts = new Map<string, number>();
    for (const character of text) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }

    expect(text).toMatch(BASE62);
    expect(counts.size).toBe(62);
    // 1,000 expected per character, standard deviation about 31: the bounds are more than 9 deviations away.
    for (const [character, count] of counts) {
      expect(count, character).toBeGreaterThan(700);
      expect(count, character).toBeLessThan(1300);
    }
  });

  it("refuses a length that is not a positive integer", () => {
    for (const length of [0, -1, 1.5, Number.NaN]) {
      expect(() => randomBase62(length)).toThrow(RangeError);
    }
  });
});

describe("ApiKeyGenerator.issue", () => {
  it("[PBE-021 AC1] stores the prefix, last4 and HMAC of the key it returns, never the key", async () => {
    const { generator, inserts } = generatorWith([true]);

    const issued = await generator.issue(TRX, NEW_KEY);

    expect(inserts).toHaveLength(1);
    const row = inserts[0];
    expect(row).toMatchObject({
      tenant_id: TENANT_ID,
      name: "Storefront production",
      kind: "secret",
      environment: "test",
      prefix: issued.key.slice(0, 14),
      last4: issued.key.slice(-4),
      key_hash: createHmac("sha256", PEPPER).update(issued.key).digest("hex"),
      allowed_origins: [],
      scopes: ["storefront"],
      expires_at: null,
      created_by_account_id: ACCOUNT_ID,
      created_at: new Date("2026-01-15T10:00:00Z"),
      updated_at: new Date("2026-01-15T10:00:00Z"),
    });
    expect(row?.id).toMatch(/^key_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(JSON.stringify(row)).not.toContain(issued.key);
    expect(issued.row.id).toBe(row?.id);
  });

  it("makes a new key when the prefix exists, and succeeds on the third try", async () => {
    const { generator, inserts } = generatorWith([false, false, true]);

    const issued = await generator.issue(TRX, NEW_KEY);

    expect(inserts).toHaveLength(3);
    expect(new Set(inserts.map((row) => row.prefix)).size).toBe(3);
    expect(new Set(inserts.map((row) => row.id)).size).toBe(3);
    expect(issued.row.prefix).toBe(inserts[2]?.prefix);
  });

  it(`fails with INTERNAL_ERROR after ${API_KEY_MAX_TRIES} collisions`, async () => {
    const { generator, inserts } = generatorWith([false]);

    const error = await generator.issue(TRX, NEW_KEY).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("INTERNAL_ERROR");
    expect(inserts).toHaveLength(API_KEY_MAX_TRIES);
  });
});

describe("ApiKeyGenerator.issueInitialTestKeys", () => {
  it("issues pk_test without origins and sk_test scoped storefront, created by nobody, audited by the system", async () => {
    const { generator, inserts, audits } = generatorWith([true]);

    const keys = await generator.issueInitialTestKeys(TRX, TENANT_ID);

    expect(keys.publishable.key).toMatch(/^pk_test_[A-Za-z0-9]{40}$/);
    expect(keys.secret.key).toMatch(/^sk_test_[A-Za-z0-9]{40}$/);
    expect(
      inserts.map(({ name, kind, environment, allowed_origins, scopes, created_by_account_id }) => ({
        name,
        kind,
        environment,
        allowed_origins,
        scopes,
        created_by_account_id,
      })),
    ).toEqual([
      {
        name: INITIAL_TEST_KEY_NAMES.publishable,
        kind: "publishable",
        environment: "test",
        allowed_origins: [],
        scopes: [],
        created_by_account_id: null,
      },
      {
        name: INITIAL_TEST_KEY_NAMES.secret,
        kind: "secret",
        environment: "test",
        allowed_origins: [],
        scopes: ["storefront"],
        created_by_account_id: null,
      },
    ]);
    expect(audits).toEqual([
      expect.objectContaining({
        actorType: "system",
        action: "api_key.created",
        targetType: "api_key",
        targetId: keys.publishable.row.id,
        tenantId: TENANT_ID,
        details: apiKeyAuditFacts(keys.publishable.row),
      }),
      expect.objectContaining({
        actorType: "system",
        action: "api_key.created",
        targetId: keys.secret.row.id,
        details: {
          prefix: keys.secret.row.prefix,
          kind: "secret",
          environment: "test",
          scopes: ["storefront"],
        },
      }),
    ]);
    const written = JSON.stringify({ inserts, audits });
    expect(written).not.toContain(keys.publishable.key);
    expect(written).not.toContain(keys.secret.key);
  });
});
