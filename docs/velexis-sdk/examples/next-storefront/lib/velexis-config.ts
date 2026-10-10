/**
 * Shared Velexis configuration — imported by server code (lib/velexis.ts, route handlers) AND by middleware.ts (edge).
 * Keep it free of server-only imports.
 *
 * Single OTA:  VELEXIS_SECRET_KEY (scope `storefront`), VELEXIS_CONSOLE_SECRET_KEY (scope `console`, for /console),
 *              NEXT_PUBLIC_VELEXIS_PUBLISHABLE_KEY, VELEXIS_API_URL.
 * Many OTAs:   VELEXIS_HOSTING_KEY (`hk_…`): hosts are resolved with `storefront.resolve` and every call sends
 *              `X-Velexis-Host` — or, without a hosting key, VELEXIS_TENANTS='{"www.acme.travel":{"tenantKey":"acme",
 *              "secretKey":"sk_live_…","consoleSecretKey":"sk_live_…","publishableKey":"pk_live_…"}, …}'.
 */
import { defineVelexisConfig, tenantsFromEnv, tenantsFromHostingKey } from "@velexis/ota-sdk/next";

export const velexisConfig = defineVelexisConfig({
  tenants: process.env.VELEXIS_HOSTING_KEY ? tenantsFromHostingKey() : process.env.VELEXIS_TENANTS ? tenantsFromEnv("VELEXIS_TENANTS") : undefined,
  signInPath: "/account/sign-in",
  consoleSignInPath: "/console/sign-in",
  // Visitor IP for per-visitor rate limits / sign-in lockouts: the last `x-forwarded-for` entry, written by our edge.
  endUser: { ipHeader: "x-forwarded-for", trustedHops: 1 },
  clientOptions: { timeoutMs: 30_000, maxRetries: 2 },
});
