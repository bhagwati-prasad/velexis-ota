// The row sources of `secrets:rewrap` (PBE-072; ADR-0010 "Rotation" item 3, packages/crypto/README.md "KEK rotation"):
// every ciphertext column set of the `platform` schema, read and written as velexis_platform_app, the role with DML on
// these tables (ADR-0004; velexis_migrator owns them; the platform never touches a tenant schema, whose values OBE-100's
// OTA command re-wraps).
//
// Each source is one table with the `*_ciphertext` columns that its key id column covers, and the associated data its
// writer seals them with, `platform.<table>.<column>:<row id>` (`associatedData` of common/crypto.provider.ts):
//
//   table                          ciphertext columns                             the place's writer (under src/)
//   accounts                       mfa_secret_ciphertext                          accounts/mfa.service.ts
//   amadeus_accounts               client_secret_ciphertext                       supplier-connections/amadeus-accounts.*
//   supplier_connections           client_secret_ciphertext                       ….amadeus-credentials.verifier.ts
//   payment_provider_connections   secret_ciphertext, webhook_secret_ciphertext   payment-connections/stripe-api-keys.*
//   credential_submissions         secret_ciphertext, webhook_secret_ciphertext   common/credentials/credential-submissions.*
//   tenant_payout_accounts         bank_details_ciphertext (row id `tenant_id`)   settlements/payout-accounts.service.ts
//   email_outbox                   secret_payload_ciphertext                      notifications/outbox.service.ts
//   provisioning_jobs              reveal_ciphertext (key id column               provisioning/post-steps/issue-api-keys.*
//                                  `reveal_encryption_key_id`)
//
// That is the list of platform-operations.md §8's query. A row's ciphertexts share one key id column, so they move
// together in one update and the column never names a KEK that does not wrap every value of the row. The integration
// test compares this list with the catalog, so a migration that adds a ciphertext column fails it until the column has
// its source here. The pending MFA set-ups in Redis (`mfasetup:<accountId>`, 10 minutes) and the OTA backend's
// 60-second caches of platform rows expire by themselves (master-key-rotation.md steps 6 and 8).
//
// The queries follow rewrapBatch's contract: `fetch` reads one keyset page (`<id> > afterId ORDER BY <id> LIMIT n`, no
// lock) of the rows that hold a ciphertext and whose key id is not the current KEK, filtered in the WHERE clause, never
// after the LIMIT; `update` writes the new ciphertexts and the key id of one row only while every ciphertext column and
// the key id still hold what was read (`IS NOT DISTINCT FROM`, NULLs included), and nothing else (not `version`, not
// `updated_at`: the plaintext does not change, and an ETag a person holds stays valid). Each statement runs on its own
// (autocommit), so a run holds no lock across rows and a run that stops keeps what it wrote.
//
// Identifiers come from the constant list below only (quoted by Kysely's `sql.table` and `sql.ref`); values travel as
// bound parameters. Nothing here logs: rows go to rewrapBatch, which returns counts.
import type { RewrapChange, RewrapPage, RewrapRow } from "@velexis/crypto";
import { sql } from "@velexis/db";
import type { PlatformDb } from "../common/database";

/** The schema of every source: the platform's own (ADR-0004). */
export const REWRAP_SCHEMA = "platform";

/** One ciphertext column set of a platform table: the columns its key id column covers. */
export interface CiphertextSource {
  /** The table in schema `platform`, unqualified. */
  readonly table: string;
  /** The primary key, the keyset cursor and the row id of the associated data: `id`, or `tenant_id`. */
  readonly idColumn: string;
  /** The column that names the KEK of the row's values: `encryption_key_id`, or `reveal_encryption_key_id`. */
  readonly kekIdColumn: string;
  /** Its `*_ciphertext` columns, sealed with `platform.<table>.<column>:<row id>`, sharing the key id column. */
  readonly columns: readonly string[];
}

function source(
  table: string,
  columns: readonly string[],
  ids: { readonly idColumn?: string; readonly kekIdColumn?: string } = {},
): CiphertextSource {
  return Object.freeze({
    table,
    idColumn: ids.idColumn ?? "id",
    kekIdColumn: ids.kekIdColumn ?? "encryption_key_id",
    columns: Object.freeze([...columns]),
  });
}

/** Every ciphertext column set of the platform schema, in the order of platform-operations.md §8 (file header). */
export const REWRAP_SOURCES: readonly CiphertextSource[] = Object.freeze([
  source("accounts", ["mfa_secret_ciphertext"]),
  source("amadeus_accounts", ["client_secret_ciphertext"]),
  source("supplier_connections", ["client_secret_ciphertext"]),
  source("payment_provider_connections", ["secret_ciphertext", "webhook_secret_ciphertext"]),
  source("credential_submissions", ["secret_ciphertext", "webhook_secret_ciphertext"]),
  source("tenant_payout_accounts", ["bank_details_ciphertext"], { idColumn: "tenant_id" }),
  source("email_outbox", ["secret_payload_ciphertext"]),
  source("provisioning_jobs", ["reveal_ciphertext"], { kekIdColumn: "reveal_encryption_key_id" }),
]);

