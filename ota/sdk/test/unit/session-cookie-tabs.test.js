// @vitest-environment happy-dom
// Cookie mode across the tabs of one origin (FIX-W67-KI003, guidebook known issue KI-003, lead decision (36f) of
// 2026-11-21; ota/sdk/README.md §4.1, OADR-0006 point 5 and its note of 2026-11-21). The tabs of a storefront share its
// cookie jar, so two tabs whose access cookie has expired both hold the same `__Host-vx_rt`; the API has no grace
// window, and a second refresh with that cookie is a reuse that revokes the session's family. Where the page has Web
// Locks, every cookie-mode refresh runs under the origin's lock `COOKIE_REFRESH_LOCK`, from before its request until its
// answer is in; a tab whose refresh found the lock held waits (at most the refresh's timeout) and then sends its calls
// once more with the cookies the other tab's answer left, refreshing only when they are refused `TOKEN_EXPIRED` again.
//
// Two client families made with `createVelexisClient` stand for two tabs: they share nothing in the SDK, and here they
// share what two tabs of one origin share, a cookie jar (the fake API's, plus `document.cookie` for the readable CSRF
// cookie) and a lock manager (a fake `navigator.locks` with the Web Locks rules the SDK uses: exclusive locks of one
// name, `ifAvailable`, `signal`, release when the callback settles). The fake API rotates the refresh cookie on every
// refresh and answers a rotated one with `401 REFRESH_TOKEN_REUSED`, revoking the session and clearing both cookies, as
// ota/backend/src/identity/sessions.service.ts and auth.controller.ts do; each request carries the cookies the jar
// holds when it is sent, as a browser attaches them.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVelexisClient } from "../../src/index.js";
import { COOKIE_REFRESH_LOCK, CSRF_COOKIE } from "../../src/internal/session.js";
import { AuthenticationError, ConnectionError, ServerError } from "../../src/shared.js";

/** Fake values with the right shapes; none of them works anywhere. */
const CSRF = "csrf_ki003_first";
const CSRF_NEW = "csrf_ki003_second";
const REFRESH = "/api/v1/auth/refresh";
const ACCOUNT = "/api/v1/account";
const STOREFRONT = "/api/v1/storefront";

/** The readable cookies of the page (`document.cookie`), by name: the CSRF cookie only. */
let readable = new Map();

/**
 * Puts a cookie jar behind `document.cookie`: reading lists the cookies, writing sets one (attributes ignored).
 * @param {Record<string, string>} [cookies]
 */
function useCookies(cookies = {}) {
  readable = new Map(Object.entries(cookies));
  Object.defineProperty(globalThis.document, "cookie", {
    configurable: true,
    get: () => [...readable].map(([name, value]) => `${name}=${value}`).join("; "),
    set: (text) => {
      const [pair = ""] = String(text).split(";");
      const index = pair.indexOf("=");
      readable.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    },
  });
}

afterEach(() => {
  if (globalThis.document) {
    Reflect.deleteProperty(globalThis.document, "cookie");
  }
  Reflect.deleteProperty(globalThis.navigator, "locks");
  vi.useRealTimers();
});

/**
 * A request for a lock, as the fake lock manager keeps it.
 * @typedef {object} LockRequest
 * @property {string} name
 * @property {(lock: { name: string, mode: string } | null) => unknown} callback
 * @property {(value: unknown) => void} resolve
 * @property {(reason: unknown) => void} reject
 */

/**
 * A fake `navigator.locks` with the rules of the Web Locks API that the SDK relies on, for exclusive locks: a request
 * is granted when no one holds the lock and no one waits for it, else it waits in order; `ifAvailable` calls the
 * callback with `null` instead of waiting; a `signal` aborted before the grant removes the request and rejects it with
 * the signal's reason; the lock is released when the callback's promise settles, and the request settles as the
 * callback did. The page's two families (two tabs) share it, as the tabs of one origin share the origin's locks.
 */
