// `tenants:create-demo` of dist/cli.js (PBE-075; lead decision (20a) of 2026-11-13, approved by the owner;
// platform/docs/runbooks/launch-checklist.md §6, "The production demo OTA"): creates Velexis's own demo OTA, the OTA with
// the reserved key `demo` whose storefront `demo.<STOREFRONT_BASE_DOMAIN>` the external uptime monitor, the on-VM payment
// page check (`HEALTHCHECK_STOREFRONT_HOST`), the ASV scope and the airline-card go-live use
// (docs/mvp/deployment-single-vm.md §13). `demo` is reserved (tenant-key.ts): the portal's key check answers `reserved`
// and createTenant `409 TENANT_KEY_UNAVAILABLE`, for every caller but this command, which is the one way to create it,
// in production too. The developer runs it on the VM as the admin bootstrap is run:
//
//   sudo velexis-run platform node dist/cli.js tenants:create-demo <owner e-mail> --country <CC> --currency <CUR> \
//     --time-zone <zone> --operator "<your name>"
//
// 1. The arguments (exit 2 with the usage, never echoing what was typed, before any configuration is read): the owner's
//    e-mail address; `--country`, `--currency` and `--time-zone`, which createTenant requires (the reference data
//    checks them; no document fixes Velexis's own, so they have no default); `--name`, "Velexis demo" by default (1 to
//    100 characters, as `TenantName`); `--key`, which takes only a key of VELEXIS_OWN_TENANT_KEYS (`demo`, its default);
//    `--operator`, as admin:grant's (by default the user of the process).
// 2. The owner: an account with the address (`not_found`), verified (`not_verified`), `active` (`not_active`) and with
//    MFA on (`mfa_not_enabled`), checked as admin:grant checks them. A refusal exits 1 and changes nothing.
// 3. An OTA with the key already, in any status: it must be the owner's (an active `owner` membership of the account),
//    else `other_owner`; and `active` or `provisioning`, else `wrong_status` (a failed setup is retried by its owner on
//    the portal's setup page). Nothing is created then. Its subscription decides the rest (step 5): a manual one that is
//    `active` already changes nothing (exit 0); a manual one still `trialing` or `past_due` (a first run stopped
//    between its two transactions) is set `active`; anything else (billed by Stripe, canceled, none) is refused
//    (`unexpected`, exit 1, nothing changes).
// 4. Otherwise createTenant runs with the option VelexisOwnTenant (provisioning/lifecycle.service.ts, its file header):
//    the portal's own transaction, so the same rows (the tenant `provisioning` in the storefront environment `test`, the
//    owner membership, the manual trial of `early_access` whatever FEATURE_STRIPE_BILLING says, the verified primary
//    sub-domain, the `provision` job), the audit rows `tenant.created` and `tenant.reserved_key_used` with this command
//    as the actor, and the dispatch of the job after the commit. The OTA worker creates the tenant schema; the platform
//    worker's post-steps assign a test office, create the test payment connection, issue the initial test keys and
//    activate the OTA; a job the dispatch could not hand over is the reconciler's. Refusals of createTenant (an unknown
//    country, currency or time zone; the key taken meanwhile; the owner's tenant limit) exit 1 with nothing written.
// 5. Then the manual subscription goes `active` with the reason "Velexis demo OTA, not billed" through
//    SubscriptionsService.updateManual, the service of adminUpdateManualSubscription, in its own transaction (its
//    `subscription.manually_updated` row, this command as the actor), so `billing.manual_trials` never e-mails its owner
//    or suspends it, and go-live would accept it. When that fails, the OTA stays created and the command exits 1: run
//    it again, and step 3 completes it.
//
// Every audit row has `actor_type = 'system'`, the label `cli tenants:create-demo by <operator>` and `{command,
// operator}` in its details. The command prints ids, the e-mail address, the key, statuses and what to do next, never a
// secret (the initial test keys wait for the owner's one-time reveal on the portal's setup page, `/otas/<tenantId>/
// setup`, within 24 hours of the setup). Exit codes are cli.ts's: 0 created, completed or nothing to do; 1 refused or
// failed (the reason on stderr; an invalid configuration names variables, never values); 2 invalid arguments.
//
// It runs in a Nest application context of its own (DemoOtaCliModule): the CLI's common providers (a pool of 2
// connections named platform-cli, Redis, Clock, ids, the envelope encryption), the audit, the outbox and the queues,
// and the providers createTenant and the manual edit need, as AdminModule provides the latter (the Stripe client is
// never called: an OTA of Velexis's own has no Checkout). Log lines go to stderr. cli.ts loads this file only when the
// command runs, so `help` needs neither Nest nor the configuration.
import { Inject, Injectable, Module, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigError } from "@velexis/config";
import { AppError } from "@velexis/errors";
import type { Logger } from "@velexis/logger";
import { LoggerModule } from "nestjs-pino";
import { defaultOperator, OPERATOR_NAME } from "../admin/admin-cli.commands";
import { AuditModule } from "../audit/audit.module";
import type { AuditDetails } from "../audit/audit.service";
import { AccountsRepository } from "../auth/accounts.repository";
import { BillingCustomersRepository } from "../billing/billing-customers.repository";
import { CheckoutService } from "../billing/checkout.service";
import { PlansRepository } from "../billing/plans.repository";
import { StripeBillingGateway } from "../billing/stripe-billing.gateway";
import { SubscriptionsRepository } from "../billing/subscriptions.repository";
import { SubscriptionsService } from "../billing/subscriptions.service";
import { SubscriptionChangedHandler } from "../billing/sync/handlers/subscription-changed.handler";
import { PriceToPlan } from "../billing/sync/price-to-plan";
import { BillingStatusRules } from "../billing/sync/status-rules";
import { SubscriptionSyncLock } from "../billing/sync/subscription-lock";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CliContext } from "../cli";
import { CommonModule } from "../common/common.module";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { FeatureSwitches } from "../common/features";
import { QueuesModule } from "../common/queues/queues.module";
import { stripeClientProvider } from "../common/stripe/stripe.client";
import {
  configModule,
  createProcessLogger,
  EMAIL_ADDRESS,
  loadConfig,
  PLATFORM_PROCESSES,
  type PlatformBackendConfig,
} from "../config";
import { DomainsRepository } from "../domains/domains.repository";
import { MembershipsRepository } from "../memberships/memberships.repository";
import { NotificationsModule } from "../notifications/notifications.module";
import { PaymentConnectionsRepository } from "../payment-connections/payment-connections.repository";
import { ProvisioningDispatcher } from "../provisioning/dispatcher";
import { LifecycleService, type VelexisOwnTenant } from "../provisioning/lifecycle.service";
import { ProvisioningJobsRepository } from "../provisioning/provisioning-jobs.repository";
import { SuspensionService } from "../provisioning/suspension.service";
import { SupplierConnectionsRepository } from "../supplier-connections/supplier-connections.repository";
import { isVelexisOwnTenantKey, VELEXIS_OWN_TENANT_KEYS } from "./tenant-key";
import { TenantsRepository } from "./tenants.repository";

