// Next.js configuration of the portal (ADR-0014, platform/frontend/README.md §7).
// Runtime configuration is read in server code through src/lib/config.ts, never here: this file has no `env`
// block, so no variable is ever inlined into a browser bundle.
import { join } from "node:path";
import type { NextConfig } from "next";

/**
 * Static security headers on every response. The nonce-based Content-Security-Policy is per request and comes
 * with the middleware (PFE-002); token pages override the referrer policy with `no-referrer`.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
] as const;

const nextConfig: NextConfig = {
  // The VM runs `node platform/frontend/server.js` from the standalone tree (deploy/scripts/pack-release.sh).
  output: "standalone",
  // Trace files from the repository root so workspace packages land in .next/standalone/node_modules and the
  // server sits at .next/standalone/platform/frontend/server.js.
  outputFileTracingRoot: join(__dirname, "..", ".."),
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: [...SECURITY_HEADERS] }];
  },
};

export default nextConfig;
