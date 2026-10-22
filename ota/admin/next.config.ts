// Next.js configuration of the OTA admin (ADR-0014, ota/admin/README.md §6 and §10).
// Runtime configuration is read by server code through src/config.ts when a request needs it, never here: this
// file has no `env` block, so no variable is ever inlined into a browser bundle.
import { join } from "node:path";
import type { NextConfig } from "next";

/**
 * Static security headers on every response; Caddy adds HSTS and `X-Frame-Options` in production
 * (deploy/caddy/Caddyfile). The Content-Security-Policy here is the fallback of the answers the middleware does not
 * see (static files, the health routes): `src/middleware.ts` sets the full nonce-based policy on every other answer,
 * per request, in its place (and on the request, where Next.js reads the nonce for the scripts it renders). Both
 * policies keep `frame-ancestors 'none'`.
 */
export const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
] as const;

const nextConfig: NextConfig = {
  // The VM runs `node ota/admin/server.js` from the standalone tree (deploy/scripts/pack-release.sh and the
  // velexis-ota-admin unit).
  output: "standalone",
  // Trace files from the repository root, two levels up, so workspace packages land in
  // .next/standalone/node_modules and the server sits at .next/standalone/ota/admin/server.js.
  outputFileTracingRoot: join(__dirname, "..", ".."),
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // Asset uploads go through a server action; the API itself refuses files over 1 MB (README §10).
    serverActions: { bodySizeLimit: "2mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: [...SECURITY_HEADERS] }];
  },
};

export default nextConfig;
