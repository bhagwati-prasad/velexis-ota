// The row sources of `secrets:rewrap` (OBE-100; ADR-0010 "Rotation" item 3, packages/crypto/README.md "KEK rotation"):
// every ciphertext column set of a tenant schema, read and written through `tenantTx` as velexis_ota_app.
//
// Each source is one table of the tenant baseline (migrations/tenant/0001_baseline.sql) with the `*_ciphertext` columns
// that its `encryption_key_id` covers, and the associated data its writer seals them with,
// `tenant_<key>.<table>.<column>:<row id>` (aadFor of @velexis/crypto):
//
//   saved_travelers            discount_eligibility_ciphertext                    no MVP writer yet (B1 saved travellers)
//   saved_traveler_documents   number_ciphertext, details_ciphertext              no MVP writer yet (B1 saved travellers)
//   checkout_travelers         documents_ciphertext, discount_eligibility_ciphertext   checkout/traveler-documents.ts
//   booking_travelers          documents_ciphertext, discount_eligibility_ciphertext   bookings/order-recorder.ts
//   notifications              secret_payload_ciphertext                          notifications/outbox.service.ts
//   idempotency_keys           response_ciphertext                                common/http/idempotency.service.ts
//
// A row's ciphertexts share one `encryption_key_id`, so they move together in one update. `booking_documents` has an
// `encryption_key_id` but no ciphertext column (the key of an object-storage file, which no writer sets yet): it is not
// a source. The integration test compares this list with the catalog, so a migration that adds a ciphertext column
// fails it until the column has its source here.
//
// The queries follow rewrapBatch's contract: `fetch` reads one keyset page (`id > afterId ORDER BY id LIMIT n`, no lock)
// of the rows that hold a ciphertext and whose `encryption_key_id` is not the current KEK, filtered in the WHERE clause,
// never after the LIMIT; `update` writes the new ciphertexts and `encryption_key_id` of one row only while every
// ciphertext column and the `encryption_key_id` still hold what was read (`IS NOT DISTINCT FROM`, NULLs included), and
// nothing else (not `version`, not `updated_at`: the plaintext does not change). Each page and each update is a short
// transaction of its own, so a run holds no lock across rows and a run that stops keeps what it wrote.
//
// Identifiers come from the constant list below only (quoted by Kysely's `sql.table` and `sql.ref`); values travel as
// bound parameters. Nothing here logs: rows go to rewrapBatch, which returns counts.
import type { RewrapChange, RewrapPage, RewrapRow } from "@velexis/crypto";
import { isTenantSchema, sql, tenantTx, type Kysely, type TenantDb, type TenantSchema } from "@velexis/db";

/** One ciphertext column set of a tenant table: the columns its `encryption_key_id` covers. */
export interface CiphertextSource {
  /** The tenant table, resolved through the `search_path` of `tenantTx` (`<schema>, reference`). */
  readonly table: string;
  /** Its `*_ciphertext` columns, sealed with `aadFor(schema, table, column, id)` and sharing `encryption_key_id`. */
  readonly columns: readonly string[];
}

/** Every ciphertext column set of a tenant schema, in the order of the tenant baseline (see the file header). */
export const REWRAP_SOURCES: readonly CiphertextSource[] = Object.freeze([
  Object.freeze({ table: "saved_travelers", columns: Object.freeze(["discount_eligibility_ciphertext"]) }),
  Object.freeze({
    table: "saved_traveler_documents",
    columns: Object.freeze(["number_ciphertext", "details_ciphertext"]),
  }),
  Object.freeze({
    table: "checkout_travelers",
    columns: Object.freeze(["documents_ciphertext", "discount_eligibility_ciphertext"]),
  }),
  Object.freeze({
    table: "booking_travelers",
    columns: Object.freeze(["documents_ciphertext", "discount_eligibility_ciphertext"]),
  }),
  Object.freeze({ table: "notifications", columns: Object.freeze(["secret_payload_ciphertext"]) }),
  Object.freeze({ table: "idempotency_keys", columns: Object.freeze(["response_ciphertext"]) }),
]);

/**
 * `RewrapRow.kekId` of a row that holds a ciphertext but no `encryption_key_id` (only `saved_travelers` has no CHECK
 * against it): the empty string, which is never a KEK id (1 to 255 printable characters), so the optimistic check can
 * tell it apart. A re-wrap sets the column.
 */
export const NO_KEK_ID = "";

/** The rows and counts of the sources of one tenant schema, as rewrapBatch and the command's report need them. */
export interface RewrapStore {
  /** The rows of `source` not under `page.currentKekId` that hold a ciphertext, one keyset page (rewrapBatch `fetch`). */
  fetch(schema: TenantSchema, source: CiphertextSource, page: RewrapPage): Promise<readonly RewrapRow[]>;
  /** Writes one row's re-wrapped values under the optimistic check; `false` when the row changed (rewrapBatch `update`). */
  update(schema: TenantSchema, source: CiphertextSource, change: RewrapChange): Promise<boolean>;
  /** The rows of `source` that hold a ciphertext and are not under `currentKekId`, by `encryption_key_id`. */
  countNotUnder(
    schema: TenantSchema,
    source: CiphertextSource,
    currentKekId: string,
  ): Promise<Readonly<Record<string, number>>>;
}

interface SourceRow {
  readonly id: string;
  readonly encryption_key_id: string | null;
  readonly [column: string]: unknown;
}

