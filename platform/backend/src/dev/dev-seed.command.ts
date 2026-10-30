// `dev:seed` of dist/cli.js (PBE-034; README §5 and §6, platform/docs/flows/amadeus-connection.md §A item 4): the data a
// developer needs before the portal and the platform admin are of any use locally. Development and tests only: it
// refuses `APP_ENV=production` (exit 1) before it opens a connection. It creates, each only when it is missing:
//
// 1. The platform admin `admin@example.com`: an `active` account with a verified address, `is_platform_admin`, a new
//    random password (Argon2id, as PasswordPolicy stores every password) and TOTP MFA on (the secret envelope-encrypted
//    as MfaService stores it, associated data `platform.accounts.mfa_secret_ciphertext:<id>`). The password and the
//    `otpauth://` set-up URI are printed once, on stdout, when the account is created: they exist nowhere else in
//    clear (never logged, audited or stored), so a second run prints neither. An existing account of that address is
//    never changed (its password and MFA stay); a lost one is reset with `admin:reset-mfa` and "Forgot password".
// 2. The Velexis test Amadeus account (`amadeus_accounts`, environment `test`), pointing at AMADEUS_BASE_URL_TEST (the
//    Amadeus stub `http://127.0.0.1:4900` by default), client id DEV_SEED_AMADEUS_CLIENT_ID and a new random client
//    secret (envelope-encrypted with `platform.amadeus_accounts.client_secret_ciphertext:<id>`; the stub accepts any
//    non-empty pair). The command then verifies it as the `amadeus_account.verify` job does (amadeus-oauth.gateway.ts:
//    a token request to `{baseUrl}/v1/security/oauth2/token`, the token discarded): a token makes it `active` with
//    `last_verified_at`; a refusal `invalid_credentials`; no answer (the stub is not running) leaves it
//    `pending_verification` with `last_error`, and the command exits 1 asking to start the stub and run it again. A run
//    verifies an account it created whenever it is not `active` (and not `disabled`), so the second run after starting
//    the stub completes the seed. A test account that an admin configured is left as it is.
// 3. Twenty test offices (DEV_SEED_OFFICE_IDS: DEV1A0001 to DEV1A0020) in that account's pool, `available`; an office
//    id the pool holds already is skipped, whatever its status. Twenty since 2026-10-30 (ten before; lead decision
//    (2f), FIX-W34-SHARED): a whole e2e run sets up one OTA per journey on an office of this pool
//    (tools/e2e/README.md).
//
// Every change writes its audit row in its transaction (actor `system`, label `cli dev:seed by <operator>`, the user of
// the process): `admin.granted` for the new admin, `amadeus_account.created`, `amadeus_account.verified` or
// `amadeus_account.verification_failed`, `amadeus_office.added`; a run that changes nothing writes none. A changed
// account status publishes `vx:invalidate {type: "amadeus_account", id}` after the commit, as the verification job does.
//
// Exit codes are those of cli.ts: 0 when the admin (an active platform admin with MFA), the active test account and the
// twenty offices are in place, 1 when the command refused (production, an invalid configuration) or something is still
// missing (each said on stderr), 2 for an argument (the command takes none; it is never echoed). It runs in a Nest
// application context of its own (DevSeedModule: the CLI's common providers, the audit, the Amadeus repositories and
// the token check); log lines go to stderr. cli.ts loads this file only when the command runs.
import { randomBytes } from "node:crypto";
import { Inject, Injectable, Module, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigError, defineConfig, env, type ConfigSchema, type EnvSource } from "@velexis/config";
import { sql } from "@velexis/db";
import type { Logger } from "@velexis/logger";
import { LoggerModule } from "nestjs-pino";
import { accountSecretPlace, generateTotpSecret, otpauthUrl } from "../accounts/mfa.service";
import { defaultOperator } from "../admin/admin-cli.commands";
import { AuditModule } from "../audit/audit.module";
import { AuditService } from "../audit/audit.service";
import { PasswordPolicy } from "../auth/password-policy";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CliContext } from "../cli";
import { Clock } from "../common/clock";
import { CommonModule } from "../common/common.module";
import { EnvelopeService } from "../common/crypto.provider";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import {
  configModule,
  createProcessLogger,
  loadConfig,
  PLATFORM_BACKEND_CONFIG_SCHEMA,
  PLATFORM_PROCESSES,
  type PlatformBackendConfig,
} from "../config";
import {
  AmadeusAccountsRepository,
  type AmadeusAccountRecord,
} from "../supplier-connections/amadeus-accounts.repository";
import { AmadeusOAuthGateway, type AmadeusTokenCheck } from "../supplier-connections/amadeus-oauth.gateway";
import { AmadeusOfficesRepository } from "../supplier-connections/amadeus-offices.repository";
import { clientSecretPlace, verificationOutcome } from "../supplier-connections/verification.processor";

