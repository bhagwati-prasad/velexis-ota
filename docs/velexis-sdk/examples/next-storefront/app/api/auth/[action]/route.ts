/**
 * Customer auth endpoints used by the browser client (`useAuth()`):
 * POST /api/auth/sign-in | sign-up | sign-out | refresh | reset-password | change-password.
 * Tokens are written to httpOnly cookies here and never returned to JavaScript.
 */
import { createAuthHandlers } from "@velexis/ota-sdk/next";
import { velexisConfig } from "@/lib/velexis-config";

export const dynamic = "force-dynamic";

export const { POST } = createAuthHandlers({
  config: velexisConfig,
  actions: ["sign-in", "sign-up", "sign-out", "refresh", "reset-password", "change-password"],
});
