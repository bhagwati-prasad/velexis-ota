// Integration tests of @velexis/testing/amadeus (X-027; ADR-0022 item 5): the Amadeus stub of tools/amadeus-stub,
// started in-process on a free port of 127.0.0.1 and driven with fetch, as a backend's Amadeus client drives it. They
// need nothing but the loopback interface (no PostgreSQL, Redis or Mailpit; the global setup of vitest.int.config.ts
// still builds its template database for the other files).
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import * as stubPackage from "@velexis/amadeus-stub";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as amadeusModule from "../../src/amadeus.js";
import {
  OAUTH_TOKEN_PATH,
  SCENARIO_HEADER,
  startAmadeusStub,
  STUB_SCENARIOS,
  stubScenario,
  TIMEOUT_HOLD_MS,
  TOKEN_EXPIRES_IN,
  TOKEN_OPERATION,
  type AmadeusStub,
  type StartAmadeusStubOptions,
  type StubScenario,
  type StubTimers,
} from "../../src/amadeus.js";
import { FakeClock } from "../../src/index.js";

const SEARCH_PATH = "/v2/shopping/flight-offers";
const SEARCH_QUERY = {
  originLocationCode: "MAD",
  destinationLocationCode: "PAR",
  departureDate: "2027-01-15",
  adults: "1",
  max: "2",
} as const;
/** Dummy credentials: the stub accepts any non-empty pair unless it is given its own. Not secrets. */
const CLIENT = { client_id: "velexis-test-client", client_secret: "not-a-real-secret" } as const;

interface TokenBody {
  readonly token_type: string;
  readonly access_token: string;
  readonly expires_in: number;
}
interface SearchBody {
  readonly meta: { readonly count: number };
  readonly data: readonly { readonly id: string }[];
}
interface ErrorBody {
  readonly errors: readonly { readonly status: number; readonly code: number; readonly title: string }[];
}

/** Stubs a test started and has not stopped; `afterEach` stops them when an assertion failed first. */
const running = new Set<AmadeusStub>();

async function start(options?: StartAmadeusStubOptions): Promise<AmadeusStub> {
  const stub = await startAmadeusStub(options);
  running.add(stub);
  return stub;
}

async function stop(stub: AmadeusStub): Promise<void> {
  await stub.stop();
  running.delete(stub);
}

afterEach(async () => {
  await Promise.all([...running].map((stub) => stub.stop()));
  running.clear();
});

function requestToken(
  stub: AmadeusStub,
  headers: Record<string, string> = {},
  credentials: { readonly client_id: string; readonly client_secret: string } = CLIENT,
): Promise<Response> {
  return fetch(`${stub.url}${OAUTH_TOKEN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ grant_type: "client_credentials", ...credentials }).toString(),
  });
}

async function accessToken(stub: AmadeusStub, headers: Record<string, string> = {}): Promise<string> {
  const res = await requestToken(stub, headers);
  expect(res.status).toBe(200);
  const body = (await res.json()) as TokenBody;
  expect(body).toMatchObject({ token_type: "Bearer", expires_in: TOKEN_EXPIRES_IN });
  expect(body.access_token).not.toBe("");
  return body.access_token;
}

function search(stub: AmadeusStub, token: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${stub.url}${SEARCH_PATH}?${new URLSearchParams(SEARCH_QUERY).toString()}`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
}

async function errorCode(res: Response): Promise<number | undefined> {
  return ((await res.json()) as ErrorBody).errors[0]?.code;
}

/** A port is free when this process can listen on it. */
async function expectPortFree(port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => resolve());
  });
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
}

/**
 * Acceptance criterion 1 on a running stub: a token, a search without and a search with `stubScenario("server-error")`,
 * and those three requests in `requests()`. Returns the token. AC2 runs it twice in one test.
 */
async function tokenAndSearches(stub: AmadeusStub): Promise<string> {
  expect(stub.requests()).toEqual([]);
  const token = await accessToken(stub);

  const found = await search(stub, token);
  expect(found.status).toBe(200);
  expect(found.headers.get("content-type")).toBe("application/vnd.amadeus+json");
  const offers = (await found.json()) as SearchBody;
  expect(offers.meta.count).toBe(2);
  expect(offers.data).toHaveLength(2);

  const failed = await search(stub, token, stubScenario("server-error"));
  expect(failed.status).toBe(500);
  expect(((await failed.json()) as ErrorBody).errors).toEqual([
    expect.objectContaining({ status: 500, code: 141, title: "SYSTEM ERROR HAS OCCURRED" }),
  ]);

  const recorded = stub.requests();
  expect(recorded).toHaveLength(3);
  expect(recorded[0]).toMatchObject({
    method: "POST",
    path: OAUTH_TOKEN_PATH,
    query: {},
    headers: { "content-type": "application/x-www-form-urlencoded" },
    operation: TOKEN_OPERATION,
    scenario: "success",
    status: 200,
  });
  expect(recorded[1]).toMatchObject({
    method: "GET",
    path: SEARCH_PATH,
    query: SEARCH_QUERY,
    headers: { authorization: "[REDACTED]" },
    operation: "getFlightOffers",
    scenario: "success",
    status: 200,
  });
  expect(recorded[1]?.headers).not.toHaveProperty("x-stub-scenario");
  expect(recorded[2]).toMatchObject({
    method: "GET",
    path: SEARCH_PATH,
    query: SEARCH_QUERY,
    headers: { authorization: "[REDACTED]", "x-stub-scenario": "server-error" },
    operation: "getFlightOffers",
    scenario: "server-error",
    status: 500,
  });
  for (const request of recorded) {
    expect(request.receivedAt).toBeInstanceOf(Date);
    expect(request.durationMs).toBeGreaterThanOrEqual(0);
  }
  // Neither the token nor the client secret is in the log: headers are redacted, bodies are never recorded.
  const log = JSON.stringify(recorded);
  expect(log).not.toContain(token);
  expect(log).not.toContain(CLIENT.client_secret);
  return token;
}