/** The command word. */
export const DEMO_OTA_COMMAND = "tenants:create-demo";

/** The arguments of the command, for cli.ts's usage text. */
export const DEMO_OTA_ARGUMENTS =
  "<email> --country <code> --currency <code> --time-zone <zone> [--name <name>] [--key demo] [--operator <name>]";

/** The usage line of the command. */
export const DEMO_OTA_USAGE = `Usage: node dist/cli.js ${DEMO_OTA_COMMAND} ${DEMO_OTA_ARGUMENTS}`;

/** The demo OTA's name when `--name` is not given. */
export const DEFAULT_DEMO_OTA_NAME = "Velexis demo";

/** The key when `--key` is not given: the first of Velexis's own keys, `demo`. */
export const DEFAULT_DEMO_OTA_KEY = VELEXIS_OWN_TENANT_KEYS[0] ?? "demo";

/** The reason of the manual edit that takes the demo OTA out of billing (launch checklist §6). */
export const DEMO_OTA_SUBSCRIPTION_REASON = "Velexis demo OTA, not billed";

/** The statuses of an existing OTA the command accepts: it is being set up, or it is set up. */
export const DEMO_OTA_ACCEPTED_STATUSES: readonly string[] = Object.freeze(["active", "provisioning"]);

/** The statuses of a manual subscription that the command sets `active`: a trial nobody has decided on. */
const OPEN_TRIAL_STATUSES: ReadonlySet<string> = new Set(["trialing", "past_due"]);

