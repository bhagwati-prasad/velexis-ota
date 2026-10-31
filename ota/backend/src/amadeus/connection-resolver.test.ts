// ConnectionResolver against a fake platform cache and repository (OBE-017, OBE-079; OADR-0001 point 4, flows/amadeus-
// connection-and-tokens.md §2): which credential set, base URL and offices serve a tenant (on the Velexis shared
// account or with its own credentials), which serve an existing order (the releasing-office rule), and every way a
// connection is refused with 424. The resolver against PostgreSQL, Redis and the stub is test/integration/amadeus/
// resolver.int.test.ts (the shared account) and own-credentials.int.test.ts (own credentials and the rule).
import type { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import { describe, expect, it, vi } from "vitest";
import { newId } from "../common/ids";
import { redisKeys } from "../common/redis/redis.keys";
import type { ApiConfig } from "../config";
import type { CacheParser, PlatformCache } from "../tenancy/platform-cache";
import type {
  AmadeusEnvironment,
  PlatformAmadeusAccount,
  PlatformAmadeusAccountOffice,
  PlatformAmadeusConnection,
  PlatformReadRepository,
} from "../tenancy/platform-read.repository";
import {
  AMADEUS_OFFICIAL_BASE_URLS,
  AmadeusConnectionUnusableError,
  ConnectionResolver,
  parseAmadeusAccount,
  parseAmadeusConnection,
  type ConnectionUnusableReason,
  type ResolvedAmadeusConnection,
} from "./connection-resolver";

const OFFICE = "NCE1A0955";
const OTHER_OFFICE = "PAR1A0911";
/** Offices of the OTA's own Amadeus account (never offices of the Velexis pool). */
const OWN_OFFICE = "LON1A2208";
const OWN_OTHER_OFFICE = "LON1A2209";
/** An envelope ciphertext as the repository returns it (base64 text); the resolver never decrypts it. */
const CIPHERTEXT = Buffer.from("not a real envelope, never decrypted here").toString("base64");
/** The OTA's own client secret's ciphertext, as the platform re-encrypted it for the connection's row. */
const OWN_CIPHERTEXT = Buffer.from("the OTA's own envelope, never decrypted here").toString("base64");

function account(overrides: Partial<PlatformAmadeusAccount> = {}): PlatformAmadeusAccount {
  return Object.freeze({
    id: newId("ama"),
    environment: "test",
    baseUrl: "https://test.travel.api.amadeus.com",
    clientId: "velexis-test-client",
    clientSecretCiphertext: CIPHERTEXT,
    status: "active",
    offices: [],
    ...overrides,
  });
}

/** An office of the shared account's pool that serves `tenantId`. */
function serving(
  officeId: string,
  tenantId: string,
  status: PlatformAmadeusAccountOffice["status"] = "releasing",
): PlatformAmadeusAccountOffice {
  return Object.freeze({ officeId, tenantId, status });
}

function connection(
  tenantId: string,
  shared: PlatformAmadeusAccount | null,
  overrides: Partial<PlatformAmadeusConnection> = {},
): PlatformAmadeusConnection {
  return Object.freeze({
    id: newId("sc"),
    tenantId,
    environment: shared?.environment ?? "test",
    credentialSource: "velexis",
    amadeusAccountId: shared?.id ?? null,
    velexisAccountId: shared?.id ?? null,
    baseUrl: null,
    clientId: null,
    clientSecretCiphertext: null,
    officeIds: [OFFICE],
    defaultOfficeId: OFFICE,
    queuingOfficeId: OFFICE,
    ownerOfficeId: OFFICE,
    status: "active",
    ...overrides,
  });
}

/**
 * A connection switched to the OTA's own credentials as the platform applies them (PBE-053): `tenant`, no account,
 * the OTA's host, client id, re-encrypted secret and offices; `velexisAccountId` names the shared account of the
 * environment (`shared`), whose offices may still serve its old orders.
 */
function ownConnection(
  tenantId: string,
  shared: PlatformAmadeusAccount | null,
  overrides: Partial<PlatformAmadeusConnection> = {},
): PlatformAmadeusConnection {
  return connection(tenantId, shared, {
    credentialSource: "tenant",
    amadeusAccountId: null,
    baseUrl: "https://own.amadeus.example.net",
    clientId: "own-client-id",
    clientSecretCiphertext: OWN_CIPHERTEXT,
    officeIds: [OWN_OFFICE, OWN_OTHER_OFFICE],
    defaultOfficeId: OWN_OFFICE,
    queuingOfficeId: OWN_OFFICE,
    ownerOfficeId: OWN_OFFICE,
    ...overrides,
  });
}

interface World {
  readonly connections?: readonly PlatformAmadeusConnection[];
  readonly accounts?: readonly PlatformAmadeusAccount[];
  readonly overrides?: Partial<Record<"AMADEUS_BASE_URL_TEST" | "AMADEUS_BASE_URL_LIVE", string>>;
}

/**
 * A resolver over a repository that knows `world` and a cache that loads through it and round-trips every value
 * through JSON and the resolver's parser, as Redis would.
 */
function harness(world: World) {
  const platform = {
    amadeusConnection: vi.fn((tenantId: string, environment: AmadeusEnvironment) =>
      Promise.resolve(
        world.connections?.find((row) => row.tenantId === tenantId && row.environment === environment) ??
          null,
      ),
    ),
    amadeusAccountById: vi.fn((id: string) =>
      Promise.resolve(world.accounts?.find((row) => row.id === id) ?? null),
    ),
  };
  const throughJson = async <T>(load: () => Promise<T | null>, parse: CacheParser<T>): Promise<T | null> => {
    const value = await load();
    if (value === null) {
      return null;
    }
    const parsed = parse(JSON.parse(JSON.stringify(value)));
    expect(parsed).toEqual(value);
    return parsed ?? null;
  };
  const cache = {
    connection: vi.fn(
      <T>(
        _kind: string,
        _tenantId: string,
        _env: string,
        load: () => Promise<T | null>,
        parse: CacheParser<T>,
      ) => throughJson(load, parse),
    ),
    amadeusAccount: vi.fn(<T>(_id: string, load: () => Promise<T | null>, parse: CacheParser<T>) =>
      throughJson(load, parse),
    ),
  };
  const config = {
    get: (name: keyof NonNullable<World["overrides"]>) => world.overrides?.[name],
  } as unknown as ConfigService<ApiConfig, true>;
  const resolver = new ConnectionResolver(
    cache as unknown as PlatformCache,
    platform as unknown as PlatformReadRepository,
    config,
  );
  return { resolver, cache, platform };
}

/** The 424 a resolution rejects with, as `[status, code, reason]`. */
async function refusal(
  promise: Promise<unknown>,
): Promise<[number, string, ConnectionUnusableReason | undefined]> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  const { status, code, cause } = error as AppError;
  expect(cause).toBeInstanceOf(AmadeusConnectionUnusableError);
  return [status, code, (cause as AmadeusConnectionUnusableError).reason];
}

