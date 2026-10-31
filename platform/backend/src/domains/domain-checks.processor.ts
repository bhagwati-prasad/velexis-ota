// The queue `platform-domains` (PBE-050; platform/docs/architecture.md §5, concurrency 4; flows/custom-domains.md step
// 2, PADR-0004 items 2 to 4, scope PF-41 AC2): the DNS verification of pending custom domains, its producer and its one
// consumer.
//
// - **DomainJobs** (API and worker) queues `domain.verify {domainId}` (the 5-minute run of verify-pending.scheduler.ts,
//   and `checkDomain`) and `domain.tls_probe {domainId}` one minute after a verification (TLS_PROBE_DELAY_MS). The job
//   data is the domain id and nothing else (ADR-0009 item 10). `enqueue…` never throws: Redis failing, or not answering
//   within DOMAIN_ENQUEUE_TIMEOUT_MS, is logged (`domains.enqueue_failed`, `domains.enqueue_timeout`) and answers
//   `false`; the caller decides what that means (`checkDomain` answers `503`, the run fails and is tried again).
// - **DomainVerification** (worker) is one `domain.verify` job:
//   1. the domain is read; a domain that is gone, not a custom domain or not `pending` is left alone
//      (`domains.verify_skipped`: a concurrent job verified it, the owner removed it, it failed meanwhile);
//   2. outside any transaction, domain-checks.ts asks the resolver of dns.gateway.ts (DNS_RESOLVERS) for both proofs:
//      `TXT _velexis.<host>` holds the token, and the CNAME chain reaches `<key>.<STOREFRONT_BASE_DOMAIN>` or every
//      A/AAAA record is a storefront address (STOREFRONT_IPV4, STOREFRONT_IPV6);
//   3. in one transaction, with the domain row locked and still `pending` with the same token (else nothing is written,
//      `domains.verify_superseded`):
//      - both proofs hold: `verified`, `verified_at`, `check_failures = 0`, `last_checked_at`, no `last_check_error`;
//        the audit row `domain.verified`; `domain.verified` to every active owner of the OTA; after the commit the
//        `domain` invalidation (the OTA backend and TLS `ask` serve the host from now on) and `domain.tls_probe` in one
//        minute, whose probe makes Caddy obtain the certificate before the first traveller arrives (PBE-051 handles
//        the probe; a probe that cannot be queued is logged, and the daily probe catches up);
//      - otherwise `last_checked_at` and the error code (`last_check_error`: `txt_missing`, `txt_mismatch`,
//        `cname_missing`, `cname_wrong_target`, `a_wrong_address`, `dns_timeout`) for the portal; when the Clock's now
//        has reached `verification_deadline_at` the domain also becomes `failed`, with the audit row
//        `domain.verification_failed`, `domain.failed` to every active owner and, after the commit, the `domain`
//        invalidation (architecture §6.3). `checkDomain` restarts a failed domain's window with the same token.
//   The owners' e-mails go out while the OTA's members see it (not `failed`, not deleted), once per owner and window
//   (idempotency key with the deadline). The audit rows carry the host name, the statuses, the routing or the error
//   code, never the token.
// - **DomainChecksProcessor** (worker only, DomainsModule.forWorker()) is the queue's one processor (BullMQ hands any
//   job of a queue to any of its workers): `domain.verify` runs DomainVerification; `domain.recheck` and
//   `domain.tls_probe` belong to PBE-051 and complete for now with one `domains.job_not_handled` line, so a probe
//   queued by a verification does not fail; any other name or invalid data ends at once (UnrecoverableError). A
//   database failure fails the job and BullMQ tries again (ADR-0009: 5 attempts, backoff from 30 s); a DNS failure is
//   no job failure but the `dns_timeout` outcome, which the next run asks again.
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UnrecoverableError, type Job, type JobsOptions, type Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { MEMBER_VISIBLE_TENANT_STATUSES } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { PLATFORM_QUEUE, platformWorkerOptions } from "../common/queues/queue-names";
import { afterCommit, InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import { OutboxService } from "../notifications/outbox.service";
import { DNS_RESOLVER } from "./dns.gateway";
import {
  checkDomainRecords,
  DNS_CHECK_ERROR_TEXT,
  type DnsCheckError,
  type DnsResolver,
  type DomainCheckResult,
  type DomainRouting,
  type StorefrontAddressSet,
} from "./domain-checks";
import { DomainsRepository, type DomainCheckRow } from "./domains.repository";

/** The jobs of `platform-domains` (architecture §5). */
export const DOMAIN_VERIFY_JOB = "domain.verify";
export const DOMAIN_RECHECK_JOB = "domain.recheck";
export const DOMAIN_TLS_PROBE_JOB = "domain.tls_probe";

/** The jobs of the queue that a later task handles (PBE-051): completed with a log line until then. */
export const DOMAIN_JOBS_NOT_HANDLED_YET: readonly string[] = Object.freeze([
  DOMAIN_RECHECK_JOB,
  DOMAIN_TLS_PROBE_JOB,
]);

/** The data of every job of the queue: the domain's id, nothing else (ADR-0009 item 10). */
export interface DomainJobData {
  readonly domainId: string;
}

/** How long after a verification the first TLS probe runs (PADR-0004 item 7: one minute). */
export const TLS_PROBE_DELAY_MS = 60_000;

/** How long queueing a job may take before it is given up. */
export const DOMAIN_ENQUEUE_TIMEOUT_MS = 2000;

/** The actor label of the job's audit rows. */
const ACTOR_LABEL = DOMAIN_VERIFY_JOB;

/** The owners' e-mails (PADR-0013 item 5). */
export const DOMAIN_VERIFIED_TEMPLATE = "domain.verified";
export const DOMAIN_FAILED_TEMPLATE = "domain.failed";

const DOMAIN_ID = /^dom_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The domain id of a job's data, or `undefined` when the data is not `{ domainId: dom_… }`. */
export function domainIdOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const id = (data as Partial<DomainJobData>).domainId;
  return Object.keys(data).length === 1 && typeof id === "string" && DOMAIN_ID.test(id) ? id : undefined;
}

