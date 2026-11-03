// The OTA's own Amadeus credentials, the API's side (PBE-053; flows/amadeus-connection.md §D items 1 and 2, PADR-0010,
// ADR-0012; scope PF-52 AC1). Who may call it is decided before it runs: TenantRoleGuard (owners and admins:
// `changeConnections`), RecentMfaGuard (`x-mfa-step-up`: `403 MFA_REQUIRED` without MFA, `401 REAUTH_REQUIRED` without a
// TOTP step-up in the last 15 minutes) and FeatureGuard (`x-feature: own_amadeus`, `403 FEATURE_DISABLED`).
//
// `submit` (`submitAmadeusCredentials`, `PUT …/amadeus-connections/{environment}/credentials`):
//
// 0. The `live` environment also needs the live switch (FIX-W40-PLATFORM, lead decision (2g) of 2026-11-03): while
//    FEATURE_LIVE_SWITCH is off, `403 FEATURE_DISABLED` with `details.feature = live_switch`, checked here, after the
//    guards and before any other rule of the request, so nothing is read or written; the `test` environment does not
//    need it.
// 1. The request validation has checked the body against `SubmitAmadeusCredentialsRequest` (the client id without
//    spaces, a client secret of 1 to 512 characters, 1 to 50 distinct office ids of 9 upper-case letters and digits).
//    The default office and, when sent, the queuing and owner offices must be among `officeIds` (`400
//    VALIDATION_FAILED` with a field error on each other one, `officeProblems`; the message never holds the value); the
//    two optional offices default to the default office, as provisioning sets them for a Velexis office.
// 2. One transaction (`runInTransaction`): the tenant's row with `FOR SHARE` (gone, or not visible to members: `404
//    NOT_FOUND`; not `active`: `409 TENANT_NOT_ACTIVE` with `details.status`, PADR-0014 item 5), so a suspension waits
//    for the submission or the submission sees it; a connection of the environment that a platform admin disabled
//    (`adminSetConnectionStatus`, PADR-0012 item 8) answers `409 CONFLICT` with `details.reason = connection_disabled`
//    and nothing is written (FIX-W39-PLATFORM, lead decision (2i) of 2026-11-02; the row is read without a lock, and the
//    worker's apply refuses it again with CONNECTION_DISABLED if the admin disables it later); then
//    CredentialSubmissionsService.submit (PBE-052) with `kind =
//    'amadeus'`: it supersedes the open submission of that environment (its secret erased), stores the non-secret fields
//    in `public_data` (`clientId`, `officeIds`, `defaultOfficeId`, `queuingOfficeId`, `ownerOfficeId`) and the client
//    secret envelope-encrypted, writes the audit row `amadeus.credentials_submitted` (no secret; this service writes
//    none of its own) and, after the commit, enqueues `credentials.verify {submissionId}`. The connection row is read
//    but never locked here: the worker's apply locks the submission, then the connection (lock order of
//    credentials-verify.processor.ts), and the environment needs no connection yet (flow §D item 4).
// 3. The answer is `202 {submission}`, the submission as `getCredentialSubmission` answers it (`pending`).
//
// The worker's side, the token request and the switch of the connection, is amadeus-credentials.verifier.ts.
//
// `listConnections` (`listAmadeusConnections`, PBE-027) answers the OTA's connections without the client secret's
// ciphertext (`toAmadeusConnection`), each with its `pendingSubmission`: the latest submission of its environment while
// it is open or after it failed (CredentialSubmissionsService.pendingByEnvironment), so the portal shows a rejection
// next to the connection it left untouched. `connectionOf` maps one connection the same way, for the answer of
// `updateAmadeusConnection` (FIX-W39-PLATFORM, lead decision (2k) of 2026-11-02: every answered connection carries its
// `pendingSubmission`).
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError, type FieldError } from "@velexis/errors";
import { MEMBER_VISIBLE_TENANT_STATUSES, type TenantMembership } from "../common/auth/tenant-role.guard";
import { liveSwitchOrThrow } from "../common/credentials/live-switch";
import {
  CredentialSubmissionsService,
  toCredentialSubmission,
} from "../common/credentials/credential-submissions.service";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { FeatureSwitches } from "../common/features";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import type { AmadeusEnvironment } from "./amadeus-accounts.repository";
import {
  SupplierConnectionsRepository,
  toAmadeusConnection,
  type AmadeusConnection,
  type SupplierConnectionView,
} from "./supplier-connections.repository";

export type SubmitAmadeusCredentialsRequest = components["schemas"]["SubmitAmadeusCredentialsRequest"];
export type CredentialSubmissionAccepted = components["schemas"]["CredentialSubmissionAccepted"];

