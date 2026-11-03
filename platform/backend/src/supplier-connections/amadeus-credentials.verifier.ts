// The verifier of the OTA's own Amadeus credentials (PBE-053; flows/amadeus-connection.md §D items 3 to 5, PADR-0010
// items 4 and 5, PADR-0012 item 4, ADR-0012; scope PF-52 AC2): the `amadeus` verifier of the `credentials.verify` job
// of PBE-052 (common/credentials/credentials-verify.processor.ts), registered in the worker's one `CredentialVerifiers`
// registry from `onModuleInit` (SupplierConnectionsWorkerModule imports `CredentialSubmissionsModule.forWorker()`). The
// processor owns the attempt: it decrypts the client secret of the submission, calls `check` outside any transaction,
// then `apply` in its final transaction with the submission locked, writes the submission's outcome with both secret
// columns erased, the audit row `amadeus.credentials_applied` or `amadeus.credentials_rejected` (with what `apply`
// answers) and the submitter's e-mail, and retries an `unavailable` answer (5 attempts, backoff; then
// `PROVIDER_UNAVAILABLE`).
//
// `check`: an OAuth token request with the submitted client id and secret (AmadeusOAuthGateway: client credentials, a
// 10-second timeout, no redirect followed, the token discarded) to the Amadeus host of the submission's environment,
// AMADEUS_BASE_URL_TEST or AMADEUS_BASE_URL_LIVE (the official hosts by default; the Amadeus stub only outside
// production, config.ts):
// - a token: `verified`, with the host as the result, so `apply` stores the host that was checked;
// - HTTP 401, or the OAuth error `invalid_client`: `rejected` with `AMADEUS_CREDENTIALS_INVALID` (final at once);
// - anything else (a timeout, a network error, 5xx, 408, 429, and the answers that prove nothing about the credentials:
//   another 4xx, a redirect, a 2xx without a token): `unavailable`, retried, then `PROVIDER_UNAVAILABLE`.
// The messages carry the gateway's short error (`HTTP 401 invalid_client (Amadeus code 38187)`), never a body, the
// secret or the token.
//
// `apply(trx, …)`, in the job's transaction, after the submission (lock order: submission, then connection):
// 1. The tenant's row `FOR SHARE`: an OTA that is no longer `active` (suspended since it submitted, PADR-0014 item 5)
//    keeps its connection; the submission fails with `TENANT_NOT_ACTIVE` (CredentialRejection).
// 2. The connection lock of the environment (`lockTenantEnvironment`, as the admin's office assignment and provisioning
//    take it), then the connection itself `FOR UPDATE`. A connection a platform admin disabled
//    (`adminSetConnectionStatus`, PADR-0012 item 8) is not switched behind the admin's back: the submission fails with
//    `CONNECTION_DISABLED`, nothing written.
// 3. The client secret is envelope-encrypted again for the connection's row (associated data
//    `platform.supplier_connections.client_secret_ciphertext:<sc_id>`, ADR-0010; the OTA backend opens it with exactly
//    that), and the connection becomes `credential_source = 'tenant'`, without a Velexis account, with the host, the
//    client id, the new ciphertext and its KEK, the offices of the submission, `active`, `last_verified_at` now and
//    `version + 1` (`switchToTenant`). The monitored queues stay as the OTA set them (a queue of a `releasing` office
//    stays usable for the old orders), and so do the ticketing defaults, except the `automatedProcess` entries whose
//    `officeId` is not one of the new offices, which are dropped (FIX-W39-PLATFORM, lead decision (2j) of 2026-11-02:
//    ADR-0012 office isolation, the rule PBE-040's `updateAmadeusConnection` applies to every entry it takes; an entry
//    without an office stays). Without a connection for the environment (own credentials before any Velexis
//    connection, flow §D item 4) it is inserted (`insertTenant`, created by the submitter).
// 4. Every Velexis office assigned to the OTA in that environment becomes `releasing` with `release_requested_at`,
//    keeping its tenant (PADR-0012 item 4: the OTA backend still services the orders owned by it with the Velexis
//    account), each with an audit row `amadeus_office.released` (actor `system`, label `credentials.verify`).
// 5. After the commit, `vx:invalidate {type: "connection", tenantId}` and an `amadeus_account` invalidation for the
//    Velexis account of each office set `releasing` and of the connection's former account, so the OTA backend drops
//    its cached rows at once.
// The answer adds the connection's values before and after (ids, source, status, offices, ticketing defaults, host and
// client id, never a secret or a ciphertext), the offices set `releasing` and the offices of the dropped
// `automatedProcess` entries to the audit row of the processor.
import { Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import {
  CredentialRejection,
  CredentialVerifiers,
  type CredentialApplied,
  type CredentialApplyInput,
  type CredentialCheck,
  type CredentialCheckInput,
  type CredentialVerifier,
} from "../common/credentials/credentials-verify.processor";
import { EnvelopeService, type CiphertextPlace } from "../common/crypto.provider";
import { IdGenerator } from "../common/ids";
import { InvalidationPublisher } from "../common/redis/invalidation.publisher";
import { amadeusBaseUrl, type PlatformBackendConfig } from "../config";
import type { AmadeusEnvironment } from "./amadeus-accounts.repository";
import type { AmadeusPublicData } from "./amadeus-credentials.service";
import { AmadeusOAuthGateway, type AmadeusTokenCheck } from "./amadeus-oauth.gateway";
import { AmadeusOfficesRepository } from "./amadeus-offices.repository";
import {
  SupplierConnectionsRepository,
  type AmadeusConnection,
  type SupplierConnectionView,
  type TenantCredentials,
} from "./supplier-connections.repository";

/** The submission result code of credentials Amadeus refused (PADR-0010 item 6). */
export const AMADEUS_CREDENTIALS_INVALID = "AMADEUS_CREDENTIALS_INVALID";

/** The submission result code of an OTA that stopped being `active` before its credentials were applied. */
export const TENANT_NOT_ACTIVE = "TENANT_NOT_ACTIVE";

/** The submission result code of a connection a platform admin disabled. */
export const CONNECTION_DISABLED = "CONNECTION_DISABLED";

/** The actor label of the audit rows the apply writes: the job's. */
const ACTOR_LABEL = "credentials.verify";

/** The place of a connection's client secret, for the envelope's associated data (ADR-0010). */
export function connectionSecretPlace(connectionId: string): CiphertextPlace {
  return { table: "supplier_connections", column: "client_secret_ciphertext", rowId: connectionId };
}

/** A submission whose `public_data` is not what `submitAmadeusCredentials` stores: an attempt that cannot complete. */
export class InvalidAmadeusSubmissionError extends Error {
  override readonly name = "InvalidAmadeusSubmissionError";
}

const OFFICE_ID = /^[A-Z0-9]{9}$/;
const CLIENT_ID = /^\S{1,200}$/;

function isOfficeId(value: unknown): value is string {
  return typeof value === "string" && OFFICE_ID.test(value);
}

/**
 * The non-secret fields of an `amadeus` submission, checked: the client id, 1 to 50 distinct office ids, and the
 * default, queuing and owner offices among them. Throws `InvalidAmadeusSubmissionError` (naming fields, never values)
 * otherwise.
 */
export function amadeusPublicDataOf(publicData: Readonly<Record<string, unknown>>): AmadeusPublicData {
  const { clientId, officeIds, defaultOfficeId, queuingOfficeId, ownerOfficeId } = publicData;
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) {
    throw new InvalidAmadeusSubmissionError("public_data.clientId is missing or invalid");
  }
  if (
    !Array.isArray(officeIds) ||
    officeIds.length === 0 ||
    officeIds.length > 50 ||
    !officeIds.every(isOfficeId) ||
    new Set(officeIds).size !== officeIds.length
  ) {
    throw new InvalidAmadeusSubmissionError("public_data.officeIds is missing or invalid");
  }
  const offices: readonly string[] = officeIds;
  for (const [name, value] of [
    ["defaultOfficeId", defaultOfficeId],
    ["queuingOfficeId", queuingOfficeId],
    ["ownerOfficeId", ownerOfficeId],
  ] as const) {
    if (!isOfficeId(value) || !offices.includes(value)) {
      throw new InvalidAmadeusSubmissionError(`public_data.${name} is missing or not one of officeIds`);
    }
  }
  return {
    clientId,
    officeIds: [...offices],
    defaultOfficeId: defaultOfficeId as string,
    queuingOfficeId: queuingOfficeId as string,
    ownerOfficeId: ownerOfficeId as string,
  };
}