/** The rules of the values createTenant requires (`CountryCode`, `CurrencyCode`, `TimeZone`, `TenantName`). */
const COUNTRY_CODE = /^[A-Z]{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const TIME_ZONE = /^(?=.{1,64}$)[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const NAME_MAX_LENGTH = 100;
// eslint-disable-next-line no-control-regex -- the name may hold no control character.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** The parsed arguments of a run. */
export interface DemoOtaArguments {
  /** The owner's e-mail address as typed (trimmed); compared ignoring letter case. */
  readonly email: string;
  /** One of VELEXIS_OWN_TENANT_KEYS. */
  readonly key: string;
  readonly name: string;
  readonly countryCode: string;
  readonly defaultCurrency: string;
  readonly timeZone: string;
  /** Who ran the command, for the audit rows. */
  readonly operator: string;
}

/** The flags of the command and the field each one sets. */
const FLAGS = {
  "--name": "name",
  "--key": "key",
  "--country": "countryCode",
  "--currency": "defaultCurrency",
  "--time-zone": "timeZone",
  "--operator": "operator",
} as const;

type Flag = keyof typeof FLAGS;
type FlagField = (typeof FLAGS)[Flag];

function isFlag(arg: string): arg is Flag {
  return Object.hasOwn(FLAGS, arg);
}

/** The problem of a flag's value, or `undefined` when it is fine (never quoting the value). */
function valueProblem(field: FlagField, value: string): string | undefined {
  switch (field) {
    case "name":
      return value.length < 1 || value.length > NAME_MAX_LENGTH || CONTROL_CHARACTER.test(value)
        ? `--name needs 1 to ${NAME_MAX_LENGTH} characters on one line`
        : undefined;
    case "key":
      return isVelexisOwnTenantKey(value)
        ? undefined
        : `--key takes only Velexis's own key (${VELEXIS_OWN_TENANT_KEYS.join(", ")}); create any other OTA in the portal`;
    case "countryCode":
      return COUNTRY_CODE.test(value) ? undefined : "--country needs an ISO 3166-1 alpha-2 code in capitals";
    case "defaultCurrency":
      return CURRENCY_CODE.test(value) ? undefined : "--currency needs an ISO 4217 code in capitals";
    case "timeZone":
      return TIME_ZONE.test(value) ? undefined : "--time-zone needs an IANA time zone name";
    case "operator":
      return OPERATOR_NAME.test(value)
        ? undefined
        : "--operator needs one name: a letter or digit, then letters, digits, spaces and ._@+- (at most 64)";
  }
}

/**
 * `<email>` and the flags of DEMO_OTA_ARGUMENTS, each `--flag <value>`, in any order, or the problem as one line
 * (never quoting an argument). `operator` gives the operator when `--operator` is absent.
 */
export function parseDemoOtaArguments(
  args: readonly string[],
  operator: () => string = defaultOperator,
): DemoOtaArguments | { readonly problem: string } {
  let email: string | undefined;
  const values: Partial<Record<FlagField, string>> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (isFlag(arg)) {
      const field = FLAGS[arg];
      const raw = args[index + 1];
      if (values[field] !== undefined) {
        return { problem: `${arg} is given twice` };
      }
      if (raw === undefined || raw.startsWith("--")) {
        return { problem: `${arg} needs a value` };
      }
      const value = raw.trim();
      const problem = valueProblem(field, value);
      if (problem !== undefined) {
        return { problem };
      }
      values[field] = value;
      index += 1;
    } else if (email === undefined && !arg.startsWith("-")) {
      email = arg.trim();
    } else {
      return {
        problem:
          "unexpected argument: give one e-mail address and the flags of the usage line, each with its value",
      };
    }
  }
  if (email === undefined || !EMAIL_ADDRESS.test(email)) {
    return { problem: "give the owner's e-mail address (one address, as the person signed up with it)" };
  }
  const { countryCode, defaultCurrency, timeZone } = values;
  if (countryCode === undefined || defaultCurrency === undefined || timeZone === undefined) {
    return { problem: "--country, --currency and --time-zone are required" };
  }
  return {
    email,
    key: values.key ?? DEFAULT_DEMO_OTA_KEY,
    name: values.name ?? DEFAULT_DEMO_OTA_NAME,
    countryCode,
    defaultCurrency,
    timeZone,
    operator: values.operator ?? operator(),
  };
}

/** The actor label of the command's audit rows. */
export function demoOtaActorLabel(operator: string): string {
  return `cli ${DEMO_OTA_COMMAND} by ${operator}`;
}

/** What the audit rows' details add: the command and its operator. */
export function demoOtaAuditDetails(operator: string): AuditDetails {
  return { command: DEMO_OTA_COMMAND, operator };
}

/** The OTA the command made or found. */
export interface DemoOta {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: string;
}

/** What the checks before any write found (steps 2 and 3 of the file header). */
export type DemoOtaCheck =
  | { readonly result: "create"; readonly accountId: string }
  | { readonly result: "exists"; readonly accountId: string; readonly ota: DemoOta }
  | { readonly result: "not_found" | "not_verified" | "not_active" | "mfa_not_enabled" }
  | { readonly result: "other_owner" | "wrong_status"; readonly ota: DemoOta };

/** What createTenant came to (step 4). */
export type DemoOtaCreation =
  | {
      readonly result: "created";
      readonly ota: DemoOta;
      readonly job: { readonly id: string; readonly status: string };
    }
  | { readonly result: "not_verified" | "key_unavailable" }
  | { readonly result: "invalid_reference"; readonly flags: readonly string[] }
  | { readonly result: "tenant_limit"; readonly limit: number | null };

/** What the manual edit came to (step 5). */
export type DemoOtaActivation =
  | { readonly result: "activated" | "already_active"; readonly subscriptionId: string }
  | {
      readonly result: "unexpected";
      readonly subscription: {
        readonly id: string;
        readonly provider: string;
        readonly status: string;
      } | null;
    }
  | { readonly result: "failed"; readonly subscriptionId: string; readonly code: string };

/** What a report says: lines for stdout and stderr, and the exit code. */
export interface DemoOtaReport {
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly code: number;
}

/** The flag of each field error of createTenant's `400 VALIDATION_FAILED`. */
const FLAG_OF_FIELD: Readonly<Record<string, string>> = Object.freeze({
  "/countryCode": "--country",
  "/defaultCurrency": "--currency",
  "/timeZone": "--time-zone",
  "/name": "--name",
});

/** The work of the command, in its application context (see the file header). */
@Injectable()
export class DemoOtaService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly lifecycle: LifecycleService,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly manualEdits: SubscriptionsService,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** Steps 2 and 3: the owner, then an OTA that has the key already. Reads only. */
  async check({ email, key }: Pick<DemoOtaArguments, "email" | "key">): Promise<DemoOtaCheck> {
    const identity = await this.accounts.findByEmail(this.db, email);
    const account =
      identity === undefined ? undefined : await this.accounts.findMfaAccount(this.db, identity.id);
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
    const ota = await this.db
      .selectFrom("platform.tenants")
      .select(["id", "key", "name", "status"])
      .where("key", "=", key)
      .executeTakeFirst();
    if (ota === undefined) {
      return { result: "create", accountId: account.id };
    }
    const owner = await this.db
      .selectFrom("platform.tenant_memberships")
      .select("id")
      .where("tenant_id", "=", ota.id)
      .where("account_id", "=", account.id)
      .where("role", "=", "owner")
      .where("status", "=", "active")
      .executeTakeFirst();
    if (owner === undefined) {
      return { result: "other_owner", ota };
    }
    if (!DEMO_OTA_ACCEPTED_STATUSES.includes(ota.status)) {
      return { result: "wrong_status", ota };
    }
    return { result: "exists", accountId: account.id, ota };
  }

  /** Step 4: createTenant with the option of Velexis's own OTAs; its refusals as outcomes. */
  async create(args: DemoOtaArguments, accountId: string): Promise<DemoOtaCreation> {
    const own: VelexisOwnTenant = {
      actorLabel: demoOtaActorLabel(args.operator),
      details: demoOtaAuditDetails(args.operator),
    };
    try {
      const created = await this.lifecycle.createTenant(
        accountId,
        {
          key: args.key,
          name: args.name,
          countryCode: args.countryCode,
          defaultCurrency: args.defaultCurrency,
          timeZone: args.timeZone,
        },
        // Stripe's idempotency key of a Checkout (M5) is built from it; an OTA of Velexis's own has no Checkout.
        DEMO_OTA_COMMAND,
        own,
      );
      const { tenant, provisioningJob } = created;
      return {
        result: "created",
        ota: { id: tenant.id, key: tenant.key, name: tenant.name, status: tenant.status },
        job: { id: provisioningJob.id, status: provisioningJob.status },
      };
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }
      switch (error.code) {
        case "EMAIL_NOT_VERIFIED":
          return { result: "not_verified" };
        case "TENANT_KEY_UNAVAILABLE":
          return { result: "key_unavailable" };
        case "VALIDATION_FAILED":
          return {
            result: "invalid_reference",
            flags: (error.fieldErrors ?? []).map((field) => FLAG_OF_FIELD[field.path] ?? field.path),
          };
        case "UNPROCESSABLE": {
          const limit: unknown = (error.details as { limit?: unknown } | undefined)?.limit;
          return { result: "tenant_limit", limit: typeof limit === "number" ? limit : null };
        }
        default:
          throw error;
      }
    }
  }

  /** Step 5: the OTA's manual subscription set `active` through the admin's manual edit, unless it is already. */
  async activate(tenantId: string, operator: string): Promise<DemoOtaActivation> {
    const shown = await this.subscriptions.findShownForTenant(tenantId);
    if (shown === undefined) {
      return { result: "unexpected", subscription: null };
    }
    const subscription = { id: shown.id, provider: shown.billing_provider, status: shown.status };
    if (shown.billing_provider !== "manual") {
      return { result: "unexpected", subscription };
    }
    if (shown.status === "active") {
      return { result: "already_active", subscriptionId: shown.id };
    }
    if (!OPEN_TRIAL_STATUSES.has(shown.status)) {
      return { result: "unexpected", subscription };
    }
    const row = await this.subscriptions.findAdmin(shown.id);
    if (row === undefined) {
      return { result: "unexpected", subscription: null };
    }
    try {
      await this.manualEdits.updateManual(
        { system: { label: demoOtaActorLabel(operator), details: demoOtaAuditDetails(operator) } },
        row.id,
        row.version,
        { status: "active", reason: DEMO_OTA_SUBSCRIPTION_REASON },
      );
    } catch (error) {
      if (error instanceof AppError) {
        return { result: "failed", subscriptionId: row.id, code: error.code };
      }
      throw error;
    }
    return { result: "activated", subscriptionId: row.id };
  }
}

