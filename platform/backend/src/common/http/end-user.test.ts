import type { IncomingHttpHeaders } from "node:http";
import type { ConfigService } from "@nestjs/config";
import { AppError, toErrorEnvelope } from "@velexis/errors";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { PlatformBackendConfig } from "../../config";
import {
  BFF_KEY_HEADER,
  BffKey,
  END_USER_AGENT_HEADER,
  END_USER_IP_HEADER,
  EndUserMiddleware,
  isLoopbackAddress,
  MAX_USER_AGENT_LENGTH,
  normalizeIp,
  resolveEndUser,
  type EndUserRequest,
} from "./end-user";
import type { EndUser, RequestContext } from "./request-context";

// Test values only: the development key of .env.example and documentation addresses (RFC 5737, RFC 3849).
const KEY = "dev_bff_key_change_me_0123456789abcdef";
const WRONG_KEY = "dev_bff_key_change_me_0123456789abcdeX";
const PERSON_IP = "203.0.113.7";
const PERSON_AGENT = "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0";
const SERVER_AGENT = "node";

const key = new BffKey(KEY);

/** A request from the portal server on loopback, as `lib/api.ts` sends it. */
function fromPortal(
  overrides: { headers?: IncomingHttpHeaders; remoteAddress?: string; ip?: string } = {},
): EndUserRequest {
  return {
    headers: {
      "user-agent": SERVER_AGENT,
      [BFF_KEY_HEADER]: KEY,
      [END_USER_IP_HEADER]: PERSON_IP,
      [END_USER_AGENT_HEADER]: PERSON_AGENT,
      ...overrides.headers,
    },
    ip: overrides.ip ?? overrides.remoteAddress ?? "127.0.0.1",
    socket: { remoteAddress: overrides.remoteAddress ?? "127.0.0.1" },
  };
}

function validationError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an AppError");
}

describe("resolveEndUser", () => {
  it("[PBE-008 AC5] believes the forwarded IP and user agent with the valid key, from loopback, without X-Forwarded-For", () => {
    expect(resolveEndUser(fromPortal(), key)).toEqual({
      ip: PERSON_IP,
      userAgent: PERSON_AGENT,
      source: "bff",
    });
    expect(resolveEndUser(fromPortal({ remoteAddress: "::1" }), key).ip).toBe(PERSON_IP);
    expect(resolveEndUser(fromPortal({ remoteAddress: "::ffff:127.0.0.1" }), key).ip).toBe(PERSON_IP);
    expect(resolveEndUser(fromPortal({ headers: { [END_USER_IP_HEADER]: "2001:db8::7" } }), key).ip).toBe(
      "2001:db8::7",
    );
  });

  it("[PBE-008 AC5] ignores both headers with a wrong key and uses req.ip and the request's User-Agent", () => {
    expect(resolveEndUser(fromPortal({ headers: { [BFF_KEY_HEADER]: WRONG_KEY } }), key)).toEqual({
      ip: "127.0.0.1",
      userAgent: SERVER_AGENT,
      source: "socket",
      ignoredBffKey: "bff_key_invalid",
    });
    expect(resolveEndUser(fromPortal({ headers: { [BFF_KEY_HEADER]: "" } }), key).ignoredBffKey).toBe(
      "bff_key_invalid",
    );
  });

  it("[PBE-008 AC5] ignores both headers when X-Forwarded-For is present (the request came through Caddy)", () => {
    // Express's req.ip with `trust proxy` loopback is Caddy's client address, the right-most X-Forwarded-For entry.
    const viaCaddy = fromPortal({ headers: { "x-forwarded-for": "198.51.100.9" }, ip: "198.51.100.9" });

    expect(resolveEndUser(viaCaddy, key)).toEqual({
      ip: "198.51.100.9",
      userAgent: SERVER_AGENT,
      source: "socket",
      ignoredBffKey: "forwarded_for",
    });
  });

  it("ignores both headers from a peer that is not loopback, even with the valid key", () => {
    expect(resolveEndUser(fromPortal({ remoteAddress: "192.0.2.10" }), key)).toEqual({
      ip: "192.0.2.10",
      userAgent: SERVER_AGENT,
      source: "socket",
      ignoredBffKey: "not_loopback",
    });
  });

  it("uses req.ip and User-Agent for a request without the key, and logs nothing for it", () => {
    const direct: EndUserRequest = {
      headers: { "user-agent": PERSON_AGENT, [END_USER_IP_HEADER]: "192.0.2.99" },
      ip: "::ffff:198.51.100.20",
      socket: { remoteAddress: "127.0.0.1" },
    };

    expect(resolveEndUser(direct, key)).toEqual({
      ip: "198.51.100.20",
      userAgent: PERSON_AGENT,
      source: "socket",
    });
  });

  it("[PBE-008 AC5] answers 400 VALIDATION_FAILED for the valid key with a missing or malformed IP, without its value", () => {
    const missing = validationError(() =>
      resolveEndUser(fromPortal({ headers: { [END_USER_IP_HEADER]: undefined } }), key),
    );
    const blank = validationError(() =>
      resolveEndUser(fromPortal({ headers: { [END_USER_IP_HEADER]: " " } }), key),
    );
    const malformed = validationError(() =>
      resolveEndUser(fromPortal({ headers: { [END_USER_IP_HEADER]: "999.1.1.1-secret-value-4" } }), key),
    );
    const twoValues = validationError(() =>
      resolveEndUser(fromPortal({ headers: { [END_USER_IP_HEADER]: "203.0.113.7, 203.0.113.8" } }), key),
    );

    for (const error of [missing, blank]) {
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.fieldErrors).toEqual([
        { path: "/header/X-Velexis-End-User-IP", code: "required", message: "This header is required." },
      ]);
    }
    for (const error of [malformed, twoValues]) {
      expect(error.fieldErrors).toEqual([
        {
          path: "/header/X-Velexis-End-User-IP",
          code: "format",
          message: "Must be an IPv4 or IPv6 address.",
        },
      ]);
    }
    expect(JSON.stringify(toErrorEnvelope(malformed, "req-1", { exposeSupplier: false }))).not.toContain(
      "secret-value-4",
    );
  });

  it("cuts a user agent to 512 characters and treats a blank one as none", () => {
    const long = "A".repeat(MAX_USER_AGENT_LENGTH + 100);

    expect(
      resolveEndUser(fromPortal({ headers: { [END_USER_AGENT_HEADER]: long } }), key).userAgent,
    ).toHaveLength(MAX_USER_AGENT_LENGTH);
    expect(
      resolveEndUser(fromPortal({ headers: { [END_USER_AGENT_HEADER]: "  " } }), key).userAgent,
    ).toBeUndefined();
    expect(
      resolveEndUser({ headers: { "user-agent": long }, ip: "127.0.0.1", socket: {} }, key).userAgent,
    ).toHaveLength(MAX_USER_AGENT_LENGTH);
  });
});

