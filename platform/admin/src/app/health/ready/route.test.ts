import { ConfigError } from "@velexis/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ PLATFORM_API_URL: "http://127.0.0.1:3100" }));
const getConfig = vi.hoisted(() => vi.fn(() => config));

vi.mock("@/lib/config", () => ({ getConfig }));

import { GET } from "./route";

type FetchArgs = [input: string, init: RequestInit];

const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();

/** A fetch that never answers by itself and rejects like undici when its signal aborts. */
function hangUntilAborted(_input: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      reject(new DOMException("This operation was aborted", "AbortError"));
    });
  });
}

/** A fetch that answers 200 after `delayMs` (on the fake clock), unless its signal aborts first. */
function answerAfter(delayMs: number) {
  return (_input: string, init: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response('{"status":"ok"}', { status: 200 })), delayMs);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("This operation was aborted", "AbortError"));
      });
    });
}

beforeEach(() => {
  config.PLATFORM_API_URL = "http://127.0.0.1:3100";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /health/ready", () => {
  it("answers 200 when the platform API answers /health/live", async () => {
    fetchMock.mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", checks: { platformApi: "ok" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:3100/health/live");
    expect(init).toMatchObject({ cache: "no-store", redirect: "manual" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("answers 503 when the platform API is down (connection refused)", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable", checks: { platformApi: "down" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 when the platform API answers with an error status", async () => {
    fetchMock.mockResolvedValue(new Response("Service Unavailable", { status: 503 }));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable", checks: { platformApi: "down" } });
  });

  it("answers 503 when the platform API does not answer within 2 seconds", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangUntilAborted);
    let settled = false;

    const pending = GET().finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable", checks: { platformApi: "down" } });
  });

  it("answers 200 when the platform API answers just within 2 seconds", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(answerAfter(1900));

    const pending = GET();
    await vi.advanceTimersByTimeAsync(1900);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a redirect from the platform API as not ready", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { Location: "/elsewhere" } }));

    const response = await GET();

    expect(response.status).toBe(503);
  });

  it("joins a PLATFORM_API_URL with a trailing slash without a double slash", async () => {
    config.PLATFORM_API_URL = "http://127.0.0.1:3100/";
    fetchMock.mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));

    await GET();

    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:3100/health/live");
  });

  it("fails instead of answering when the configuration is invalid, so deploy.sh never sees it ready", async () => {
    const invalid = new ConfigError([{ variable: "PLATFORM_API_URL", reason: "is required but missing" }]);
    getConfig.mockImplementationOnce(() => {
      throw invalid;
    });

    await expect(GET()).rejects.toBe(invalid);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
