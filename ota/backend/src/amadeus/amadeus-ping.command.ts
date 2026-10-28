// `amadeus:ping --tenant <key> --env <test|live>` of dist/cli.js (OBE-025; README §5, flows/amadeus-connection-and-
// tokens.md): a support check of one OTA's Amadeus connection in one environment, through the same code as its calls.
//
//   sudo velexis-run ota node dist/cli.js amadeus:ping --tenant demo --env test
//
// It builds the worker's Amadeus module graph (AmadeusWorkerModule on TenancyModule.forWorker(), the process's Redis
// connections, the request context) and, one step after the other, each timed:
//
//   1. connection: resolves the tenant's connection (connection-resolver.ts: the platform rows through the platform
//      caches; `424 SUPPLIER_NOT_CONFIGURED` without a usable one) and prints its id, credential set, office and base
//      URL (none of them a secret);
//   2. token: gets an access token for its credential set (token-provider.ts: the cached one, as every call does, or a
//      token request; `424 SUPPLIER_NOT_CONFIGURED` when Amadeus refuses the credentials). The token is never printed
//      or logged;
//   3. read: one cheap read as the tenant, through AmadeusClient (its rate limits, timeout, retry, error mapping and
//      `supplier_requests` row): Flight Offers Search GET for one adult MAD-BCN 30 days after today, one offer at most.
//      It reads no booking and no personal data. The row (operation `support.amadeusPing`) and the log lines carry the
//      printed request id.
//
// Every step prints its status and duration; the last line is `ok` (exit 0). The first step that fails prints the
// error code on stderr, with the reason when the code has one (`SUPPLIER_NOT_CONFIGURED (credentials_refused)`), and
// the command exits 1. Nothing printed is a secret: never a token, a client secret, a DSN or a supplier body.
//
// It reads `APP_ENV`, `LOG_LEVEL`, `DATABASE_URL` (velexis_ota_app, which reads the platform rows and writes the
// tenant's `supplier_requests` through `tenantTx`), `REDIS_URL` (tokens, buckets, platform caches), `MASTER_KEY_DIR`
// and `MASTER_KEY_CURRENT` (the KEKs that decrypt the client secret and the cached token) and, as the API does, the
// optional `AMADEUS_BASE_URL_TEST` / `_LIVE` (the stub in development and CI). Log lines go to stderr at `warn` (or
// `debug` / `error` when LOG_LEVEL says so).
import { randomBytes } from "node:crypto";
import { Module, type DynamicModule, type INestApplicationContext } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { ConfigError, defineConfig, loadDevEnvFiles, type EnvSource } from "@velexis/config";
import { isTenantSchema } from "@velexis/db";
import { AppError } from "@velexis/errors";
import { createLogger, type Logger } from "@velexis/logger";
import { ClsModule } from "nestjs-cls";
import { LoggerModule, Logger as NestPinoLogger } from "nestjs-pino";
import type { CliStreams } from "../cli";
import { Clock } from "../common/clock";
import { CommonModule } from "../common/common.module";
import { RedisModule } from "../common/redis/redis.module";
import { apiConfigSchema, APP_DIR, workerConfigSchema } from "../config";
import { PlatformReadRepository, type AmadeusEnvironment } from "../tenancy/platform-read.repository";
import { TenancyModule } from "../tenancy/tenancy.module";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { AmadeusClient, type GetFlightOffersRequest } from "./amadeus.client";
import { AmadeusWorkerModule } from "./amadeus.module";
import type { AmadeusCallContext } from "./call-context";
import { AmadeusConnectionUnusableError, ConnectionResolver } from "./connection-resolver";
import { AmadeusRateLimitedError } from "./rate-limiter";
import { AmadeusCredentialsRefusedError, AmadeusTokenRequestError, TokenProvider } from "./token-provider";

/** The command word. */
export const AMADEUS_PING_COMMAND = "amadeus:ping";

/** The usage line of the command. */
export const AMADEUS_PING_USAGE = `Usage: node dist/cli.js ${AMADEUS_PING_COMMAND} --tenant <key> --env <test|live>`;

/** The process name of the command's log lines. */
export const AMADEUS_PING_APP = "ota-cli-amadeus-ping";

/** `supplier_requests.operation` of the read. */
export const AMADEUS_PING_OPERATION = "support.amadeusPing";

/** The variables the command reads (see the file header). */
export const AMADEUS_PING_CONFIG_SCHEMA = {
  APP_ENV: workerConfigSchema.APP_ENV,
  LOG_LEVEL: workerConfigSchema.LOG_LEVEL,
  DATABASE_URL: workerConfigSchema.DATABASE_URL,
  REDIS_URL: workerConfigSchema.REDIS_URL,
  MASTER_KEY_DIR: workerConfigSchema.MASTER_KEY_DIR,
  MASTER_KEY_CURRENT: workerConfigSchema.MASTER_KEY_CURRENT,
  AMADEUS_BASE_URL_TEST: apiConfigSchema.AMADEUS_BASE_URL_TEST,
  AMADEUS_BASE_URL_LIVE: apiConfigSchema.AMADEUS_BASE_URL_LIVE,
} as const;

