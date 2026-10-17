// The rules of an OTA's key (platform/docs/scope.md PF-10 AC1, platform/docs/flows/signup-and-create-ota.md step 6):
// the key names the tenant schema `tenant_<key>` and the storefront host `<key>.<STOREFRONT_BASE_DOMAIN>`, so it is a
// DNS label of 3 to 30 lower-case letters and digits that starts with a letter (`TenantKey` of the OpenAPI document,
// `tenants_key_dns_ck` of migration 0002). It is never one of the reserved names below, and never a key that any
// tenant row has or had: a deleted or failed OTA keeps its key, so the check reads every row in any status.
//
// `checkTenantKey` (the wizard's live check) answers `available: false` with the first problem: `invalid`, then
// `reserved`, then `taken`; `createTenant` (PBE-018) applies the same rules again, because a key can be taken between
// the check and the submit.

/** The key rule: a DNS label of 3–30 lower-case letters and digits that starts with a letter. */
export const TENANT_KEY_PATTERN = /^[a-z][a-z0-9]{2,29}$/;

/**
 * The names no OTA may take (the sign-up flow, step 6): the schemas of the cluster, the hosts and paths Velexis uses
 * or may use, and words that would mislead a traveller. Every one of them is a valid key otherwise; the baseline's
 * CHECK constraint on `platform.tenants.key` refuses the first eight as well.
 */
export const RESERVED_TENANT_KEYS: readonly string[] = Object.freeze([
  "platform",
  "reference",
  "public",
  "admin",
  "api",
  "www",
  "app",
  "console",
  "mail",
  "static",
  "assets",
  "cdn",
  "status",
  "help",
  "docs",
  "support",
  "billing",
  "login",
  "auth",
  "test",
  "demo",
]);

/** Why a key cannot be used: it breaks the rule, it is reserved, or a tenant row has it. */
export type TenantKeyUnavailableReason = "invalid" | "reserved" | "taken";

/** True when `key` follows the key rule (TENANT_KEY_PATTERN). */
export function isValidTenantKey(key: string): boolean {
  return TENANT_KEY_PATTERN.test(key);
}

/** True when `key` is on the reserved list. */
export function isReservedTenantKey(key: string): boolean {
  return RESERVED_TENANT_KEYS.includes(key);
}

/**
 * The problem of a key that needs no database: `invalid` or `reserved`; `undefined` when the key may be used unless
 * a tenant row has it.
 */
export function tenantKeyProblem(key: string): Exclude<TenantKeyUnavailableReason, "taken"> | undefined {
  if (!isValidTenantKey(key)) {
    return "invalid";
  }
  return isReservedTenantKey(key) ? "reserved" : undefined;
}

/**
 * The storefront host of a key: `<key>.<baseDomain>` (`acme.ota.example.com`), with STOREFRONT_BASE_DOMAIN as the
 * base. The key is put in as given; for a valid key the result is a valid host name.
 */
export function storefrontHost(key: string, baseDomain: string): string {
  return `${key}.${baseDomain}`;
}
