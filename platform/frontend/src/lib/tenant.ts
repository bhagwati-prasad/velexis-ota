import "server-only";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { platformApi, type ApiError } from "@/lib/api";
import { otaPath } from "@/lib/roles";

/**
 * The OTA of an `/otas/[tenantId]/…` request (README §5): `otas/[tenantId]/layout.tsx` loads it once per request,
 * and the pages below it read the same answer, because `loadTenant` is a React `cache()`: within one request a
 * second call with the same id returns the first call's promise, so the layout and the page make one `getTenant`
 * call together. Server code only; the tenant holds no secret, but the call carries the session's bearer token.
 */

/** An OTA as `getTenant` answers it, with the caller's role in `myRole`. */
export type Tenant = components["schemas"]["Tenant"];

/** An OTA id as the platform issues it (`ten_` + ULID); the `TenantId` pattern of the platform document. */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

/** `value` is an OTA id. */
export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID.test(value);
}

/** The `If-Match` value of a tenant version: the `ETag` of `getTenant` (`"<version>"`). */
export function ifMatchOf(version: number): string {
  return `"${version}"`;
}

/** The answer of `loadTenant`. */
export type TenantResult = { tenant: Tenant; error?: undefined } | { tenant?: undefined; error: ApiError };

/** An id that is not an OTA id: answered as the API answers an OTA the caller is no member of. */
const NOT_A_TENANT: ApiError = Object.freeze({
  code: "NOT_FOUND",
  status: 404,
  fieldErrors: Object.freeze([]),
  details: Object.freeze({}),
});

/**
 * `GET /v1/tenants/{tenantId}` for the request being rendered, at most once per request and id. An id that is not
 * an OTA id is `NOT_FOUND` without a call.
 */
export const loadTenant = cache(async (tenantId: string): Promise<TenantResult> => {
  if (!isTenantId(tenantId)) {
    return { error: NOT_A_TENANT };
  }
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}", { params: { path: { tenantId } } });
  return result.error === undefined ? { tenant: result.data } : { error: result.error };
});

/** Answers of the API that mean the session is over: sign in again. */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/**
 * The OTA of an `/otas/<tenantId>/…` page, for the layout and its pages. An OTA the caller is no member of (or an id
 * that is none) renders the not-found page (`notFound()`: the API answers `404` for both, so ids cannot be probed);
 * an ended session goes to sign-in and back to the OTA's overview, an unverified account to `/verify-pending`. Any
 * other failure (rate limit, API unavailable) is returned, for the page to show the portal's message for its code.
 *
 * The way back is the overview, not the page itself: the layout reads the same cached answer and redirects before
 * any page below it does (checked with `next start`), and Next.js never tells a layout which page it wraps.
 */
export async function requireTenant(tenantId: string): Promise<TenantResult> {
  const result = await loadTenant(tenantId);
  if (result.error === undefined) {
    return result;
  }
  const { code } = result.error;
  if (code === "NOT_FOUND" || code === "VALIDATION_FAILED") {
    notFound();
  }
  if (SESSION_ENDED.has(code)) {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId) }).toString()}`);
  }
  if (code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
  return result;
}
