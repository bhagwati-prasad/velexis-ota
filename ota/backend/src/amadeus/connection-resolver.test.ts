// ConnectionResolver against a fake platform cache and repository (OBE-017; OADR-0001 point 4, flows/amadeus-
// connection-and-tokens.md §2): which credential set, base URL and offices serve a tenant, and every way a connection
// is refused with 424. The resolver against PostgreSQL, Redis and the stub is test/integration/amadeus/
// resolver.int.test.ts.
import type { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import { describe, expect, it, vi } from "vitest";
import { newId } from "../common/ids";
import type { ApiConfig } from "../config";
import type { CacheParser, PlatformCache } from "../tenancy/platform-cache";
import type {
  AmadeusEnvironment,
  PlatformAmadeusAccount,
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
} from "./connection-resolver";

const OFFICE = "NCE1A0955";
const OTHER_OFFICE = "PAR1A0911";
/** An envelope ciphertext as the repository returns it (base64 text); the resolver never decrypts it. */
const CIPHERTEXT = Buffer.from("not a real envelope, never decrypted here").toString("base64");

function account(overrides: Partial<PlatformAmadeusAccount> = {}): PlatformAmadeusAccount {
  return Object.freeze({
    id: newId("ama"),
    environment: "test",
    baseUrl: "https://test.travel.api.amadeus.com",
    clientId: "velexis-test-client",
    clientSecretCiphertext: CIPHERTEXT,
    status: "active",
    ...overrides,
  });
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
      "the OTA's own credentials (OBE-079, M5)",
      {
        connections: [
          connection(tenantId, null, {
            credentialSource: "tenant",
            baseUrl: "https://test.travel.api.amadeus.com",
            clientId: "own-client",
            clientSecretCiphertext: CIPHERTEXT,
          }),
        ],
      },
      "test",
      "tenant_credentials_not_supported",
    ],
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
    const shared = account();
    const row = connection(newId("ten"), shared);

    expect(parseAmadeusAccount(JSON.parse(JSON.stringify(shared)))).toEqual(shared);
    expect(parseAmadeusConnection(JSON.parse(JSON.stringify(row)))).toEqual(row);
    for (const broken of [
      { ...shared, clientSecretCiphertext: "not base64!" },
      { ...shared, clientSecretCiphertext: "" },
      { ...shared, status: "suspended" },
      { ...shared, environment: "staging" },
      { ...shared, baseUrl: null },
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
    ]) {
      expect(parseAmadeusConnection(broken)).toBeUndefined();
    }
  });
});
