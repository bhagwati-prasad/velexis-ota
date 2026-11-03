// The queue `platform-domains` (PBE-050, PBE-051; platform/docs/architecture.md §5, concurrency 4; flows/custom-
// domains.md steps 2, 4 and 6, PADR-0004 items 2 to 5 and 7, scope PF-41 AC2 and AC3): the DNS verification of pending
// custom domains, the daily DNS re-check of verified ones, the TLS probe of storefront hosts, their producer and the
// queue's one consumer.
//
// - **DomainJobs** (API and worker) queues `domain.verify {domainId}` (the 5-minute run of verify-pending.scheduler.ts,
//   `checkDomain`, the admin's re-check of a pending domain), `domain.recheck {domainId}` (the daily run of
//   recheck.scheduler.ts, the admin's re-check of a verified domain) and `domain.tls_probe {domainId}` (one minute
//   after a verification, TLS_PROBE_DELAY_MS; the daily run; the admin's re-check, at once). The job data is the domain
//   id and nothing else (ADR-0009 item 10). `enqueue…` never throws: Redis failing, or not answering within
//   DOMAIN_ENQUEUE_TIMEOUT_MS, is logged (`domains.enqueue_failed`, `domains.enqueue_timeout`) and answers `false`; the
//   caller decides what that means (`checkDomain` and `adminRecheckDomain` answer `503`, a run fails and is tried
//   again).
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
//        minute, whose probe makes Caddy obtain the certificate before the first traveller arrives (a probe that
//        cannot be queued is logged, and the daily probe catches up);
//      - otherwise `last_checked_at` and the error code (`last_check_error`: `txt_missing`, `txt_mismatch`,
//        `cname_missing`, `cname_wrong_target`, `a_wrong_address`, `dns_timeout`) for the portal; when the Clock's now
//        has reached `verification_deadline_at` the domain also becomes `failed`, with the audit row
//        `domain.verification_failed`, `domain.failed` to every active owner and, after the commit, the `domain`
//        invalidation (architecture §6.3). `checkDomain` restarts a failed domain's window with the same token.
//   The owners' e-mails go out while the OTA's members see it (not `failed`, not deleted), once per owner and window
//   (idempotency key with the deadline). The audit rows carry the host name, the statuses, the routing or the error
//   code, never the token.
// - **DomainRecheck** (worker, PBE-051) is one `domain.recheck` job, the daily re-check of a verified custom domain
//   (flows step 6, PADR-0004 item 5): the same two proofs, asked outside any transaction for a domain that is still a
//   verified custom domain (else `domains.recheck_skipped`); then, under the tenant's domain lock and with the row
//   locked and still verified with the same token (else `domains.recheck_superseded`):
//   - both proofs hold: `check_failures = 0`, `last_checked_at`, no `last_check_error` (one success resets the count);
//   - otherwise `check_failures` grows by one and `last_checked_at` and the error code are stored; every failed check
//     counts, `dns_timeout` included (a host whose DNS servers do not answer is not reachable by travellers either).
//     At the third consecutive failure (RECHECK_FAILURE_LIMIT) the domain becomes `failed` and loses the primary flag,
//     the OTA's sub-domain becomes primary again when the domain was, the audit row `domain.recheck_failed` is
//     written, `domain.failed` goes to every active owner (once per owner and verification, idempotency key with
//     `verified_at`), and after the commit the `domain` invalidations of the host (and of the sub-domain when the flag
//     moved) are published and the cached `tlsask:<host>` answer is deleted, so neither the OTA backend nor TLS `ask`
//     serves the host any more (architecture §6.3: failed, primary changed).
//   The platform admin's re-check of a verified domain is one such check too (admin-domains.service.ts).
// - **DomainTlsProbe** (tls-probe.ts, PBE-051) is one `domain.tls_probe` job.
// - **DomainOwnerNotices** queues one domain e-mail to every active owner of a domain's OTA in the caller's
//   transaction, while the OTA's members see it: `domain.verified`, `domain.failed` (both PBE-050) and
//   `domain.removed` (PBE-051, the platform admin's removal; PADR-0013 item 5, note of 2026-11-03).
// - **DomainChecksProcessor** (worker only, DomainsModule.forWorker()) is the queue's one processor (BullMQ hands any
//   job of a queue to any of its workers): `domain.verify` runs DomainVerification, `domain.recheck` DomainRecheck and
//   `domain.tls_probe` DomainTlsProbe; any other name or invalid data ends at once (UnrecoverableError). A database
//   failure fails the job and BullMQ tries again (ADR-0009: 5 attempts, backoff from 30 s); a DNS failure is no job
//   failure but the `dns_timeout` outcome, and a TLS failure the `failed` outcome, which the next run asks again.
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UnrecoverableError, type Job, type JobsOptions, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { MEMBER_VISIBLE_TENANT_STATUSES } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { PLATFORM_QUEUE, platformWorkerOptions } from "../common/queues/queue-names";
import { afterCommit, InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { redisKeys } from "../common/redis/redis-keys";
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
import { DomainTlsProbe, type DomainTlsProbeResult } from "./tls-probe";

/** The jobs of `platform-domains` (architecture §5). */
export const DOMAIN_VERIFY_JOB = "domain.verify";
export const DOMAIN_RECHECK_JOB = "domain.recheck";
export const DOMAIN_TLS_PROBE_JOB = "domain.tls_probe";

/** Every job name of the queue. */
export const DOMAIN_JOB_NAMES: readonly string[] = Object.freeze([
  DOMAIN_VERIFY_JOB,
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

/** Consecutive failed daily re-checks that fail a verified domain (PADR-0004 item 5). */
export const RECHECK_FAILURE_LIMIT = 3;

/** The owners' e-mails (PADR-0013 item 5 and its note of 2026-11-03). */
export const DOMAIN_VERIFIED_TEMPLATE = "domain.verified";
export const DOMAIN_FAILED_TEMPLATE = "domain.failed";
export const DOMAIN_REMOVED_TEMPLATE = "domain.removed";

/** A domain e-mail's template. */
export type DomainTemplate =
  typeof DOMAIN_VERIFIED_TEMPLATE | typeof DOMAIN_FAILED_TEMPLATE | typeof DOMAIN_REMOVED_TEMPLATE;

/** The `failure` sentence of `domain.failed`: why the domain failed, after "<host> is marked as failed for …:". */
export const DOMAIN_FAILURE_TEXT = Object.freeze({
  window: "Velexis could not verify its DNS records within 72 hours.",
  recheck:
    "Velexis checks the DNS records of verified domains every day, and they failed three checks in a row. If it was " +
    "the primary address of your storefront, your Velexis sub-domain is the primary address again.",
});

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

/** Where a TLS probe goes: when (`delay`, none for at once) and under which job id (none for a new one). */
export interface TlsProbeJobOptions {
  readonly delay?: number;
  readonly jobId?: string;
}

/** The logger lines of forgetTlsAsk. */
interface WarnLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * Deletes the cached positive `ask` answer of a host that is no longer served (PADR-0004 item 6), besides the `domain`
 * invalidation that the API's subscriber also turns into this deletion. Redis is a cache here: a failure is logged and
 * the change stands (the key expires within 60 s anyway).
 */
export async function forgetTlsAsk(
  redis: Pick<Redis, "del">,
  hostname: string,
  logger: WarnLogger,
): Promise<void> {
  try {
    await redis.del(redisKeys.tlsAsk(hostname).key);
  } catch (error) {
    logger.warn({ err: error }, "domains.tls_ask_forget_failed");
  }
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

  /** Queues `domain.recheck` for the domain; `jobId` (the daily run's) makes a second add of the same run a no-op. */
  enqueueRecheck(domainId: string, jobId?: string): Promise<boolean> {
    return this.enqueue(DOMAIN_RECHECK_JOB, domainId, jobId === undefined ? {} : { jobId });
  }

  /** Queues `domain.tls_probe` for the domain: at once, or `delay` milliseconds from now (file header). */
  enqueueTlsProbe(domainId: string, options: TlsProbeJobOptions = {}): Promise<boolean> {
    return this.enqueue(DOMAIN_TLS_PROBE_JOB, domainId, {
      ...(options.delay === undefined ? {} : { delay: options.delay }),
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    });
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

/** The domain an owners' e-mail is about. */
export interface NoticeDomain {
  readonly id: string;
  readonly tenant_id: string;
  readonly hostname: string;
}

@Injectable()
export class DomainOwnerNotices {
  constructor(
    private readonly domains: DomainsRepository,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Queues `template` to every active owner of the domain's OTA in `trx`, once per owner and `occasion` (part of the
   * idempotency key: the verification window, the verification, the removal), while the OTA's members see it;
   * otherwise nothing. The data are the owner's name, the OTA's name and key, the host, `extra` and the link to the
   * portal's domains page.
   */
  async queue(
    trx: PlatformTransaction,
    domain: NoticeDomain,
    template: DomainTemplate,
    extra: Readonly<Record<string, string>>,
    occasion: string,
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
        idempotencyKey: `${template}:${domain.id}:${occasion}`,
      });
    }
  }
}

/** The CNAME target and storefront addresses of this deployment, which both DNS jobs check against. */
function routingTargetsOf(config: ConfigService<PlatformBackendConfig, true>): {
  readonly baseDomain: string;
  readonly addresses: StorefrontAddressSet;
} {
  return {
    baseDomain: config.get("STOREFRONT_BASE_DOMAIN", { infer: true }),
    addresses: {
      ipv4: config.get("STOREFRONT_IPV4", { infer: true }),
      ipv6: config.get("STOREFRONT_IPV6", { infer: true }),
    },
  };
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
    private readonly notices: DomainOwnerNotices,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(DNS_RESOLVER) private readonly resolver: DnsResolver,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(DomainVerification.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    ({ baseDomain: this.baseDomain, addresses: this.addresses } = routingTargetsOf(config));
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
      actorLabel: DOMAIN_VERIFY_JOB,
      action: "domain.verified",
      targetType: "domain",
      targetId: domain.id,
      tenantId: domain.tenant_id,
      before: { verificationStatus: domain.verification_status },
      after: { verificationStatus: "verified" },
      details: { hostname: domain.hostname, routing },
    });
    await this.notices.queue(trx, domain, DOMAIN_VERIFIED_TEMPLATE, {}, windowOf(domain));
    this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: domain.hostname });
    afterCommit(trx, async () => {
      if (!(await this.jobs.enqueueTlsProbe(domain.id, { delay: TLS_PROBE_DELAY_MS }))) {
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
      actorLabel: DOMAIN_VERIFY_JOB,
      action: "domain.verification_failed",
      targetType: "domain",
      targetId: domain.id,
      tenantId: domain.tenant_id,
      before: { verificationStatus: domain.verification_status },
      after: { verificationStatus: "failed", lastCheckError: result.error },
      details: { hostname: domain.hostname, verificationDeadlineAt: deadline.toISOString() },
    });
    await this.notices.queue(
      trx,
      domain,
      DOMAIN_FAILED_TEMPLATE,
      { failure: DOMAIN_FAILURE_TEXT.window, reason: DNS_CHECK_ERROR_TEXT[result.error] },
      windowOf(domain),
    );
    this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: domain.hostname });
    return { domainId: domain.id, status: "failed", checked: true, error: result.error };
  }
}

