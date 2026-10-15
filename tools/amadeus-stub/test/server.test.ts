import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ConfigError } from "@velexis/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStubCliConfig, startStubCli } from "../src/cli";
import {
  AMADEUS_SPEC_FILES,
  AmadeusSpecs,
  createStubServer,
  loadFixture,
  OAUTH_TOKEN_PATH,
  STUB_OPERATIONS,
  STUB_SCENARIOS,
  TIMEOUT_HOLD_MS,
  TOKEN_EXPIRES_IN,
  type AmadeusIssue,
  type StubServer,
  type StubServerOptions,
  type StubTimers,
} from "../src/index";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SEARCH_PATH = "/v2/shopping/flight-offers";
/** The query of acceptance criterion 2. */
const MAD_PAR = "originLocationCode=MAD&destinationLocationCode=PAR&departureDate=2027-01-15&adults=1";
/** Dummy credentials: the stub accepts any non-empty pair unless it is given its own. */
const CLIENT = { id: "stub-client-id", secret: "not-a-real-secret" };

interface ErrorBody {
  readonly errors: readonly AmadeusIssue[];
}
interface TokenBody {
  readonly type: string;
  readonly client_id: string;
  readonly token_type: string;
  readonly access_token: string;
  readonly expires_in: number;
  readonly state: string;
}
interface OAuthErrorBody {
  readonly error: string;
  readonly error_description: string;
  readonly code: number;
  readonly title: string;
}
interface SearchBody {
  readonly meta: { readonly count: number };
  readonly data: readonly { readonly id: string }[];
  readonly dictionaries?: unknown;
}

const servers: StubServer[] = [];

async function startStub(options: Partial<StubServerOptions> = {}): Promise<StubServer> {
  const server = await createStubServer({ port: 0, ...options });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function tokenRequest(
  stub: StubServer,
  form: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${stub.url}${OAUTH_TOKEN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: form,
  });
}

const CREDENTIALS_FORM = `grant_type=client_credentials&client_id=${CLIENT.id}&client_secret=${CLIENT.secret}`;

async function accessToken(stub: StubServer): Promise<string> {
  const res = await tokenRequest(stub, CREDENTIALS_FORM);
  expect(res.status).toBe(200);
  return (await json<TokenBody>(res)).access_token;
}

async function authorized(stub: StubServer): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await accessToken(stub)}` };
}

/** A valid POST Flight Offers Search body (GetFlightOffersQuery). */
function searchBody(destination = "PAR", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currencyCode: "EUR",
    originDestinations: [
      {
        id: "1",
        originLocationCode: "MAD",
        destinationLocationCode: destination,
        departureDateTimeRange: { date: "2027-01-15", time: "10:00:00" },
      },
    ],
    travelers: [{ id: "1", travelerType: "ADULT" }],
    sources: ["GDS"],
    ...extra,
  };
}

function postSearch(
  stub: StubServer,
  headers: Record<string, string>,
  body: unknown,
  extraHeaders: Record<string, string> = { "x-http-method-override": "GET" },
): Promise<Response> {
  return fetch(`${stub.url}${SEARCH_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/vnd.amadeus+json", ...extraHeaders, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function fixtureBody(): unknown {
  return loadFixture("flight-offers-search", "success").body;
}

/** Timers that only fire when the test says so, for the 30-second `timeout` scenario. */
function manualTimers(): {
  readonly timers: StubTimers;
  readonly pending: Map<number, { readonly callback: () => void; readonly ms: number }>;
  readonly cleared: number[];
} {
  const pending = new Map<number, { readonly callback: () => void; readonly ms: number }>();
  const cleared: number[] = [];
  let next = 1;
  return {
    pending,
    cleared,
    timers: {
      setTimeout(callback, ms) {
        const id = next++;
        pending.set(id, { callback, ms });
        return id;
      },
      clearTimeout(handle) {
        pending.delete(handle as number);
        cleared.push(handle as number);
      },
    },
  };
}

/** Sends one raw HTTP/1.1 request (for request targets `fetch` refuses to send) and resolves with the status line. */
function rawStatusLine(stub: StubServer, requestLine: string): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect(stub.port, stub.host, () => {
      socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("error", fail);
    socket.on("close", () => done(received.split("\r\n")[0] ?? ""));
  });
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  await new Promise<void>((done) => probe.close(() => done()));
  if (address === null || typeof address === "string") {
    throw new Error("no TCP address");
  }
  return address.port;
}

