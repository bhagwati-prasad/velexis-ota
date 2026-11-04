// The storefront hosts in the platform admin (PBE-051; platform/docs/api-inventory-admin.md §7 domain rows,
// flows/custom-domains.md step 8, flows/platform-admin-operations.md §G, PADR-0004, PADR-0006, scope PF-92). Who may
// call is AdminAuthGuard's (`x-scope: platform_admin`); the `reason` of the removal arrives trimmed and checked (5–500
// characters) from the request validation (FIX-W35-PLATFORM). This service owns the transactions, their audit rows and
// the work after the commit (architecture §4); the admin never touches tenant schemas.
//
// - `adminListDomains` (`list`): every storefront host of every OTA in any status, the Velexis sub-domains and the
//   custom domains, newest first (then by id), filtered by kind, DNS verification status and TLS status, with the OTA's
//   id and key, the last DNS check and TLS probe and the count of consecutive failed re-checks. The cursor is the last
//   host of the page (`400 VALIDATION_FAILED` on `/query/cursor` for one that names no host). Not audited: it holds no
//   personal data or secret.
// - `adminRecheckDomain` (`recheck`): queues the checks of one host now (DomainJobs) instead of waiting for the
//   schedules: the DNS check of a custom domain by its status (`domain.verify` for a pending one, `domain.recheck`, the
//   daily re-check, for a verified one; a failed one has none: its owner restarts its window with "Check now"), and
//   the TLS probe of the host at once (the sub-domain has no DNS records, so it gets the probe only). The jobs are the
//   whole effect: one that cannot be queued answers `503 SERVICE_UNAVAILABLE` (the others stay queued); otherwise the
//   audit row `domain.recheck_requested` (the host and the jobs) is written and `202` answered before the jobs run. A
//   verified domain's re-check always runs DNS, also after the day's 04:10 run (FIX-W41-PLATFORM, lead decision (2b)
//   of 2026-11-04, which replaces the shared daily job id of FIX-W40-PLATFORM's decision (2f)): its `domain.recheck`
//   has a job id of its own, the domain and the Clock's slot of ADMIN_RECHECK_SLOT_MS (`adminRecheckJobId`), so a
//   double click within the slot adds one job, not two (a click on each side of a slot's end adds a second, which the
//   strike rule keeps harmless), and each later click adds one. The job counts like a daily one, but a failure adds a
//   strike only when none was counted that UTC day, and a pass resets the count (domain-checks.processor.ts,
//   `strikeCountedOn`), so quick repeated clicks cannot fail a domain; the TLS probe is queued each time. Nothing is
//   published here: the jobs publish what they change.
// - `adminRemoveDomain` (`remove`): an abusive custom domain of any OTA, whatever the OTA's status, with a reason. As
//   the portal's `removeDomain` does (domains.service.ts), in one transaction under the tenant's domain lock: the row
//   is deleted and, when it was primary, the sub-domain becomes primary again; the audit row `domain.removed` (actor
//   `platform_admin`) keeps the reason, the host, its status and the primary flag; every active owner gets
//   `domain.removed` while the OTA's members see it (PADR-0013 item 5, note of 2026-11-03; the reason stays in the
//   audit trail and out of the e-mail). After the commit the `domain` invalidations of the host (and of the sub-domain
//   when the flag moved) are published and the cached `tlsask:<host>` answer is deleted, so neither the storefront nor
//   the TLS gate serves the host any more; the host name is free for an OTA that proves ownership. The sub-domain
//   cannot be removed (`409 CONFLICT`, `details.reason = "subdomain"`); an unknown host answers `404 NOT_FOUND`.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { afterCommit, InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import {
  DOMAIN_RECHECK_JOB,
  DOMAIN_REMOVED_TEMPLATE,
  DOMAIN_TLS_PROBE_JOB,
  DOMAIN_VERIFY_JOB,
  DomainJobs,
  DomainOwnerNotices,
  forgetTlsAsk,
} from "./domain-checks.processor";
import { DomainsRepository, type AdminDomainRow } from "./domains.repository";