/** True for a token answer that says the client id and secret are wrong: HTTP 401, or the OAuth error `invalid_client`. */
export function refusesCredentials(answer: AmadeusTokenCheck): boolean {
  return (
    answer.outcome === "rejected" &&
    (answer.httpStatus === 401 || /^HTTP [0-9]{3} invalid_client\b/.test(answer.error))
  );
}

/** What the verifier's `check` answers for one token request to `baseUrl` (see the file header). */
export function credentialCheckOf(answer: AmadeusTokenCheck, baseUrl: string): CredentialCheck {
  if (answer.outcome === "verified") {
    return { outcome: "verified", result: { baseUrl } };
  }
  if (refusesCredentials(answer)) {
    return {
      outcome: "rejected",
      errorCode: AMADEUS_CREDENTIALS_INVALID,
      errorMessage: `Amadeus refused the client id and secret (${answer.error}).`,
    };
  }
  return {
    outcome: "unavailable",
    errorMessage: `Amadeus could not verify the credentials (${answer.error}).`,
  };
}

/**
 * The connection's values in the audit row: ids, source, status, offices, ticketing defaults, host and client id;
 * never a secret.
 */
function auditValuesOf(row: SupplierConnectionView): Record<string, unknown> {
  return {
    connectionId: row.id,
    credentialSource: row.credential_source,
    connectionStatus: row.status,
    amadeusAccountId: row.amadeus_account_id,
    baseUrl: row.base_url,
    clientId: row.client_id,
    officeIds: [...row.office_ids],
    defaultOfficeId: row.default_office_id,
    queuingOfficeId: row.queuing_office_id,
    ownerOfficeId: row.owner_office_id,
    ticketingDefaults: row.ticketing_defaults,
    version: row.version,
  };
}

