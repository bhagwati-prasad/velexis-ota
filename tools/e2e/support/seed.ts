// Test data that journeys cannot create through the UI or the public API (PADR-0017 item 5; PFE-014).
//
// Arrange data through the platform API where an operation exists (support/fixtures.ts does that for accounts and
// sessions). This file is for the rest, against the stack's own database (`velexis_e2e_<runId>`, support/stack.ts):
//   - `runPlatformCli` runs `platform/backend/dist/cli.js` with the stack's environment: `admin:grant <email>`
//     (PBE-028) makes an account a platform admin, which no screen can do;
//   - `withDatabase(role, fn)` hands a connected `pg` client to `fn`, as one of the roles of @velexis/testing
//     (`platform`, `ota`, `migrator`, `provisioner`), for rows that only Stripe or an operator would create (a draft
//     settlement, a payout account under review). Platform rows are written as `platform`, the API's own role.
//     Tenant schemas belong to the OTA plan's helpers: through `tenantTx` of @velexis/db, never with
//     schema-qualified SQL (ADR-0004);
//   - builders (`defineBuilder` of @velexis/testing) give each journey unique, valid input.
//
// The platform admin's M5 journeys (PAD-015, the end of this file) add:
//
//   await moveOtaToNewPlan(callPlatformApi, { admin, owner, tenantId, plan, reason });  // admin API: a plan of its own
//   const hold = await holdVelexisLivePool();          // the live pool to this journey alone, until hold.release()
//   await restoreVelexisLivePool({ … });               // the live pool as the journey found it
//   await insertDraftSettlement({ … });                // a draft statement with its lines, as the monthly run leaves it
//   await applyOwnLiveCredentials({ tenantId, … });    // the own-credentials apply: the Velexis live office releasing
//   await ageAdminMfa(admin.email);                    // the admin's last TOTP code 20 minutes old
//
// The arrangements that specs once wrote to the stack's database themselves are helpers here too (FIX-W45-PLATFORM,
// lead decision (9d) of 2026-11-06, PADR-0017 item 5), so no spec writes a platform row with a database client of its
// own any more (a spec may still read stored state to assert it; an OTA's own schema stays with support/ota.ts's
// `tenantTx` helpers, as above):
//
//   await insertQueuedProvisioningJob({ … });          // a job back in the queue after a lost attempt (admin-step-up)
//   await setTenantLive(tenantId);                     // an OTA live before any go-live (ota-admin/roles, live-environment)
//   await setTenantBillingNotice(tenantId, "past_due"); // an OTA's billing notice (ota-admin/live-environment)
//
// All three write as the platform API's own role (`platform`, velexis_platform_app), like every other helper of this
// file: the two OTA rows moved from velexis_migrator to it on 2026-11-06 (FIX-W46-PLATFORM, lead decision (11a)); the
// role's DML grants on the `platform` schema (deploy/postgres/schemas.sql) cover `platform.tenants`. The caller
// publishes the platform's `tenant` invalidation (support/ota.ts `publishTenantInvalidation`), which this file cannot
// import.
//
// `moveOtaToNewPlan` goes through the platform admin API (an operation exists), with the `callPlatformApi` the journey
// hands in: support/fixtures.ts imports this file, so this file never imports it (nor support/ota.ts or
// support/tenants.ts, which import it too) at run time, only their types.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { components } from "@velexis/api-types/platform";
import type { EncryptedValue } from "@velexis/crypto";
import { defineBuilder, type TestRole } from "@velexis/testing";
import pg from "pg";
import type { ApiCall } from "./fixtures";
import { uniqueEmail } from "./mailpit";
import {
  AMADEUS_STUB_URL,
  childEnv,
  REPO_ROOT,
  runningStackContext,
  serviceEnv,
  stackDatabaseUrl,
  type StackContext,
} from "./stack";
import type { SignedInOwner } from "./tenants";

const run = promisify(execFile);

let context: StackContext | undefined;

/** The stack of this run (the global setup passes its database name to the workers). */
export function stack(): StackContext {
  context ??= runningStackContext();
  return context;
}