describe("OAuth token endpoint", () => {
  it("issues a client-credentials token like Amadeus and accepts it on a search [X-026 AC1]", async () => {
    const stub = await startStub();
    const res = await tokenRequest(stub, CREDENTIALS_FORM);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const token = await json<TokenBody>(res);
    expect(token).toMatchObject({
      type: "amadeusOAuth2Token",
      client_id: CLIENT.id,
      token_type: "Bearer",
      expires_in: 1799,
      state: "approved",
    });
    expect(token.access_token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(TOKEN_EXPIRES_IN).toBe(1799);

    const search = await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(search.status).toBe(200);
    const again = await accessToken(stub);
    expect(again).not.toBe(token.access_token);
  });

  it("answers 401 invalid_client in the Amadeus format when credentials are missing [X-026 AC1]", async () => {
    const stub = await startStub();
    for (const form of [
      "grant_type=client_credentials",
      `grant_type=client_credentials&client_id=${CLIENT.id}`,
      `grant_type=client_credentials&client_secret=${CLIENT.secret}`,
      "grant_type=client_credentials&client_id=&client_secret=",
    ]) {
      const res = await tokenRequest(stub, form);
      expect(res.status, form).toBe(401);
      expect(await json<OAuthErrorBody>(res)).toEqual({
        error: "invalid_client",
        error_description: "Client credentials are invalid",
        code: 38187,
        title: "Invalid parameters",
      });
    }
  });

  it("answers 400 for a missing or unsupported grant, or a body that is not a form [X-026 AC1]", async () => {
    const stub = await startStub();
    const missing = await tokenRequest(stub, `client_id=${CLIENT.id}&client_secret=${CLIENT.secret}`);
    expect(missing.status).toBe(400);
    expect(await json<OAuthErrorBody>(missing)).toMatchObject({ error: "invalid_request", code: 38187 });

    const password = await tokenRequest(stub, `grant_type=password&client_id=${CLIENT.id}&client_secret=x`);
    expect(password.status).toBe(400);
    expect(await json<OAuthErrorBody>(password)).toMatchObject({
      error: "unsupported_grant_type",
      code: 38187,
    });

    const asJson = await tokenRequest(
      stub,
      JSON.stringify({
        grant_type: "client_credentials",
        client_id: CLIENT.id,
        client_secret: CLIENT.secret,
      }),
      { "content-type": "application/json" },
    );
    expect(asJson.status).toBe(400);
    expect(await json<OAuthErrorBody>(asJson)).toMatchObject({ error: "invalid_request" });
  });

  it("accepts only its configured credentials when it is given some [X-026 AC1]", async () => {
    const stub = await startStub({ credentials: { clientId: CLIENT.id, clientSecret: CLIENT.secret } });
    const wrong = await tokenRequest(
      stub,
      `grant_type=client_credentials&client_id=${CLIENT.id}&client_secret=nope`,
    );
    expect(wrong.status).toBe(401);
    expect(await json<OAuthErrorBody>(wrong)).toMatchObject({ error: "invalid_client" });
    const other = await tokenRequest(
      stub,
      `grant_type=client_credentials&client_id=other&client_secret=${CLIENT.secret}`,
    );
    expect(other.status).toBe(401);
    expect((await tokenRequest(stub, CREDENTIALS_FORM)).status).toBe(200);
  });

  it("answers 401 to a search without a bearer token, with an unknown one or with another scheme [X-026 AC1]", async () => {
    const stub = await startStub();
    const cases: Array<[Record<string, string>, number, string]> = [
      [{}, 38191, "Invalid HTTP header"],
      [{ authorization: "Basic c3R1Yjpub3Bl" }, 38191, "Invalid HTTP header"],
      [{ authorization: "Bearer" }, 38191, "Invalid HTTP header"],
      [{ authorization: "Bearer not-a-token-this-stub-issued" }, 38190, "Invalid access token"],
    ];
    for (const [headers, code, title] of cases) {
      const res = await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, { headers });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/vnd.amadeus+json");
      expect(await json<ErrorBody>(res)).toEqual({
        errors: [expect.objectContaining({ status: 401, code, title })],
      });
    }
    const post = await postSearch(stub, {}, searchBody());
    expect(post.status).toBe(401);
    // Authentication comes before everything else, even an operation that is not stubbed yet.
    const order = await fetch(`${stub.url}/v1/booking/flight-orders/eJzTd9f3NjIxMwYADRkCqQ%3D%3D`);
    expect(order.status).toBe(401);
  });

  it("expires a token after expires_in seconds on the injected clock [X-026 AC1]", async () => {
    let now = Date.parse("2027-01-15T06:00:00.000Z");
    const stub = await startStub({ clock: { now: () => new Date(now) } });
    const headers = await authorized(stub);
    now += (TOKEN_EXPIRES_IN - 1) * 1000;
    expect((await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, { headers })).status).toBe(200);
    now += 1000;
    const expired = await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, { headers });
    expect(expired.status).toBe(401);
    expect(await json<ErrorBody>(expired)).toEqual({
      errors: [expect.objectContaining({ status: 401, code: 38192, title: "Access token expired" })],
    });
    expect(
      (await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, { headers: await authorized(stub) })).status,
    ).toBe(200);
  });

  it("records requests for assertions without a body, a secret or a token [X-026 AC1]", async () => {
    const stub = await startStub();
    const token = await accessToken(stub);
    await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}&max=2`, {
      headers: {
        authorization: `Bearer ${token}`,
        cookie: "session=session-cookie-value",
        "x-stub-scenario": "success",
      },
    });
    const [tokenCall, search] = stub.requests();
    expect(tokenCall).toMatchObject({
      method: "POST",
      path: OAUTH_TOKEN_PATH,
      operation: "oauth2Token",
      status: 200,
    });
    expect(search).toMatchObject({
      method: "GET",
      path: SEARCH_PATH,
      query: {
        originLocationCode: "MAD",
        destinationLocationCode: "PAR",
        departureDate: "2027-01-15",
        adults: "1",
      },
      operation: "getFlightOffers",
      scenario: "success",
      status: 200,
    });
    expect(search?.headers).toMatchObject({ authorization: "[REDACTED]", cookie: "[REDACTED]" });
    expect(search?.receivedAt).toBeInstanceOf(Date);
    const log = JSON.stringify(stub.requests());
    expect(log).not.toContain(token);
    expect(log).not.toContain(CLIENT.secret);
    expect(log).not.toContain("session-cookie-value");
    stub.clearRequests();
    expect(stub.requests()).toEqual([]);
  });
});

describe("Flight Offers Search", () => {
  it("returns the fixture for GET /v2/shopping/flight-offers?originLocationCode=MAD&destinationLocationCode=PAR&departureDate=2027-01-15&adults=1 [X-026 AC2]", async () => {
    const stub = await startStub();
    const res = await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, { headers: await authorized(stub) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.amadeus+json");
    const body = await json<SearchBody>(res);
    expect(body).toEqual(fixtureBody());
    expect(body.meta.count).toBe(body.data.length);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("returns the fixture for the POST form with X-HTTP-Method-Override [X-026 AC2]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const res = await postSearch(stub, headers, searchBody());
    expect(res.status).toBe(200);
    expect(await json<SearchBody>(res)).toEqual(fixtureBody());
    // application/json is accepted as well as Amadeus's own media type.
    const plain = await postSearch(
      stub,
      { ...headers, "content-type": "application/json; charset=utf-8" },
      searchBody(),
    );
    expect(plain.status).toBe(200);
  });

  it("returns at most max offers (GET) or searchCriteria.maxFlightOffers (POST) [X-026 AC2]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const get = await json<SearchBody>(
      await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}&max=2`, { headers }),
    );
    expect(get.data.map((offer) => offer.id)).toEqual(["1", "2"]);
    expect(get.meta.count).toBe(2);
    const post = await json<SearchBody>(
      await postSearch(stub, headers, searchBody("PAR", { searchCriteria: { maxFlightOffers: 3 } })),
    );
    expect(post.data.map((offer) => offer.id)).toEqual(["1", "2", "3"]);
    expect(post.meta.count).toBe(3);
  });

  it("serves a synthetic fixture that matches the Flight Offers Search response schema [X-026 AC2]", () => {
    const fixture = loadFixture("flight-offers-search", "success");
    expect(fixture.fixture).toMatchObject({
      operation: "flight-offers-search",
      scenario: "success",
      source: "synthetic",
      scrubbed: true,
    });
    expect(fixture.status).toBe(200);
    const specs = new AmadeusSpecs();
    const getFlightOffers = STUB_OPERATIONS.find((op) => op.name === "getFlightOffers");
    if (getFlightOffers === undefined) {
      throw new Error("getFlightOffers is missing from the route table");
    }
    const problems = specs.validateResponse(getFlightOffers.spec, 200, fixture.body);
    // The specification declares the dictionaries as objects with a required "key" property, which no Amadeus response
    // has (the codes are the keys). Only that defect is tolerated.
    const specificationDefect = (p: (typeof problems)[number]): boolean =>
      p.keyword === "required" &&
      p.params["missingProperty"] === "key" &&
      ["/dictionaries/locations", "/dictionaries/currencies"].includes(p.instancePath);
    expect(problems.filter((p) => !specificationDefect(p))).toEqual([]);
    // The fixture really is checked: a broken offer is reported.
    const broken = structuredClone(fixture.body) as { data: Array<Record<string, unknown>> };
    delete broken.data[0]?.["id"];
    expect(
      specs.validateResponse(getFlightOffers.spec, 200, broken).filter((p) => !specificationDefect(p)),
    ).toEqual([expect.objectContaining({ instancePath: "/data/0", keyword: "required" })]);
  });

  it("refuses a fixture file without its header or not marked scrubbed", () => {
    const dir = mkdtempSync(join(tmpdir(), "amadeus-stub-fixtures-"));
    try {
      mkdirSync(join(dir, "flight-offers-search"));
      const write = (content: unknown): void =>
        writeFileSync(join(dir, "flight-offers-search", "success.json"), JSON.stringify(content));
      write({ status: 200, body: {} });
      expect(() => loadFixture("flight-offers-search", "success", dir)).toThrow(/not a stub fixture/);
      const header = {
        operation: "flight-offers-search",
        scenario: "success",
        source: "recorded",
        date: "2026-10-14",
      };
      write({ fixture: { ...header, scrubbed: false }, status: 200, body: {} });
      expect(() => loadFixture("flight-offers-search", "success", dir)).toThrow(/scrubbed: true/);
      // A copy is returned: changing it never changes what the next caller gets.
      const copy = loadFixture("flight-offers-search", "success");
      (copy.body as { data: unknown[] }).data.length = 0;
      expect(
        (loadFixture("flight-offers-search", "success").body as { data: unknown[] }).data.length,
      ).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("request validation", () => {
  it("answers 400 naming originLocationCode when a search omits it [X-026 AC3]", async () => {
    const stub = await startStub();
    const res = await fetch(
      `${stub.url}${SEARCH_PATH}?destinationLocationCode=PAR&departureDate=2027-01-15&adults=1`,
      { headers: await authorized(stub) },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/vnd.amadeus+json");
    expect(await json<ErrorBody>(res)).toEqual({
      errors: [
        {
          status: 400,
          code: 32171,
          title: "MANDATORY DATA MISSING",
          detail: "query parameter originLocationCode is required",
          source: { parameter: "originLocationCode" },
        },
      ],
    });
  });

  it("lists every failing query parameter without echoing a value [X-026 AC3]", async () => {
    const stub = await startStub();
    const query =
      "originLocationCode=MAD&destinationLocationCode=PAR&departureDate=not-a-date&adults=10&travelClass=COACH" +
      "&nonStop=perhaps&max=0&max=1&unknownFilter=1";
    const res = await fetch(`${stub.url}${SEARCH_PATH}?${query}`, { headers: await authorized(stub) });
    expect(res.status).toBe(400);
    const { errors } = await json<ErrorBody>(res);
    const byParameter = Object.fromEntries(
      errors.map((issue) => [
        issue.source !== undefined && "parameter" in issue.source ? issue.source.parameter : "",
        issue,
      ]),
    );
    expect(Object.keys(byParameter).sort()).toEqual(
      ["adults", "departureDate", "max", "nonStop", "travelClass", "unknownFilter"].sort(),
    );
    expect(byParameter["departureDate"]).toMatchObject({ code: 477, title: "INVALID FORMAT" });
    expect(byParameter["adults"]).toMatchObject({
      code: 4926,
      detail: "query parameter adults must be <= 9",
    });
    expect(byParameter["travelClass"]).toMatchObject({ code: 572, title: "INVALID OPTION" });
    expect(byParameter["nonStop"]).toMatchObject({
      code: 477,
      detail: "query parameter nonStop must be boolean",
    });
    expect(byParameter["max"]).toMatchObject({ detail: "query parameter max must not be repeated" });
    expect(byParameter["unknownFilter"]).toMatchObject({
      detail: "query parameter unknownFilter is not defined by the specification",
    });
    const text = JSON.stringify(errors);
    expect(text).not.toContain("not-a-date");
    expect(text).not.toContain("perhaps");
    expect(text).not.toContain("COACH");
  });

  it("validates the POST body and headers against the specification [X-026 AC3]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);

    const noOverride = await postSearch(stub, headers, searchBody(), {});
    expect(noOverride.status).toBe(400);
    expect((await json<ErrorBody>(noOverride)).errors).toEqual([
      expect.objectContaining({ code: 32171, source: { parameter: "X-HTTP-Method-Override" } }),
    ]);

    const invalid = await postSearch(stub, headers, {
      ...searchBody(),
      travelers: undefined,
      originDestinations: [
        { id: "1", originLocationCode: "MAD", departureDateTimeRange: { date: "15/01/2027" } },
      ],
    });
    expect(invalid.status).toBe(400);
    const issues = (await json<ErrorBody>(invalid)).errors;
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 32171, source: { pointer: "/travelers" } }),
        expect.objectContaining({
          code: 477,
          source: { pointer: "/originDestinations/0/departureDateTimeRange/date" },
        }),
      ]),
    );
    expect(JSON.stringify(issues)).not.toContain("15/01/2027");

    const notJson = await postSearch(stub, headers, "{ not json");
    expect(notJson.status).toBe(400);
    expect((await json<ErrorBody>(notJson)).errors).toEqual([
      expect.objectContaining({ code: 477, detail: "the request body is not valid JSON" }),
    ]);

    const empty = await postSearch(stub, headers, "");
    expect((await json<ErrorBody>(empty)).errors).toEqual([
      expect.objectContaining({ code: 32171, detail: "the request body is required" }),
    ]);

    const wrongType = await postSearch(stub, { ...headers, "content-type": "text/plain" }, searchBody());
    expect(wrongType.status).toBe(400);
    expect((await json<ErrorBody>(wrongType)).errors).toEqual([
      expect.objectContaining({ code: 477, source: { parameter: "Content-Type" } }),
    ]);
  });

  it("answers 400 to a POST body that is not an object, a double-encoded one included [X-026 AC3]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    // GetFlightOffersQuery declares `properties` but no `type`: without the normalisation these all found offers.
    for (const body of ["null", "[]", "42", JSON.stringify(JSON.stringify(searchBody()))]) {
      const res = await postSearch(stub, headers, body);
      expect(res.status, body).toBe(400);
      expect((await json<ErrorBody>(res)).errors).toEqual([
        {
          status: 400,
          code: 477,
          title: "INVALID FORMAT",
          detail: "request body must be object",
          source: { pointer: "" },
        },
      ]);
    }
    // The object itself still passes, and so does the specification's own example body.
    expect((await postSearch(stub, headers, searchBody())).status).toBe(200);
    const specification = JSON.parse(
      readFileSync(join(REPO_ROOT, "docs/amadeus-api", AMADEUS_SPEC_FILES.FlightOffersSearch), "utf8"),
    ) as { definitions: { GetFlightOffersQuery: { example: unknown } } };
    const example = specification.definitions.GetFlightOffersQuery.example;
    expect(example).toBeTypeOf("object");
    expect((await postSearch(stub, headers, example)).status).toBe(200);
  });

  it("validates before any scenario, so a malformed request fails whatever the scenario [X-026 AC3]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    stub.setDefaultScenario("server-error");
    const res = await fetch(
      `${stub.url}${SEARCH_PATH}?destinationLocationCode=PAR&departureDate=2027-01-15&adults=1`,
      {
        headers,
      },
    );
    expect(res.status).toBe(400);
    const timeout = await fetch(`${stub.url}${SEARCH_PATH}?originLocationCode=MAD`, {
      headers: { ...headers, "X-Stub-Scenario": "timeout" },
    });
    expect(timeout.status).toBe(400);
    // The default scenario of the constructor applies as well: here to the token endpoint itself.
    const failing = await startStub({ defaultScenario: "server-error" });
    expect((await tokenRequest(failing, CREDENTIALS_FORM)).status).toBe(500);
  });

  it("routes the 12 operations of the 9 specifications that the OTA OpenAPI document names [X-026 AC3]", () => {
    expect(STUB_OPERATIONS).toHaveLength(12);
    expect(new Set(STUB_OPERATIONS.map((op) => op.spec.specFile)).size).toBe(9);
    expect(new Set(STUB_OPERATIONS.map((op) => op.name)).size).toBe(12);
    expect(Object.keys(AMADEUS_SPEC_FILES)).toHaveLength(9);

    // Every `x-amadeus` entry of the OTA OpenAPI document is one of the stub's routes, and the other way round. Queue
    // List's entry omits the `/v1` of its specification's server URL.
    const document = readFileSync(
      join(REPO_ROOT, "ota/backend/openapi/velexis-ota-booking-api.openapi.yaml"),
      "utf8",
    );
    const entries = new Set(
      [
        ...document.matchAll(/^\s+- api: (\w+)\n\s+operationId: (.+)\n\s+method: (\w+)\n\s+path: (\S+)$/gm),
      ].map(([, api, operationId, method, path]) => `${api} ${operationId} ${method} ${path}`),
    );
    const routes = new Set(
      STUB_OPERATIONS.map(
        (op) =>
          `${op.api} ${op.operationId} ${op.method} ${op.api === "QueueList" ? op.path.slice(3) : op.path}`,
      ),
    );
    expect(routes).toEqual(entries);
    expect(STUB_OPERATIONS.find((op) => op.name === "listQueue")?.path).toBe("/v1/office/queues/{queue-id}");

    // Each route is its specification's base path (Swagger 2.0 `basePath`, OpenAPI 3 server URL) plus its path key
    // (without Queue List's `GET` prefix), with the specification's method and operationId.
    for (const op of STUB_OPERATIONS) {
      const specification = JSON.parse(
        readFileSync(join(REPO_ROOT, "docs/amadeus-api", op.spec.specFile), "utf8"),
      ) as {
        basePath?: string;
        servers?: readonly { url: string }[];
        paths: Record<string, Record<string, { operationId?: string }>>;
      };
      const server = specification.servers?.[0]?.url;
      const basePath = specification.basePath ?? (server === undefined ? "" : new URL(server).pathname);
      expect(op.path, op.name).toBe(basePath + op.spec.specPath.replace(/^GET(?=\/)/, ""));
      expect(specification.paths[op.spec.specPath]?.[op.method.toLowerCase()]?.operationId, op.name).toBe(
        op.operationId,
      );
    }

    // Each operation's request validator compiles against its specification.
    const specs = new AmadeusSpecs();
    for (const op of STUB_OPERATIONS) {
      expect(() => specs.prepare(op.spec), op.name).not.toThrow();
    }
    expect(specs.danglingRefs()).toEqual([
      "FlightOffersSearch_v2_Version_1.0_swagger_specification.json#/definitions/LoyaltyProgram",
      "FlightOffersSearch_v2_Version_1.0_swagger_specification.json#/definitions/commissionValue",
    ]);
  });

  it("coerces typed path and query parameters of the other specifications", () => {
    const specs = new AmadeusSpecs();
    const listQueue = STUB_OPERATIONS.find((op) => op.name === "listQueue");
    const byReference = STUB_OPERATIONS.find((op) => op.name === "getFlightOrderByReference");
    if (listQueue === undefined || byReference === undefined) {
      throw new Error("missing operations");
    }
    const parts = { headers: {}, body: "" };
    expect(
      specs.validateRequest(listQueue.spec, {
        ...parts,
        query: new URLSearchParams("max=5"),
        pathParams: { "queue-id": "50" },
      }),
    ).toMatchObject({ ok: true, request: { query: { max: 5 } } });
    const notANumber = specs.validateRequest(listQueue.spec, {
      ...parts,
      query: new URLSearchParams(),
      pathParams: { "queue-id": "fifty" },
    });
    expect(notANumber).toMatchObject({
      ok: false,
      issues: [{ code: 477, source: { parameter: "queue-id" } }],
    });
    const missing = specs.validateRequest(byReference.spec, {
      ...parts,
      query: new URLSearchParams(),
      pathParams: {},
    });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.issues.map((issue) => issue.source)).toEqual([
      { parameter: "reference" },
      { parameter: "originSystemCode" },
    ]);
  });
});