/** The ticketing defaults a switch writes, and the offices of the `automatedProcess` entries it dropped. */
export interface OfficeBoundTicketingDefaults {
  readonly ticketingDefaults: AmadeusConnection["ticketingDefaults"];
  readonly droppedOfficeIds: string[];
}

/**
 * The stored ticketing defaults without the `automatedProcess` entries whose `officeId` is not one of `officeIds`
 * (FIX-W39-PLATFORM, lead decision (2j) of 2026-11-02; ADR-0012 office isolation, PBE-040's rule): an entry without an
 * office and every other setting stay. `undefined` when no entry is dropped (nothing to write).
 */
export function ticketingDefaultsForOffices(
  stored: unknown,
  officeIds: readonly string[],
): OfficeBoundTicketingDefaults | undefined {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return undefined;
  }
  const defaults = stored as Record<string, unknown>;
  const entries = defaults["automatedProcess"];
  if (!Array.isArray(entries)) {
    return undefined;
  }
  const allowed = new Set(officeIds);
  const kept: unknown[] = [];
  const droppedOfficeIds: string[] = [];
  for (const entry of entries as unknown[]) {
    const officeId: unknown =
      entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>)["officeId"]
        : undefined;
    if (typeof officeId === "string" && !allowed.has(officeId)) {
      droppedOfficeIds.push(officeId);
    } else {
      kept.push(entry);
    }
  }
  if (droppedOfficeIds.length === 0) {
    return undefined;
  }
  return {
    ticketingDefaults: { ...defaults, automatedProcess: kept } as AmadeusConnection["ticketingDefaults"],
    droppedOfficeIds,
  };
}

@Injectable()
export class AmadeusCredentialsVerifier implements CredentialVerifier, OnModuleInit {
  private readonly config: Pick<PlatformBackendConfig, "AMADEUS_BASE_URL_TEST" | "AMADEUS_BASE_URL_LIVE">;

  constructor(
    private readonly verifiers: CredentialVerifiers,
    private readonly gateway: AmadeusOAuthGateway,
    private readonly connections: SupplierConnectionsRepository,
    private readonly offices: AmadeusOfficesRepository,
    private readonly envelope: EnvelopeService,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly ids: IdGenerator,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.config = {
      AMADEUS_BASE_URL_TEST: config.get("AMADEUS_BASE_URL_TEST", { infer: true }),
      AMADEUS_BASE_URL_LIVE: config.get("AMADEUS_BASE_URL_LIVE", { infer: true }),
    };
  }

  /** Registers this verifier for `amadeus` in the worker's one registry (PBE-052). */
  onModuleInit(): void {
    this.verifiers.register("amadeus", this);
  }

