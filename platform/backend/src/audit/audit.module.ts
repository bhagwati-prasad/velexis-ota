// AuditModule (platform/docs/architecture.md §2.1, layer 0): owns `platform_audit_log`. Every module of a higher layer
// that changes state imports it and calls `AuditService.record(trx, entry)` in its own transaction (PADR-0006). The
// module has no connection of its own: it writes on the caller's transaction. In the API it reads the request context
// of the global CommonModule; in the worker and the CLI there is none, and the rows carry no IP or user agent.
//
// `AuditModule.forApi()` (AdminModule, PBE-032) adds the reads of the table: the admin's audit search, the CSV export
// and an account's recent rows (AuditQueryService, on the global CommonModule's PLATFORM_DB).
import { Module, type DynamicModule } from "@nestjs/common";
import { AuditQueryService } from "./audit-query.service";
import { AuditRepository } from "./audit.repository";
import { AuditService } from "./audit.service";

@Module({
  providers: [AuditRepository, AuditService],
  exports: [AuditService],
})
export class AuditModule {
  /** The module with the audit reads of the platform admin, for AdminModule. */
  static forApi(): DynamicModule {
    return {
      module: AuditModule,
      providers: [AuditQueryService],
      exports: [AuditQueryService],
    };
  }
}
