// `console.supplierRequests.list` (consoleListSupplierRequests; `x-scope: console`, `x-permission:
// supplier_requests:read`: owner, admin, agent, finance; OBE-066): the Amadeus call log of the request's environment,
// newest first, with the redacted bodies when asked for (supplier-log.repository.ts). The global guards resolved the
// caller, the tenant and its environment, the staff member, the rate limits and the permission (OADR-0011 points 3 to
// 6); the validation interceptor checked the input against the OTA document. The read is the whole use case: the
// handler runs the repository's query in one tenant transaction and maps the rows. No Amadeus call.
//
// The supplier log is not an audited read (OADR-0011 point 8 as decided on 2026-10-21, flow §3 step 7: "Other
// successful reads (… the supplier log …) write none"): the handler does not opt in with `@AuditedRead`, so only a
// refused or failed call has a `staff_actions` row. `Cache-Control: private, no-store`.
import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx } from "../tenancy/tenant-tx";
import {
  decodeSupplierLogCursor,
  encodeSupplierLogCursor,
  SUPPLIER_LOG_CACHE_CONTROL,
  supplierLogFiltersOf,
  supplierLogFingerprint,
  supplierLogLimitOf,
  SupplierLogRepository,
  toSupplierLogEntry,
  type ConsoleSupplierRequestPage,
} from "./supplier-log.repository";

@Controller("v1/console/supplier-requests")
export class ConsoleSupplierLogController {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly log: SupplierLogRepository,
  ) {}

  @Get()
  @OpenApiOperation("consoleListSupplierRequests")
  async list(
    @OpenApiInput() input: ValidatedInput<"consoleListSupplierRequests">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleSupplierRequestPage> {
    res.setHeader("Cache-Control", SUPPLIER_LOG_CACHE_CONTROL);
    const query = input.query ?? {};
    const tenant = this.tenants.require();
    const includeBodies = query.includeBodies === true;
    const limit = supplierLogLimitOf(query);
    const filters = supplierLogFiltersOf(query);
    const fingerprint = supplierLogFingerprint(tenant.environment, filters);
    const after = query.cursor === undefined ? undefined : decodeSupplierLogCursor(query.cursor, fingerprint);
    const rows = await this.tx.run((trx) =>
      this.log.page(trx, {
        ...filters,
        environment: tenant.environment,
        includeBodies,
        after,
        limit: limit + 1,
      }),
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => toSupplierLogEntry(row, includeBodies)),
      page: {
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeSupplierLogCursor(fingerprint, last.sortKey, last.id)
            : null,
        limit,
      },
    };
  }
}
