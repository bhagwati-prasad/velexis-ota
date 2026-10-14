/**
 * The portal's Content-Security-Policy (README §7), set per request by `middleware.ts` with a fresh nonce.
 * Next.js reads the policy from the request headers and puts the nonce on its own scripts.
 */

/** The request header that hands the nonce to server components that render their own `<script>`. */
export const NONCE_HEADER = "x-nonce";

/** A base64 nonce: only these characters may go into the header. */
const NONCE = /^[A-Za-z0-9+/]{22,}={0,2}$/;

/** A fresh nonce of 128 random bits, base64-encoded. */
export function createNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}

export interface CspOptions {
  /** The nonce of this response (`createNonce()`). */
  readonly nonce: string;
  /** `PUBLIC_OTA_ADMIN_URL`: the SSO hand-off posts a form to its origin (PADR-0007). */
  readonly otaAdminUrl: string;
  /**
   * `APP_ENV=development`: `next dev` evaluates its modules with `eval`, so `script-src` also allows
   * `'unsafe-eval'` there, and only there.
   */
  readonly development: boolean;
}

/**
 * The policy:
 * - scripts only from the portal and with this response's nonce; no inline script without it;
 * - styles from the portal; inline styles are allowed (`style` attributes of components), scripts are not;
 * - images from the portal and `data:` URLs; fonts, frames and everything else from the portal only;
 * - `connect-src 'self'`: the browser talks to the portal only (server actions), never to the API;
 * - forms post to the portal, or to the OTA admin for the SSO hand-off; Stripe pages are reached by redirects,
 *   never in frames;
 * - the portal is never framed (`frame-ancestors 'none'`), `<base>` cannot point elsewhere, no plugins.
 */
export function contentSecurityPolicy(options: CspOptions): string {
  if (!NONCE.test(options.nonce)) {
    throw new TypeError("The CSP nonce must be a base64 string of at least 128 bits");
  }
  const otaAdminOrigin = new URL(options.otaAdminUrl).origin;
  const scriptSources = [
    "'self'",
    `'nonce-${options.nonce}'`,
    ...(options.development ? ["'unsafe-eval'"] : []),
  ];
  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    ["script-src", ...scriptSources],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:"],
    ["font-src", "'self'"],
    ["connect-src", "'self'"],
    ["form-action", "'self'", otaAdminOrigin],
    ["frame-ancestors", "'none'"],
    ["base-uri", "'self'"],
    ["object-src", "'none'"],
  ];
  return directives.map((directive) => directive.join(" ")).join("; ");
}
