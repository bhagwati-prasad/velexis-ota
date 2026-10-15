// record.ts: `pnpm --filter @velexis/amadeus-stub record <operation> --request <file.json> [--scenario <name>]`, which
// records one fixture from the real Amadeus test environment (X-034, ADR-0015).
//
// It reads AMADEUS_RECORD_BASE_URL (default: the Amadeus Enterprise test host), AMADEUS_RECORD_CLIENT_ID and
// AMADEUS_RECORD_CLIENT_SECRET from the environment only (the shell, or a git-ignored `.env.local`; never a flag or the
// request file). It validates the request against the operation's specification, requests a token
// (`client_credentials`), sends the request, scrubs the response (src/scrub.ts), scans the result for personal data
// and writes `fixtures/<folder>/<scenario>.json` with the fixture header (operation, scenario, `source: "recorded"`,
// date, `scrubbed: true`). The scan must find nothing, or nothing is written.
//
// It refuses to run when CI is set (to a non-empty value): recording calls the real test environment with a developer's
// own credentials. Like the stub, it refuses when APP_ENV or NODE_ENV is `production`. It never follows a redirect, so
// the secret and the token reach the configured host only. It never prints the client secret, the token, a header or
// a body: only the operation, the host, the status, the duration, the replacement counts and the file it wrote. Exit
// codes: 0 written, 1 refused or failed, 2 usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
  ConfigError,
  defineConfig,
  env,
  type ConfigOf,
  type ConfigSchema,
  type EnvSource,
} from "@velexis/config";
import { OAUTH_TOKEN_PATH } from "./oauth";
import {
  FIXTURE_DIR,
  STUB_OPERATIONS,
  type AmadeusApi,
  type Fixture,
  type OperationName,
  type StubOperation,
} from "./routes";
import type { AmadeusIssue } from "./scenarios";
import { scanForPersonalData, scrub, SCRUB_CATEGORIES, type ScanFinding, type ScrubResult } from "./scrub";
import { AmadeusSpecs, type RequestParts } from "./validate";

/** The command name after `node dist/cli.js`. */
export const RECORD_COMMAND = "record";

/** The Amadeus Enterprise test host (ADR-0012; docs/mvp/plans/roadmap.md, external dependencies). */
export const AMADEUS_RECORD_DEFAULT_BASE_URL = "https://test.travel.api.amadeus.com";

/** How long the token request and the operation may take each. */
export const RECORD_TIMEOUT_MS = 60_000;

/** The scenario of a fixture recorded without `--scenario`. */
export const DEFAULT_RECORD_SCENARIO = "success";

/**
 * The fixture folder of each API: the API in kebab case (fixtures/README.md), except Flight Availabilities Search,
 * whose folder OBE-019 names `flight-availabilities`.
 */
export const FIXTURE_FOLDERS: Readonly<Record<AmadeusApi, string>> = Object.freeze({
  FlightOffersSearch: "flight-offers-search",
  FlightAvailabilitiesSearch: "flight-availabilities",
  BrandedFaresUpsell: "branded-fares-upsell",
  FlightOffersPrice: "flight-offers-price",
  FlightCreateOrders: "flight-create-orders",
  FlightOrderIssue: "flight-order-issue",
  FlightOrderManagement: "flight-order-management",
  GetFlightOrderByRecordLocator: "get-flight-order-by-record-locator",
  QueueList: "queue-list",
});

/** The POST searches that Amadeus answers only with `X-HTTP-Method-Override: GET` (their specifications require it). */
const METHOD_OVERRIDE_OPERATIONS: ReadonlySet<OperationName> = new Set([
  "searchFlightOffers",
  "searchFlightAvailabilities",
]);

const AMADEUS_JSON = "application/vnd.amadeus+json";
/** A scenario is a file name: lower-case words joined by hyphens. */
const SCENARIO_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A query parameter value of the request file; an array is sent comma-separated. */
export type RecordQueryValue = string | number | boolean | readonly (string | number | boolean)[];

/** The request file of `--request`: every part optional, as the operation needs it. */
export interface RecordRequest {
  readonly query?: Readonly<Record<string, RecordQueryValue>>;
  readonly pathParams?: Readonly<Record<string, string>>;
  /** The JSON body of a POST or PATCH, as Amadeus expects it (`{ "data": { ... } }`). */
  readonly body?: unknown;
}