/** The name of the stack's database. */
export function stackDatabaseName(): string {
  return stack().databaseName;
}

/**
 * Runs `fn` with a client connected to the stack's database as `role`, and closes the client afterwards. The DSN
 * carries a development password: it is never logged.
 */
export async function withDatabase<T>(role: TestRole, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: stackDatabaseUrl(stack(), role),
    application_name: "velexis-e2e-seed",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The output of a platform CLI command. */
export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `node platform/backend/dist/cli.js <args>` with the environment of the stack's platform API, and resolves to
 * its output. Rejects with the exit code and stderr when the command fails.
 */
export async function runPlatformCli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [join(REPO_ROOT, "platform/backend/dist/cli.js"), ...args],
      {
        cwd: join(REPO_ROOT, "platform/backend"),
        env: childEnv(serviceEnv("platform-cli", stack())),
        timeout: 60_000,
      },
    );
    return { stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown };
    throw new Error(
      `platform CLI \`${args[0] ?? ""}\` failed (exit code ${String(failure.code)}): ${String(failure.stderr ?? "")}`,
    );
  }
}

/** Makes the verified account with MFA of `email` a platform admin: `admin:grant` of the platform CLI (PBE-028). */
export async function grantPlatformAdmin(email: string): Promise<void> {
  await runPlatformCli(["admin:grant", email]);
}

/** What a person types to sign up: unique for every build. */
export interface AccountInput {
  /** `<label>+<uuid>@example.com`, its own Mailpit inbox. */
  readonly email: string;
  /**
   * 25 characters, random, so never on a breached-password list, with a letter and a digit (`newPassword`): it meets
   * the privileged rule of platform admins and the owners and admins of OTAs too (ADR-0008, revision of 2026-11-10).
   */
  readonly password: string;
  readonly fullName: string;
}

/**
 * A random password both of the platform's rules accept: `E2e-` (a letter and a digit, as the privileged rule of
 * platform admins and the owners and admins of OTAs asks), 20 characters of letters, digits, `-` and `_`, and `!`.
 */
export function newPassword(): string {
  return `E2e-${randomBytes(15).toString("base64url")}!`;
}

/** Sign-up input with a unique e-mail address and a random password: `buildAccount({ fullName: "Owner" })`. */
export const buildAccount = defineBuilder<AccountInput>((n) => ({
  email: uniqueEmail("account"),
  password: newPassword(),
  fullName: `E2E Person ${n}`,
}));

// ---- The platform admin's M5 journeys (PAD-015) ----------------------------------------------------------------------

type Schemas = components["schemas"];

/**
 * How this file calls the platform API: `callPlatformApi` of support/fixtures.ts, which the journey hands in
 * (fixtures.ts imports this file, so this file only imports its types).
 */
export type PlatformApiCaller = <T>(call: ApiCall) => Promise<T>;

/** A platform admin's API session: the admin's end-user IP and the access token of an `adminVerifyMfa` sign-in. */
export interface AdminApiSession {
  readonly endUserIp: string;
  readonly accessToken: string;
}

/** What `moveOtaToNewPlan` needs. */
export interface PlanMoveInput {
  readonly admin: AdminApiSession;
  /** The OTA's owner (`getSubscription` is the owner's read of the OTA's subscription). */
  readonly owner: SignedInOwner;
  readonly tenantId: string;
  /** The plan to create (not public): the journey's own code, with the limits the journey needs. */
  readonly plan: Schemas["CreatePlanRequest"];
  /** The reason of `adminUpdateManualSubscription` (5 to 500 characters), stored in the audit log. */
  readonly reason: string;
}

/**
 * Gives the OTA `tenantId` the new plan `input.plan` as its current plan, through the platform admin API as Velexis
 * staff do for a pilot (PADR-0017 item 5; the way portal-domains.e2e.ts arranges its plan): no public plan has custom
 * domains or live mode, and an owner's plan change runs through Stripe Billing, which is off in the stack.
 * `adminCreatePlan` creates the plan; the owner's `getSubscription` and the admin's `adminGetSubscription` read the
 * OTA's manual trial and its version; `adminUpdateManualSubscription` moves the trial to the plan (`If-Match`, the
 * reason), which sets the OTA's plan and publishes the platform's `tenant` invalidation. Resolves to the subscription
 * the admin operation answered.
 */
