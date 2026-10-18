import "server-only";

/**
 * The admin's IP address and user agent, forwarded to the platform API on every call (README §4, PADR-0019), as the
 * portal does (`platform/frontend/src/lib/end-user.ts`).
 *
 * The admin listens on 127.0.0.1 behind Caddy, so the socket address of a request says nothing about the person.
 * Caddy has no trusted proxies configured: it writes the real client address as the right-most entry of
 * `X-Forwarded-For`, whatever the browser sent. Only that entry is used; a browser-supplied left-most entry never
 * is. The API honours the two end-user headers only from loopback, without `X-Forwarded-For`, and with the shared
 * key in `X-Velexis-Bff-Key`; admin sign-in is throttled per admin IP, and admin audit rows record it.
 */

/** The header that carries the admin's IP address. */
export const END_USER_IP_HEADER = "X-Velexis-End-User-IP";
/** The header that carries the admin's user agent. */
export const END_USER_AGENT_HEADER = "X-Velexis-End-User-Agent";
/** The header that carries `PLATFORM_BFF_KEY`, the first-party key shared with the platform API. */
export const BFF_KEY_HEADER = "X-Velexis-Bff-Key";

/** The address used when the request did not come through Caddy (local development without a proxy). */
export const FALLBACK_END_USER_IP = "127.0.0.1";
/** The longest user agent forwarded, in characters. */
export const MAX_USER_AGENT_LENGTH = 512;

/** The incoming request headers this module reads (a `Headers` object or Next.js's read-only copy). */
export interface IncomingHeaders {
  get(name: string): string | null;
}

/**
 * The right-most entry of `X-Forwarded-For`, which Caddy writes, or `127.0.0.1` without one. Every entry to its
 * left may come from the browser and is ignored. The value is passed on unchanged: the API refuses a malformed
 * address with `400 VALIDATION_FAILED`, so a proxy misconfiguration shows at once instead of putting every admin
 * into one rate-limit bucket.
 */
export function endUserIp(headers: IncomingHeaders): string {
  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.at(-1) ?? FALLBACK_END_USER_IP;
}

/** The browser's `User-Agent`, cut to 512 characters; empty when the browser sent none. */
export function endUserAgent(headers: IncomingHeaders): string {
  return (headers.get("user-agent") ?? "").trim().slice(0, MAX_USER_AGENT_LENGTH);
}

/** The three headers of PADR-0019 for one API call made on behalf of the request with `incoming` headers. */
export function endUserHeaders(incoming: IncomingHeaders, bffKey: string): Record<string, string> {
  return {
    [END_USER_IP_HEADER]: endUserIp(incoming),
    [END_USER_AGENT_HEADER]: endUserAgent(incoming),
    [BFF_KEY_HEADER]: bffKey,
  };
}
