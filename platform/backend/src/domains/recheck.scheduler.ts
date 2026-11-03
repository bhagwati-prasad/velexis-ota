// The two daily runs of custom domains (PBE-051; platform/docs/architecture.md §5, in UTC, registered while
// FEATURE_CUSTOM_DOMAINS is on; flows/custom-domains.md steps 4 and 6, PADR-0004 items 5 and 7, scope PF-41 AC3). Their
// schedules are declared with the others in scheduler.registry.ts, which the worker registers when it starts; these are
// their handlers, which the one processor of `platform-maintenance` runs (DomainsModule.forWorker()). Each run only
// queues one job per domain on `platform-domains`, whose processor does the work (domain-checks.processor.ts):
//
// - `domains.recheck_verified` (04:10): one `domain.recheck` per verified custom domain, oldest first. The job asks DNS
//   for both proofs again; a failure counts, a success resets the count, and the third consecutive failure fails the
//   domain and gives the primary flag back to the sub-domain.
// - `domains.tls_probe` (04:40): one `domain.tls_probe` per verified storefront host (the Velexis sub-domains and the
//   custom domains) of an OTA whose hosts may be served (`provisioning`, `active`, `suspended`: the tenants of `ask`
//   rule 1), oldest first. The job connects to Caddy with the host as SNI and stores what it finds (tls-probe.ts).
//
// Each job id names the domain and the UTC day of the Clock's now when the run (or its retry) starts
// (`domain.recheck.<domainId>.<day>`, `domain.tls_probe.<domainId>.<day>`), so a retry on the same day adds no second
// job for a domain queued already (completed jobs are kept a day, ADR-0009 item 7). A platform admin's re-check of a
// verified domain takes the same `domain.recheck` id (admin-domains.service.ts), so the daily run and the admin's
// clicks count one strike a day at most (FIX-W40-PLATFORM, lead decision (2f) of 2026-11-03). When a job cannot be
// queued (Redis down or too slow) the run fails after trying every domain, and BullMQ tries it again with the defaults
// of ADR-0009 (5 attempts, backoff from 30 s); the next day's run comes anyway.
import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { MaintenanceJob, type MaintenanceJobHandler } from "../common/queues/maintenance.processor";
import { DOMAIN_RECHECK_JOB, DOMAIN_TLS_PROBE_JOB, DomainJobs } from "./domain-checks.processor";
import { DomainsRepository } from "./domains.repository";

/** The schedules and job names (scheduler.registry.ts). */
export const DOMAINS_RECHECK_VERIFIED_JOB = "domains.recheck_verified";
export const DOMAINS_TLS_PROBE_JOB = "domains.tls_probe";

/** The length of one run's slot: a day. */
export const DAILY_SLOT_MS = 24 * 60 * 60 * 1000;

/** The BullMQ job id of a domain's `job` in the daily run of `now` (no `:`, which BullMQ refuses in ids). */
export function dailyJobId(job: string, domainId: string, now: Date): string {
  return `${job}.${domainId}.${Math.floor(now.getTime() / DAILY_SLOT_MS)}`;
}

/** What a finished run returns (BullMQ keeps it with the job): counts only. */
export interface DailyDomainRunResult {
  /** The domains found. */
  readonly domains: number;
  /** The jobs queued (or found queued by an earlier try of the same run). */
  readonly queued: number;
}

/** Some jobs could not be queued: the run fails, and BullMQ tries it again. */
export class DailyDomainEnqueueError extends Error {
  override readonly name = "DailyDomainEnqueueError";

  constructor(job: string, failed: number, domains: number) {
    super(`${job} could not be queued for ${failed} of ${domains} domains on platform-domains`);
  }
}

/** Queues `enqueue(domainId, jobId)` for every id; throws when one could not be queued. */
async function queueEach(
  job: string,
  ids: readonly string[],
  now: Date,
  enqueue: (domainId: string, jobId: string) => Promise<boolean>,
): Promise<DailyDomainRunResult> {
  let queued = 0;
  for (const domainId of ids) {
    if (await enqueue(domainId, dailyJobId(job, domainId, now))) {
      queued += 1;
    }
  }
  if (queued < ids.length) {
    throw new DailyDomainEnqueueError(job, ids.length - queued, ids.length);
  }
  return { domains: ids.length, queued };
}

@Injectable()
@MaintenanceJob(DOMAINS_RECHECK_VERIFIED_JOB)
export class RecheckVerifiedScheduler implements MaintenanceJobHandler {
  constructor(
    private readonly domains: DomainsRepository,
    private readonly jobs: DomainJobs,
    private readonly clock: Clock,
    @InjectPinoLogger(RecheckVerifiedScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run: a `domain.recheck` per verified custom domain (see the file header). */
  async run(): Promise<DailyDomainRunResult> {
    const result = await queueEach(
      DOMAIN_RECHECK_JOB,
      await this.domains.verifiedCustomDomainIds(),
      this.clock.now(),
      (domainId, jobId) => this.jobs.enqueueRecheck(domainId, jobId),
    );
    this.logger.info({ ...result }, "domains.recheck_verified_queued");
    return result;
  }
}

@Injectable()
@MaintenanceJob(DOMAINS_TLS_PROBE_JOB)
export class TlsProbeScheduler implements MaintenanceJobHandler {
  constructor(
    private readonly domains: DomainsRepository,
    private readonly jobs: DomainJobs,
    private readonly clock: Clock,
    @InjectPinoLogger(TlsProbeScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run: a `domain.tls_probe` per verified storefront host of a served OTA (see the file header). */
  async run(): Promise<DailyDomainRunResult> {
    const result = await queueEach(
      DOMAIN_TLS_PROBE_JOB,
      await this.domains.servedStorefrontHostIds(),
      this.clock.now(),
      (domainId, jobId) => this.jobs.enqueueTlsProbe(domainId, { jobId }),
    );
    this.logger.info({ ...result }, "domains.tls_probe_queued");
    return result;
  }
}
