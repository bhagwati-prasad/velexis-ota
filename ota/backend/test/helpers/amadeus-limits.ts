// The Amadeus client's buckets of integration files whose journeys make many Amadeus calls for one tenant, one after
// the other (searches, prices, bookings, order reads and updates). They run faster than the tenant bucket's 10-call
// burst refills on a fast runner, and an empty bucket answers the next call `429 RATE_LIMITED` before Amadeus is
// called (CI run 41018342931: the second pricing of pricing-rules.int.test.ts). These buckets hold enough for a whole
// file; the buckets themselves are the subject of rate-limiter.test.ts and client.int.test.ts (limits.ts: tests pass
// their own). Give the module to the API graph and, when the file starts one, to the worker graph too: both
// processes share the buckets' state in Redis.
//
//   api = await createTestApp({ database: db, redis, imports: [journeyAmadeusLimitsModule()] });
import { Global, Module, type DynamicModule } from "@nestjs/common";
import { AMADEUS_LIMITS, DEFAULT_AMADEUS_LIMITS, type AmadeusLimits } from "../../src/amadeus/limits";

/** The default limits with buckets that a whole integration file cannot empty. */
export const JOURNEY_AMADEUS_LIMITS: AmadeusLimits = Object.freeze({
  ...DEFAULT_AMADEUS_LIMITS,
  credentialBucket: Object.freeze({ ratePerSecond: 20, burst: 500 }),
  tenantBucket: Object.freeze({ ratePerSecond: 5, burst: 500 }),
});

/** A global module that provides JOURNEY_AMADEUS_LIMITS to the Amadeus client and rate limiter of one graph. */
export function journeyAmadeusLimitsModule(): DynamicModule {
  @Global()
  @Module({})
  class JourneyAmadeusLimitsModule {}
  return {
    module: JourneyAmadeusLimitsModule,
    providers: [{ provide: AMADEUS_LIMITS, useValue: JOURNEY_AMADEUS_LIMITS }],
    exports: [AMADEUS_LIMITS],
    global: true,
  };
}
