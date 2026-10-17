// The Amadeus connection resolver (OADR-0001 point 4, flows/amadeus-connection-and-tokens.md §2, ADR-0012; OBE-017):
// which credential set, base URL and offices serve one tenant in one environment.
//
//   conn:amadeus:<tenantId>:<env>  → the platform.supplier_connections row (PlatformCache, 60 s, dropped on the
//                                    `connection` invalidation; a missing row is not cached)
//   amadeus:acct:<id>              → the platform.amadeus_accounts row it references (60 s, dropped on
//                                    `amadeus_account`)
//
// The rows are read through the platform caches of OBE-012 and cached as the repository returns them: the client
// secret stays the platform's envelope ciphertext (base64 text), and only the token provider decrypts it, in memory,
// for a token request. The resolved connection carries the ciphertext and its associated data, never the secret.
//
// Rules (M2):
//   - no row for the tenant and environment, or a row that is not `active` (`pending_verification` while no office
//     was free at provisioning, `invalid_credentials`, `disabled`) → 424 SUPPLIER_NOT_CONFIGURED;
//   - `credential_source = velexis`: the referenced `amadeus_accounts` row of that environment is the credential set
//     (credId `ama_…`, shared by every OTA on the account, so its token is too); it must exist and be `active`, else
//     424. The composite foreign key of the platform makes a test connection on the live account impossible; the
//     resolver checks the environment again anyway;
//   - `credential_source = tenant` (the OTA's own credentials) is part of the types but answers 424 until OBE-079
//     (M5, behind the platform's FEATURE_OWN_AMADEUS switch), as does the releasing-office rule for old orders;
//   - offices: `queuing` and `owner` (new flight orders) are the connection's queuing and owner offices, `queue`
//     (Queue List) and `retrieval` (by-reference reads) its default office, each falling back to the default office
//     or the queuing office as the platform fills them (`default = queuing = owner` at provisioning). Only an office
//     of the connection's `office_ids` is ever used: on the shared account any other office may be another OTA's
//     (ADR-0012, office isolation). A connection without a usable office id answers 424. `officeIds` is the list the
//     client checks caller-provided offices against (403 OFFICE_NOT_ALLOWED, OBE-018);
//   - base URL: AMADEUS_BASE_URL_TEST / _LIVE when set (the stub in development and CI), else the account's
//     `base_url`, else the official host of the environment (rule 5).
//
// The reason of a 424 is the error's `cause` (`AmadeusConnectionUnusableError`), for the logs only: the response says
// no more than the catalogue's message.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { aadFor } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { ApiConfig } from "../config";
import { PlatformCache, type CacheParser } from "../tenancy/platform-cache";
import {
  AMADEUS_CREDENTIAL_STATUSES,
  AMADEUS_ENVIRONMENTS,
  CREDENTIAL_SOURCES,
  PlatformReadRepository,
  type AmadeusEnvironment,
  type CredentialSource,
  type PlatformAmadeusAccount,
  type PlatformAmadeusConnection,
} from "../tenancy/platform-read.repository";

/** The Amadeus Enterprise hosts, when neither an override nor the row names one (rule 5). */
export const AMADEUS_OFFICIAL_BASE_URLS: Readonly<Record<AmadeusEnvironment, string>> = Object.freeze({
  test: "https://test.travel.api.amadeus.com",
  live: "https://travel.api.amadeus.com",
});

/** An Amadeus office id, as the CHECK of `platform.amadeus_offices.office_id` writes it (`NCE1A0955`). */
export const AMADEUS_OFFICE_ID = /^[A-Z0-9]{9}$/;

/**
 * The client secret of a credential set as the platform stored it: the envelope ciphertext of @velexis/crypto in
 * base64, and the associated data of its place (`platform.amadeus_accounts.client_secret_ciphertext:<id>`). Only
 * `decryptValue` with the process's KEKs turns it into the secret.
 */
export interface EncryptedSecret {
  readonly ciphertext: string;
  readonly aad: string;
}

/** The offices every request of the tenant carries (ADR-0012, office isolation on the shared account). */
export interface AmadeusOffices {
  /** `queuingOfficeId` of Flight Create Orders. */
  readonly queuing: string;
  /** `ownerOfficeId` of Flight Create Orders. */
  readonly owner: string;
  /** The office of Queue List. */
  readonly queue: string;
  /** The office of by-reference retrieval (Get Flight Order by record locator). */
  readonly retrieval: string;
}

