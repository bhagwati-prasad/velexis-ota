// Next.js configuration of the portal (ADR-0014, platform/frontend/README.md §7).
// Runtime configuration is read in server code through src/lib/config.ts, never here: this file has no `env`
// block, so no variable is ever inlined into a browser bundle.
import { join } from "node:path";
import type { NextConfig } from "next";

/**
 * Static security headers on every response. The nonce-based Content-Security-Policy is per request and comes
 * with the middleware (PFE-002); token pages override the referrer policy with `no-referrer`, the "Open console"
 * hand-off page with `strict-origin`.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
] as const;

/**
 * Paths whose URL carries a single-use token, served with `Referrer-Policy: no-referrer` (README §7, PADR-0008
 * item 4). The override lives here and not only in the route handler: Next.js sets these configured headers on the
 * response first and keeps them over a handler's own value of the same header. A later rule replaces the value of
 * an earlier one.
 */
const TOKEN_PAGES = ["/verify-email"] as const;

/**
 * The "Open console" hand-off page (PFE-017), served with `Referrer-Policy: strict-origin` (PADR-0007 point 4 as
 * revised on 2026-10-23). Its form posts the portal token to the OTA admin's `/sso`, which accepts only
 * `Origin` = `PUBLIC_PORTAL_URL`: under `no-referrer` a browser sends `Origin: null` with that post, while
 * `strict-origin` sends the portal's origin and nothing of the path. The token travels in the form body only. As for
 * the token pages, the rule is needed because Next.js keeps these headers over the route handler's own.
 */
const HAND_OFF_PAGES = ["/otas/:tenantId/console/launch"] as const;

const nextConfig: NextConfig = {
  // The VM runs `node platform/frontend/server.js` from the standalone tree (deploy/scripts/pack-release.sh).
  output: "standalone",
  // Trace files from the repository root so workspace packages land in .next/standalone/node_modules and the
  // server sits at .next/standalone/platform/frontend/server.js.
  outputFileTracingRoot: join(__dirname, "..", ".."),
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      { source: "/:path*", headers: [...SECURITY_HEADERS] },
      ...TOKEN_PAGES.map((source) => ({
        source,
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      })),
      ...HAND_OFF_PAGES.map((source) => ({
        source,
        headers: [{ key: "Referrer-Policy", value: "strict-origin" }],
      })),
    ];
  },
};

export default nextConfig;
