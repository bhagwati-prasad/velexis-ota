// The Amadeus connection resolver (OADR-0001 point 4, flows/amadeus-connection-and-tokens.md §2, ADR-0012; OBE-017,
// OBE-079): which credential set, base URL and offices serve one tenant in one environment, and one existing order.
//
//   conn:amadeus:<tenantId>:<env>  → the platform.supplier_connections row with the id of the Velexis account of its
//                                    environment (PlatformCache, 60 s, dropped on the `connection` invalidation; a
//                                    missing row is not cached)
//   amadeus:acct:<id>              → the platform.amadeus_accounts row with the offices of its pool that serve a tenant
//                                    (`assigned` or `releasing`; 60 s, dropped on `amadeus_account`, which the
//                                    platform publishes after every change of the account or of its offices)
//
// The rows are read through the platform caches of OBE-012 and cached as the repository returns them: the client
// secret stays the platform's envelope ciphertext (base64 text), and only the token provider decrypts it, in memory,
// for a token request. The resolved connection carries the ciphertext and its associated data, never the secret.
//
// Rules:
//   - no row for the tenant and environment, or a row that is not `active` (`pending_verification` while no office
//     was free at provisioning, `invalid_credentials`, `disabled`) → 424 SUPPLIER_NOT_CONFIGURED, for every call, an
//     existing order's included (rule 1 comes first: a connection the platform disabled serves nothing);
//   - `credential_source = velexis`: the referenced `amadeus_accounts` row of that environment is the credential set
//     (credId `ama_…`, shared by every OTA on the account, so its token is too); it must exist and be `active`, else
//     424. The composite foreign key of the platform makes a test connection on the live account impossible; the
//     resolver checks the environment again anyway;
//   - `credential_source = tenant` (the OTA's own credentials, M5, OBE-079): the connection's own client id, its
//     client secret's ciphertext with the associated data of the connection's row
//     (`platform.supplier_connections.client_secret_ciphertext:<sc_id>`, as the platform re-encrypts a verified
//     submission, PBE-053), its `base_url` and its offices. The credential set is the connection (credId `sc_…`), so
//     the token, the token lock, the refused-credentials flag and the per-credential bucket are never the Velexis
//     account's: after a switch the old token is never reused, and a refusal of one set never blocks the other. A
//     `tenant` row without a client id or secret (the CHECK `supplier_connections_source_ck` forbids it) answers 424;
//   - the releasing-office rule (rule 3, PADR-0012 point 4; OBE-079): a call on an existing order passes the order's
//     office (`orderOffice`: the booking's owner or queuing office, the office whose queue Queue List reads). When it
//     is an office of the Velexis account of the environment `assigned` or `releasing` for this tenant, the Velexis
//     account serves the call, with that office alone (`officeIds = [office]`, every office field that office),
//     whatever the connection's credential source; otherwise the connection's current credentials do (and the client
//     refuses an office outside their `officeIds` with 403 OFFICE_NOT_ALLOWED, so an office the platform released to
//     the pool, which may be another OTA's next, never reaches Amadeus). A `velexis` connection's own office needs no
//     look-up: the account serves it either way. The Velexis account must then be `active` and of the environment,
//     else 424, as for a `velexis` connection;
//   - offices: `queuing` and `owner` (new flight orders) are the connection's queuing and owner offices, `queue`
//     (Queue List) and `retrieval` (by-reference reads) its default office, each falling back to the default office
//     or the queuing office as the platform fills them (`default = queuing = owner` at provisioning). Only an office
//     of the connection's `office_ids` is ever used: on the shared account any other office may be another OTA's
//     (ADR-0012, office isolation). A connection without a usable office id answers 424. `officeIds` is the list the
//     client checks caller-provided offices against (403 OFFICE_NOT_ALLOWED, OBE-018);
//   - base URL: AMADEUS_BASE_URL_TEST / _LIVE when set (the stub in development and CI), else the account's or the
//     connection's `base_url`, else the official host of the environment (rule 5).
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
  SERVING_OFFICE_STATUSES,
  type AmadeusEnvironment,
  type CredentialSource,
  type PlatformAmadeusAccount,
  type PlatformAmadeusAccountOffice,
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
 * base64, and the associated data of its place (`platform.amadeus_accounts.client_secret_ciphertext:<ama_id>` for the
 * Velexis account, `platform.supplier_connections.client_secret_ciphertext:<sc_id>` for the OTA's own credentials).
 * Only `decryptValue` with the process's KEKs turns it into the secret.
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

/** What serves the Amadeus calls of one tenant in one environment (or the calls on one existing order of it). */
export interface ResolvedAmadeusConnection {
  readonly tenantId: string;
  readonly environment: AmadeusEnvironment;
  /** The tenant's `supplier_connections` row (`sc_…`). */
  readonly connectionId: string;
  /**
   * Whose credentials serve the calls: `velexis` for the shared account (a `velexis` connection, or an existing order
   * of a Velexis office `assigned` or `releasing` for the tenant), `tenant` for the OTA's own (OBE-079).
   */
  readonly credentialSource: CredentialSource;
  /**
   * The credential set (`ama_…` for the shared account, the connection's `sc_…` for the OTA's own credentials): the key
   * of the token, the token lock, the refused-credentials flag and the per-credential bucket.
   */
  readonly credId: string;
  readonly clientId: string;
  readonly encryptedSecret: EncryptedSecret;
  /** The origin of every request (`https://test.travel.api.amadeus.com`, the stub in development), no trailing `/`. */
  readonly baseUrl: string;
  readonly offices: AmadeusOffices;
  /** Every office the calls may act for: the connection's, or the one Velexis office of an existing order. */
  readonly officeIds: readonly string[];
}

/** Why a connection cannot serve calls; the `cause` of the 424. */
export type ConnectionUnusableReason =
  | "no_connection"
  | "connection_not_active"
  | "no_tenant_credentials"
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
    velexisAccountId,
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
    // An entry written before OBE-079 has none: a miss, read again with it.
    !nullableString(velexisAccountId) ||
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
    velexisAccountId,
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

/** One cached serving office of an account; anything else is `undefined`. */
function parseAccountOffice(value: unknown): PlatformAmadeusAccountOffice | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { officeId, tenantId, status } = value;
  if (
    typeof officeId !== "string" ||
    !AMADEUS_OFFICE_ID.test(officeId) ||
    typeof tenantId !== "string" ||
    tenantId === "" ||
    !isOneOf(status, SERVING_OFFICE_STATUSES)
  ) {
    return undefined;
  }
  return Object.freeze({ officeId, tenantId, status });
}