function createLockManager() {
  /** @type {LockRequest | null} */
  let holder = null;
  /** @type {LockRequest[]} */
  const queue = [];
  /** @type {{ count: number, resolve: () => void }[]} */
  const watchers = [];
  const notify = () => {
    for (const watcher of [...watchers]) {
      if (queue.length >= watcher.count) {
        watchers.splice(watchers.indexOf(watcher), 1);
        watcher.resolve();
      }
    }
  };
  /** @param {LockRequest} request */
  const grant = (request) => {
    holder = request;
    manager.grants += 1;
    Promise.resolve()
      .then(() => request.callback({ name: request.name, mode: "exclusive" }))
      .then(
        (value) => {
          release();
          request.resolve(value);
        },
        (error) => {
          release();
          request.reject(error);
        },
      );
  };
  const release = () => {
    holder = null;
    const next = queue.shift();
    if (next !== undefined) {
      grant(next);
    }
    notify();
  };
  const manager = {
    /** Every request, in order: its name and whether it asked `ifAvailable` or carried a signal. */
    requests: /** @type {{ name: string, ifAvailable: boolean, signal: boolean }[]} */ ([]),
    /** How many requests were granted. */
    grants: 0,
    /** Whether someone holds the lock now. */
    get held() {
      return holder !== null;
    },
    /** How many requests wait for the lock now. */
    get pending() {
      return queue.length;
    },
    /**
     * Resolves once at least `count` requests wait for the lock.
     * @param {number} count
     * @returns {Promise<void>}
     */
    whenPending(count) {
      return new Promise((resolve) => {
        watchers.push({ count, resolve });
        notify();
      });
    },
    async query() {
      return {
        held: holder === null ? [] : [{ name: holder.name, mode: "exclusive" }],
        pending: queue.map((request) => ({ name: request.name, mode: "exclusive" })),
      };
    },
    /**
     * @param {string} name
     * @param {{ ifAvailable?: boolean, signal?: AbortSignal } | ((lock: unknown) => unknown)} optionsOrCallback
     * @param {(lock: unknown) => unknown} [maybeCallback]
     */
    request(name, optionsOrCallback, maybeCallback) {
      const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      if (callback === undefined) {
        throw new TypeError("fake locks: a request needs a callback");
      }
      manager.requests.push({
        name,
        ifAvailable: options.ifAvailable === true,
        signal: options.signal !== undefined,
      });
      return new Promise((resolve, reject) => {
        const { signal } = options;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        /** @type {LockRequest} */
        const request = { name, callback, resolve, reject };
        const free = holder === null && queue.length === 0;
        if (free) {
          grant(request);
          return;
        }
        if (options.ifAvailable === true) {
          Promise.resolve()
            .then(() => callback(null))
            .then(resolve, reject);
          return;
        }
        queue.push(request);
        signal?.addEventListener(
          "abort",
          () => {
            const index = queue.indexOf(request);
            if (index !== -1) {
              queue.splice(index, 1);
              reject(signal.reason);
            }
          },
          { once: true },
        );
        notify();
      });
    },
  };
  return manager;
}

/**
 * Installs a fake lock manager as the page's `navigator.locks` (happy-dom has none: it answers `null`).
 * @returns {ReturnType<typeof createLockManager>}
 */
function useLocks() {
  const locks = createLockManager();
  Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: locks });
  return locks;
}

/**
 * One request the fake API received: the tab that sent it, the cookies the jar held when it was sent, and its answer.
 * @typedef {object} Seen
 * @property {string} tab
 * @property {string} method
 * @property {string} path
 * @property {{ at: string | undefined, rt: string | undefined }} sent
 * @property {Record<string, string>} headers by lower-case name
 * @property {string | null} body
 * @property {boolean} locked whether a lock was held when it was sent
 * @property {number} sentAt the order in which it was sent (a counter shared with `answeredAt`)
 * @property {number | undefined} answeredAt when it was answered
 * @property {number | undefined} status
 * @property {string | undefined} code
 */

/**
 * An answer of the fake API.
 * @typedef {{ status: number, body?: unknown }} Answer
 */

/**
 * The API's error envelope with this code and status.
 * @param {string} code
 * @param {number} [status]
 * @returns {Answer}
 */
const refusalOf = (code, status = 401) => ({
  status,
  body: { error: { code, message: `Fake ${code}`, status, requestId: "req_ki003" } },
});

/**
 * The fake storefront API behind one browser's cookie jar (see the file header). The session starts with an expired
 * access cookie (the browser has dropped it) and the refresh cookie `rt_1`.
 * @param {{ locks?: { held: boolean } }} [options]
 */
