// The Velexis Amadeus accounts of the platform admin (platform/docs/api-inventory-admin.md §5, flows/amadeus-connection.md
// §A, ADR-0012, PADR-0012; scope PF-90): list, create, update (rename, rotate, disable) and verify again. Who may call
// them is AdminAuthGuard's (`platform_admin`); the step-up of `adminCreateAmadeusAccount` is RecentMfaGuard's
// (`x-mfa-step-up`). This service owns the transactions, their audit rows (`actor_type = 'platform_admin'`), the
// `amadeus_account` invalidations and the verification jobs after the commit.
//
// - One account per environment: a second one answers `409 CONFLICT` (`details.reason = environment_exists`).
// - The client secret is envelope-encrypted at once with the associated data
//   `platform.amadeus_accounts.client_secret_ciphertext:<id>` (ADR-0010) and never logged, audited, queued or answered.
// - `baseUrl` is an `https` host, or the loopback Amadeus stub outside production (`400 VALIDATION_FAILED`,
//   `/baseUrl`, `https`, when APP_ENV is `production`).
// - A new host, client id or secret needs a TOTP step-up within 15 minutes (`401 REAUTH_REQUIRED`, `403 MFA_REQUIRED`):
//   the job and the OTA backend send the stored secret to the host. It sets the account `pending_verification` and
//   runs the verification again. A new name or `status: disabled` needs none; disabling queues no verification, and
//   the job leaves a disabled account alone, so a job queued before the disable never undoes it.
//   `adminVerifyAmadeusAccount` makes a disabled account `active` again: it takes the account to `pending_verification`
//   first (audited, `amadeus_account` invalidation), then queues the job. `If-Match` carries the version (`412
//   PRECONDITION_FAILED`).
// - The job `amadeus_account.verify {amadeusAccountId}` goes to `platform-connections` after the commit. Redis down
//   there does not fail a create or an update (the account stays `pending_verification`, and the admin verifies it
//   again later, `amadeus_account.enqueue_failed`), but it fails `adminVerifyAmadeusAccount` with `503
//   SERVICE_UNAVAILABLE`, whose job is its whole effect; its audit row is written only once the job is queued (for a
//   disabled account, with the move to `pending_verification`, which a 503 leaves in place).
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccountAuthStates } from "../common/auth/admin-auth.guard";
import { assertRecentMfa } from "../common/auth/recent-mfa.guard";
import { Clock } from "../common/clock";
import { EnvelopeService } from "../common/crypto.provider";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { PLATFORM_QUEUE } from "../common/queues/queue-names";
import { afterCommit, InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import {
  AmadeusAccountsRepository,
  emptyOfficeCounts,
  type AmadeusAccountChanges,
  type AmadeusAccountRecord,
  type AmadeusOfficeCounts,
} from "./amadeus-accounts.repository";
import {
  AMADEUS_ACCOUNT_VERIFY_JOB,
  clientSecretPlace,
  type AmadeusAccountVerifyJobData,
} from "./verification.processor";

export type AdminAmadeusAccount = components["schemas"]["AdminAmadeusAccount"];
export type AdminAmadeusAccountList = components["schemas"]["AdminAmadeusAccountList"];
export type CreateAmadeusAccountRequest = components["schemas"]["CreateAmadeusAccountRequest"];
export type UpdateAmadeusAccountRequest = components["schemas"]["UpdateAmadeusAccountRequest"];

/** How long the enqueue of a verification job may take before it is given up. */
export const VERIFY_ENQUEUE_TIMEOUT_MS = 2000;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The API's account of a row: never the secret or its ciphertext (`clientId` is not a secret). */
export function toAdminAmadeusAccount(
  row: AmadeusAccountRecord,
  officeCounts: AmadeusOfficeCounts = emptyOfficeCounts(),
): AdminAmadeusAccount {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment as AdminAmadeusAccount["environment"],
    baseUrl: row.base_url,
    clientId: row.client_id,
    status: row.status as AdminAmadeusAccount["status"],
    lastVerifiedAt: iso(row.last_verified_at),
    lastError: row.last_error,
    officeCounts: { ...officeCounts },
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

/** The non-secret settings of an account, as audit rows hold them. */
function auditedSettings(row: Pick<AmadeusAccountRecord, "name" | "environment" | "base_url" | "client_id">) {
  return { name: row.name, environment: row.environment, baseUrl: row.base_url, clientId: row.client_id };
}

@Injectable()
export class AmadeusAccountsService {
  private readonly production: boolean;

  constructor(
    private readonly accounts: AmadeusAccountsRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly authStates: AccountAuthStates,
    private readonly envelope: EnvelopeService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectQueue(PLATFORM_QUEUE.connections) private readonly connections: Queue,
    @InjectPinoLogger(AmadeusAccountsService.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.production = config.get("APP_ENV", { infer: true }) === "production";
  }

  /** adminListAmadeusAccounts: every account, `test` before `live`, with the office counts of its pool. */
  async list(): Promise<AdminAmadeusAccountList> {
    const rows = await this.accounts.list();
    const counts = await this.accounts.officeCounts(rows.map((row) => row.id));
    return { data: rows.map((row) => toAdminAmadeusAccount(row, counts.get(row.id))) };
  }

  /**
   * adminCreateAmadeusAccount: the account of an environment, `pending_verification`, with its secret encrypted, an
   * `amadeus_account.created` audit row, and the verification job after the commit.
   */
  async create(
    claims: Pick<AccessTokenClaims, "sub">,
    request: CreateAmadeusAccountRequest,
  ): Promise<AdminAmadeusAccount> {
    this.assertBaseUrl(request.baseUrl);
    const now = this.clock.now();
    const id = this.ids.new("ama");
    const encrypted = await this.envelope.encrypt(request.clientSecret, clientSecretPlace(id));
    return runInTransaction(this.db, async (trx) => {
      const row = await this.accounts.insertIfNew(trx, {
        id,
        name: request.name,
        environment: request.environment,
        base_url: request.baseUrl,
        client_id: request.clientId,
        client_secret_ciphertext: Buffer.from(encrypted.ciphertext),
        encryption_key_id: encrypted.kekId,
        created_by_account_id: claims.sub,
        created_at: now,
        updated_at: now,
      });
      if (row === undefined) {
        throw new AppError("CONFLICT", { details: { reason: "environment_exists" } });
      }
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "amadeus_account.created",
        targetType: "amadeus_account",
        targetId: row.id,
        after: { ...auditedSettings(row), status: row.status },
      });
      this.verifyAfterCommit(trx, row.id);
      return toAdminAmadeusAccount(row);
    });
  }

  /**
   * adminUpdateAmadeusAccount: the fields of `request` that differ from the stored ones (a `clientSecret` always
   * counts), with `version + 1`, an `amadeus_account.updated` audit row (the changed fields, never the secret), an
   * `amadeus_account` invalidation and, for new credentials, the verification job after the commit. A request that
   * changes nothing writes nothing.
   */
  async update(
    claims: Pick<AccessTokenClaims, "sub" | "mfa_at">,
    accountId: string,
    version: number,
    request: UpdateAmadeusAccountRequest,
  ): Promise<AdminAmadeusAccount> {
    if (request.baseUrl !== undefined) {
      this.assertBaseUrl(request.baseUrl);
    }
    const now = this.clock.now();
    const mayNeedStepUp =
      request.baseUrl !== undefined || request.clientId !== undefined || request.clientSecret !== undefined;
    // Read before the transaction: AccountAuthStates reads on the pool, and a read there while the transaction holds
    // a connection could wait for one that the requests queued behind the row lock never give back.
    const caller = mayNeedStepUp ? await this.authStates.read(claims.sub) : undefined;
    const encrypted =
      request.clientSecret === undefined
        ? undefined
        : await this.envelope.encrypt(request.clientSecret, clientSecretPlace(accountId));

    return runInTransaction(this.db, async (trx) => {
      const current = await this.accounts.lock(trx, accountId);
      if (current === undefined) {
        throw new AppError("NOT_FOUND");
      }
      if (current.version !== version) {
        throw new AppError("PRECONDITION_FAILED");
      }
      const changes: { -readonly [K in keyof AmadeusAccountChanges]: AmadeusAccountChanges[K] } = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = <K extends "name" | "base_url" | "client_id">(
        column: K,
        field: string,
        value?: string,
      ) => {
        if (value !== undefined && value !== current[column]) {
          changes[column] = value;
          before[field] = current[column];
          after[field] = value;
        }
      };
      change("name", "name", request.name);
      change("base_url", "baseUrl", request.baseUrl);
      change("client_id", "clientId", request.clientId);
      if (encrypted !== undefined) {
        changes.client_secret_ciphertext = Buffer.from(encrypted.ciphertext);
        changes.encryption_key_id = encrypted.kekId;
      }
      const newCredentials =
        changes.base_url !== undefined || changes.client_id !== undefined || encrypted !== undefined;
      if (newCredentials) {
        if (caller === undefined) {
          throw new AppError("UNAUTHENTICATED");
        }
        assertRecentMfa(caller, claims, now);
      }
      // `status: disabled` wins over new credentials: the account stays disabled and no verification runs (a later
      // adminVerifyAmadeusAccount makes it active again).
      const status =
        request.status === "disabled" ? "disabled" : newCredentials ? "pending_verification" : undefined;
      if (status !== undefined && status !== current.status) {
        changes.status = status;
        before["status"] = current.status;
        after["status"] = status;
      }
      if (newCredentials) {
        changes.last_error = null;
      }
      if (Object.keys(changes).length === 0) {
        return this.withCounts(current, trx);
      }
      const row = await this.accounts.update(trx, accountId, changes, now);
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "amadeus_account.updated",
        targetType: "amadeus_account",
        targetId: accountId,
        before,
        after,
        // The names of the changed fields; `clientSecret` is named, never its value (and a key holding "secret"
        // would be redacted by the audit's redactor).
        details: {
          environment: row.environment,
          changed: [...Object.keys(after), ...(encrypted === undefined ? [] : ["clientSecret"])],
        },
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "amadeus_account", id: accountId });
      if (newCredentials && row.status !== "disabled") {
        this.verifyAfterCommit(trx, accountId);
      }
      return this.withCounts(row, trx);
    });
  }

  /**
   * adminVerifyAmadeusAccount: queues the verification job (`503 SERVICE_UNAVAILABLE` when Redis does not take it),
   * then writes an `amadeus_account.verification_requested` audit row. `404` for an unknown account. A `disabled`
   * account is taken to `pending_verification` first, with that audit row, because the job leaves a disabled account
   * alone; a 503 then leaves it `pending_verification`.
   */
  async requestVerification(claims: Pick<AccessTokenClaims, "sub">, accountId: string): Promise<void> {
    const account = await this.accounts.find(accountId);
    if (account === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const reopened = account.status === "disabled" && (await this.reopenForVerification(claims, accountId));
    if (!(await this.enqueueVerification(accountId))) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }
    if (reopened) {
      return;
    }
    await runInTransaction(this.db, async (trx) => {
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "amadeus_account.verification_requested",
        targetType: "amadeus_account",
        targetId: accountId,
        details: { environment: account.environment, status: account.status },
      });
    });
  }

  /**
   * Takes a disabled account to `pending_verification` for adminVerifyAmadeusAccount, with no error, the
   * `amadeus_account.verification_requested` audit row and an `amadeus_account` invalidation after the commit. The
   * version is kept, as for every status a verification writes. `false` when the account is no longer disabled.
   */
  private async reopenForVerification(
    claims: Pick<AccessTokenClaims, "sub">,
    accountId: string,
  ): Promise<boolean> {
    return runInTransaction(this.db, async (trx) => {
      const current = await this.accounts.lock(trx, accountId);
      if (current?.status !== "disabled") {
        return false;
      }
      const row = await this.accounts.recordVerification(
        trx,
        accountId,
        { status: "pending_verification", last_error: null },
        this.clock.now(),
      );
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "amadeus_account.verification_requested",
        targetType: "amadeus_account",
        targetId: accountId,
        before: { status: current.status },
        after: { status: row.status },
        details: { environment: row.environment, status: current.status },
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "amadeus_account", id: accountId });
      return true;
    });
  }

  /**
   * Adds `amadeus_account.verify {amadeusAccountId}` to `platform-connections`. Never throws: a failure, or a Redis
   * that does not answer within VERIFY_ENQUEUE_TIMEOUT_MS, is logged and answers `false`.
   */
  async enqueueVerification(amadeusAccountId: string): Promise<boolean> {
    const data: AmadeusAccountVerifyJobData = { amadeusAccountId };
    let timer: NodeJS.Timeout | undefined;
    const added = this.connections.add(AMADEUS_ACCOUNT_VERIFY_JOB, data).then(
      () => true,
      (error: unknown) => {
        this.logger.warn({ amadeusAccountId, err: error }, "amadeus_account.enqueue_failed");
        return false;
      },
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), VERIFY_ENQUEUE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([added, timedOut]);
      if (result === "timeout") {
        this.logger.warn(
          { amadeusAccountId, timeoutMs: VERIFY_ENQUEUE_TIMEOUT_MS },
          "amadeus_account.enqueue_timeout",
        );
        return false;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Queues the verification once `trx` has committed (never failing the committed request). */
  private verifyAfterCommit(trx: PlatformTransaction, amadeusAccountId: string): void {
    afterCommit(trx, async () => {
      await this.enqueueVerification(amadeusAccountId);
    });
  }

  /** The account with the office counts of its pool. */
  private async withCounts(
    row: AmadeusAccountRecord,
    trx: PlatformTransaction,
  ): Promise<AdminAmadeusAccount> {
    const counts = await this.accounts.officeCounts([row.id], trx);
    return toAdminAmadeusAccount(row, counts.get(row.id));
  }

  /** The loopback stub (`http://127.0.0.1…`) is a development host only: production takes `https` hosts. */
  private assertBaseUrl(baseUrl: string): void {
    if (this.production && !baseUrl.startsWith("https://")) {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [
          {
            path: "/baseUrl",
            code: "https",
            message: "Must be an https URL; the Amadeus stub is for development.",
          },
        ],
      });
    }
  }
}