/** The application context of the command (see the file header). */
@Module({})
export class DemoOtaCliModule {
  static forRoot(config: PlatformBackendConfig, logger: Logger): DynamicModule {
    return {
      module: DemoOtaCliModule,
      imports: [
        configModule(config),
        LoggerModule.forRoot({ pinoHttp: { logger } }),
        CommonModule.forCli(),
        AuditModule,
        NotificationsModule,
        // The `ota-tenant-ops` queue the dispatcher adds the `provision` job to.
        QueuesModule,
      ],
      providers: [
        FeatureSwitches,
        // createTenant (LifecycleService) and what it writes through.
        AccountsRepository,
        TenantsRepository,
        MembershipsRepository,
        SubscriptionsRepository,
        PlansRepository,
        BillingCustomersRepository,
        DomainsRepository,
        ProvisioningJobsRepository,
        ProvisioningDispatcher,
        stripeClientProvider,
        StripeBillingGateway,
        CheckoutService,
        LifecycleService,
        // The manual edit (SubscriptionsService), with the resync's update path it is built with, as AdminModule
        // provides it; the command never resyncs.
        SupplierConnectionsRepository,
        PaymentConnectionsRepository,
        SuspensionService,
        PriceToPlan,
        BillingStatusRules,
        SubscriptionSyncLock,
        SubscriptionChangedHandler,
        SubscriptionsService,
        DemoOtaService,
      ],
    };
  }
}