function createWorld(options = {}) {
  let clock = 0;
  let generation = 1;
  /** @type {(() => void)[]} */
  let releaseHeld = [];
  /** @type {{ count: number, resolve: () => void }[]} */
  const watchers = [];
  const world = {
    /** The httpOnly cookies of the browser: what every request carries. */
    jar: /** @type {{ at: string | undefined, rt: string | undefined }} */ ({ at: undefined, rt: "rt_1" }),
    /** The refresh token the API takes now; every other issued one has been rotated. */
    current: "rt_1",
    issued: new Set(["rt_1"]),
    accessTokens: new Set(),
    revoked: false,
    /** @type {Seen[]} */
    requests: [],
    refreshesInFlight: 0,
    maxRefreshesInFlight: 0,
    /** Whether refreshes wait until `release` before the API looks at them. */
    holding: false,
    /** How many refreshes wait now. */
    held: 0,
    /**
     * A refresh's answer instead of the rotation when it gives one (a failure that changes nothing at the API).
     * @type {(seen: Seen) => Answer | undefined}
     */
    refreshFailure: () => undefined,
    /**
     * Holds the answer of a call (not a refresh) until the promise it returns settles, when it returns one.
     * @type {(seen: Seen) => Promise<void> | undefined}
     */
    gate: () => undefined,
    /** Lets every held refresh through, and the later ones at once. */
    release() {
      world.holding = false;
      const waiting = releaseHeld;
      releaseHeld = [];
      for (const resolve of waiting) {
        resolve();
      }
    },
    /**
     * Resolves once at least `count` refreshes are held.
     * @param {number} count
     * @returns {Promise<void>}
     */
    whenHeld(count) {
      return new Promise((resolve) => {
        watchers.push({ count, resolve });
        notify();
      });
    },
    /** The refresh requests, in the order they were sent. */
    refreshes() {
      return world.requests.filter((seen) => seen.path === REFRESH);
    },
    /**
     * The `fetch` of one tab: the shared jar and API, with the tab's name on what it sends.
     * @param {string} tab
     * @returns {typeof globalThis.fetch}
     */
    fetchOf(tab) {
      return async (input, init = {}) => {
        const url = new URL(String(input), "http://storefront.invalid");
        /** @type {Record<string, string>} */
        const headers = {};
        new Headers(init.headers).forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });
        /** @type {Seen} */
        const seen = {
          tab,
          method: (init.method ?? "GET").toUpperCase(),
          path: url.pathname,
          sent: { ...world.jar },
          headers,
          body: typeof init.body === "string" ? init.body : null,
          locked: options.locks?.held ?? false,
          sentAt: (clock += 1),
          answeredAt: undefined,
          status: undefined,
          code: undefined,
        };
        world.requests.push(seen);
        const answer = await answerOf(seen);
        seen.answeredAt = clock += 1;
        seen.status = answer.status;
        seen.code = /** @type {{ error?: { code?: string } } | undefined} */ (answer.body)?.error?.code;
        return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
          status: answer.status,
          headers: { "content-type": "application/json", "x-request-id": "req_ki003" },
        });
      };
    },
  };
  const notify = () => {
    for (const watcher of [...watchers]) {
      if (world.held >= watcher.count) {
        watchers.splice(watchers.indexOf(watcher), 1);
        watcher.resolve();
      }
    }
  };
  const clearSession = () => {
    world.jar = { at: undefined, rt: undefined };
  };
  /**
   * @param {Seen} seen
   * @returns {Promise<Answer>}
   */
  async function answerOf(seen) {
    if (seen.path === STOREFRONT) {
      globalThis.document.cookie = `${CSRF_COOKIE}=${CSRF_NEW}; Path=/; Secure; SameSite=Lax`;
      return { status: 200, body: { id: "sf_1" } };
    }
    if (seen.path !== REFRESH) {
      await world.gate(seen);
      if (world.revoked || (seen.sent.at === undefined && seen.sent.rt === undefined)) {
        return refusalOf("UNAUTHENTICATED");
      }
      if (seen.sent.at !== undefined && world.accessTokens.has(seen.sent.at)) {
        return { status: 200, body: { path: seen.path, accessCookie: seen.sent.at } };
      }
      return refusalOf("TOKEN_EXPIRED");
    }
    world.refreshesInFlight += 1;
    world.maxRefreshesInFlight = Math.max(world.maxRefreshesInFlight, world.refreshesInFlight);
    try {
      if (world.holding) {
        world.held += 1;
        notify();
        await new Promise((resolve) => releaseHeld.push(() => resolve(undefined)));
        world.held -= 1;
      }
      const failure = world.refreshFailure(seen);
      if (failure !== undefined) {
        return failure;
      }
      const presented = seen.sent.rt;
      if (world.revoked || presented === undefined || !world.issued.has(presented)) {
        clearSession();
        return refusalOf("REFRESH_TOKEN_INVALID");
      }
      if (presented !== world.current) {
        // A rotated refresh cookie: a reuse, which revokes the family and clears both cookies (OADR-0006).
        world.revoked = true;
        clearSession();
        return refusalOf("REFRESH_TOKEN_REUSED");
      }
      generation += 1;
      world.current = `rt_${generation}`;
      world.issued.add(world.current);
      world.accessTokens.add(`at_${generation}`);
      world.jar = { at: `at_${generation}`, rt: world.current };
      return { status: 200, body: { customer: { id: "cus_1" }, sessionExpiresAt: "2026-11-21T18:00:00Z" } };
    } finally {
      world.refreshesInFlight -= 1;
    }
  }
  return world;
}

/**
 * One tab: a client family of its own on the shared jar.
 * @param {ReturnType<typeof createWorld>} world
 * @param {string} name
 * @param {import("../../src/shared.js").VelexisClientOptions} [options]
 */
function openTab(world, name, options = {}) {
  return createVelexisClient({ session: "cookie", fetch: world.fetchOf(name), maxRetries: 0, ...options });
}

/**
 * The calls of `tab` to `path`, as `[access cookie sent, status, code]`.
 * @param {ReturnType<typeof createWorld>} world
 * @param {string} tab
 * @param {string} [path]
 */
const callsOf = (world, tab, path = ACCOUNT) =>
  world.requests
    .filter((seen) => seen.tab === tab && seen.path === path)
    .map((seen) => [seen.sent.at, seen.status, seen.code]);

/**
 * How many calls `tab` has sent to `path` so far, the one `world.gate` is asked about included.
 * @param {ReturnType<typeof createWorld>} world
 * @param {string} tab
 * @param {string} [path]
 */
