import { Injectable } from "@nestjs/common";

/**
 * The current time (platform/docs/architecture.md §2.1, CommonModule). Services inject it instead of calling
 * `new Date()` or `Date.now()`, so tests control time (conventions §2, "Time and randomness"): `createTestApp`
 * (test/support/app.ts) provides the `FakeClock` of `@velexis/testing` in its place. Times are UTC instants;
 * formatting in a time zone happens only in the portal and the admin.
 */
@Injectable()
export class Clock {
  /** A new `Date` for the current instant. */
  now(): Date {
    return new Date();
  }
}