export async function moveOtaToNewPlan(
  call: PlatformApiCaller,
  input: PlanMoveInput,
): Promise<Schemas["AdminSubscription"]> {
  const asAdmin = { endUserIp: input.admin.endUserIp, accessToken: input.admin.accessToken } as const;
  await call<Schemas["AdminPlan"]>({
    operation: "adminCreatePlan",
    method: "POST",
    path: "/v1/admin/plans",
    ...asAdmin,
    body: input.plan,
  });
  const current = await call<Schemas["Subscription"]>({
    operation: "getSubscription",
    method: "GET",
    path: `/v1/tenants/${encodeURIComponent(input.tenantId)}/subscription`,
    endUserIp: input.owner.account.endUserIp,
    accessToken: input.owner.accessToken,
  });
  const { subscription } = await call<Schemas["AdminSubscriptionDetail"]>({
    operation: "adminGetSubscription",
    method: "GET",
    path: `/v1/admin/subscriptions/${encodeURIComponent(current.id)}`,
    ...asAdmin,
  });
  const change: Schemas["UpdateManualSubscriptionRequest"] = {
    planCode: input.plan.code,
    reason: input.reason,
  };
  return await call<Schemas["AdminSubscription"]>({
    operation: "adminUpdateManualSubscription",
    method: "PATCH",
    path: `/v1/admin/subscriptions/${encodeURIComponent(subscription.id)}`,
    ...asAdmin,
    headers: { "If-Match": `"${String(subscription.version)}"` },
    body: change,
  });
}

/**
 * The name of the PostgreSQL advisory lock of the Velexis live pool (the stack's database, `hashtextextended`), which
 * admin-amadeus-pool.e2e.ts (PAD-010) and admin-live-office.e2e.ts (PAD-015) each hold for their whole run.
 */
export const VELEXIS_LIVE_POOL_LOCK = "velexis-e2e:velexis-live-pool";

/**
 * How long a journey waits for the Velexis live pool by default: as long as the other journey that holds it runs at
 * most (its one-time arrangement and its steps, each step at most Playwright's 30 seconds).
 */
export const LIVE_POOL_WAIT_MS = 300_000;

/** How often `holdVelexisLivePool` asks for the lock again. */
const LIVE_POOL_POLL_MS = 500;

/** The Velexis live pool held by this journey, until `release()` (also called by the end of the worker process). */
export interface LivePoolHold {
  release(): Promise<void>;
}

/**
 * Holds the Velexis live pool for this journey alone: a session-level advisory lock (VELEXIS_LIVE_POOL_LOCK) on a
 * connection of its own to the stack's database, asked for again every half second (`pg_try_advisory_lock`) until it
 * is free, at most `timeoutMs`. There is one Velexis Amadeus account per environment, and two journeys need the live
 * one: admin-amadeus-pool.e2e.ts (PAD-010) creates it in the browser and counts its offices exactly, and
 * admin-live-office.e2e.ts (PAD-015) assigns and releases a live office of it and leaves the pool as it found it
 * (`restoreVelexisLivePool`). Holding the pool, neither ever sees the other's offices in between, whatever order the
 * workers run them in. The lock goes when the hold is released or its connection closes (a worker that dies).
 */
export async function holdVelexisLivePool(timeoutMs: number = LIVE_POOL_WAIT_MS): Promise<LivePoolHold> {
  const client = new pg.Client({
    connectionString: stackDatabaseUrl(stack(), "platform"),
    application_name: "velexis-e2e-live-pool",
  });
  await client.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await client.query<{ held: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held",
        [VELEXIS_LIVE_POOL_LOCK],
      );
      if (rows[0]?.held === true) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `the Velexis live pool is still held by another journey after ${String(timeoutMs / 1000)} s ` +
            "(admin-amadeus-pool.e2e.ts or admin-live-office.e2e.ts)",
        );
      }
      await delay(LIVE_POOL_POLL_MS);
    }
  } catch (error) {
    await client.end();
    throw error;
  }
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [VELEXIS_LIVE_POOL_LOCK]);
      } finally {
        await client.end();
      }
    },
  };
}