describe("a connection on the Velexis shared account", () => {
  it("resolves to the account's credentials, the connection's offices and the account's base URL", async () => {
    const tenantId = newId("ten");
    const shared = account();
    const row = connection(tenantId, shared);
    const { resolver, cache, platform } = harness({ connections: [row], accounts: [shared] });

    const resolved = await resolver.resolve(tenantId, "test");

    expect(resolved).toEqual({
      tenantId,
      environment: "test",
      connectionId: row.id,
      credentialSource: "velexis",
      credId: shared.id,
      clientId: "velexis-test-client",
      encryptedSecret: {
        ciphertext: CIPHERTEXT,
        aad: `platform.amadeus_accounts.client_secret_ciphertext:${shared.id}`,
      },
      baseUrl: "https://test.travel.api.amadeus.com",
      offices: { queuing: OFFICE, owner: OFFICE, queue: OFFICE, retrieval: OFFICE },
      officeIds: [OFFICE],
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    // Through the platform caches of OBE-012: conn:amadeus:<tenantId>:test, then amadeus:acct:<id>.
    expect(cache.connection).toHaveBeenCalledWith(
      "amadeus",
      tenantId,
      "test",
      expect.any(Function),
      parseAmadeusConnection,
    );
    expect(cache.amadeusAccount).toHaveBeenCalledWith(shared.id, expect.any(Function), parseAmadeusAccount);
    expect(platform.amadeusConnection).toHaveBeenCalledWith(tenantId, "test");
  });

  it("shares one credential set between every tenant on the account", async () => {
    const shared = account();
    const [first, second] = [newId("ten"), newId("ten")];
    const { resolver } = harness({
      connections: [
        connection(first, shared),
        connection(second, shared, {
          officeIds: [OTHER_OFFICE],
          defaultOfficeId: OTHER_OFFICE,
          queuingOfficeId: OTHER_OFFICE,
          ownerOfficeId: OTHER_OFFICE,
        }),
      ],
      accounts: [shared],
    });

    const [a, b] = await Promise.all([resolver.resolve(first, "test"), resolver.resolve(second, "test")]);

    expect([a.credId, b.credId]).toEqual([shared.id, shared.id]);
    expect(a.connectionId).not.toBe(b.connectionId);
    expect([a.officeIds, b.officeIds]).toEqual([[OFFICE], [OTHER_OFFICE]]);
    expect([a.offices.queuing, b.offices.queuing]).toEqual([OFFICE, OTHER_OFFICE]);
  });

  it("uses AMADEUS_BASE_URL_<ENV> over the row, and the official host when the row has none", async () => {
    const tenantId = newId("ten");
    const testAccount = account({ baseUrl: "https://test.travel.api.amadeus.com/" });
    const liveAccount = account({ environment: "live", baseUrl: "" });
    const rows = [connection(tenantId, testAccount), connection(tenantId, liveAccount)];
    const world = { connections: rows, accounts: [testAccount, liveAccount] };

    const plain = harness(world).resolver;
    const stubbed = harness({
      ...world,
      overrides: { AMADEUS_BASE_URL_TEST: "http://127.0.0.1:4900" },
    }).resolver;

    expect((await plain.resolve(tenantId, "test")).baseUrl).toBe("https://test.travel.api.amadeus.com");
    expect((await plain.resolve(tenantId, "live")).baseUrl).toBe(AMADEUS_OFFICIAL_BASE_URLS.live);
    expect((await stubbed.resolve(tenantId, "test")).baseUrl).toBe("http://127.0.0.1:4900");
    expect((await stubbed.resolve(tenantId, "live")).baseUrl).toBe("https://travel.api.amadeus.com");
  });

  it("falls back to the default office, then the queuing office, where the connection names none", async () => {
    const tenantId = newId("ten");
    const shared = account();
    const sparse = harness({
      connections: [
        connection(tenantId, shared, {
          officeIds: [OFFICE, OTHER_OFFICE],
          defaultOfficeId: null,
          queuingOfficeId: OFFICE,
          ownerOfficeId: OTHER_OFFICE,
        }),
      ],
      accounts: [shared],
    });
    const defaults = harness({
      connections: [connection(tenantId, shared, { queuingOfficeId: null, ownerOfficeId: null })],
      accounts: [shared],
    });

    expect((await sparse.resolver.resolve(tenantId, "test")).offices).toEqual({
      queuing: OFFICE,
      owner: OTHER_OFFICE,
      queue: OFFICE,
      retrieval: OFFICE,
    });
    expect((await defaults.resolver.resolve(tenantId, "test")).offices).toEqual({
      queuing: OFFICE,
      owner: OFFICE,
      queue: OFFICE,
      retrieval: OFFICE,
    });
  });

  it("never uses an office outside the connection's office_ids, which may be another OTA's on the account", async () => {
    const tenantId = newId("ten");
    const shared = account();
    const { resolver } = harness({
      connections: [
        connection(tenantId, shared, {
          officeIds: [OFFICE],
          defaultOfficeId: OFFICE,
          queuingOfficeId: OTHER_OFFICE,
          ownerOfficeId: OTHER_OFFICE,
        }),
      ],
      accounts: [shared],
    });

    const resolved = await resolver.resolve(tenantId, "test");

    expect(resolved.offices).toEqual({ queuing: OFFICE, owner: OFFICE, queue: OFFICE, retrieval: OFFICE });
    expect(resolved.officeIds).toEqual([OFFICE]);
  });
});

describe("a connection with the OTA's own credentials (OBE-079)", () => {
  it("resolves to the connection's client id, secret, base URL and offices, keyed by the connection [OBE-079 AC1]", async () => {
    const tenantId = newId("ten");
    const shared = account({ offices: [serving(OFFICE, tenantId)] });
    const row = ownConnection(tenantId, shared);
    const { resolver, cache } = harness({ connections: [row], accounts: [shared] });

    const resolved = await resolver.resolve(tenantId, "test");

    expect(resolved).toEqual({
      tenantId,
      environment: "test",
      connectionId: row.id,
      credentialSource: "tenant",
      credId: row.id,
      clientId: "own-client-id",
      encryptedSecret: {
        ciphertext: OWN_CIPHERTEXT,
        aad: `platform.supplier_connections.client_secret_ciphertext:${row.id}`,
      },
      baseUrl: "https://own.amadeus.example.net",
      offices: { queuing: OWN_OFFICE, owner: OWN_OFFICE, queue: OWN_OFFICE, retrieval: OWN_OFFICE },
      officeIds: [OWN_OFFICE, OWN_OTHER_OFFICE],
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    // A new search needs nothing of the Velexis account.
    expect(cache.amadeusAccount).not.toHaveBeenCalled();
  });

  it("keys the token by the new credential id, so the shared account's token is never reused after a switch [OBE-079 AC1]", async () => {
    const tenantId = newId("ten");
    const shared = account();
    const before = connection(tenantId, shared);
    const after = ownConnection(tenantId, shared, { id: before.id });

    const velexis = await harness({ connections: [before], accounts: [shared] }).resolver.resolve(
      tenantId,
      "test",
    );
    const own = await harness({ connections: [after], accounts: [shared] }).resolver.resolve(
      tenantId,
      "test",
    );

    expect([velexis.credId, own.credId]).toEqual([shared.id, before.id]);
    expect(redisKeys.amadeusToken(own.credId, "test").key).not.toBe(
      redisKeys.amadeusToken(velexis.credId, "test").key,
    );
    expect(redisKeys.amadeusBadCredentials(own.credId).key).not.toBe(
      redisKeys.amadeusBadCredentials(velexis.credId).key,
    );
    expect(own.encryptedSecret.aad).not.toBe(velexis.encryptedSecret.aad);
  });

  it("uses AMADEUS_BASE_URL_<ENV> over the connection's base_url, and the official host when it has none", async () => {
    const tenantId = newId("ten");
    const rows = [
      ownConnection(tenantId, null, { baseUrl: "https://own.amadeus.example.net/" }),
      ownConnection(tenantId, null, { environment: "live", baseUrl: "" }),
    ];

    const plain = harness({ connections: rows }).resolver;
    const stubbed = harness({
      connections: rows,
      overrides: { AMADEUS_BASE_URL_TEST: "http://127.0.0.1:4900" },
    }).resolver;

    expect((await plain.resolve(tenantId, "test")).baseUrl).toBe("https://own.amadeus.example.net");
    expect((await plain.resolve(tenantId, "live")).baseUrl).toBe(AMADEUS_OFFICIAL_BASE_URLS.live);
    expect((await stubbed.resolve(tenantId, "test")).baseUrl).toBe("http://127.0.0.1:4900");
  });

  const tenantId = newId("ten");
  const OWN_CASES: ReadonlyArray<[string, PlatformAmadeusConnection, ConnectionUnusableReason]> = [
    ...(["pending_verification", "invalid_credentials", "disabled"] as const).map(
      (status): [string, PlatformAmadeusConnection, ConnectionUnusableReason] => [
        `a connection in status ${status}`,
        ownConnection(tenantId, null, { status }),
        "connection_not_active",
      ],
    ),
    ["no client id", ownConnection(tenantId, null, { clientId: null }), "no_tenant_credentials"],
    [
      "no client secret",
      ownConnection(tenantId, null, { clientSecretCiphertext: null }),
      "no_tenant_credentials",
    ],
    [
      "offices outside its office_ids only",
      ownConnection(tenantId, null, { officeIds: [OTHER_OFFICE] }),
      "no_office",
    ],
  ];

  it.each(OWN_CASES)("answers 424 SUPPLIER_NOT_CONFIGURED for %s", async (_case, row, reason) => {
    const { resolver } = harness({ connections: [row] });

    expect(await refusal(resolver.resolve(tenantId, "test"))).toEqual([
      424,
      "SUPPLIER_NOT_CONFIGURED",
      reason,
    ]);
  });
});

describe("an existing order (the releasing-office rule, OBE-079)", () => {
  /** The Velexis-served resolution of `office` for `row` on `shared`. */
  const servedByVelexis = (
    row: PlatformAmadeusConnection,
    shared: PlatformAmadeusAccount,
    office: string,
  ): ResolvedAmadeusConnection => ({
    tenantId: row.tenantId,
    environment: "test",
    connectionId: row.id,
    credentialSource: "velexis",
    credId: shared.id,
    clientId: "velexis-test-client",
    encryptedSecret: {
      ciphertext: CIPHERTEXT,
      aad: `platform.amadeus_accounts.client_secret_ciphertext:${shared.id}`,
    },
    baseUrl: "https://test.travel.api.amadeus.com",
    offices: { queuing: office, owner: office, queue: office, retrieval: office },
    officeIds: [office],
  });

  it.each(["releasing", "assigned"] as const)(
    "is served by the Velexis account with its office alone while that office is %s for the tenant [OBE-079 AC1]",
    async (status) => {
      const tenantId = newId("ten");
      const shared = account({ offices: [serving(OFFICE, tenantId, status)] });
      const row = ownConnection(tenantId, shared);
      const { resolver, cache } = harness({ connections: [row], accounts: [shared] });

      const order = await resolver.resolve(tenantId, "test", OFFICE);
      const search = await resolver.resolve(tenantId, "test");

      expect(order).toEqual(servedByVelexis(row, shared, OFFICE));
      expect(Object.isFrozen(order) && Object.isFrozen(order.officeIds)).toBe(true);
      expect(cache.amadeusAccount).toHaveBeenCalledWith(shared.id, expect.any(Function), parseAmadeusAccount);
      // Everything new uses the OTA's own credentials.
      expect(search).toMatchObject({
        credentialSource: "tenant",
        credId: row.id,
        officeIds: [OWN_OFFICE, OWN_OTHER_OFFICE],
      });
    },
  );

  it("is served by the OTA's own credentials once the office is available again (released) [OBE-079 AC2]", async () => {
    const tenantId = newId("ten");
    const released = account({ offices: [] });
    const row = ownConnection(tenantId, released);
    const { resolver } = harness({ connections: [row], accounts: [released] });

    const resolved = await resolver.resolve(tenantId, "test", OFFICE);

    // The client then refuses the office, which is not the OTA's own, with 403 OFFICE_NOT_ALLOWED.
    expect(resolved).toMatchObject({ credentialSource: "tenant", credId: row.id });
    expect(resolved.officeIds).not.toContain(OFFICE);
  });

  it("never routes to an office that serves another tenant: the shared account's other offices are other OTAs' [OBE-079 AC2]", async () => {
    const [tenantId, otherTenant] = [newId("ten"), newId("ten")];
    const shared = account({
      offices: [serving(OFFICE, otherTenant, "assigned"), serving(OTHER_OFFICE, otherTenant, "releasing")],
    });
    const row = ownConnection(tenantId, shared);
    const { resolver } = harness({ connections: [row], accounts: [shared] });

    for (const office of [OFFICE, OTHER_OFFICE]) {
      expect(await resolver.resolve(tenantId, "test", office)).toMatchObject({
        credentialSource: "tenant",
        officeIds: [OWN_OFFICE, OWN_OTHER_OFFICE],
      });
    }
  });

  it("serves the OTA's own offices with its own credentials, and ignores an office that is not an office id", async () => {
    const tenantId = newId("ten");
    const shared = account({ offices: [serving(OFFICE, tenantId)] });
    const row = ownConnection(tenantId, shared);
    const { resolver } = harness({ connections: [row], accounts: [shared] });

    for (const office of [OWN_OTHER_OFFICE, OFFICE.toLowerCase()]) {
      expect(await resolver.resolve(tenantId, "test", office)).toMatchObject({
        credentialSource: "tenant",
        credId: row.id,
      });
    }
  });

  it("keeps the OTA's own credentials when the environment has no Velexis account", async () => {
    const tenantId = newId("ten");
    const row = ownConnection(tenantId, null);
    const { resolver, cache } = harness({ connections: [row] });

    expect(await resolver.resolve(tenantId, "test", OFFICE)).toMatchObject({ credentialSource: "tenant" });
    expect(cache.amadeusAccount).not.toHaveBeenCalled();
  });

  it("serves a velexis connection's own office as the connection does, and another office of the tenant alone", async () => {
    const tenantId = newId("ten");
    // An admin moved the tenant to OFFICE; its old office OTHER_OFFICE is releasing.
    const shared = account({
      offices: [serving(OFFICE, tenantId, "assigned"), serving(OTHER_OFFICE, tenantId)],
    });
    const row = connection(tenantId, shared);
    const { resolver } = harness({ connections: [row], accounts: [shared] });

    expect(await resolver.resolve(tenantId, "test", OFFICE)).toEqual(
      await resolver.resolve(tenantId, "test"),
    );
    expect(await resolver.resolve(tenantId, "test", OTHER_OFFICE)).toEqual(
      servedByVelexis(row, shared, OTHER_OFFICE),
    );
  });

  it("answers 424 when the Velexis account cannot serve the order, and for a connection that is not active", async () => {
    const tenantId = newId("ten");
    const disabledAccount = account({ status: "disabled", offices: [serving(OFFICE, tenantId)] });
    const shared = account({ offices: [serving(OFFICE, tenantId)] });

    expect(
      await refusal(
        harness({
          connections: [ownConnection(tenantId, disabledAccount)],
          accounts: [disabledAccount],
        }).resolver.resolve(tenantId, "test", OFFICE),
      ),
    ).toEqual([424, "SUPPLIER_NOT_CONFIGURED", "amadeus_account_not_active"]);
    // A connection the platform disabled serves nothing, not even an order of a Velexis office (rule 1 first).
    expect(
      await refusal(
        harness({
          connections: [ownConnection(tenantId, shared, { status: "disabled" })],
          accounts: [shared],
        }).resolver.resolve(tenantId, "test", OFFICE),
      ),
    ).toEqual([424, "SUPPLIER_NOT_CONFIGURED", "connection_not_active"]);
  });
});

describe("a connection that cannot serve calls", () => {
  const tenantId = newId("ten");
  const shared = account();
  const live = account({ environment: "live" });

  const CASES: ReadonlyArray<[string, World, AmadeusEnvironment, ConnectionUnusableReason]> = [
    ["no connection row", { accounts: [shared] }, "test", "no_connection"],
    [
      "a row of the other environment only",
      { connections: [connection(tenantId, live)], accounts: [live] },
      "test",
      "no_connection",
    ],
    ...(["pending_verification", "invalid_credentials", "disabled"] as const).map(
      (status): [string, World, AmadeusEnvironment, ConnectionUnusableReason] => [
        `a connection in status ${status}`,
        { connections: [connection(tenantId, shared, { status })], accounts: [shared] },
        "test",
        "connection_not_active",
      ],
    ),
    [
      "a missing shared account",
      { connections: [connection(tenantId, shared)] },
      "test",
      "no_amadeus_account",
    ],
    [
      "a shared account id that is null",
      { connections: [connection(tenantId, shared, { amadeusAccountId: null })], accounts: [shared] },
      "test",
      "no_amadeus_account",
    ],
    ...(["pending_verification", "invalid_credentials", "disabled"] as const).map(
      (status): [string, World, AmadeusEnvironment, ConnectionUnusableReason] => {
        const inactive = account({ status });
        return [
          `a shared account in status ${status}`,
          { connections: [connection(tenantId, inactive)], accounts: [inactive] },
          "test",
          "amadeus_account_not_active",
        ];
      },
    ),
    [
      "a test connection on the live account",
      { connections: [connection(tenantId, live, { environment: "test" })], accounts: [live] },
      "test",
      "amadeus_account_environment",
    ],
    [
      "no office id",
      {
        connections: [
          connection(tenantId, shared, { defaultOfficeId: null, queuingOfficeId: null, ownerOfficeId: null }),
        ],
        accounts: [shared],
      },
      "test",
      "no_office",
    ],
    [
      "offices outside the connection's office_ids only",
      {
        connections: [connection(tenantId, shared, { officeIds: [OTHER_OFFICE] })],
        accounts: [shared],
      },
      "test",
      "no_office",
    ],
    [
      "an office that is not an Amadeus office id",
      {
        connections: [
          connection(tenantId, shared, {
            defaultOfficeId: "nce1a0955",
            queuingOfficeId: null,
            ownerOfficeId: null,
          }),
        ],
        accounts: [shared],
      },
      "test",
      "no_office",
    ],
  ];

  it.each(CASES)(
    "answers 424 SUPPLIER_NOT_CONFIGURED for %s [OBE-017 AC2]",
    async (_case, world, env, reason) => {
      const { resolver } = harness(world);

      expect(await refusal(resolver.resolve(tenantId, env))).toEqual([
        424,
        "SUPPLIER_NOT_CONFIGURED",
        reason,
      ]);
    },
  );

  it("names the tenant and the reason in the cause only: the 424 itself says no more than the catalogue", async () => {
    const { resolver } = harness({ accounts: [shared] });

    const error = await resolver.resolve(tenantId, "test").catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: "SUPPLIER_NOT_CONFIGURED",
      message: "The OTA has no active Amadeus connection for this environment.",
    });
    expect((error as AppError).details).toBeUndefined();
    expect((error as AppError).cause).toMatchObject({
      reason: "no_connection",
      tenantId,
      environment: "test",
    });
  });

  it("lets a failing platform read through as the cache's 503", async () => {
    const { resolver, cache } = harness({});
    cache.connection.mockRejectedValueOnce(new AppError("SERVICE_UNAVAILABLE"));

    await expect(resolver.resolve(tenantId, "test")).rejects.toMatchObject({ status: 503 });
  });
});

describe("the cached rows", () => {
  it("are read back only in the shape the repository returns, with the ciphertext as base64 text", () => {
    const tenantId = newId("ten");
    const shared = account({
      offices: [serving(OFFICE, tenantId, "assigned"), serving(OTHER_OFFICE, tenantId)],
    });
    const row = connection(tenantId, shared);
    const own = ownConnection(tenantId, shared);

    expect(parseAmadeusAccount(JSON.parse(JSON.stringify(shared)))).toEqual(shared);
    expect(parseAmadeusConnection(JSON.parse(JSON.stringify(row)))).toEqual(row);
    expect(parseAmadeusConnection(JSON.parse(JSON.stringify(own)))).toEqual(own);
    const { offices: _offices, ...withoutOffices } = shared;
    const { velexisAccountId: _velexisAccountId, ...withoutVelexisAccount } = own;
    for (const broken of [
      { ...shared, clientSecretCiphertext: "not base64!" },
      { ...shared, clientSecretCiphertext: "" },
      { ...shared, status: "suspended" },
      { ...shared, environment: "staging" },
      { ...shared, baseUrl: null },
      // Entries written before OBE-079, and offices of another shape.
      withoutOffices,
      { ...shared, offices: {} },
      { ...shared, offices: [{ officeId: OFFICE, tenantId, status: "available" }] },
      { ...shared, offices: [{ officeId: "nce1a0955", tenantId, status: "assigned" }] },
      { ...shared, offices: [{ officeId: OFFICE, tenantId: null, status: "releasing" }] },
      { ...shared, offices: [OFFICE] },
      null,
      [],
      "ama_x",
    ]) {
      expect(parseAmadeusAccount(broken)).toBeUndefined();
    }
    for (const broken of [
      { ...row, credentialSource: "platform" },
      { ...row, officeIds: OFFICE },
      { ...row, officeIds: [1] },
      { ...row, clientSecretCiphertext: { type: "Buffer", data: [1, 2, 3] } },
      { ...row, status: undefined },
      { ...row, queuingOfficeId: 9 },
      // An entry written before OBE-079.
      withoutVelexisAccount,
      { ...own, velexisAccountId: 7 },
    ]) {
      expect(parseAmadeusConnection(broken)).toBeUndefined();
    }
  });
});
