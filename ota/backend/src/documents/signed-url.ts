// The signed URLs of booking documents (OBE-054; OADR-0013 item 9, ADR-0017 "Signed URLs", ADR-0010): what
// bookings.getDocumentDownloadUrl hands out and what the file endpoint `GET /v1/files/{storageKey}` (downloadFile)
// accepts.
//
//   path       `/v1/files/<storageKey>`, the storage key with its `/` as they are (`tenant_<key>/documents/<bookingId>/
//              <documentId>.pdf`, documents.processor.ts), so the path is the one the API receives
//   signature  `signUrl` of @velexis/crypto: `<path>?exp=<unix seconds>&sig=<base64url HMAC-SHA-256 of
//              "<path>?exp=<exp>">` with the decoded `document-url.key` (DOCUMENT_URL_KEY_FILE, read once at start-up);
//              valid 5 minutes, `exp` rounded down to the second, and a link is valid up to and including `exp`
//   the URL    the edge (the hosted storefront) gets the same-origin path `/api<signed path>`: Caddy proxies a storefront
//              host's `/api/*` to the API without the prefix (deploy/caddy/Caddyfile), so `img-src`/`connect-src 'self'`
//              hold and the API sees the signed path; a key caller gets `<PUBLIC_OTA_API_URL><signed path>`, an absolute
//              URL on `api.ota.example.com` (the same rule as the asset URLs of storefront.get, OADR-0012 point 3)
//
// Only the path and `exp` are signed, never the host: one link works on either host, and the file endpoint checks the
// tenant itself (document-downloads.service.ts). Verifying takes the request's URL as Express received it
// (`req.originalUrl`): its path must be one `signUrl` can sign (unreserved characters, no dot segment, no
// percent-encoding) and its query exactly `exp=…&sig=…`; the signature is compared in constant time. Every refusal
// has the same answer (`403 FORBIDDEN`); the reason (`malformed`, `signature`, `expired`, `not_a_document`) is for the
// log line only. A signed URL is a credential for its five minutes: it is never logged, neither are `sig` nor the key.
import { Inject, Injectable, type FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readKeyFile } from "@velexis/config";
import { SIGNED_URL_KEY_MIN_BYTES, signUrl, verifySignedUrl } from "@velexis/crypto";
import { Clock } from "../common/clock";
import type { ApiConfig } from "../config";

/** How long a signed document URL works (OADR-0013 item 9). */
export const DOCUMENT_URL_TTL_SECONDS = 300;

/** The path of the file endpoint, before the storage key. */
export const FILES_PATH_PREFIX = "/v1/files/";

/** The prefix under which the hosted storefront reaches the API on its own origin (Caddy strips it). */
export const EDGE_API_PREFIX = "/api";

/** Injection token of the decoded `document-url.key`. */
export const DOCUMENT_URL_KEY = "DOCUMENT_URL_KEY";

/**
 * A booking document's storage key (documents.processor.ts): the tenant's schema (the shape of `TENANT_SCHEMA_PATTERN`
 * of @velexis/db), `documents`, the booking id and the document id with `.pdf`.
 */
const DOCUMENT_STORAGE_KEY =
  /^(tenant_[a-z][a-z0-9_]{1,39})\/documents\/(bkg_[0-9A-Za-z]{16,40})\/(doc_[0-9A-Za-z]{16,40})\.pdf$/;

/** What a document's storage key names. */
export interface DocumentKeyParts {
  /** `tenant_<key>`. */
  readonly schemaName: string;
  /** The tenant key: the schema name without `tenant_`. */
  readonly tenantKey: string;
  readonly bookingId: string;
  readonly documentId: string;
}

/** The parts of a booking document's storage key, or `undefined` when `storageKey` is not one. */
export function parseDocumentKey(storageKey: string): DocumentKeyParts | undefined {
  const match = DOCUMENT_STORAGE_KEY.exec(storageKey);
  if (match === null) {
    return undefined;
  }
  const [, schemaName = "", bookingId = "", documentId = ""] = match;
  return { schemaName, tenantKey: schemaName.slice("tenant_".length), bookingId, documentId };
}

/** The file endpoint's path of a storage key: `/v1/files/<storageKey>`. */
export function documentFilePath(storageKey: string): string {
  return `${FILES_PATH_PREFIX}${storageKey}`;
}

/** Who gets the URL: the storefront edge (a same-origin path), or a key caller (an absolute URL on the API host). */
export type DocumentUrlAudience =
  { readonly caller: "edge" } | { readonly caller: "key"; readonly publicApiUrl: string };