/** The message of a field error for an office outside `officeIds`; it never holds the value. */
export const NOT_A_SUBMITTED_OFFICE = "Must be one of officeIds.";

/** The office fields of a submission besides `officeIds`, each optional but the default office. */
const OFFICE_FIELDS = ["defaultOfficeId", "queuingOfficeId", "ownerOfficeId"] as const;

const VISIBLE_STATUSES: ReadonlySet<string> = new Set(MEMBER_VISIBLE_TENANT_STATUSES);

/**
 * The non-secret fields of a submission, as `public_data` stores them and the verifier reads them: the client id and
 * the offices, the queuing and owner offices defaulted to the default office.
 */
export interface AmadeusPublicData {
  readonly clientId: string;
  readonly officeIds: readonly string[];
  readonly defaultOfficeId: string;
  readonly queuingOfficeId: string;
  readonly ownerOfficeId: string;
}

/**
 * A field error for each office of `request` (the default office, and the queuing and owner offices when sent) that is
 * not one of its `officeIds`, in that order. Empty when every one is.
 */
export function officeProblems(request: SubmitAmadeusCredentialsRequest): FieldError[] {
  const allowed = new Set(request.officeIds);
  const problems: FieldError[] = [];
  for (const field of OFFICE_FIELDS) {
    const officeId = request[field];
    if (officeId !== undefined && !allowed.has(officeId)) {
      problems.push({ path: `/${field}`, code: "unknown", message: NOT_A_SUBMITTED_OFFICE });
    }
  }
  return problems;
}

/** The `public_data` of a submission of `request`: every field but the client secret, the two offices defaulted. */
export function publicDataOf(request: SubmitAmadeusCredentialsRequest): AmadeusPublicData {
  return {
    clientId: request.clientId,
    officeIds: [...request.officeIds],
    defaultOfficeId: request.defaultOfficeId,
    queuingOfficeId: request.queuingOfficeId ?? request.defaultOfficeId,
    ownerOfficeId: request.ownerOfficeId ?? request.defaultOfficeId,
  };
}

@Injectable()
export class AmadeusCredentialsService {
  constructor(
    private readonly submissions: CredentialSubmissionsService,
    private readonly connections: SupplierConnectionsRepository,
    private readonly switches: FeatureSwitches,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** submitAmadeusCredentials: a new submission of the OTA's own credentials for `environment` (see the header). */
  async submit(
    membership: TenantMembership,
    environment: AmadeusEnvironment,
    request: SubmitAmadeusCredentialsRequest,
  ): Promise<CredentialSubmissionAccepted> {
    liveSwitchOrThrow(this.switches, environment);
    const problems = officeProblems(request);
    if (problems.length > 0) {
      throw new AppError("VALIDATION_FAILED", { fieldErrors: problems });
    }
    const { tenantId, accountId } = membership;
    const row = await runInTransaction(this.db, async (trx) => {
      const tenantStatus = await this.connections.tenantStatusForShare(trx, tenantId);
      if (tenantStatus === undefined || !VISIBLE_STATUSES.has(tenantStatus)) {
        throw new AppError("NOT_FOUND");
      }
      if (tenantStatus !== "active") {
        throw new AppError("TENANT_NOT_ACTIVE", { details: { status: tenantStatus } });
      }
      // Read without a lock (lock order: submission, then connection, in the worker's apply).
      const connection = await this.connections.findViewForTenant(tenantId, environment, trx);
      if (connection?.status === "disabled") {
        throw new AppError("CONFLICT", { details: { reason: "connection_disabled" } });
      }
      return this.submissions.submit(trx, {
        tenantId,
        kind: "amadeus",
        environment,
        publicData: { ...publicDataOf(request) },
        secrets: { secret: request.clientSecret },
        submittedBy: accountId,
      });
    });
    return { submission: toCredentialSubmission(row) };
  }

  /**
   * listAmadeusConnections: the tenant's Amadeus connections, `test` first, read without the secret's ciphertext, each
   * with its `pendingSubmission` (see the header).
   */
  async listConnections(tenantId: string): Promise<AmadeusConnection[]> {
    const [rows, pending] = await Promise.all([
      this.connections.listForTenant(tenantId),
      this.submissions.pendingByEnvironment(tenantId, "amadeus"),
    ]);
    return rows.map((row) => toAmadeusConnection(row, pending));
  }

  /** The tenant's connection `row` as the list maps it, with its `pendingSubmission` read now (see the header). */
  async connectionOf(tenantId: string, row: SupplierConnectionView): Promise<AmadeusConnection> {
    return toAmadeusConnection(row, await this.submissions.pendingByEnvironment(tenantId, "amadeus"));
  }
}