describe("scenarios and magic values", () => {
  it("answers 500 for server-error, on searches and on the token endpoint [X-026 AC4]", async () => {
    const stub = await startStub();
    const headers = { ...(await authorized(stub)), "X-Stub-Scenario": "server-error" };
    const search = await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, { headers });
    expect(search.status).toBe(500);
    expect(await json<ErrorBody>(search)).toEqual({
      errors: [
        { status: 500, code: 141, title: "SYSTEM ERROR HAS OCCURRED", detail: "Stub scenario server-error" },
      ],
    });
    const token = await tokenRequest(stub, CREDENTIALS_FORM, { "X-Stub-Scenario": "server-error" });
    expect(token.status).toBe(500);
    expect(stub.requests().at(-1)).toMatchObject({
      operation: "oauth2Token",
      scenario: "server-error",
      status: 500,
    });
  });

  it("answers 429 with Amadeus code 38194 for rate-limited [X-026 AC4]", async () => {
    const stub = await startStub();
    const res = await postSearch(
      stub,
      { ...(await authorized(stub)), "x-stub-scenario": "rate-limited" },
      searchBody(),
    );
    expect(res.status).toBe(429);
    expect(await json<ErrorBody>(res)).toEqual({
      errors: [expect.objectContaining({ status: 429, code: 38194, title: "Too many requests" })],
    });
  });

  it("holds the response of timeout until the client aborts [X-026 AC4]", async () => {
    const { timers, pending, cleared } = manualTimers();
    const stub = await startStub({ timers });
    const headers = { ...(await authorized(stub)), "X-Stub-Scenario": "timeout" };
    const controller = new AbortController();
    const call = fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, { headers, signal: controller.signal });
    await vi.waitFor(() => expect(pending.size).toBe(1));
    expect([...pending.values()][0]?.ms).toBe(30_000);
    expect(TIMEOUT_HOLD_MS).toBe(30_000);
    expect(stub.requests().at(-1)).toMatchObject({ scenario: "timeout", status: undefined });

    controller.abort();
    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(cleared).toHaveLength(1));
    expect(pending.size).toBe(0);
    await vi.waitFor(() => expect(stub.requests().at(-1)?.durationMs).toBeTypeOf("number"));
    expect(stub.requests().at(-1)?.status).toBeUndefined();
  });

  it("answers 504 when timeout has held the response for 30 s [X-026 AC4]", async () => {
    const { timers, pending } = manualTimers();
    const stub = await startStub({ timers });
    const call = tokenRequest(stub, CREDENTIALS_FORM, { "X-Stub-Scenario": "timeout" });
    await vi.waitFor(() => expect(pending.size).toBe(1));
    const [timer] = [...pending.values()];
    timer?.callback();
    const res = await call;
    expect(res.status).toBe(504);
    expect(await json<ErrorBody>(res)).toEqual({
      errors: [
        expect.objectContaining({ status: 504, detail: "Stub scenario timeout: no answer within 30 s" }),
      ],
    });
  });

  it("returns no offers for the destination ZZZ, on GET and POST [X-026 AC4]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    const get = await fetch(
      `${stub.url}${SEARCH_PATH}?originLocationCode=MAD&destinationLocationCode=ZZZ&departureDate=2027-01-15&adults=1`,
      { headers },
    );
    expect(get.status).toBe(200);
    expect(await json<SearchBody>(get)).toEqual({ meta: { count: 0 }, data: [] });
    const post = await postSearch(stub, headers, searchBody("ZZZ"));
    expect(post.status).toBe(200);
    expect(await json<SearchBody>(post)).toEqual({ meta: { count: 0 }, data: [] });
  });

  it("routes each operation to its handler: since OBE-041 none answers 501 not stubbed yet [X-026 AC4]", async () => {
    const stub = await startStub();
    const headers = { ...(await authorized(stub)), "content-type": "application/vnd.amadeus+json" };
    // X-026 answered 501 (stub code 90002) for each operation without a handler; OBE-041 stubbed the last seven.
    expect(STUB_OPERATIONS.filter((op) => op.handler === undefined).map((op) => op.name)).toEqual([]);
    for (const op of STUB_OPERATIONS) {
      const path = op.path
        .replace("{flight-orderId}", "eJzTd9f3NjIxMwYADRkCqQ%3D%3D")
        .replace("{queue-id}", "50");
      const res = await fetch(`${stub.url}${path}`, {
        method: op.method,
        headers,
        ...(op.method === "POST" || op.method === "PATCH" ? { body: "{}" } : {}),
      });
      expect(res.status, op.name).not.toBe(501);
      const body = await res.text();
      expect(body, op.name).not.toContain("NOT STUBBED YET");
      expect(stub.requests().at(-1)?.operation).toBe(op.name);
    }
  });

  it("answers 400 for an unknown scenario name, listing the known ones [X-026 AC4]", async () => {
    const stub = await startStub();
    const res = await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, {
      headers: { ...(await authorized(stub)), "X-Stub-Scenario": "sold-out-typo" },
    });
    expect(res.status).toBe(400);
    expect(await json<ErrorBody>(res)).toEqual({
      errors: [
        {
          status: 400,
          code: 90001,
          title: "UNKNOWN STUB SCENARIO",
          detail: `X-Stub-Scenario must be exactly one of: ${STUB_SCENARIOS.join(", ")}`,
          source: { parameter: "X-Stub-Scenario" },
        },
      ],
    });
  });

  it("applies the default scenario to requests without the header, which overrides it [X-026 AC4]", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    stub.setDefaultScenario("rate-limited");
    expect((await tokenRequest(stub, CREDENTIALS_FORM)).status).toBe(429);
    expect((await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, { headers })).status).toBe(429);
    const optOut = await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, {
      headers: { ...headers, "X-Stub-Scenario": "success" },
    });
    expect(optOut.status).toBe(200);
    stub.setDefaultScenario("success");
    expect((await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, { headers })).status).toBe(200);
    expect(() => stub.setDefaultScenario("no-such-scenario" as never)).toThrow(TypeError);
  });

  it("answers 404 like Amadeus's gateway for an unknown route", async () => {
    const stub = await startStub();
    const headers = await authorized(stub);
    for (const [method, path] of [
      ["GET", "/v1/reference-data/locations"],
      ["PUT", SEARCH_PATH],
      ["GET", OAUTH_TOKEN_PATH],
      ["GET", `${SEARCH_PATH}/`],
    ] as const) {
      const res = await fetch(`${stub.url}${path}`, { method, headers });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await json<ErrorBody>(res)).toEqual({
        errors: [expect.objectContaining({ status: 404, code: 38196, title: "Resource not found" })],
      });
    }
  });

  it("answers 400 to a request target that is not a URL, and keeps serving", async () => {
    const stub = await startStub();
    // An absolute-form target that `new URL` refuses used to throw outside any handler and end the process.
    expect(await rawStatusLine(stub, "GET http://[::1 HTTP/1.1")).toBe("HTTP/1.1 400 Bad Request");
    expect(await rawStatusLine(stub, "GET http://127.0.0.1:99999/v2/shopping/flight-offers HTTP/1.1")).toBe(
      "HTTP/1.1 400 Bad Request",
    );
    expect(stub.requests().at(-1)).toMatchObject({
      path: "http://127.0.0.1:99999/v2/shopping/flight-offers",
      operation: undefined,
      status: 400,
    });
    expect((await tokenRequest(stub, CREDENTIALS_FORM)).status).toBe(200);
  });

  it("answers 413 for a request body over the limit", async () => {
    const stub = await startStub();
    const res = await postSearch(stub, await authorized(stub), `"${"x".repeat(5 * 1024 * 1024)}"`);
    expect(res.status).toBe(413);
  });
});