const sentSoFar = (world, tab, path = ACCOUNT) =>
  world.requests.filter((seen) => seen.tab === tab && seen.path === path).length;

/**
 * A gate for the answer of one call (`world.gate`): `hold()` is what the gate returns for that call, `reached`
 * resolves once the call has reached the API, and `open()` lets its answer go.
 */
function createGate() {
  /** @type {() => void} */
  let open = () => {};
  /** @type {() => void} */
  let arrive = () => {};
  /** @type {Promise<void>} */
  const opened = new Promise((resolve) => {
    open = () => resolve();
  });
  /** @type {Promise<void>} */
  const reached = new Promise((resolve) => {
    arrive = () => resolve();
  });
  return {
    open: () => open(),
    reached,
    /** @returns {Promise<void>} */
    hold() {
      arrive();
      return opened;
    },
  };
}

describe("cookie mode: the tabs of one origin refresh one after the other under the Web Lock", () => {
  it("[FIX-W67-KI003 AC2] two tabs whose access cookie expired never have two refreshes in flight: the second waits for the first's lock, sends its call once more with the new access cookie, and the session survives", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const locks = useLocks();
    const world = createWorld({ locks });
    world.holding = true;
    const tabA = openTab(world, "A");
    const tabB = openTab(world, "B");

    const first = tabA.account.get();
    await world.whenHeld(1);
    const second = tabB.account.get();
    // Tab B at its refresh: it waits for tab A's lock, or (without the lock) its refresh is held beside tab A's.
    await Promise.race([locks.whenPending(1), world.whenHeld(2)]);
    expect(world.refreshesInFlight).toBe(1);
    world.release();

    await expect(first).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });
    await expect(second).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });
    expect(world.maxRefreshesInFlight).toBe(1);
    expect(world.revoked).toBe(false);
    expect(world.refreshes().map((seen) => [seen.tab, seen.sent.rt, seen.status, seen.locked])).toEqual([
      ["A", "rt_1", 200, true],
    ]);
    // Tab B: refused, then sent once more after tab A's answer, with the access cookie that answer left.
    expect(callsOf(world, "B")).toEqual([
      [undefined, 401, "TOKEN_EXPIRED"],
      ["at_2", 200, undefined],
    ]);
    const [refreshA] = world.refreshes();
    const [, retryB] = world.requests.filter((seen) => seen.tab === "B" && seen.path === ACCOUNT);
    expect(retryB?.sentAt).toBeGreaterThan(refreshA?.answeredAt ?? Infinity);
    expect(locks.requests.every((request) => request.name === COOKIE_REFRESH_LOCK)).toBe(true);
    expect([locks.held, locks.pending]).toEqual([false, 0]);
  });

  it("[FIX-W67-KI003 AC2] when the first tab's refresh fails without a rotation, the second tab's call is refused again and its own refresh goes out after the first one's answer, under the lock, with the refresh cookie the API still takes", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const locks = useLocks();
    const world = createWorld({ locks });
    world.holding = true;
    // Tab A's refresh fails at the API without a rotation (503): the jar keeps the expired access and `rt_1`.
    world.refreshFailure = (seen) => (seen.tab === "A" ? refusalOf("SERVICE_UNAVAILABLE", 503) : undefined);
    const tabA = openTab(world, "A");
    const tabB = openTab(world, "B");

    const first = tabA.account.get().catch((caught) => caught);
    await world.whenHeld(1);
    const second = tabB.account.get();
    await Promise.race([locks.whenPending(1), world.whenHeld(2)]);
    expect(world.refreshesInFlight).toBe(1);
    world.release();

    expect(await first).toBeInstanceOf(ServerError);
    await expect(second).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });
    expect(world.maxRefreshesInFlight).toBe(1);
    expect(world.revoked).toBe(false);
    const [refreshA, refreshB] = world.refreshes();
    expect(world.refreshes().map((seen) => [seen.tab, seen.sent.rt, seen.status, seen.locked])).toEqual([
      ["A", "rt_1", 503, true],
      ["B", "rt_1", 200, true],
    ]);
    expect(refreshB?.sentAt).toBeGreaterThan(refreshA?.answeredAt ?? Infinity);
    expect(callsOf(world, "B")).toEqual([
      [undefined, 401, "TOKEN_EXPIRED"],
      [undefined, 401, "TOKEN_EXPIRED"],
      ["at_2", 200, undefined],
    ]);
    expect([locks.held, locks.pending]).toEqual([false, 0]);
  });

  it("[FIX-W67-KI003 AC2] a tab whose call was refused after the other tab's refresh had already let go of the lock refreshes at once, with the refresh cookie that refresh left, so it never presents a rotated one", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const locks = useLocks();
    const world = createWorld({ locks });
    /** @type {() => void} */
    let answerB = () => {};
    const heldB = new Promise((resolve) => {
      answerB = () => resolve(undefined);
    });
    // Tab B's first call went out with the expired access cookie; its answer comes after tab A has refreshed.
    world.gate = (seen) => (seen.tab === "B" && seen.sentAt === 1 ? heldB : undefined);
    const tabA = openTab(world, "A");
    const tabB = openTab(world, "B");

    const second = tabB.account.get();
    await expect(tabA.account.get()).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });
    answerB();

    // The lock was free, so tab B refreshed with what the jar holds now (`rt_2`): no reuse, the session lives on.
    await expect(second).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_3" });
    expect(world.refreshes().map((seen) => [seen.tab, seen.sent.rt, seen.status])).toEqual([
      ["A", "rt_1", 200],
      ["B", "rt_2", 200],
    ]);
    expect(world.maxRefreshesInFlight).toBe(1);
    expect(world.revoked).toBe(false);
  });

  it("[FIX-W67-KI003 AC2] a call refused TOKEN_EXPIRED again after another tab's failed refresh still refreshes when a third tab holds the lock by then: it waits for that tab's refresh, then sends its own with the refresh cookie the API still takes", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const locks = useLocks();
    const world = createWorld({ locks });
    world.holding = true;
    // Tabs A and C refresh in vain (503 without a rotation): the jar keeps the expired access and `rt_1`.
    world.refreshFailure = (seen) => (seen.tab === "B" ? undefined : refusalOf("SERVICE_UNAVAILABLE", 503));
    // Tab B's call once more after it waited for tab A's refresh: its answer waits until tab C holds the lock.
    const resendB = createGate();
    world.gate = (seen) =>
      seen.tab === "B" && seen.path === ACCOUNT && sentSoFar(world, "B") === 2 ? resendB.hold() : undefined;
    const tabA = openTab(world, "A");
    const tabB = openTab(world, "B");
    const tabC = openTab(world, "C");

    const first = tabA.account.get().catch((caught) => caught);
    await world.whenHeld(1);
    const second = tabB.account.get();
    await locks.whenPending(1);
    world.release();
    world.holding = true;
    expect(await first).toBeInstanceOf(ServerError);
    await resendB.reached;
    const third = tabC.account.get().catch((caught) => caught);
    await world.whenHeld(1);
    // Tab B's call is refused TOKEN_EXPIRED again while tab C holds the lock: its refresh waits for tab C's.
    resendB.open();
    await locks.whenPending(1);
    expect(world.refreshesInFlight).toBe(1);
    world.release();

    expect(await third).toBeInstanceOf(ServerError);
    await expect(second).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });
    expect(world.refreshes().map((seen) => [seen.tab, seen.sent.rt, seen.status, seen.locked])).toEqual([
      ["A", "rt_1", 503, true],
      ["C", "rt_1", 503, true],
      ["B", "rt_1", 200, true],
    ]);
    const [, refreshC, refreshB] = world.refreshes();
    expect(refreshB?.sentAt).toBeGreaterThan(refreshC?.answeredAt ?? Infinity);
    expect(world.maxRefreshesInFlight).toBe(1);
    expect(world.revoked).toBe(false);
    expect(callsOf(world, "B")).toEqual([
      [undefined, 401, "TOKEN_EXPIRED"],
      [undefined, 401, "TOKEN_EXPIRED"],
      ["at_2", 200, undefined],
    ]);
    expect([locks.held, locks.pending]).toEqual([false, 0]);
  });

  it("[FIX-W67-KI003 AC2] a call whose attempt went out before its tab waited for another tab's failed refresh, and whose TOKEN_EXPIRED comes after, is sent once more and, refused again, refreshes under the lock instead of failing", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const locks = useLocks();
    const world = createWorld({ locks });
    world.holding = true;
    world.refreshFailure = (seen) => (seen.tab === "A" ? refusalOf("SERVICE_UNAVAILABLE", 503) : undefined);
    // Tab B's calls in order: its first call's attempt (refused at once), its second call's attempt (answered late)
    // and its first call's attempt after the wait (answered later still).
    const lateAnswer = createGate();
    const resendFirst = createGate();
    world.gate = (seen) => {
      const sent = seen.tab === "B" ? sentSoFar(world, "B") : 0;
      return sent === 2 ? lateAnswer.hold() : sent === 3 ? resendFirst.hold() : undefined;
    };
    const tabA = openTab(world, "A");
    const tabB = openTab(world, "B");

    const first = tabA.account.get().catch((caught) => caught);
    await world.whenHeld(1);
    const callB = tabB.account.get();
    await locks.whenPending(1);
    const lateB = tabB.request("GET", "/v1/account");
    await lateAnswer.reached;
    world.release();
    expect(await first).toBeInstanceOf(ServerError);
    await resendFirst.reached;
    // Tab B has waited for tab A's refresh, without a refresh of its own; its second call's TOKEN_EXPIRED comes now.
    lateAnswer.open();
    await expect(lateB).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });
    resendFirst.open();
    await expect(callB).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });

    expect(world.refreshes().map((seen) => [seen.tab, seen.sent.rt, seen.status, seen.locked])).toEqual([
      ["A", "rt_1", 503, true],
      ["B", "rt_1", 200, true],
    ]);
    expect(callsOf(world, "B")).toEqual([
      [undefined, 401, "TOKEN_EXPIRED"],
      [undefined, 401, "TOKEN_EXPIRED"],
      [undefined, 401, "TOKEN_EXPIRED"],
      [undefined, 401, "TOKEN_EXPIRED"],
      ["at_2", 200, undefined],
      ["at_2", 200, undefined],
    ]);
    expect(world.maxRefreshesInFlight).toBe(1);
    expect(world.revoked).toBe(false);
    expect([locks.held, locks.pending]).toEqual([false, 0]);
  });

  it("[FIX-W67-KI003 AC2] a call refused TOKEN_EXPIRED again joins its tab's refresh that waits for another tab's lock and makes it refresh after that tab's: the tab sends one refresh, and both its calls get through", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const locks = useLocks();
    const world = createWorld({ locks });
    world.holding = true;
    // Tabs A and C refresh in vain (503 without a rotation): the jar keeps the expired access and `rt_1`.
    world.refreshFailure = (seen) => (seen.tab === "B" ? undefined : refusalOf("SERVICE_UNAVAILABLE", 503));
    // Tab B's first call once more after it waited for tab A's refresh: its answer waits until tab B's second call's
    // refresh waits for tab C's lock.
    const resendB = createGate();
    world.gate = (seen) =>
      seen.tab === "B" && seen.path === ACCOUNT && sentSoFar(world, "B") === 2 ? resendB.hold() : undefined;
    const tabA = openTab(world, "A");
    const tabB = openTab(world, "B");
    const tabC = openTab(world, "C");

    const first = tabA.account.get().catch((caught) => caught);
    await world.whenHeld(1);
    const callB = tabB.account.get();
    await locks.whenPending(1);
    world.release();
    world.holding = true;
    expect(await first).toBeInstanceOf(ServerError);
    await resendB.reached;
    const third = tabC.account.get().catch((caught) => caught);
    await world.whenHeld(1);
    // Tab B's second call is refused: its refresh (not forced) waits for tab C's lock.
    const laterB = tabB.request("GET", "/v1/bookings");
    await locks.whenPending(1);
    // Tab B's first call is refused TOKEN_EXPIRED again and joins that refresh. The SDK handles an answer in promise
    // jobs only, so one macrotask after the API answered, the call has joined.
    resendB.open();
    await vi.waitFor(() =>
      expect(world.requests.filter((seen) => seen.tab === "B")[1]?.answeredAt).toBeDefined(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(locks.requests).toHaveLength(6);
    world.release();

    expect(await third).toBeInstanceOf(ServerError);
    await expect(callB).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });
    await expect(laterB).resolves.toEqual({ path: "/api/v1/bookings", accessCookie: "at_2" });
    expect(world.refreshes().map((seen) => [seen.tab, seen.sent.rt, seen.status, seen.locked])).toEqual([
      ["A", "rt_1", 503, true],
      ["C", "rt_1", 503, true],
      ["B", "rt_1", 200, true],
    ]);
    expect(world.maxRefreshesInFlight).toBe(1);
    expect(world.revoked).toBe(false);
    expect([locks.held, locks.pending]).toEqual([false, 0]);
  });

  it("[FIX-W67-KI003 AC2] one tab still sends one refresh for all its clients' calls refused together, under one request for the lock", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const locks = useLocks();
    const world = createWorld({ locks });
    const tab = openTab(world, "A", { maxRetries: 2 });
    const currencyClient = tab.withOptions({ currency: "EUR" });
    const rulesClient = tab.withOptions({ maxRetries: 0 });

    const results = await Promise.all([
      tab.account.get(),
      currencyClient.account.get(),
      rulesClient.account.get(),
      tab.request("GET", "/v1/account"),
      currencyClient.request("GET", "/v1/account"),
    ]);

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ path: ACCOUNT, accessCookie: "at_2" })));
    expect(world.refreshes().map((seen) => [seen.tab, seen.sent.rt, seen.status, seen.locked])).toEqual([
      ["A", "rt_1", 200, true],
    ]);
    expect(locks.requests).toEqual([{ name: COOKIE_REFRESH_LOCK, ifAvailable: true, signal: false }]);
    expect([locks.held, locks.pending]).toEqual([false, 0]);
  });

  it("[FIX-W67-KI003 AC2] holds the lock for the refresh alone: the missing CSRF cookie is fetched before, and after 403 CSRF_TOKEN_INVALID fetched again with the lock let go, then the refresh is sent once more under it", async () => {
    useCookies();
    const locks = useLocks();
    const world = createWorld({ locks });
    let csrfRefused = false;
    world.refreshFailure = (seen) => {
      if (csrfRefused) {
        return undefined;
      }
      csrfRefused = true;
      expect(seen.headers["x-csrf-token"]).toBe(CSRF_NEW);
      return refusalOf("CSRF_TOKEN_INVALID", 403);
    };
    const tab = openTab(world, "A");

    await expect(tab.account.get()).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });

    expect(world.requests.map((seen) => [seen.method, seen.path, seen.status, seen.locked])).toEqual([
      ["GET", ACCOUNT, 401, false],
      ["GET", STOREFRONT, 200, false],
      ["POST", REFRESH, 403, true],
      ["GET", STOREFRONT, 200, false],
      ["POST", REFRESH, 200, true],
      ["GET", ACCOUNT, 200, false],
    ]);
    // One key for the refresh's two attempts, as `sendWithCsrf` sends a request once more.
    const [firstRefresh, secondRefresh] = world.refreshes();
    expect(firstRefresh?.headers["idempotency-key"]).toBe(secondRefresh?.headers["idempotency-key"]);
    expect(locks.requests).toEqual([
      { name: COOKIE_REFRESH_LOCK, ifAvailable: true, signal: false },
      { name: COOKIE_REFRESH_LOCK, ifAvailable: true, signal: false },
    ]);
  });
});