/** What serves the Amadeus calls of one tenant in one environment. */
export interface ResolvedAmadeusConnection {
  readonly tenantId: string;
  readonly environment: AmadeusEnvironment;
  /** The tenant's `supplier_connections` row (`sc_…`). */
  readonly connectionId: string;
  readonly credentialSource: CredentialSource;
  /**
   * The credential set (`ama_…` for the shared account, `sc_…` for own credentials from M5): the key of the token,
   * the token lock, the refused-credentials flag and the per-credential bucket.
   */
  readonly credId: string;
  readonly clientId: string;
  readonly encryptedSecret: EncryptedSecret;
  /** The origin of every request (`https://test.travel.api.amadeus.com`, the stub in development), no trailing `/`. */
  readonly baseUrl: string;
  readonly offices: AmadeusOffices;
  /** Every office the connection may act for. */
  readonly officeIds: readonly string[];
}

/** Why a connection cannot serve calls; the `cause` of the 424. */
export type ConnectionUnusableReason =
  | "no_connection"
  | "connection_not_active"
  | "tenant_credentials_not_supported"
  | "no_amadeus_account"
  | "amadeus_account_not_active"
  | "amadeus_account_environment"
  | "no_office";

/** The cause of a `424 SUPPLIER_NOT_CONFIGURED`: the reason, with ids only (never a secret or a ciphertext). */
export class AmadeusConnectionUnusableError extends Error {
  override readonly name = "AmadeusConnectionUnusableError";

  constructor(
    readonly reason: ConnectionUnusableReason,
    readonly tenantId: string,
    readonly environment: AmadeusEnvironment,
  ) {
    super(`The Amadeus connection of ${tenantId} (${environment}) cannot serve calls: ${reason}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** base64 text, as `Buffer#toString("base64")` writes it. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const isCiphertext = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && BASE64.test(value);

/** A cached `PlatformAmadeusConnection` (`conn:amadeus:<tenantId>:<env>`); anything else is a miss. */
export const parseAmadeusConnection: CacheParser<PlatformAmadeusConnection> = (value) => {
  if (!isRecord(value)) {
    return undefined;
  }
  const {
    id,
    tenantId,
    environment,
    credentialSource,
    amadeusAccountId,
    baseUrl,
    clientId,
    clientSecretCiphertext,
    officeIds,
    defaultOfficeId,
    queuingOfficeId,
    ownerOfficeId,
    status,
  } = value;
  if (
    typeof id !== "string" ||
    typeof tenantId !== "string" ||
    !isOneOf(environment, AMADEUS_ENVIRONMENTS) ||
    !isOneOf(credentialSource, CREDENTIAL_SOURCES) ||
    !nullableString(amadeusAccountId) ||
    !nullableString(baseUrl) ||
    !nullableString(clientId) ||
    !(clientSecretCiphertext === null || isCiphertext(clientSecretCiphertext)) ||
    !isStringArray(officeIds) ||
    !nullableString(defaultOfficeId) ||
    !nullableString(queuingOfficeId) ||
    !nullableString(ownerOfficeId) ||
    !isOneOf(status, AMADEUS_CREDENTIAL_STATUSES)
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    tenantId,
    environment,
    credentialSource,
    amadeusAccountId,
    baseUrl,
    clientId,
    clientSecretCiphertext,
    officeIds: Object.freeze([...officeIds]),
    defaultOfficeId,
    queuingOfficeId,
    ownerOfficeId,
    status,
  });
};

/** A cached `PlatformAmadeusAccount` (`amadeus:acct:<id>`); anything else is a miss. */
export const parseAmadeusAccount: CacheParser<PlatformAmadeusAccount> = (value) => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, environment, baseUrl, clientId, clientSecretCiphertext, status } = value;
  if (
    typeof id !== "string" ||
    !isOneOf(environment, AMADEUS_ENVIRONMENTS) ||
    typeof baseUrl !== "string" ||
    typeof clientId !== "string" ||
    !isCiphertext(clientSecretCiphertext) ||
    !isOneOf(status, AMADEUS_CREDENTIAL_STATUSES)
  ) {
    return undefined;
  }
  return Object.freeze({ id, environment, baseUrl, clientId, clientSecretCiphertext, status });
};

