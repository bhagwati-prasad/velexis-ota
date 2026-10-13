/**
 * Associated data that binds a ciphertext to its place (ADR-0010): `"<schema>.<table>.<column>:<rowId>"`.
 * A ciphertext copied to another column, row or tenant schema then fails to decrypt.
 */

/** Lower-case PostgreSQL identifier (at most 63 bytes), so that `.` and `:` can never appear in one. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
/** Row ids are printable ASCII without spaces (prefixed ULIDs such as `sup_01J…`). */
const ROW_ID = /^[\x21-\x7e]{1,255}$/;

function assertIdentifier(name: "schema" | "table" | "column", value: string): void {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`aadFor(): ${name} must be a lower-case SQL identifier`);
  }
}

/**
 * Returns the associated data of one encrypted column value, for example
 * `aadFor("platform", "supplier_connections", "client_secret_ciphertext", "sup_01J…")` gives
 * `"platform.supplier_connections.client_secret_ciphertext:sup_01J…"`.
 *
 * Every part is validated, so two different places never produce the same string: identifiers cannot
 * contain `.` or `:`, and the row id is everything after the first `:`.
 */
export function aadFor(schema: string, table: string, column: string, rowId: string): string {
  assertIdentifier("schema", schema);
  assertIdentifier("table", table);
  assertIdentifier("column", column);
  if (typeof rowId !== "string" || !ROW_ID.test(rowId)) {
    throw new TypeError("aadFor(): rowId must be 1 to 255 printable ASCII characters without spaces");
  }
  return `${schema}.${table}.${column}:${rowId}`;
}
