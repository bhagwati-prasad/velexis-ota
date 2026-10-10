/**
 * Edge middleware:
 * - maps the request host to the OTA's keys (multi-domain hosting) and sets the trusted `x-velexis-tenant` header,
 * - refreshes the customer / staff session before server components render (rotated tokens go into httpOnly cookies),
 * - protects /account (customers) and /console (staff); sign-in / sign-up pages stay public.
 */
import type { NextRequest } from "next/server";
import { velexisMiddleware } from "@velexis/ota-sdk/next";
import { velexisConfig } from "@/lib/velexis-config";

const handler = velexisMiddleware({
  config: velexisConfig,
  customerPaths: ["/account"],
  consolePaths: ["/console"],
  publicPaths: ["/account/sign-in", "/account/sign-up", "/console/sign-in"],
  unknownTenant: "not-found",
});

export function middleware(request: NextRequest) {
  return handler(request);
}

// Must be a literal (read statically by Next.js). The proxy route refreshes tokens itself.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/velexis).*)"],
};