/** The command word. */
export const DEV_SEED_COMMAND = "dev:seed";

/** The development platform admin's address (an example domain: nothing is ever delivered there). */
export const DEV_SEED_ADMIN_EMAIL = "admin@example.com";

/** The development platform admin's name. */
export const DEV_SEED_ADMIN_NAME = "Velexis Dev Admin";

/** The client id of the test Amadeus account dev:seed creates; it marks the account as the seed's own. */
export const DEV_SEED_AMADEUS_CLIENT_ID = "velexis-dev-seed";

/** The name of the test Amadeus account dev:seed creates, as the platform admin lists it. */
export const DEV_SEED_AMADEUS_NAME = "Velexis test account (dev:seed)";

/**
 * The twenty test office ids `DEV1A0001` to `DEV1A0020` (9 upper-case letters and digits, as
 * `amadeus_offices.office_id` requires; ten until lead decision (2f) of 2026-10-30).
 */
export const DEV_SEED_OFFICE_IDS: readonly string[] = Object.freeze(
  Array.from({ length: 20 }, (_, index) => `DEV1A${String(index + 1).padStart(4, "0")}`),
);

/** The notes of the offices dev:seed adds. */
export const DEV_SEED_OFFICE_NOTES = "Test office of dev:seed (development only)";

/** The Amadeus stub of local development (`pnpm stub:amadeus`, tools/amadeus-stub). */
export const DEV_SEED_DEFAULT_AMADEUS_BASE_URL = "http://127.0.0.1:4900";

/**
 * What `amadeus_accounts.base_url` accepts (its CHECK constraint, migration 0002): an `https` URL, or the loopback stub
 * `http://127.0.0.1[:port]` without a path.
 */
export const AMADEUS_BASE_URL_RULE = /^(?:https:\/\/\S+|http:\/\/127\.0\.0\.1(?::[0-9]{1,5})?)$/;

/**
 * The variable dev:seed reads beyond the backend's configuration: the host of the test account it creates
 * (README §3, the same name as the OTA backend's). It is validated here, not in config.ts, because only this
 * development command uses it in M1.
 */
export const DEV_SEED_CONFIG_SCHEMA = {
  AMADEUS_BASE_URL_TEST: env.url({
    protocols: ["http:", "https:"],
    default: DEV_SEED_DEFAULT_AMADEUS_BASE_URL,
  }),
} as const satisfies ConfigSchema;

/** The actor label of the command's audit rows. */
export function devSeedActorLabel(operator: string): string {
  return `cli ${DEV_SEED_COMMAND} by ${operator}`;
}

/** A new random secret: `bytes` bytes from the CSPRNG in base64url (no padding). */
function randomSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** What the admin step found or did. */
export type AdminSeedOutcome =
  | {
      readonly result: "created";
      readonly accountId: string;
      /** Shown once; never stored in clear, logged or audited. */
      readonly password: string;
      /** Shown once; the secret in it is stored only encrypted. */
      readonly otpauthUrl: string;
    }
  | {
      readonly result: "exists";
      readonly accountId: string;
      /** True when the account is an `active` platform admin with MFA, as dev:seed would have made it. */
      readonly ready: boolean;
    };

/** The non-secret state of the test Amadeus account after the Amadeus step. */
export interface AmadeusSeedOutcome {
  readonly accountId: string;
  readonly baseUrl: string;
  readonly status: string;
  readonly lastError: string | null;
  readonly created: boolean;
  /** True when the account was created by dev:seed (its client id), so dev:seed verifies it. */
  readonly ownedBySeed: boolean;
  /** What the token request of this run answered, `undefined` when none was sent. */
  readonly check: AmadeusTokenCheck["outcome"] | "undecryptable" | undefined;
}

/** What the office step did, in DEV_SEED_OFFICE_IDS order. */
export interface OfficeSeedOutcome {
  readonly added: readonly string[];
  readonly present: readonly string[];
}

