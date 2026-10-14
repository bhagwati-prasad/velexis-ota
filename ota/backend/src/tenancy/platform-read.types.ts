// What the OTA backend reads from the platform tables (platform architecture §6.2, ota/docs/data-model.md §2.1): plain,
// JSON-safe objects that the tenancy caches (OADR-0009 point 4) can store as they are. The value lists are the CHECK
// lists of platform.tenants (platform migrations 0001 and 0002); a value outside them is refused, never passed on.
import type { TenantSchema } from "@velexis/db";

/** `platform.tenants.status`. Only `active` tenants are served (OADR-0009 point 2, PADR-0014). */
export const TENANT_STATUSES = [
  "provisioning",
  "active",
  "suspended",
  "deprovisioning",
  "deleted",
  "failed",
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** `platform.tenants.storefront_environment`: the environment of the hosted storefront and its edge requests. */
export const STOREFRONT_ENVIRONMENTS = ["test", "live"] as const;
export type StorefrontEnvironment = (typeof STOREFRONT_ENVIRONMENTS)[number];

/** `platform.tenants.billing_notice`: the billing banner of the OTA admin; `null` when there is none. */
export const BILLING_NOTICES = ["past_due", "trial_ending"] as const;
export type BillingNotice = (typeof BILLING_NOTICES)[number];

/** A row of `platform.tenants`, as far as the OTA backend relies on it. */
export interface PlatformTenant {
  /** `ten_` + ULID. */
  readonly id: string;
  /** The immutable short key: the `<key>.ota.example.com` sub-domain and the schema name's suffix. */
  readonly key: string;
  /** The OTA's display name. */
  readonly name: string;
  readonly status: TenantStatus;
  /** `tenant_<key>`, checked with `assertTenantSchema` before it is returned: the only schema name `tenantTx` gets. */
  readonly schemaName: TenantSchema;
  readonly storefrontEnvironment: StorefrontEnvironment;
  /** ISO 4217 code, such as `EUR`. */
  readonly defaultCurrency: string;
  /** BCP 47 locale, such as `en`. */
  readonly defaultLocale: string;
  readonly billingNotice: BillingNotice | null;
}

/**
 * A platform row holds a value the OTA backend does not know, for example a status that a newer platform migration
 * added. The row is refused, as one with a malformed schema name is (`InvalidTenantSchemaError` of `@velexis/db`).
 */
export class UnexpectedPlatformValueError extends Error {
  override readonly name = "UnexpectedPlatformValueError";

  constructor(
    /** The column, schema-qualified: `platform.tenants.status`. */
    readonly column: string,
    /** The id of the row. */
    readonly rowId: string,
    value: unknown,
    allowed: readonly string[],
  ) {
    super(`${column} of ${rowId} is ${describe(value)}, not one of ${allowed.join(", ")}`);
  }
}

const MAX_SHOWN = 64;

/** The refused value for the message: a quoted, shortened string, or its type. These columns hold no personal data. */
function describe(value: unknown): string {
  if (typeof value !== "string") {
    return value === null ? "null" : `a ${typeof value}`;
  }
  return JSON.stringify(value.length > MAX_SHOWN ? `${value.slice(0, MAX_SHOWN)}…` : value);
}
