// cli.js: the Amadeus stub as a process, for local development and end-to-end runs (X-026), and the fixture recorder
// (X-034, src/record.ts).
//
//   pnpm stub:amadeus                         (root; = pnpm --filter @velexis/amadeus-stub run start)
//   STUB_PORT=4901 node dist/cli.js
//   AMADEUS_STUB_CLIENT_ID=<id> AMADEUS_STUB_CLIENT_SECRET=<secret> pnpm stub:amadeus
//                                             (accepts only that pair; KI-011, FIX-W69-PAGES)
//   pnpm --filter @velexis/amadeus-stub record <operation> --request <file.json> [--scenario <name>]
//                                             (= node dist/cli.js record ...; see src/record.ts)
//
// It listens on 127.0.0.1 only, on STUB_PORT (default 4900), read through @velexis/config after the development env
// files (root and package `.env.local`). It refuses to start when APP_ENV or NODE_ENV is `production`: the VM never
// runs the stub (ADR-0025 item 7). By default its token endpoint accepts any non-empty client id and secret; with
// AMADEUS_STUB_CLIENT_ID and AMADEUS_STUB_CLIENT_SECRET (both, or neither) it accepts only that pair and answers any
// other with 401 invalid_client, as Amadeus does, so a wrong secret can be tried locally (the platform admin's
// "Invalid credentials" state, known issue KI-011). It prints one line when it listens (naming the variables of a
// restriction, never their values) and one line per request (method, path without the query, status, scenario,
// duration): never a header, a query string, a body or a token. SIGINT or SIGTERM stops it. Exit codes: 0 stopped,
// 1 could not start, 2 usage (an unknown command, or only one of the two credential variables).
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { defineConfig, env, loadDevEnvFiles, type EnvSource } from "@velexis/config";
import { RECORD_COMMAND, runRecordCli } from "./record";
import type { StubCredentials } from "./oauth";
import { STUB_SCENARIOS } from "./scenarios";
import { createStubServer, DEFAULT_HOST, type RecordedRequest, type StubServer } from "./server";

/** The port of `pnpm stub:amadeus` (architecture.md §3, `AMADEUS_BASE_URL_TEST` of .env.example). */
export const DEFAULT_STUB_PORT = 4900;

/** tools/amadeus-stub (this file is `src/cli.ts` or `dist/cli.js`). */
const PACKAGE_DIR = resolve(__dirname, "..");

const CONFIG_SCHEMA = {
  STUB_PORT: env.port({ default: DEFAULT_STUB_PORT }),
  APP_ENV: env.enum(["development", "test", "production"] as const, { optional: true }),
  NODE_ENV: env.string({ optional: true }),
  AMADEUS_STUB_CLIENT_ID: env.string({ optional: true }),
  AMADEUS_STUB_CLIENT_SECRET: env.string({ optional: true }),
};

/**
 * The CLI was started the wrong way (exit code 2): only one of AMADEUS_STUB_CLIENT_ID and AMADEUS_STUB_CLIENT_SECRET.
 * Its message names the variables, never a value.
 */
export class StubCliUsageError extends Error {
  override readonly name = "StubCliUsageError";
}

/** The exit code of a CLI that could not start because of `error`: 2 for a usage error, 1 otherwise. */
export function exitCodeOf(error: unknown): 1 | 2 {
  return error instanceof StubCliUsageError ? 2 : 1;
}

/** Where the CLI writes: `process.stdout`, or a test's buffer. */
export interface TextSink {
  write(chunk: string): unknown;
}

export interface StubCliConfig {
  readonly host: string;
  readonly port: number;
  /** The only client credentials the token endpoint accepts; absent: any non-empty pair. */
  readonly credentials?: StubCredentials;
}

/**
 * The address the CLI listens on and the credentials it accepts, from `source` (default: the process environment,
 * through @velexis/config, where an empty value counts as unset). Throws a `ConfigError` naming STUB_PORT when it is
 * not a port, an error in production, and a `StubCliUsageError` when only one of AMADEUS_STUB_CLIENT_ID and
 * AMADEUS_STUB_CLIENT_SECRET is set.
 */
