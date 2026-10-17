// Optimistic locking over HTTP (platform/docs/api-inventory.md §2): a PATCH takes `If-Match: "<version>"`, a stale
// version answers `412 PRECONDITION_FAILED`, and the answers of versioned resources carry the version in `ETag`. The
// two helpers live here, in layer 0, so that every module's controller shares one behaviour without importing a
// module of its own layer (architecture §2.2): the tenant profile (PBE-017) and the team routes (PBE-025) use them.
import { AppError } from "@velexis/errors";

/** The ETag of a versioned resource: its version as a quoted string (`"3"`), as `If-Match` sends it back. */
export function etagOf(version: number): string {
  return `"${version}"`;
}

/** The version an `If-Match` value names (`"3"` → 3); the OpenAPI validation has checked the form. */
export function versionOfIfMatch(value: string): number {
  const match = /^"([0-9]+)"$/.exec(value);
  const version = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(version)) {
    throw new AppError("PRECONDITION_FAILED");
  }
  return version;
}