/** The account columns the admin step reads. */
interface ExistingAccount {
  readonly id: string;
  readonly status: string;
  readonly is_platform_admin: boolean;
  readonly mfa_enabled: boolean;
  readonly deleted_at: Date | null;
}

/** The work of dev:seed, in the command's application context. */
@Injectable()
export class DevSeedService {
  constructor(
    private readonly amadeusAccounts: AmadeusAccountsRepository,
    private readonly amadeusOffices: AmadeusOfficesRepository,
    private readonly gateway: AmadeusOAuthGateway,
    private readonly passwords: PasswordPolicy,
    private readonly envelope: EnvelopeService,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  private async findAdminAccount(db: PlatformDb = this.db): Promise<ExistingAccount | undefined> {
    return db
      .selectFrom("platform.accounts")
      .select(["id", "status", "is_platform_admin", "mfa_enabled", "deleted_at"])
      .where(sql<string>`lower(email)`, "=", DEV_SEED_ADMIN_EMAIL.toLowerCase())
      .executeTakeFirst();
  }

  private static existing(account: ExistingAccount): AdminSeedOutcome {
    const ready =
      account.status === "active" &&
      account.deleted_at === null &&
      account.is_platform_admin &&
      account.mfa_enabled;
    return { result: "exists", accountId: account.id, ready };
  }

  /** Step 1 (see the file header). */
  async seedAdmin(label: string, operator: string): Promise<AdminSeedOutcome> {
    const found = await this.findAdminAccount();
    if (found !== undefined) {
      return DevSeedService.existing(found);
    }
    let password = randomSecret(18);
    while (this.passwords.problem(password) !== undefined) {
      password = randomSecret(18);
    }
    const passwordHash = await this.passwords.hash(password);
    const secret = generateTotpSecret();
    const id = this.ids.new("acc");
    const encrypted = await this.envelope.encrypt(secret, accountSecretPlace(id));
    const now = this.clock.now();
    const inserted = await runInTransaction(this.db, async (trx) => {
      const row = await trx
        .insertInto("platform.accounts")
        .values({
          id,
          email: DEV_SEED_ADMIN_EMAIL,
          email_verified_at: now,
          password_hash: passwordHash,
          password_changed_at: now,
          full_name: DEV_SEED_ADMIN_NAME,
          status: "active",
          is_platform_admin: true,
          mfa_enabled: true,
          mfa_enabled_at: now,
          mfa_secret_ciphertext: Buffer.from(encrypted.ciphertext),
          encryption_key_id: encrypted.kekId,
          created_at: now,
          updated_at: now,
        })
        // A concurrent run inserted the address first (`accounts_email_lower_uq`): that account stays.
        .onConflict((conflict) => conflict.doNothing())
        .returning("id")
        .executeTakeFirst();
      if (row === undefined) {
        return false;
      }
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: label,
        action: "admin.granted",
        targetType: "account",
        targetId: id,
        after: { isPlatformAdmin: true, mfaEnabled: true },
        details: { command: DEV_SEED_COMMAND, operator, accountCreated: true },
      });
      return true;
    });
    if (!inserted) {
      const raced = await this.findAdminAccount();
      if (raced === undefined) {
        throw new Error("dev:seed: the admin account is neither inserted nor found");
      }
      return DevSeedService.existing(raced);
    }
    return {
      result: "created",
      accountId: id,
      password,
      otpauthUrl: otpauthUrl(DEV_SEED_ADMIN_EMAIL, secret),
    };
  }

  private async findTestAccount(): Promise<AmadeusAccountRecord | undefined> {
    return (await this.amadeusAccounts.list()).find((row) => row.environment === "test");
  }

  /** Step 2 (see the file header). `createdBy` is the admin of step 1. */
  async seedAmadeusAccount(
    baseUrl: string,
    createdBy: string,
    label: string,
    operator: string,
  ): Promise<AmadeusSeedOutcome> {
    let account = await this.findTestAccount();
    let created = false;
    if (account === undefined) {
      const id = this.ids.new("ama");
      const encrypted = await this.envelope.encrypt(randomSecret(24), clientSecretPlace(id));
      const now = this.clock.now();
      const inserted = await runInTransaction(this.db, async (trx) => {
        const row = await this.amadeusAccounts.insertIfNew(trx, {
          id,
          name: DEV_SEED_AMADEUS_NAME,
          environment: "test",
          base_url: baseUrl,
          client_id: DEV_SEED_AMADEUS_CLIENT_ID,
          client_secret_ciphertext: Buffer.from(encrypted.ciphertext),
          encryption_key_id: encrypted.kekId,
          created_by_account_id: createdBy,
          created_at: now,
          updated_at: now,
        });
        if (row !== undefined) {
          await this.audit.record(trx, {
            actorType: "system",
            actorLabel: label,
            action: "amadeus_account.created",
            targetType: "amadeus_account",
            targetId: row.id,
            after: {
              name: row.name,
              environment: row.environment,
              baseUrl: row.base_url,
              clientId: row.client_id,
              status: row.status,
            },
            details: { command: DEV_SEED_COMMAND, operator },
          });
        }
        return row;
      });
      created = inserted !== undefined;
      account = inserted ?? (await this.findTestAccount());
      if (account === undefined) {
        throw new Error("dev:seed: the test Amadeus account is neither inserted nor found");
      }
    }
    const ownedBySeed = account.client_id === DEV_SEED_AMADEUS_CLIENT_ID;
    let check: AmadeusSeedOutcome["check"];
    if (ownedBySeed && account.status !== "active" && account.status !== "disabled") {
      const verified = await this.verify(account, label);
      account = verified.account;
      check = verified.check;
    }
    return {
      accountId: account.id,
      baseUrl: account.base_url,
      status: account.status,
      lastError: account.last_error,
      created,
      ownedBySeed,
      check,
    };
  }

  /**
   * The token check of the `amadeus_account.verify` job for `tested`, and its result written when the account still
   * has the tested host, client id, secret and status. "Amadeus unavailable" keeps the status (with the error), as a
   * job attempt that BullMQ would try again does.
   */
  private async verify(
    tested: AmadeusAccountRecord,
    label: string,
  ): Promise<{ account: AmadeusAccountRecord; check: AmadeusSeedOutcome["check"] }> {
    const result = await this.check(tested);
    const outcome = verificationOutcome(result, tested.status, false, this.clock.now());
    const account = await runInTransaction(this.db, async (trx) => {
      const current = await this.amadeusAccounts.lock(trx, tested.id);
      const unchanged =
        current !== undefined &&
        current.base_url === tested.base_url &&
        current.client_id === tested.client_id &&
        current.status === tested.status &&
        Buffer.from(current.client_secret_ciphertext).equals(Buffer.from(tested.client_secret_ciphertext));
      if (current === undefined || !unchanged) {
        return current ?? tested;
      }
      const row = await this.amadeusAccounts.recordVerification(
        trx,
        tested.id,
        outcome.fields,
        this.clock.now(),
      );
      if (!outcome.retry) {
        await this.audit.record(trx, {
          actorType: "system",
          actorLabel: label,
          action:
            result.outcome === "verified"
              ? "amadeus_account.verified"
              : "amadeus_account.verification_failed",
          targetType: "amadeus_account",
          targetId: row.id,
          before: { status: current.status },
          after: { status: row.status },
          details: {
            command: DEV_SEED_COMMAND,
            environment: row.environment,
            outcome: result.outcome,
            ...(row.last_error === null ? {} : { lastError: row.last_error }),
          },
        });
      }
      if (row.status !== current.status) {
        this.invalidations.publishAfterCommit(trx, { v: 1, type: "amadeus_account", id: row.id });
      }
      return row;
    });
    return { account, check: result.outcome };
  }

  /** Decrypts the secret and requests a token with it; the secret's bytes are zeroed when the request is sent. */
  private async check(
    account: AmadeusAccountRecord,
  ): Promise<AmadeusTokenCheck | { readonly outcome: "undecryptable"; readonly error: string }> {
    let plaintext: Buffer;
    try {
      plaintext = await this.envelope.decrypt(
        account.client_secret_ciphertext,
        clientSecretPlace(account.id),
      );
    } catch {
      return { outcome: "undecryptable", error: "the stored client secret cannot be decrypted" };
    }
    try {
      return await this.gateway.checkCredentials({
        baseUrl: account.base_url,
        clientId: account.client_id,
        clientSecret: plaintext.toString("utf8"),
      });
    } finally {
      plaintext.fill(0);
    }
  }

  /** Step 3 (see the file header). */
  async seedOffices(amadeusAccountId: string, label: string, operator: string): Promise<OfficeSeedOutcome> {
    const now = this.clock.now();
    return runInTransaction(this.db, async (trx) => {
      const inserted = await this.amadeusOffices.insertNew(
        trx,
        DEV_SEED_OFFICE_IDS.map((officeId) => ({
          id: this.ids.new("amo"),
          amadeus_account_id: amadeusAccountId,
          office_id: officeId,
          notes: DEV_SEED_OFFICE_NOTES,
          created_at: now,
          updated_at: now,
        })),
      );
      const addedIds = new Set(inserted.map((row) => row.office_id));
      const added = DEV_SEED_OFFICE_IDS.filter((officeId) => addedIds.has(officeId));
      const present = DEV_SEED_OFFICE_IDS.filter((officeId) => !addedIds.has(officeId));
      if (added.length > 0) {
        await this.audit.record(trx, {
          actorType: "system",
          actorLabel: label,
          action: "amadeus_office.added",
          targetType: "amadeus_account",
          targetId: amadeusAccountId,
          details: {
            command: DEV_SEED_COMMAND,
            operator,
            environment: "test",
            created: added,
            skipped: present,
            notes: DEV_SEED_OFFICE_NOTES,
          },
        });
      }
      return { added, present };
    });
  }
}

