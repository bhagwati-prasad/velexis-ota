import { Injectable } from "@nestjs/common";

/**
 * The current time. Services inject it instead of calling `new Date()` or `Date.now()`, so tests control time
 * (docs/mvp/conventions.md §2, "Time and randomness"); a test module provides `{ provide: Clock, useValue: fake }`.
 * Times are UTC instants; formatting in a time zone happens only in views.
 */
@Injectable()
export class Clock {
  /** A new `Date` for the current instant. */
  now(): Date {
    return new Date();
  }
}
