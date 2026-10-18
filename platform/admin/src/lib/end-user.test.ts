import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
const config = vi.hoisted(() => ({
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
}));

vi.mock("next/headers", () => nextHeaders);
vi.mock("@/lib/config", () => ({ getConfig: () => config }));

import { createPlatformApi, platformApi } from "./api";
import {
  BFF_KEY_HEADER,
  END_USER_AGENT_HEADER,
  END_USER_IP_HEADER,
  MAX_USER_AGENT_LENGTH,
  endUserAgent,
  endUserHeaders,
  endUserIp,
} from "./end-user";

const BFF_KEY = config.PLATFORM_BFF_KEY;
const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

/** The requests the mocked fetch received. */
function sentRequests(): Request[] {
  return fetchMock.mock.calls.map(([request]) => request);
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(Response.json({}, { status: 200 })));
  vi.stubGlobal("fetch", fetchMock);
});

describe("endUserIp", () => {
  it("[PAD-002 AC4] takes the right-most X-Forwarded-For entry and ignores a browser-supplied left-most one", () => {
    // The browser sent "X-Forwarded-For: 6.6.6.6"; Caddy appended the real client address.
    const headers = new Headers({ "X-Forwarded-For": "6.6.6.6, 203.0.113.7" });

    expect(endUserIp(headers)).toBe("203.0.113.7");
  });

  it("[PAD-002 AC4] takes the right-most entry across several X-Forwarded-For header lines", () => {
    const headers = new Headers([
      ["X-Forwarded-For", "6.6.6.6, 7.7.7.7"],
      ["X-Forwarded-For", "198.51.100.23"],
    ]);

    expect(endUserIp(headers)).toBe("198.51.100.23");
  });

  it("[PAD-002 AC4] uses the only entry Caddy wrote, IPv4 or IPv6", () => {
    expect(endUserIp(new Headers({ "X-Forwarded-For": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(endUserIp(new Headers({ "X-Forwarded-For": " 2001:db8::7 " }))).toBe("2001:db8::7");
  });

  it("[PAD-002 AC4] falls back to 127.0.0.1 without X-Forwarded-For (development without Caddy)", () => {
    expect(endUserIp(new Headers())).toBe("127.0.0.1");
  });

  it("falls back to 127.0.0.1 when X-Forwarded-For has no entry", () => {
    expect(endUserIp(new Headers({ "X-Forwarded-For": "" }))).toBe("127.0.0.1");
    expect(endUserIp(new Headers({ "X-Forwarded-For": " , ," }))).toBe("127.0.0.1");
  });

  it("skips an empty right-most entry instead of sending an empty address", () => {
    expect(endUserIp(new Headers({ "X-Forwarded-For": "203.0.113.7, " }))).toBe("203.0.113.7");
  });
});

describe("endUserAgent", () => {
  it("[PAD-002 AC4] cuts the user agent to 512 characters", () => {
    const long = `Mozilla/5.0 ${"x".repeat(600)}`;

    const agent = endUserAgent(new Headers({ "User-Agent": long }));

    expect(MAX_USER_AGENT_LENGTH).toBe(512);
    expect(agent).toHaveLength(512);
    expect(agent).toBe(long.slice(0, 512));
  });

  it("keeps a user agent of at most 512 characters as it is", () => {
    const exact = "a".repeat(512);
    const usual =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

    expect(endUserAgent(new Headers({ "User-Agent": exact }))).toBe(exact);
    expect(endUserAgent(new Headers({ "User-Agent": usual }))).toBe(usual);
  });

  it("is empty when the browser sent no user agent", () => {
    expect(endUserAgent(new Headers())).toBe("");
  });
});

describe("endUserHeaders", () => {
  it("[PAD-002 AC4] builds the three headers of PADR-0019", () => {
    const incoming = new Headers({ "X-Forwarded-For": "6.6.6.6, 203.0.113.7", "User-Agent": "Agent/1.0" });

    expect(endUserHeaders(incoming, BFF_KEY)).toEqual({
      "X-Velexis-End-User-IP": "203.0.113.7",
      "X-Velexis-End-User-Agent": "Agent/1.0",
      "X-Velexis-Bff-Key": BFF_KEY,
    });
    expect([END_USER_IP_HEADER, END_USER_AGENT_HEADER, BFF_KEY_HEADER]).toEqual([
      "X-Velexis-End-User-IP",
      "X-Velexis-End-User-Agent",
      "X-Velexis-Bff-Key",
    ]);
  });
});

describe("the API client forwards the admin", () => {
  const incoming = new Headers({
    "X-Forwarded-For": "6.6.6.6, 203.0.113.7",
    "User-Agent": `Agent/2.0 ${"y".repeat(700)}`,
  });

  function expectEndUserHeaders(request: Request): void {
    expect(request.headers.get("x-velexis-end-user-ip")).toBe("203.0.113.7");
    expect(request.headers.get("x-velexis-end-user-agent")).toBe(`Agent/2.0 ${"y".repeat(502)}`);
    expect(request.headers.get("x-velexis-bff-key")).toBe(BFF_KEY);
  }

  afterEach(() => {
    // Every call any test of this block made carried the three headers.
    for (const request of sentRequests()) {
      expect(request.headers.get("x-velexis-bff-key")).toBe(BFF_KEY);
      expect(request.headers.has("x-velexis-end-user-ip")).toBe(true);
      expect(request.headers.has("x-velexis-end-user-agent")).toBe(true);
    }
  });

  it("[PAD-002 AC4] every mocked API call carries the three headers: the sign-in calls, the refresh and signed-in calls", async () => {
    const anonymous = createPlatformApi({
      baseUrl: config.PLATFORM_API_URL,
      bffKey: BFF_KEY,
      requestHeaders: incoming,
    });
    const signedIn = createPlatformApi({
      baseUrl: config.PLATFORM_API_URL,
      bffKey: BFF_KEY,
      requestHeaders: incoming,
      accessToken: "admin-access-token-value",
    });

    await anonymous.POST("/v1/admin/auth/sign-in", {
      body: { email: "lena.holm@example.com", password: "a-long-password" },
    });
    await anonymous.POST("/v1/admin/auth/mfa/verify", {
      body: { mfaChallengeToken: "challenge-value", code: "492039" },
    });
    await anonymous.POST("/v1/admin/auth/refresh", { body: { refreshToken: "refresh-token-value" } });
    await signedIn.GET("/v1/admin/me");
    await signedIn.POST("/v1/admin/auth/step-up", { body: { code: "492039" } });
    await signedIn.POST("/v1/admin/auth/sign-out", { body: { refreshToken: "refresh-token-value" } });

    const requests = sentRequests();
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/admin/auth/sign-in",
      "/v1/admin/auth/mfa/verify",
      "/v1/admin/auth/refresh",
      "/v1/admin/me",
      "/v1/admin/auth/step-up",
      "/v1/admin/auth/sign-out",
    ]);
    for (const request of requests) {
      expectEndUserHeaders(request);
    }
  });

  it("[PAD-002 AC4] a caller cannot replace the forwarded headers", async () => {
    const api = createPlatformApi({
      baseUrl: config.PLATFORM_API_URL,
      bffKey: BFF_KEY,
      requestHeaders: incoming,
    });

    await api.POST("/v1/admin/auth/sign-in", {
      body: { email: "lena.holm@example.com", password: "a-long-password" },
      headers: {
        "X-Velexis-End-User-IP": "6.6.6.6",
        "X-Velexis-End-User-Agent": "forged",
        "X-Velexis-Bff-Key": "forged-key",
      },
    });

    expectEndUserHeaders(sentRequests()[0]!);
  });

  it("[PAD-002 AC4] platformApi() takes the headers of the request being rendered and the key from the config", async () => {
    nextHeaders.headers.mockResolvedValue(incoming);
    nextHeaders.cookies.mockResolvedValue({ get: () => undefined });

    const api = await platformApi();
    await api.GET("/v1/admin/me");

    expectEndUserHeaders(sentRequests()[0]!);
  });

  it("[PAD-002 AC4] sends 127.0.0.1 and an empty user agent for a request without them (development)", async () => {
    const api = createPlatformApi({
      baseUrl: config.PLATFORM_API_URL,
      bffKey: BFF_KEY,
      requestHeaders: new Headers(),
    });

    await api.GET("/v1/admin/me");

    const request = sentRequests()[0]!;
    expect(request.headers.get("x-velexis-end-user-ip")).toBe("127.0.0.1");
    expect(request.headers.has("x-velexis-end-user-agent")).toBe(true);
    expect(request.headers.get("x-velexis-end-user-agent")).toBe("");
    expect(request.headers.get("x-velexis-bff-key")).toBe(BFF_KEY);
  });
});

describe("module boundaries", () => {
  it("end-user.ts is a server-only module", () => {
    const source = readFileSync(fileURLToPath(new URL("./end-user.ts", import.meta.url)), "utf8");

    expect(source.startsWith('import "server-only";\n')).toBe(true);
  });
});