/** What a journey added to the Velexis live pool, which `restoreVelexisLivePool` takes away again. */
export interface LivePoolArrangement {
  /** The Velexis live account (`ama_…`) the journey used. */
  readonly accountId: string;
  /** The journey created that account itself (no other journey had made one when it took the pool). */
  readonly createdAccount: boolean;
  /** The pool entries (`amo_…`) the journey added to it. */
  readonly officeRowIds: readonly string[];
  /** The journey's OTA. */
  readonly tenantId: string;
}

/**
 * Leaves the Velexis live pool as the journey found it, as the platform API's own role in one transaction: the pool
 * entries the journey added are deleted (released ones are `available` again), and an account the journey created
 * goes too, after the journey's OTA's live connection on it, if the journey stopped before the OTA's own credentials
 * replaced it. So admin-amadeus-pool.e2e.ts (PAD-010), when it holds the pool afterwards, finds no live account and an
 * empty pool, as in a run without this journey, and counts its offices exactly. No API removes an account or an
 * office (the admin retires an office, which keeps it in the pool's counts): these rows are the journey's own.
 * Resolves to the number of rows deleted. The caller publishes the `amadeus_account` and `connection` invalidations.
 */
export async function restoreVelexisLivePool(arrangement: LivePoolArrangement): Promise<number> {
  return await withDatabase("platform", async (client) => {
    await client.query("BEGIN");
    try {
      let deleted = 0;
      if (arrangement.createdAccount) {
        const connections = await client.query(
          `DELETE FROM platform.supplier_connections
            WHERE tenant_id = $1 AND provider = 'amadeus' AND environment = 'live' AND amadeus_account_id = $2`,
          [arrangement.tenantId, arrangement.accountId],
        );
        deleted += connections.rowCount ?? 0;
      }
      const offices = await client.query(
        "DELETE FROM platform.amadeus_offices WHERE amadeus_account_id = $1 AND id = ANY($2::text[])",
        [arrangement.accountId, [...arrangement.officeRowIds]],
      );
      deleted += offices.rowCount ?? 0;
      if (arrangement.createdAccount) {
        const accounts = await client.query(
          "DELETE FROM platform.amadeus_accounts WHERE id = $1 AND environment = 'live'",
          [arrangement.accountId],
        );
        deleted += accounts.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return deleted;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/** A line of a draft statement as the monthly run writes it from one Stripe balance transaction (PBE-059). */
export interface DraftSettlementLine {
  /** `sln_…`. */
  readonly id: string;
  readonly lineType: "charge" | "refund";
  /** Signed, in the statement's currency, as a decimal string (`"250.00"`, `"-40.00"`). */
  readonly amount: string;
  readonly stripeFee: string;
  /** `txn_…`, unique over every statement. */
  readonly balanceTransactionId: string;
  readonly paymentIntentId: string;
  readonly description: string;
  readonly occurredAt: Date;
}

/** The totals of a statement, as `numeric(12,2)` decimal strings (settlement-formula.ts of the platform backend). */
export interface DraftSettlementTotals {
  readonly gross: string;
  readonly refunds: string;
  readonly disputes: string;
  readonly stripeFees: string;
  readonly velexisFees: string;
  readonly adjustments: string;
  readonly net: string;
}

/** What `insertDraftSettlement` writes. */
export interface DraftSettlementInput {
  /** `stl_` and a ULID, the `SettlementId` pattern of the platform document. */
  readonly id: string;
  readonly tenantId: string;
  readonly currency: string;
  /** The first instant of a calendar month (UTC) and of the next one. */
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly feeBps: number;
  /** The totals of `lines` by the platform's formula: the review recomputes them from the lines on an adjustment. */
  readonly totals: DraftSettlementTotals;
  readonly lines: readonly DraftSettlementLine[];
}

/**
 * Writes a draft statement with its lines as the monthly settlement run leaves one (PBE-059), as the platform API's
 * own role in one transaction: the run builds it from the Velexis Stripe account's balance transactions of the month,
 * which the stack cannot have (PADR-0017 item 5 names this very case). The environment is `test`, the one the stack's
 * run would use (`APP_ENV=test`), and `line_count` is the number of lines. The review (adjustment, approval, payment)
 * is the journey's, through the platform admin.
 */
export async function insertDraftSettlement(input: DraftSettlementInput): Promise<void> {
  await withDatabase("platform", async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO platform.settlements (id, tenant_id, environment, currency, period_start, period_end, status,
                                           gross_amount, refunds_amount, disputes_amount, stripe_fees_amount,
                                           velexis_fees_amount, adjustments_amount, net_amount, fee_bps, line_count)
         VALUES ($1, $2, 'test', $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          input.id,
          input.tenantId,
          input.currency,
          input.periodStart,
          input.periodEnd,
          input.totals.gross,
          input.totals.refunds,
          input.totals.disputes,
          input.totals.stripeFees,
          input.totals.velexisFees,
          input.totals.adjustments,
          input.totals.net,
          input.feeBps,
          input.lines.length,
        ],
      );
      for (const line of input.lines) {
        await client.query(
          `INSERT INTO platform.settlement_lines (id, settlement_id, tenant_id, line_type, balance_transaction_id,
                                                  payment_intent_id, occurred_at, amount, stripe_fee, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            line.id,
            input.id,
            input.tenantId,
            line.lineType,
            line.balanceTransactionId,
            line.paymentIntentId,
            line.occurredAt,
            line.amount,
            line.stripeFee,
            line.description,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/** What `applyOwnLiveCredentials` needs. */
export interface OwnLiveCredentialsInput {
  readonly tenantId: string;
  /** The office of the OTA's own credentials: its only, default, queuing and owner office. */
  readonly officeId: string;
  /**
   * Seals a new client secret for the connection `connectionId` as the platform worker seals one it applies (the
   * journey hands in support/ota.ts's `sealedClientSecret` with the stack's KEK).
   */
  readonly seal: (connectionId: string) => Promise<EncryptedValue>;
}

/** What the own-credentials apply changed. */
export interface OwnLiveCredentialsApplied {
  readonly connectionId: string;
  /** The Velexis live account the connection used before. */
  readonly accountId: string;
  /** The Velexis offices (`amo_…`) now `releasing`. */
  readonly releasingOfficeRowIds: readonly string[];
}

/**
 * Applies verified own live Amadeus credentials to the OTA `tenantId` as the platform worker's `credentials.verify`
 * job does once Amadeus accepted them (PBE-053; flows/amadeus-connection.md §D item 3), as the platform API's own role
 * in one transaction: the OTA's active live `velexis` connection becomes `credential_source = 'tenant'` on the stack's
 * Amadeus stub (no Velexis account; a made-up client id and a random client secret sealed by `input.seal` under the
 * connection's associated data; `input.officeId` as its only, default, queuing and owner office; `active`, verified
 * now, the next version), and every Velexis office of that account assigned to the OTA becomes `releasing` with the
 * time of the request. Submitting own credentials needs FEATURE_OWN_AMADEUS, which the stack keeps off (its portal and
 * admin pages change what PAD-010's journey reads), so the apply is written here, as OFE-022's own live connection is.
 * The caller publishes the `connection` and `amadeus_account` invalidations, as the worker does after its commit.
 */
export async function applyOwnLiveCredentials(
  input: OwnLiveCredentialsInput,
): Promise<OwnLiveCredentialsApplied> {
  if (!/^[A-Z0-9]{9}$/.test(input.officeId)) {
    throw new TypeError(`not an Amadeus office id: ${input.officeId}`);
  }
  const connection = await withDatabase("platform", async (client) => {
    const { rows } = await client.query<{
      id: string;
      credential_source: string;
      amadeus_account_id: string | null;
      status: string;
      version: number;
    }>(
      `SELECT id, credential_source, amadeus_account_id, status, version
         FROM platform.supplier_connections
        WHERE tenant_id = $1 AND provider = 'amadeus' AND environment = 'live'`,
      [input.tenantId],
    );
    return rows[0];
  });
  if (
    connection === undefined ||
    connection.credential_source !== "velexis" ||
    connection.amadeus_account_id === null ||
    connection.status !== "active"
  ) {
    throw new Error(
      `the OTA ${input.tenantId} has no active live connection on the Velexis account to replace`,
    );
  }
  const accountId = connection.amadeus_account_id;
  const sealed = await input.seal(connection.id);
  return await withDatabase("platform", async (client) => {
    await client.query("BEGIN");
    try {
      const updated = await client.query(
        `UPDATE platform.supplier_connections
            SET credential_source = 'tenant', amadeus_account_id = NULL, base_url = $3, client_id = $4,
                client_secret_ciphertext = $5, encryption_key_id = $6, office_ids = ARRAY[$7::text],
                default_office_id = $7, queuing_office_id = $7, owner_office_id = $7, status = 'active',
                last_verified_at = now(), last_error = NULL, version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 AND credential_source = 'velexis'`,
        [
          connection.id,
          connection.version,
          AMADEUS_STUB_URL,
          `e2e-own-live-${randomBytes(6).toString("hex")}`,
          sealed.ciphertext,
          sealed.kekId,
          input.officeId,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error(
          `the live connection of the OTA ${input.tenantId} changed while its credentials were applied`,
        );
      }
      const releasing = await client.query<{ id: string }>(
        `UPDATE platform.amadeus_offices
            SET status = 'releasing', release_requested_at = now(), version = version + 1, updated_at = now()
          WHERE amadeus_account_id = $1 AND assigned_tenant_id = $2 AND status = 'assigned'
          RETURNING id`,
        [accountId, input.tenantId],
      );
      await client.query("COMMIT");
      return {
        connectionId: connection.id,
        accountId,
        releasingOfficeRowIds: releasing.rows.map((row) => row.id),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/** How far `ageAdminMfa` moves the last TOTP verification back by default: beyond the step-up's 15 minutes. */
export const AGED_MFA_MINUTES = 20;

/**
 * Moves the last TOTP verification of every open platform admin session of the account `email` `minutes` back
 * (`account_sessions.mfa_verified_at`, which each refresh copies into the access token's `mfa_at`), as the platform API's
 * own role: the session of an admin whose last code is older than the step-up's 15 minutes (PADR-0008), which no API
 * makes in less time. The next refresh (the admin's middleware refreshes as soon as the access cookie is gone) gives
 * an access token whose step-up operations answer `401 REAUTH_REQUIRED`, so the page asks for a code. Throws when the
 * account has no such session; resolves to the number of session rows changed.
 */
export async function ageAdminMfa(email: string, minutes: number = AGED_MFA_MINUTES): Promise<number> {
  const changed = await withDatabase("platform", async (client) => {
    const result = await client.query(
      `UPDATE platform.account_sessions s
          SET mfa_verified_at = s.mfa_verified_at - make_interval(mins => $2::int)
         FROM platform.accounts a
        WHERE a.id = s.account_id AND lower(a.email) = lower($1) AND s.audience = 'platform_admin'
          AND s.revoked_at IS NULL AND s.mfa_verified_at IS NOT NULL`,
      [email, minutes],
    );
    return result.rowCount ?? 0;
  });
  if (changed === 0) {
    throw new Error(`${email} has no open platform admin session with a TOTP verification`);
  }
  return changed;
}

// ---- Arrangements the specs wrote themselves (FIX-W45-PLATFORM, lead decision (9d) of 2026-11-06) -------------------

/** What `insertQueuedProvisioningJob` writes. */
export interface QueuedProvisioningJobInput {
  /** `job_` and a ULID, the `ProvisioningJobId` pattern of the platform document. */
  readonly id: string;
  readonly tenantId: string;
  readonly kind: Schemas["ProvisioningJobKind"];
  /** The attempt that was lost: the job's `attempt` (at least 1). */
  readonly attempt: number;
  /** The job's backoff: it is due again this many seconds after the database's now (at least 1). */
  readonly dueInSeconds: number;
  /** The error the failure handler recorded (a code and words, never a secret). */
  readonly error: string;
}

/**
 * Writes a provisioning job back in the queue after a lost attempt, as the platform's failure handler leaves one
 * (PBE-023: `queued` at step `dispatch`, the lost attempt counted with its `started_at`, due again after its backoff),
 * as the platform API's own role. No operation leaves a job queued for longer than the moment before its dispatch,
 * and the admin's "Cancel job" is offered on a queued job only (admin-step-up.e2e.ts, PAD-016); the worker's
 * dispatcher leaves the job alone until it is due.
 */
export async function insertQueuedProvisioningJob(input: QueuedProvisioningJobInput): Promise<void> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new TypeError(`not an attempt number: ${String(input.attempt)}`);
  }
  if (!Number.isSafeInteger(input.dueInSeconds) || input.dueInSeconds < 1) {
    throw new TypeError(`not a backoff in whole seconds: ${String(input.dueInSeconds)}`);
  }
  await withDatabase("platform", async (client) => {
    await client.query(
      `INSERT INTO platform.provisioning_jobs (id, tenant_id, kind, status, step, payload, attempt, scheduled_at,
                                               started_at, error)
       VALUES ($1, $2, $3, 'queued', 'dispatch', '{}'::jsonb, $4, now() + make_interval(secs => $5::int), now(), $6)`,
      [input.id, input.tenantId, input.kind, input.attempt, input.dueInSeconds, input.error],
    );
  });
}

/**
 * Runs `update`, an `UPDATE platform.tenants … WHERE id = $1 …` with `values` as `$2` on, as the platform API's own
 * role (see the header), and throws `failure` unless it changed exactly one row.
 */
async function updateTenant(
  tenantId: string,
  update: string,
  values: readonly unknown[],
  failure: string,
): Promise<void> {
  const changed = await withDatabase("platform", async (client) => {
    const { rowCount } = await client.query(update, [tenantId, ...values]);
    return rowCount ?? 0;
  });
  if (changed !== 1) {
    throw new Error(failure);
  }
}

/**
 * Makes the active test OTA `tenantId` live (`storefront_environment = live`, `live_enabled_at` now, the next version)
 * as the platform API's own role, for the OTA admin journeys that need a live OTA before the go-live they do not test
 * (roles.e2e.ts, live-environment.e2e.ts). Throws unless the OTA was active and in the test environment. The caller
 * publishes the platform's `tenant` invalidation, so the OTA API reads the row again at once instead of after its 60 s
 * cache.
 */
export async function setTenantLive(tenantId: string): Promise<void> {
  await updateTenant(
    tenantId,
    `UPDATE platform.tenants
        SET storefront_environment = 'live', live_enabled_at = now(), version = version + 1, updated_at = now()
      WHERE id = $1 AND status = 'active' AND storefront_environment = 'test'`,
    [],
    `the OTA ${tenantId} is not an active test OTA`,
  );
}

/**
 * Sets the billing notice of the active OTA `tenantId` (`past_due`, `trial_ending`, or `null` for none) as the
 * platform's billing sync does, with the next version, as the platform API's own role (live-environment.e2e.ts). Throws
 * unless the OTA was active. The caller publishes the platform's `tenant` invalidation.
 */
export async function setTenantBillingNotice(
  tenantId: string,
  notice: Schemas["BillingNotice"],
): Promise<void> {
  await updateTenant(
    tenantId,
    `UPDATE platform.tenants
        SET billing_notice = $2, version = version + 1, updated_at = now()
      WHERE id = $1 AND status = 'active'`,
    [notice],
    `the OTA ${tenantId} is not an active OTA`,
  );
}
