// The admin bootstrap commands of dist/cli.js (PBE-028; PADR-0006 item 6,
// platform/docs/flows/platform-admin-operations.md §A item 2 and "Failure handling", README §5). The developer runs
// them on the VM (`sudo velexis-run platform node dist/cli.js admin:grant <email> --operator <name>`) or locally; no
// admin is created by migrations or seeds:
//
// - `admin:grant <email>` makes an existing account a platform admin. The account must be `active` with a verified
//   e-mail address and MFA enabled; otherwise the command changes nothing, says why on stderr and exits 1. An account
//   that is an admin already is left as it is (exit 0). The grant sets `is_platform_admin` (`version + 1`) and writes
//   one audit row `admin.granted` in the same transaction.
// - `admin:reset-mfa <email>` is the emergency reset of a platform admin who lost the authenticator and every recovery
//   code (the only admin cannot be reset in the admin itself). It writes the OTA cut-off `staffdeny:acct:<id>` first
//   (as signOutEverywhere does), then in one transaction turns MFA off (the secret is cleared, `version + 1`), deletes
//   the recovery codes, revokes every session family (portal and admin, reason `admin`), queues the `auth.mfa_changed`
//   e-mail (PADR-0008 item 6) and writes one audit row `account.mfa_reset`; after the commit it publishes an `account`
//   invalidation. The admin then signs in to the portal, turns MFA on again and signs in to the admin. Accounts that
//   are not platform admins are refused (exit 1): their MFA is reset in the admin (PBE-032). An admin without MFA is
//   left as it is (exit 0).
//
// Both audit rows have `actor_type = 'system'` and the actor label `cli <command> by <operator>`, with the operator in
// `details` too: `--operator <name>` names the person who ran the command, by default the user of the process (on the
// VM `velexis-run` starts the command as the zone's user, so pass `--operator` there). Exit codes are
// those of cli.ts: 0 done (or nothing to do), 1 refused or failed, 2 wrong arguments. A wrong argument is never echoed
// (it may be a secret typed in the wrong place).
//
// Each command loads the configuration (an invalid one exits 1 with the ConfigError, which names variables, never
// values) and runs in a Nest application context of its own (AdminCliModule): the CLI's common providers (a pool of 2
// connections named platform-cli, Redis, Clock), the audit, the outbox and the repositories of AuthModule. Log lines
// go to stderr, from `warn` up unless LOG_LEVEL asks for debug or trace. cli.ts loads this file only when one of these
// commands runs, so `help` needs neither Nest nor the configuration.
import { userInfo } from "node:os";
import { Inject, Injectable, Module, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigError } from "@velexis/config";
import type { Logger } from "@velexis/logger";
import type { Redis } from "ioredis";
import { LoggerModule } from "nestjs-pino";
import { MFA_CHANGES } from "../accounts/mfa.service";
import { RecoveryCodesRepository } from "../accounts/recovery-codes.repository";
import { AuditModule } from "../audit/audit.module";
import { AuditService } from "../audit/audit.service";
import { AccountsRepository } from "../auth/accounts.repository";
import { SessionsRepository } from "../auth/sessions.repository";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CliContext } from "../cli";
import { Clock } from "../common/clock";
import { CommonModule } from "../common/common.module";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { redisKeys, setKey } from "../common/redis/redis-keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import {
  configModule,
  createProcessLogger,
  EMAIL_ADDRESS,
  loadConfig,
  PLATFORM_PROCESSES,
  type PlatformBackendConfig,
} from "../config";
import { NotificationsModule } from "../notifications/notifications.module";
import { OutboxService } from "../notifications/outbox.service";

/** The two commands of this file. */
export type AdminCliCommandName = "admin:grant" | "admin:reset-mfa";

/** The arguments of both commands, for cli.ts's usage text. */
export const ADMIN_CLI_ARGUMENTS = "<email> [--operator <name>]";

/** What an operator name may be: a login or a person's name, one line, at most 64 characters. */
export const OPERATOR_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._@+-]{0,63}$/;

