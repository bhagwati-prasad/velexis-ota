// `offers.purge` (OBE-024; OADR-0002 point 6, OADR-0014 points 2 and 5, ota/docs/architecture.md §6, db README §6):
// every 15 minutes, per tenant (`active` and `suspended`; jobs/schedulers.ts fans it out), one job deletes the
// tenant's expired searches in batches of 500 (jobs/limits.ts). PostgreSQL cascades each delete to the search's offers
// (search results and upsold offers carry its `search_id`), its upsells and the priced offers of those offers; child
// priced offers lose their `parent_priced_offer_id` (SET NULL), `supplier_requests` their `search_id`.
//
// A search past its `expires_at` is kept while one of its priced offers
//
//   - backs a checkout (`checkouts.priced_offer_id` or `base_priced_offer_id`, both `ON DELETE RESTRICT`), as OADR-0002
//     point 6 says: a checkout in progress is never broken; or
//   - has not expired yet: a priced offer lives `min(now + offer_ttl_minutes, end of lastTicketingDate)` from its own
//     pricing (OADR-0002 point 3), so it may outlive its search by up to the TTL, and flights.getPricedOffer and
//     checkout.create read it until its own `expires_at`.
//
// One statement per job, in the tenant's transaction: the batch is chosen oldest first by the `expires_at` index and
// locked with `FOR UPDATE SKIP LOCKED`, so two purge jobs of one tenant (a new run while a continuation still runs)
// delete different searches instead of waiting for each other. A checkout created between the choice and the delete
// makes the RESTRICT foreign key refuse the statement: the job fails, BullMQ tries it again, and the next attempt
// keeps that search. A full batch asks the runner for more (fan-out.ts re-enqueues the job). The job logs
// `offers.purged` with the count when it deleted anything, never an id of a search or a customer.
import { Injectable } from "@nestjs/common";
import { sql } from "@velexis/db";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { TenantJob, type TenantJobHandler, type TenantJobOutcome } from "../jobs/fan-out";
import { JOB_BATCH_LIMITS } from "../jobs/limits";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";

/** The schedule and job name (jobs/schedulers.ts). */
export const OFFERS_PURGE_JOB = "offers.purge";

/**
 * Deletes at most `limit` expired searches of the transaction's tenant that no checkout and no unexpired priced offer
 * holds (see the file header), oldest first, and resolves to the ids it deleted.
 */
export async function purgeExpiredSearches(
  trx: TenantTransaction,
  now: Date,
  limit: number,
): Promise<string[]> {
  const batch = trx
    .selectFrom("flight_searches as s")
    .select("s.id")
    .where("s.expires_at", "<=", now)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("flight_offers as o")
            .innerJoin("priced_offers as p", "p.offer_id", "o.id")
            .select(sql<number>`1`.as("held"))
            .whereRef("o.search_id", "=", "s.id")
            .where((held) =>
              held.or([
                held("p.expires_at", ">", now),
                held.exists(
                  held
                    .selectFrom("checkouts as c")
                    .select(sql<number>`1`.as("checkout"))
                    .where((checkout) =>
                      checkout.or([
                        checkout("c.priced_offer_id", "=", checkout.ref("p.id")),
                        checkout("c.base_priced_offer_id", "=", checkout.ref("p.id")),
                      ]),
                    ),
                ),
              ]),
            ),
        ),
      ),
    )
    .orderBy("s.expires_at")
    .orderBy("s.id")
    .limit(limit)
    .forUpdate("s")
    .skipLocked();
  const deleted = await trx.deleteFrom("flight_searches").where("id", "in", batch).returning("id").execute();
  return deleted.map((row) => row.id);
}

/** What one run deleted: the count of searches (their offers, upsells and priced offers went with them). */
export interface OffersPurgeCounts extends Readonly<Record<string, number>> {
  readonly searches: number;
}

@Injectable()
@TenantJob(OFFERS_PURGE_JOB)
export class OffersPurgeProcessor implements TenantJobHandler {
  constructor(
    private readonly tx: TenantTx,
    private readonly clock: Clock,
    @InjectPinoLogger(OffersPurgeProcessor.name) private readonly logger: PinoLogger,
  ) {}

  /** One batch for the job's tenant (the runner opened its context); a full batch asks for more. */
  async run(tenant: PlatformTenant): Promise<TenantJobOutcome> {
    const now = this.clock.now();
    const limit = JOB_BATCH_LIMITS.searchPurge;
    const deleted = await this.tx.run((trx) => purgeExpiredSearches(trx, now, limit));
    const counts: OffersPurgeCounts = { searches: deleted.length };
    if (deleted.length > 0) {
      this.logger.info({ tenantId: tenant.id, ...counts }, "offers.purged");
    }
    return { more: deleted.length >= limit, counts };
  }
}
