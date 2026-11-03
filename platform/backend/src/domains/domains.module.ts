// DomainsModule (platform/docs/architecture.md §2.1, layer 1): owns `tenant_domains`. The static module holds the
// repository, with the sub-domain row of a new OTA that ProvisioningModule writes in the create-OTA transaction
// (PBE-018).
//
// - `DomainsModule.forApi()` (AppModule and AdminModule: one object for both, so the API has one instance of it) adds
//   the portal's domain routes (DomainsController, DomainsService: the list since PBE-027; adding, making primary and
//   removing a custom domain since PBE-049; checking one now since PBE-050, with DomainJobs, the producer of
//   `platform-domains`), Caddy's TLS `ask` endpoint (TlsAskController, TlsAskService with its in-process refusal
//   cache, ADR-0018, PADR-0004 item 6) (PBE-027), and the platform admin's domain rules (AdminDomainsService, with
//   DomainOwnerNotices for the owners' e-mail of a removal; PBE-051), which it exports to AdminModule's thin
//   AdminDomainsController. TlsAskService is a listener of the API's `vx:invalidate` subscriber (CommonModule), so it
//   must exist once per process: only this API module provides it.
// - `DomainsModule.forWorker()` (WorkerModule) is the worker's part: the one processor of `platform-domains`
//   (DomainChecksProcessor) with the DNS verification (DomainVerification over the `node:dns` resolver of
//   dns.gateway.ts) and the `domains.verify_pending` handler of the `platform-maintenance` processor (PBE-050); the
//   daily DNS re-check (DomainRecheck), the TLS probe (DomainTlsProbe on TLS_PROBE_TARGET, Caddy on `127.0.0.1:443`)
//   and the handlers of `domains.recheck_verified` and `domains.tls_probe` (PBE-051). It is a module of its own, as
//   SettlementsModule's worker part is, so the worker builds neither the portal's routes nor TLS `ask`.
//
// It imports AuditModule (the audit rows of the domain writes), QueuesModule (the `platform-domains` queue) and
// NotificationsModule (the owners' e-mails), and uses the global CommonModule (Clock, IdGenerator, FeatureSwitches,
// PLATFORM_DB) and RedisModule (the command client, the InvalidationPublisher).
import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { QueuesModule } from "../common/queues/queues.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AdminDomainsService } from "./admin-domains.service";
import { dnsResolverProvider } from "./dns.gateway";
import {
  DomainChecksProcessor,
  DomainJobs,
  DomainOwnerNotices,
  DomainRecheck,
  DomainVerification,
} from "./domain-checks.processor";
import { DomainsController } from "./domains.controller";
import { DomainsRepository } from "./domains.repository";
import { DomainsService } from "./domains.service";
import { RecheckVerifiedScheduler, TlsProbeScheduler } from "./recheck.scheduler";
import { TlsAskController } from "./tls-ask.controller";
import { TlsAskNegativeCache } from "./tls-ask.negative-cache";
import { TlsAskService } from "./tls-ask.service";
import { DomainTlsProbe, tlsProbeTargetProvider } from "./tls-probe";
import { VerifyPendingScheduler } from "./verify-pending.scheduler";

/** The worker's part of DomainsModule (`DomainsModule.forWorker()`). */
@Module({
  imports: [QueuesModule, AuditModule, NotificationsModule],
  providers: [
    DomainsRepository,
    DomainJobs,
    DomainOwnerNotices,
    dnsResolverProvider,
    tlsProbeTargetProvider,
    DomainVerification,
    DomainRecheck,
    DomainTlsProbe,
    DomainChecksProcessor,
    VerifyPendingScheduler,
    RecheckVerifiedScheduler,
    TlsProbeScheduler,
  ],
})
export class DomainsWorkerModule {}

@Module({
  imports: [AuditModule],
  providers: [DomainsRepository],
  exports: [DomainsRepository],
})
export class DomainsModule {
  /** The one `forApi()` module object of the process. */
  private static apiModule: DynamicModule | undefined;

  /**
   * The module with the portal's domain routes, the TLS `ask` endpoint and the admin's domain rules, for AppModule
   * and AdminModule. One object for every caller, so both imports share one module instance (one DomainJobs, one
   * TlsAskService).
   */
  static forApi(): DynamicModule {
    DomainsModule.apiModule ??= {
      module: DomainsModule,
      imports: [QueuesModule, NotificationsModule],
      controllers: [DomainsController, TlsAskController],
      providers: [
        DomainsService,
        DomainJobs,
        DomainOwnerNotices,
        AdminDomainsService,
        TlsAskNegativeCache,
        TlsAskService,
      ],
      exports: [AdminDomainsService],
    };
    return DomainsModule.apiModule;
  }

  /** The processor of `platform-domains`, the DNS checks, the TLS probe and the daily runs' handlers, for WorkerModule. */
  static forWorker(): DynamicModule {
    return { module: DomainsWorkerModule };
  }
}
