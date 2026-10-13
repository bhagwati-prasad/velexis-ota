// @vitest-environment happy-dom
// The fake fetch of test/helpers/fake-fetch.js in the DOM that the cookie-mode tests use: happy-dom brings its own
// Headers, Request, Response and AbortController, which differ from Node's in details (header-name case), so the
// helper is proved here too.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeFetch, errorResponse } from "../helpers/fake-fetch.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createFakeFetch under happy-dom", () => {
  it("records relative cookie-mode calls with lower-case header names", async () => {
    const fake = createFakeFetch([{ body: { data: [] } }, errorResponse(403, "CSRF_TOKEN_INVALID")]);

    const ok = await fake.fetch("/api/v1/storefront?locale=es", {
      credentials: "same-origin",
      mode: "same-origin",
      headers: { Accept: "application/json" },
    });
    const refused = await fake.fetch("/api/v1/auth/sign-in", {
      method: "post",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "csrf-fake" },
      body: JSON.stringify({ email: "traveller@example.com" }),
    });

    expect(await ok.json()).toEqual({ data: [] });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-request-id")).toBe("req_fake");
    expect((await refused.json()).error.code).toBe("CSRF_TOKEN_INVALID");
    expect(fake.requests[0]).toMatchObject({
      method: "GET",
      url: "/api/v1/storefront?locale=es",
      path: "/api/v1/storefront",
      headers: { accept: "application/json" },
    });
    expect(fake.requests[0]?.searchParams.get("locale")).toBe("es");
    expect(fake.requests[0]?.init).toMatchObject({ credentials: "same-origin", mode: "same-origin" });
    expect(fake.requests[1]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-fake" },
      json: { email: "traveller@example.com" },
    });
    expect(Object.keys(fake.requests[1]?.headers ?? {})).toEqual(["content-type", "x-csrf-token"]);
  });

  it("reads method, lower-case headers and body from a happy-dom Request", async () => {
    const fake = createFakeFetch([{ status: 204 }]);

    const response = await fake.fetch(
      new Request("https://shop.example.com/api/v1/account", {
        method: "PATCH",
        headers: { "X-CSRF-Token": "csrf-fake" },
        body: '{"locale":"es"}',
      }),
    );

    expect(response.status).toBe(204);
    expect(fake.lastRequest).toMatchObject({
      method: "PATCH",
      path: "/api/v1/account",
      headers: { "x-csrf-token": "csrf-fake" },
      body: '{"locale":"es"}',
      json: { locale: "es" },
    });
  });

  it("rejects with the abort reason under fake timers", async () => {
    vi.useFakeTimers();
    const fake = createFakeFetch([{ body: "never", delayMs: Infinity }]);
    const controller = new AbortController();

    const hanging = fake.fetch("/api/v1/flights/searches", { method: "POST", signal: controller.signal });
    const rejected = expect(hanging).rejects.toMatchObject({ name: "AbortError" });
    setTimeout(() => controller.abort(), 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
  });
});
