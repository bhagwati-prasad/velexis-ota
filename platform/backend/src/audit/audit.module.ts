// AuditModule (platform/docs/architecture.md §2.1, layer 0): owns `platform_audit_log`. Every module of a higher layer
// that changes state imports it and calls `AuditService.record(trx, entry)` in its own transaction (PADR-0006). The
// module has no connection of its own: it writes on the caller's transaction. In the API it reads the request context
// of the global CommonModule; in the worker and the CLI there is none, and the rows carry no IP or user agent.
import { Module } from "@nestjs/common";
import { AuditRepository } from "./audit.repository";
import { AuditService } from "./audit.service";

@Module({
  providers: [AuditRepository, AuditService],
  exports: [AuditService],
})
export class AuditModule {}