/** The parsed arguments of a command. */
export interface AdminCliArguments {
  /** The account's e-mail address as typed (trimmed); compared ignoring letter case. */
  readonly email: string;
  /** Who ran the command, for the audit row. */
  readonly operator: string;
}

/**
 * The operator when `--operator` is not given: the user this process runs as (`os.userInfo()`), else `unknown`. On
 * the VM that is the zone's user (`velexis-run` starts the command as `velexis-platform`), so the operator passes
 * `--operator <name>` there.
 */
export function defaultOperator(): string {
  try {
    const { username } = userInfo();
    if (OPERATOR_NAME.test(username)) {
      return username;
    }
  } catch {
    // No user database entry for this uid (a container): fall through.
  }
  return "unknown";
}

/**
 * `<email> [--operator <name>]` in any order, or the problem as one line (never quoting an argument). `operator` is
 * the default operator when the flag is absent.
 */
export function parseAdminCliArguments(
  args: readonly string[],
  operator: () => string = defaultOperator,
): AdminCliArguments | { readonly problem: string } {
  let email: string | undefined;
  let named: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--operator") {
      const value = args[index + 1];
      if (named !== undefined || value === undefined || !OPERATOR_NAME.test(value.trim())) {
        return {
          problem:
            "--operator needs one name: a letter or digit, then letters, digits, spaces and ._@+- (at most 64)",
        };
      }
      named = value.trim();
      index += 1;
    } else if (email === undefined && !arg.startsWith("-")) {
      email = arg.trim();
    } else {
      return { problem: "unexpected argument: give one e-mail address and, optionally, --operator <name>" };
    }
  }
  if (email === undefined || !EMAIL_ADDRESS.test(email)) {
    return { problem: "give the account's e-mail address (one address, as the person signed up with it)" };
  }
  return { email, operator: named ?? operator() };
}

/** What `admin:grant` found and did. */
export type GrantOutcome =
  | { readonly result: "granted"; readonly accountId: string }
  | { readonly result: "already_admin"; readonly accountId: string }
  | { readonly result: "not_found" | "not_verified" | "not_active" | "mfa_not_enabled" };

/** What `admin:reset-mfa` found and did. */
export type ResetMfaOutcome =
  | {
      readonly result: "reset";
      readonly accountId: string;
      readonly revokedFamilies: number;
      readonly recoveryCodesRemoved: number;
    }
  | { readonly result: "mfa_not_enabled"; readonly accountId: string }
  | { readonly result: "not_found" | "not_platform_admin" };

/** The actor label of the commands' audit rows. */
export function actorLabel(command: AdminCliCommandName, operator: string): string {
  return `cli ${command} by ${operator}`;
}