describe("cookie mode without Web Locks: the refresh as before", () => {
  it("[FIX-W67-KI003 AC3] happy-dom has no navigator.locks, so two tabs refresh as before: each sends its refresh at once, and the second one, presenting the rotated cookie, revokes the session", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    expect(globalThis.navigator.locks ?? undefined).toBeUndefined();
    const world = createWorld();
    world.holding = true;
    const tabA = openTab(world, "A");
    const tabB = openTab(world, "B");

    const first = tabA.account.get().catch((caught) => caught);
    const second = tabB.account.get().catch((caught) => caught);
    await world.whenHeld(2);
    expect(world.refreshesInFlight).toBe(2);
    world.release();

    const errors = await Promise.all([first, second]);
    // One of the two refreshes rotates the cookie, the other presents the rotated one: a reuse (KI-003 as it was).
    expect(
      world
        .refreshes()
        .map((seen) => [seen.sent.rt, seen.status, seen.code])
        .sort(),
    ).toEqual([
      ["rt_1", 200, undefined],
      ["rt_1", 401, "REFRESH_TOKEN_REUSED"],
    ]);
    expect(world.revoked).toBe(true);
    expect(errors.some((error) => error instanceof AuthenticationError)).toBe(true);
  });

  it("[FIX-W67-KI003 AC3] one tab sends the same requests, in the same order and with the same headers, without Web Locks as with them", async () => {
    /** The requests of one tab's refresh, without what differs per run (the Idempotency-Key's value). */
    const run = async (/** @type {boolean} */ withLocks) => {
      useCookies();
      if (withLocks) {
        useLocks();
      } else {
        Reflect.deleteProperty(globalThis.navigator, "locks");
      }
      const world = createWorld();
      const tab = openTab(world, "A");
      await tab.account.get();
      await tab.request("POST", "/v1/account", { body: {} }).catch(() => undefined);
      return world.requests.map((seen) => ({
        method: seen.method,
        path: seen.path,
        body: seen.body,
        sent: seen.sent,
        status: seen.status,
        headers: Object.keys(seen.headers).sort(),
        csrf: seen.headers["x-csrf-token"],
      }));
    };

    const without = await run(false);
    const withLocks = await run(true);

    expect(without.map((request) => `${request.method} ${request.path} ${request.status}`)).toEqual([
      `GET ${ACCOUNT} 401`,
      `GET ${STOREFRONT} 200`,
      `POST ${REFRESH} 200`,
      `GET ${ACCOUNT} 200`,
      `POST ${ACCOUNT} 200`,
    ]);
    expect(withLocks).toEqual(without);
  });

  it("[FIX-W67-KI003 AC3] a call whose attempt went out before its tab's refresh finished is sent once more without another refresh, and a second TOKEN_EXPIRED is thrown, as before", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    expect(globalThis.navigator.locks ?? undefined).toBeUndefined();
    const world = createWorld();
    const BOOKINGS = "/api/v1/bookings";
    // The tab's second call goes out with the expired access cookie; its answer comes after the tab has refreshed.
    const lateAnswer = createGate();
    world.gate = (seen) =>
      seen.path === BOOKINGS && sentSoFar(world, "A", BOOKINGS) === 1 ? lateAnswer.hold() : undefined;
    const tab = openTab(world, "A");

    const first = tab.account.get();
    const late = tab.request("GET", "/v1/bookings").catch((caught) => caught);
    await lateAnswer.reached;
    await expect(first).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });
    // The new access cookie is refused as well (say, it ended at once): the late call is not refreshed for again.
    world.accessTokens.delete("at_2");
    lateAnswer.open();

    const error = await late;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.code).toBe("TOKEN_EXPIRED");
    expect(world.refreshes().map((seen) => [seen.sent.rt, seen.status])).toEqual([["rt_1", 200]]);
    expect(callsOf(world, "A", BOOKINGS)).toEqual([
      [undefined, 401, "TOKEN_EXPIRED"],
      ["at_2", 401, "TOKEN_EXPIRED"],
    ]);
  });

  it("[FIX-W67-KI003 AC3] a page whose Web Locks refuse the request (a document with an opaque origin) refreshes without the lock, as before", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const refusing = {
      request: vi.fn(async () => {
        throw new DOMException("The request was denied.", "SecurityError");
      }),
    };
    Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: refusing });
    const world = createWorld();
    const tab = openTab(world, "A");

    await expect(tab.account.get()).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });

    expect(refusing.request).toHaveBeenCalledTimes(1);
    expect(world.refreshes().map((seen) => [seen.sent.rt, seen.status])).toEqual([["rt_1", 200]]);
  });
});

