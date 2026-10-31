// The OTA helpers of the platform admin journeys (support/tenants.ts, PAD-010) without a stack: `fetch` is a fake
// platform API, and `withDatabase` of support/seed.ts hands over a fake `pg` client that records its queries. The
// journeys run them against the real API and database (specs/admin-*.e2e.ts); these tests pin what they send.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SeedModule from "../support/seed";
import { callPlatformApi, PlatformApiError, uniqueTestIp, type PortalAccount } from "../support/fixtures";
import { buildAccount } from "../support/seed";
import { exampleEnv, PLATFORM_API_URL } from "../support/stack";
import {
  createOtaWithApi,
  otaInput,
  uniqueOtaKey,
  waitForOtaStatus,
  withAvailableOfficesHeld,
  type Ota,
  type SignedInOwner,
} from "../support/tenants";

const { withDatabase } = vi.hoisted(() => ({ withDatabase: vi.fn() }));

vi.mock("../support/seed", async (importOriginal) => {
  const actual = await importOriginal<typeof SeedModule>();
  return { ...actual, withDatabase };
});

interface ApiRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Replaces `fetch` with a fake platform API: `answer` gets each request and returns status and JSON body. */
function fakePlatformApi(answer: (request: ApiRequest) => { status: number; body?: unknown }): ApiRequest[] {
  const requests: ApiRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      const request: ApiRequest = {
        url,
        method: init.method ?? "GET",
        headers: { ...(init.headers as Record<string, string>) },
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      requests.push(request);
      const { status, body } = answer(request);
      return Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));
    }),
  );
  return requests;
}

const path = (request: ApiRequest | undefined): string => request?.url.replace(PLATFORM_API_URL, "") ?? "";

/** `TenantKey` of the platform document. */
const TENANT_KEY = /^[a-z][a-z0-9]{2,29}$/;
/** `Idempotency-Key` of the platform document. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

function owner(): SignedInOwner {
  const account: PortalAccount = { ...buildAccount(), endUserIp: uniqueTestIp() };
  return { account, accessToken: "owner-access-token" };
}

/** A `Tenant` answer of the platform API in `status`. */
function tenant(status: Ota["status"]): Ota {
  return { id: "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F", key: "adm0123456789", status } as Ota;
}

