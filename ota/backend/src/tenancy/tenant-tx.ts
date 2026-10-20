// Tenant transactions of the OTA backend (ADR-0004, ota/docs/architecture.md §4, db README §5): `tenantTx` of
// @velexis/db with the schema of the current tenant context, on the process's pool of velexis_ota_app.
//
//   const booking = await this.tx.run((trx) => this.bookings.byId(trx, bookingId));
//
// One transaction per use-case step: it starts with `set_config('search_path', '<schema>, reference', true)` and
// `set_config('statement_timeout', '15s', true)`, both transaction-local, so a pooled connection never carries a
// tenant to the next request. The schema name comes only from the tenant context (tenant-context.ts), which the
// tenant guard fills from the platform row; a caller cannot pass one, and there is no tenant outside a resolved
// request or `TenantContext.run`. Repositories take the transaction first and never name a schema.
//
// Work that must wait for the commit (enqueueing a job about rows the transaction wrote, conventions §2 "enqueue jobs
// after commit") is registered with `afterCommit(trx, work)` inside `run`: it runs once COMMIT has succeeded, in
// order, and is dropped when the transaction rolls back (OBE-030: the outbox's `notify {tenantId}`, OADR-0013 item 1).
import { Inject, Injectable } from "@nestjs/common";
import { tenantTx, type TenantDatabase, type TenantDb, type Transaction } from "@velexis/db";
import { TenantContext } from "./tenant-context";

/** Injection token of the `TenantDb` handle over the process's pool (tenancy.module.ts). */
export const TENANT_DB = "TENANT_DB";

/** `statement_timeout` of a tenant transaction (architecture §4). */
export const TENANT_STATEMENT_TIMEOUT_MS = 15_000;

/** The open transaction of a tenant use case. */
export type TenantTransaction = Transaction<TenantDatabase>;

/** Work that waits for the commit of a tenant transaction. */
export type AfterCommitWork = () => Promise<void> | void;

/** The work registered on each open transaction of `TenantTx.run`, by the transaction object. */
const AFTER_COMMIT = new WeakMap<object, AfterCommitWork[]>();

/** `afterCommit` got a transaction that `TenantTx.run` did not open, or one that has finished. */
export class NotInTenantTransactionError extends Error {
  override readonly name = "NotInTenantTransactionError";

  constructor() {
    super(
      "afterCommit: pass the open transaction of TenantTx.run (its commit is what the work waits for); a " +
        "transaction opened another way, or one that has finished, cannot be followed",
    );
  }
}

/**
 * Registers `work` to run after the commit of `trx`, an open transaction of `TenantTx.run`. Throws
 * `NotInTenantTransactionError` for any other transaction (or one whose function has returned).
 */
export function afterCommit(trx: TenantTransaction, work: AfterCommitWork): void {
  const queue = AFTER_COMMIT.get(trx);
  if (queue === undefined) {
    throw new NotInTenantTransactionError();
  }
  queue.push(work);
}

@Injectable()
export class TenantTx {
  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    private readonly tenants: TenantContext,
  ) {}

  /**
   * Runs `fn` in one transaction on the schema of the current tenant; it commits when `fn` resolves and rolls back
   * when it throws. Throws `NoTenantContextError` without a tenant in the context, before any SQL.
   *
   * After the commit it runs the work `fn` registered with `afterCommit(trx, …)`, in order, and then resolves with
   * `fn`'s result; a rollback (`fn` throws, or COMMIT fails) drops the work. A piece of work that throws does not stop
   * the others; its error (an `AggregateError` for several) is rethrown after all of them ran, although the
   * transaction stays committed.
   */
  async run<T>(fn: (trx: TenantTransaction) => Promise<T>): Promise<T> {
    const { schemaName } = this.tenants.require();
    const work: AfterCommitWork[] = [];
    const result = await tenantTx(
      this.db,
      schemaName,
      async (trx) => {
        AFTER_COMMIT.set(trx, work);
        try {
          return await fn(trx);
        } finally {
          // Nothing can be registered once `fn` has returned: the commit is under way.
          AFTER_COMMIT.delete(trx);
        }
      },
      { statementTimeoutMs: TENANT_STATEMENT_TIMEOUT_MS },
    );
    const failures: unknown[] = [];
    for (const item of work) {
      try {
        await item();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "work after the commit failed");
    }
    return result;
  }
}