export function readStubCliConfig(source?: EnvSource): StubCliConfig {
  const config = source === undefined ? defineConfig(CONFIG_SCHEMA) : defineConfig(CONFIG_SCHEMA, source);
  if (config.APP_ENV === "production" || config.NODE_ENV === "production") {
    throw new Error("the Amadeus stub never runs in production (ADR-0025 item 7)");
  }
  const clientId = config.AMADEUS_STUB_CLIENT_ID;
  const clientSecret = config.AMADEUS_STUB_CLIENT_SECRET;
  if ((clientId === undefined) !== (clientSecret === undefined)) {
    throw new StubCliUsageError(
      "set both AMADEUS_STUB_CLIENT_ID and AMADEUS_STUB_CLIENT_SECRET to accept only that pair, or neither to accept any",
    );
  }
  return clientId === undefined || clientSecret === undefined
    ? { host: DEFAULT_HOST, port: config.STUB_PORT }
    : { host: DEFAULT_HOST, port: config.STUB_PORT, credentials: { clientId, clientSecret } };
}

/** The log line of one request: no header, query string, body or token. */
export function formatRequestLine(request: RecordedRequest): string {
  const status = request.status === undefined ? "-" : String(request.status);
  const scenario =
    request.scenario === undefined || request.scenario === "success" ? "" : ` [${request.scenario}]`;
  const duration = request.durationMs === undefined ? "" : ` ${request.durationMs} ms`;
  return `amadeus-stub: ${request.method} ${request.path} ${status}${scenario}${duration}\n`;
}

/** Starts the stub as `pnpm stub:amadeus` does and returns it; the caller stops it with `close()`. */
export async function startStubCli(
  io: { readonly env?: EnvSource | undefined; readonly stdout?: TextSink | undefined } = {},
): Promise<StubServer> {
  const stdout = io.stdout ?? process.stdout;
  const { host, port, credentials } = readStubCliConfig(io.env);
  const started = performance.now();
  const server = await createStubServer({
    host,
    port,
    credentials,
    onResponse: (request) => stdout.write(formatRequestLine(request)),
  });
  // The restriction is named by its variables only: the line never carries the client id or the secret.
  const accepted =
    credentials === undefined
      ? "any non-empty client id and secret"
      : "only AMADEUS_STUB_CLIENT_ID and AMADEUS_STUB_CLIENT_SECRET";
  stdout.write(
    `amadeus-stub: listening on ${server.url} (ready in ${Math.round(performance.now() - started)} ms; ` +
      `credentials: ${accepted}; X-Stub-Scenario: ${STUB_SCENARIOS.join(", ")})\n`,
  );
  return server;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(args: readonly string[]): void {
  runRecordCli(args).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`amadeus-stub record: ${error instanceof Error ? error.name : typeof error}\n`);
      process.exitCode = 1;
    },
  );
}

function main(): void {
  loadDevEnvFiles({ appDir: PACKAGE_DIR });
  const [command, ...args] = process.argv.slice(2);
  if (command === RECORD_COMMAND) {
    record(args);
    return;
  }
  if (command !== undefined) {
    process.stderr.write(
      `amadeus-stub: unknown command; run it without arguments, or with ${RECORD_COMMAND}\n`,
    );
    process.exitCode = 2;
    return;
  }
  // The signal handlers come first, so a SIGINT during start-up still stops the server once it listens.
  let stopRequested = false;
  let running: StubServer | undefined;
  const close = (server: StubServer): void => {
    server.close().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        process.stderr.write(`amadeus-stub: ${describeError(error)}\n`);
        process.exitCode = 1;
      },
    );
  };
  const stop = (): void => {
    stopRequested = true;
    if (running !== undefined) {
      close(running);
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  startStubCli().then(
    (server) => {
      running = server;
      if (stopRequested) {
        close(server);
      }
    },
    (error: unknown) => {
      process.stderr.write(`amadeus-stub: ${describeError(error)}\n`);
      process.exitCode = exitCodeOf(error);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    },
  );
}

if (require.main === module) {
  main();
}
