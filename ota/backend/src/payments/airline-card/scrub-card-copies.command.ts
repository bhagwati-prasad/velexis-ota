// `tenants:scrub-card-copies (--tenant <key> | --all) [--batch-size <n>]` of dist/cli.js (FIX-W30-OTA, lead decision (1)
// of 2026-10-26; conventions §9: a backfill of tenant data is a batched job per tenant): the one-off scrub of the card
// holder and expiry from the copies stored before FIX-W29-SECURITY (card-copies-scrub.ts: `bookings.form_of_payments`,
// `bookings.order_snapshot`, `supplier_requests.request_body` and `response_body`). Run on the VM as the OTA zone, once
// after the deploy of the release that has it:
//
//   sudo velexis-run ota node dist/cli.js tenants:scrub-card-copies --all
//   sudo velexis-run ota node dist/cli.js tenants:scrub-card-copies --tenant <key>
//
// It reads `APP_ENV`, `LOG_LEVEL` and `DATABASE_URL` only (ota-backend.env: the velexis_ota_app role, which reads
// `platform.tenants` and writes tenant data through `tenantTx`; never a migrator or provisioner DSN). `--tenant` names
// one OTA by its key (any status whose schema exists); `--all` takes every `active` and `suspended` OTA (the tenants
// whose schemas the per-tenant schedules serve, OADR-0014 point 4), one after the other, and goes on past a tenant that
// fails. Running it again is harmless: a scrubbed copy is never written twice, and rows written since 2026-10-24 are
// left alone.
//
// Output: one line per schema with the counts (rows read, scrubbed, skipped because they changed meanwhile), never a
// copy, an id of a person or a DSN. Exit codes (cli.ts): 0 when every schema was scrubbed, 1 on invalid arguments or
// configuration, an unknown tenant, or a schema whose scrub failed (stderr names it and the error's class and code; run
// the command again for it).
import { ConfigError, defineConfig, loadDevEnvFiles, type EnvSource } from "@velexis/config";
import { createPlatformDb, createPool, createTenantDb, isTenantSchema } from "@velexis/db";
import { createLogger, type Logger } from "@velexis/logger";
import type { CliStreams } from "../../cli";
import { APP_DIR, workerConfigSchema } from "../../config";
import { PlatformReadRepository } from "../../tenancy/platform-read.repository";
import type { TenantStatus } from "../../tenancy/platform-read.types";
import { SCRUB_BATCH_SIZE, scrubCardCopies, type ScrubCounts } from "./card-copies-scrub";

/** The command word. */
export const SCRUB_CARD_COPIES_COMMAND = "tenants:scrub-card-copies";

/** The usage line of the command. */
export const SCRUB_CARD_COPIES_USAGE = `Usage: node dist/cli.js ${SCRUB_CARD_COPIES_COMMAND} (--tenant <key> | --all) [--batch-size <n>]`;

/** The process name of the command's log lines and of its PostgreSQL `application_name`. */
export const SCRUB_CARD_COPIES_APP = "ota-cli-scrub-card-copies";

/** The tenants `--all` scrubs. */
export const SCRUB_TENANT_STATUSES: readonly TenantStatus[] = Object.freeze(["active", "suspended"]);

/** The variables the command reads: those of ota-backend.env (DATABASE_URL is velexis_ota_app). */
export const SCRUB_CARD_COPIES_CONFIG_SCHEMA = {
  APP_ENV: workerConfigSchema.APP_ENV,
  LOG_LEVEL: workerConfigSchema.LOG_LEVEL,
  DATABASE_URL: workerConfigSchema.DATABASE_URL,
} as const;

/** The arguments of a run: one tenant or all of them, and the batch size. */
export interface ScrubArguments {
  readonly target: { readonly kind: "tenant"; readonly key: string } | { readonly kind: "all" };
  readonly batchSize: number;
}

/**
 * The arguments of `tenants:scrub-card-copies` (`--tenant <key>` or `--tenant=<key>`, `--all`, `--batch-size <n>`), or
 * `undefined` when they are not exactly one target and at most one batch size.
 */
export function scrubArgumentsOf(args: readonly string[]): ScrubArguments | undefined {
  let key: string | undefined;
  let all = false;
  let batchSize: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split("=", 2) : [arg, undefined];
    const value = (): string | undefined => {
      if (inline !== undefined) {
        return inline;
      }
      index += 1;
      return args[index];
    };
    if (name === "--all" && inline === undefined && !all) {
      all = true;
    } else if (name === "--tenant" && key === undefined) {
      key = value();
      // A tenant key as `platform.tenants.key` holds it: `tenant_<key>` is a tenant schema name.
      if (key === undefined || !isTenantSchema(`tenant_${key}`)) {
        return undefined;
      }
    } else if (name === "--batch-size" && batchSize === undefined) {
      const raw = value();
      if (raw === undefined || !/^[1-9][0-9]{0,4}$/.test(raw)) {
        return undefined;
      }
      batchSize = Number(raw);
    } else {
      return undefined;
    }
  }
  if (all === (key !== undefined)) {
    return undefined;
  }
  return {
    target: key === undefined ? { kind: "all" } : { kind: "tenant", key },
    batchSize: batchSize ?? SCRUB_BATCH_SIZE,
  };
}

