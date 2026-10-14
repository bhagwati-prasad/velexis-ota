// cli.js: the Amadeus stub as a process, for local development and end-to-end runs (X-026).
//
//   pnpm stub:amadeus                         (root; = pnpm --filter @velexis/amadeus-stub run start)
//   STUB_PORT=4901 node dist/cli.js
//
// It listens on 127.0.0.1 only, on STUB_PORT (default 4900), read through @velexis/config after the development env
// files (root and package `.env.local`). It refuses to start when APP_ENV or NODE_ENV is `production`: the VM never
// runs the stub (ADR-0025 item 7). It prints one line when it listens and one line per request (method, path without
// the query, status, scenario, duration): never a header, a query string, a body or a token. SIGINT or SIGTERM stops
// it. Exit codes: 0 stopped, 1 could not start.
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { defineConfig, env, loadDevEnvFiles, type EnvSource } from "@velexis/config";
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
};

/** Where the CLI writes: `process.stdout`, or a test's buffer. */
export interface TextSink {
  write(chunk: string): unknown;
}

export interface StubCliConfig {
  readonly host: string;
  readonly port: number;
}

/**
 * The address the CLI listens on, from `source` (default: the process environment, through @velexis/config). Throws a
 * `ConfigError` naming STUB_PORT when it is not a port, and an error in production.
 */
export function readStubCliConfig(source?: EnvSource): StubCliConfig {
  const config = source === undefined ? defineConfig(CONFIG_SCHEMA) : defineConfig(CONFIG_SCHEMA, source);
  if (config.APP_ENV === "production" || config.NODE_ENV === "production") {
    throw new Error("the Amadeus stub never runs in production (ADR-0025 item 7)");
  }
  return { host: DEFAULT_HOST, port: config.STUB_PORT };
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
  const { host, port } = readStubCliConfig(io.env);
  const started = performance.now();
  const server = await createStubServer({
    host,
    port,
    onResponse: (request) => stdout.write(formatRequestLine(request)),
  });
  stdout.write(
    `amadeus-stub: listening on ${server.url} (ready in ${Math.round(performance.now() - started)} ms; ` +
      `X-Stub-Scenario: ${STUB_SCENARIOS.join(", ")})\n`,
  );
  return server;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(): void {
  loadDevEnvFiles({ appDir: PACKAGE_DIR });
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
      process.exitCode = 1;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    },
  );
}

if (require.main === module) {
  main();
}
