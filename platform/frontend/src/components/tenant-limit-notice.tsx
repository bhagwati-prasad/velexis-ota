import type { components } from "@velexis/api-types/platform";

import type { PlatformApi } from "@/lib/api";
import { WIZARD_STRINGS } from "@/lib/strings";

/** `TenantList.tenantLimit` of `listTenants`: the most OTAs one account may own, and how many count against it. */
export type TenantLimit = components["schemas"]["TenantLimit"];

/**
 * Whether the account has reached its tenant limit (FIX-W69-LIMIT, known issue KI-010; scope PF-10 AC4): `owned` at or
 * above `max`, which is when createTenant answers `422 UNPROCESSABLE` (`tenant_limit`). An unknown limit (listTenants
 * failed) is not reached: the review's refusal stays the final guard.
 */
export function tenantLimitReached(limit: TenantLimit | undefined): limit is TenantLimit {
  return limit !== undefined && limit.owned >= limit.max;
}

/**
 * The caller's tenant limit for `/otas/new` (`listTenants`, with the session of `api`). A failed call only costs the
 * notice: the wizard opens as before and the review's `tenant_limit` message remains.
 */
export async function loadTenantLimit(api: PlatformApi): Promise<TenantLimit | undefined> {
  const tenants = await api.GET("/v1/tenants");
  return tenants.data?.tenantLimit;
}

/**
 * The reason a new OTA would be refused, as visible text (FIX-W69-LIMIT): on the dashboard next to the disabled
 * "Create an OTA" (which names it with `aria-describedby`, so give it `id`), and above the create-OTA wizard's first
 * step. Nothing below the limit. A note, not an alert: nothing went wrong, and the page does not announce it.
 */
export function TenantLimitNotice({
  limit,
  id,
}: {
  readonly limit: TenantLimit | undefined;
  readonly id?: string;
}) {
  if (!tenantLimitReached(limit)) {
    return null;
  }
  return (
    <p id={id} className="rounded-lg border px-4 py-3 text-sm" data-notice="tenant-limit">
      {WIZARD_STRINGS.tenantLimitReached(limit.owned, limit.max)}
    </p>
  );
}
