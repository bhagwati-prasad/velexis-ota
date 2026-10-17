// The API key generator (PADR-0005 items 1 to 4; platform/docs/flows/api-keys.md): the only code that makes a key.
//
//   key       = `<pk|sk>_<test|live>_` + 40 base62 characters from Node's CSPRNG (about 238 bits)
//   prefix    = the first 14 characters (`sk_test_` + 6), unique, shown in the portal and the OTA's lookup key
//   last4     = the last 4 characters
//   key_hash  = hex(HMAC-SHA-256(pepper, key)), the pepper of API_KEY_PEPPER_FILE (`hashApiKey` of @velexis/crypto)
//
// `ApiKeyGenerator.issue` writes the row in the caller's transaction with `INSERT … ON CONFLICT DO NOTHING`, so a
// prefix that exists already (about 1 in 56 billion per pair of keys) costs a new key, not the transaction; after
// three collisions it fails with `500 INTERNAL_ERROR`. The full key is returned to the caller once and never stored,
// logged or kept for a replay: only the prefix, `last4` and the HMAC reach the row. `issueInitialTestKeys` makes the
// two test keys of a new OTA for provisioning (PBE-022), which keeps them envelope-encrypted for a single reveal.
import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { hashApiKey } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import type { ApiKeyEnvironment, ApiKeyKind } from "./api-key-rules";
import { DEFAULT_SECRET_KEY_SCOPES } from "./api-key-rules";
import { ApiKeysRepository, type ApiKeyRecord } from "./api-keys.repository";

/** Injection token of the decoded API key pepper (a `Buffer` of at least 32 bytes, read once at start-up). */
export const API_KEY_PEPPER = "API_KEY_PEPPER";

/** The base62 characters after the kind and environment (PADR-0005 item 1). */
export const API_KEY_SECRET_LENGTH = 40;
/** The visible, unique prefix: `sk_test_` and the first 6 secret characters (PADR-0005 item 2). */
export const API_KEY_PREFIX_LENGTH = 14;
/** How many keys `issue` makes at most when their prefixes exist already (PADR-0005 item 2). */
export const API_KEY_MAX_TRIES = 3;
/** A key as the generator makes it (and the OTA backend accepts it). */
export const API_KEY_PATTERN = /^(pk|sk)_(test|live)_[A-Za-z0-9]{40}$/;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** The largest multiple of 62 a byte can hold: bytes from it up are drawn again, so every character is uniform. */
const BASE62_BYTE_LIMIT = 248;

/** The text of a kind in a key. */
export const API_KEY_KIND_TEXT: Readonly<Record<ApiKeyKind, "pk" | "sk">> = Object.freeze({
  publishable: "pk",
  secret: "sk",
});

/** `length` characters of base62, each uniform, from the CSPRNG (rejection sampling of random bytes). */
export function randomBase62(length: number): string {
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new RangeError("randomBase62(): length must be a positive integer");
  }
  let text = "";
  while (text.length < length) {
    const bytes = randomBytes(length - text.length + 8);
    for (const byte of bytes) {
      if (byte < BASE62_BYTE_LIMIT && text.length < length) {
        text += BASE62[byte % 62] ?? "";
      }
    }
    bytes.fill(0);
  }
  return text;
}

/** A new key and what is stored of it. */
export interface GeneratedApiKey {
  /** The full key: answered once, never stored or logged. */
  readonly key: string;
  readonly prefix: string;
  readonly last4: string;
  /** `hex(HMAC-SHA-256(pepper, key))`, the only form of the key that is stored. */
  readonly keyHash: string;
}

/** Makes a key of `kind` and `environment` and its prefix, `last4` and hash under `pepper`. */
export function generateApiKey(
  kind: ApiKeyKind,
  environment: ApiKeyEnvironment,
  pepper: Buffer,
): GeneratedApiKey {
  const key = `${API_KEY_KIND_TEXT[kind]}_${environment}_${randomBase62(API_KEY_SECRET_LENGTH)}`;
  return {
    key,
    prefix: key.slice(0, API_KEY_PREFIX_LENGTH),
    last4: key.slice(-4),
    keyHash: hashApiKey(key, pepper),
  };
}