/** The application context of dev:seed (see the file header). */
@Module({})
export class DevSeedModule {
  static forRoot(config: PlatformBackendConfig, logger: Logger): DynamicModule {
    return {
      module: DevSeedModule,
      imports: [
        configModule(config),
        LoggerModule.forRoot({ pinoHttp: { logger } }),
        CommonModule.forCli(),
        AuditModule,
      ],
      providers: [
        AmadeusAccountsRepository,
        AmadeusOfficesRepository,
        AmadeusOAuthGateway,
        { provide: PasswordPolicy, useFactory: () => PasswordPolicy.load() },
        DevSeedService,
      ],
    };
  }
}

/** The CLI's log level: `info` lines would only repeat what the command prints, so `info` becomes `warn`. */
function cliLogLevel(level: PlatformBackendConfig["LOG_LEVEL"]): PlatformBackendConfig["LOG_LEVEL"] {
  return level === "info" ? "warn" : level;
}

/** APP_ENV as `source` gives it before any `.env.local` file is read, or `undefined` when it is missing or invalid. */
function plainAppEnv(source: EnvSource | undefined): string | undefined {
  try {
    return defineConfig({ APP_ENV: PLATFORM_BACKEND_CONFIG_SCHEMA.APP_ENV }, source).APP_ENV;
  } catch (error) {
    if (error instanceof ConfigError) {
      return undefined;
    }
    throw error;
  }
}

