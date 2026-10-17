// Builders for an OTA and its people (PBE-017), on top of the row builders of platform-rows.ts: the membership row,
// and `insertOta`, which writes what createTenant (PBE-018) leaves behind for a tenant: the tenant row and its verified
// primary storefront sub-domain `<key>.<base domain>`, optionally with a subscription and members. Tests arrange their
// own OTAs with them instead of sharing fixtures (conventions §10).
//
//   const owner = await insertAccount(pool);
//   const { tenant } = await insertOta(pool, { members: [[owner, "owner"]] });
//   const viewer = await insertMember(pool, tenant, await insertAccount(pool), "viewer");
import { defineBuilder, type Builder, type BuilderOverrides } from "@velexis/testing";
import type { TenantRole } from "../../src/memberships/tenant-roles";
import {
  insertRow,
  insertSubscription,
  insertTenant,
  insertTenantDomain,
  testId,
  type PlatformInsert,
  type PlatformRow,
  type Queryable,
  type SubscriptionRow,
  type TenantRow,
} from "./platform-rows";

/** The storefront base domain of the test applications (TEST_STOREFRONT_BASE_DOMAIN of test/support/app.ts). */
export const TEST_BASE_DOMAIN = "ota.example.com";

/** `platform.tenant_memberships`: an active `viewer`; the insert takes the tenant and the account. */
export type MembershipRow = Omit<PlatformInsert<"tenant_memberships">, "tenant_id" | "account_id">;
export const buildMembership: Builder<MembershipRow> = defineBuilder<MembershipRow>((n) => ({
  id: testId("stf", n),
  role: "viewer",
  status: "active",
}));

type Ref = { readonly id: string };

/** Writes a membership of `account` in `tenant`. */
export function insertMembership(
  db: Queryable,
  tenant: Ref,
  account: Ref,
  overrides?: BuilderOverrides<MembershipRow>,
): Promise<PlatformRow<"tenant_memberships">> {
  return insertRow(db, "tenant_memberships", {
    ...buildMembership(overrides),
    tenant_id: tenant.id,
    account_id: account.id,
  });
}

/** Writes an active membership of `account` in `tenant` with `role`. */
export function insertMember(
  db: Queryable,
  tenant: Ref,
  account: Ref,
  role: TenantRole,
): Promise<PlatformRow<"tenant_memberships">> {
  return insertMembership(db, tenant, account, { role });
}

/** What `insertOta` writes besides the tenant. */
export interface OtaOptions {
  readonly tenant?: BuilderOverrides<TenantRow>;
  /** The subscription; `undefined` writes none. */
  readonly subscription?: BuilderOverrides<SubscriptionRow>;
  /** Active members, in order. */
  readonly members?: ReadonlyArray<readonly [Ref, TenantRole]>;
}

/** An OTA as the portal sees it: the tenant, its primary sub-domain, its subscription and members, when asked for. */
export interface InsertedOta {
  readonly tenant: PlatformRow<"tenants">;
  readonly domain: PlatformRow<"tenant_domains">;
  readonly subscription: PlatformRow<"subscriptions"> | undefined;
  readonly memberships: ReadonlyArray<PlatformRow<"tenant_memberships">>;
}

/**
 * Writes an OTA (active, key `agency<n>`, unless `options.tenant` says otherwise) with its verified primary storefront
 * sub-domain `<key>.ota.example.com`, the subscription of `options.subscription` and the members of `options.members`.
 */
export async function insertOta(db: Queryable, options: OtaOptions = {}): Promise<InsertedOta> {
  const tenant = await insertTenant(db, options.tenant);
  const domain = await insertTenantDomain(db, tenant, {
    hostname: `${tenant.key}.${TEST_BASE_DOMAIN}`,
    is_primary: true,
  });
  const subscription =
    options.subscription === undefined
      ? undefined
      : await insertSubscription(db, tenant, options.subscription);
  const memberships: Array<PlatformRow<"tenant_memberships">> = [];
  for (const [account, role] of options.members ?? []) {
    memberships.push(await insertMember(db, tenant, account, role));
  }
  return { tenant, domain, subscription, memberships };
}
