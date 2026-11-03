// The `pendingSubmission` of an answered connection (PBE-053, PBE-057; FIX-W39-PLATFORM, lead decision (2k) of
// 2026-11-02): the one mapper of the Amadeus and the Stripe connections alike. CredentialSubmissionsService
// .pendingByEnvironment reads the tenant's latest submission of a kind in each environment (one query,
// CredentialSubmissionsRepository.latestByEnvironment) and keeps those `toPendingSubmission` shows; `toAmadeusConnection`
// and `toPaymentConnection` pick a connection's with `pendingSubmissionOf`. Every answer that carries a connection
// fills it: the portal's lists, the settings updates, the live request, the switch back to Velexis payments, the
// Connect callback, and the admin's tenant detail, connection status and office assignment.
import type { components } from "@velexis/api-types/platform";
import type { CredentialEnvironment, CredentialSubmissionView } from "./credential-submissions.repository";

/** The latest submission of a connection's environment, as an answered connection shows it (`pendingSubmission`). */
export type PendingCredentialSubmission = components["schemas"]["PendingCredentialSubmission"];

/**
 * The `pendingSubmission` of a tenant's connections of one kind, by environment (`pendingByEnvironment`): an entry for
 * each environment whose latest submission is open or failed, none for the others.
 */
export type PendingSubmissions = Readonly<
  Partial<Record<CredentialEnvironment, PendingCredentialSubmission>>
>;

/** The statuses a `pendingSubmission` shows: an open submission, or one that failed (the portal shows why). */
const PENDING_SUBMISSION_STATUSES: ReadonlySet<string> = new Set(["pending", "verifying", "failed"]);

/**
 * The `pendingSubmission` of a submission: its id, its status and, once it failed, its error code, while it is
 * `pending` or `verifying` or after it `failed`; `null` for any other status (applied, superseded) and without a
 * submission. Never a secret nor a public field.
 */
export function toPendingSubmission(
  row: Pick<CredentialSubmissionView, "id" | "status" | "error_code"> | undefined,
): PendingCredentialSubmission | null {
  if (row === undefined || !PENDING_SUBMISSION_STATUSES.has(row.status)) {
    return null;
  }
  return {
    id: row.id,
    status: row.status as PendingCredentialSubmission["status"],
    errorCode: row.status === "failed" ? row.error_code : null,
  };
}

/** The `pendingSubmission` of a connection of `environment` among `pending`; `null` without one. */
export function pendingSubmissionOf(
  pending: PendingSubmissions,
  environment: string,
): PendingCredentialSubmission | null {
  return environment === "test" || environment === "live" ? (pending[environment] ?? null) : null;
}