export type AdminDomain = components["schemas"]["AdminDomain"];
export type AdminDomainList = components["schemas"]["AdminDomainList"];

/** The validated query of `adminListDomains`. */
export interface ListAdminDomainsQuery {
  readonly kind?: string | undefined;
  readonly verificationStatus?: string | undefined;
  readonly tlsStatus?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The page size without `limit` (the document's default). */
export const DEFAULT_ADMIN_DOMAIN_PAGE_LIMIT = 50;

/** The slot in which a platform admin's re-checks of one verified domain share one DNS check: 10 s of the Clock. */
export const ADMIN_RECHECK_SLOT_MS = 10_000;

/**
 * The BullMQ job id of a platform admin's DNS re-check of the verified domain `domainId` at `now`:
 * `domain.recheck.admin.<domainId>.<slot>`, never the daily run's id (`dailyJobId`, recheck.scheduler.ts), and no `:`,
 * which BullMQ refuses in ids. Two clicks in one slot share the job; completed jobs are kept a day (ADR-0009 item 7).
 */
export function adminRecheckJobId(domainId: string, now: Date): string {
  return `${DOMAIN_RECHECK_JOB}.admin.${domainId}.${Math.floor(now.getTime() / ADMIN_RECHECK_SLOT_MS)}`;
}

/** The occasion of the removal e-mail: one per owner and removed domain. */
const REMOVAL_OCCASION = "removed";

const DOMAIN_ID = /^dom_[0-9A-HJKMNP-TV-Z]{26}$/;

/** An opaque cursor: base64url of `{"id": "<domain id>"}`, the last host of the page. */
export function encodeDomainCursor(domainId: string): string {
  return Buffer.from(JSON.stringify({ id: domainId }), "utf8").toString("base64url");
}

/** The domain id of a cursor of the admin's list, or `undefined` when it is not one. */
export function decodeDomainCursor(cursor: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const id: unknown = (value as Record<string, unknown>)["id"];
    return Object.keys(value).length === 1 && typeof id === "string" && DOMAIN_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function invalidCursor(): AppError<"VALIDATION_FAILED"> {
  return new AppError("VALIDATION_FAILED", {
    fieldErrors: [{ path: "/query/cursor", code: "cursor", message: "Is not a cursor of this list." }],
  });
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The `AdminDomain` of the OpenAPI document for a host of any OTA. */
export function toAdminDomain(row: AdminDomainRow): AdminDomain {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantKey: row.tenant_key,
    hostname: row.hostname,
    kind: row.kind as AdminDomain["kind"],
    purpose: row.purpose as AdminDomain["purpose"],
    isPrimary: row.is_primary,
    verificationStatus: row.verification_status as AdminDomain["verificationStatus"],
    verifiedAt: iso(row.verified_at),
    verificationDeadlineAt: iso(row.verification_deadline_at),
    lastCheckedAt: iso(row.last_checked_at),
    lastCheckError: row.last_check_error,
    checkFailures: row.check_failures,
    tlsStatus: row.tls_status as AdminDomain["tlsStatus"],
    tlsExpiresAt: iso(row.tls_expires_at),
    tlsCheckedAt: iso(row.tls_checked_at),
    createdAt: row.created_at.toISOString(),
  };
}

/** The jobs an admin's re-check queues for a host (see the file header), in the order they are queued. */
export function recheckJobsOf(domain: Pick<AdminDomainRow, "kind" | "verification_status">): string[] {
  const jobs: string[] = [];
  if (domain.kind === "custom" && domain.verification_status === "pending") {
    jobs.push(DOMAIN_VERIFY_JOB);
  }
  if (domain.kind === "custom" && domain.verification_status === "verified") {
    jobs.push(DOMAIN_RECHECK_JOB);
  }
  jobs.push(DOMAIN_TLS_PROBE_JOB);
  return jobs;
}

@Injectable()
export class AdminDomainsService {
  constructor(
    private readonly domains: DomainsRepository,
    private readonly jobs: DomainJobs,
    private readonly notices: DomainOwnerNotices,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectPinoLogger(AdminDomainsService.name) private readonly logger: PinoLogger,
  ) {}

  /** `adminListDomains` (see the file header). */
  async list(query: ListAdminDomainsQuery): Promise<AdminDomainList> {
    const limit = query.limit ?? DEFAULT_ADMIN_DOMAIN_PAGE_LIMIT;
    let afterDomainId: string | undefined;
    if (query.cursor !== undefined) {
      afterDomainId = decodeDomainCursor(query.cursor);
      if (afterDomainId === undefined || !(await this.domains.domainExists(afterDomainId))) {
        throw invalidCursor();
      }
    }
    const rows = await this.domains.listForAdmin(
      { kind: query.kind, verificationStatus: query.verificationStatus, tlsStatus: query.tlsStatus },
      afterDomainId,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toAdminDomain),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodeDomainCursor(last.id) : null,
        limit,
      },
    };
  }

  /** `adminRecheckDomain` (see the file header). */
  async recheck(claims: Pick<AccessTokenClaims, "sub">, domainId: string): Promise<void> {
    const domain = await this.domains.findForAdmin(domainId);
    if (domain === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const jobs = recheckJobsOf(domain);
    let queued = true;
    for (const job of jobs) {
      const added =
        job === DOMAIN_VERIFY_JOB
          ? await this.jobs.enqueueVerify(domain.id)
          : job === DOMAIN_RECHECK_JOB
            ? // A job id of its own, not the daily run's: DNS always runs (file header).
              await this.jobs.enqueueRecheck(domain.id, adminRecheckJobId(domain.id, this.clock.now()))
            : await this.jobs.enqueueTlsProbe(domain.id);
      queued &&= added;
    }
    if (!queued) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }
    await runInTransaction(this.db, async (trx) => {
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "domain.recheck_requested",
        targetType: "domain",
        targetId: domain.id,
        tenantId: domain.tenant_id,
        details: { hostname: domain.hostname, jobs },
      });
    });
  }

  /** `adminRemoveDomain` (see the file header). */
  async remove(claims: Pick<AccessTokenClaims, "sub">, domainId: string, reason: string): Promise<void> {
    const found = await this.domains.findForAdmin(domainId);
    if (found === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const now = this.clock.now();
    await runInTransaction(this.db, async (trx) => {
      // The tenant's domain lock first, as every domain write takes it, then the row.
      await this.domains.lockTenantDomains(trx, found.tenant_id);
      const domain = await this.domains.lockForCheck(trx, domainId);
      if (domain === undefined) {
        throw new AppError("NOT_FOUND");
      }
      if (domain.kind !== "custom") {
        throw new AppError("CONFLICT", { details: { reason: "subdomain" } });
      }
      await this.domains.delete(trx, domain.id);
      const promoted = domain.is_primary
        ? await this.domains.lockSubdomain(trx, domain.tenant_id, domain.purpose)
        : undefined;
      if (promoted !== undefined) {
        await this.domains.setPrimary(trx, promoted.id, true, now);
      }
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "domain.removed",
        targetType: "domain",
        targetId: domain.id,
        tenantId: domain.tenant_id,
        before: {
          hostname: domain.hostname,
          verificationStatus: domain.verification_status,
          isPrimary: domain.is_primary,
        },
        details: {
          reason,
          ...(promoted === undefined ? {} : { primaryHostname: promoted.hostname }),
        },
      });
      await this.notices.queue(trx, domain, DOMAIN_REMOVED_TEMPLATE, {}, REMOVAL_OCCASION);
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: domain.hostname });
      if (promoted !== undefined) {
        this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: promoted.hostname });
      }
      afterCommit(trx, () => forgetTlsAsk(this.redis, domain.hostname, this.logger));
    });
  }
}