describe("cookie mode: a refused or stuck refresh never keeps the lock", () => {
  it("[FIX-W67-KI003 AC4] a refused refresh lets go of the lock and rejects the calls waiting for it, with onSessionExpired once; the tab that waited sends its call once more and gets the API's answer for a visitor, without a refresh of its own", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const locks = useLocks();
    const world = createWorld({ locks });
    world.holding = true;
    const expiredA = vi.fn();
    const expiredB = vi.fn();
    const tabA = openTab(world, "A", { onSessionExpired: expiredA });
    const tabB = openTab(world, "B", { onSessionExpired: expiredB });

    const callsA = [
      tabA.account.get().catch((caught) => caught),
      tabA.request("GET", "/v1/account").catch((caught) => caught),
    ];
    await world.whenHeld(1);
    const callB = tabB.account.get().catch((caught) => caught);
    await Promise.race([locks.whenPending(1), world.whenHeld(2)]);
    // The session ended elsewhere meanwhile (signed out on another device): the API refuses tab A's refresh.
    world.revoked = true;
    world.release();

    for (const error of await Promise.all(callsA)) {
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.code).toBe("REFRESH_TOKEN_INVALID");
    }
    expect(expiredA).toHaveBeenCalledTimes(1);
    const errorB = await callB;
    expect(errorB).toBeInstanceOf(AuthenticationError);
    expect(errorB.code).toBe("UNAUTHENTICATED");
    expect(expiredB).not.toHaveBeenCalled();
    expect(world.refreshes().map((seen) => [seen.tab, seen.status, seen.code])).toEqual([
      ["A", 401, "REFRESH_TOKEN_INVALID"],
    ]);
    expect([locks.held, locks.pending]).toEqual([false, 0]);
    // The lock is free: the next request for it is granted at once.
    await expect(
      locks.request(COOKIE_REFRESH_LOCK, { ifAvailable: true }, (lock) => lock !== null),
    ).resolves.toBe(true);
  });

  it("[FIX-W67-KI003 AC4] a refresh that fails on the network lets go of the lock, and the tab's next refresh takes it again", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const locks = useLocks();
    const world = createWorld({ locks });
    let failed = false;
    world.refreshFailure = () => {
      if (failed) {
        return undefined;
      }
      failed = true;
      throw new TypeError("fetch failed");
    };
    const tab = openTab(world, "A");

    const error = await tab.account.get().catch((caught) => caught);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.code).toBe("NETWORK_ERROR");
    expect([locks.held, locks.pending]).toEqual([false, 0]);

    await expect(tab.account.get()).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });
    expect(locks.grants).toBe(2);
  });

  it("[FIX-W67-KI003 AC4] the wait for another holder's lock ends after the refresh's timeout: the call fails with ConnectionError TIMEOUT without sending a refresh, its request for the lock is withdrawn, and a later call refreshes once the holder lets go", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const locks = useLocks();
    const world = createWorld({ locks });
    const expired = vi.fn();
    vi.useFakeTimers();
    // A stuck holder: another tab that took the lock and never lets go.
    /** @type {() => void} */
    let letGo = () => {};
    void locks.request(
      COOKIE_REFRESH_LOCK,
      () => new Promise((resolve) => (letGo = () => resolve(undefined))),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(locks.held).toBe(true);
    // The root's timeout bounds the shared refresh, whichever client's call started it (SDK-017).
    const tab = openTab(world, "B", { timeoutMs: 1_000, onSessionExpired: expired });
    const quickClient = tab.withOptions({ timeoutMs: 50 });

    const failed = quickClient.account.get().catch((caught) => caught);
    await vi.advanceTimersByTimeAsync(999);
    expect(locks.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await failed;

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.code).toBe("TIMEOUT");
    expect(error.message).toBe(
      "Timed out after 1000 ms waiting for another tab's session refresh (POST /v1/auth/refresh)",
    );
    expect(world.refreshes()).toEqual([]);
    expect(locks.pending).toBe(0);
    expect(expired).not.toHaveBeenCalled();

    letGo();
    await vi.advanceTimersByTimeAsync(0);
    const later = tab.account.get();
    await vi.advanceTimersByTimeAsync(0);
    await expect(later).resolves.toEqual({ path: ACCOUNT, accessCookie: "at_2" });
    expect(world.refreshes().map((seen) => [seen.tab, seen.sent.rt, seen.status])).toEqual([
      ["B", "rt_1", 200],
    ]);
  });
});
