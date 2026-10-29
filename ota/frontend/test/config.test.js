// lib/config.js and lib/client.js (ota/frontend/README.md §2 point 3, OADR-0015 point 7): `storefront.get` once,
// kept in sessionStorage for 5 minutes, every storage access wrapped so that a page works when the browser refuses
// storage; errors are thrown as the SDK raised them and never cached. The default client is the cookie-mode client of
// lib/client.js on the same-origin `/api`.
import { ConnectionError, PermissionError } from "@velexis/ota-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLIENT_OPTIONS, client } from "../src/lib/client.js";
import { CONFIG_STORAGE_KEY, CONFIG_TTL_MS, clearCachedConfig, loadConfig } from "../src/lib/config.js";

/** A small public configuration (the real one is much larger; only its round trip matters here). */
const CONFIG = Object.freeze({
  tenantKey: "demo",
  name: "Demo Travel",
  environment: "test",
  defaultLocale: "en-GB",
  defaultCurrency: "GBP",
  currencies: [{ code: "GBP", name: "Pound sterling", symbol: "£", decimals: 2 }],
  version: 3,
});
const START = Date.UTC(2026, 9, 17, 9, 0, 0);

/** A fake SDK client whose `storefront.get` answers with `answers` in turn (an Error is thrown). */
function fakeClient(/** @type {unknown[]} */ ...answers) {
  const get = vi.fn(async () => {
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) {
      throw answer;
    }
    return structuredClone(answer);
  });
  return { storefront: { get }, get };
}

/** An in-memory Storage. */
function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: vi.fn((/** @type {string} */ key) => (items.has(key) ? items.get(key) : null)),
    setItem: vi.fn((/** @type {string} */ key, /** @type {string} */ value) => void items.set(key, value)),
    removeItem: vi.fn((/** @type {string} */ key) => void items.delete(key)),
  };
}

/** A Storage whose every method throws, like a full or blocked storage. */
const throwingStorage = () => ({
  getItem: vi.fn(() => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  }),
  setItem: vi.fn(() => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  }),
  removeItem: vi.fn(() => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  }),
});

const sessionStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