/** `<column> IS NOT NULL OR …`: the row holds at least one ciphertext. */
function holdsCiphertext(source: CiphertextSource) {
  return sql.join(
    source.columns.map((column) => sql`${sql.ref(column)} IS NOT NULL`),
    sql` OR `,
  );
}

/** A ciphertext as read, or `null`; anything else means the column is not `bytea` (a programming error). */
function ciphertextOf(value: unknown, column: string): Buffer | null {
  if (value === null || Buffer.isBuffer(value)) {
    return value;
  }
  throw new TypeError(`secrets:rewrap: ${column} is not read as bytea`);
}

/** `RewrapStore` on the tenant schemas of `tenants` (velexis_ota_app), one `tenantTx` per page and per update. */
export class RewrapRepository implements RewrapStore {
  constructor(private readonly tenants: TenantDb) {}

  async fetch(
    schema: TenantSchema,
    source: CiphertextSource,
    page: RewrapPage,
  ): Promise<readonly RewrapRow[]> {
    const afterId = page.afterId === null ? sql`` : sql`AND ${sql.ref("id")} > ${page.afterId}`;
    const rows = await tenantTx(this.tenants, schema, async (trx) => {
      const { rows: found } = await sql<SourceRow>`
        SELECT ${sql.ref("id")}, ${sql.ref("encryption_key_id")}, ${sql.join(source.columns.map((column) => sql.ref(column)))}
        FROM ${sql.table(source.table)}
        WHERE ${sql.ref("encryption_key_id")} IS DISTINCT FROM ${page.currentKekId}
          AND (${holdsCiphertext(source)})
          ${afterId}
        ORDER BY ${sql.ref("id")}
        LIMIT ${page.limit}
      `.execute(trx);
      return found;
    });
    return rows.map((row) => ({
      id: row.id,
      kekId: row.encryption_key_id ?? NO_KEK_ID,
      ciphertexts: Object.fromEntries(
        source.columns.map((column) => [column, ciphertextOf(row[column], column)]),
      ),
    }));
  }

  async update(schema: TenantSchema, source: CiphertextSource, change: RewrapChange): Promise<boolean> {
    const written = Object.entries(change.ciphertexts);
    if (written.length === 0) {
      return false;
    }
    const previousKekId = change.previous.kekId === NO_KEK_ID ? null : change.previous.kekId;
    const unchanged = source.columns.map((column) => {
      const previous = change.previous.ciphertexts[column] ?? null;
      return sql`${sql.ref(column)} IS NOT DISTINCT FROM ${previous === null ? null : Buffer.from(previous)}`;
    });
    const result = await tenantTx(this.tenants, schema, async (trx) => {
      return await sql`
        UPDATE ${sql.table(source.table)}
        SET ${sql.join([
          ...written.map(([column, value]) => sql`${sql.ref(checkedColumn(source, column))} = ${value}`),
          sql`${sql.ref("encryption_key_id")} = ${change.kekId}`,
        ])}
        WHERE ${sql.ref("id")} = ${change.id}
          AND ${sql.ref("encryption_key_id")} IS NOT DISTINCT FROM ${previousKekId}
          AND ${sql.join(unchanged, sql` AND `)}
      `.execute(trx);
    });
    return (result.numAffectedRows ?? 0n) > 0n;
  }

  async countNotUnder(
    schema: TenantSchema,
    source: CiphertextSource,
    currentKekId: string,
  ): Promise<Readonly<Record<string, number>>> {
    const rows = await tenantTx(this.tenants, schema, async (trx) => {
      const { rows: found } = await sql<{ kek_id: string | null; rows: string }>`
        SELECT ${sql.ref("encryption_key_id")} AS kek_id, count(*) AS rows
        FROM ${sql.table(source.table)}
        WHERE ${sql.ref("encryption_key_id")} IS DISTINCT FROM ${currentKekId}
          AND (${holdsCiphertext(source)})
        GROUP BY ${sql.ref("encryption_key_id")}
      `.execute(trx);
      return found;
    });
    return sortedCounts(rows.map((row) => [row.kek_id ?? NO_KEK_ID, Number(row.rows)]));
  }
}

/** A column `update` may set: one of the source's ciphertext columns, never anything rewrapBatch did not read. */
function checkedColumn(source: CiphertextSource, column: string): string {
  if (!source.columns.includes(column)) {
    throw new TypeError(`secrets:rewrap: ${column} is not a ciphertext column of ${source.table}`);
  }
  return column;
}

/** Counts by KEK id in KEK id order, as rewrapBatch's `remainingByKekId`. */
export function sortedCounts(entries: Iterable<readonly [string, number]>): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const [kekId, rows] of entries) {
    counts.set(kekId, (counts.get(kekId) ?? 0) + rows);
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The tenant schemas of the database, from the catalog (`pg_namespace`, readable by every role), in name order: every
 * schema named `tenant_<key>`, whatever the status of its tenant (a suspended, deprovisioning or deleted OTA whose
 * schema still exists has values under the old KEK too). `db` is any handle on the OTA pool; no tenant table is read.
 */
export async function tenantSchemas<DB>(db: Kysely<DB>): Promise<TenantSchema[]> {
  const { rows } = await sql<{ name: string }>`
    SELECT nspname AS name FROM pg_catalog.pg_namespace
    WHERE nspname LIKE ${"tenant\\_%"} ORDER BY nspname
  `.execute(db);
  // `TENANT_SCHEMA_PATTERN` of @velexis/db: a schema `tenantTx` would refuse is no tenant schema.
  return rows.map((row) => row.name).filter(isTenantSchema);
}
