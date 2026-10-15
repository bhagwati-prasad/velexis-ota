import { Injectable } from "@nestjs/common";
import { newId } from "@velexis/crypto";
import { Clock } from "./clock";

/**
 * The prefixes of the ids the platform backend generates (`"<prefix>_<ULID>"`, conventions §1):
 *
 * - the API's ids, listed in platform/docs/api-inventory.md §2: accounts, tenants, staff (memberships),
 *   invitations, API keys, domains, supplier and payment connections, provisioning jobs, subscriptions,
 *   invoices, settlements, credential submissions, Velexis Amadeus accounts and offices;
 * - the ids of platform rows that the API never shows on their own (the `CHECK (id LIKE '<prefix>\_%')` of the
 *   platform migrations): sessions (`asn`, a session's `familyId`), account tokens (`atk`), settlement lines
 *   (`sln`) and outbox e-mails (`eml`).
 *
 * `stripe_events` ids (`evt_…`) are Stripe's own and are never generated here. A new table with a new prefix adds it
 * here first; `ids.test.ts` compares the list with the inventory and the migrations.
 */
export const PLATFORM_ID_PREFIXES = Object.freeze([
  "acc",
  "ten",
  "stf",
  "ivt",
  "key",
  "dom",
  "sc",
  "ppc",
  "job",
  "sub",
  "inv",
  "stl",
  "crs",
  "ama",
  "amo",
  "asn",
  "atk",
  "sln",
  "eml",
] as const);

/** A prefix of PLATFORM_ID_PREFIXES. */
export type PlatformIdPrefix = (typeof PLATFORM_ID_PREFIXES)[number];

/** A platform id with its prefix: `PlatformId<"ten">` is `` `ten_${string}` ``. */
export type PlatformId<P extends PlatformIdPrefix = PlatformIdPrefix> = `${P}_${string}`;

/** True when `value` is a prefix of PLATFORM_ID_PREFIXES. */
export function isPlatformIdPrefix(value: unknown): value is PlatformIdPrefix {
  return typeof value === "string" && (PLATFORM_ID_PREFIXES as readonly string[]).includes(value);
}

/**
 * The injectable id generator (conventions §2, "Time and randomness"): `ids.new("ten")` is `ten_` followed by a ULID
 * whose timestamp comes from the injected `Clock` (so ids sort with the `created_at` values the same service writes,
 * and tests that fake the clock get predictable timestamps) and whose 80 random bits are fresh from Node's CSPRNG
 * for every id (`newId` of `@velexis/crypto`; never monotonic). Only the prefixes of PLATFORM_ID_PREFIXES compile, and
 * any other value throws a `TypeError` at run time.
 */
@Injectable()
export class IdGenerator {
  constructor(private readonly clock: Clock) {}

  /** A new `"<prefix>_<ULID>"` id stamped with `Clock.now()`. */
  new<P extends PlatformIdPrefix>(prefix: P): PlatformId<P> {
    if (!isPlatformIdPrefix(prefix)) {
      throw new TypeError("IdGenerator.new(): the prefix is not one of PLATFORM_ID_PREFIXES");
    }
    return newId<PlatformIdPrefix>(prefix, this.clock.now()) as PlatformId<P>;
  }
}
