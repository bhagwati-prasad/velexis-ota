// API key verification (OADR-0009 rule 1.3, PADR-0005, db README §5): the `key` branch of the caller guard.
//
//   X-Api-Key → format → 14-character prefix → `platform.api_keys` row (`apiKeyByPrefix`)
//             → HMAC-SHA-256(pepper, key) compared with `key_hash` in constant time
//             → revoked → expired → kind and environment → scopes → Origin of publishable keys
//
// The key is checked against its stored hash before anything else about the row is used, so a caller that does not
// hold the key learns nothing about it: every refusal answers the same `401 INVALID_API_KEY`, except a publishable key
// sent by a browser origin that the key does not list, which answers `403 ORIGIN_NOT_ALLOWED` (the key itself was
// right). The reason of a refusal is logged (`caller.api_key_refused`, with the key id once the hash matched), never
// the key. A failing platform lookup answers `503 SERVICE_UNAVAILABLE` (OADR-0009 point 5).
//
// The pepper (API_KEY_PEPPER_FILE, the platform's identical copy) is read once when the module starts and stays in
// memory. The Redis cache of the rows (`apikey:<prefix>`, 60 s) and the usage counter come with OBE-012 and OBE-013.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types";
import { verifyApiKey } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import { PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import {
  PlatformReadRepository,
  type ApiKeyEnvironment,
  type ApiKeyKind,
  type PlatformApiKey,
} from "./platform-read.repository";
import { UnexpectedPlatformValueError } from "./platform-read.types";

/** Injection token of the decoded API key pepper (a `Buffer` of at least 32 bytes). */
export const API_KEY_PEPPER = "API_KEY_PEPPER";

/**
 * A publishable or secret key as the platform issues it (PADR-0005 item 1): `pk_`/`sk_`, the environment, and 40
 * base62 characters from a CSPRNG. Anything else is refused before any lookup (hosting keys `hk_` are not served in
 * the MVP; the OTA admin's service key is recognised before this, OBE-060).
 */
export const API_KEY_PATTERN = /^(pk|sk)_(test|live)_[A-Za-z0-9]{40}$/;

/** The visible, unique prefix: `sk_test_` and the first 6 secret characters (PADR-0005 item 2). */
export const API_KEY_PREFIX_LENGTH = 14;

type StaffPermission = components["schemas"]["StaffPermission"];
type ConsoleApiKeyScope = components["schemas"]["ConsoleApiKeyScope"];

/** `ConsoleApiKeyScope` of the OTA document; the unit test checks the list against the document. */
export const CONSOLE_API_KEY_SCOPES = Object.freeze([
  "storefront",
  "console",
  "console:automation",
] as const satisfies readonly ConsoleApiKeyScope[]);

/** `StaffPermission` of the OTA document; the unit test checks the list against the document. */
export const STAFF_PERMISSIONS = Object.freeze([
  "bookings:read",
  "bookings:write",
  "bookings:issue",
  "bookings:cancel",
  "customers:read",
  "queues:read",
  "supplier_requests:read",
  "amadeus:read",
  "amadeus:write",
] as const satisfies readonly StaffPermission[]);

/** A key that passed every check: what the request context keeps of it (never the key or its hash). */
export interface VerifiedApiKey {
  /** `key_` + ULID. */
  readonly id: string;
  readonly tenantId: string;
  readonly kind: Exclude<ApiKeyKind, "hosting">;
  readonly environment: ApiKeyEnvironment;
  readonly scopes: readonly string[];
}

/** Why a key was refused, for the log line. */
export type ApiKeyRefusal =
  | "malformed"
  | "unknown"
  | "hash_mismatch"
  | "revoked"
  | "expired"
  | "row_mismatch"
  | "invalid_scopes"
  | "origin_not_allowed";

/** What the verifier reads from the request besides the key. */
export interface ApiKeyRequest {
  /** The `Origin` header, when the request has one (browsers send it on every cross-origin call). */
  readonly origin?: string | undefined;
}

/**
 * Compared when no row has the prefix, so an unknown prefix costs the same HMAC as a known one (the prefix is not a
 * secret, but the answer should not depend on it). No key hashes to it in practice.
 */
const NO_KEY_HASH = "0".repeat(64);

const KINDS_BY_TEXT: Readonly<Record<string, Exclude<ApiKeyKind, "hosting">>> = {
  pk: "publishable",
  sk: "secret",
};

const PERMISSIONS: ReadonlySet<string> = new Set(STAFF_PERMISSIONS);
const KNOWN_SCOPES: ReadonlySet<string> = new Set([...CONSOLE_API_KEY_SCOPES, ...STAFF_PERMISSIONS]);

/**
 * Why a key's scopes break the rules of PADR-0005 item 6 and `ConsoleApiKeyScope`, or `undefined` when they are
 * valid. Publishable keys have customer scope only: no scope, or `storefront`. Secret keys: only values of the
 * document; `storefront` excludes the console scopes and permissions; permissions only with `console:automation`,
 * which needs at least one. An empty list is valid (customer scope, console with a staff token).
 */
export function scopeProblem(kind: VerifiedApiKey["kind"], scopes: readonly string[]): string | undefined {
  if (kind === "publishable") {
    return scopes.every((scope) => scope === "storefront")
      ? undefined
      : "a publishable key has customer scope only";
  }
  const unknown = scopes.filter((scope) => !KNOWN_SCOPES.has(scope));
  if (unknown.length > 0) {
    return "a scope is not a value of ConsoleApiKeyScope or StaffPermission";
  }
  const permissions = scopes.filter((scope) => PERMISSIONS.has(scope));
  const automation = scopes.includes("console:automation");
  if (scopes.includes("storefront") && scopes.some((scope) => scope !== "storefront")) {
    return "storefront excludes the console scopes and permissions";
  }
  if (permissions.length > 0 && !automation) {
    return "permissions are allowed only with console:automation";
  }
  if (automation && permissions.length === 0) {
    return "console:automation needs at least one permission";
  }
  return undefined;
}

/** True when `origin` is one of the key's allowed origins (exact, case-insensitive: scheme and host are). */
function originAllowed(origin: string, allowed: readonly string[]): boolean {
  const presented = origin.toLowerCase();
  return allowed.some((entry) => entry.toLowerCase() === presented);
}

@Injectable()
export class ApiKeyVerifier {
  constructor(
    private readonly platform: PlatformReadRepository,
    @Inject(API_KEY_PEPPER) private readonly pepper: Buffer,
    private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(ApiKeyVerifier.name);
  }

  /**
   * Verifies a presented `pk_`/`sk_` key. Resolves to the verified key; throws `AppError` `INVALID_API_KEY` (401) for
   * every refusal but one, `ORIGIN_NOT_ALLOWED` (403) for a publishable key from an origin it does not list, and
   * `SERVICE_UNAVAILABLE` (503) when the platform lookup fails.
   */
  async verify(presented: string, request: ApiKeyRequest = {}): Promise<VerifiedApiKey> {
    const format = API_KEY_PATTERN.exec(presented);
    if (format === null) {
      throw this.refuse("malformed");
    }
    const kind = KINDS_BY_TEXT[format[1] ?? ""];
    const environment = format[2];
    const row = await this.lookup(presented.slice(0, API_KEY_PREFIX_LENGTH));
    if (row === null) {
      verifyApiKey(presented, this.pepper, NO_KEY_HASH);
      throw this.refuse("unknown");
    }
    if (!verifyApiKey(presented, this.pepper, row.keyHash)) {
      throw this.refuse("hash_mismatch");
    }
    // From here the caller holds the key: the reasons name the key id in the log.
    if (row.revokedAt !== null) {
      throw this.refuse("revoked", row);
    }
    if (row.expiresAt !== null && Date.parse(row.expiresAt) <= this.clock.now().getTime()) {
      throw this.refuse("expired", row);
    }
    if (kind === undefined || row.kind !== kind || row.environment !== environment || row.tenantId === null) {
      throw this.refuse("row_mismatch", row);
    }
    if (scopeProblem(kind, row.scopes) !== undefined) {
      throw this.refuse("invalid_scopes", row);
    }
    if (
      kind === "publishable" &&
      request.origin !== undefined &&
      !originAllowed(request.origin, row.allowedOrigins)
    ) {
      this.logger.info({ reason: "origin_not_allowed", keyId: row.id }, "caller.api_key_refused");
      throw new AppError("ORIGIN_NOT_ALLOWED", {
        message:
          "This publishable key may not be used from this origin; add it to the key's allowed origins.",
      });
    }
    return Object.freeze({
      id: row.id,
      tenantId: row.tenantId,
      kind,
      environment: row.environment,
      scopes: row.scopes,
    });
  }

  /** The row of the prefix; a failing lookup is a `503`, a row the backend cannot read stays an error. */
  private async lookup(prefix: string): Promise<PlatformApiKey | null> {
    try {
      return await this.platform.apiKeyByPrefix(prefix);
    } catch (error) {
      if (error instanceof UnexpectedPlatformValueError) {
        throw error;
      }
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    }
  }

  /** Logs the refusal (never the key) and returns the error every refusal answers with. */
  private refuse(reason: ApiKeyRefusal, row?: PlatformApiKey): AppError {
    this.logger.info(row === undefined ? { reason } : { reason, keyId: row.id }, "caller.api_key_refused");
    return new AppError("INVALID_API_KEY");
  }
}
