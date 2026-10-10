/**
 * Same-origin proxy for browser calls (client components through `createBrowserClient()`).
 * Forwards allow-listed customer-scope operations with the httpOnly cookie tokens (customer access token, or the guest
 * booking token of the booking in the path). Calls carrying a token use the tenant's secret key + the visitor's IP;
 * token-less customer-optional calls (signed-out search, checkout, payment) use the publishable key, so the API's
 * ownership checks apply exactly as for a direct browser call. Console paths are always refused.
 */
import { createProxyHandler, DEFAULT_PROXY_ALLOW_LIST, DEFAULT_PROXY_GUARDS } from "@velexis/ota-sdk/next";
import { velexisConfig } from "@/lib/velexis-config";

export const dynamic = "force-dynamic";
// checkout.complete (Amadeus Create Orders + issuance) may take up to 60 s through the proxy.
export const maxDuration = 90;

export const { GET, POST, PUT, PATCH, DELETE } = createProxyHandler({
  config: velexisConfig,
  allow: DEFAULT_PROXY_ALLOW_LIST,
  guards: DEFAULT_PROXY_GUARDS,
  forwardKey: "auto",
  captureBookingTokens: true, // guest tokens from checkout.complete (201 and 504 SUPPLIER_TIMEOUT) / bookings.lookup → httpOnly cookies
  refreshSession: true,
  onRequest: ({ rule, request }) => {
    if (process.env.NODE_ENV !== "production") console.debug(`[velexis-proxy] ${request.method} ${rule.path} (${rule.sdkMethod ?? "?"})`);
  },
});
