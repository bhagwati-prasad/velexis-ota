// The fake fetch of test/helpers/fake-fetch.js, which every later SDK unit test relies on: answers in call order,
// records every request, builds real Response objects, and honours abort signals and fake timers.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeFetch, errorResponse, networkError } from "../helpers/fake-fetch.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createFakeFetch", () => {
  it("answers from the queue in call order and records every request", async () => {
    const fake = createFakeFetch([{ body: { n: 1 } }, { status: 201, body: { n: 2 } }]);

    const first = await fake.fetch("https://api.ota.example.com/v1/flights/searches?include=offers,links", {
      method: "post",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "key-1" },
      body: JSON.stringify({ originLocationCode: "MAD" }),
      credentials: "omit",
    });
    const second = await fake.fetch(new URL("https://api.ota.example.com/v1/storefront"));

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ n: 1 });
    expect(first.headers.get("content-type")).toBe("application/json");
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ n: 2 });
    expect(fake.remaining).toBe(0);

    expect(fake.requests).toHaveLength(2);
    const [post, get] = fake.requests;
    expect(post).toMatchObject({
      method: "POST",
      url: "https://api.ota.example.com/v1/flights/searches?include=offers,links",
      path: "/v1/flights/searches",
      headers: { "content-type": "application/json", "idempotency-key": "key-1" },
      body: '{"originLocationCode":"MAD"}',
      json: { originLocationCode: "MAD" },
      signal: null,
    });
    expect(post?.searchParams.get("include")).toBe("offers,links");
    expect(post?.init.credentials).toBe("omit");
    expect(get).toMatchObject({
      method: "GET",
      url: "https://api.ota.example.com/v1/storefront",
      body: null,
    });
    expect(fake.lastRequest).toBe(get);
  });

  it("records relative URLs as given (cookie mode) and keeps non-JSON bodies as passed", async () => {
    const form = new FormData();
    form.append("kind", "logo");
    const fake = createFakeFetch([{ status: 204 }, { body: "plain text" }]);

    const empty = await fake.fetch("/api/v1/console/settings/assets?x=1", { method: "POST", body: form });
    const text = await fake.fetch("/api/v1/storefront");

    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
    expect(await text.text()).toBe("plain text");
    expect(text.headers.get("content-type")).not.toBe("application/json");
    expect(fake.requests[0]).toMatchObject({
      url: "/api/v1/console/settings/assets?x=1",
      path: "/api/v1/console/settings/assets",
    });
    expect(fake.requests[0]?.body).toBe(form);
    expect(fake.requests[0]?.json).toBeUndefined();
  });

  it("reads method, URL, headers and body from a Request", async () => {
    const fake = createFakeFetch([{ body: {} }]);

    await fake.fetch(
      new Request("https://api.ota.example.com/v1/auth/refresh", {
        method: "POST",
        headers: { "X-Api-Key": "pk_test_fake" },
        body: "{}",
      }),
    );

    expect(fake.lastRequest).toMatchObject({
      method: "POST",
      path: "/v1/auth/refresh",
      headers: { "x-api-key": "pk_test_fake" },
      body: "{}",
      json: {},
    });
  });

  it("answers with the result of a function of the request, or with a ready Response", async () => {
    const fake = createFakeFetch([
      (request) => ({ status: request.method === "DELETE" ? 204 : 200 }),
      async (request) => ({ body: { path: request.path } }),
      new Response("ready", { status: 202 }),
    ]);

    expect((await fake.fetch("https://api.ota.example.com/v1/x", { method: "DELETE" })).status).toBe(204);
    expect(await (await fake.fetch("https://api.ota.example.com/v1/y")).json()).toEqual({ path: "/v1/y" });
    const ready = await fake.fetch("https://api.ota.example.com/v1/z");
    expect(ready.status).toBe(202);
    expect(await ready.text()).toBe("ready");
  });

  it("lets answers be added later with enqueue", async () => {
    const fake = createFakeFetch();
    expect(fake.enqueue({ body: 1 }, { body: 2 })).toBe(fake);
    expect(fake.remaining).toBe(2);
    expect(await (await fake.fetch("https://api.ota.example.com/a")).json()).toBe(1);
    expect(fake.remaining).toBe(1);
  });

  it("rejects a call when no answer is left, naming the request", async () => {
    const fake = createFakeFetch();
    await expect(fake.fetch("https://api.ota.example.com/v1/bookings", { method: "GET" })).rejects.toThrow(
      "fake fetch: no answer queued for GET https://api.ota.example.com/v1/bookings",
    );
    expect(fake.requests).toHaveLength(1);
  });

  it("refuses canned responses that a Response cannot have", () => {
    const fake = createFakeFetch();
    expect(() => fake.enqueue({ status: 204, body: {} })).toThrow("a 204 response has no body");
    expect(() => fake.enqueue({ status: 99 })).toThrow("not a final HTTP status");
    expect(fake.remaining).toBe(0);
  });

  it("rejects with a network error like fetch does", async () => {
    const fake = createFakeFetch([networkError()]);
    await expect(fake.fetch("https://api.ota.example.com/v1/storefront")).rejects.toThrow(
      new TypeError("fetch failed"),
    );
  });

  it("does not answer a call whose signal is already aborted, and keeps the answer for the next call", async () => {
    const fake = createFakeFetch([{ body: "next" }]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      fake.fetch("https://api.ota.example.com/v1/a", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.requests).toHaveLength(1);
    expect(fake.remaining).toBe(1);
    expect(await (await fake.fetch("https://api.ota.example.com/v1/b")).text()).toBe("next");
  });

  it("answers after delayMs under fake timers, and rejects with the abort reason when aborted first", async () => {
    vi.useFakeTimers();
    const fake = createFakeFetch([
      { body: "slow", delayMs: 1000 },
      { body: "never", delayMs: Infinity },
    ]);

    let settled = false;
    const slow = fake.fetch("https://api.ota.example.com/v1/slow").then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await slow).text()).toBe("slow");

    const controller = new AbortController();
    const hanging = fake.fetch("https://api.ota.example.com/v1/hang", { signal: controller.signal });
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    setTimeout(() => controller.abort(timeout), 30_000);
    const rejected = expect(hanging).rejects.toBe(timeout);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(fake.lastRequest?.signal).toBe(controller.signal);
  });
});

describe("errorResponse", () => {
  it("builds the API's error envelope with the X-Request-Id header", async () => {
    const fake = createFakeFetch([
      errorResponse(401, "TOKEN_EXPIRED", { requestId: "req_1", details: { reason: "expired" } }),
    ]);

    const response = await fake.fetch("https://api.ota.example.com/v1/account");

    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe("req_1");
    expect(await response.json()).toEqual({
      error: {
        code: "TOKEN_EXPIRED",
        message: "Fake TOKEN_EXPIRED",
        status: 401,
        requestId: "req_1",
        details: { reason: "expired" },
      },
    });
  });
});
