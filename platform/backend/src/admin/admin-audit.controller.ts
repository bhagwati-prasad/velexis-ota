// The platform audit log in the platform admin (PBE-032; platform/docs/api-inventory-admin.md §7, flows/platform-admin-
// operations.md §I, PADR-0006 "Audit", scope PF-85): the search and the CSV export, under `/v1/admin/audit-log`. Both
// are `x-scope: platform_admin` (AdminAuthGuard). The search binds its operation and makes one AuditQueryService call.
//
// The export answers `text/csv` as a stream (`StreamableFile` over the chunks of AuditQueryService.startExport), with
// `Cache-Control: no-store` (the file holds e-mail and IP addresses) and an attachment named after the period. A
// failure once the stream has started aborts the answer (the socket is destroyed), so a client never takes a cut file
// for a complete one; a client that goes away stops the reading of further batches. The service has logged the error.
import { Readable } from "node:stream";
import { Controller, Get, Res, StreamableFile } from "@nestjs/common";
import { AUDIT_CSV_CONTENT_TYPE } from "../audit/audit-csv";
import {
  AuditQueryService,
  type AuditEntryList,
  type ExportAuditQuery,
  type ListAuditQuery,
} from "../audit/audit-query.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";

/** The part of the Express response the export handler uses. */
interface StreamTarget {
  setHeader(name: string, value: string): unknown;
  once(event: "close", listener: () => void): unknown;
  destroy(error?: Error): unknown;
}

@Controller("v1/admin")
export class AdminAuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get("audit-log")
  @OpenApiOperation("adminListAudit")
  adminListAudit(@Validated("query") query: ListAuditQuery): Promise<AuditEntryList> {
    return this.audit.list(query);
  }

  @Get("audit-log.csv")
  @OpenApiOperation("adminExportAudit")
  async adminExportAudit(
    @AccessToken() token: AccessTokenClaims,
    @Validated("query") query: ExportAuditQuery,
    @Res({ passthrough: true }) res: StreamTarget,
  ): Promise<StreamableFile> {
    const exported = await this.audit.startExport({ accountId: token.sub }, query);
    const stream = Readable.from(exported.chunks, { objectMode: false });
    // A client that disconnects ends the reading: the generator stops before its next batch.
    res.once("close", () => stream.destroy());
    res.setHeader("Cache-Control", "no-store");
    return new StreamableFile(stream, {
      type: AUDIT_CSV_CONTENT_TYPE,
      disposition: exported.disposition,
    }).setErrorHandler(() => {
      res.destroy();
    });
  }
}
