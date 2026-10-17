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
import { Inject, Injectable } from "@nestjs/common";
import { tenantTx, type TenantDatabase, type TenantDb, type Transaction } from "@velexis/db";
import { TenantContext } from "./tenant-context";

/** Injection token of the `TenantDb` handle over the process's pool (tenancy.module.ts). */
export const TENANT_DB = "TENANT_DB";

/** `statement_timeout` of a tenant transaction (architecture §4). */
export const TENANT_STATEMENT_TIMEOUT_MS = 15_000;

/** The open transaction of a tenant use case. */
export type TenantTransaction = Transaction<TenantDatabase>;

@Injectable()
export class TenantTx {
  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    private readonly tenants: TenantContext,
  ) {}

  /**
   * Runs `fn` in one transaction on the schema of the current tenant; it commits when `fn` resolves and rolls back
   * when it throws. Throws `NoTenantContextError` without a tenant in the context, before any SQL.
   */
  async run<T>(fn: (trx: TenantTransaction) => Promise<T>): Promise<T> {
    const { schemaName } = this.tenants.require();
    return await tenantTx(this.db, schemaName, fn, { statementTimeoutMs: TENANT_STATEMENT_TIMEOUT_MS });
  }
}
