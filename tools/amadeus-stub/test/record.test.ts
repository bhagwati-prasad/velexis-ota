// `record` (X-034): refuses in CI and without credentials, records from a server that speaks Amadeus (the stub, or a
// fake fetch), scrubs and scans before it writes, and never prints the secret or the token.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStubServer, loadFixture, OAUTH_TOKEN_PATH, type StubServer } from "../src/index";
import {
  AMADEUS_RECORD_DEFAULT_BASE_URL,
  findRecordOperation,
  RecordUsageError,
  runRecordCli,
  type RecordCliIo,
} from "../src/record";
import { scanForPersonalData } from "../src/scrub";

/** Dummy credentials; the stub accepts only this pair. */
const CREDENTIALS = { clientId: "record-test-client", clientSecret: "record-test-secret-not-real" };
const CREDENTIAL_ENV = {
  AMADEUS_RECORD_CLIENT_ID: CREDENTIALS.clientId,
  AMADEUS_RECORD_CLIENT_SECRET: CREDENTIALS.clientSecret,
};
const NOW = (): Date => new Date("2027-01-02T09:30:00Z");
const FAKE_TOKEN = "fake-access-token-for-tests";

/** A valid POST Flight Offers Search body (GetFlightOffersQuery). */
const SEARCH_REQUEST = {
  body: {
    currencyCode: "EUR",
    originDestinations: [
      {
        id: "1",
        originLocationCode: "MAD",
        destinationLocationCode: "PAR",
        departureDateTimeRange: { date: "2027-01-15" },
      },
    ],
    travelers: [{ id: "1", travelerType: "ADULT" }],
    sources: ["GDS"],
    searchCriteria: { maxFlightOffers: 2 },
  },
};
const ORDER_ID = "eJzTd9f3NjIJdgMADeQCtg";
const GET_ORDER_REQUEST = { pathParams: { "flight-orderId": ORDER_ID } };

/** A Flight Order Management answer with personal data, as the test environment would send it. */
const ORDER_WITH_PERSONAL_DATA = {
  data: {
    type: "flight-order",
    id: ORDER_ID,
    associatedRecords: [{ reference: "K7M2QF", originSystemCode: "GDS", flightOfferId: "1" }],
    travelers: [
      {
        id: "1",
        dateOfBirth: "1982-01-16",
        name: { firstName: "STEPHANE", lastName: "MARTIN" },
        contact: {
          emailAddress: "stephane.martin@mail.com",
          phones: [{ deviceType: "MOBILE", countryCallingCode: "33", number: "612345678" }],
        },
        documents: [{ documentType: "PASSPORT", number: "512345678", nationality: "FR", holder: true }],
      },
    ],
  },
};
const PERSONAL_VALUES = [
  "STEPHANE",
  "MARTIN",
  "1982-01-16",
  "stephane.martin",
  "612345678",
  "512345678",
  "K7M2QF",
];