describe("startAmadeusStub", () => {
  it('starts the stub on a random port, gets a token and searches with and without stubScenario("server-error"), asserting on requests() [X-027 AC1]', async () => {
    const stub = await start();
    expect(stub.port).toBeGreaterThan(0);
    expect(stub.url).toBe(`http://127.0.0.1:${stub.port}`);

    await tokenAndSearches(stub);
  });

  it("stop() frees the port, so the same test runs twice in one process [X-027 AC2]", async () => {
    const first = await start();
    const firstToken = await tokenAndSearches(first);

    // A response that the timeout scenario holds for 30 s does not keep the stub open: stop() drops it.
    const held = requestToken(first, stubScenario("timeout")).then(
      () => "answered",
      () => "dropped",
    );
    await vi.waitFor(() => {
      expect(first.requests().at(-1)).toMatchObject({ operation: TOKEN_OPERATION, scenario: "timeout" });
    });
    expect(first.requests().at(-1)?.status).toBeUndefined();
    await stop(first);
    await expect(first.stop()).resolves.toBeUndefined(); // idempotent
    expect(await held).toBe("dropped");
    await expect(requestToken(first)).rejects.toThrow(TypeError); // nothing listens there any more
    await expectPortFree(first.port);

    // The same test again, on the very port the first stub freed: a new stub with its own tokens and request log.
    const second = await start({ port: first.port });
    expect(second.url).toBe(first.url);
    await tokenAndSearches(second);
    const stale = await search(second, firstToken);
    expect(stale.status).toBe(401);
    expect(await errorCode(stale)).toBe(38190);
    await stop(second);
    await expectPortFree(second.port);
  });

  it("setDefaultScenario() applies to every request without the header; stubScenario() still picks its own", async () => {
    const stub = await start();
    const token = await accessToken(stub);
    stub.clearRequests();
    expect(stub.requests()).toEqual([]);

    stub.setDefaultScenario("rate-limited");
    expect((await search(stub, token)).status).toBe(429);
    expect((await requestToken(stub)).status).toBe(429); // token requests included
    expect((await search(stub, token, stubScenario("success"))).status).toBe(200);
    stub.setDefaultScenario("success");
    expect((await search(stub, token)).status).toBe(200);

    expect(
      stub.requests().map(({ operation, scenario, status }) => ({ operation, scenario, status })),
    ).toEqual([
      { operation: "getFlightOffers", scenario: "rate-limited", status: 429 },
      { operation: TOKEN_OPERATION, scenario: "rate-limited", status: 429 },
      { operation: "getFlightOffers", scenario: "success", status: 200 },
      { operation: "getFlightOffers", scenario: "success", status: 200 },
    ]);
    expect(() => stub.setDefaultScenario("no-such-scenario" as StubScenario)).toThrow(TypeError);
  });

  it("passes defaultScenario, credentials and clock to the stub", async () => {
    const clock = new FakeClock("2026-10-14T08:00:00Z");
    const stub = await start({
      defaultScenario: "server-error",
      credentials: { clientId: CLIENT.client_id, clientSecret: CLIENT.client_secret },
      clock,
    });

    expect((await requestToken(stub)).status).toBe(500);
    const other = { client_id: CLIENT.client_id, client_secret: "another-dummy-value" };
    expect((await requestToken(stub, stubScenario("success"), other)).status).toBe(401);
    const token = await accessToken(stub, stubScenario("success"));
    expect(stub.requests()[0]?.receivedAt).toEqual(new Date("2026-10-14T08:00:00Z"));

    expect((await search(stub, token, stubScenario("success"))).status).toBe(200);
    clock.advance(TOKEN_EXPIRES_IN * 1000 + 1);
    const expired = await search(stub, token, stubScenario("success"));
    expect(expired.status).toBe(401);
    expect(await errorCode(expired)).toBe(38192);
  });

  it("passes timers to the stub, so a test fires the timeout scenario's hold itself", async () => {
    const pending: { readonly callback: () => void; readonly ms: number }[] = [];
    const timers: StubTimers = {
      setTimeout: (callback, ms) => pending.push({ callback, ms }),
      clearTimeout: () => undefined,
    };
    const stub = await start({ timers });
    const token = await accessToken(stub);

    const answer = search(stub, token, stubScenario("timeout"));
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    expect(pending[0]?.ms).toBe(TIMEOUT_HOLD_MS);
    pending[0]?.callback();
    const res = await answer;
    expect(res.status).toBe(504);
    expect(stub.requests().at(-1)).toMatchObject({ scenario: "timeout", status: 504 });
  });

  it("shows the stub's orders and the airline's changes a test plays on them (OBE-045)", async () => {
    const stub = await start();
    expect(stub.orders.list()).toEqual([]);
    // No order yet: the changes find nothing (the stub's own tests play them on stored orders).
    expect(stub.orders.changeSegment("no-such-order", "1", { bookingStatus: "CANCELLED" })).toBeUndefined();
    expect(stub.orders.cancelByAirline("no-such-order")).toBeUndefined();
    expect(() => stub.orders.changeSegment("no-such-order", "1", { departureAt: "tomorrow" })).toThrow(
      TypeError,
    );
    stub.orders.reset();
    expect(stub.orders.list()).toEqual([]);
  });
});