/** The CLI's log level: `info` lines would only repeat what the command prints, so `info` becomes `warn`. */
function cliLogLevel(level: PlatformBackendConfig["LOG_LEVEL"]): PlatformBackendConfig["LOG_LEVEL"] {
  return level === "info" ? "warn" : level;
}

/** The usage error: the problem, never the argument (it may be a secret typed in the wrong place). */
function usageError(context: CliContext, problem: string): number {
  context.stderr.write(`${DEMO_OTA_COMMAND}: ${problem}; nothing was created.\n${DEMO_OTA_USAGE}\n`);
  return EXIT_USAGE;
}

/** A refusal of the checks (steps 2 and 3). */
export type DemoOtaCheckRefusal = Exclude<DemoOtaCheck, { readonly result: "create" | "exists" }>;

/** True when the checks refused the run. */
export function isCheckRefusal(check: DemoOtaCheck): check is DemoOtaCheckRefusal {
  return check.result !== "create" && check.result !== "exists";
}

/** A createTenant that wrote nothing (step 4). */
export type DemoOtaCreationRefusal = Exclude<DemoOtaCreation, { readonly result: "created" }>;

/** The report of a refusal of the checks (steps 2 and 3): exit 1, nothing written. */
export function checkReport(
  check: DemoOtaCheckRefusal,
  args: Pick<DemoOtaArguments, "email">,
): DemoOtaReport {
  const who = args.email;
  const refused = (line: string): DemoOtaReport => ({ out: [], err: [line], code: EXIT_FAILED });
  switch (check.result) {
    case "not_found":
      return refused(`No account has the e-mail address ${who}; nothing was created.`);
    case "not_verified":
      return refused(
        `The account ${who} has not verified its e-mail address; nothing was created. The person verifies it from ` +
          "the sign-up e-mail first.",
      );
    case "not_active":
      return refused(`The account ${who} is not active; nothing was created.`);
    case "mfa_not_enabled":
      return refused(
        `The account ${who} has no MFA; nothing was created. The person turns MFA on in the portal first ` +
          `(Account, Security), then run ${DEMO_OTA_COMMAND} again.`,
      );
    case "other_owner":
      return refused(
        `The OTA ${check.ota.key} (${check.ota.id}) exists and ${who} is not its owner; nothing changed.`,
      );
    case "wrong_status":
      return refused(
        `The OTA ${check.ota.key} (${check.ota.id}) is ${check.ota.status}, not active or provisioning; nothing ` +
          "changed. A failed setup is retried by its owner on the portal's setup page; look at the OTA in the " +
          "platform admin.",
      );
  }
}