/** The work of the two commands, in the CLI's application context. */
@Injectable()
export class AdminCliService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly sessions: SessionsRepository,
    private readonly recoveryCodes: RecoveryCodesRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly publisher: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** admin:grant (see the file header). */
  async grant({ email, operator }: AdminCliArguments): Promise<GrantOutcome> {
    return runInTransaction(this.db, async (trx): Promise<GrantOutcome> => {
      const identity = await this.accounts.findByEmail(trx, email);
      const account =
        identity === undefined ? undefined : await this.accounts.lockMfaAccount(trx, identity.id);
      if (identity === undefined || account === undefined || account.deleted_at !== null) {
        return { result: "not_found" };
      }
      if (identity.email_verified_at === null || account.status === "pending_verification") {
        return { result: "not_verified" };
      }
      if (account.status !== "active") {
        return { result: "not_active" };
      }
      if (!account.mfa_enabled || account.mfa_secret_ciphertext === null) {
        return { result: "mfa_not_enabled" };
      }
      if (!(await this.accounts.grantPlatformAdmin(trx, account.id, this.clock.now()))) {
        return { result: "already_admin", accountId: account.id };
      }
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: actorLabel("admin:grant", operator),
        action: "admin.granted",
        targetType: "account",
        targetId: account.id,
        before: { isPlatformAdmin: false },
        after: { isPlatformAdmin: true },
        details: { command: "admin:grant", operator },
      });
      return { result: "granted", accountId: account.id };
    });
  }

  /** admin:reset-mfa (see the file header). */
  async resetMfa({ email, operator }: AdminCliArguments): Promise<ResetMfaOutcome> {
    const identity = await this.accounts.findByEmail(this.db, email);
    const found =
      identity === undefined ? undefined : await this.accounts.findMfaAccount(this.db, identity.id);
    if (found === undefined || found.deleted_at !== null) {
      return { result: "not_found" };
    }
    if (!found.is_platform_admin) {
      return { result: "not_platform_admin" };
    }
    if (!found.mfa_enabled) {
      return { result: "mfa_not_enabled", accountId: found.id };
    }
    // The OTA cut-off first: if Redis fails nothing is reset; if the database fails, the staff sessions are still cut
    // off, which errs on the safe side (as signOutEverywhere).
    const cutOff = this.clock.now();
    await setKey(this.redis, redisKeys.staffDenyAccount(found.id), String(cutOff.getTime()));
    return runInTransaction(this.db, async (trx): Promise<ResetMfaOutcome> => {
      const account = await this.accounts.lockMfaAccount(trx, found.id);
      if (account === undefined || account.deleted_at !== null) {
        return { result: "not_found" };
      }
      if (!account.is_platform_admin) {
        return { result: "not_platform_admin" };
      }
      const now = this.clock.now();
      if (!(await this.accounts.disableMfa(trx, account.id, now))) {
        return { result: "mfa_not_enabled", accountId: account.id };
      }
      const recoveryCodesRemoved = await this.recoveryCodes.deleteAll(trx, account.id);
      const revokedFamilies = await this.sessions.revokeAllOfAccount(trx, account.id, "admin", now);
      await this.outbox.queue(trx, {
        templateKey: "auth.mfa_changed",
        to: account.email,
        accountId: account.id,
        data: { fullName: account.full_name, change: MFA_CHANGES.disabled },
      });
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: actorLabel("admin:reset-mfa", operator),
        action: "account.mfa_reset",
        targetType: "account",
        targetId: account.id,
        before: { mfaEnabled: true },
        after: { mfaEnabled: false },
        details: {
          command: "admin:reset-mfa",
          operator,
          recoveryCodesRemoved,
          revokedFamilies,
          staffDenyFrom: cutOff.toISOString(),
        },
      });
      this.publisher.publishAfterCommit(trx, { v: 1, type: "account", accountId: account.id });
      return { result: "reset", accountId: account.id, revokedFamilies, recoveryCodesRemoved };
    });
  }
}

/** The application context of the admin commands (see the file header). */
@Module({})
export class AdminCliModule {
  static forRoot(config: PlatformBackendConfig, logger: Logger): DynamicModule {
    return {
      module: AdminCliModule,
      imports: [
        configModule(config),
        LoggerModule.forRoot({ pinoHttp: { logger } }),
        CommonModule.forCli(),
        AuditModule,
        NotificationsModule,
      ],
      providers: [AccountsRepository, SessionsRepository, RecoveryCodesRepository, AdminCliService],
    };
  }
}

/** The CLI's log level: `info` lines would only repeat what the command prints, so `info` becomes `warn`. */
function cliLogLevel(level: PlatformBackendConfig["LOG_LEVEL"]): PlatformBackendConfig["LOG_LEVEL"] {
  return level === "info" ? "warn" : level;
}

/**
 * Runs `work` with the AdminCliService of a new application context on the configuration of `context.env` (default:
 * the process environment and the `.env.local` files), and closes the context afterwards. Answers EXIT_FAILED after
 * writing the ConfigError when the configuration is invalid.
 */