/** The read of step 3: from MAD to BCN, this many days after today (UTC), one adult, one offer at most. */
export const PING_SEARCH = Object.freeze({ origin: "MAD", destination: "BCN", daysAhead: 30 });

/** The arguments of a run. */
export interface PingArguments {
  /** `platform.tenants.key` of the OTA. */
  readonly key: string;
  readonly environment: AmadeusEnvironment;
}

/**
 * The arguments of `amadeus:ping` (`--tenant <key>` or `--tenant=<key>`, `--env test|live` or `--env=…`), or
 * `undefined` unless both are given once and valid.
 */
export function pingArgumentsOf(args: readonly string[]): PingArguments | undefined {
  let key: string | undefined;
  let environment: AmadeusEnvironment | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    // `--name=value`: the value is everything after the first `=`, so `--tenant=demo=x` names the key `demo=x`.
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    let value = equals === -1 ? undefined : arg.slice(equals + 1);
    if (value === undefined) {
      index += 1;
      value = args[index];
    }
    // A tenant key as `platform.tenants.key` holds it: `tenant_<key>` is a tenant schema name.
    if (
      name === "--tenant" &&
      key === undefined &&
      value !== undefined &&
      isTenantSchema(`tenant_${value}`)
    ) {
      key = value;
    } else if (name === "--env" && environment === undefined && (value === "test" || value === "live")) {
      environment = value;
    } else {
      return undefined;
    }
  }
  return key === undefined || environment === undefined ? undefined : { key, environment };
}

/** The command's configuration: `env` (tests), else the process environment and, in development, `.env.local`. */
function loadPingConfig(env: EnvSource | undefined) {
  if (env !== undefined) {
    return defineConfig(AMADEUS_PING_CONFIG_SCHEMA, env);
  }
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig(AMADEUS_PING_CONFIG_SCHEMA);
}

type PingConfig = ReturnType<typeof loadPingConfig>;

function cliLogger(config: PingConfig, io: CliStreams): Logger {
  const level = config.LOG_LEVEL === "debug" ? "debug" : config.LOG_LEVEL === "error" ? "error" : "warn";
  return createLogger({
    app: AMADEUS_PING_APP,
    env: config.APP_ENV,
    level,
    destination: { write: (line: string) => void io.stderr.write(line) },
  });
}

@Module({})
class AmadeusPingModule {
  /** The worker's Amadeus graph on the command's configuration and logger (see the file header). */
  static forRoot(config: PingConfig, logger: Logger): DynamicModule {
    return {
      module: AmadeusPingModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validatePredefined: false,
          skipProcessEnv: true,
          load: [() => config],
        }),
        LoggerModule.forRoot({ pinoHttp: { logger } }),
        ClsModule.forRoot({ global: true }),
        CommonModule,
        RedisModule,
        TenancyModule.forWorker(),
        AmadeusWorkerModule,
      ],
    };
  }
}

/**
 * A short reason for an error that is no AppError, for stderr: its class name and its SQLSTATE or errno code, never
 * its message (PostgreSQL's can quote values, a file error names a path).
 */
function failureReason(error: unknown): string {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  const code: unknown =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9][A-Z0-9_]{1,31}$/.test(code) ? `${name} ${code}` : name;
}

/** What a failed step prints: the error code and, when known, why (ids and codes only). */
export function describeFailure(error: unknown): string {
  if (!(error instanceof AppError)) {
    return failureReason(error);
  }
  const cause: unknown = error.cause;
  let reason: string | undefined;
  if (cause instanceof AmadeusConnectionUnusableError) {
    reason = cause.reason;
  } else if (cause instanceof AmadeusCredentialsRefusedError) {
    reason = "credentials_refused";
  } else if (cause instanceof AmadeusTokenRequestError) {
    reason = cause.status === null ? "token request without an answer" : `token request HTTP ${cause.status}`;
  } else if (cause instanceof AmadeusRateLimitedError) {
    reason = "Velexis rate limit";
  } else if (error.supplier !== undefined) {
    reason = `Amadeus HTTP ${error.supplier.status}, code ${error.supplier.code}`;
  }
  return reason === undefined ? error.code : `${error.code} (${reason})`;
}

/** A step's outcome: its value and duration, or the error it threw. */
type Timed<T> =
  | { readonly ok: true; readonly value: T; readonly ms: number }
  | { readonly ok: false; readonly error: unknown; readonly ms: number };

async function timed<T>(run: () => Promise<T>): Promise<Timed<T>> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  try {
    const value = await run();
    return { ok: true, value, ms: elapsed() };
  } catch (error) {
    return { ok: false, error, ms: elapsed() };
  }
}

