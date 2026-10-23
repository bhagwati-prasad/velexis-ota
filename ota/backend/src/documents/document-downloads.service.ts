// The downloads of booking documents (OBE-054; OADR-0013 item 9, ADR-0017, ota/docs/flows/ticketing-and-documents.md
// §3 step 8 and §4): bookings.listDocuments and bookings.getDocumentDownloadUrl (`x-scope: customer`, behind the
// booking access guard: the owning customer or the holder of the booking's guest token, 404 for anyone else) and the
// file endpoint `GET /v1/files/{storageKey}` (downloadFile, `security: []`, `x-sdk-exclude`).
//
//   bookings.listDocuments          the booking's `ready` documents (a superseded version, a failed rendering and a
//                                   document not rendered yet are not listed), newest first (`created_at`, then `id`),
//                                   of the `kind`s asked for, with a keyset cursor bound to the booking and the kinds
//   bookings.getDocumentDownloadUrl one document of the booking: `ready` or `superseded` gets a URL of the file endpoint
//                                   signed for five minutes (signed-url.ts; the edge's same-origin `/api/v1/files/…`,
//                                   a key caller's `PUBLIC_OTA_API_URL/v1/files/…`), and the staff-only booking event
//                                   `document.downloaded` in the same transaction; `failed` (and `pending`) answer
//                                   `409 DOCUMENT_NOT_READY` with `details.retryAfterSeconds`; a document of another
//                                   booking is `404`, and so is a failed rendering that a newer version superseded
//                                   (the render job supersedes every earlier row, a failed one too: it never had a
//                                   file, so it gets no URL and no event)
//   downloadFile                   the signature and the expiry first (`403 FORBIDDEN`, one answer for every reason,
//                                   nothing looked up), then the tenant: with a credential (the storefront edge or an
//                                   API key) the tenant the tenant guard resolved must be the storage key's, and the
//                                   document's booking of the request's environment; without one (a browser following a
//                                   key caller's absolute URL) the storage key's tenant, read through the platform
//                                   cache, served while `active` like every other route (PADR-0014). Anything else is
//                                   `404 NOT_FOUND`: another tenant's key, a key without a stored document (a failed
//                                   rendering has no file, superseded or not), a file missing from storage. The bytes
//                                   are read from the StorageAdapter outside any transaction and checked against
//                                   `content_hash` before they are sent (a mismatch is `500` and an error line, never a
//                                   file)
//
// The booking event is written by this module's repository with the shared redactor, as OrderRecorder.event writes the
// bookings module's events; `document.downloaded` asks for no document (documents.processor.ts, DOCUMENT_TRIGGERS),
// which is the one thing OrderRecorder.event adds. The service knows nothing of the bookings module (architecture §2.2:
// bookings → documents): the booking access guard's decision comes from the request context (BookingAccessContext of
// common/auth), and BookingsModule registers DocumentsController, whose booking routes that guard protects. Log lines
// carry ids, kinds and reasons, never a signed URL, a signature or a key.
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types";
import type { StorageAdapter } from "@velexis/db/storage";
import { AppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { BookingAccessContext } from "../common/auth/booking-access.guard";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { PlatformCache } from "../tenancy/platform-cache";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx } from "../tenancy/tenant-tx";
import { DOCUMENT_STORAGE } from "./documents.processor";
import {
  DocumentsRepository,
  FAILED_CONTENT_HASH,
  type ListedDocumentRow,
  type StoredFileRow,
} from "./documents.repository";
import { DocumentUrlSigner, type DocumentKeyParts } from "./signed-url";

type Schemas = components["schemas"];
export type DocumentListItem = Schemas["Document"];
export type DocumentDownloadUrl = Schemas["DocumentDownloadUrl"];

/** A page of documents (bookings.listDocuments). */
export interface DocumentPage {
  readonly data: DocumentListItem[];
  readonly page: Schemas["PageInfo"];
}

/** A document's file, as the file endpoint sends it. */
export interface DocumentFile {
  readonly bytes: Buffer;
  readonly fileName: string;
  readonly contentType: string;
}

/** The staff-only booking event of every download URL (the contract's getBookingDocumentDownloadUrl). */
export const DOCUMENT_DOWNLOADED_EVENT = "document.downloaded";

/** The `Cache-Control` of bookings.listDocuments (personal data) and of the file endpoint (the link expires). */
export const DOCUMENTS_CACHE_CONTROL = "private, no-store";

/** The `Cache-Control` of bookings.getDocumentDownloadUrl (the URL expires). */
export const DOWNLOAD_URL_CACHE_CONTROL = "no-store";

/** The default page size (the document's `Limit`). */
export const DEFAULT_DOCUMENTS_LIMIT = 20;

/** The statuses whose file exists: a superseded version stays downloadable (OADR-0013 item 6). */
const DOWNLOADABLE: ReadonlySet<string> = new Set(["ready", "superseded"]);