/** The command's configuration: `env` (tests), else the process environment and, in development, `.env.local`. */
function loadScrubConfig(env: EnvSource | undefined) {
  if (env !== undefined) {
    return defineConfig(SCRUB_CARD_COPIES_CONFIG_SCHEMA, env);
  }
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig(SCRUB_CARD_COPIES_CONFIG_SCHEMA);
}

function cliLogger(config: { APP_ENV: string; LOG_LEVEL: string }, io: CliStreams): Logger {
  const level = config.LOG_LEVEL === "debug" ? "debug" : config.LOG_LEVEL === "error" ? "error" : "warn";
  return createLogger({
    app: SCRUB_CARD_COPIES_APP,
    env: config.APP_ENV,
    level,
    destination: { write: (line: string) => void io.stderr.write(line) },
  });
}

/**
 * A short reason for a failure, for stderr: the error's class name and its SQLSTATE or errno code, never its message
 * (PostgreSQL's can quote values).
 */
function failureReason(error: unknown): string {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  const code: unknown =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9][A-Z0-9_]{1,31}$/.test(code) ? `${name} ${code}` : name;
}

const countsText = (table: string, counts: ScrubCounts): string =>
  `${table} ${counts.scrubbed} scrubbed of ${counts.read} read (${counts.skipped} changed meanwhile, left for another run)`;

/** What `runScrubCardCopies` gets from cli.ts. */
export interface ScrubCardCopiesIo extends CliStreams {
  /** The configuration variables instead of the process environment and `.env.local` files (tests). */
  readonly env?: EnvSource | undefined;
}

/** `tenants:scrub-card-copies` (see the file header). */
export async function runScrubCardCopies(args: readonly string[], io: ScrubCardCopiesIo): Promise<number> {
  const parsed = scrubArgumentsOf(args);
  if (parsed === undefined) {
    io.stderr.write(`${SCRUB_CARD_COPIES_COMMAND}: name one tenant or --all.\n${SCRUB_CARD_COPIES_USAGE}\n`);
    return 1;
  }
  let config: ReturnType<typeof loadScrubConfig>;
  try {
    config = loadScrubConfig(io.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr.write(`${SCRUB_CARD_COPIES_COMMAND}: the configuration is invalid:\n${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const logger = cliLogger(config, io);
  const pool = createPool(config.DATABASE_URL, { applicationName: SCRUB_CARD_COPIES_APP, logger, max: 2 });
  const platform = new PlatformReadRepository(createPlatformDb(pool));
  const tenants = createTenantDb(pool, { appEnv: config.APP_ENV });
  try {
    let schemas: string[];
    try {
      if (parsed.target.kind === "tenant") {
        const tenant = await platform.tenantByKey(parsed.target.key);
        if (tenant === null) {
          io.stderr.write(
            `${SCRUB_CARD_COPIES_COMMAND}: no tenant has the key ${parsed.target.key}; nothing was scrubbed.\n`,
          );
          return 1;
        }
        schemas = [tenant.schemaName];
      } else {
        schemas = [];
        for (const id of await platform.tenantIdsByStatus(SCRUB_TENANT_STATUSES)) {
          const tenant = await platform.tenantById(id);
          if (tenant !== null) {
            schemas.push(tenant.schemaName);
          }
        }
      }
    } catch (error) {
      io.stderr.write(
        `${SCRUB_CARD_COPIES_COMMAND}: the tenants could not be read (${failureReason(error)}); nothing was scrubbed.\n`,
      );
      return 1;
    }
    let failed = 0;
    for (const schema of schemas) {
      try {
        const outcome = await scrubCardCopies(tenants, schema, { batchSize: parsed.batchSize });
        logger.info(
          { schema, bookings: outcome.bookings, supplierRequests: outcome.supplierRequests },
          "card_copies.scrubbed",
        );
        io.stdout.write(
          `${SCRUB_CARD_COPIES_COMMAND}: ${schema}: ${countsText("bookings", outcome.bookings)}; ` +
            `${countsText("supplier_requests", outcome.supplierRequests)}.\n`,
        );
      } catch (error) {
        failed += 1;
        logger.error({ schema, err: failureReason(error) }, "card_copies.scrub_failed");
        io.stderr.write(
          `${SCRUB_CARD_COPIES_COMMAND}: ${schema}: the scrub failed (${failureReason(error)}); run the command ` +
            "again for it: repeating it is harmless.\n",
        );
      }
    }
    io.stdout.write(
      `${SCRUB_CARD_COPIES_COMMAND}: ${schemas.length - failed} of ${schemas.length} tenant schema(s) scrubbed.\n`,
    );
    return failed === 0 ? 0 : 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
