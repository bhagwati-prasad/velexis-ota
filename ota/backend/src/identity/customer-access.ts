// Whether the customer of a valid access token may still act (FIX-W29-SECURITY; lead decision (1) of 2026-10-24,
// ADR-0008 "Access tokens" and its dated note, ota/docs/architecture.md §7 `cust`). Access tokens stay stateless for
// their 15 minutes, except for one fact about their customer: a customer that was deleted (account.delete) or disabled
// may no longer hold a session (`mayHoldSession`: `active` or `pending_verification`, no `deleted_at`), and the
// customer guard refuses its token on every customer-scope operation with `401 UNAUTHENTICATED`, as account.* answers
// (OBE-035). The check is cheap: one Redis `GET` of `t:<tenantId>:<env>:cust:<customerId>` per request, a database read
// at most once a minute per customer, in the manner of OADR-0011's staff checks (revocation keys and a membership read
// cached for 60 s):
//
//   `1`      the database said, at most CUSTOMER_ACCESS_TTL_SECONDS ago, that the customer may hold a session: allowed;
//   none     read the customer (`SessionsRepository.findSessionCustomer`, no lock); allowed or refused by it, and an
//            allowed customer is cached as `1` with `SET … NX`, so it never overwrites a revocation;
//   `0`      revoked (`revoke`): read the customer on every request while it lives, and cache nothing over it;
//   error    Redis cannot answer: read the customer, cache nothing (architecture §10: a check that cannot use Redis falls
//            back to PostgreSQL instead of skipping it).
//
// `revoke` writes `0` for both environments of the tenant (a customer belongs to the tenant, and its tokens are not
// bound to an environment), after the commit of the change that took the customer's sessions away: account.delete and
// any path that disables a customer. A `1` written before the revocation is overwritten by it, and one that a guard
// read from the database before the commit and writes afterwards finds the `0` and is not written (`NX`), so no cached
// `1` outlives the revocation. A customer disabled by a path that does not revoke (by hand in the database) is refused
// within CUSTOMER_ACCESS_TTL_SECONDS. A revocation that Redis cannot store is logged and never fails its change: the
// change committed, and a cached `1` lives at most a minute.
//
// Ids only in the log lines: never a token or an address.
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { redisKeys, type KeyEnvironment } from "../common/redis/redis.keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx } from "../tenancy/tenant-tx";
import { SessionsRepository } from "./sessions.repository";
import { mayHoldSession } from "./sessions.service";

/** The value of the key while the database's last answer was "may act". */
export const CUSTOMER_ACCESS_ALLOWED = "1";
/** The value of the key after a revocation: read the database. */
export const CUSTOMER_ACCESS_REVOKED = "0";

/** The environments a revocation covers: every one a token of the customer can be presented in. */
const ENVIRONMENTS: readonly KeyEnvironment[] = ["test", "live"];

/** What the check needs of the command client (`REDIS_CLIENT`). */
export type CustomerAccessRedis = Pick<Redis, "get" | "set" | "multi">;

@Injectable()
export class CustomerAccess {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: CustomerAccessRedis,
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly sessions: SessionsRepository,
    @InjectPinoLogger(CustomerAccess.name) private readonly logger: PinoLogger,
  ) {}

  /** Whether customer `customerId` of the request's tenant may still act (see the file header). */
  async mayAct(customerId: string): Promise<boolean> {
    const { tenantId, environment } = this.tenants.require();
    const key = redisKeys.customerAccess(tenantId, environment, customerId);
    let cached: string | null | undefined;
    try {
      cached = await this.redis.get(key.key);
    } catch (error) {
      this.logger.warn({ customerId, err: error }, "customer.access_cache_unavailable");
    }
    if (cached === CUSTOMER_ACCESS_ALLOWED) {
      return true;
    }
    const allowed = mayHoldSession(
      await this.tx.run((trx) => this.sessions.findSessionCustomer(trx, customerId)),
    );
    if (allowed && cached === null) {
      try {
        await this.redis.set(key.key, CUSTOMER_ACCESS_ALLOWED, "EX", key.ttlSeconds, "NX");
      } catch (error) {
        this.logger.warn({ customerId, err: error }, "customer.access_cache_unavailable");
      }
    }
    return allowed;
  }

  /**
   * Revokes what the guards cached of customer `customerId` of tenant `tenantId`, in both environments: call it after
   * the commit of the change that took the customer's sessions away (see the file header). Never throws.
   */
  async revoke(tenantId: string, customerId: string): Promise<void> {
    try {
      const batch = this.redis.multi();
      for (const environment of ENVIRONMENTS) {
        const key = redisKeys.customerAccess(tenantId, environment, customerId);
        batch.set(key.key, CUSTOMER_ACCESS_REVOKED, "EX", key.ttlSeconds);
      }
      const results = await batch.exec();
      const failed = (results ?? []).find(([error]) => error !== null);
      if (results === null || failed !== undefined) {
        throw failed?.[0] ?? new Error("the revocation's MULTI was discarded");
      }
    } catch (error) {
      this.logger.warn({ customerId, err: error }, "customer.access_revocation_failed");
    }
  }
}