describe("BffKey", () => {
  it("matches only the exact key, whatever the length of the value", () => {
    expect(key.matches(KEY)).toBe(true);
    expect(key.matches(WRONG_KEY)).toBe(false);
    expect(key.matches(KEY.slice(0, -1))).toBe(false);
    expect(key.matches(`${KEY}0`)).toBe(false);
    expect(key.matches("")).toBe(false);
    expect(() => new BffKey("")).toThrow(TypeError);
  });
});

describe("addresses", () => {
  it("knows loopback addresses and writes IPv4-mapped addresses as IPv4", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(address)).toBe(true);
    }
    for (const address of ["10.0.0.1", "::ffff:10.0.0.1", "::2", "fe80::1", "", undefined]) {
      expect(isLoopbackAddress(address)).toBe(false);
    }
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
  });
});

describe("EndUserMiddleware", () => {
  function middleware(): {
    use: EndUserMiddleware["use"];
    endUsers: EndUser[];
    warn: ReturnType<typeof vi.fn>;
  } {
    const endUsers: EndUser[] = [];
    const warn = vi.fn();
    const config = { get: () => KEY } as unknown as ConfigService<PlatformBackendConfig, true>;
    const context = { setEndUser: (endUser: EndUser) => endUsers.push(endUser) } as unknown as RequestContext;
    const instance = new EndUserMiddleware(config, context, { warn } as unknown as PinoLogger);
    return { use: instance.use.bind(instance), endUsers, warn };
  }

  it("puts the end user into the request context and continues", () => {
    const { use, endUsers, warn } = middleware();
    const next = vi.fn();

    use(fromPortal(), undefined, next);

    expect(endUsers).toEqual([{ ip: PERSON_IP, userAgent: PERSON_AGENT }]);
    expect(next).toHaveBeenCalledWith();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a key it does not believe as a warning with the reason only, never the key", () => {
    const { use, endUsers, warn } = middleware();

    use(fromPortal({ headers: { [BFF_KEY_HEADER]: WRONG_KEY } }), undefined, vi.fn());

    expect(endUsers).toEqual([{ ip: "127.0.0.1", userAgent: SERVER_AGENT }]);
    expect(warn).toHaveBeenCalledWith({ reason: "bff_key_invalid" }, "request_context.bff_key_ignored");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(WRONG_KEY);
  });

  it("throws the 400 for a believed request without an IP, before the context is set", () => {
    const { use, endUsers } = middleware();
    const next = vi.fn();

    expect(() => use(fromPortal({ headers: { [END_USER_IP_HEADER]: undefined } }), undefined, next)).toThrow(
      AppError,
    );
    expect(endUsers).toEqual([]);
    expect(next).not.toHaveBeenCalled();
  });
});