  /** The Amadeus host of `environment` (AMADEUS_BASE_URL_TEST or AMADEUS_BASE_URL_LIVE, without a trailing slash). */
  baseUrlOf(environment: AmadeusEnvironment): string {
    return amadeusBaseUrl(this.config, environment);
  }

  /** The token request with the submitted credentials, outside any transaction (see the file header). */
  async check(input: CredentialCheckInput): Promise<CredentialCheck> {
    const data = amadeusPublicDataOf(input.publicData);
    const baseUrl = this.baseUrlOf(input.environment);
    const answer = await this.gateway.checkCredentials({
      baseUrl,
      clientId: data.clientId,
      clientSecret: input.secrets.secret,
    });
    return credentialCheckOf(answer, baseUrl);
  }

  /** The switch of the connection in the job's transaction (see the file header). */
  async apply(trx: PlatformTransaction, input: CredentialApplyInput): Promise<CredentialApplied> {
    const data = amadeusPublicDataOf(input.publicData);
    const { tenantId, environment, now } = input;
    const verified: unknown = (input.result as { readonly baseUrl?: unknown } | undefined)?.baseUrl;
    const baseUrl = typeof verified === "string" ? verified : this.baseUrlOf(environment);

    const tenantStatus = await this.connections.tenantStatusForShare(trx, tenantId);
    if (tenantStatus !== "active") {
      throw new CredentialRejection(
        TENANT_NOT_ACTIVE,
        "The OTA is not active, so its Amadeus connection cannot change. Submit the credentials again once it is active.",
      );
    }
    await this.connections.lockTenantEnvironment(trx, tenantId, environment);
    const existing = await this.connections.lockViewForTenant(trx, tenantId, environment);
    if (existing?.status === "disabled") {
      throw new CredentialRejection(
        CONNECTION_DISABLED,
        "Velexis disabled this Amadeus connection, so it cannot change. Contact Velexis support.",
      );
    }

    const connectionId = existing?.id ?? this.ids.new("sc");
    // ADR-0012 office isolation: no automated process of a new order on an office these credentials do not hold.
    const officeBound =
      existing === undefined
        ? undefined
        : ticketingDefaultsForOffices(existing.ticketing_defaults, data.officeIds);
    const sealed = await this.envelope.encrypt(input.secrets.secret, connectionSecretPlace(connectionId));
    const credentials: TenantCredentials = {
      baseUrl,
      clientId: data.clientId,
      clientSecretCiphertext: sealed.ciphertext,
      encryptionKeyId: sealed.kekId,
      officeIds: data.officeIds,
      defaultOfficeId: data.defaultOfficeId,
      queuingOfficeId: data.queuingOfficeId,
      ownerOfficeId: data.ownerOfficeId,
    };
    const connection =
      existing === undefined
        ? await this.connections.insertTenant(trx, {
            id: connectionId,
            tenantId,
            environment,
            credentials,
            createdByAccountId: input.submittedByAccountId,
            now,
          })
        : await this.connections.switchToTenant(
            trx,
            existing.id,
            credentials,
            now,
            officeBound?.ticketingDefaults,
          );

    const releasing = await this.offices.startReleasing(trx, tenantId, environment, now);
    for (const office of releasing) {
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: ACTOR_LABEL,
        action: "amadeus_office.released",
        targetType: "amadeus_office",
        targetId: office.id,
        tenantId,
        before: { status: "assigned" },
        after: { status: office.status, releaseRequestedAt: now.toISOString() },
        details: {
          officeId: office.office_id,
          environment,
          reason: "own_credentials_applied",
          submissionId: input.submissionId,
          connectionId: connection.id,
        },
      });
    }

    this.invalidations.publishAfterCommit(trx, { v: 1, type: "connection", tenantId });
    const accounts = new Set(releasing.map((office) => office.amadeus_account_id));
    if (existing?.amadeus_account_id !== null && existing?.amadeus_account_id !== undefined) {
      accounts.add(existing.amadeus_account_id);
    }
    for (const id of accounts) {
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "amadeus_account", id });
    }

    return {
      before: existing === undefined ? { connectionId: null } : auditValuesOf(existing),
      after: auditValuesOf(connection),
      details: {
        connectionCreated: existing === undefined,
        releasingOfficeIds: releasing.map((office) => office.office_id),
        ...(officeBound === undefined
          ? {}
          : { droppedAutomatedProcessOfficeIds: officeBound.droppedOfficeIds }),
      },
    };
  }
}
