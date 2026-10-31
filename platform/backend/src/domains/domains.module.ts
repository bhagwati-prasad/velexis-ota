// DomainsModule (platform/docs/architecture.md §2.1, layer 1): owns `tenant_domains`. The static module holds the
// repository, with the sub-domain row of a new OTA that ProvisioningModule writes in the create-OTA transaction
// (PBE-018).
//
// - `DomainsModule.forApi()` (AppModule) adds the portal's domain routes (DomainsController, DomainsService: the list
//   since PBE-027; adding, making primary and removing a custom domain since PBE-049; checking one now since PBE-050,
//   with DomainJobs, the producer of `domain.verify` on `platform-domains`) and Caddy's TLS `ask` endpoint
//   (TlsAskController, TlsAskService with its in-process refusal cache, ADR-0018, PADR-0004 item 6) (PBE-027).
//   TlsAskService is a listener of the API's `vx:invalidate` subscriber (CommonModule), so it must exist once per
//   process: only this API module provides it.
// - `DomainsModule.forWorker()` (WorkerModule) is the worker's part (PBE-050): the one processor of `platform-domains`
//   (DomainChecksProcessor) with the DNS verification (DomainVerification over the `node:dns` resolver of
//   dns.gateway.ts) and the `domains.verify_pending` handler of the `platform-maintenance` processor. It is a module of
//   its own, as SettlementsModule's worker part is, so the worker builds neither the portal's routes nor TLS `ask`.
//
// The TLS probe and the daily re-check come with PBE-051. It imports AuditModule (the audit rows of the domain writes),
// QueuesModule (the `platform-domains` queue) and, in the worker, NotificationsModule (the owners' e-mails), and uses
// the global CommonModule (Clock, IdGenerator, FeatureSwitches, PLATFORM_DB) and RedisModule (the command client, the
// InvalidationPublisher).
import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { QueuesModule } from "../common/queues/queues.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { dnsResolverProvider } from "./dns.gateway";
import { DomainChecksProcessor, DomainJobs, DomainVerification } from "./domain-checks.processor";
import { DomainsController } from "./domains.controller";
import { DomainsRepository } from "./domains.repository";
import { DomainsService } from "./domains.service";
import { TlsAskController } from "./tls-ask.controller";
import { TlsAskNegativeCache } from "./tls-ask.negative-cache";
import { TlsAskService } from "./tls-ask.service";
import { VerifyPendingScheduler } from "./verify-pending.scheduler";

/** The worker's part of DomainsModule (`DomainsModule.forWorker()`). */
@Module({
  imports: [QueuesModule, AuditModule, NotificationsModule],
  providers: [
    DomainsRepository,
    DomainJobs,
    dnsResolverProvider,
    DomainVerification,
    DomainChecksProcessor,
    VerifyPendingScheduler,
  ],
})
export class DomainsWorkerModule {}

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
      imports: [QueuesModule],
      controllers: [DomainsController, TlsAskController],
      providers: [DomainsService, DomainJobs, TlsAskNegativeCache, TlsAskService],
    };
  }

  /** The processor of `platform-domains`, the DNS verification and the 5-minute run's handler, for WorkerModule. */
  static forWorker(): DynamicModule {
    return { module: DomainsWorkerModule };
  }
}