beforeEach(() => {
  // The stack the global setup would have started (support/seed.ts `stack()` reads it in a test worker).
  vi.stubEnv(
    "TEST_DATABASE_ADMIN_URL",
    "postgres://velexis_test_admin:dev_test_admin@127.0.0.1:5432/postgres",
  );
  vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379/0");
  vi.stubEnv("SMTP_URL", "smtp://127.0.0.1:1025");
  vi.stubEnv("MAILPIT_API_URL", "http://127.0.0.1:8025");
  vi.stubEnv("E2E_STRIPE", "false");
  vi.stubEnv("E2E_DATABASE_NAME", "velexis_e2e_unit_000000");
  withDatabase.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("uniqueOtaKey and otaInput", () => {
  it("give every OTA a key of the platform's pattern and a valid request", () => {
    const keys = new Set(Array.from({ length: 200 }, () => uniqueOtaKey()));
    expect(keys.size).toBe(200);
    for (const key of keys) {
      expect(key).toMatch(TENANT_KEY);
    }
    expect(uniqueOtaKey("pool")).toMatch(/^pool[0-9a-f]{10}$/);
    expect(() => uniqueOtaKey("Pool")).toThrow(TypeError);

    const input = otaInput({ name: "Pool Travel" });
    expect(input).toEqual({
      key: expect.stringMatching(TENANT_KEY),
      name: "Pool Travel",
      countryCode: "NO",
      defaultCurrency: "EUR",
      timeZone: "Europe/Oslo",
    });
    expect(otaInput({ key: "acme" }).name).toBe("E2E Travel acme");
  });
});

describe("createOtaWithApi", () => {
  it("creates the OTA as its owner, with a new Idempotency-Key and the PADR-0019 headers", async () => {
    const requests = fakePlatformApi(() => ({
      status: 202,
      body: {
        tenant: tenant("provisioning"),
        provisioningJob: { id: "job_1", status: "queued" },
        checkoutUrl: null,
      },
    }));
    const signedIn = owner();

    expect(await createOtaWithApi(signedIn, { name: "Lifecycle Travel" })).toEqual(tenant("provisioning"));
    await createOtaWithApi(signedIn);

    expect(requests.map((request) => `${request.method} ${path(request)}`)).toEqual([
      "POST /v1/tenants",
      "POST /v1/tenants",
    ]);
    const [first, second] = requests;
    expect(first?.headers).toMatchObject({
      Authorization: "Bearer owner-access-token",
      "X-Velexis-Bff-Key": exampleEnv(["platform/backend/.env.example"])["PLATFORM_BFF_KEY"],
      "X-Velexis-End-User-IP": signedIn.account.endUserIp,
      "Content-Type": "application/json",
    });
    expect(first?.headers["Idempotency-Key"]).toMatch(IDEMPOTENCY_KEY);
    expect(second?.headers["Idempotency-Key"]).not.toBe(first?.headers["Idempotency-Key"]);
    expect(first?.body).toMatchObject({ name: "Lifecycle Travel", key: expect.stringMatching(TENANT_KEY) });
  });

  it("keeps the PADR-0019 headers when a call's own headers name them", async () => {
    const requests = fakePlatformApi(() => ({ status: 200, body: {} }));
    await callPlatformApi({
      operation: "getTenant",
      method: "GET",
      path: "/v1/tenants/ten_1",
      endUserIp: "198.18.0.1",
      headers: { "X-Velexis-End-User-IP": "203.0.113.9", "X-Velexis-Bff-Key": "forged" },
    });
    expect(requests[0]?.headers["X-Velexis-End-User-IP"]).toBe("198.18.0.1");
    expect(requests[0]?.headers["X-Velexis-Bff-Key"]).not.toBe("forged");
  });

  it("fails with the operation, status and code of a refusal", async () => {
    fakePlatformApi(() => ({
      status: 409,
      body: { error: { code: "TENANT_KEY_UNAVAILABLE", message: "taken", status: 409, requestId: "r1" } },
    }));
    const failure = createOtaWithApi(owner());
    await expect(failure).rejects.toBeInstanceOf(PlatformApiError);
    await expect(failure).rejects.toThrow(/^createTenant answered 409 TENANT_KEY_UNAVAILABLE$/);
  });
});

describe("waitForOtaStatus", () => {
  it("asks getTenant as the owner until the OTA has the status", async () => {
    const answers: Ota["status"][] = ["provisioning", "provisioning", "active"];
    const requests = fakePlatformApi(() => ({ status: 200, body: tenant(answers.shift() ?? "active") }));
    const signedIn = owner();

    expect(await waitForOtaStatus(signedIn, "ten_1", "active", { intervalMs: 1 })).toEqual(tenant("active"));
    expect(requests.map((request) => `${request.method} ${path(request)}`)).toEqual([
      "GET /v1/tenants/ten_1",
      "GET /v1/tenants/ten_1",
      "GET /v1/tenants/ten_1",
    ]);
    expect(requests[0]?.headers["Authorization"]).toBe("Bearer owner-access-token");
  });

  it("fails at once when the set-up failed, and after the timeout with the last status", async () => {
    fakePlatformApi(() => ({ status: 200, body: tenant("failed") }));
    await expect(waitForOtaStatus(owner(), "ten_1", "active", { intervalMs: 1 })).rejects.toThrow(
      'the OTA adm0123456789 failed to set up while the journey waited for "active"',
    );

    fakePlatformApi(() => ({ status: 200, body: tenant("provisioning") }));
    await expect(waitForOtaStatus(owner(), "ten_1", "active", { timeoutMs: 0 })).rejects.toThrow(
      'the OTA adm0123456789 is still "provisioning", not "active"',
    );
  });
});

describe("withAvailableOfficesHeld", () => {
  /** A fake `pg` client that records its queries and answers the lock query with `rowCount` rows. */
  function fakeClient(rowCount: number) {
    const queries: { text: string; values?: unknown[] }[] = [];
    const client = {
      query: vi.fn((text: string, values?: unknown[]) => {
        queries.push(values === undefined ? { text } : { text, values });
        return Promise.resolve({ rowCount, rows: [] });
      }),
    };
    withDatabase.mockImplementation((role: string, fn: (pgClient: typeof client) => Promise<unknown>) => {
      expect(role).toBe("platform");
      return fn(client);
    });
    return queries;
  }

  it("holds the available offices of the environment while the callback runs, then rolls back", async () => {
    const queries = fakeClient(7);
    let seen: string[] = [];
    const held = await withAvailableOfficesHeld("test", () => {
      seen = queries.map((query) => query.text.trim().split(/\s+/)[0] ?? "");
      return Promise.resolve("set up");
    });

    expect(held).toEqual({ result: "set up", heldOffices: 7 });
    // While the callback ran: the transaction was open and the lock query had run.
    expect(seen).toEqual(["BEGIN", "SELECT"]);
    expect(queries[1]?.text).toMatch(/o\.status = 'available'[\s\S]*FOR UPDATE OF o/);
    expect(queries[1]?.values).toEqual(["test"]);
    expect(queries.map((query) => query.text.trim().split(/\s+/)[0])).toEqual([
      "BEGIN",
      "SELECT",
      "ROLLBACK",
    ]);
  });

  it("rolls back when the callback fails, and fails with its error", async () => {
    const queries = fakeClient(0);
    await expect(
      withAvailableOfficesHeld("live", () => Promise.reject(new Error("set-up failed"))),
    ).rejects.toThrow("set-up failed");
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
  });
});
