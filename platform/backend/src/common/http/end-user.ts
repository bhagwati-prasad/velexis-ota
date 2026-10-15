// The end user's IP and user agent (platform/docs/architecture.md §3.2, PADR-0019). The portal and the admin call the
// API from their own servers on 127.0.0.1, so they forward the person's IP and user agent in
// `X-Velexis-End-User-IP` and `X-Velexis-End-User-Agent`, authenticated by the shared key in `X-Velexis-Bff-Key`.
// The API believes the two headers only when ALL of these hold:
//
//   1. the socket peer is loopback (the portal and admin servers run on the VM);
//   2. the request has no `X-Forwarded-For` (it did not come through Caddy, which always sets one);
//   3. `X-Velexis-Bff-Key` equals PLATFORM_BFF_KEY, compared in constant time.
//
// Then a missing or malformed IP answers `400 VALIDATION_FAILED`, so a client bug cannot quietly put every person in
// one rate-limit bucket. In every other case the two headers are ignored and the IP is Express's `req.ip` (`trust
// proxy` loopback: the Caddy client address for public calls) with the request's own `User-Agent`. A key that is
// sent but not believed is logged as a warning, never with its value; `x-velexis-bff-key` is on the logger's
// redaction list.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { isIP, isIPv4 } from "node:net";
import { Injectable, type NestMiddleware } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformBackendConfig } from "../../config";
import { RequestContext, type EndUser } from "./request-context";

/** The header that carries the end user's IP address (lower case, as Node delivers header names). */
export const END_USER_IP_HEADER = "x-velexis-end-user-ip";
/** The header that carries the end user's user agent. */
export const END_USER_AGENT_HEADER = "x-velexis-end-user-agent";
/** The header that carries PLATFORM_BFF_KEY. */
export const BFF_KEY_HEADER = "x-velexis-bff-key";
/** The longest user agent kept, in characters (the portal and admin cut it to the same length). */
export const MAX_USER_AGENT_LENGTH = 512;

/** Why a request's BFF key was not believed. Logged by name, never with the key. */
export type IgnoredBffKeyReason = "bff_key_invalid" | "not_loopback" | "forwarded_for";

/** The end user of a request, and why a sent BFF key was ignored. */
export interface ResolvedEndUser extends EndUser {
  /** `bff` when the forwarded headers were believed, `socket` when `req.ip` and `User-Agent` were used. */
  readonly source: "bff" | "socket";
  /** Set when the request carried `X-Velexis-Bff-Key` but the headers were not believed. */
  readonly ignoredBffKey?: IgnoredBffKeyReason;
}

/** The parts of an Express request the resolution reads. */
export interface EndUserRequest {
  readonly headers: IncomingHttpHeaders;
  /** Express's client address (`trust proxy`); `undefined` once the socket has closed. */
  readonly ip?: string | undefined;
  readonly socket: { readonly remoteAddress?: string | undefined };
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * PLATFORM_BFF_KEY, kept as its SHA-256 digest. `matches` compares the digests of both sides with `timingSafeEqual`,
 * so the time taken depends neither on where the values differ nor on the length of the expected key.
 */
export class BffKey {
  private readonly digest: Buffer;

  constructor(key: string) {
    if (key === "") {
      throw new TypeError("BffKey: the key must not be empty");
    }
    this.digest = sha256(key);
  }

  matches(value: string): boolean {
    return timingSafeEqual(sha256(value), this.digest);
  }
}

/** The single value of a header; `undefined` when absent. A repeated header (an array) is joined as Node would. */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

/** `::ffff:203.0.113.7` → `203.0.113.7`; any other address unchanged. */
export function normalizeIp(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  return mapped !== undefined && isIPv4(mapped) ? mapped : address;
}

/** True for 127.0.0.0/8, `::1` and their IPv4-mapped form. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  const ip = normalizeIp(address);
  return (isIPv4(ip) && ip.startsWith("127.")) || ip === "::1";
}

/** A user agent cut to 512 characters; `undefined` for a missing or blank one. */
function userAgentOf(value: string | undefined): string | undefined {
  const agent = value?.trim().slice(0, MAX_USER_AGENT_LENGTH);
  return agent === undefined || agent === "" ? undefined : agent;
}

/** The request's own client address: Express's `req.ip`, or the socket's when Express has none. */
function socketIpOf(req: EndUserRequest): string {
  // Both are missing only when the client has already gone; the request then never answers anyone.
  return normalizeIp(req.ip ?? req.socket.remoteAddress ?? "0.0.0.0");
}

/**
 * The end user of `req` (PADR-0019 item 3). Throws `AppError("VALIDATION_FAILED")` naming the IP header, never its
 * value, when a believed request carries a missing or malformed IP.
 */
export function resolveEndUser(req: EndUserRequest, key: BffKey): ResolvedEndUser {
  const sentKey = headerValue(req.headers, BFF_KEY_HEADER);
  const direct = (ignoredBffKey?: IgnoredBffKeyReason): ResolvedEndUser => ({
    ip: socketIpOf(req),
    userAgent: userAgentOf(headerValue(req.headers, "user-agent")),
    source: "socket",
    ...(ignoredBffKey === undefined ? {} : { ignoredBffKey }),
  });
  if (sentKey === undefined) {
    return direct();
  }
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return direct("not_loopback");
  }
  if (headerValue(req.headers, "x-forwarded-for") !== undefined) {
    return direct("forwarded_for");
  }
  if (!key.matches(sentKey)) {
    return direct("bff_key_invalid");
  }
  const ip = headerValue(req.headers, END_USER_IP_HEADER)?.trim();
  if (ip === undefined || ip === "" || isIP(ip) === 0) {
    throw new AppError("VALIDATION_FAILED", {
      fieldErrors: [
        ip === undefined || ip === ""
          ? { path: "/header/X-Velexis-End-User-IP", code: "required", message: "This header is required." }
          : {
              path: "/header/X-Velexis-End-User-IP",
              code: "format",
              message: "Must be an IPv4 or IPv6 address.",
            },
      ],
    });
  }
  return {
    ip: normalizeIp(ip),
    userAgent: userAgentOf(headerValue(req.headers, END_USER_AGENT_HEADER)),
    source: "bff",
  };
}

/**
 * Fills the end user of the request context. Mounted by AppModule right after the request context's ClsMiddleware
 * (`API_REQUEST_MIDDLEWARE`), so every guard, interceptor and service of the request sees it.
 */
@Injectable()
export class EndUserMiddleware implements NestMiddleware {
  private readonly key: BffKey;

  constructor(
    config: ConfigService<PlatformBackendConfig, true>,
    private readonly context: RequestContext,
    @InjectPinoLogger(EndUserMiddleware.name) private readonly logger: PinoLogger,
  ) {
    this.key = new BffKey(config.get("PLATFORM_BFF_KEY", { infer: true }));
  }

  use(req: EndUserRequest, _res: unknown, next: (error?: unknown) => void): void {
    const endUser = resolveEndUser(req, this.key);
    if (endUser.ignoredBffKey !== undefined) {
      // The reason only: the key itself is never logged (and its header is redacted anyway).
      this.logger.warn({ reason: endUser.ignoredBffKey }, "request_context.bff_key_ignored");
    }
    this.context.setEndUser({ ip: endUser.ip, userAgent: endUser.userAgent });
    next();
  }
}
