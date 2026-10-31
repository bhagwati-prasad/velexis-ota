// DomainsModule (platform/docs/architecture.md §2.1, layer 1): owns `tenant_domains`. The static module holds the
// repository, with the sub-domain row of a new OTA that ProvisioningModule writes in the create-OTA transaction
// (PBE-018).
//
// - `DomainsModule.forApi()` (AppModule) adds the portal's domain routes (DomainsController, DomainsService: the list
//   since PBE-027; adding, making primary and removing a custom domain since PBE-049) and Caddy's TLS `ask` endpoint
//   (TlsAskController, TlsAskService with its in-process refusal cache, ADR-0018, PADR-0004 item 6) (PBE-027).
//   TlsAskService is a listener of the API's `vx:invalidate` subscriber (CommonModule), so it must exist once per
//   process: only this API module provides it.
//
// The DNS checks and the TLS probe come with PBE-050 and PBE-051. It imports AuditModule (the audit rows of the domain
// writes) and uses the global CommonModule (Clock, IdGenerator, FeatureSwitches, PLATFORM_DB) and RedisModule (the
// command client, the InvalidationPublisher).
import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DomainsController } from "./domains.controller";
import { DomainsRepository } from "./domains.repository";
import { DomainsService } from "./domains.service";
import { TlsAskController } from "./tls-ask.controller";
import { TlsAskNegativeCache } from "./tls-ask.negative-cache";
import { TlsAskService } from "./tls-ask.service";

@Module({
  imports: [AuditModule],
  providers: [DomainsRepository],
  exports: [DomainsRepository],
})
export class DomainsModule {
  /** The module with the portal's domain routes and the TLS `ask` endpoint, for AppModule. */
  static forApi(): DynamicModule {
    return {
      module: DomainsModule,
      controllers: [DomainsController, TlsAskController],
      providers: [DomainsService, TlsAskNegativeCache, TlsAskService],
    };
  }
}