/** A signed document URL and the end of its validity (`exp`). */
export interface SignedDocumentUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

/** The end of validity of a URL signed at `now`: five minutes later, rounded down to the second (`exp`). */
export function documentUrlExpiry(now: Date): Date {
  return new Date(Math.floor((now.getTime() + DOCUMENT_URL_TTL_SECONDS * 1000) / 1000) * 1000);
}

/** Signs the file endpoint's path of `storageKey` at `now` with `key`, as `audience` follows it (see the header). */
export function signDocumentUrl(
  storageKey: string,
  options: { readonly key: Uint8Array; readonly now: Date; readonly audience: DocumentUrlAudience },
): SignedDocumentUrl {
  const expiresAt = documentUrlExpiry(options.now);
  const signed = signUrl(documentFilePath(storageKey), { expiresAt, key: options.key });
  const url =
    options.audience.caller === "edge"
      ? `${EDGE_API_PREFIX}${signed}`
      : `${options.audience.publicApiUrl.replace(/\/+$/, "")}${signed}`;
  return { url, expiresAt };
}

/** Why a request URL was refused: every reason answers the same `403 FORBIDDEN`. */
export type DocumentUrlRefusal = "malformed" | "signature" | "expired" | "not_a_document";

/** The outcome of checking a request's URL. */
export type DocumentUrlCheck =
  | {
      readonly valid: true;
      /** The signed storage key, with its parts. */
      readonly storageKey: string;
      readonly document: DocumentKeyParts;
      readonly expiresAt: Date;
    }
  | { readonly valid: false; readonly reason: DocumentUrlRefusal };

/**
 * Checks the URL of a file request (`req.originalUrl`: the path as signed, then `?exp=…&sig=…`) at `now` with `key`:
 * the signature first, then that the signed path is the file endpoint's path of a booking document's storage key.
 */
export function verifyDocumentUrl(
  requestUrl: string,
  options: { readonly key: Uint8Array; readonly now: Date },
): DocumentUrlCheck {
  const verified = verifySignedUrl(requestUrl, options);
  if (!verified.valid) {
    return verified;
  }
  if (!verified.path.startsWith(FILES_PATH_PREFIX)) {
    return { valid: false, reason: "not_a_document" };
  }
  const storageKey = verified.path.slice(FILES_PATH_PREFIX.length);
  const document = parseDocumentKey(storageKey);
  if (document === undefined) {
    return { valid: false, reason: "not_a_document" };
  }
  return { valid: true, storageKey, document, expiresAt: verified.expiresAt };
}

/**
 * The decoded `document-url.key` (DOCUMENT_URL_KEY_FILE), read once at start-up; the configuration checked the file
 * (mode 0400 or 0600, at least 32 bytes after base64 decoding). It stays in this process's memory, never logged.
 */
export const documentUrlKeyProvider: FactoryProvider<Buffer> = {
  provide: DOCUMENT_URL_KEY,
  inject: [ConfigService],
  useFactory: (config: ConfigService<ApiConfig, true>) => {
    const key = readKeyFile(config.get("DOCUMENT_URL_KEY_FILE", { infer: true }), {
      minBytes: SIGNED_URL_KEY_MIN_BYTES,
    });
    if (!Buffer.isBuffer(key)) {
      throw new TypeError("DOCUMENT_URL_KEY_FILE must be a base64 key file");
    }
    return key;
  },
};

/** Signs and checks document URLs with the process's key and the injected clock (API only). */
@Injectable()
export class DocumentUrlSigner {
  private readonly publicApiUrl: string;

  constructor(
    @Inject(DOCUMENT_URL_KEY) private readonly key: Buffer,
    private readonly clock: Clock,
    config: ConfigService<ApiConfig, true>,
  ) {
    this.publicApiUrl = config.get("PUBLIC_OTA_API_URL", { infer: true });
  }

  /** A URL of the file endpoint for `storageKey`, valid five minutes from now, for the edge or a key caller. */
  sign(storageKey: string, caller: "edge" | "key"): SignedDocumentUrl {
    return signDocumentUrl(storageKey, {
      key: this.key,
      now: this.clock.now(),
      audience: caller === "edge" ? { caller } : { caller, publicApiUrl: this.publicApiUrl },
    });
  }

  /** Checks the URL of a file request now (see `verifyDocumentUrl`). */
  verify(requestUrl: string): DocumentUrlCheck {
    return verifyDocumentUrl(requestUrl, { key: this.key, now: this.clock.now() });
  }
}