/** `date` plus `days`, as the `YYYY-MM-DD` of UTC. */
function isoDateAfter(date: Date, days: number): string {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The three steps of the file header on a built graph; resolves to the exit code. */
async function ping(app: INestApplicationContext, target: PingArguments, io: CliStreams): Promise<number> {
  const out = (line: string): void => void io.stdout.write(`${AMADEUS_PING_COMMAND}: ${line}\n`);
  const fail = (step: string, outcome: { readonly error: unknown; readonly ms: number }): number => {
    io.stderr.write(
      `${AMADEUS_PING_COMMAND}: ${step} failed after ${outcome.ms} ms: ${describeFailure(outcome.error)}\n`,
    );
    return 1;
  };
  const get = <T>(token: abstract new (...args: never[]) => T): T => app.get(token, { strict: false });

  const lookup = await timed(() => get(PlatformReadRepository).tenantByKey(target.key));
  if (!lookup.ok) {
    return fail("tenant", lookup);
  }
  const tenant = lookup.value;
  if (tenant === null) {
    io.stderr.write(`${AMADEUS_PING_COMMAND}: no tenant has the key ${target.key}.\n`);
    return 1;
  }
  out(`tenant ${tenant.key} (${tenant.id}, ${tenant.status}), Amadeus ${target.environment} environment`);

  const resolved = await timed(() => get(ConnectionResolver).resolve(tenant.id, target.environment));
  if (!resolved.ok) {
    return fail("connection", resolved);
  }
  const connection = resolved.value;
  out(
    `connection ${connection.connectionId} (${connection.credentialSource}, credential set ${connection.credId}, ` +
      `office ${connection.offices.queue}) at ${connection.baseUrl}: ok in ${resolved.ms} ms`,
  );

  // The token stays in this scope: only its outcome and duration are printed.
  const token = await timed(async () => {
    await get(TokenProvider).getToken(connection);
  });
  if (!token.ok) {
    return fail("token", token);
  }
  out(`token: ok in ${token.ms} ms`);

  const requestId = `amadeus-ping-${randomBytes(8).toString("hex")}`;
  const departureDate = isoDateAfter(get(Clock).now(), PING_SEARCH.daysAhead);
  const search: GetFlightOffersRequest = {
    query: {
      originLocationCode: PING_SEARCH.origin,
      destinationLocationCode: PING_SEARCH.destination,
      departureDate,
      adults: 1,
      max: 1,
    },
  };
  const context: AmadeusCallContext = {
    tenantId: tenant.id,
    environment: target.environment,
    operation: AMADEUS_PING_OPERATION,
    requestId,
  };
  const actingTenant: RequestTenant = {
    tenantId: tenant.id,
    key: tenant.key,
    schemaName: tenant.schemaName,
    environment: target.environment,
    caller: { type: "anonymous", id: "anonymous" },
    actor: { type: "system", id: null },
    requestId,
  };
  const read = await timed(() =>
    get(TenantContext).run(actingTenant, () => get(AmadeusClient).getFlightOffers(context, search)),
  );
  const what = `Flight Offers Search (${PING_SEARCH.origin}-${PING_SEARCH.destination} on ${departureDate}, request id ${requestId})`;
  if (!read.ok) {
    return fail(what, read);
  }
  const { call } = read.value;
  out(
    `${what}: HTTP ${call.status} in ${read.ms} ms (Amadeus ${call.durationMs} ms, ama-request-id ` +
      `${call.correlationId ?? "none"}, supplier request ${call.supplierRequestId ?? "not recorded"})`,
  );
  io.stdout.write("ok\n");
  return 0;
}

/** What `runAmadeusPing` gets from cli.ts. */
export interface AmadeusPingIo extends CliStreams {
  /** The configuration variables instead of the process environment and `.env.local` files (tests). */
  readonly env?: EnvSource | undefined;
}

/** `amadeus:ping` (see the file header). */
export async function runAmadeusPing(args: readonly string[], io: AmadeusPingIo): Promise<number> {
  const target = pingArgumentsOf(args);
  if (target === undefined) {
    io.stderr.write(`${AMADEUS_PING_COMMAND}: name one tenant and the environment.\n${AMADEUS_PING_USAGE}\n`);
    return 1;
  }
  let config: PingConfig;
  try {
    config = loadPingConfig(io.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr.write(`${AMADEUS_PING_COMMAND}: the configuration is invalid:\n${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const logger = cliLogger(config, io);
  let app: INestApplicationContext | undefined;
  try {
    app = await NestFactory.createApplicationContext(AmadeusPingModule.forRoot(config, logger), {
      bufferLogs: true,
      abortOnError: false,
    });
    app.useLogger(app.get(NestPinoLogger));
  } catch (error) {
    // A missing or unreadable key folder, for example: the class and code only.
    io.stderr.write(`${AMADEUS_PING_COMMAND}: could not start (${failureReason(error)}).\n`);
    await app?.close().catch(() => undefined);
    return 1;
  }
  try {
    return await ping(app, target, io);
  } finally {
    await app.close().catch(() => undefined);
  }
}