describe("server lifecycle and CLI", () => {
  it("starts in under 1 s, specifications and fixtures included [X-026 AC5]", async () => {
    const started = performance.now();
    await startStub({ specs: new AmadeusSpecs() });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("frees its port on close(), even while a response is held [X-026 AC5]", async () => {
    const { timers, pending } = manualTimers();
    const first = await createStubServer({ port: 0, timers });
    const call = tokenRequest(first, CREDENTIALS_FORM, { "X-Stub-Scenario": "timeout" });
    await vi.waitFor(() => expect(pending.size).toBe(1));
    await first.close();
    await expect(call).rejects.toThrow();
    expect(pending.size).toBe(0);
    await first.close();

    const second = await startStub({ port: first.port });
    expect(second.url).toBe(`http://127.0.0.1:${first.port}`);
    expect((await tokenRequest(second, CREDENTIALS_FORM)).status).toBe(200);
  });

  it("listens on 127.0.0.1:4900 by default through `pnpm stub:amadeus` [X-026 AC5]", () => {
    expect(readStubCliConfig({})).toEqual({ host: "127.0.0.1", port: 4900 });
    expect(readStubCliConfig({ STUB_PORT: "4901" })).toEqual({ host: "127.0.0.1", port: 4901 });
    expect(() => readStubCliConfig({ STUB_PORT: "not-a-port" })).toThrow(ConfigError);
    expect(() => readStubCliConfig({ STUB_PORT: "not-a-port" })).toThrow(/STUB_PORT/);
    expect(() => readStubCliConfig({ APP_ENV: "production" })).toThrow(/never runs in production/);
    expect(() => readStubCliConfig({ NODE_ENV: "production" })).toThrow(/never runs in production/);

    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const own = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")) as {
      name: string;
      scripts: Record<string, string>;
    };
    expect(root.scripts["stub:amadeus"]).toBe(`pnpm --filter ${own.name} run start`);
    expect(own.scripts["start"]).toMatch(/node dist\/cli\.js$/);
  });

  it("serves through the CLI and prints one line per request without a token or query [X-026 AC5]", async () => {
    let output = "";
    const port = await freePort();
    const stub = await startStubCli({
      env: { STUB_PORT: String(port) },
      stdout: { write: (c: string) => (output += c) },
    });
    servers.push(stub);
    expect(stub.url).toBe(`http://127.0.0.1:${port}`);
    const token = await accessToken(stub);
    await fetch(`${stub.url}${SEARCH_PATH}?${MAD_PAR}`, {
      headers: { authorization: `Bearer ${token}`, "x-stub-scenario": "rate-limited" },
    });
    await vi.waitFor(() => expect(output.split("\n")).toHaveLength(4));
    const [listening, tokenLine, searchLine] = output.split("\n");
    expect(listening).toMatch(
      new RegExp(`^amadeus-stub: listening on http://127\\.0\\.0\\.1:${port} \\(ready in \\d+ ms;`),
    );
    expect(tokenLine).toMatch(/^amadeus-stub: POST \/v1\/security\/oauth2\/token 200 \d+ ms$/);
    expect(searchLine).toMatch(
      /^amadeus-stub: GET \/v2\/shopping\/flight-offers 429 \[rate-limited\] \d+ ms$/,
    );
    expect(output).not.toContain(token);
    expect(output).not.toContain("MAD");
  });
});