/** The verification window of a domain, the occasion of its window's e-mails (one per owner and window). */
function windowOf(domain: DomainCheckRow): string {
  return domain.verification_deadline_at?.toISOString() ?? "none";
}

/** What a finished `domain.recheck` job returns (BullMQ keeps it): ids, statuses, counts and codes, never a token. */
export interface DomainRecheckResult {
  readonly domainId: string;
  /**
   * The domain's status after the job: `verified`, or `failed` at the third failure; the status found when the job
   * left the domain alone (`pending`, `failed`, or `missing` when it was gone), and `superseded` when the domain was
   * removed or changed while DNS was asked (nothing written).
   */
  readonly status: string;
  /** False when the job left the domain alone. */
  readonly checked: boolean;
  /** The consecutive failed re-checks after this one. */
  readonly checkFailures?: number;
  /** The error code of a failed check. */
  readonly error?: DnsCheckError;
  /** The sub-domain that became primary again when the failed domain was primary. */
  readonly primaryHostname?: string;
}

@Injectable()
export class DomainRecheck {
  private readonly baseDomain: string;
  private readonly addresses: StorefrontAddressSet;

  constructor(
    private readonly domains: DomainsRepository,
    private readonly audit: AuditService,
    private readonly notices: DomainOwnerNotices,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(DNS_RESOLVER) private readonly resolver: DnsResolver,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectPinoLogger(DomainRecheck.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    ({ baseDomain: this.baseDomain, addresses: this.addresses } = routingTargetsOf(config));
  }

  /** One `domain.recheck` job (see the file header). */
  async recheck(domainId: string): Promise<DomainRecheckResult> {
    const row = await this.domains.findForCheck(domainId);
    if (
      row === undefined ||
      row.kind !== "custom" ||
      row.verification_status !== "verified" ||
      row.verification_token === null
    ) {
      const status = row?.verification_status ?? "missing";
      this.logger.info({ domainId, status }, "domains.recheck_skipped");
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
      // The tenant's domain lock first, as every domain write takes it: the primary flag may move.
      await this.domains.lockTenantDomains(trx, row.tenant_id);
      const current = await this.domains.lockForCheck(trx, domainId);
      if (
        current === undefined ||
        current.verification_status !== "verified" ||
        current.verification_token !== token
      ) {
        return undefined;
      }
      const now = this.clock.now();
      if (result.ok) {
        await this.domains.recordRecheckPassed(trx, current.id, now);
        return {
          domainId,
          status: "verified",
          checked: true,
          checkFailures: 0,
        } satisfies DomainRecheckResult;
      }
      const failures = current.check_failures + 1;
      const failed = failures >= RECHECK_FAILURE_LIMIT;
      await this.domains.recordRecheckFailure(trx, current.id, {
        error: result.error,
        failures,
        failed,
        now,
      });
      if (!failed) {
        return {
          domainId,
          status: "verified",
          checked: true,
          checkFailures: failures,
          error: result.error,
        } satisfies DomainRecheckResult;
      }
      return this.failVerified(trx, current, result.error, failures, now);
    });
    if (outcome === undefined) {
      this.logger.info({ domainId, tenantId: row.tenant_id }, "domains.recheck_superseded");
      return { domainId, status: "superseded", checked: false };
    }
    this.logger.info(
      {
        domainId,
        tenantId: row.tenant_id,
        status: outcome.status,
        checkFailures: outcome.checkFailures,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      },
      outcome.status === "failed"
        ? "domains.recheck_failed"
        : outcome.error === undefined
          ? "domains.rechecked"
          : "domains.recheck_check_failed",
    );
    return outcome;
  }

