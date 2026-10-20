// `dev:seed` of dist/cli.js (OBE-007; README §5 and §6, docs/mvp/local-development.md): the demo OTA a developer needs
// before the storefront, the SDK or the OTA admin are of any use locally. Development and tests only: `APP_ENV=production`
// exits 1 before any configuration is read or connection opened, so nothing is written. It needs the platform's
// `dev:seed` (PBE-034) first: the Velexis test Amadeus account and its pool of test offices.
//
// A DEVELOPMENT-ONLY EXCEPTION to "the OTA backend never writes platform tables" (ADR-0003): what the platform's
// sign-up, `createTenant` and provisioning post-steps would write is written here as velexis_migrator
// (DATABASE_MIGRATOR_URL, the owner of the platform tables, which no app process holds on the VM), each row only when
// it is missing, in one transaction:
//
// 1. the tenant `demo` (`tenant_demo`, "Demo Travel", plan `early_access`, status `provisioning`, storefront `test`);
// 2. its storefront sub-domain `demo.<STOREFRONT_BASE_DOMAIN>` (verified, primary), as `createTenant` inserts it;
// 3. its Amadeus `test` connection through the Velexis shared test account: the office the tenant holds in the account's
//    pool, else the oldest available one, assigned to it (`velexis`, the office as default, queuing and owner office,
//    `active`), as the `assign_amadeus_office` post-step does;
// 4. its Stripe `test` payment connection in `velexis` mode (manual capture, `active`, default), no secret;
// 5. a `pk_test_…` key without origins and an `sk_test_…` key scoped `storefront` (PADR-0005: 40 base62 characters from
//    the CSPRNG, the 14-character prefix, `last4`, `key_hash = hashApiKey(key, pepper)` with the shared pepper of
//    API_KEY_PEPPER_FILE), each kind only when the tenant has no valid test key of it.
//
// Then it provisions `tenant_demo` with `ProvisioningService.provisionTenant`, the worker's real provisioning function
// (velexis_provisioner, DATABASE_PROVISIONER_URL; the platform rows read back as velexis_ota_app, DATABASE_URL), and,
// in a second transaction, sets the tenant `active` with `activated_at`, mirrors the ledger into
// `platform.tenant_schema_migrations` and sets `schema_version`, as the platform's `record_migrations` and `activate`
// post-steps do. The two raw keys are printed once, on stdout, when they are created: they are stored nowhere in clear
// and never logged, so a second run prints neither (a lost key is revoked and rolled in the portal, or the rows are
// deleted locally before running the seed again).
//
// A second run changes nothing: one tenant, one schema, two keys. Exit codes (cli.ts): 0 when the demo OTA is active
// with its schema, connections and keys; 1 after the production refusal, an invalid configuration, a missing platform
// seed (no test Amadeus account, no free test office), a tenant `demo` in another state, or a failed provisioning (its
// code and message on stderr). It never prints a DSN or the pepper.
import { randomBytes } from "node:crypto";
import {
  ConfigError,
  defineConfig,
  env,
  loadDevEnvFiles,
  readKeyFile,
  type EnvSource,
} from "@velexis/config";
import { API_KEY_PEPPER_MIN_BYTES, hashApiKey } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  sql,
  type Kysely,
  type PlatformDatabase,
  type Transaction,
} from "@velexis/db";
import { createLogger, type Logger } from "@velexis/logger";
import type { CliStreams } from "../cli";
import { Clock } from "../common/clock";
import { newId } from "../common/ids";
import { apiConfigSchema, APP_DIR, workerConfigSchema } from "../config";
import {
  createProvisionerDatabase,
  DEFAULT_PROVISIONING_OPTIONS,
  ProvisioningService,
  type ProvisioningOptions,
} from "../provisioning/provisioning.service";
import { PlatformReadRepository } from "../tenancy/platform-read.repository";

/** The command word. */
export const DEV_SEED_COMMAND = "dev:seed";

/** The process name of the command's log lines and PostgreSQL connections. */
export const DEV_SEED_APP = "ota-cli-dev-seed";

/** The demo OTA. */
export const DEV_TENANT = Object.freeze({
  key: "demo",
  name: "Demo Travel",
  schemaName: "tenant_demo",
  planCode: "early_access",
  defaultCurrency: "EUR",
  defaultLocale: "en",
  /** The card statement suffix of its Stripe connection (`^[A-Za-z0-9][A-Za-z0-9 .&-]{1,21}$`). */
  statementDescriptorSuffix: "DEMO TRAVEL",
} as const);

