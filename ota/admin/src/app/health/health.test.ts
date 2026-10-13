import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConfigModule from "@/config";
import { GET as live } from "./live/route";
import { GET as ready } from "./ready/route";

const { configured, getConfig } = vi.hoisted(() => {
  const configured: { config?: unknown } = {};
  return { configured, getConfig: vi.fn(() => configured.config) };
});

// The routes read a real, validated configuration; only where it comes from is replaced.
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  configured.config = actual.loadConfig({
    APP_ENV: "test",
    PUBLIC_OTA_ADMIN_URL: "http://localhost:3002",
    PUBLIC_PORTAL_URL: "http://localhost:3000",
    // A trailing slash, as an operator may write it: the probe still asks for /health/live.
    OTA_API_URL: "http://127.0.0.1:4999/",
    OTA_ADMIN_SERVICE_KEY: "sk_test_ota_admin_service_key_dummy",
  });
  return { ...actual, getConfig };
});

type FakeFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A fake `fetch` that records each call and answers with `answer`. */
function fakeFetch(answer: FakeFetch) {
  const fetch = vi.fn<FakeFetch>(answer);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** A fetch that never answers on its own, like a hung API: it only rejects when its signal aborts. */
function hangingUntilAborted(_input: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

function connectionRefused(): Promise<Response> {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4999"), { code: "ECONNREFUSED" });
  return Promise.reject(new TypeError("fetch failed", { cause }));
}

describe("GET /health/live", () => {
  it("answers 200 {status: ok} without reading the configuration or calling anything", async () => {
    const fetch = fakeFetch(connectionRefused);

    const response = live();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
    expect(fetch).not.toHaveBeenCalled();
    expect(getConfig).not.toHaveBeenCalled();
  });
});

describe("GET /health/ready", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers 200 when the OTA API answers /health/live", async () => {
    const fetch = fakeFetch(() => Promise.resolve(Response.json({ status: "ok" })));

    const response = await ready();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", checks: { otaApi: "ok" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:4999/health/live");
    expect(init).toMatchObject({ method: "GET", cache: "no-store", redirect: "manual" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // The probe carries no service key, token or cookie.
    expect(init?.headers).toBeUndefined();
    expect(init?.credentials).toBeUndefined();
  });

  it("answers 503 when the OTA API is unreachable [OAD-001 AC3]", async () => {
    fakeFetch(connectionRefused);

    const response = await ready();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: "unavailable", checks: { otaApi: "down" } });
    // The cause stays on the server.
    expect(body).not.toContain("ECONNREFUSED");
  });

  it("answers 503 when the OTA API does not answer within 2 s [OAD-001 AC3]", async () => {
    const fetch = fakeFetch(hangingUntilAborted);
    let settled: Response | undefined;
    const pending = ready().then((response) => {
      settled = response;
      return response;
    });

    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBeUndefined();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable", checks: { otaApi: "timeout" } });
  });

  it("answers 200 when the OTA API answers just inside the 2 s budget", async () => {
    fakeFetch(
      (_input, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(Response.json({ status: "ok" })), 1999);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const pending = ready();

    await vi.advanceTimersByTimeAsync(1999);
    const response = await pending;

    expect(response.status).toBe(200);
    // The budget timer is cleared once the answer is in: nothing is left to fire.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers 503 when the OTA API answers /health/live with an error status [OAD-001 AC3]", async () => {
    fakeFetch(() => Promise.resolve(Response.json({ status: "error" }, { status: 500 })));

    const response = await ready();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable", checks: { otaApi: "down" } });
  });

  it("answers 503 on a redirect instead of following it", async () => {
    fakeFetch(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://elsewhere.example.net/" } }),
      ),
    );

    const response = await ready();

    expect(response.status).toBe(503);
  });
});