/**
 * Whether a row's file was stored: a failed rendering stores nothing (`content_hash` FAILED_CONTENT_HASH,
 * documents.repository.ts) and keeps that hash when the next ready version supersedes it.
 */
const hasStoredFile = (row: { readonly contentHash: string }): boolean =>
  row.contentHash !== FAILED_CONTENT_HASH;

/**
 * `details.retryAfterSeconds` of `409 DOCUMENT_NOT_READY`: a failed rendering is retried by its job (5 attempts,
 * exponential backoff from 30 s, ADR-0009); `pending` is not written by the MVP renderer (documents.repository.ts).
 */
const RETRY_AFTER_SECONDS: Readonly<Record<string, number>> = Object.freeze({ pending: 10, failed: 30 });

/** `403 FORBIDDEN` of a link that is not valid: the same answer for every reason (signed-url.ts). */
function linkRefused(): AppError<"FORBIDDEN"> {
  return new AppError("FORBIDDEN", {
    message: "The download link is not valid or has expired; ask for a new one.",
  });
}

// ---- Cursors -------------------------------------------------------------------------------------------------------

const CURSOR_VERSION = 1;
const CURSOR_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const CURSOR_ID = /^doc_[0-9A-Za-z]{16,40}$/;
const MAX_CURSOR_LENGTH = 400;

/** `400 VALIDATION_FAILED` for a cursor this list did not issue. */
function invalidCursor(): AppError<"VALIDATION_FAILED"> {
  return new AppError("VALIDATION_FAILED", {
    fieldErrors: [{ path: "/query/cursor", code: "cursor", message: "is not a cursor of this list" }],
  });
}

/** The list a cursor belongs to: the booking and the kinds asked for. */
function fingerprintOf(bookingId: string, kinds: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(["documents", bookingId, kinds]))
    .digest("base64url")
    .slice(0, 22);
}

function encodeCursor(fingerprint: string, row: Pick<ListedDocumentRow, "sortKey" | "id">): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, fingerprint, row.sortKey, row.id])).toString(
    "base64url",
  );
}

/** The keyset position of `value` for the list of `fingerprint`; `400 VALIDATION_FAILED` otherwise. */
function decodeCursor(value: string, fingerprint: string): { readonly key: string; readonly id: string } {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    throw invalidCursor();
  }
  const [version, print, key, id] = parsed as unknown[];
  if (
    version !== CURSOR_VERSION ||
    print !== fingerprint ||
    typeof key !== "string" ||
    !CURSOR_KEY.test(key) ||
    typeof id !== "string" ||
    !CURSOR_ID.test(id)
  ) {
    throw invalidCursor();
  }
  return { key, id };
}

/** A listed document as the contract has it. */
function toDocument(row: ListedDocumentRow): DocumentListItem {
  return {
    id: row.id,
    bookingId: row.bookingId,
    kind: row.kind as DocumentListItem["kind"],
    status: row.status as DocumentListItem["status"],
    locale: row.locale,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    ticketId: row.ticketId,
    invoiceNumber: row.invoiceNumber,
    createdAt: row.createdAt.toISOString(),
  };
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** An error's name for a log line (`Error` for anything that is not an Error with a plain name). */
function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : "Error";
}