/** The report of a createTenant that wrote nothing (step 4): exit 1. */
export function creationReport(creation: DemoOtaCreationRefusal): DemoOtaReport {
  const refused = (line: string): DemoOtaReport => ({ out: [], err: [line], code: EXIT_FAILED });
  switch (creation.result) {
    case "not_verified":
      return refused("The owner's account is no longer active and verified; nothing was created.");
    case "key_unavailable":
      return refused(
        `The key was taken while the command ran; nothing was created. Run ${DEMO_OTA_COMMAND} again: it reports ` +
          "the OTA that has it.",
      );
    case "invalid_reference":
      return refused(
        `The reference data holds no such value for ${creation.flags.join(", ")}; nothing was created.`,
      );
    case "tenant_limit":
      return refused(
        `The owner owns ${creation.limit === null ? "the most" : `${creation.limit}`} OTAs already ` +
          "(MAX_TENANTS_PER_ACCOUNT); nothing was created.",
      );
  }
}

/** The line about the OTA: created now, or found. */
export function otaLine(
  ota: DemoOta,
  args: Pick<DemoOtaArguments, "email">,
  job?: { readonly id: string; readonly status: string },
): string {
  const what = `The OTA ${ota.key} "${ota.name}" (${ota.id}) of ${args.email}`;
  return job === undefined
    ? `${what} exists already (${ota.status}); it was not created again.`
    : `${what} was created: ${ota.status}, storefront environment test, plan early_access; its setup job ` +
        `${job.id} is ${job.status}. Audit rows tenant.created and tenant.reserved_key_used were written.`;
}