/** A cached `PlatformAmadeusAccount` with its serving offices (`amadeus:acct:<id>`); anything else is a miss. */
export const parseAmadeusAccount: CacheParser<PlatformAmadeusAccount> = (value) => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, environment, baseUrl, clientId, clientSecretCiphertext, status, offices } = value;
  if (
    typeof id !== "string" ||
    !isOneOf(environment, AMADEUS_ENVIRONMENTS) ||
    typeof baseUrl !== "string" ||
    typeof clientId !== "string" ||
    !isCiphertext(clientSecretCiphertext) ||
    !isOneOf(status, AMADEUS_CREDENTIAL_STATUSES) ||
    // An entry written before OBE-079 has no offices: a miss, read again with them.
    !Array.isArray(offices)
  ) {
    return undefined;
  }
  const parsed = (offices as readonly unknown[]).map(parseAccountOffice);
  if (parsed.some((office) => office === undefined)) {
    return undefined;
  }
  return Object.freeze({
    id,
    environment,
    baseUrl,
    clientId,
    clientSecretCiphertext,
    status,
    offices: Object.freeze(parsed as PlatformAmadeusAccountOffice[]),
  });
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

/** The offices of a connection (see the file header), or `undefined` when it has no usable office id. */
function officesOf(connection: PlatformAmadeusConnection): AmadeusOffices | undefined {
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
    return undefined;
  }
  return Object.freeze({ queuing, owner, queue, retrieval: queue });
}

/** The client secret of the Velexis account, with the associated data of its row. */
function accountSecret(account: PlatformAmadeusAccount): EncryptedSecret {
  return Object.freeze({
    ciphertext: account.clientSecretCiphertext,
    aad: aadFor("platform", "amadeus_accounts", "client_secret_ciphertext", account.id),
  });
}