/**
 * `RewrapRow.kekId` of a row that holds a ciphertext but no key id (only `accounts` has no CHECK against it): the empty
 * string, which is never a KEK id (1 to 255 printable characters), so the optimistic check can tell it apart. A
 * re-wrap sets the column.
 */
export const NO_KEK_ID = "";

/** Counts by KEK id, as rewrapBatch's `remainingByKekId`. */
export type KekCounts = Readonly<Record<string, number>>;

/** The rows and counts of the platform's sources, as rewrapBatch and the command's report need them. */
export interface RewrapStore {
  /** The rows of `source` not under `page.currentKekId` that hold a ciphertext: one page (rewrapBatch `fetch`). */
  fetch(source: CiphertextSource, page: RewrapPage): Promise<readonly RewrapRow[]>;
  /** Writes one row's new values under the optimistic check; `false` when the row changed (rewrapBatch `update`). */
  update(source: CiphertextSource, change: RewrapChange): Promise<boolean>;
  /** The rows of `source` that hold a ciphertext and are not under `currentKekId`, by key id. */
  countNotUnder(source: CiphertextSource, currentKekId: string): Promise<KekCounts>;
}

interface SourceRow {
  readonly row_id: string;
  readonly kek_id: string | null;
  readonly [column: string]: unknown;
}

/** `platform.<table>`, quoted. */
function tableOf(source: CiphertextSource) {
  return sql.table(`${REWRAP_SCHEMA}.${source.table}`);
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

/** A column `update` may set: one of the source's ciphertext columns, never anything rewrapBatch did not read. */
function checkedColumn(source: CiphertextSource, column: string): string {
  if (!source.columns.includes(column)) {
    throw new TypeError(`secrets:rewrap: ${column} is not a ciphertext column of ${source.table}`);
  }
  return column;
}

/** `RewrapStore` on the platform schema (as velexis_platform_app), one statement per page, count and update. */
export class RewrapRepository implements RewrapStore {
  constructor(private readonly db: PlatformDb) {}

  async fetch(source: CiphertextSource, page: RewrapPage): Promise<readonly RewrapRow[]> {
    const id = sql.ref(source.idColumn);
    const kekId = sql.ref(source.kekIdColumn);
    const afterId = page.afterId === null ? sql`` : sql`AND ${id} > ${page.afterId}`;
    const { rows } = await sql<SourceRow>`
      SELECT ${id} AS row_id, ${kekId} AS kek_id, ${sql.join(source.columns.map((column) => sql.ref(column)))}
      FROM ${tableOf(source)}
      WHERE ${kekId} IS DISTINCT FROM ${page.currentKekId}
        AND (${holdsCiphertext(source)})
        ${afterId}
      ORDER BY ${id}
      LIMIT ${page.limit}
    `.execute(this.db);
    return rows.map((row) => ({
      id: row.row_id,
      kekId: row.kek_id ?? NO_KEK_ID,
      ciphertexts: Object.fromEntries(
        source.columns.map((column) => [column, ciphertextOf(row[column], column)]),
      ),
    }));
  }

  async update(source: CiphertextSource, change: RewrapChange): Promise<boolean> {
    const written = Object.entries(change.ciphertexts);
    if (written.length === 0) {
      return false;
    }
    const kekId = sql.ref(source.kekIdColumn);
    const previousKekId = change.previous.kekId === NO_KEK_ID ? null : change.previous.kekId;
    const unchanged = source.columns.map((column) => {
      const previous = change.previous.ciphertexts[column] ?? null;
      return sql`${sql.ref(column)} IS NOT DISTINCT FROM ${previous === null ? null : Buffer.from(previous)}`;
    });
    const result = await sql`
      UPDATE ${tableOf(source)}
      SET ${sql.join([
        ...written.map(([column, value]) => sql`${sql.ref(checkedColumn(source, column))} = ${value}`),
        sql`${kekId} = ${change.kekId}`,
      ])}
      WHERE ${sql.ref(source.idColumn)} = ${change.id}
        AND ${kekId} IS NOT DISTINCT FROM ${previousKekId}
        AND ${sql.join(unchanged, sql` AND `)}
    `.execute(this.db);
    return (result.numAffectedRows ?? 0n) > 0n;
  }

  async countNotUnder(source: CiphertextSource, currentKekId: string): Promise<KekCounts> {
    const kekId = sql.ref(source.kekIdColumn);
    const { rows } = await sql<{ kek_id: string | null; rows: string }>`
      SELECT ${kekId} AS kek_id, count(*) AS rows
      FROM ${tableOf(source)}
      WHERE ${kekId} IS DISTINCT FROM ${currentKekId}
        AND (${holdsCiphertext(source)})
      GROUP BY ${kekId}
    `.execute(this.db);
    return sortedCounts(rows.map((row) => [row.kek_id ?? NO_KEK_ID, Number(row.rows)]));
  }
}

/** Counts by KEK id in KEK id order, as rewrapBatch's `remainingByKekId`. */
export function sortedCounts(entries: Iterable<readonly [string, number]>): KekCounts {
  const counts = new Map<string, number>();
  for (const [kekId, rows] of entries) {
    counts.set(kekId, (counts.get(kekId) ?? 0) + rows);
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
