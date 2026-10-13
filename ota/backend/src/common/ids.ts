import { Injectable } from "@nestjs/common";
import { newId as newPrefixedId, type IdPrefix } from "@velexis/crypto";
import { Clock } from "./clock";

/**
 * A new application id `"<prefix>_<ULID>"` (`bkg_01J…`, db README §2.1): 2 to 4 lower-case letters, checked at
 * compile time and at run time, then a ULID with 80 fresh CSPRNG bits (`@velexis/crypto`, X-005). `now` sets the
 * timestamp part; services use `IdGenerator`, which takes it from the injected `Clock`.
 */
export function newId<P extends string>(prefix: IdPrefix<P>, now?: Date): string {
  return newPrefixedId(prefix, now);
}

/**
 * The injectable id generator (conventions §2): ids get their timestamp from `Clock`, so they sort with the
 * `created_at` values written by the same service, and tests that fake the clock get predictable id prefixes.
 */
@Injectable()
export class IdGenerator {
  constructor(private readonly clock: Clock) {}

  /** A new `"<prefix>_<ULID>"` id stamped with `Clock.now()`. */
  newId<P extends string>(prefix: IdPrefix<P>): string {
    return newPrefixedId(prefix, this.clock.now());
  }
}