  /**
   * The third consecutive failure: the domain is `failed` (written by the caller) and the sub-domain primary again when
   * it was primary; audited, the owners told, the invalidations and the `ask` cache deletion after the commit.
   */
  private async failVerified(
    trx: PlatformTransaction,
    domain: DomainCheckRow,
    error: DnsCheckError,
    failures: number,
    now: Date,
  ): Promise<DomainRecheckResult> {
    const promoted = domain.is_primary
      ? await this.domains.lockSubdomain(trx, domain.tenant_id, domain.purpose)
      : undefined;
    if (promoted !== undefined) {
      await this.domains.setPrimary(trx, promoted.id, true, now);
    }
    await this.audit.record(trx, {
      actorType: "system",
      actorLabel: DOMAIN_RECHECK_JOB,
      action: "domain.recheck_failed",
      targetType: "domain",
      targetId: domain.id,
      tenantId: domain.tenant_id,
      before: { verificationStatus: domain.verification_status, isPrimary: domain.is_primary },
      after: {
        verificationStatus: "failed",
        isPrimary: false,
        lastCheckError: error,
        checkFailures: failures,
      },
      details: {
        hostname: domain.hostname,
        ...(promoted === undefined ? {} : { primaryHostname: promoted.hostname }),
      },
    });
    await this.notices.queue(
      trx,
      domain,
      DOMAIN_FAILED_TEMPLATE,
      { failure: DOMAIN_FAILURE_TEXT.recheck, reason: DNS_CHECK_ERROR_TEXT[error] },
      `recheck:${domain.verified_at?.toISOString() ?? "none"}`,
    );
    this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: domain.hostname });
    if (promoted !== undefined) {
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: promoted.hostname });
    }
    afterCommit(trx, () => forgetTlsAsk(this.redis, domain.hostname, this.logger));
    return {
      domainId: domain.id,
      status: "failed",
      checked: true,
      checkFailures: failures,
      error,
      ...(promoted === undefined ? {} : { primaryHostname: promoted.hostname }),
    };
  }
}

@Processor(PLATFORM_QUEUE.domains, platformWorkerOptions(PLATFORM_QUEUE.domains))
export class DomainChecksProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly verification: DomainVerification,
    private readonly recheck: DomainRecheck,
    private readonly probe: DomainTlsProbe,
    @InjectPinoLogger(DomainChecksProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<DomainVerifyResult | DomainRecheckResult | DomainTlsProbeResult> {
    if (!DOMAIN_JOB_NAMES.includes(job.name)) {
      throw new UnrecoverableError(`${PLATFORM_QUEUE.domains} has no job named ${loggableJobName(job.name)}`);
    }
    const domainId = domainIdOf(job.data);
    if (domainId === undefined) {
      throw new UnrecoverableError(`${job.name} needs { domainId: dom_… } and nothing else`);
    }
    switch (job.name) {
      case DOMAIN_RECHECK_JOB:
        return this.recheck.recheck(domainId);
      case DOMAIN_TLS_PROBE_JOB:
        return this.probe.probe(domainId);
      default:
        return this.verification.verify(domainId);
    }
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