afterEach(() => {
  if (sessionStorageDescriptor) {
    Object.defineProperty(globalThis, "sessionStorage", sessionStorageDescriptor);
  }
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("loadConfig", () => {
  it("[OFE-002 AC1] calls storefront.get once and answers from sessionStorage for 5 minutes", async () => {
    const sdk = fakeClient(CONFIG, { ...CONFIG, version: 4 });
    const storage = memoryStorage();
    let now = START;
    const deps = { client: sdk, storage, now: () => now };

    expect(await loadConfig(deps)).toEqual(CONFIG);
    expect(JSON.parse(storage.items.get(CONFIG_STORAGE_KEY))).toEqual({ storedAt: START, config: CONFIG });

    now = START + CONFIG_TTL_MS - 1;
    expect(await loadConfig(deps)).toEqual(CONFIG);
    expect(sdk.get).toHaveBeenCalledTimes(1);

    now = START + CONFIG_TTL_MS;
    expect(await loadConfig(deps)).toEqual({ ...CONFIG, version: 4 });
    expect(sdk.get).toHaveBeenCalledTimes(2);
    expect(CONFIG_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("[OFE-002 AC1] works with a throwing sessionStorage: every page load asks the API instead", async () => {
    const sdk = fakeClient(CONFIG);
    const storage = throwingStorage();

    expect(await loadConfig({ client: sdk, storage, now: () => START })).toEqual(CONFIG);
    expect(await loadConfig({ client: sdk, storage, now: () => START + 1000 })).toEqual(CONFIG);

    expect(sdk.get).toHaveBeenCalledTimes(2);
    expect(storage.getItem).toHaveBeenCalled();
    expect(storage.setItem).toHaveBeenCalled();
    expect(() => clearCachedConfig(storage)).not.toThrow();
  });

  it("[OFE-002 AC1] works when the browser refuses window.sessionStorage itself", async () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
    const sdk = fakeClient(CONFIG);

    expect(await loadConfig({ client: sdk })).toEqual(CONFIG);
    expect(await loadConfig({ client: sdk })).toEqual(CONFIG);
    expect(sdk.get).toHaveBeenCalledTimes(2);
    expect(() => clearCachedConfig()).not.toThrow();
  });

  it("[OFE-002 AC1] uses the page's sessionStorage by default and forgets it on request", async () => {
    const sdk = fakeClient(CONFIG);

    await loadConfig({ client: sdk });
    await loadConfig({ client: sdk });

    expect(sdk.get).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CONFIG_STORAGE_KEY)).toContain('"tenantKey":"demo"');
    clearCachedConfig();
    expect(sessionStorage.getItem(CONFIG_STORAGE_KEY)).toBeNull();
  });

  it("[OFE-002 AC1] ignores and removes unreadable, foreign, future and expired entries", async () => {
    const offline = new ConnectionError({ code: "NETWORK_ERROR", message: "Network error.", status: 0 });
    for (const text of [
      "{not json",
      JSON.stringify({ config: CONFIG }),
      JSON.stringify({ storedAt: START, config: "x" }),
      JSON.stringify({ storedAt: START + 60_000, config: CONFIG }),
      JSON.stringify({ storedAt: START - CONFIG_TTL_MS, config: CONFIG }),
    ]) {
      const sdk = fakeClient(offline, CONFIG);
      const storage = memoryStorage();
      storage.items.set(CONFIG_STORAGE_KEY, text);

      // The entry is gone even when the API cannot be reached: it is never used again.
      await expect(loadConfig({ client: sdk, storage, now: () => START }), text).rejects.toBe(offline);
      expect(storage.items.has(CONFIG_STORAGE_KEY), text).toBe(false);

      expect(await loadConfig({ client: sdk, storage, now: () => START })).toEqual(CONFIG);
      expect(sdk.get, text).toHaveBeenCalledTimes(2);
      expect(JSON.parse(storage.items.get(CONFIG_STORAGE_KEY))).toEqual({ storedAt: START, config: CONFIG });
    }
  });

  it("[OFE-002 AC1] throws the SDK's error unchanged and caches nothing", async () => {
    const suspended = new PermissionError({
      code: "TENANT_SUSPENDED",
      message: "This storefront is suspended.",
      status: 403,
      requestId: "req_ofe002",
    });
    const sdk = fakeClient(suspended);
    const storage = memoryStorage();

    await expect(loadConfig({ client: sdk, storage, now: () => START })).rejects.toBe(suspended);
    expect(storage.items.size).toBe(0);
  });
});

describe("the storefront client", () => {
  it("[OFE-002 AC1] is the SDK's cookie-mode client on the same-origin /api", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(CONFIG), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    expect(CLIENT_OPTIONS).toEqual({ baseUrl: "/api", session: "cookie" });
    expect(await loadConfig({ storage: null })).toEqual(CONFIG);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = /** @type {[string, RequestInit]} */ (fetch.mock.calls[0]);
    expect(url).toBe("/api/v1/storefront");
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", mode: "same-origin" });
    const headers = new Headers(init.headers);
    expect(headers.has("x-api-key")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    // Cookie mode refuses tokens, so none can be passed to the storefront client by mistake.
    expect(() => client.withOptions({ accessToken: "not-a-real-token" })).toThrow(TypeError);
  });

  /** The API's error answer: `status` with `code`. */
  const errorAnswer = (/** @type {number} */ status, /** @type {string} */ code) =>
    new Response(JSON.stringify({ error: { code, message: code, status, requestId: "req_test" } }), {
      status,
      headers: { "content-type": "application/json" },
    });

  /** A cached configuration, as a page left it in sessionStorage a minute ago. */
  function cacheConfig() {
    sessionStorage.setItem(
      CONFIG_STORAGE_KEY,
      JSON.stringify({ storedAt: Date.now() - 60_000, config: CONFIG }),
    );
  }

  it("[OFE-003] [FIX-W33-OTA] drops the cached storefront.get copy when any call answers 403 TENANT_SUSPENDED", async () => {
    cacheConfig();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorAnswer(403, "TENANT_SUSPENDED")),
    );

    // Not storefront.get: any call of an open tab (here the airports' names).
    await expect(client.reference.airports.get({ iataCode: "MAD" })).rejects.toMatchObject({
      code: "TENANT_SUSPENDED",
      status: 403,
    });

    expect(sessionStorage.getItem(CONFIG_STORAGE_KEY)).toBeNull();
    // The next page asks storefront.get again, which answers the suspension: loadConfig throws it, boot renders it.
    await expect(loadConfig()).rejects.toMatchObject({ code: "TENANT_SUSPENDED" });
  });

  it("[OFE-003] [FIX-W33-OTA] keeps the cached copy for any other refusal, a 403 of another code included", async () => {
    for (const [status, code] of /** @type {const} */ ([
      [403, "FEATURE_DISABLED"],
      [403, "CSRF_TOKEN_INVALID"],
      [404, "NOT_FOUND"],
    ])) {
      cacheConfig();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => errorAnswer(status, code)),
      );
      await expect(client.reference.airports.get({ iataCode: "MAD" })).rejects.toMatchObject({ code });
      expect(sessionStorage.getItem(CONFIG_STORAGE_KEY)).toContain('"tenantKey":"demo"');
    }
    // A 403 whose body is not the API's JSON (a proxy's page) changes nothing either.
    cacheConfig();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<h1>Forbidden</h1>", { status: 403, headers: { "content-type": "text/html" } }),
      ),
    );
    await expect(client.reference.airports.get({ iataCode: "MAD" })).rejects.toMatchObject({ status: 403 });
    expect(sessionStorage.getItem(CONFIG_STORAGE_KEY)).toContain('"tenantKey":"demo"');
  });

  it("[OFE-003] [FIX-W33-OTA] drops nothing and still answers the call when the browser refuses storage", async () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorAnswer(403, "TENANT_SUSPENDED")),
    );

    await expect(client.reference.airports.get({ iataCode: "MAD" })).rejects.toMatchObject({
      code: "TENANT_SUSPENDED",
    });
  });
});
