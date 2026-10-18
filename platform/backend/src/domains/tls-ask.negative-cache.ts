// The in-process cache of the TLS `ask` endpoint's refusals (PADR-0004 item 6, PBE-027). Caddy's catch-all `https://`
// site sends every unknown SNI name to `ask`, and Caddy 2.8 has no rate limit for on-demand TLS, so the refusals of
// well-formed hosts that no OTA serves stay here, never in Redis: the shared Redis runs with `noeviction` and BullMQ
// needs it, so random names in TLS handshakes must not cost it any memory. Positive answers go to Redis
// (`tlsask:<host>`, tls-ask.service.ts).
//
// A bounded LRU of at most MAX entries, each living TTL_MS from when it was added (the Clock's time). A hit moves the
// host to the most recently used end; adding a host past the bound drops the least recently used one first, so the
// cache never holds more than MAX hosts, whatever the flood. The `vx:invalidate` subscriber (through TlsAskService)
// deletes the hosts of a changed domain or tenant, so a newly verified domain or a tenant whose status changed is not
// refused for the rest of the minute. Malformed hosts never get here: they are refused before any cache or database
// access.
import { Injectable } from "@nestjs/common";
import { Clock } from "../common/clock";

/** How many refused hosts the cache holds at most (PADR-0004 item 6). */
export const TLS_ASK_NEGATIVE_CACHE_MAX_ENTRIES = 10_000;
/** How long a refusal is remembered, in milliseconds (PADR-0004 item 6). */
export const TLS_ASK_NEGATIVE_CACHE_TTL_MS = 60_000;

@Injectable()
export class TlsAskNegativeCache {
  /** The refused hosts with the epoch milliseconds their entry ends, least recently used first (Map order). */
  private readonly entries = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  /** How many hosts the cache holds now (expired entries not yet dropped included). */
  get size(): number {
    return this.entries.size;
  }

  /** True when `host` was refused less than TTL_MS ago; a hit makes it the most recently used host. */
  has(host: string): boolean {
    const expiresAt = this.entries.get(host);
    if (expiresAt === undefined) {
      return false;
    }
    this.entries.delete(host);
    if (expiresAt <= this.clock.now().getTime()) {
      return false;
    }
    this.entries.set(host, expiresAt);
    return true;
  }

  /** Remembers the refusal of `host` for TTL_MS, dropping the least recently used hosts past the bound. */
  add(host: string): void {
    this.entries.delete(host);
    while (this.entries.size >= TLS_ASK_NEGATIVE_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.entries.delete(oldest.value);
    }
    this.entries.set(host, this.clock.now().getTime() + TLS_ASK_NEGATIVE_CACHE_TTL_MS);
  }

  /** Forgets the refusal of `host`; true when there was one. */
  delete(host: string): boolean {
    return this.entries.delete(host);
  }
}