/** A job name as a log line may carry it: a plain job name, else a placeholder (never arbitrary text). */
function loggableJobName(name: unknown): string {
  return typeof name === "string" && /^[a-z][a-z0-9_.-]{0,60}$/.test(name) ? name : "(not a job name)";
}

@Injectable()
export class DomainJobs {
  constructor(
    @InjectQueue(PLATFORM_QUEUE.domains) private readonly queue: Queue,
    @InjectPinoLogger(DomainJobs.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Queues `domain.verify` for the domain; `jobId` (the 5-minute run's) makes a second add of the same run a no-op.
   * `false`, after one log line, when Redis fails or takes too long.
   */
  enqueueVerify(domainId: string, jobId?: string): Promise<boolean> {
    return this.enqueue(DOMAIN_VERIFY_JOB, domainId, jobId === undefined ? {} : { jobId });
  }

  /** Queues `domain.tls_probe` for the domain, TLS_PROBE_DELAY_MS from now (file header). */
  enqueueTlsProbe(domainId: string): Promise<boolean> {
    return this.enqueue(DOMAIN_TLS_PROBE_JOB, domainId, { delay: TLS_PROBE_DELAY_MS });
  }

  private async enqueue(name: string, domainId: string, options: JobsOptions): Promise<boolean> {
    const data: DomainJobData = { domainId };
    let timer: NodeJS.Timeout | undefined;
    const added = this.queue.add(name, data, options).then(
      () => true,
      (error: unknown) => {
        this.logger.warn({ job: name, domainId, err: error }, "domains.enqueue_failed");
        return false;
      },
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), DOMAIN_ENQUEUE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([added, timedOut]);
      if (result === "timeout") {
        this.logger.warn(
          { job: name, domainId, timeoutMs: DOMAIN_ENQUEUE_TIMEOUT_MS },
          "domains.enqueue_timeout",
        );
        return false;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** What a finished `domain.verify` job returns (BullMQ keeps it): ids, statuses and codes, never a token. */
export interface DomainVerifyResult {
  readonly domainId: string;
  /**
   * The domain's status after the job: `verified`, `pending` or `failed`; `missing` when no such domain was found at
   * the start, and `superseded` when the domain was removed or changed while DNS was asked (nothing written).
   */
  readonly status: string;
  /** False when the job left the domain alone (not a pending custom domain, or changed meanwhile). */
  readonly checked: boolean;
  /** How the verified domain routes to Velexis. */
  readonly routing?: DomainRouting;
  /** The error code of a failed check. */
  readonly error?: DnsCheckError;
}

@Injectable()
export class DomainVerification {
  private readonly baseDomain: string;
  private readonly addresses: StorefrontAddressSet;

  constructor(
    private readonly domains: DomainsRepository,
    private readonly jobs: DomainJobs,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(DNS_RESOLVER) private readonly resolver: DnsResolver,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(DomainVerification.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
    this.addresses = {
      ipv4: config.get("STOREFRONT_IPV4", { infer: true }),
      ipv6: config.get("STOREFRONT_IPV6", { infer: true }),
    };
  }

  /** One `domain.verify` job (see the file header). */
  async verify(domainId: string): Promise<DomainVerifyResult> {
    const row = await this.domains.findForCheck(domainId);
    if (
      row === undefined ||
      row.kind !== "custom" ||
      row.verification_status !== "pending" ||
      row.verification_token === null
    ) {
      const status = row?.verification_status ?? "missing";
      this.logger.info({ domainId, status }, "domains.verify_skipped");
      return { domainId, status, checked: false };
    }
    const token = row.verification_token;
    const result = await checkDomainRecords(this.resolver, {
      hostname: row.hostname,
      verificationToken: token,
      cnameTarget: `${row.tenant_key}.${this.baseDomain}`,
      storefrontAddresses: this.addresses,
    });

    const outcome = await runInTransaction(this.db, async (trx) => {
      const current = await this.domains.lockForCheck(trx, domainId);
      if (
        current === undefined ||
        current.verification_status !== "pending" ||
        current.verification_token !== token
      ) {
        return undefined;
      }
      const now = this.clock.now();
      return result.ok
        ? this.finishVerified(trx, current, result.routing, now)
        : this.finishFailedCheck(trx, current, result, now);
    });
    if (outcome === undefined) {
      this.logger.info({ domainId, tenantId: row.tenant_id }, "domains.verify_superseded");
      return { domainId, status: "superseded", checked: false };
    }
    this.logger.info(
      {
        domainId,
        tenantId: row.tenant_id,
        status: outcome.status,
        ...(outcome.routing === undefined ? {} : { routing: outcome.routing }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      },
      outcome.status === "verified"
        ? "domains.verified"
        : outcome.status === "failed"
          ? "domains.verification_failed"
          : "domains.check_failed",
    );
    return outcome;
  }

  /** Both proofs hold: verified, audited, the owners told; the invalidation and the TLS probe follow the commit. */
  private async finishVerified(
    trx: PlatformTransaction,
    domain: DomainCheckRow,
    routing: DomainRouting,
    now: Date,
  ): Promise<DomainVerifyResult> {
    await this.domains.markVerified(trx, domain.id, now);
    await this.audit.record(trx, {
      actorType: "system",
      actorLabel: ACTOR_LABEL,
      action: "domain.verified",
      targetType: "domain",
      targetId: domain.id,
      tenantId: domain.tenant_id,
      before: { verificationStatus: domain.verification_status },
      after: { verificationStatus: "verified" },
      details: { hostname: domain.hostname, routing },
    });
    await this.notifyOwners(trx, domain, DOMAIN_VERIFIED_TEMPLATE, {});
    this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: domain.hostname });
    afterCommit(trx, async () => {
      if (!(await this.jobs.enqueueTlsProbe(domain.id))) {
        this.logger.warn({ domainId: domain.id, tenantId: domain.tenant_id }, "domains.tls_probe_not_queued");
      }
    });
    return { domainId: domain.id, status: "verified", checked: true, routing };
  }

  /**
   * A proof does not hold: the check's time and error; past the deadline also `failed`, audited, the owners told, and
   * the invalidation after the commit.
   */
  private async finishFailedCheck(
    trx: PlatformTransaction,
    domain: DomainCheckRow,
    result: Extract<DomainCheckResult, { ok: false }>,
    now: Date,
  ): Promise<DomainVerifyResult> {
    const deadline = domain.verification_deadline_at;
    const failed = deadline !== null && now.getTime() >= deadline.getTime();
    await this.domains.recordCheckFailure(trx, domain.id, { error: result.error, failed, now });
    if (!failed) {
      return { domainId: domain.id, status: "pending", checked: true, error: result.error };
    }
    await this.audit.record(trx, {
      actorType: "system",
      actorLabel: ACTOR_LABEL,
      action: "domain.verification_failed",
      targetType: "domain",
      targetId: domain.id,
      tenantId: domain.tenant_id,
      before: { verificationStatus: domain.verification_status },
      after: { verificationStatus: "failed", lastCheckError: result.error },
      details: { hostname: domain.hostname, verificationDeadlineAt: deadline.toISOString() },
    });
    await this.notifyOwners(trx, domain, DOMAIN_FAILED_TEMPLATE, {
      reason: DNS_CHECK_ERROR_TEXT[result.error],
    });
    this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: domain.hostname });
    return { domainId: domain.id, status: "failed", checked: true, error: result.error };
  }

  /**
   * Queues `template` to every active owner of the domain's OTA in `trx`, once per owner and verification window, while
   * the OTA's members see it; otherwise nothing.
   */
  private async notifyOwners(
    trx: PlatformTransaction,
    domain: DomainCheckRow,
    template: typeof DOMAIN_VERIFIED_TEMPLATE | typeof DOMAIN_FAILED_TEMPLATE,
    extra: Readonly<Record<string, string>>,
  ): Promise<void> {
    const tenant = await this.domains.tenantLabel(trx, domain.tenant_id);
    if (
      tenant === undefined ||
      tenant.deleted_at !== null ||
      !(MEMBER_VISIBLE_TENANT_STATUSES as readonly string[]).includes(tenant.status)
    ) {
      return;
    }
    const domainsUrl = this.outbox.portalLink(`/otas/${domain.tenant_id}/domains`);
    const window = domain.verification_deadline_at?.toISOString() ?? "none";
    for (const owner of await this.domains.activeOwners(trx, domain.tenant_id)) {
      await this.outbox.queue(trx, {
        templateKey: template,
        to: owner.email,
        accountId: owner.account_id,
        tenantId: domain.tenant_id,
        data: {
          fullName: owner.full_name,
          tenantName: tenant.name,
          tenantKey: tenant.key,
          hostname: domain.hostname,
          ...extra,
          domainsUrl,
        },
        idempotencyKey: `${template}:${domain.id}:${window}`,
      });
    }
  }
}

/** What a job the processor does not handle yet completes with. */
export interface UnhandledDomainJob {
  readonly handled: false;
}

@Processor(PLATFORM_QUEUE.domains, platformWorkerOptions(PLATFORM_QUEUE.domains))
export class DomainChecksProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly verification: DomainVerification,
    @InjectPinoLogger(DomainChecksProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<DomainVerifyResult | UnhandledDomainJob> {
    const isVerify = job.name === DOMAIN_VERIFY_JOB;
    if (!isVerify && !DOMAIN_JOBS_NOT_HANDLED_YET.includes(job.name)) {
      throw new UnrecoverableError(`${PLATFORM_QUEUE.domains} has no job named ${loggableJobName(job.name)}`);
    }
    const domainId = domainIdOf(job.data);
    if (domainId === undefined) {
      throw new UnrecoverableError(`${job.name} needs { domainId: dom_… } and nothing else`);
    }
    if (!isVerify) {
      this.logger.info({ job: job.name, domainId }, "domains.job_not_handled");
      return { handled: false };
    }
    return this.verification.verify(domainId);
  }

  /** A job failed: logged with its name, domain and attempt, so the failure is seen before the retries run out. */
  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(
      {
        queue: PLATFORM_QUEUE.domains,
        job: loggableJobName(job?.name),
        attempt: job?.attemptsMade,
        domainId: domainIdOf(job?.data),
        err: error,
      },
      "domains.job_failed",
    );
  }

  /** Errors of the worker itself (its Redis connections). */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: PLATFORM_QUEUE.domains, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }
}