/** The environment of everything dev:seed creates: the demo OTA stays in test. */
const ENVIRONMENT = "test";

/** The names of the two keys, as the portal lists them. */
export const DEV_SEED_KEY_NAMES = Object.freeze({
  publishable: "dev:seed publishable test key",
  secret: "dev:seed secret test key",
} as const);

/** The variables dev:seed reads (README §3; root and app `.env.local` locally). */
export const DEV_SEED_CONFIG_SCHEMA = {
  APP_ENV: workerConfigSchema.APP_ENV,
  LOG_LEVEL: workerConfigSchema.LOG_LEVEL,
  // velexis_ota_app: provisionTenant re-reads the tenant through the read-only platform repository.
  DATABASE_URL: workerConfigSchema.DATABASE_URL,
  // velexis_provisioner: the provisioning transaction.
  DATABASE_PROVISIONER_URL: workerConfigSchema.DATABASE_PROVISIONER_URL,
  // velexis_migrator: the development-only platform writes (the file header). Never in an app's configuration.
  DATABASE_MIGRATOR_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
  API_KEY_PEPPER_FILE: apiConfigSchema.API_KEY_PEPPER_FILE,
  STOREFRONT_BASE_DOMAIN: apiConfigSchema.STOREFRONT_BASE_DOMAIN,
} as const;

// ---- API keys (PADR-0005) ----------------------------------------------------------------------------------------

/** The base62 characters after `pk_test_` / `sk_test_` (PADR-0005 item 1). */
export const API_KEY_SECRET_LENGTH = 40;
/** The visible, unique prefix: the first 14 characters (PADR-0005 item 2). */
export const API_KEY_PREFIX_LENGTH = 14;
/** How many keys are made at most when their prefix exists already (PADR-0005 item 2). */
const API_KEY_MAX_TRIES = 3;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Bytes from 248 up are drawn again, so every character is uniform (248 = 4 × 62). */
const BASE62_BYTE_LIMIT = 248;

/** `length` uniform base62 characters from the CSPRNG (rejection sampling). */
export function randomBase62(length: number): string {
  let text = "";
  while (text.length < length) {
    const bytes = randomBytes(length - text.length + 8);
    for (const byte of bytes) {
      if (byte < BASE62_BYTE_LIMIT && text.length < length) {
        text += BASE62[byte % 62] ?? "";
      }
    }
    bytes.fill(0);
  }
  return text;
}

export type DevKeyKind = keyof typeof DEV_SEED_KEY_NAMES;

/** A new test key of `kind`: the full key (shown once) and the columns of its row. */
export function newTestKey(
  kind: DevKeyKind,
  pepper: Buffer,
): { readonly key: string; readonly prefix: string; readonly last4: string; readonly keyHash: string } {
  const key = `${kind === "publishable" ? "pk" : "sk"}_${ENVIRONMENT}_${randomBase62(API_KEY_SECRET_LENGTH)}`;
  return {
    key,
    prefix: key.slice(0, API_KEY_PREFIX_LENGTH),
    last4: key.slice(-4),
    keyHash: hashApiKey(key, pepper),
  };
}

// ---- The seed ----------------------------------------------------------------------------------------------------

type MigratorDb = Kysely<PlatformDatabase>;
type MigratorTx = Transaction<PlatformDatabase>;

/** Something the platform's dev:seed should have created, or a state dev:seed does not change. */
export class DevSeedRefusal extends Error {
  override readonly name = "DevSeedRefusal";
}

/** What the platform rows step found or did. */
export interface PlatformSeedOutcome {
  readonly tenantId: string;
  readonly tenantCreated: boolean;
  readonly tenantStatus: string;
  readonly hostname: string;
  readonly domainCreated: boolean;
  readonly officeId: string | null;
  readonly connectionCreated: boolean;
  readonly amadeusAccountStatus: string;
  readonly paymentConnectionCreated: boolean;
  /** The keys created by this run, with their full text (shown once). */
  readonly createdKeys: ReadonlyArray<{
    readonly kind: DevKeyKind;
    readonly id: string;
    readonly key: string;
  }>;
  /** The kinds whose valid test key existed already. */
  readonly existingKeys: readonly DevKeyKind[];
}

/** The tenant statuses dev:seed continues from: before or after its own provisioning. */
const SEEDABLE_STATUSES: readonly string[] = ["provisioning", "active"];

