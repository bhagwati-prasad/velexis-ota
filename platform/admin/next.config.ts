// Next.js configuration of the platform admin (ADR-0014, platform/admin/README.md §4).
// Runtime configuration is read in server code through src/lib/config.ts, never here: this file has no `env`
// block, so no variable is ever inlined into a browser bundle.
import { join } from "node:path";
import type { NextConfig } from "next";

/**
 * Static headers on every response, pages, route handlers (the health routes included), static assets and
 * error pages alike. The staff console is never indexed and never sends its URLs to another origin. The
 * nonce-based Content-Security-Policy is per request and comes with the middleware (PAD-002).
 */
export const SECURITY_HEADERS = [
  { key: "X-Robots-Tag", value: "noindex" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
] as const;

const nextConfig: NextConfig = {
  // The VM runs `node platform/admin/server.js` from the standalone tree (deploy/scripts/pack-release.sh).
  output: "standalone",
  // Trace files from the repository root so workspace packages land in .next/standalone/node_modules and the
  // server sits at .next/standalone/platform/admin/server.js.
  outputFileTracingRoot: join(__dirname, "..", ".."),
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: [...SECURITY_HEADERS] }];
  },
};

export default nextConfig;
