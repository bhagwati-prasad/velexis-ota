import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_CONFIG, apiError, deferred, fakeOtaApi, fakeRedirect, staffSession } from "@/test/fake-ota-api";

vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(fakeRedirect) }));

import {
  FINAL_REFRESH_ERROR_CODES,
  REFRESH_REUSE_MS,
  createRefreshDedup,
  dedupRefresh,
  isFinalRefreshError,
  refreshTokenKey,
  type RefreshFlight,
  type StaffRefreshCall,
} from "./refresh-dedup";
import { refreshStaffSession } from "./velexis";

const NOW = Date.parse("2026-10-21T10:00:00Z");
const BROWSER = new Headers({ "X-Forwarded-For": "203.0.113.7", "User-Agent": "Mozilla/5.0 Test" });

/** A refresh call that answers `staffSession` for every token and counts its calls. */
function countingCall(): StaffRefreshCall & ReturnType<typeof vi.fn> {
  return vi.fn((token: string) =>
    Promise.resolve(staffSession(NOW, { refreshToken: `rotated-from-${token}` })),
  ) as unknown as StaffRefreshCall & ReturnType<typeof vi.fn>;
}

describe("refreshStaffSession (de-duplicated per refresh token)", () => {
  let api: ReturnType<typeof fakeOtaApi>;

  beforeEach(() => {
    api = fakeOtaApi();
  });

  it("[OAD-002 AC1] two parallel refreshes with the same token make one SDK call and both receive the new tokens", async () => {
    const dedup = createRefreshDedup({ now: () => NOW });
    const answer = deferred<Response>();
    const rotated = staffSession(NOW, { refreshToken: "staff-refresh-token-new" });
    api.on("POST /v1/console/auth/refresh", () => answer.promise);

    // Two requests of one browser arrive with the same old refresh token before the API answers.
    const first = refreshStaffSession("staff-refresh-token-old", BROWSER, { fetch: api.fetch, dedup });
    const second = refreshStaffSession("staff-refresh-token-old", BROWSER, { fetch: api.fetch, dedup });
    answer.resolve(Response.json(rotated));
    const outcomes = await Promise.all([first, second]);

    const refreshes = api.sent("POST /v1/console/auth/refresh");
    expect(refreshes).toHaveLength(1);
    expect(api.requests).toHaveLength(1);
    expect(refreshes[0]?.body).toEqual({ refreshToken: "staff-refresh-token-old" });
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ ok: true, session: rotated });
    }
    expect(outcomes[0]).toBe(outcomes[1]);
  });

  it("[OAD-002 AC1] a request with the old token after the refresh settled gets the same new tokens without a call", async () => {
    let clock = NOW;
    const dedup = createRefreshDedup({ now: () => clock });
    const rotated = staffSession(NOW, { refreshToken: "staff-refresh-token-new" });
    api.on("POST /v1/console/auth/refresh", () => Response.json(rotated));

    const first = await refreshStaffSession("staff-refresh-token-old", BROWSER, { fetch: api.fetch, dedup });
    clock += REFRESH_REUSE_MS - 1;
    const late = await refreshStaffSession("staff-refresh-token-old", BROWSER, { fetch: api.fetch, dedup });

    expect(late).toEqual(first);
    expect(api.sent("POST /v1/console/auth/refresh")).toHaveLength(1);
  });

  it("refreshes with the service key alone, in the test environment, as a staff session", async () => {
    const dedup = createRefreshDedup({ now: () => NOW });

    await refreshStaffSession("staff-refresh-token-old", BROWSER, { fetch: api.fetch, dedup });

    const [request] = api.requests;
    expect(request?.url.toString()).toBe(`${TEST_CONFIG.OTA_API_URL}/v1/console/auth/refresh`);
    expect(request?.headers.get("X-Api-Key")).toBe(TEST_CONFIG.OTA_ADMIN_SERVICE_KEY);
    // A refresh never presents the (expired) access token.
    expect(request?.headers.has("Authorization")).toBe(false);
    expect(request?.headers.get("X-Velexis-Environment")).toBe("test");
    expect(request?.headers.get("Idempotency-Key")).toMatch(/^[\x21-\x7e]{16,128}$/);
  });

  it("answers a refusal as a final outcome, once, for every request with that token", async () => {
    const dedup = createRefreshDedup({ now: () => NOW });
    api.on("POST /v1/console/auth/refresh", () => apiError("REFRESH_TOKEN_REUSED", 401));

    const [first, second] = await Promise.all([
      refreshStaffSession("reused-token", BROWSER, { fetch: api.fetch, dedup }),
      refreshStaffSession("reused-token", BROWSER, { fetch: api.fetch, dedup }),
    ]);
    const third = await refreshStaffSession("reused-token", BROWSER, { fetch: api.fetch, dedup });

    expect(first).toMatchObject({
      ok: false,
      final: true,
      error: { code: "REFRESH_TOKEN_REUSED", status: 401 },
    });
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(api.sent("POST /v1/console/auth/refresh")).toHaveLength(1);
  });
});