/** The report of step 5 and the exit code of the run. */
export function activationReport(activation: DemoOtaActivation, ota: DemoOta): DemoOtaReport {
  switch (activation.result) {
    case "activated":
      return {
        out: [
          `Its manual subscription ${activation.subscriptionId} is now active ("${DEMO_OTA_SUBSCRIPTION_REASON}"; ` +
            "audit row subscription.manually_updated): billing never e-mails or suspends it.",
          `Next: the owner signs in to the portal and opens /otas/${ota.id}/setup within 24 hours of the setup to ` +
            "reveal the initial test keys once.",
        ],
        err: [],
        code: EXIT_OK,
      };
    case "already_active":
      return {
        out: [`Its manual subscription ${activation.subscriptionId} is active already; nothing changed.`],
        err: [],
        code: EXIT_OK,
      };
    case "unexpected": {
      const what =
        activation.subscription === null
          ? "has no subscription"
          : `has the ${activation.subscription.provider} subscription ${activation.subscription.id} in ` +
            `${activation.subscription.status}`;
      return {
        out: [],
        err: [
          `The OTA ${ota.key} (${ota.id}) ${what}, not a manual one this command sets active; nothing changed. ` +
            "Look at it in the platform admin (Subscriptions).",
        ],
        code: EXIT_FAILED,
      };
    }
    case "failed":
      return {
        out: [],
        err: [
          `The manual subscription ${activation.subscriptionId} could not be set active (${activation.code}); the ` +
            `OTA stays as it is. Run ${DEMO_OTA_COMMAND} again to complete it.`,
        ],
        code: EXIT_FAILED,
      };
  }
}

/** Writes a report's lines and answers its exit code. */
function emit(context: CliContext, report: DemoOtaReport): number {
  if (report.out.length > 0) {
    context.stdout.write(`${report.out.join("\n")}\n`);
  }
  if (report.err.length > 0) {
    context.stderr.write(`${report.err.join("\n")}\n`);
  }
  return report.code;
}

/** `tenants:create-demo <email> --country … --currency … --time-zone … [flags]` (see the file header). */
export async function runCreateDemoOta(args: readonly string[], context: CliContext): Promise<number> {
  const parsed = parseDemoOtaArguments(args);
  if ("problem" in parsed) {
    return usageError(context, parsed.problem);
  }
  let config: PlatformBackendConfig;
  try {
    config = loadConfig(context.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // A ConfigError names each variable and the reason, never a value.
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
  const app = await NestFactory.createApplicationContext(DemoOtaCliModule.forRoot(config, logger), {
    // Nest's own start-up lines are noise here; errors while the context is built reach the caller.
    logger: false,
    abortOnError: false,
  });
  try {
    const service = app.get(DemoOtaService);
    const check = await service.check(parsed);
    if (isCheckRefusal(check)) {
      return emit(context, checkReport(check, parsed));
    }
    let ota: DemoOta;
    if (check.result === "exists") {
      ota = check.ota;
      context.stdout.write(`${otaLine(ota, parsed)}\n`);
    } else {
      const creation = await service.create(parsed, check.accountId);
      if (creation.result !== "created") {
        return emit(context, creationReport(creation));
      }
      ota = creation.ota;
      // Written before step 5, so the operator knows the OTA exists whatever step 5 comes to.
      context.stdout.write(`${otaLine(ota, parsed, creation.job)}\n`);
    }
    return emit(context, activationReport(await service.activate(ota.id, parsed.operator), ota));
  } finally {
    await app.close();
  }
}