/** The refusal in production: before any connection, so nothing is written. */
function refuseProduction(context: CliContext): number {
  context.stderr.write(
    `${DEV_SEED_COMMAND} creates development data and refuses APP_ENV=production; nothing was written.\n`,
  );
  return EXIT_FAILED;
}

/** What the run printed about each step: the lines for stdout, the problems for stderr. */
interface Report {
  readonly out: string[];
  readonly problems: string[];
}

function reportAdmin(report: Report, admin: AdminSeedOutcome): void {
  if (admin.result === "created") {
    report.out.push(
      `Platform admin ${DEV_SEED_ADMIN_EMAIL} (${admin.accountId}): created, with MFA. Shown once, never again:`,
      `  Password:         ${admin.password}`,
      `  TOTP set-up URI:  ${admin.otpauthUrl}`,
      "  Add the URI to an authenticator app, then sign in to the platform admin with the password and a code.",
    );
    return;
  }
  report.out.push(
    `Platform admin ${DEV_SEED_ADMIN_EMAIL} (${admin.accountId}): exists already; nothing changed (its password ` +
      "and TOTP set-up URI were shown when dev:seed created it; use admin:reset-mfa and the portal's " +
      '"Forgot password" to start over).',
  );
  if (!admin.ready) {
    report.problems.push(
      `The account ${DEV_SEED_ADMIN_EMAIL} is not an active platform admin with MFA, and dev:seed never changes an ` +
        "existing account: turn MFA on in the portal, then run admin:grant for it.",
    );
  }
}