async function seedTenantRow(
  trx: MigratorTx,
  now: Date,
): Promise<{ id: string; created: boolean; status: string }> {
  const id = newId("ten", now);
  const inserted = await trx
    .insertInto("platform.tenants")
    .values({
      id,
      key: DEV_TENANT.key,
      name: DEV_TENANT.name,
      status: "provisioning",
      plan_code: DEV_TENANT.planCode,
      default_currency: DEV_TENANT.defaultCurrency,
      default_locale: DEV_TENANT.defaultLocale,
      storefront_environment: ENVIRONMENT,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) => conflict.column("key").doNothing())
    .returning(["id", "status"])
    .executeTakeFirst();
  if (inserted !== undefined) {
    return { id: inserted.id, created: true, status: inserted.status };
  }
  const existing = await trx
    .selectFrom("platform.tenants")
    .select(["id", "status"])
    .where("key", "=", DEV_TENANT.key)
    .forUpdate()
    .executeTakeFirstOrThrow();
  return { id: existing.id, created: false, status: existing.status };
}

async function seedSubdomain(
  trx: MigratorTx,
  tenantId: string,
  hostname: string,
  now: Date,
): Promise<boolean> {
  const inserted = await trx
    .insertInto("platform.tenant_domains")
    .values({
      id: newId("dom", now),
      tenant_id: tenantId,
      hostname,
      kind: "subdomain",
      purpose: "storefront",
      is_primary: true,
      verification_status: "verified",
      verified_at: now,
      created_at: now,
      updated_at: now,
    })
    // The host name is unique, and so is a tenant's primary storefront host: either conflict keeps what is there.
    .onConflict((conflict) => conflict.doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted !== undefined) {
    return true;
  }
  const owner = await trx
    .selectFrom("platform.tenant_domains")
    .select("tenant_id")
    .where("hostname", "=", hostname)
    .executeTakeFirst();
  if (owner === undefined) {
    throw new DevSeedRefusal(
      `The tenant ${DEV_TENANT.key} has another primary storefront host than ${hostname} (was STOREFRONT_BASE_DOMAIN ` +
        "changed?); dev:seed leaves it alone.",
    );
  }
  if (owner.tenant_id !== tenantId) {
    throw new DevSeedRefusal(
      `The host name ${hostname} belongs to another tenant; dev:seed leaves it alone.`,
    );
  }
  return false;
}

/** The Amadeus test connection (step 3 of the file header). */
async function seedAmadeusConnection(
  trx: MigratorTx,
  tenantId: string,
  now: Date,
): Promise<{ officeId: string | null; created: boolean; accountStatus: string }> {
  const account = await trx
    .selectFrom("platform.amadeus_accounts")
    .select(["id", "status"])
    .where("environment", "=", ENVIRONMENT)
    .executeTakeFirst();
  if (account === undefined) {
    throw new DevSeedRefusal(
      "There is no Velexis test Amadeus account: run the platform's dev:seed first " +
        "(pnpm --filter @velexis/platform-backend dev:seed), then this one again.",
    );
  }
  const existing = await trx
    .selectFrom("platform.supplier_connections")
    .select(["default_office_id"])
    .where("tenant_id", "=", tenantId)
    .where("provider", "=", "amadeus")
    .where("environment", "=", ENVIRONMENT)
    .executeTakeFirst();
  if (existing !== undefined) {
    return { officeId: existing.default_office_id, created: false, accountStatus: account.status };
  }
  let office = await trx
    .selectFrom("platform.amadeus_offices")
    .select(["id", "office_id"])
    .where("amadeus_account_id", "=", account.id)
    .where("assigned_tenant_id", "=", tenantId)
    .where("status", "=", "assigned")
    .executeTakeFirst();
  if (office === undefined) {
    office = await trx
      .selectFrom("platform.amadeus_offices")
      .select(["id", "office_id"])
      .where("amadeus_account_id", "=", account.id)
      .where("status", "=", "available")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(1)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (office === undefined) {
      throw new DevSeedRefusal(
        "The Velexis test Amadeus account has no available office: run the platform's dev:seed first, or add an " +
          "office to the pool in the platform admin.",
      );
    }
    await trx
      .updateTable("platform.amadeus_offices")
      .set({
        status: "assigned",
        assigned_tenant_id: tenantId,
        assigned_at: now,
        release_requested_at: null,
        version: sql<number>`version + 1`,
        updated_at: now,
      })
      .where("id", "=", office.id)
      .where("status", "=", "available")
      .executeTakeFirstOrThrow();
  }
  await trx
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc", now),
      tenant_id: tenantId,
      provider: "amadeus",
      environment: ENVIRONMENT,
      credential_source: "velexis",
      amadeus_account_id: account.id,
      office_ids: [office.office_id],
      default_office_id: office.office_id,
      queuing_office_id: office.office_id,
      owner_office_id: office.office_id,
      // jsonb columns are written as JSON text.
      ticketing_defaults: JSON.stringify({}),
      monitored_queues: JSON.stringify([]),
      status: "active",
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { officeId: office.office_id, created: true, accountStatus: account.status };
}

