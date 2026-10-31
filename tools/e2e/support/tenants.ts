// OTAs of the platform admin journeys (PAD-010), arranged as their owner would arrange them: through the portal's own
// operations `createTenant` and `getTenant` (PADR-0017 item 5: through the public API where an operation exists).
//
//   const account = await createVerifiedAccount(buildAccount({ fullName: "Owner" }));
//   const session = await signInWithApi(account);                     // also the owner's portal cookies, if needed
//   const owner = { account, accessToken: session.accessToken };
//   const ota = await createOtaWithApi(owner);                         // `provisioning`, its set-up job dispatched
//   await waitForOtaStatus(owner, ota.id, "active");                   // the OTA worker built its schema (E2E_WITH_OTA=1)
//
// `withAvailableOfficesHeld` arranges the one state of the office pool that no operation can: a set-up that finds no
// available office (flows/provisioning.md §3 `assign_amadeus_office`, PADR-0012), so the new OTA's Velexis connection
// waits for an office (`pending_verification`) as it does when the pool is empty. It does not empty the shared pool:
// for as long as its callback runs, a transaction of the platform API's own role holds the row locks of the
// environment's available offices, which the set-up step passes over (`FOR UPDATE SKIP LOCKED`); it changes no row and
// rolls back. Another OTA set up in the same seconds also gets no office, so a journey holds the pool only while its
// own OTA is set up.
import { randomBytes, randomUUID } from "node:crypto";
import type { components } from "@velexis/api-types/platform";
import { callPlatformApi, type PortalAccount } from "./fixtures";
import { withDatabase } from "./seed";

type Schemas = components["schemas"];

/** An OTA as `getTenant` answers it to its owner. */
export type Ota = Schemas["Tenant"];
/** A status of an OTA. */
export type OtaStatus = Schemas["TenantStatus"];
/** An environment of the Amadeus accounts and offices. */
export type AmadeusEnvironment = Schemas["Environment"];

/** How long `waitForOtaStatus` waits by default: PF-11 sets up an OTA within a minute (about 2 s locally). */
export const OTA_STATUS_TIMEOUT_MS = 45_000;
/** How often `waitForOtaStatus` asks `getTenant`. */
export const OTA_STATUS_INTERVAL_MS = 250;

/** `TenantKey` (`^[a-z][a-z0-9]{2,29}$`): `prefix` (lower-case letters) and 10 random hex digits, unique per call. */
export function uniqueOtaKey(prefix = "adm"): string {
  if (!/^[a-z]{1,19}$/.test(prefix)) {
    throw new TypeError("an OTA key prefix is 1 to 19 lower-case letters");
  }
  return `${prefix}${randomBytes(5).toString("hex")}`;
}

/** What `createOtaWithApi` sends: `CreateTenantRequest` with a unique key and a name after it by default. */
export function otaInput(
  overrides: Partial<Schemas["CreateTenantRequest"]> = {},
): Schemas["CreateTenantRequest"] {
  const key = overrides.key ?? uniqueOtaKey();
  return {
    key,
    name: `E2E Travel ${key}`,
    countryCode: "NO",
    defaultCurrency: "EUR",
    timeZone: "Europe/Oslo",
    ...overrides,
  };
}

/** An OTA owner signed in to the portal: the account and the access token of one of its sessions (`signInWithApi`). */
export interface SignedInOwner {
  readonly account: PortalAccount;
  readonly accessToken: string;
}

/**
 * Creates an OTA owned by `owner` (a verified account) through `createTenant`, as the portal's wizard does, with a new
 * `Idempotency-Key`, and resolves to the new OTA (`provisioning`; its set-up job is dispatched at once before M5).
 */
export async function createOtaWithApi(
  owner: SignedInOwner,
  overrides: Partial<Schemas["CreateTenantRequest"]> = {},
): Promise<Ota> {
  const created = await callPlatformApi<Schemas["TenantCreated"]>({
    operation: "createTenant",
    method: "POST",
    path: "/v1/tenants",
    endUserIp: owner.account.endUserIp,
    accessToken: owner.accessToken,
    headers: { "Idempotency-Key": randomUUID() },
    body: otaInput(overrides),
  });
  return created.tenant;
}

/** The OTA `tenantId` as its owner sees it (`getTenant`). */
export async function getOtaWithApi(owner: SignedInOwner, tenantId: string): Promise<Ota> {
  return await callPlatformApi<Ota>({
    operation: "getTenant",
    method: "GET",
    path: `/v1/tenants/${encodeURIComponent(tenantId)}`,
    endUserIp: owner.account.endUserIp,
    accessToken: owner.accessToken,
  });
}

export interface WaitForOtaStatusOptions {
  /** Default OTA_STATUS_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** Default OTA_STATUS_INTERVAL_MS. */
  readonly intervalMs?: number;
}

/**
 * Asks `getTenant` until the OTA has `status`, and resolves to it. Fails at once when the set-up failed (`failed`
 * while waiting for another status), and after `timeoutMs` with the last status seen.
 */
export async function waitForOtaStatus(
  owner: SignedInOwner,
  tenantId: string,
  status: OtaStatus,
  options: WaitForOtaStatusOptions = {},
): Promise<Ota> {
  const deadline = Date.now() + (options.timeoutMs ?? OTA_STATUS_TIMEOUT_MS);
  for (;;) {
    const ota = await getOtaWithApi(owner, tenantId);
    if (ota.status === status) {
      return ota;
    }
    if (ota.status === "failed") {
      throw new Error(`the OTA ${ota.key} failed to set up while the journey waited for "${status}"`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`the OTA ${ota.key} is still "${ota.status}", not "${status}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? OTA_STATUS_INTERVAL_MS));
  }
}

/**
 * Runs `fn` while a transaction of the platform role holds the row locks (`FOR UPDATE`) of every available office of
 * the Velexis Amadeus account of `environment`, then rolls the transaction back: nothing is written. An OTA set up
 * meanwhile finds no office (see the file header). Resolves to the result of `fn` and to the number of offices held.
 *
 * `fn` must end within the platform role's `idle_in_transaction_session_timeout` (60 s, deploy/postgres/bootstrap.sql),
 * which `waitForOtaStatus`'s default of 45 s keeps to: after it the server ends the session, which frees the locks and
 * fails the journey on the lost connection instead of letting it pass unnoticed.
 */
export async function withAvailableOfficesHeld<T>(
  environment: AmadeusEnvironment,
  fn: () => Promise<T>,
): Promise<{ readonly result: T; readonly heldOffices: number }> {
  return await withDatabase("platform", async (client) => {
    await client.query("BEGIN");
    try {
      const held = await client.query(
        `SELECT o.id
           FROM platform.amadeus_offices o
           JOIN platform.amadeus_accounts a ON a.id = o.amadeus_account_id
          WHERE a.environment = $1 AND o.status = 'available'
            FOR UPDATE OF o`,
        [environment],
      );
      return { result: await fn(), heldOffices: held.rowCount ?? 0 };
    } finally {
      await client.query("ROLLBACK");
    }
  });
}