describe("createRefreshDedup", () => {
  it("reuses a settled refresh for 30 seconds, then calls again", async () => {
    let clock = NOW;
    const dedup = createRefreshDedup({ now: () => clock });
    const call = countingCall();

    const first = await dedup("token-a", call);
    clock += REFRESH_REUSE_MS - 1;
    expect(await dedup("token-a", call)).toBe(first);
    expect(call).toHaveBeenCalledTimes(1);

    clock += 1;
    await dedup("token-a", call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(REFRESH_REUSE_MS).toBe(30_000);
  });

  it("keeps a pending refresh in flight however long the API takes", async () => {
    let clock = NOW;
    const dedup = createRefreshDedup({ now: () => clock });
    const answer = deferred<ReturnType<typeof staffSession>>();
    const call = vi.fn(() => answer.promise);

    const first = dedup("slow-token", call);
    clock += 10 * REFRESH_REUSE_MS;
    const second = dedup("slow-token", call);
    answer.resolve(staffSession(NOW));

    expect(await second).toBe(await first);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("refreshes different refresh tokens separately", async () => {
    const dedup = createRefreshDedup({ now: () => NOW });
    const call = countingCall();

    const [a, b, again] = await Promise.all([
      dedup("token-a", call),
      dedup("token-b", call),
      dedup("token-a", call),
    ]);

    expect(call).toHaveBeenCalledTimes(2);
    expect(again).toBe(a);
    expect(b).not.toBe(a);
  });

  it("forgets a failure that may pass, so the next request tries again", async () => {
    const dedup = createRefreshDedup({ now: () => NOW });
    const unavailable = Object.assign(new Error("unavailable"), { code: "SERVICE_UNAVAILABLE", status: 503 });
    const call = vi
      .fn<StaffRefreshCall>()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce(staffSession(NOW));

    const failed = await dedup("token-c", call);
    const refreshed = await dedup("token-c", call);

    expect(failed).toEqual({ ok: false, final: false, error: unavailable });
    expect(refreshed).toMatchObject({ ok: true });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it.each([...FINAL_REFRESH_ERROR_CODES])("treats %s as final and keeps it for 30 seconds", async (code) => {
    let clock = NOW;
    const dedup = createRefreshDedup({ now: () => clock });
    const call = vi.fn<StaffRefreshCall>().mockRejectedValue(Object.assign(new Error(code), { code }));

    const first = await dedup(`token-${code}`, call);
    clock += REFRESH_REUSE_MS - 1;
    const second = await dedup(`token-${code}`, call);

    expect(first).toMatchObject({ ok: false, final: true });
    expect(second).toBe(first);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not treat rate limits, outages, network failures or unknown errors as final", () => {
    for (const code of [
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
      "INTERNAL_ERROR",
      "NETWORK_ERROR",
      "TIMEOUT",
    ]) {
      expect(isFinalRefreshError({ code }), code).toBe(false);
    }
    expect(isFinalRefreshError(new Error("boom"))).toBe(false);
    expect(isFinalRefreshError(undefined)).toBe(false);
  });

  it("keys the flights by the SHA-256 of the refresh token, never by the token", async () => {
    const flights = new Map<string, RefreshFlight>();
    const dedup = createRefreshDedup({ now: () => NOW, flights });

    await dedup("some-refresh-token", countingCall());

    const key = refreshTokenKey("some-refresh-token");
    expect(key).toBe(createHash("sha256").update("some-refresh-token").digest("hex"));
    expect([...flights.keys()]).toEqual([key]);
    expect(key).not.toContain("some-refresh-token");
  });

  it("forgets settled flights once their 30 seconds are over", async () => {
    let clock = NOW;
    const flights = new Map<string, RefreshFlight>();
    const dedup = createRefreshDedup({ now: () => clock, flights });

    await dedup("token-old", countingCall());
    clock += REFRESH_REUSE_MS;
    await dedup("token-new", countingCall());

    expect([...flights.keys()]).toEqual([refreshTokenKey("token-new")]);
  });

  it("shares one process-wide map between the bundles of the admin (a registered symbol on globalThis)", async () => {
    const store = globalThis as typeof globalThis & Record<symbol, unknown>;
    const flights = store[Symbol.for("velexis.ota-admin.staff-refresh-flights")];
    expect(flights).toBeInstanceOf(Map);

    await dedupRefresh("process-wide-token", countingCall());

    expect((flights as Map<string, RefreshFlight>).has(refreshTokenKey("process-wide-token"))).toBe(true);
  });
});