/** A refusal or failure of `record`, with a message that names no secret, token or body content. */
export class RecordError extends Error {
  override readonly name: string = "RecordError";
}

/** A command line `record` cannot use (exit code 2). */
export class RecordUsageError extends RecordError {
  override readonly name = "RecordUsageError";
}

export interface RecordOptions {
  readonly operation: StubOperation;
  readonly request: RecordRequest;
  /** Default `success`. */
  readonly scenario?: string | undefined;
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Default: the package's fixtures folder. */
  readonly fixtureDir?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  /** The clock of the header's date. */
  readonly now?: (() => Date) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly specs?: AmadeusSpecs | undefined;
}

export interface RecordResult {
  readonly file: string;
  /** `false` when the file existed and was replaced. */
  readonly created: boolean;
  readonly status: number;
  readonly durationMs: number;
  readonly replaced: ScrubResult["replaced"];
  /** Differences between the scrubbed body and the response schema, or `undefined` when the status has none. */
  readonly schemaProblems: number | undefined;
  readonly fixture: Fixture;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** The operation of `name`: a stub operation name, or the fixture folder of an API with a single operation. */
export function findRecordOperation(name: string): StubOperation {
  const byName = STUB_OPERATIONS.find((operation) => operation.name === name);
  if (byName !== undefined) {
    return byName;
  }
  const inFolder = STUB_OPERATIONS.filter((operation) => FIXTURE_FOLDERS[operation.api] === name);
  const [only] = inFolder;
  if (only !== undefined && inFolder.length === 1) {
    return only;
  }
  if (inFolder.length > 1) {
    throw new RecordUsageError(
      `${name} has ${inFolder.length} operations; name one: ${inFolder.map((operation) => operation.name).join(", ")}`,
    );
  }
  // The name is not echoed: whatever was typed there (a pasted secret) must not reach the terminal log.
  throw new RecordUsageError("unknown operation (the usage below lists them)");
}

/** Checks the shape of a parsed request file. */
export function parseRecordRequest(raw: unknown): RecordRequest {
  if (!isRecord(raw)) {
    throw new RecordError('the request file must hold a JSON object { "query"?, "pathParams"?, "body"? }');
  }
  const unknownKeys = Object.keys(raw).filter(
    (key) => key !== "query" && key !== "pathParams" && key !== "body",
  );
  if (unknownKeys.length > 0) {
    throw new RecordError(
      `the request file may only have "query", "pathParams" and "body", not ${unknownKeys.map((key) => JSON.stringify(key)).join(", ")}`,
    );
  }
  const { query, pathParams } = raw;
  if (
    query !== undefined &&
    !(
      isRecord(query) &&
      Object.values(query).every(
        (value) => isScalar(value) || (Array.isArray(value) && value.every(isScalar)),
      )
    )
  ) {
    throw new RecordError('"query" must be an object of strings, numbers, booleans or arrays of them');
  }
  if (
    pathParams !== undefined &&
    !(isRecord(pathParams) && Object.values(pathParams).every((v) => typeof v === "string"))
  ) {
    throw new RecordError('"pathParams" must be an object of strings');
  }
  return raw as RecordRequest;
}

function pathParamNames(operation: StubOperation): string[] {
  return [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? "");
}

interface PreparedRequest {
  readonly parts: RequestParts;
  readonly headers: Readonly<Record<string, string>>;
  readonly path: string;
}

function prepareRequest(operation: StubOperation, request: RecordRequest): PreparedRequest {
  const names = pathParamNames(operation);
  const pathParams = request.pathParams ?? {};
  const missing = names.filter((name) => (pathParams[name] ?? "") === "");
  if (missing.length > 0) {
    throw new RecordError(
      `${operation.name} needs "pathParams": { ${missing.map((n) => `"${n}"`).join(", ")} }`,
    );
  }
  const extra = Object.keys(pathParams).filter((name) => !names.includes(name));
  if (extra.length > 0) {
    throw new RecordError(`${operation.name} has no path parameter ${extra.map((n) => `"${n}"`).join(", ")}`);
  }
  const takesBody = operation.method === "POST" || operation.method === "PATCH";
  if (!takesBody && request.body !== undefined) {
    throw new RecordError(`${operation.name} (${operation.method}) takes no body`);
  }

  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(request.query ?? {})) {
    query.set(name, Array.isArray(value) ? value.map(String).join(",") : String(value));
  }
  const headers: Record<string, string> = { accept: AMADEUS_JSON };
  const body = request.body === undefined ? "" : JSON.stringify(request.body);
  if (body !== "") {
    headers["content-type"] = AMADEUS_JSON;
  }
  if (METHOD_OVERRIDE_OPERATIONS.has(operation.name)) {
    headers["x-http-method-override"] = "GET";
  }
  const search = query.toString();
  const path =
    operation.path.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(pathParams[name] ?? "")) +
    (search === "" ? "" : `?${search}`);
  return { parts: { query, headers, pathParams, body }, headers, path };
}

