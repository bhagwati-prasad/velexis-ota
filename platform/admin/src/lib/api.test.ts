import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
const config = vi.hoisted(() => ({
  PLATFORM_API_URL: "http://127.0.0.1:3100/",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
}));

vi.mock("next/headers", () => nextHeaders);
vi.mock("@/lib/config", () => ({ getConfig: () => config }));

import { createPlatformApi, platformApi, requestIdOf, toApiError, type PlatformApi } from "./api";

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

/** `AdminMe` of the platform document (dummy values). */
const ADMIN = {
  id: "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9",
  email: "lena.holm@example.com",
  fullName: "Lena Holm",
  features: {
    stripeBilling: false,
    ownStripe: false,
    settlements: false,
    ownAmadeus: false,
    customDomains: false,
    liveSwitch: false,
  },
};

function envelope(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json(
    { error: { code, status, message: `Raw API message for ${code}`, requestId: "req_api_0001", ...extra } },
    { status },
  );
}

function api(options: { accessToken?: string; requestHeaders?: Headers } = {}): PlatformApi {
  return createPlatformApi({
    baseUrl: "http://127.0.0.1:3100",
    bffKey: config.PLATFORM_BFF_KEY,
    requestHeaders: options.requestHeaders ?? new Headers(),
    ...(options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
  });
}

function lastRequest(): Request {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error("fetch was not called");
  }
  return call[0];
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("createPlatformApi requests", () => {
  it("calls PLATFORM_API_URL with cache: no-store and never follows a redirect", async () => {
    fetchMock.mockResolvedValue(Response.json(ADMIN));

    await api({ accessToken: "at" }).GET("/v1/admin/me");

    const request = lastRequest();
    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://127.0.0.1:3100/v1/admin/me");
    expect(request.cache).toBe("no-store");
    expect(request.redirect).toBe("manual");
  });

  it("keeps the base URL, fetch, no-store and manual redirects even when a caller passes other values", async () => {
    const otherFetch = vi.fn<(input: Request) => Promise<Response>>();
    fetchMock.mockImplementation(() => Promise.resolve(Response.json(ADMIN)));

    await api({ accessToken: "access-token-value" }).GET("/v1/admin/me", {
      baseUrl: "https://elsewhere.example",
      fetch: otherFetch,
      cache: "force-cache",
      redirect: "follow",
    });

    expect(otherFetch).not.toHaveBeenCalled();
    const request = lastRequest();
    expect(request.url).toBe("http://127.0.0.1:3100/v1/admin/me");
    expect(request.cache).toBe("no-store");
    expect(request.redirect).toBe("manual");
    expect(request.headers.get("authorization")).toBe("Bearer access-token-value");
  });

  it("sends the access token as a bearer token, and no Authorization without one", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json(ADMIN)));

    await api({ accessToken: "access-token-value" }).GET("/v1/admin/me");
    expect(lastRequest().headers.get("authorization")).toBe("Bearer access-token-value");

    await api().POST("/v1/admin/auth/sign-in", {
      body: { email: "lena.holm@example.com", password: "p" },
      headers: { Authorization: "Bearer smuggled" },
    });
    expect(lastRequest().headers.has("authorization")).toBe(false);
  });

  it("calls the admin surface only: any other path throws before anything is sent", () => {
    const client = api({ accessToken: "access-token-value" }) as unknown as {
      GET(url: string): Promise<unknown>;
    };

    for (const path of ["/v1/me", "/v1/plans", "/v1/administrators", "/health/live"]) {
      expect(() => client.GET(path), path).toThrow(TypeError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a valid X-Request-Id of the incoming request and drops an invalid one", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json(ADMIN)));

    await api({
      requestHeaders: new Headers({ "X-Request-Id": "3f2a1c9e-7b4d-4e8a-9c1f-2d3e4f5a6b7c" }),
    }).GET("/v1/admin/me");
    expect(lastRequest().headers.get("x-request-id")).toBe("3f2a1c9e-7b4d-4e8a-9c1f-2d3e4f5a6b7c");

    await api({ requestHeaders: new Headers({ "X-Request-Id": "bad id with spaces" }) }).GET("/v1/admin/me");
    expect(lastRequest().headers.has("x-request-id")).toBe(false);
    expect(requestIdOf(new Headers({ "X-Request-Id": "short" }))).toBeUndefined();
  });

  it("sends the JSON body of the operation", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await api({ accessToken: "at" }).POST("/v1/admin/auth/sign-out", {
      body: { refreshToken: "refresh-token-value" },
    });

    const request = lastRequest();
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toEqual({ refreshToken: "refresh-token-value" });
  });

  it("platformApi() uses the configuration, the admin access token cookie and the request headers", async () => {
    nextHeaders.cookies.mockResolvedValue({
      get: (name: string) => (name === "__Host-vxa_at" ? { value: "cookie-access-token" } : undefined),
    });
    nextHeaders.headers.mockResolvedValue(new Headers({ "X-Request-Id": "req_from_caddy_0001" }));
    fetchMock.mockResolvedValue(Response.json(ADMIN));

    const result = await (await platformApi()).GET("/v1/admin/me");

    expect(result).toEqual({ data: ADMIN });
    const request = lastRequest();
    expect(request.url).toBe("http://127.0.0.1:3100/v1/admin/me");
    expect(request.headers.get("authorization")).toBe("Bearer cookie-access-token");
    expect(request.headers.get("x-request-id")).toBe("req_from_caddy_0001");
  });

  it("platformApi() never sends the portal's access cookie", async () => {
    nextHeaders.cookies.mockResolvedValue({
      get: (name: string) => (name === "__Host-vxp_at" ? { value: "portal-access-token" } : undefined),
    });
    nextHeaders.headers.mockResolvedValue(new Headers());
    fetchMock.mockResolvedValue(Response.json(ADMIN));

    await (await platformApi()).GET("/v1/admin/me");

    expect(lastRequest().headers.has("authorization")).toBe(false);
  });
});