/** The base URL of rule 5: the override, else the row's `base_url`, else the official host; no trailing `/`. */
function baseUrlOf(
  override: string | undefined,
  row: string | null,
  environment: AmadeusEnvironment,
): string {
  const url = override ?? (row === null || row === "" ? AMADEUS_OFFICIAL_BASE_URLS[environment] : row);
  return url.replace(/\/+$/, "");
}

/** The first candidate that is an office id of the connection's `officeIds` (an office the tenant may act for). */
function office(
  officeIds: readonly string[],
  ...candidates: ReadonlyArray<string | null>
): string | undefined {
  return candidates.find(
    (candidate): candidate is string =>
      candidate !== null && AMADEUS_OFFICE_ID.test(candidate) && officeIds.includes(candidate),
  );
}

@Injectable()
export class ConnectionResolver {
  /** AMADEUS_BASE_URL_TEST and _LIVE: origins, or `undefined`. */
  private readonly overrides: Readonly<Record<AmadeusEnvironment, string | undefined>>;

  constructor(
    private readonly cache: PlatformCache,
    private readonly platform: PlatformReadRepository,
    config: ConfigService<ApiConfig, true>,
  ) {
    this.overrides = Object.freeze({
      test: config.get("AMADEUS_BASE_URL_TEST", { infer: true }),
      live: config.get("AMADEUS_BASE_URL_LIVE", { infer: true }),
    });
  }

  /**
   * The credential set, base URL and offices that serve `tenantId` in `environment` (see the file header). Throws
   * `424 SUPPLIER_NOT_CONFIGURED` when the tenant has no usable connection, and `503 SERVICE_UNAVAILABLE` when the
   * platform rows cannot be read.
   */
  async resolve(tenantId: string, environment: AmadeusEnvironment): Promise<ResolvedAmadeusConnection> {
    const unusable = (reason: ConnectionUnusableReason): AppError =>
      new AppError("SUPPLIER_NOT_CONFIGURED", {
        cause: new AmadeusConnectionUnusableError(reason, tenantId, environment),
      });

    const connection = await this.cache.connection(
      "amadeus",
      tenantId,
      environment,
      () => this.platform.amadeusConnection(tenantId, environment),
      parseAmadeusConnection,
    );
    if (connection === null || connection.tenantId !== tenantId || connection.environment !== environment) {
      throw unusable("no_connection");
    }
    if (connection.status !== "active") {
      throw unusable("connection_not_active");
    }
    if (connection.credentialSource !== "velexis") {
      throw unusable("tenant_credentials_not_supported"); // OBE-079 (M5)
    }
    const accountId = connection.amadeusAccountId;
    if (accountId === null) {
      throw unusable("no_amadeus_account");
    }
    const account = await this.cache.amadeusAccount(
      accountId,
      () => this.platform.amadeusAccountById(accountId),
      parseAmadeusAccount,
    );
    if (account === null || account.id !== accountId) {
      throw unusable("no_amadeus_account");
    }
    if (account.environment !== environment) {
      throw unusable("amadeus_account_environment");
    }
    if (account.status !== "active") {
      throw unusable("amadeus_account_not_active");
    }

    const { officeIds } = connection;
    const queuing = office(officeIds, connection.queuingOfficeId, connection.defaultOfficeId);
    const owner = office(
      officeIds,
      connection.ownerOfficeId,
      connection.defaultOfficeId,
      connection.queuingOfficeId,
    );
    const queue = office(officeIds, connection.defaultOfficeId, connection.queuingOfficeId);
    if (queuing === undefined || owner === undefined || queue === undefined) {
      throw unusable("no_office");
    }

    return Object.freeze({
      tenantId,
      environment,
      connectionId: connection.id,
      credentialSource: connection.credentialSource,
      credId: account.id,
      clientId: account.clientId,
      encryptedSecret: Object.freeze({
        ciphertext: account.clientSecretCiphertext,
        aad: aadFor("platform", "amadeus_accounts", "client_secret_ciphertext", account.id),
      }),
      baseUrl: baseUrlOf(this.overrides[environment], account.baseUrl, environment),
      offices: Object.freeze({ queuing, owner, queue, retrieval: queue }),
      officeIds,
    });
  }
}