const formatIssue = (issue: AmadeusIssue): string =>
  `  - ${issue.code} ${issue.title}${issue.detail === undefined ? "" : `: ${issue.detail}`}`;

/** undici's fixed message for a network failure, and its cause when `redirect: "error"` met a redirect. */
const FETCH_FAILED = "fetch failed";
const UNEXPECTED_REDIRECT = "unexpected redirect";

function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `no answer within ${Math.round(timeoutMs / 1000)} s`;
  }
  if (!(error instanceof Error)) {
    return `unexpected ${typeof error}`;
  }
  const cause = error.cause;
  if (cause instanceof Error && cause.message === UNEXPECTED_REDIRECT) {
    return "it answered with a redirect, which record never follows (the secret and the token go to the configured host only)";
  }
  const code = isRecord(cause) && typeof cause["code"] === "string" ? ` (${cause["code"]})` : "";
  // Only undici's fixed message is quoted: any other may quote what was sent (an invalid header value quotes the
  // `Authorization` header, so the token).
  return `${error.message === FETCH_FAILED ? FETCH_FAILED : error.name}${code}`;
}

/** An OAuth 2.0 bearer token (RFC 6750 `b64token`): anything else is refused before it goes into a header. */
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

/** The OAuth error of a token response, when it is a plain code (`invalid_client`, Amadeus code 38187). */
function describeOAuthError(body: unknown): string {
  if (!isRecord(body)) {
    return "";
  }
  const parts: string[] = [];
  if (typeof body["error"] === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(body["error"])) {
    parts.push(body["error"]);
  }
  if (typeof body["code"] === "number" && Number.isInteger(body["code"])) {
    parts.push(`code ${body["code"]}`);
  }
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

async function send(
  doFetch: typeof fetch,
  what: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ readonly status: number; readonly ok: boolean; readonly text: string }> {
  try {
    // Never follow a redirect: a 307 or 308 would send the secret (or the token) on to another host, maybe over http.
    const response = await doFetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, ok: response.ok, text: await response.text() };
  } catch (error) {
    throw new RecordError(
      `the ${what} to ${new URL(url).host} failed: ${describeFetchError(error, timeoutMs)}`,
    );
  }
}

function parseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function requestToken(
  doFetch: typeof fetch,
  baseUrl: string,
  clientId: string,
  clientSecret: string,
  timeoutMs: number,
): Promise<string> {
  const response = await send(
    doFetch,
    "token request",
    `${baseUrl}${OAUTH_TOKEN_PATH}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    },
    timeoutMs,
  );
  const parsed = parseJson(response.text);
  const body = parsed.ok ? parsed.value : undefined;
  if (!response.ok) {
    throw new RecordError(
      `the token request failed: HTTP ${response.status}${describeOAuthError(body)}; ` +
        "check AMADEUS_RECORD_CLIENT_ID, AMADEUS_RECORD_CLIENT_SECRET and AMADEUS_RECORD_BASE_URL",
    );
  }
  const token = isRecord(body) ? body["access_token"] : undefined;
  if (typeof token !== "string" || token === "") {
    throw new RecordError(`the token response (HTTP ${response.status}) has no access_token`);
  }
  if (!BEARER_TOKEN.test(token)) {
    // Not quoted: it is the token.
    throw new RecordError(
      `the token response (HTTP ${response.status}) has an access_token that is not a bearer token`,
    );
  }
  return token;
}

const formatFinding = (finding: ScanFinding): string => `  - ${finding.pointer}: ${finding.message}`;

/**
 * Records one fixture: validates the request, gets a token, sends the request, scrubs and scans the response and
 * writes `<fixtureDir>/<folder>/<scenario>.json`. Throws a `RecordError` (nothing written) when the request does not
 * match the specification, a request fails, the response is not JSON, a non-2xx response would become `success`, or
 * the scan still finds personal data after scrubbing.
 */
export async function recordFixture(options: RecordOptions): Promise<RecordResult> {
  const { operation, request } = options;
  const scenario = options.scenario ?? DEFAULT_RECORD_SCENARIO;
  if (!SCENARIO_NAME.test(scenario)) {
    throw new RecordUsageError(
      "the scenario must be lower-case words joined by hyphens (sold-out, price-changed)",
    );
  }
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? RECORD_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;
  const specs = options.specs ?? new AmadeusSpecs();

  const prepared = prepareRequest(operation, request);
  const validation = specs.validateRequest(operation.spec, prepared.parts);
  if (!validation.ok) {
    throw new RecordError(
      [
        `the request does not match the ${operation.api} specification:`,
        ...validation.issues.map(formatIssue),
      ].join("\n"),
    );
  }

  const token = await requestToken(doFetch, baseUrl, options.clientId, options.clientSecret, timeoutMs);
  const headers = { ...prepared.headers, authorization: `Bearer ${token}` };
  const started = performance.now();
  const response = await send(
    doFetch,
    `${operation.name} request`,
    `${baseUrl}${prepared.path}`,
    {
      method: operation.method,
      headers,
      ...(prepared.parts.body === "" ? {} : { body: prepared.parts.body }),
    },
    timeoutMs,
  );
  const durationMs = Math.round(performance.now() - started);

  let body: unknown = null;
  if (response.text.trim() !== "") {
    const parsed = parseJson(response.text);
    if (!parsed.ok) {
      throw new RecordError(
        `the ${operation.name} response (HTTP ${response.status}) is not JSON; nothing was written`,
      );
    }
    body = parsed.value;
  }
  if (scenario === DEFAULT_RECORD_SCENARIO && !response.ok) {
    throw new RecordError(
      `${operation.name} answered HTTP ${response.status}, which is not a success; ` +
        "pass --scenario <name> to record an error response; nothing was written",
    );
  }

  const scrubbed = scrub(body);
  const folder = FIXTURE_FOLDERS[operation.api];
  const date = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  const fixture: Fixture = {
    fixture: {
      operation: folder,
      scenario,
      source: "recorded",
      date,
      scrubbed: true,
      description:
        `Recorded with ${operation.name} (${operation.method} ${operation.path}) from ${new URL(baseUrl).host} ` +
        "and scrubbed of personal data by src/scrub.ts.",
    },
    status: response.status,
    body: scrubbed.value,
  };
  const findings = scanForPersonalData(fixture);
  if (findings.length > 0) {
    throw new RecordError(
      [
        "the scrubbed response still holds personal data, so nothing was written (extend src/scrub.ts):",
        ...findings.map(formatFinding),
      ].join("\n"),
    );
  }

  let schemaProblems: number | undefined;
  try {
    schemaProblems = specs.validateResponse(operation.spec, response.status, scrubbed.value).length;
  } catch {
    schemaProblems = undefined;
  }

  const file = join(options.fixtureDir ?? FIXTURE_DIR, folder, `${scenario}.json`);
  const created = !existsSync(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  return {
    file,
    created,
    status: response.status,
    durationMs,
    replaced: scrubbed.replaced,
    schemaProblems,
    fixture,
  };
}

// ---- The command line ------------------------------------------------------------------------------------------

/** Where the command writes: `process.stdout` / `process.stderr`, or a test's buffer. */
export interface RecordTextSink {
  write(chunk: string): unknown;
}

export interface RecordCliIo {
  /** The environment (default: the process environment, through @velexis/config). */
  readonly env?: EnvSource | undefined;
  readonly stdout?: RecordTextSink | undefined;
  readonly stderr?: RecordTextSink | undefined;
  /** The base of a relative `--request` path (default: INIT_CWD, where pnpm was started, else the process's). */
  readonly cwd?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => Date) | undefined;
  readonly fixtureDir?: string | undefined;
}

export const RECORD_USAGE = [
  "usage: pnpm --filter @velexis/amadeus-stub record <operation> --request <file.json> [--scenario <name>]",
  `  <operation>      ${STUB_OPERATIONS.map((operation) => operation.name).join(", ")}`,
  "                   or the fixture folder of an API with one operation (flight-create-orders, flight-offers-price)",
  '  --request, -r    a JSON file { "query"?: { ... }, "pathParams"?: { ... }, "body"?: { ... } },',
  "                   relative to the directory pnpm was started in",
  `  --scenario, -s   the fixture name, default ${DEFAULT_RECORD_SCENARIO}: fixtures/<folder>/<scenario>.json`,
  "environment: AMADEUS_RECORD_CLIENT_ID, AMADEUS_RECORD_CLIENT_SECRET (required),",
  `             AMADEUS_RECORD_BASE_URL (default ${AMADEUS_RECORD_DEFAULT_BASE_URL}); never runs when CI is set or in production`,
].join("\n");

const PREFIX = "amadeus-stub record:";

const RECORD_ENV = {
  AMADEUS_RECORD_BASE_URL: env.url({
    default: AMADEUS_RECORD_DEFAULT_BASE_URL,
    protocols: ["https:", "http:"],
  }),
  AMADEUS_RECORD_CLIENT_ID: env.string(),
  AMADEUS_RECORD_CLIENT_SECRET: env.string(),
  INIT_CWD: env.string({ optional: true }),
};

function readEnv<S extends ConfigSchema>(schema: S, source: EnvSource | undefined): ConfigOf<S> {
  return source === undefined ? defineConfig(schema) : defineConfig(schema, source);
}

function describeReplacements(replaced: ScrubResult["replaced"]): string {
  const counts = SCRUB_CATEGORIES.filter((category) => replaced[category] > 0).map(
    (category) => `${category} ${replaced[category]}`,
  );
  return counts.length === 0 ? "nothing to replace" : `replaced ${counts.join(", ")}`;
}

interface ParsedCommand {
  readonly operation: StubOperation;
  readonly requestPath: string;
  readonly scenario: string;
}

const RECORD_OPTIONS = {
  request: { type: "string", short: "r" },
  scenario: { type: "string", short: "s" },
  help: { type: "boolean", short: "h" },
} as const;

const parseRaw = (args: readonly string[]) =>
  parseArgs({ args: [...args], options: RECORD_OPTIONS, allowPositionals: true, strict: true });

function parseCommand(args: readonly string[]): ParsedCommand | "help" {
  let parsed: ReturnType<typeof parseRaw>;
  try {
    parsed = parseRaw(args);
  } catch {
    // The parser's message may quote what was typed; a mistyped secret must not reach the terminal log.
    throw new RecordUsageError("unknown option, or an option without its value");
  }
  if (parsed.values.help === true) {
    return "help";
  }
  if (parsed.positionals.length !== 1) {
    throw new RecordUsageError("name exactly one operation");
  }
  const operation = findRecordOperation(parsed.positionals[0] ?? "");
  const requestPath = parsed.values.request;
  if (requestPath === undefined || requestPath === "") {
    throw new RecordUsageError("--request <file.json> is required");
  }
  const scenario = parsed.values.scenario ?? DEFAULT_RECORD_SCENARIO;
  if (!SCENARIO_NAME.test(scenario)) {
    throw new RecordUsageError(
      "the scenario must be lower-case words joined by hyphens (sold-out, price-changed)",
    );
  }
  return { operation, requestPath, scenario };
}

function readRequestFile(file: string): RecordRequest {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = isRecord(error) && typeof error["code"] === "string" ? ` (${error["code"]})` : "";
    throw new RecordError(`cannot read the request file ${file}${code}`);
  }
  const parsed = parseJson(text);
  if (!parsed.ok) {
    // JSON.parse quotes the text around the error, and the request may hold traveller data: say only where.
    throw new RecordError(`the request file ${file} is not valid JSON`);
  }
  return parseRecordRequest(parsed.value);
}

/**
 * `record` as the command line runs it, after `node dist/cli.js record`: returns the exit code (0 written, 1 refused
 * or failed, 2 usage). Messages go to `stderr`, progress to `stdout`; neither ever holds the secret or the token.
 */
export async function runRecordCli(args: readonly string[], io: RecordCliIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const fail = (message: string, code: number): number => {
    stderr.write(`${PREFIX} ${message.replace(/\n/g, "\n  ")}\n`);
    return code;
  };

  // An empty value counts as unset, as for every variable read through @velexis/config.
  const { CI, APP_ENV, NODE_ENV } = readEnv(
    {
      CI: env.string({ optional: true }),
      APP_ENV: env.string({ optional: true }),
      NODE_ENV: env.string({ optional: true }),
    },
    io.env,
  );
  if (CI !== undefined) {
    return fail(
      "refusing to run because CI is set: recording calls the real Amadeus test environment with a developer's " +
        "own credentials, so it never runs in CI (ADR-0015)",
      1,
    );
  }
  if (APP_ENV === "production" || NODE_ENV === "production") {
    return fail(
      "refusing to run in production: the Amadeus stub and its recorder are development tools (ADR-0025 item 7)",
      1,
    );
  }

  let command: ParsedCommand;
  try {
    const parsed = parseCommand(args);
    if (parsed === "help") {
      stdout.write(`${RECORD_USAGE}\n`);
      return 0;
    }
    command = parsed;
  } catch (error) {
    if (error instanceof RecordUsageError) {
      return fail(`${error.message}\n${RECORD_USAGE}`, 2);
    }
    throw error;
  }

  let config: ConfigOf<typeof RECORD_ENV>;
  try {
    config = readEnv(RECORD_ENV, io.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return fail(
        `${error.message}\nSet them in your shell or in a git-ignored .env.local; never in a committed file ` +
          "(docs/mvp/local-development.md §5).",
        1,
      );
    }
    throw error;
  }
  const base = new URL(config.AMADEUS_RECORD_BASE_URL);
  if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") {
    // Not quoted: a user and password in the URL are credentials.
    return fail(
      "AMADEUS_RECORD_BASE_URL must be a plain base URL (scheme, host, optional port and path), without a user, " +
        "password, query or fragment",
      1,
    );
  }
  if (base.protocol === "http:" && !LOOPBACK_HOSTS.has(base.hostname)) {
    return fail(
      "AMADEUS_RECORD_BASE_URL must use https (plain http only to this machine): the client secret travels in the token request",
      1,
    );
  }

  try {
    const request = readRequestFile(resolve(io.cwd ?? config.INIT_CWD ?? process.cwd(), command.requestPath));
    const { operation } = command;
    stdout.write(`${PREFIX} ${operation.name} ${operation.method} ${operation.path} on ${base.host}\n`);
    const result = await recordFixture({
      operation,
      request,
      scenario: command.scenario,
      baseUrl: config.AMADEUS_RECORD_BASE_URL,
      clientId: config.AMADEUS_RECORD_CLIENT_ID,
      clientSecret: config.AMADEUS_RECORD_CLIENT_SECRET,
      fixtureDir: io.fixtureDir,
      fetch: io.fetch,
      now: io.now,
    });
    const shown = relative(resolve(io.fixtureDir ?? FIXTURE_DIR, ".."), result.file);
    stdout.write(
      `${PREFIX} HTTP ${result.status} in ${result.durationMs} ms; ${describeReplacements(result.replaced)}\n`,
    );
    stdout.write(
      `${PREFIX} wrote ${shown} (${result.created ? "new file" : "replaced"}); the personal-data scan is clean\n`,
    );
    if (result.schemaProblems !== undefined && result.schemaProblems > 0) {
      stdout.write(
        `${PREFIX} note: the body differs from the specification's ${result.status} response schema in ` +
          `${result.schemaProblems} place(s); fixtures/README.md lists the known defects of the specifications\n`,
      );
    }
    stdout.write(
      `${PREFIX} review the file, list it in fixtures/README.md and run pnpm --filter @velexis/amadeus-stub test\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof RecordUsageError) {
      return fail(`${error.message}\n${RECORD_USAGE}`, 2);
    }
    if (error instanceof RecordError) {
      return fail(error.message, 1);
    }
    return fail(`unexpected ${error instanceof Error ? error.name : typeof error}; nothing was written`, 1);
  }
}