describe("createPlatformApi answers", () => {
  it("answers { data } for a 2xx answer", async () => {
    fetchMock.mockResolvedValue(Response.json(ADMIN));

    const result = await api({ accessToken: "at" }).GET("/v1/admin/me");

    expect(result).toEqual({ data: ADMIN });
  });

  it("answers { data: undefined } for 204 No Content", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const result = await api({ accessToken: "at" }).POST("/v1/admin/auth/sign-out", {
      body: { refreshToken: "refresh-token-value" },
    });

    expect(result).toEqual({ data: undefined });
    expect(result.error).toBeUndefined();
  });

  it("answers { error } with the code, field errors and details of the envelope, without the API's message", async () => {
    fetchMock.mockResolvedValue(
      envelope("VALIDATION_FAILED", 400, {
        fieldErrors: [
          { path: "/email", code: "format", message: "Enter a valid e-mail address.", value: "not-an-email" },
          { path: 7, code: "broken" },
        ],
        details: { reason: "example" },
      }),
    );

    const result = await api().POST("/v1/admin/auth/sign-in", { body: { email: "x", password: "y" } });

    expect(result).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        status: 400,
        fieldErrors: [{ path: "/email", code: "format" }],
        details: { reason: "example" },
        requestId: "req_api_0001",
      },
    });
    expect(JSON.stringify(result)).not.toContain("Raw API message");
    expect(JSON.stringify(result)).not.toContain("not-an-email");
  });

  it("reads Retry-After of ACCOUNT_LOCKED and RATE_LIMITED", async () => {
    const locked = envelope("ACCOUNT_LOCKED", 423);
    locked.headers.set("Retry-After", "840");
    fetchMock.mockResolvedValue(locked);

    const result = await api().POST("/v1/admin/auth/sign-in", {
      body: { email: "lena.holm@example.com", password: "p" },
    });

    expect(result.error).toMatchObject({ code: "ACCOUNT_LOCKED", status: 423, retryAfterSeconds: 840 });
  });

  it("maps a code outside the platform catalogue to INTERNAL_ERROR", async () => {
    fetchMock.mockResolvedValue(envelope("PRICE_CHANGED", 409));

    const result = await api({ accessToken: "at" }).GET("/v1/admin/me");

    expect(result.error).toMatchObject({ code: "INTERNAL_ERROR", status: 409 });
  });

  it("maps an answer without an envelope by its status (Caddy's 502 page, a plain 500)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>Bad Gateway</html>", { status: 502 }));
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 }));

    const gateway = await api({ accessToken: "at" }).GET("/v1/admin/me");
    const internal = await api({ accessToken: "at" }).GET("/v1/admin/me");

    expect(gateway.error).toEqual({ code: "SERVICE_UNAVAILABLE", status: 502, fieldErrors: [], details: {} });
    expect(internal.error).toEqual({ code: "INTERNAL_ERROR", status: 500, fieldErrors: [], details: {} });
  });

  it("answers SERVICE_UNAVAILABLE when the API cannot be reached, without the cause", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }));

    const result = await api({ accessToken: "at" }).GET("/v1/admin/me");

    expect(result).toEqual({
      error: { code: "SERVICE_UNAVAILABLE", status: 503, fieldErrors: [], details: {} },
    });
  });

  it("treats a redirect as an error and does not follow it", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }),
    );

    const result = await api({ accessToken: "at" }).GET("/v1/admin/me");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toMatchObject({ code: "INTERNAL_ERROR", status: 302 });
  });

  it("toApiError keeps only the fields of the envelope schema", () => {
    const error = toApiError(new Response(null, { status: 403 }), {
      error: {
        code: "FORBIDDEN",
        status: 403,
        message: "m",
        requestId: 42,
        details: ["not", "an", "object"],
      },
    });

    expect(error).toEqual({ code: "FORBIDDEN", status: 403, fieldErrors: [], details: {} });
  });
});

describe("module boundaries", () => {
  it("api.ts is a server-only module", () => {
    const source = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");

    expect(source.startsWith('import "server-only";\n')).toBe(true);
  });
});