async function seedPaymentConnection(trx: MigratorTx, tenantId: string, now: Date): Promise<boolean> {
  const inserted = await trx
    .insertInto("platform.payment_provider_connections")
    .values({
      id: newId("ppc", now),
      tenant_id: tenantId,
      provider: "stripe",
      environment: ENVIRONMENT,
      account_mode: "velexis",
      capture_mode: "manual",
      is_default: true,
      status: "active",
      statement_descriptor_suffix: DEV_TENANT.statementDescriptorSuffix,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) => conflict.columns(["tenant_id", "provider", "environment"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return inserted !== undefined;
}

/** The kinds of which the tenant has a valid (neither revoked nor expired) test key. */
async function validKeyKinds(trx: MigratorTx, tenantId: string, now: Date): Promise<Set<string>> {
  const rows = await trx
    .selectFrom("platform.api_keys")
    .select("kind")
    .where("tenant_id", "=", tenantId)
    .where("environment", "=", ENVIRONMENT)
    .where("revoked_at", "is", null)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
    .execute();
  return new Set(rows.map((row) => row.kind));
}

async function insertKey(
  trx: MigratorTx,
  tenantId: string,
  kind: DevKeyKind,
  pepper: Buffer,
  now: Date,
): Promise<{ id: string; key: string }> {
  for (let attempt = 0; attempt < API_KEY_MAX_TRIES; attempt += 1) {
    const made = newTestKey(kind, pepper);
    const id = newId("key", now);
    const inserted = await trx
      .insertInto("platform.api_keys")
      .values({
        id,
        tenant_id: tenantId,
        name: DEV_SEED_KEY_NAMES[kind],
        kind,
        environment: ENVIRONMENT,
        prefix: made.prefix,
        key_hash: made.keyHash,
        last4: made.last4,
        allowed_origins: [],
        scopes: kind === "secret" ? ["storefront"] : [],
        created_at: now,
        updated_at: now,
      })
      // A prefix that exists already costs a new key, not the transaction (PADR-0005 item 2).
      .onConflict((conflict) => conflict.doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted !== undefined) {
      return { id, key: made.key };
    }
  }
  throw new Error(`dev:seed: no unused prefix for a ${kind} key after ${API_KEY_MAX_TRIES} tries`);
}

/** Steps 1 to 5 of the file header, in one transaction as velexis_migrator. */
export async function seedPlatformRows(
  migrator: MigratorDb,
  options: { readonly baseDomain: string; readonly pepper: Buffer; readonly now: Date },
): Promise<PlatformSeedOutcome> {
  const { now, pepper } = options;
  const hostname = `${DEV_TENANT.key}.${options.baseDomain}`;
  return migrator.transaction().execute(async (trx) => {
    const tenant = await seedTenantRow(trx, now);
    if (!SEEDABLE_STATUSES.includes(tenant.status)) {
      throw new DevSeedRefusal(
        `The tenant ${DEV_TENANT.key} (${tenant.id}) is ${tenant.status}; dev:seed only continues a provisioning or ` +
          "active demo tenant and changes nothing else.",
      );
    }
    const domainCreated = await seedSubdomain(trx, tenant.id, hostname, now);
    const amadeus = await seedAmadeusConnection(trx, tenant.id, now);
    const paymentConnectionCreated = await seedPaymentConnection(trx, tenant.id, now);
    const valid = await validKeyKinds(trx, tenant.id, now);
    const createdKeys: Array<{ kind: DevKeyKind; id: string; key: string }> = [];
    const existingKeys: DevKeyKind[] = [];
    for (const kind of ["publishable", "secret"] as const) {
      if (valid.has(kind)) {
        existingKeys.push(kind);
      } else {
        createdKeys.push({ kind, ...(await insertKey(trx, tenant.id, kind, pepper, now)) });
      }
    }
    return {
      tenantId: tenant.id,
      tenantCreated: tenant.created,
      tenantStatus: tenant.status,
      hostname,
      domainCreated,
      officeId: amadeus.officeId,
      connectionCreated: amadeus.created,
      amadeusAccountStatus: amadeus.accountStatus,
      paymentConnectionCreated,
      createdKeys,
      existingKeys,
    };
  });
}

/**
 * The platform's side of a successful provisioning, in one transaction: the ledger mirror and `schema_version`
 * (`record_migrations`), then `provisioning → active` with `activated_at` (`activate`). Returns true when this call
 * activated the tenant.
 */
export async function recordProvisioning(
  migrator: MigratorDb,
  tenantId: string,
  payload: {
    readonly schemaName: string;
    readonly schemaVersion: string;
    readonly migrations: ReadonlyArray<{
      readonly version: string;
      readonly checksum: string;
      readonly phase: string;
      readonly appliedAt: string;
      readonly durationMs: number | null;
    }>;
  },
  now: Date,
): Promise<boolean> {
  return migrator.transaction().execute(async (trx) => {
    for (const migration of payload.migrations) {
      const finishedAt = new Date(migration.appliedAt);
      const values = {
        schema_name: payload.schemaName,
        checksum: migration.checksum,
        phase: migration.phase,
        status: "applied",
        runner_id: DEV_SEED_COMMAND,
        started_at:
          migration.durationMs === null ? finishedAt : new Date(finishedAt.getTime() - migration.durationMs),
        finished_at: finishedAt,
        duration_ms: migration.durationMs,
        error: null,
        updated_at: now,
      };
      await trx
        .insertInto("platform.tenant_schema_migrations")
        .values({ ...values, tenant_id: tenantId, version: migration.version, created_at: now })
        .onConflict((conflict) => conflict.columns(["tenant_id", "version"]).doUpdateSet(values))
        .execute();
    }
    await trx
      .updateTable("platform.tenants")
      .set({ schema_version: payload.schemaVersion, updated_at: now })
      .where("id", "=", tenantId)
      .where((eb) =>
        eb.or([eb("schema_version", "is", null), eb("schema_version", "!=", payload.schemaVersion)]),
      )
      .execute();
    const activated = await trx
      .updateTable("platform.tenants")
      .set({ status: "active", activated_at: now, version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", tenantId)
      .where("status", "=", "provisioning")
      .returning("id")
      .executeTakeFirst();
    return activated !== undefined;
  });
}

// ---- The command -------------------------------------------------------------------------------------------------

/** What `runDevSeed` gets from cli.ts. */
export interface DevSeedIo extends CliStreams {
  /** The configuration variables instead of the process environment and `.env.local` files (tests). */
  readonly env?: EnvSource | undefined;
  /** The tenant migrations folder and template folder (tests); default the release's. */
  readonly provisioning?: ProvisioningOptions | undefined;
}

/** APP_ENV as the source gives it, before any `.env.local` file is read; `undefined` when missing or invalid. */
function plainAppEnv(source: EnvSource | undefined): string | undefined {
  try {
    return defineConfig({ APP_ENV: DEV_SEED_CONFIG_SCHEMA.APP_ENV }, source).APP_ENV;
  } catch (error) {
    if (error instanceof ConfigError) {
      return undefined;
    }
    throw error;
  }
}

function refuseProduction(io: CliStreams): number {
  io.stderr.write(
    `${DEV_SEED_COMMAND} creates development data and refuses APP_ENV=production; nothing was written.\n`,
  );
  return 1;
}

function loadDevSeedConfig(source: EnvSource | undefined) {
  if (source !== undefined) {
    return defineConfig(DEV_SEED_CONFIG_SCHEMA, source);
  }
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig(DEV_SEED_CONFIG_SCHEMA);
}

function cliLogger(config: { APP_ENV: string; LOG_LEVEL: string }, io: CliStreams): Logger {
  const level = config.LOG_LEVEL === "debug" ? "debug" : config.LOG_LEVEL === "error" ? "error" : "warn";
  return createLogger({
    app: DEV_SEED_APP,
    env: config.APP_ENV,
    level,
    destination: { write: (line: string) => void io.stderr.write(line) },
  });
}

function seedLines(outcome: PlatformSeedOutcome): string[] {
  const state = (created: boolean): string => (created ? "created" : "exists already");
  const lines = [
    `Tenant ${DEV_TENANT.key} (${outcome.tenantId}), schema ${DEV_TENANT.schemaName}: ${state(outcome.tenantCreated)}.`,
    `Storefront host ${outcome.hostname}: ${state(outcome.domainCreated)}.`,
    `Amadeus test connection through the Velexis test account (${outcome.amadeusAccountStatus}), office ` +
      `${outcome.officeId ?? "none"}: ${state(outcome.connectionCreated)}.`,
    `Stripe test payment connection (velexis mode): ${state(outcome.paymentConnectionCreated)}.`,
  ];
  for (const kind of outcome.existingKeys) {
    lines.push(
      `${kind === "publishable" ? "Publishable" : "Secret"} test key: exists already (its key was shown when ` +
        "dev:seed created it).",
    );
  }
  if (outcome.createdKeys.length > 0) {
    lines.push("Test API keys created. Shown once, never again:");
    for (const created of outcome.createdKeys) {
      lines.push(
        `  ${created.kind === "publishable" ? "Publishable" : "Secret     "} (${created.id}): ${created.key}`,
      );
    }
  }
  return lines;
}

/** `dev:seed` (see the file header). */
export async function runDevSeed(args: readonly string[], io: DevSeedIo): Promise<number> {
  if (args.length > 0) {
    io.stderr.write(
      `${DEV_SEED_COMMAND}: the command takes no arguments.\nUsage: node dist/cli.js ${DEV_SEED_COMMAND}\n`,
    );
    return 1;
  }
  if (plainAppEnv(io.env) === "production") {
    return refuseProduction(io);
  }
  let config: ReturnType<typeof loadDevSeedConfig>;
  let pepper: Buffer;
  try {
    config = loadDevSeedConfig(io.env);
    if (config.APP_ENV === "production") {
      return refuseProduction(io);
    }
    const key = readKeyFile(config.API_KEY_PEPPER_FILE, { minBytes: API_KEY_PEPPER_MIN_BYTES });
    if (!Buffer.isBuffer(key)) {
      throw new TypeError("API_KEY_PEPPER_FILE must be a base64 key file");
    }
    pepper = key;
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr.write(`${DEV_SEED_COMMAND}: the configuration is invalid:\n${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const logger = cliLogger(config, io);
  const clock = new Clock();
  const migratorPool = createPool(config.DATABASE_MIGRATOR_URL, {
    applicationName: DEV_SEED_APP,
    logger,
    max: 2,
  });
  const otaPool = createPool(config.DATABASE_URL, { applicationName: DEV_SEED_APP, logger, max: 2 });
  const provisioner = createProvisionerDatabase(config, logger);
  try {
    const migrator = createPlatformDb<PlatformDatabase>(migratorPool);
    let outcome: PlatformSeedOutcome;
    try {
      outcome = await seedPlatformRows(migrator, {
        baseDomain: config.STOREFRONT_BASE_DOMAIN,
        pepper,
        now: clock.now(),
      });
    } catch (error) {
      if (error instanceof DevSeedRefusal) {
        io.stderr.write(`${DEV_SEED_COMMAND}: ${error.message}\n`);
        return 1;
      }
      throw error;
    }
    const lines = seedLines(outcome);

    const service = new ProvisioningService(
      new PlatformReadRepository(createPlatformDb(otaPool)),
      provisioner,
      io.provisioning ?? DEFAULT_PROVISIONING_OPTIONS,
      clock,
    );
    const result = await service.provisionTenant(outcome.tenantId);
    if (result.status === "failed") {
      io.stdout.write(`${lines.join("\n")}\n`);
      io.stderr.write(
        `${DEV_SEED_COMMAND}: provisioning ${DEV_TENANT.schemaName} failed: ${result.payload.error.code}: ` +
          `${result.payload.error.message}${result.payload.retryable ? " (retryable: run dev:seed again)" : ""}\n`,
      );
      return 1;
    }
    const activated = await recordProvisioning(migrator, outcome.tenantId, result.payload, clock.now());
    lines.push(
      `Schema ${result.payload.schemaName} at ${result.payload.schemaVersion}: ` +
        `${result.payload.steps.some((step) => step.status === "succeeded") ? "provisioned" : "complete already"}; ` +
        `tenant ${activated ? "activated" : "active"}.`,
      `Try it: curl -H "X-Api-Key: <the publishable key>" http://localhost:4000/v1/storefront`,
    );
    io.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } finally {
    await Promise.all([
      migratorPool.end().catch(() => undefined),
      otaPool.end().catch(() => undefined),
      provisioner.pool.end().catch(() => undefined),
    ]);
  }
}