/** The settings of a key to issue. */
export interface NewApiKey {
  readonly tenantId: string;
  readonly name: string;
  readonly kind: ApiKeyKind;
  readonly environment: ApiKeyEnvironment;
  readonly allowedOrigins: readonly string[];
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  /** The account that creates it; `null` for the keys of provisioning. */
  readonly createdByAccountId: string | null;
}

/** A key written to `api_keys`: the stored row and the full key, which the caller answers once. */
export interface IssuedApiKey {
  readonly row: ApiKeyRecord;
  readonly key: string;
}

/** The two test keys of a new OTA (PBE-022 keeps them encrypted for one reveal by an owner). */
export interface InitialTestKeys {
  readonly publishable: IssuedApiKey;
  readonly secret: IssuedApiKey;
}

/** The names of the initial test keys, as the portal lists them. */
export const INITIAL_TEST_KEY_NAMES = Object.freeze({
  publishable: "Initial test key (publishable)",
  secret: "Initial test key (secret)",
} as const satisfies Record<ApiKeyKind, string>);

/** The audit facts of a key: its prefix, kind, environment and scopes, never the key or its hash. */
export function apiKeyAuditFacts(
  row: Pick<ApiKeyRecord, "prefix" | "kind" | "environment" | "scopes">,
): Record<string, unknown> {
  return { prefix: row.prefix, kind: row.kind, environment: row.environment, scopes: [...row.scopes] };
}

@Injectable()
export class ApiKeyGenerator {
  constructor(
    private readonly repository: ApiKeysRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    @Inject(API_KEY_PEPPER) private readonly pepper: Buffer,
  ) {}

  /**
   * Generates a key with the settings of `input` and inserts its row in `trx`, the caller's transaction. A prefix (or
   * id) that exists already costs a new key, at most API_KEY_MAX_TRIES keys in all; then `500 INTERNAL_ERROR`.
   */
  async issue(trx: PlatformTransaction, input: NewApiKey): Promise<IssuedApiKey> {
    const now = this.clock.now();
    for (let attempt = 1; attempt <= API_KEY_MAX_TRIES; attempt += 1) {
      const generated = generateApiKey(input.kind, input.environment, this.pepper);
      const row = await this.repository.insertIfNew(trx, {
        id: this.ids.new("key"),
        tenant_id: input.tenantId,
        name: input.name,
        kind: input.kind,
        environment: input.environment,
        prefix: generated.prefix,
        key_hash: generated.keyHash,
        last4: generated.last4,
        allowed_origins: [...input.allowedOrigins],
        scopes: [...input.scopes],
        expires_at: input.expiresAt,
        created_by_account_id: input.createdByAccountId,
        created_at: now,
        updated_at: now,
      });
      if (row !== undefined) {
        return { row, key: generated.key };
      }
    }
    throw new AppError("INTERNAL_ERROR", { message: "No unique API key could be generated; try again." });
  }

  /**
   * The two test keys of a new OTA (platform/docs/flows/api-keys.md step 4), in `trx`: `pk_test_…` without origins
   * and `sk_test_…` scoped `storefront`, created by nobody, each with an `api_key.created` audit row of the system.
   * Returns the full keys once; the caller encrypts them for the reveal and never stores them in clear.
   */
  async issueInitialTestKeys(trx: PlatformTransaction, tenantId: string): Promise<InitialTestKeys> {
    const issue = async (kind: ApiKeyKind): Promise<IssuedApiKey> => {
      const issued = await this.issue(trx, {
        tenantId,
        name: INITIAL_TEST_KEY_NAMES[kind],
        kind,
        environment: "test",
        allowedOrigins: [],
        scopes: kind === "secret" ? DEFAULT_SECRET_KEY_SCOPES : [],
        expiresAt: null,
        createdByAccountId: null,
      });
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: "provisioning",
        action: "api_key.created",
        targetType: "api_key",
        targetId: issued.row.id,
        tenantId,
        details: apiKeyAuditFacts(issued.row),
      });
      return issued;
    };
    const publishable = await issue("publishable");
    const secret = await issue("secret");
    return { publishable, secret };
  }
}
