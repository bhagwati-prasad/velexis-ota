/**
 * Server-only Velexis helpers (server components, server actions, route handlers).
 * In a real app add `import "server-only";` at the top so a client import fails the build.
 *
 * Every client created per request sends the visitor's IP / user agent (`X-Velexis-End-User-*`, see `endUser` in the
 * config) and gets customer scope from the API unless it acts as staff — results of customer / anonymous clients can be
 * passed to client components as they are (SDK pages through `serializePage`).
 */
import { cache } from "react";
import {
  createServerClient,
  createPublicServerClient,
  getTenant,
  getSession,
  getStaffSession,
  requireCustomer,
  requireStaff,
  storefrontCacheOptions,
  referenceCacheOptions,
  type ServerClientOptions,
  type RequireStaffOptions,
} from "@velexis/ota-sdk/next";
import type { StaffRole } from "@velexis/ota-sdk";
import { velexisConfig } from "./velexis-config";

export { velexisConfig };

/** Client acting as the signed-in customer (or anonymous); optionally with the guest token of one booking. */
export function customerClient(options: Omit<ServerClientOptions, "config" | "as"> = {}) {
  return createServerClient({ ...options, config: velexisConfig, as: "customer" });
}

/** Client without any user token (sign-up, guest lookup): request tenant + visitor, customer scope. */
export function anonymousClient() {
  return createServerClient({ config: velexisConfig, as: "anonymous" });
}

/** Client acting as the signed-in staff member (console key + staff cookie; console pages and console server actions). */
export function staffClient() {
  return createServerClient({ config: velexisConfig, as: "staff" });
}

/** The `console` namespace with the staff token. */
export async function consoleApi() {
  return (await staffClient()).console;
}

/** Storefront config, cached in the Next.js data cache per tenant (revalidated every 5 min or by tag). */
export const getStorefront = cache(async () => {
  const tenant = await getTenant({ config: velexisConfig });
  const vx = createPublicServerClient({ config: velexisConfig, tenant });
  return vx.storefront.get({}, storefrontCacheOptions(tenant.tenantKey));
});

/** Airline names/logos for a set of codes (reference data, cached 24 h). */
export async function getAirlines(codes: string[]) {
  if (codes.length === 0) return new Map<string, { name: string; logoSquareUrl?: string | null }>();
  const tenant = await getTenant({ config: velexisConfig });
  const vx = createPublicServerClient({ config: velexisConfig, tenant });
  const page = await vx.reference.airlines.list({ iataCodes: [...new Set(codes)].slice(0, 100), limit: 100 }, referenceCacheOptions());
  return new Map(page.data.map((a) => [a.iataCode, a]));
}

export const currentCustomer = () => getSession({ config: velexisConfig });
export const currentStaff = () => getStaffSession({ config: velexisConfig });
export const mustBeCustomer = (returnTo?: string) => requireCustomer({ config: velexisConfig, returnTo });
export const mustBeStaff = (options: Omit<RequireStaffOptions, "config"> & { roles?: StaffRole[] } = {}) =>
  requireStaff({ ...options, config: velexisConfig });