class Output {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

interface Workspace {
  /** Where the request file is; relative `--request` paths resolve here. */
  readonly workDir: string;
  /** The fixtures folder `record` writes into. */
  readonly fixtureDir: string;
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const workspaces: string[] = [];
const servers: StubServer[] = [];
const httpServers: Server[] = [];

/** Starts `server` on a free port of 127.0.0.1. */
function listen(server: Server): Promise<void> {
  return new Promise((done) => server.listen(0, "127.0.0.1", done));
}

const serverUrl = (server: Server): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    httpServers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(requests: Record<string, unknown> = {}): Workspace {
  const root = mkdtempSync(join(tmpdir(), "amadeus-stub-record-"));
  workspaces.push(root);
  const workDir = join(root, "work");
  const fixtureDir = join(root, "fixtures");
  mkdirSync(workDir);
  for (const [name, content] of Object.entries(requests)) {
    writeFileSync(join(workDir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return { workDir, fixtureDir };
}

async function startStub(): Promise<StubServer> {
  const server = await createStubServer({ port: 0, credentials: CREDENTIALS });
  servers.push(server);
  return server;
}

async function record(
  args: readonly string[],
  space: Workspace,
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Promise<Run> {
  const stdout = new Output();
  const stderr = new Output();
  const io: RecordCliIo = {
    env,
    stdout,
    stderr,
    cwd: space.workDir,
    fixtureDir: space.fixtureDir,
    now: NOW,
    fetch: fetchImpl,
  };
  const code = await runRecordCli(args, io);
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** A fetch that answers the token request with FAKE_TOKEN and the operation with `status` and `body`. */
function fakeAmadeus(status: number, body: unknown) {
  return vi.fn<typeof fetch>((input) => {
    const url = String(input);
    const response = url.endsWith(OAUTH_TOKEN_PATH)
      ? new Response(JSON.stringify({ access_token: FAKE_TOKEN, expires_in: 1799 }), { status: 200 })
      : new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/vnd.amadeus+json" },
        });
    return Promise.resolve(response);
  });
}

function writtenFiles(space: Workspace): string[] {
  return existsSync(space.fixtureDir)
    ? readdirSync(space.fixtureDir, { recursive: true, encoding: "utf8" }).filter((file) =>
        file.endsWith(".json"),
      )
    : [];
}

function expectNoSecrets(run: Run, ...secrets: readonly string[]): void {
  for (const secret of [CREDENTIALS.clientSecret, ...secrets]) {
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);
  }
}

describe("record: refusals", () => {
  it("exits non-zero with a clear message when CI is set, before reading anything or calling Amadeus [X-034 AC3]", async () => {
    for (const ci of ["true", "1", "false"]) {
      const space = workspace({ "search.json": SEARCH_REQUEST });
      const fetchSpy = fakeAmadeus(200, {});
      const run = await record(
        ["searchFlightOffers", "--request", "search.json"],
        space,
        { ...CREDENTIAL_ENV, CI: ci },
        fetchSpy,
      );

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("refusing to run because CI is set");
      expect(run.stderr).toContain("never runs in CI");
      expect(run.stdout).toBe("");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(writtenFiles(space)).toEqual([]);
      expectNoSecrets(run);
    }
  });

  it("exits non-zero naming the variable when a credential variable is missing or empty [X-034 AC3]", async () => {
    const cases: readonly [string, Record<string, string | undefined>][] = [
      ["AMADEUS_RECORD_CLIENT_ID", { AMADEUS_RECORD_CLIENT_SECRET: CREDENTIALS.clientSecret }],
      ["AMADEUS_RECORD_CLIENT_SECRET", { AMADEUS_RECORD_CLIENT_ID: CREDENTIALS.clientId }],
      ["AMADEUS_RECORD_CLIENT_SECRET", { ...CREDENTIAL_ENV, AMADEUS_RECORD_CLIENT_SECRET: "" }],
    ];
    for (const [missing, env] of cases) {
      const space = workspace({ "search.json": SEARCH_REQUEST });
      const fetchSpy = fakeAmadeus(200, {});
      const run = await record(["searchFlightOffers", "--request", "search.json"], space, env, fetchSpy);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`${missing} is required but missing`);
      expect(run.stderr).toContain(".env.local");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(writtenFiles(space)).toEqual([]);
      expectNoSecrets(run);
    }

    const space = workspace({ "search.json": SEARCH_REQUEST });
    const run = await record(["searchFlightOffers", "--request", "search.json"], space, {});
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("AMADEUS_RECORD_CLIENT_ID is required but missing");
    expect(run.stderr).toContain("AMADEUS_RECORD_CLIENT_SECRET is required but missing");
  });

  it("refuses in production, like the stub", async () => {
    for (const env of [{ APP_ENV: "production" }, { NODE_ENV: "production" }]) {
      const space = workspace({ "search.json": SEARCH_REQUEST });
      const fetchSpy = fakeAmadeus(200, {});
      const run = await record(
        ["searchFlightOffers", "--request", "search.json"],
        space,
        { ...CREDENTIAL_ENV, ...env },
        fetchSpy,
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("refusing to run in production");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(writtenFiles(space)).toEqual([]);
    }
  });

  it("refuses a base URL with a user, a password, a query or a fragment, without quoting it", async () => {
    for (const url of [
      "https://recorder:base-url-password-not-real@test.travel.api.amadeus.com",
      "https://test.travel.api.amadeus.com/?base-url-password-not-real",
      "https://test.travel.api.amadeus.com/#base-url-password-not-real",
    ]) {
      const space = workspace({ "search.json": SEARCH_REQUEST });
      const fetchSpy = fakeAmadeus(200, {});
      const run = await record(
        ["searchFlightOffers", "--request", "search.json"],
        space,
        { ...CREDENTIAL_ENV, AMADEUS_RECORD_BASE_URL: url },
        fetchSpy,
      );
      expect(run.code, url).toBe(1);
      expect(run.stderr).toContain("must be a plain base URL");
      expectNoSecrets(run, "base-url-password-not-real");
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("sends the secret over https only, apart from this machine", async () => {
    const space = workspace({ "search.json": SEARCH_REQUEST });
    const fetchSpy = fakeAmadeus(200, {});
    const run = await record(
      ["searchFlightOffers", "--request", "search.json"],
      space,
      { ...CREDENTIAL_ENV, AMADEUS_RECORD_BASE_URL: "http://test.travel.api.amadeus.com" },
      fetchSpy,
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("must use https");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 2 with the usage to a command line it cannot use, without echoing what was typed", async () => {
    const space = workspace({ "search.json": SEARCH_REQUEST });
    const commands: readonly (readonly string[])[] = [
      [],
      ["searchFlightOffers"],
      ["sk_live_typed_by_mistake", "--request", "search.json"],
      ["flight-offers-search", "--request", "search.json"],
      ["searchFlightOffers", "getFlightOffers", "--request", "search.json"],
      ["searchFlightOffers", "--request", "search.json", "--scenario", "../escape"],
      ["searchFlightOffers", "--request", "search.json", "--client-secret=sk_live_typed_by_mistake"],
    ];
    for (const args of commands) {
      const fetchSpy = fakeAmadeus(200, {});
      const run = await record(args, space, CREDENTIAL_ENV, fetchSpy);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stderr).toContain("usage: pnpm --filter @velexis/amadeus-stub record <operation>");
      expect(run.stderr).not.toContain("sk_live_typed_by_mistake");
      expect(fetchSpy).not.toHaveBeenCalled();
    }
    const help = await record(["--help"], space, CREDENTIAL_ENV);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("AMADEUS_RECORD_CLIENT_SECRET");
  });

  it("refuses a request file it cannot read, without quoting its content", async () => {
    const space = workspace({
      "broken.json": '{ "body": { "travelers": [ { "name": "STEPHANE MARTIN" ',
      "unknown.json": { headers: { authorization: "Bearer x" } },
    });
    const missing = await record(["searchFlightOffers", "-r", "absent.json"], space, CREDENTIAL_ENV);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("cannot read the request file");

    const broken = await record(["searchFlightOffers", "-r", "broken.json"], space, CREDENTIAL_ENV);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("is not valid JSON");
    expect(broken.stderr).not.toContain("STEPHANE");

    const unknown = await record(["searchFlightOffers", "-r", "unknown.json"], space, CREDENTIAL_ENV);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('may only have "query", "pathParams" and "body"');
  });

  it("validates the request against the specification before it asks for a token", async () => {
    const space = workspace({ "search.json": { query: { destinationLocationCode: "PAR", adults: 1 } } });
    const fetchSpy = fakeAmadeus(200, {});
    const run = await record(["getFlightOffers", "-r", "search.json"], space, CREDENTIAL_ENV, fetchSpy);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("does not match the FlightOffersSearch specification");
    expect(run.stderr).toContain("query parameter originLocationCode is required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a refused token request without the secret", async () => {
    const stub = await startStub();
    const space = workspace({ "search.json": SEARCH_REQUEST });
    const run = await record(["searchFlightOffers", "-r", "search.json"], space, {
      AMADEUS_RECORD_BASE_URL: stub.url,
      AMADEUS_RECORD_CLIENT_ID: CREDENTIALS.clientId,
      AMADEUS_RECORD_CLIENT_SECRET: "another-secret-not-real",
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("the token request failed: HTTP 401 (invalid_client");
    expect(run.stderr).not.toContain("another-secret-not-real");
    expect(writtenFiles(space)).toEqual([]);
  });

  it("refuses an access_token that is not a bearer token, without quoting it", async () => {
    const space = workspace({ "order.json": GET_ORDER_REQUEST });
    const fetchSpy = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ access_token: "odd\ntoken-not-real" }), { status: 200 })),
    );
    const run = await record(["getFlightOrder", "-r", "order.json"], space, CREDENTIAL_ENV, fetchSpy);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("has an access_token that is not a bearer token");
    expectNoSecrets(run, "token-not-real");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(writtenFiles(space)).toEqual([]);
  });

  it("names a failed request by its error's name or code, never by a message that may quote what was sent", async () => {
    const failing = (error: Error) =>
      vi.fn<typeof fetch>((input) =>
        String(input).endsWith(OAUTH_TOKEN_PATH)
          ? Promise.resolve(new Response(JSON.stringify({ access_token: FAKE_TOKEN }), { status: 200 }))
          : Promise.reject(error),
      );
    const space = workspace({ "order.json": GET_ORDER_REQUEST });

    // undici quotes an invalid header value, which would be the Authorization header.
    const quoting = await record(
      ["getFlightOrder", "-r", "order.json"],
      space,
      CREDENTIAL_ENV,
      failing(new TypeError(`Headers.append: "Bearer ${FAKE_TOKEN}" is an invalid header value.`)),
    );
    expect(quoting.code).toBe(1);
    expect(quoting.stderr).toContain(
      "the getFlightOrder request to test.travel.api.amadeus.com failed: TypeError",
    );
    expectNoSecrets(quoting, FAKE_TOKEN);

    const refused = await record(
      ["getFlightOrder", "-r", "order.json"],
      space,
      CREDENTIAL_ENV,
      failing(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        }),
      ),
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("failed: fetch failed (ECONNREFUSED)");
    expect(writtenFiles(space)).toEqual([]);
  });

  it("never follows a redirect, so the secret reaches the configured host only", async () => {
    const elsewhere: string[] = [];
    const target = createServer((request, response) => {
      elsewhere.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const redirecting = createServer((request, response) => {
      response.writeHead(307, { location: `${serverUrl(target)}${request.url ?? "/"}` }).end();
    });
    httpServers.push(target, redirecting);
    await Promise.all([listen(target), listen(redirecting)]);

    const space = workspace({ "search.json": SEARCH_REQUEST });
    const run = await record(["searchFlightOffers", "-r", "search.json"], space, {
      ...CREDENTIAL_ENV,
      AMADEUS_RECORD_BASE_URL: serverUrl(redirecting),
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("the token request to 127.0.0.1:");
    expect(run.stderr).toContain("answered with a redirect, which record never follows");
    expect(elsewhere).toEqual([]);
    expectNoSecrets(run);
    expect(writtenFiles(space)).toEqual([]);
  });
});

describe("record: recording", () => {
  it("records a fixture from the stub with its header, and never prints the secret or the token", async () => {
    const stub = await startStub();
    const space = workspace({ "search.json": SEARCH_REQUEST });
    const tokens: string[] = [];
    const capturing = vi.fn<typeof fetch>(async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith(OAUTH_TOKEN_PATH)) {
        tokens.push(((await response.clone().json()) as { access_token: string }).access_token);
      }
      return response;
    });

    const run = await record(
      ["searchFlightOffers", "--request", "search.json", "--scenario", "recorded-probe"],
      space,
      { ...CREDENTIAL_ENV, AMADEUS_RECORD_BASE_URL: stub.url },
      capturing,
    );

    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("searchFlightOffers POST /v2/shopping/flight-offers on 127.0.0.1:");
    expect(run.stdout).toContain("HTTP 200 in ");
    expect(run.stdout).toContain("wrote fixtures/flight-offers-search/recorded-probe.json (new file)");
    expect(tokens).toHaveLength(1);
    expectNoSecrets(run, tokens[0] ?? "");

    const fixture = loadFixture("flight-offers-search", "recorded-probe", space.fixtureDir);
    expect(fixture.fixture).toEqual({
      operation: "flight-offers-search",
      scenario: "recorded-probe",
      source: "recorded",
      date: "2027-01-02",
      scrubbed: true,
      description: expect.stringContaining("searchFlightOffers (POST /v2/shopping/flight-offers)"),
    });
    expect(fixture.status).toBe(200);
    const served = loadFixture("flight-offers-search", "success").body as { data: unknown[] };
    expect((fixture.body as { data: unknown[] }).data).toEqual(served.data.slice(0, 2));
    expect(scanForPersonalData(fixture)).toEqual([]);

    // Exactly one token request and one search, with the method override Amadeus requires and the token.
    expect(stub.requests().map((request) => [request.method, request.path, request.status])).toEqual([
      ["POST", OAUTH_TOKEN_PATH, 200],
      ["POST", "/v2/shopping/flight-offers", 200],
    ]);
    expect(stub.requests()[1]?.headers).toMatchObject({
      "x-http-method-override": "GET",
      authorization: "[REDACTED]",
      "content-type": "application/vnd.amadeus+json",
    });

    // Recording again replaces the file.
    const again = await record(["searchFlightOffers", "-r", "search.json", "-s", "recorded-probe"], space, {
      ...CREDENTIAL_ENV,
      AMADEUS_RECORD_BASE_URL: stub.url,
    });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("recorded-probe.json (replaced)");
  });

  it("scrubs the response before it writes it, and writes success.json by default", async () => {
    const space = workspace({ "order.json": GET_ORDER_REQUEST });
    const fetchSpy = fakeAmadeus(200, ORDER_WITH_PERSONAL_DATA);
    const run = await record(["getFlightOrder", "--request", "order.json"], space, CREDENTIAL_ENV, fetchSpy);

    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("on test.travel.api.amadeus.com");
    expect(run.stdout).toContain(
      "replaced names 2, datesOfBirth 1, documents 1, emails 1, phones 1, recordLocators 1, orderIds 1",
    );
    expectNoSecrets(run, FAKE_TOKEN);

    // The default host, the path parameter and the bearer token.
    const [tokenCall, orderCall] = fetchSpy.mock.calls;
    expect(String(tokenCall?.[0])).toBe(`${AMADEUS_RECORD_DEFAULT_BASE_URL}${OAUTH_TOKEN_PATH}`);
    expect(String(tokenCall?.[1]?.body)).toContain("grant_type=client_credentials");
    expect(tokenCall?.[1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(String(orderCall?.[0])).toBe(
      `${AMADEUS_RECORD_DEFAULT_BASE_URL}/v1/booking/flight-orders/${ORDER_ID}`,
    );
    expect(orderCall?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { accept: "application/vnd.amadeus+json", authorization: `Bearer ${FAKE_TOKEN}` },
    });

    expect(writtenFiles(space)).toEqual([join("flight-order-management", "success.json")]);
    const text = readFileSync(join(space.fixtureDir, "flight-order-management", "success.json"), "utf8");
    for (const value of [...PERSONAL_VALUES, ORDER_ID]) {
      expect(text).not.toContain(value);
    }
    const fixture = loadFixture("flight-order-management", "success", space.fixtureDir);
    expect(scanForPersonalData(fixture)).toEqual([]);
    expect(fixture.body).toMatchObject({
      data: {
        type: "flight-order",
        travelers: [{ id: "1", name: { firstName: "ALEX", lastName: "TESTER" }, dateOfBirth: "1982-01-01" }],
      },
    });
  });

  it("writes nothing when the scrubbed response still holds personal data", async () => {
    const space = workspace({ "order.json": GET_ORDER_REQUEST });
    const run = await record(
      ["getFlightOrder", "-r", "order.json"],
      space,
      CREDENTIAL_ENV,
      fakeAmadeus(200, { data: { type: "flight-order", id: "X", paidWith: 4242424242424242 } }),
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("still holds personal data, so nothing was written");
    expect(run.stderr).toContain("/body/data/paidWith");
    expect(run.stderr).not.toContain("4242424242424242");
    expect(writtenFiles(space)).toEqual([]);
  });

  it("records an error response only under a scenario name", async () => {
    const error = {
      errors: [{ status: 400, code: 477, title: "INVALID FORMAT", detail: "invalid query parameter format" }],
    };
    const space = workspace({ "order.json": GET_ORDER_REQUEST });
    const asSuccess = await record(
      ["getFlightOrder", "-r", "order.json"],
      space,
      CREDENTIAL_ENV,
      fakeAmadeus(400, error),
    );
    expect(asSuccess.code).toBe(1);
    expect(asSuccess.stderr).toContain("answered HTTP 400, which is not a success");
    expect(writtenFiles(space)).toEqual([]);

    const asScenario = await record(
      ["getFlightOrder", "-r", "order.json", "-s", "invalid-format"],
      space,
      CREDENTIAL_ENV,
      fakeAmadeus(400, error),
    );
    expect(asScenario.code).toBe(0);
    const fixture = loadFixture("flight-order-management", "invalid-format", space.fixtureDir);
    expect(fixture.status).toBe(400);
    expect(fixture.body).toEqual(error);
  });

  it("finds an operation by its name or by the fixture folder of an API with one operation", () => {
    expect(findRecordOperation("createFlightOrders").path).toBe("/v1/booking/flight-orders");
    expect(findRecordOperation("flight-create-orders").name).toBe("createFlightOrders");
    expect(findRecordOperation("flight-availabilities").name).toBe("searchFlightAvailabilities");
    expect(() => findRecordOperation("flight-order-management")).toThrow(RecordUsageError);
    expect(() => findRecordOperation("flight-order-management")).toThrow(
      "name one: getFlightOrder, patchFlightOrder, cancelFlightOrder",
    );
  });
});