describe("stubScenario", () => {
  it('returns { "X-Stub-Scenario": name } for every scenario the stub knows', () => {
    expect(stubScenario("server-error")).toEqual({ "X-Stub-Scenario": "server-error" });
    expect(SCENARIO_HEADER).toBe("X-Stub-Scenario");
    for (const name of STUB_SCENARIOS) {
      expect(stubScenario(name)).toEqual({ [SCENARIO_HEADER]: name });
    }
  });

  it("takes the scenario names of the stub package and rejects any other", () => {
    // The return type keeps the literal name, and fits fetch's and Supertest's header objects.
    const header: { readonly "X-Stub-Scenario": "timeout" } = stubScenario("timeout");
    const headers: Record<string, string> = { ...header };
    expect(headers).toEqual({ "X-Stub-Scenario": "timeout" });

    // @ts-expect-error: "no-such-scenario" is not a StubScenario of @velexis/amadeus-stub, so it does not compile.
    const misspelt = (): unknown => stubScenario("no-such-scenario");
    expect(misspelt).toThrow(
      new TypeError(`Unknown Amadeus stub scenario; use one of: ${STUB_SCENARIOS.join(", ")}`),
    );
  });
});

describe("the @velexis/testing/amadeus subpath", () => {
  const packageDir = join(__dirname, "..", "..");
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    exports: Record<string, unknown>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  it("is exported from dist/amadeus.js, which tsc builds from src/amadeus.ts", () => {
    expect(manifest.exports["./amadeus"]).toEqual({
      types: "./dist/amadeus.d.ts",
      default: "./dist/amadeus.js",
    });
    const tsconfig = JSON.parse(readFileSync(join(packageDir, "tsconfig.json"), "utf8")) as {
      compilerOptions: { rootDir: string; outDir: string };
    };
    expect(tsconfig.compilerOptions).toMatchObject({ rootDir: "src", outDir: "dist" });
    expect(Object.keys(amadeusModule)).toEqual(
      expect.arrayContaining(["startAmadeusStub", "stubScenario", "STUB_SCENARIOS", "SCENARIO_HEADER"]),
    );
  });

  it("re-exports the stub's own names, so a user of @velexis/testing/amadeus does not list the stub", () => {
    expect(amadeusModule.STUB_SCENARIOS).toBe(stubPackage.STUB_SCENARIOS);
    expect(amadeusModule.SCENARIO_HEADER).toBe(stubPackage.SCENARIO_HEADER);
    expect(amadeusModule.OAUTH_TOKEN_PATH).toBe(stubPackage.OAUTH_TOKEN_PATH);
    expect(amadeusModule.TOKEN_OPERATION).toBe(stubPackage.TOKEN_OPERATION);
    expect(amadeusModule.TOKEN_EXPIRES_IN).toBe(stubPackage.TOKEN_EXPIRES_IN);
    expect(amadeusModule.TIMEOUT_HOLD_MS).toBe(stubPackage.TIMEOUT_HOLD_MS);
    expect(amadeusModule.NO_OFFERS_DESTINATION).toBe(stubPackage.NO_OFFERS_DESTINATION);
  });

  it("lists @velexis/amadeus-stub as a devDependency only (ADR-0022 item 2)", () => {
    expect(manifest.devDependencies?.["@velexis/amadeus-stub"]).toBe("workspace:*");
    expect(manifest.dependencies ?? {}).not.toHaveProperty("@velexis/amadeus-stub");
    expect(manifest.peerDependencies ?? {}).not.toHaveProperty("@velexis/amadeus-stub");
  });
});