@Injectable()
export class DocumentDownloadsService {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly access: BookingAccessContext,
    private readonly repository: DocumentsRepository,
    private readonly signer: DocumentUrlSigner,
    private readonly cache: PlatformCache,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(DOCUMENT_STORAGE) private readonly storage: StorageAdapter,
    @InjectPinoLogger(DocumentDownloadsService.name) private readonly logger: PinoLogger,
  ) {}

  // ---- bookings.listDocuments --------------------------------------------------------------------------------------

  /** The booking's ready documents, newest first (see the file header). */
  async list(
    bookingId: string,
    query: {
      readonly kinds?: readonly string[] | undefined;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    },
  ): Promise<DocumentPage> {
    this.access.require(bookingId);
    const kinds = [...new Set(query.kinds ?? [])].sort();
    const limit = query.limit ?? DEFAULT_DOCUMENTS_LIMIT;
    const fingerprint = fingerprintOf(bookingId, kinds);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, fingerprint);
    const rows = await this.tx.run((trx) =>
      this.repository.readyDocuments(trx, bookingId, { kinds, after, limit: limit + 1 }),
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toDocument),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor(fingerprint, last) : null,
        limit,
      },
    };
  }

  // ---- bookings.getDocumentDownloadUrl -----------------------------------------------------------------------------

  /** A signed URL of one document of the booking, and its `document.downloaded` event (see the file header). */
  async downloadUrl(bookingId: string, documentId: string): Promise<DocumentDownloadUrl> {
    const access = this.access.require(bookingId);
    const tenant = this.tenants.require();
    return await this.tx.run(async (trx) => {
      const row = await this.repository.documentOf(trx, bookingId, documentId);
      if (row === undefined) {
        throw new AppError("NOT_FOUND");
      }
      if (!DOWNLOADABLE.has(row.status)) {
        throw new AppError("DOCUMENT_NOT_READY", {
          details: {
            documentId,
            status: row.status,
            retryAfterSeconds: RETRY_AFTER_SECONDS[row.status] ?? RETRY_AFTER_SECONDS["failed"],
          },
        });
      }
      if (!hasStoredFile(row)) {
        // A failed rendering that the next ready version superseded: it never had a file, and never will.
        throw new AppError("NOT_FOUND");
      }
      const signed = this.signer.sign(row.storageKey, tenant.caller.type === "edge" ? "edge" : "key");
      const now = this.clock.now();
      await this.repository.insertBookingEvent(trx, {
        id: this.ids.newId("evt"),
        booking_id: bookingId,
        type: DOCUMENT_DOWNLOADED_EVENT,
        actor_type: tenant.actor.type,
        actor_id: tenant.actor.id,
        status_from: null,
        status_to: null,
        summary: "Document download link issued.",
        data: JSON.stringify(redactPayload({ documentId, kind: row.kind, via: access.via })),
        visible_to_customer: false,
        supplier_request_id: null,
        request_id: this.tenants.requestId() ?? tenant.requestId,
        created_at: now,
        updated_at: now,
      });
      return {
        documentId: row.id,
        url: signed.url,
        expiresAt: signed.expiresAt.toISOString(),
        fileName: row.fileName,
        contentType: row.contentType,
      };
    });
  }

  // ---- downloadFile ------------------------------------------------------------------------------------------------

  /** The file a signed URL names (`requestUrl`: the request's path and query as received; see the file header). */
  async file(requestUrl: string): Promise<DocumentFile> {
    const check = this.signer.verify(requestUrl);
    if (!check.valid) {
      this.logger.info({ reason: check.reason }, "documents.link_refused");
      throw linkRefused();
    }
    const { storageKey, document } = check;
    const requestTenant = this.tenants.get();
    const read = (): Promise<StoredFileRow | undefined> =>
      this.tx.run((trx) => this.repository.fileByStorageKey(trx, storageKey));
    let row: StoredFileRow | undefined;
    if (requestTenant !== undefined) {
      if (requestTenant.schemaName !== document.schemaName) {
        // A link of one OTA through another OTA's storefront or key: answered as an unknown file.
        this.logger.warn(
          {
            securityEvent: "documents.foreign_file",
            tenantId: requestTenant.tenantId,
            callerType: requestTenant.caller.type,
            documentId: document.documentId,
          },
          "documents.file_refused",
        );
        throw new AppError("NOT_FOUND");
      }
      row = await read();
      if (row !== undefined && row.environment !== requestTenant.environment) {
        this.logger.info(
          { documentId: document.documentId, reason: "environment" },
          "documents.file_refused",
        );
        throw new AppError("NOT_FOUND");
      }
    } else {
      const tenant = await this.keyTenant(document);
      row = await this.tenants.run(tenant, read);
    }
    if (
      row === undefined ||
      row.id !== document.documentId ||
      row.bookingId !== document.bookingId ||
      !DOWNLOADABLE.has(row.status) ||
      !hasStoredFile(row)
    ) {
      this.logger.info({ documentId: document.documentId, reason: "no_file" }, "documents.file_refused");
      throw new AppError("NOT_FOUND");
    }
    const stored = row;
    const ids = { documentId: stored.id, bookingId: stored.bookingId };
    const bytes = await this.storage.get(storageKey).catch((error: unknown) => {
      this.logger.error({ ...ids, code: errorName(error) }, "documents.file_unreadable");
      throw error;
    });
    if (bytes === null) {
      this.logger.warn(ids, "documents.file_missing");
      throw new AppError("NOT_FOUND");
    }
    if (sha256(bytes) !== stored.contentHash) {
      this.logger.error(ids, "documents.file_corrupt");
      throw new AppError("INTERNAL_ERROR");
    }
    return { bytes, fileName: stored.fileName, contentType: stored.contentType };
  }

  /**
   * The tenant context of a request without a credential: the storage key's tenant, active only (PADR-0014: a
   * suspended OTA's routes answer nothing), else `404`. Its environment is the tenant's storefront environment, which
   * nothing on this path reads: without a credential the booking's environment is not checked.
   */
  private async keyTenant(document: DocumentKeyParts): Promise<RequestTenant> {
    const tenant = await this.cache.tenantByKey(document.tenantKey);
    if (tenant === null || tenant.status !== "active" || tenant.schemaName !== document.schemaName) {
      this.logger.info(
        { documentId: document.documentId, reason: tenant === null ? "tenant_unknown" : "tenant_not_active" },
        "documents.file_refused",
      );
      throw new AppError("NOT_FOUND");
    }
    const requestId = this.tenants.requestId() ?? "";
    return {
      tenantId: tenant.id,
      key: tenant.key,
      schemaName: tenant.schemaName,
      environment: tenant.storefrontEnvironment,
      caller: { type: "anonymous", id: "anonymous" },
      actor: { type: "guest", id: null },
      requestId,
    };
  }
}