function reportAmadeus(report: Report, amadeus: AmadeusSeedOutcome): void {
  const what = amadeus.created ? "created" : "exists";
  const verified = amadeus.check === "verified" ? ", verified" : "";
  report.out.push(
    `Velexis test Amadeus account (${amadeus.accountId}) at ${amadeus.baseUrl}: ${what}${verified}, ${amadeus.status}.`,
  );
  if (amadeus.status === "active") {
    return;
  }
  const error = amadeus.lastError === null ? "" : ` (${amadeus.lastError})`;
  const state = `The test Amadeus account is ${amadeus.status}${error}`;
  if (amadeus.status === "disabled") {
    // An admin disabled it (the seed never does): only the platform admin's "Verify" makes it active again.
    report.problems.push(
      `${state}: ${DEV_SEED_COMMAND} leaves a disabled account alone; verify it in the platform admin (Amadeus) to ` +
        "make it active again.",
    );
  } else if (amadeus.ownedBySeed) {
    report.problems.push(
      `${state}: start the Amadeus stub (pnpm stub:amadeus) at ${amadeus.baseUrl} and run ${DEV_SEED_COMMAND} again.`,
    );
  } else {
    report.problems.push(
      `${state} and was not created by ${DEV_SEED_COMMAND}: verify it in the platform admin (Amadeus).`,
    );
  }
}

function reportOffices(report: Report, offices: OfficeSeedOutcome): void {
  const first = DEV_SEED_OFFICE_IDS[0] ?? "";
  const last = DEV_SEED_OFFICE_IDS[DEV_SEED_OFFICE_IDS.length - 1] ?? "";
  report.out.push(
    `Test offices ${first} to ${last}: ${offices.added.length} added, ${offices.present.length} in the pool already.`,
  );
}

/** `dev:seed` (see the file header). */
export async function runDevSeed(args: readonly string[], context: CliContext): Promise<number> {
  if (args.length > 0) {
    context.stderr.write(
      `${DEV_SEED_COMMAND}: the command takes no arguments.\nUsage: node dist/cli.js ${DEV_SEED_COMMAND}\n`,
    );
    return EXIT_USAGE;
  }
  if (plainAppEnv(context.env) === "production") {
    return refuseProduction(context);
  }
  let config: PlatformBackendConfig;
  let baseUrl: string;
  try {
    config = loadConfig(context.env);
    if (config.APP_ENV === "production") {
      return refuseProduction(context);
    }
    baseUrl = defineConfig(DEV_SEED_CONFIG_SCHEMA, context.env).AMADEUS_BASE_URL_TEST;
  } catch (error) {
    if (error instanceof ConfigError) {
      context.stderr.write(`The configuration is invalid:\n${error.message}\n`);
      return EXIT_FAILED;
    }
    throw error;
  }
  if (!AMADEUS_BASE_URL_RULE.test(baseUrl)) {
    context.stderr.write(
      "AMADEUS_BASE_URL_TEST must be an https URL or the loopback Amadeus stub http://127.0.0.1:<port> " +
        "(no path); nothing was written.\n",
    );
    return EXIT_FAILED;
  }

  const logger = createProcessLogger(
    PLATFORM_PROCESSES.cli,
    { APP_ENV: config.APP_ENV, LOG_LEVEL: cliLogLevel(config.LOG_LEVEL) },
    { write: (line: string) => void context.stderr.write(line) },
  );
  const app = await NestFactory.createApplicationContext(DevSeedModule.forRoot(config, logger), {
    // Nest's own start-up lines are noise here; errors while the context is built reach the caller.
    logger: false,
    abortOnError: false,
  });
  try {
    const service = app.get(DevSeedService);
    const operator = defaultOperator();
    const label = devSeedActorLabel(operator);
    const report: Report = { out: [], problems: [] };

    const admin = await service.seedAdmin(label, operator);
    reportAdmin(report, admin);
    const amadeus = await service.seedAmadeusAccount(baseUrl, admin.accountId, label, operator);
    reportAmadeus(report, amadeus);
    reportOffices(report, await service.seedOffices(amadeus.accountId, label, operator));

    context.stdout.write(`${report.out.join("\n")}\n`);
    if (report.problems.length > 0) {
      context.stderr.write(`${report.problems.join("\n")}\n`);
      return EXIT_FAILED;
    }
    return EXIT_OK;
  } finally {
    await app.close();
  }
}
