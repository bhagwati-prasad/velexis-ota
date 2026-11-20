// The `ip` tracker of the platform API's rate limits (PBE-009, throttler.config.ts). Every end-user address counts as
// @nestjs/throttler's `normalizeIp(ip, DEFAULT_IPV6_SUBNET_PREFIX)` has it (lead decision (32f) of 2026-11-20): an
// IPv4-mapped address and, since 6.8.0, a NAT64 well-known-prefix address count as their embedded IPv4 address, any
// other IPv6 address for its /64. 6.7.1 counted every NAT64 address for 64:ff9b::/64, one bucket for all the IPv4
// hosts behind NAT64. Documentation addresses only (RFC 5737, RFC 3849; the prefixes of RFC 6052 and RFC 8215).
import { describe, expect, it } from "vitest";
import { BFF_KEY_HEADER, BffKey, END_USER_IP_HEADER, resolveEndUser } from "./end-user";
import { trackerValue } from "./throttler.config";

// The development key of .env.example, a test value only.
const KEY = "dev_bff_key_change_me_0123456789abcdef";
const key = new BffKey(KEY);

/** 192.0.2.1 written as an IPv4-mapped or a NAT64 well-known-prefix (64:ff9b::/96) IPv6 address. */
const EMBEDDING_192_0_2_1 = [
  "64:ff9b::c000:0201",
  "64:ff9b::c000:201",
  "64:ff9b::192.0.2.1",
  "::ffff:192.0.2.1",
  "::ffff:c000:201",
] as const;

/** IPv6 addresses that embed no IPv4 address, with the /64 they count for. */
const COUNTED_PER_64 = [
  ["2001:db8:0:7::1", "2001:db8:0:7::/64"],
  // In 64:ff9b::/64 but outside the well-known prefix 64:ff9b::/96 (bits 80-95 not zero): no embedded IPv4 address.
  ["64:ff9b::1:c000:201", "64:ff9b::/64"],
  // The local-use prefix 64:ff9b:1::/48 (RFC 8215) is not the well-known prefix: its addresses count for their /64.
  ["64:ff9b:1::c000:201", "64:ff9b:1::/64"],
] as const;

/** The `ip` tracker value the rate-limit guards count for a request whose context holds end-user IP `ip`. */
function ipTracker(ip: string): string | undefined {
  return trackerValue("ip", {}, { ip, actor: undefined });
}

describe("the ip tracker", () => {
  it("counts an IPv4-mapped or NAT64 well-known-prefix address as its embedded IPv4 address [FIX-W63-PLATFORM]", () => {
    expect(ipTracker("192.0.2.1")).toBe("192.0.2.1");
    for (const ip of EMBEDDING_192_0_2_1) {
      expect(ipTracker(ip), ip).toBe("192.0.2.1");
    }
  });

  it("counts any other IPv6 address for its /64 [FIX-W63-PLATFORM]", () => {
    for (const [ip, tracker] of COUNTED_PER_64) {
      expect(ipTracker(ip), ip).toBe(tracker);
    }
  });

  it("counts the same after EndUserMiddleware has put the address into the request context [FIX-W63-PLATFORM]", () => {
    // end-user.ts's own normalizeIp runs first (dotted ::ffff: only); the tracker's result must not depend on it,
    // whether the address arrives in X-Velexis-End-User-IP from the portal server or as the request's own address.
    const viaBff = (ip: string) =>
      resolveEndUser(
        {
          headers: { [BFF_KEY_HEADER]: KEY, [END_USER_IP_HEADER]: ip },
          ip: "127.0.0.1",
          socket: { remoteAddress: "127.0.0.1" },
        },
        key,
      );
    const viaSocket = (ip: string) => resolveEndUser({ headers: {}, ip, socket: { remoteAddress: ip } }, key);
    const cases: readonly (readonly [string, string])[] = [
      ...EMBEDDING_192_0_2_1.map((ip) => [ip, "192.0.2.1"] as const),
      ...COUNTED_PER_64,
    ];

    for (const [ip, tracker] of cases) {
      const bff = viaBff(ip);
      const socket = viaSocket(ip);
      expect(bff.source, ip).toBe("bff");
      expect(socket.source, ip).toBe("socket");
      expect(ipTracker(bff.ip), `${ip} from the BFF header`).toBe(tracker);
      expect(ipTracker(socket.ip), `${ip} as the request's address`).toBe(tracker);
    }
  });
});