type Unusable = (reason: ConnectionUnusableReason) => AppError;

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
   * The credential set, base URL and offices that serve `tenantId` in `environment` (see the file header); with
   * `orderOffice`, the office of the existing order a call is about, those that serve that order (the releasing-office
   * rule). Throws `424 SUPPLIER_NOT_CONFIGURED` when the tenant has no usable connection, and `503 SERVICE_UNAVAILABLE`
   * when the platform rows cannot be read.
   */
  async resolve(
    tenantId: string,
    environment: AmadeusEnvironment,
    orderOffice?: string,
  ): Promise<ResolvedAmadeusConnection> {
    const unusable: Unusable = (reason) =>
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
    if (orderOffice !== undefined) {
      const served = await this.velexisOrderOffice(connection, orderOffice, unusable);
      if (served !== undefined) {
        return served;
      }
    }
    return connection.credentialSource === "velexis"
      ? await this.velexisConnection(connection, unusable)
      : this.tenantConnection(connection, unusable);
  }

  /** A `velexis` connection: the shared account it references, its own offices. */
  private async velexisConnection(
    connection: PlatformAmadeusConnection,
    unusable: Unusable,
  ): Promise<ResolvedAmadeusConnection> {
    const accountId = connection.amadeusAccountId;
    if (accountId === null) {
      throw unusable("no_amadeus_account");
    }
    const account = await this.account(accountId);
    if (account === null) {
      throw unusable("no_amadeus_account");
    }
    this.checkAccount(account, connection.environment, unusable);
    const offices = officesOf(connection);
    if (offices === undefined) {
      throw unusable("no_office");
    }
    return Object.freeze({
      tenantId: connection.tenantId,
      environment: connection.environment,
      connectionId: connection.id,
      credentialSource: "velexis",
      credId: account.id,
      clientId: account.clientId,
      encryptedSecret: accountSecret(account),
      baseUrl: baseUrlOf(this.overrides[connection.environment], account.baseUrl, connection.environment),
      offices,
      officeIds: connection.officeIds,
    });
  }

  /** A `tenant` connection (OBE-079): the OTA's own credentials, base URL and offices; the connection is the set. */
  private tenantConnection(
    connection: PlatformAmadeusConnection,
    unusable: Unusable,
  ): ResolvedAmadeusConnection {
    const { clientId, clientSecretCiphertext } = connection;
    if (clientId === null || clientId === "" || clientSecretCiphertext === null) {
      throw unusable("no_tenant_credentials");
    }
    const offices = officesOf(connection);
    if (offices === undefined) {
      throw unusable("no_office");
    }
    return Object.freeze({
      tenantId: connection.tenantId,
      environment: connection.environment,
      connectionId: connection.id,
      credentialSource: "tenant",
      credId: connection.id,
      clientId,
      encryptedSecret: Object.freeze({
        ciphertext: clientSecretCiphertext,
        aad: aadFor("platform", "supplier_connections", "client_secret_ciphertext", connection.id),
      }),
      baseUrl: baseUrlOf(this.overrides[connection.environment], connection.baseUrl, connection.environment),
      offices,
      officeIds: connection.officeIds,
    });
  }

  /**
   * The releasing-office rule (see the file header): the Velexis account with `orderOffice` alone when that office is
   * one of the account's offices `assigned` or `releasing` for the connection's tenant, else `undefined` (the
   * connection's current credentials serve the order). A `velexis` connection's own office is served by the
   * connection itself, without a look-up.
   */
  private async velexisOrderOffice(
    connection: PlatformAmadeusConnection,
    orderOffice: string,
    unusable: Unusable,
  ): Promise<ResolvedAmadeusConnection | undefined> {
    if (
      !AMADEUS_OFFICE_ID.test(orderOffice) ||
      (connection.credentialSource === "velexis" && connection.officeIds.includes(orderOffice))
    ) {
      return undefined;
    }
    const accountId = connection.velexisAccountId;
    if (accountId === null) {
      return undefined;
    }
    const account = await this.account(accountId);
    const serves =
      account !== null &&
      account.offices.some(
        (candidate) => candidate.officeId === orderOffice && candidate.tenantId === connection.tenantId,
      );
    if (account === null || !serves) {
      return undefined;
    }
    this.checkAccount(account, connection.environment, unusable);
    return Object.freeze({
      tenantId: connection.tenantId,
      environment: connection.environment,
      connectionId: connection.id,
      credentialSource: "velexis",
      credId: account.id,
      clientId: account.clientId,
      encryptedSecret: accountSecret(account),
      baseUrl: baseUrlOf(this.overrides[connection.environment], account.baseUrl, connection.environment),
      offices: Object.freeze({
        queuing: orderOffice,
        owner: orderOffice,
        queue: orderOffice,
        retrieval: orderOffice,
      }),
      officeIds: Object.freeze([orderOffice]),
    });
  }

  /** The shared account `accountId` with its serving offices, through `amadeus:acct:<id>`, or `null`. */
  private async account(accountId: string): Promise<PlatformAmadeusAccount | null> {
    const account = await this.cache.amadeusAccount(
      accountId,
      () => this.platform.amadeusAccountById(accountId),
      parseAmadeusAccount,
    );
    return account === null || account.id !== accountId ? null : account;
  }

  /** A shared account serves `environment` only while it is of that environment and `active`; else 424. */
  private checkAccount(
    account: PlatformAmadeusAccount,
    environment: AmadeusEnvironment,
    unusable: Unusable,
  ): void {
    if (account.environment !== environment) {
      throw unusable("amadeus_account_environment");
    }
    if (account.status !== "active") {
      throw unusable("amadeus_account_not_active");
    }
  }
}