async function withAdminCli(
  context: CliContext,
  work: (service: AdminCliService) => Promise<number>,
): Promise<number> {
  let config: PlatformBackendConfig;
  try {
    config = loadConfig(context.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      context.stderr.write(`The configuration is invalid:\n${error.message}\n`);
      return EXIT_FAILED;
    }
    throw error;
  }
  const logger = createProcessLogger(
    PLATFORM_PROCESSES.cli,
    { APP_ENV: config.APP_ENV, LOG_LEVEL: cliLogLevel(config.LOG_LEVEL) },
    { write: (line: string) => void context.stderr.write(line) },
  );
  const app = await NestFactory.createApplicationContext(AdminCliModule.forRoot(config, logger), {
    // Nest's own start-up lines are noise here; errors while the context is built reach the caller.
    logger: false,
    abortOnError: false,
  });
  try {
    return await work(app.get(AdminCliService));
  } finally {
    await app.close();
  }
}

/** The usage line of `command`, after a problem with its arguments. */
function usageError(context: CliContext, command: AdminCliCommandName, problem: string): number {
  context.stderr.write(
    `${command}: ${problem}.\nUsage: node dist/cli.js ${command} ${ADMIN_CLI_ARGUMENTS}\n`,
  );
  return EXIT_USAGE;
}

/** `admin:grant <email> [--operator <name>]` (see the file header). */
export async function runAdminGrant(args: readonly string[], context: CliContext): Promise<number> {
  const parsed = parseAdminCliArguments(args);
  if ("problem" in parsed) {
    return usageError(context, "admin:grant", parsed.problem);
  }
  return withAdminCli(context, async (service) => {
    const outcome = await service.grant(parsed);
    const who = parsed.email;
    switch (outcome.result) {
      case "granted":
        context.stdout.write(
          `${who} (${outcome.accountId}) is now a platform admin; one audit row admin.granted was written.\n`,
        );
        return EXIT_OK;
      case "already_admin":
        context.stdout.write(`${who} (${outcome.accountId}) is a platform admin already; nothing changed.\n`);
        return EXIT_OK;
      case "not_found":
        context.stderr.write(`No account has the e-mail address ${who}; nothing changed.\n`);
        return EXIT_FAILED;
      case "not_verified":
        context.stderr.write(
          `The account ${who} has not verified its e-mail address; nothing changed. ` +
            "The person verifies it from the sign-up e-mail first.\n",
        );
        return EXIT_FAILED;
      case "not_active":
        context.stderr.write(`The account ${who} is not active; nothing changed.\n`);
        return EXIT_FAILED;
      case "mfa_not_enabled":
        context.stderr.write(
          `The account ${who} has no MFA; nothing changed. ` +
            "The person turns MFA on in the portal first (Account, Security), then run admin:grant again.\n",
        );
        return EXIT_FAILED;
    }
  });
}

/** `admin:reset-mfa <email> [--operator <name>]` (see the file header). */
export async function runAdminResetMfa(args: readonly string[], context: CliContext): Promise<number> {
  const parsed = parseAdminCliArguments(args);
  if ("problem" in parsed) {
    return usageError(context, "admin:reset-mfa", parsed.problem);
  }
  return withAdminCli(context, async (service) => {
    const outcome = await service.resetMfa(parsed);
    const who = parsed.email;
    switch (outcome.result) {
      case "reset":
        context.stdout.write(
          `The MFA of ${who} (${outcome.accountId}) is reset: MFA is off, ${outcome.recoveryCodesRemoved} ` +
            `recovery codes are deleted and ${outcome.revokedFamilies} sessions are revoked; one audit row ` +
            "account.mfa_reset was written and the account is e-mailed. The admin signs in to the portal and turns " +
            "MFA on again before signing in to the platform admin.\n",
        );
        return EXIT_OK;
      case "mfa_not_enabled":
        context.stdout.write(`${who} (${outcome.accountId}) has no MFA to reset; nothing changed.\n`);
        return EXIT_OK;
      case "not_found":
        context.stderr.write(`No account has the e-mail address ${who}; nothing changed.\n`);
        return EXIT_FAILED;
      case "not_platform_admin":
        context.stderr.write(
          `The account ${who} is not a platform admin; nothing changed. ` +
            "Reset the MFA of a portal account in the platform admin (Accounts).\n",
        );
        return EXIT_FAILED;
    }
  });
}
