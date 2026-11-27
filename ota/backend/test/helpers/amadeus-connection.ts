// Test support: a tenant's Amadeus connection of one environment, written as the platform writes it (X-055, plan key
// HT-00; multi-supplier plan §4.7 and §4.15; ADR-0030 item 21, item 18 proposed).
//
//   const connectionId = await setAmadeusConnection(writer, {
//     tenantId, source: "velexis", amadeusAccountId, officeIds: [office],          // today's row: the shared account
//   });
//   await setAmadeusConnection(writer, {
//     tenantId, source: "tenant", officeIds: [office],                            // the OTA's own credentials
//     own: { baseUrl: stub.url, clientId, clientSecret },
//   });
//
// One function, two sources. `velexis` is the row 43 integration files insert inline: the Velexis account of the
// environment, no host, client id or secret of its own. `tenant` is the row of own-credentials.int.test.ts's
// `switchToOwn`, as the platform applies a verified submission (PBE-053): no account, the OTA's own `base_url`, client
// id and client secret (sealed with the test KEK for the row's own associated data,
// `platform.supplier_connections.client_secret_ciphertext:<sc_id>`, as the platform re-encrypts it), its own offices,
// `active` and verified now. The first office is the default, queuing and owner office, as provisioning leaves them.
//
// The row is written as velexis_migrator (the owner of the platform tables, which the test plays): inserted when the
// tenant has no connection of that environment, else updated in place (same id, `version + 1`), so a test can switch
// a connection and back. Columns the source does not decide (`monitored_queues`, `ticketing_defaults`) are kept on an
// update unless given. Then the platform's `connection` invalidation is published on `vx:invalidate`, so a running API
// or worker reads the row again at once (its PlatformCache drops `conn:amadeus:<tenantId>:<env>`). The Velexis offices
// of the pool are not touched: a test that needs one `releasing` writes it itself.
//
// Why: the 15 Amadeus-only operations (the 12 `console.amadeus.*`, two queue operations and PNR import) are for an OTA
// with its own active Amadeus connection (ADR-0030 item 21; OBE-106 refuses them to every other OTA). The suites of
// those tools run on an OTA made by this function, with the same assertions, so no tool test is removed. The client
// secret is the test's own random value; it is never logged.
import { INVALIDATION_CHANNEL, type ConnectionInvalidation } from "@velexis/api-types/jobs";
import { encryptValue, type KeyProvider } from "@velexis/crypto";
import type { Kysely, PlatformDatabase } from "@velexis/db";
import { newId } from "../../src/common/ids";
import type { AmadeusEnvironment } from "../../src/tenancy/platform-read.repository";

/** What writes the row and publishes the invalidation. */
export interface AmadeusConnectionWriter {
  /** velexis_migrator, the owner of the platform tables. */
  readonly migrator: Kysely<PlatformDatabase>;
  /** A Redis client of the test's Redis (`redis.client` of `useRedis()`): it publishes on `vx:invalidate`. */
  readonly publisher: { publish(channel: string, message: string): Promise<unknown> };
  /** The KEKs of MASTER_KEY_DIR (`testKeyProvider()`), which seal an own client secret; `velexis` needs none. */
  readonly keys?: KeyProvider | undefined;
}

/** The OTA's own credential set, in clear, held by the test only. */
export interface OwnAmadeusCredentials {
  /** The OTA's own host (the stub's URL in a test). */
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

interface AmadeusConnectionBase {
  readonly tenantId: string;
  /** Default `test`. */
  readonly environment?: AmadeusEnvironment | undefined;
  /** The connection's offices; the first is its default, queuing and owner office. */
  readonly officeIds: readonly [string, ...string[]];
  /** `monitored_queues` ([{officeId, queueId, category}]); an insert without it writes `[]`, an update keeps it. */
  readonly monitoredQueues?: readonly Record<string, unknown>[] | undefined;
}

/** Today's row: the tenant on the Velexis account of the environment. */
export interface VelexisAmadeusConnection extends AmadeusConnectionBase {
  readonly source: "velexis";
  readonly amadeusAccountId: string;
}

/** The OTA's own credentials, as the platform applies a verified submission. */
export interface OwnAmadeusConnection extends AmadeusConnectionBase {
  readonly source: "tenant";
  readonly own: OwnAmadeusCredentials;
}

export type AmadeusConnectionInput = VelexisAmadeusConnection | OwnAmadeusConnection;

/** The columns each source decides; `null` where the CHECK `supplier_connections_source_ck` wants none. */
async function sourceColumns(writer: AmadeusConnectionWriter, input: AmadeusConnectionInput, id: string) {
  if (input.source === "velexis") {
    return {
      credential_source: "velexis",
      amadeus_account_id: input.amadeusAccountId,
      base_url: null,
      client_id: null,
      client_secret_ciphertext: null,
      encryption_key_id: null,
      last_verified_at: null,
    } as const;
  }
  if (writer.keys === undefined) {
    throw new TypeError("setAmadeusConnection: an own connection needs the KEKs that seal its client secret");
  }
  const { ciphertext, kekId } = await encryptValue(input.own.clientSecret, {
    aad: `platform.supplier_connections.client_secret_ciphertext:${id}`,
    keys: writer.keys,
  });
  return {
    credential_source: "tenant",
    amadeus_account_id: null,
    base_url: input.own.baseUrl,
    client_id: input.own.clientId,
    client_secret_ciphertext: ciphertext,
    encryption_key_id: kekId,
    last_verified_at: new Date(),
  } as const;
}

/**
 * Sets the Amadeus connection of `input.tenantId` in `input.environment` (default `test`) to `input.source` (the file
 * header), `active`, in one transaction as velexis_migrator, then publishes the `connection` invalidation. Resolves to
 * the connection's id (`sc_…`): the credential set of an own connection, whose per-credential bucket a test may reset.
 */
export async function setAmadeusConnection(
  writer: AmadeusConnectionWriter,
  input: AmadeusConnectionInput,
): Promise<string> {
  const environment = input.environment ?? "test";
  const [office] = input.officeIds;
  const id = await writer.migrator.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom("platform.supplier_connections")
      .select("id")
      .where("tenant_id", "=", input.tenantId)
      .where("provider", "=", "amadeus")
      .where("environment", "=", environment)
      .forUpdate()
      .executeTakeFirst();
    const connectionId = existing?.id ?? newId("sc");
    const columns = {
      ...(await sourceColumns(writer, input, connectionId)),
      office_ids: [...input.officeIds],
      default_office_id: office,
      queuing_office_id: office,
      owner_office_id: office,
      last_error: null,
      status: "active",
      ...(input.monitoredQueues === undefined
        ? {}
        : { monitored_queues: JSON.stringify(input.monitoredQueues) }),
    };
    if (existing === undefined) {
      await trx
        .insertInto("platform.supplier_connections")
        .values({ id: connectionId, tenant_id: input.tenantId, provider: "amadeus", environment, ...columns })
        .execute();
    } else {
      await trx
        .updateTable("platform.supplier_connections")
        .set((eb) => ({ ...columns, version: eb("version", "+", 1), updated_at: new Date() }))
        .where("id", "=", connectionId)
        .execute();
    }
    return connectionId;
  });
  const event: ConnectionInvalidation = { v: 1, type: "connection", tenantId: input.tenantId };
  await writer.publisher.publish(INVALIDATION_CHANNEL, JSON.stringify(event));
  return id;
}
