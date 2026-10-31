// The storefront assets (OBE-071; api-changes part 2 §2.5 and §4.2, OADR-0012 points 2 and 3, ADR-0018): the images
// staff upload for the storefront (logos, favicon, Open Graph image, page images), console.settings.assets.list,
// upload and delete (`settings:read` / `settings:write`). One set per OTA, shared by the test and live environments;
// the rows through the storefront context's repository and `TenantTx`, the files through the StorageAdapter
// (ADR-0017) under the tenant's own `tenant_<key>/assets/`. Their public image URL getPublicAsset is the storefront
// context's (storefront/public-assets.service.ts), which imports nothing of this module (lead decision (2a) of
// 2026-10-30, FIX-W34-OTA).
//
// upload, in order (each refusal before anything is written):
//
//   1. The parts (`uploadRequestOf`): the body parsers read the `multipart/form-data` body on this route only
//      (body-parsers.ts, `MULTIPART_BODY_LIMITS` of main.ts: 1 MB and 16 KB); a missing, empty, repeated or unknown
//      part, a `file` part that is no file and a `kind` or `fileName` part that is one are `400 VALIDATION_FAILED`
//      (`/file`, `/kind`, `/fileName`, `/<part name>`). The file name shown in the console is `fileName` (control
//      characters dropped, trimmed, 1 to 200 characters), else the file part's own name without a directory (cut to
//      200 characters), else `<kind>.<ext>`.
//   2. `422 ASSET_INVALID`, `details.reason`: `size` for a file above 1 MB, or a body the parser did not read for being
//      above its limit; `type` for anything the sniffer (image-sniffer.ts) does not read as PNG, JPEG or WebP, or ICO
//      for a `favicon` (the type comes from the bytes, never from the part's `Content-Type` or the file name, so an SVG
//      called `logo.png` is refused); `dimensions` for a logo (`logo`, `logo_dark`, `logo_square`) above 2000 × 2000.
//   3. One transaction: the storage key is `tenant_<key>/assets/<sha256>.<ext>` (`storage_key` is unique: one row
//      holds one file). The row that holds it already is locked and answered when it is of the same kind (the same
//      image again: no second row; its file is written again, which repairs a file lost to a failed delete), and
//      refused with `409 CONFLICT` (`details.reason = "asset_exists"`, `assetId`, `kind`) when it is of another kind.
//      Otherwise the row is inserted (`ast_` id; a concurrent upload of the same file that committed first makes the
//      insert write nothing, and the loop reads that row instead), then the file is stored (unchanged: no re-encoding,
//      so EXIF stays; the OTA admin says so), and the `staff_actions` row `settings.assets.upload` with the asset's
//      metadata (never the file) is written. A failure rolls the row back; a file stored for a row that rolled back
//      is the same bytes any later upload of that image stores again.
//   4. The answer: the asset with its public URL (`<PUBLIC_OTA_API_URL>/v1/assets/<key>/<id>.<ext>`, the key callers'
//      form of storefront.mapper.ts `assetUrl`), `201`, `Cache-Control: private, no-store`.
//
// The idempotency interceptor holds the `Idempotency-Key`; `AssetUploadIdempotencyHooks` makes its request hash cover
// the parts: the text parts as sent, a file part as its part name, file name, size and SHA-256 (never the bytes), so
// the same key with another file is `409 IDEMPOTENCY_KEY_REUSED`.
//
// delete: one transaction: the row is read `FOR UPDATE` (none: `404`), which holds it against a settings update that
// would reference it (its foreign key check waits for the lock); the settings fields that reference it and the content
// pages whose body shows it (`![alt](ast_…)`, OBE-072) answer `409 CONFLICT` (`details.reason = "asset_in_use"`,
// `settingsPaths`, `pageIds`); otherwise the row is deleted, the `staff_actions` row `settings.assets.delete` with its
// metadata written, and, last, the file removed, so an upload of the same image waiting for the row's storage key
// stores its file after the removal. A foreign key refusal of the delete (a reference the checks did not see) is the
// same `409`. `204`.
//
// list: newest first (`created_at`, then `id`), `kind` when given, a keyset cursor bound to the kind filter (`400
// VALIDATION_FAILED` at `/query/cursor` for another list's), `limit` 1 to 100 (20).
//
// Log lines carry ids and reasons, never a file name or bytes.
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types";
import type { StorageAdapter } from "@velexis/db/storage";
import { AppError, type FieldError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { MultipartBody, type MultipartFile, type MultipartPart } from "../common/http/body-parsers";
import { IdGenerator } from "../common/ids";
import {
  IdempotencyHooksFor,
  type IdempotencyHooks,
  type IdempotentInput,
} from "../common/http/idempotency.service";
import { escapePointer, MAX_FIELD_ERRORS } from "../common/http/openapi-validation.interceptor";
import type { ApiConfig } from "../config";
import { consoleAction, StaffActionsWriter } from "../console/staff-actions.writer";
import { DOCUMENT_STORAGE } from "../documents/documents.processor";
import { decodeKeysetCursor, encodeCursor, invalidCursor, pageLimit } from "../reference/reference.mapper";
import { assetUrl } from "../storefront/storefront.mapper";
import {
  StorefrontRepository,
  type ListedAssetRow,
  type StoredAssetRow,
} from "../storefront/storefront.repository";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { sniffImage, type SniffedImage } from "./image-sniffer";

type Schemas = components["schemas"];
export type StorefrontAsset = Schemas["StorefrontAsset"];
export type StorefrontAssetPage = Schemas["StorefrontAssetPage"];
export type StorefrontAssetKind = Schemas["StorefrontAssetKind"];

/** The largest file an asset may be (api-changes part 2 §2.5): 1 MB. */
export const ASSET_MAX_BYTES = 1_048_576;

/** Room in an upload's body for the multipart framing and the other parts. */
export const ASSET_UPLOAD_PARTS_BYTES = 16 * 1024;

/** The body limit of the upload route (`MULTIPART_BODY_LIMITS` of main.ts): a body above it is `size`, unread. */
export const ASSET_UPLOAD_BODY_LIMIT_BYTES = ASSET_MAX_BYTES + ASSET_UPLOAD_PARTS_BYTES;

/** The largest width and height of a logo (OADR-0012 point 2). */
export const LOGO_MAX_DIMENSION = 2000;

/** The `Cache-Control` of the console's answers. */
export const ASSETS_CACHE_CONTROL = "private, no-store";

/** The asset kinds of the document (`StorefrontAssetKind`), in its order. */
export const ASSET_KINDS = Object.freeze([
  "logo",
  "logo_dark",
  "logo_square",
  "favicon",
  "og_image",
  "page_image",
] as const satisfies readonly StorefrontAssetKind[]);

/** The kinds whose dimensions are limited: the logos. */
const LOGO_KINDS: ReadonlySet<string> = new Set(["logo", "logo_dark", "logo_square"]);

/** The longest file name kept (`storefront_assets.file_name`). */
const MAX_FILE_NAME = 200;

/** The longest part name an error path quotes. */
const MAX_PART_NAME = 100;

/** The parts of an upload (`StorefrontAssetUpload`). */
const UPLOAD_PARTS: ReadonlySet<string> = new Set(["file", "kind", "fileName"]);

/** An upload whose parts passed step 1 (see the file header). */
export interface AssetUploadRequest {
  readonly kind: StorefrontAssetKind;
  /** The name to show, when the parts give one (`fileName`, else the file part's); else `<kind>.<ext>`. */
  readonly fileName: string | undefined;
  readonly bytes: Buffer;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A name as it is kept: control characters dropped, trimmed, at most 200 characters (code points). */
export function displayName(value: string): string {
  // eslint-disable-next-line no-control-regex -- the control characters are what is dropped
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return Array.from(cleaned).slice(0, MAX_FILE_NAME).join("");
}

/** The file part's name without a directory (a browser may send `C:\fakepath\logo.png`), as it is kept. */
function baseName(fileName: string): string {
  return displayName(fileName.split(/[\\/]/).at(-1) ?? "");
}

/** `400 VALIDATION_FAILED` with these field errors. */
function partsRefused(fieldErrors: FieldError[]): AppError {
  return new AppError("VALIDATION_FAILED", { fieldErrors: fieldErrors.slice(0, MAX_FIELD_ERRORS) });
}

/** `422 ASSET_INVALID` with its reason. */
function assetInvalid(reason: "type" | "size" | "dimensions", message: string): AppError {
  return new AppError("ASSET_INVALID", { message, details: { reason } });
}

const isAssetKind = (value: string): value is StorefrontAssetKind =>
  (ASSET_KINDS as readonly string[]).includes(value);

/**
 * Step 1 of the file header: the upload's parts, checked, or `"too_large"` for a body the parser did not read. A body
 * that is no multipart body (none was sent) misses every part.
 */
export function uploadRequestOf(body: unknown): AssetUploadRequest | "too_large" {
  if (body instanceof MultipartBody && body.tooLarge) {
    return "too_large";
  }
  const parts: readonly MultipartPart[] = body instanceof MultipartBody ? body.parts : [];
  const errors: FieldError[] = [];
  const seen = new Map<string, MultipartPart>();
  for (const part of parts) {
    const path = `/${escapePointer(part.name.slice(0, MAX_PART_NAME))}`;
    if (!UPLOAD_PARTS.has(part.name)) {
      errors.push({ path, code: "additionalProperties", message: "is not a part of the upload" });
    } else if (seen.has(part.name)) {
      errors.push({ path, code: "duplicate", message: "is sent more than once" });
    } else {
      seen.set(part.name, part);
    }
  }
  const file = seen.get("file");
  if (file === undefined) {
    errors.push({ path: "/file", code: "required", message: "The image file is required" });
  } else if (file.type !== "file") {
    errors.push({ path: "/file", code: "type", message: "must be a file" });
  } else if (file.bytes.length === 0) {
    errors.push({ path: "/file", code: "minLength", message: "must not be empty" });
  }
  const kind = seen.get("kind");
  if (kind === undefined) {
    errors.push({ path: "/kind", code: "required", message: "The kind of image is required" });
  } else if (kind.type !== "field") {
    errors.push({ path: "/kind", code: "type", message: "must be text, not a file" });
  } else if (!isAssetKind(kind.value)) {
    errors.push({ path: "/kind", code: "enum", message: `must be one of ${ASSET_KINDS.join(", ")}` });
  }
  const name = seen.get("fileName");
  let fileName: string | undefined;
  if (name !== undefined) {
    if (name.type !== "field") {
      errors.push({ path: "/fileName", code: "type", message: "must be text, not a file" });
    } else {
      fileName = displayName(name.value);
      if (fileName === "") {
        errors.push({ path: "/fileName", code: "minLength", message: "must not be empty" });
      } else if (Array.from(name.value.trim()).length > MAX_FILE_NAME) {
        errors.push({
          path: "/fileName",
          code: "maxLength",
          message: `must be at most ${MAX_FILE_NAME} characters`,
        });
      }
    }
  }
  if (errors.length > 0 || file?.type !== "file" || kind?.type !== "field" || !isAssetKind(kind.value)) {
    throw partsRefused(errors);
  }
  const ownName = baseName(file.fileName);
  return {
    kind: kind.value,
    fileName: fileName ?? (ownName === "" ? undefined : ownName),
    bytes: file.bytes,
  };
}

/**
 * Step 2 of the file header: the image an upload holds, or `422 ASSET_INVALID` (`size`, then `type`, then
 * `dimensions`).
 */
export function checkedImage(kind: StorefrontAssetKind, bytes: Buffer): SniffedImage {
  if (bytes.length > ASSET_MAX_BYTES) {
    throw tooLarge();
  }
  const image = sniffImage(bytes);
  if (image === null || (image.format === "ico" && kind !== "favicon")) {
    throw assetInvalid(
      "type",
      kind === "favicon"
        ? "Upload a PNG, JPEG, WebP or ICO image; SVG files are not accepted."
        : "Upload a PNG, JPEG or WebP image; SVG files are not accepted.",
    );
  }
  if (LOGO_KINDS.has(kind) && (image.width > LOGO_MAX_DIMENSION || image.height > LOGO_MAX_DIMENSION)) {
    throw assetInvalid(
      "dimensions",
      `A logo may be at most ${LOGO_MAX_DIMENSION} × ${LOGO_MAX_DIMENSION} pixels.`,
    );
  }
  return image;
}

/** `422 ASSET_INVALID`, `size`. */
function tooLarge(): AppError {
  return assetInvalid("size", "The image is larger than 1 MB.");
}

/** What `staff_actions` records of an asset: its metadata, never the file. */
function auditView(row: StoredAssetRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    fileName: row.fileName,
    contentHash: row.contentHash,
  };
}

/** Whether `error` is PostgreSQL's foreign key violation (a settings reference refused the delete). */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23503";
}

/** `409 CONFLICT` of an asset in use. */
function assetInUse(settingsPaths: readonly string[], pageIds: readonly string[]): AppError {
  return new AppError("CONFLICT", {
    message: "The image is in use by the storefront settings or a page; replace it there first.",
    details: { reason: "asset_in_use", settingsPaths: [...settingsPaths], pageIds: [...pageIds] },
  });
}

// ---- The list cursor ------------------------------------------------------------------------------------------------

const CURSOR_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const ASSET_ID = /^ast_[0-9A-Za-z]{16,40}$/;
/** The kind filter as a cursor records it: `*` for none. */
const filterOf = (kind: string | undefined): string => kind ?? "*";

/** The position after `row` in the list of `kind`. */
export function encodeAssetCursor(
  kind: string | undefined,
  row: Pick<ListedAssetRow, "sortKey" | "id">,
): string {
  return encodeCursor({ t: row.sortKey, i: row.id, k: filterOf(kind) });
}

/** The keyset position of a cursor of the list of `kind`; `400 VALIDATION_FAILED` (`/query/cursor`) otherwise. */
export function decodeAssetCursor(
  kind: string | undefined,
  cursor: string,
): { readonly key: string; readonly id: string } {
  const { t, i, k } = decodeKeysetCursor(cursor, ["t", "i", "k"]);
  if (!CURSOR_KEY.test(t) || !ASSET_ID.test(i) || k !== filterOf(kind)) {
    throw invalidCursor();
  }
  return { key: t, id: i };
}

@Injectable()
export class AssetsService {
  private readonly publicApiUrl: string;

  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly repository: StorefrontRepository,
    private readonly writer: StaffActionsWriter,
    private readonly ids: IdGenerator,
    @Inject(DOCUMENT_STORAGE) private readonly storage: StorageAdapter,
    config: ConfigService<ApiConfig, true>,
    @InjectPinoLogger(AssetsService.name) private readonly logger: PinoLogger,
  ) {
    this.publicApiUrl = config.get("PUBLIC_OTA_API_URL", { infer: true });
  }

  /** An asset row as the console shows it, with its absolute public URL. */
  private toAsset(tenantKey: string, row: StoredAssetRow): StorefrontAsset {
    return {
      id: row.id,
      kind: row.kind as StorefrontAssetKind,
      contentType: row.contentType as StorefrontAsset["contentType"],
      sizeBytes: row.sizeBytes,
      width: row.width,
      height: row.height,
      fileName: row.fileName,
      url: assetUrl(
        tenantKey,
        { id: row.id, extension: row.fileExtension },
        { caller: "key", publicApiUrl: this.publicApiUrl },
      ),
      createdAt: row.createdAt.toISOString(),
    };
  }

  // ---- console.settings.assets.list -------------------------------------------------------------------------------

  /** One page of the assets, newest first (see the file header). */
  async list(query: {
    readonly kind?: StorefrontAssetKind | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<StorefrontAssetPage> {
    const tenant = this.tenants.require();
    const limit = pageLimit(query.limit);
    const after = query.cursor === undefined ? undefined : decodeAssetCursor(query.kind, query.cursor);
    const rows = await this.tx.run((trx) =>
      this.repository.listAssets(trx, { kind: query.kind, after, limit: limit + 1 }),
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => this.toAsset(tenant.key, row)),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodeAssetCursor(query.kind, last) : null,
        limit,
      },
    };
  }

  // ---- console.settings.assets.upload -----------------------------------------------------------------------------

  /** Steps 1 to 4 of the file header, for the request's validated multipart body. */
  async upload(body: unknown): Promise<StorefrontAsset> {
    const request = uploadRequestOf(body);
    if (request === "too_large") {
      throw tooLarge();
    }
    const image = checkedImage(request.kind, request.bytes);
    const tenant = this.tenants.require();
    const contentHash = sha256(request.bytes);
    const storageKey = `${tenant.schemaName}/assets/${contentHash}.${image.extension}`;
    const row = await this.tx.run((trx) => this.store(trx, { request, image, contentHash, storageKey }));
    this.logger.info({ assetId: row.id, kind: row.kind, sizeBytes: row.sizeBytes }, "assets.uploaded");
    return this.toAsset(tenant.key, row);
  }

  /** Step 3 of the file header, in the upload's transaction. */
  private async store(
    trx: TenantTransaction,
    upload: {
      readonly request: AssetUploadRequest;
      readonly image: SniffedImage;
      readonly contentHash: string;
      readonly storageKey: string;
    },
  ): Promise<StoredAssetRow> {
    const { request, image, contentHash, storageKey } = upload;
    const actor = this.tenants.require().actor;
    // A concurrent upload of the same file may commit between the read and the insert: then the insert writes
    // nothing and the next turn reads its row. A third turn would mean the row was deleted meanwhile too.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await this.repository.assetByStorageKeyForUpdate(trx, storageKey);
      if (existing !== undefined) {
        if (existing.kind !== request.kind) {
          throw new AppError("CONFLICT", {
            message: "This file is already uploaded as an image of another kind; delete that one first.",
            details: { reason: "asset_exists", assetId: existing.id, kind: existing.kind },
          });
        }
        await this.storage.put(storageKey, request.bytes, existing.contentType);
        const view = auditView(existing);
        await this.writer.record(trx, {
          action: consoleAction("consoleUploadStorefrontAsset"),
          targetType: "storefront_asset",
          targetId: existing.id,
          before: view,
          after: view,
        });
        return existing;
      }
      const inserted = await this.repository.insertAsset(trx, {
        id: this.ids.newId("ast"),
        kind: request.kind,
        content_type: image.contentType,
        file_extension: image.extension,
        file_name: request.fileName ?? `${request.kind}.${image.extension}`,
        size_bytes: request.bytes.length,
        width: image.width,
        height: image.height,
        storage_key: storageKey,
        content_hash: contentHash,
        uploaded_by_staff_id: actor.type === "staff" ? actor.id : null,
      });
      if (inserted !== undefined) {
        await this.storage.put(storageKey, request.bytes, image.contentType);
        await this.writer.record(trx, {
          action: consoleAction("consoleUploadStorefrontAsset"),
          targetType: "storefront_asset",
          targetId: inserted.id,
          before: null,
          after: auditView(inserted),
        });
        return inserted;
      }
    }
    throw new Error("storefront asset upload: the storage key kept changing hands");
  }

  // ---- console.settings.assets.delete -----------------------------------------------------------------------------

  /** The delete of the file header. */
  async delete(assetId: string): Promise<void> {
    let deleted: StoredAssetRow;
    try {
      deleted = await this.tx.run((trx) => this.remove(trx, assetId));
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw assetInUse([], []);
      }
      throw error;
    }
    this.logger.info({ assetId: deleted.id, kind: deleted.kind }, "assets.deleted");
  }

  /** The delete's transaction. */
  private async remove(trx: TenantTransaction, assetId: string): Promise<StoredAssetRow> {
    const row = await this.repository.assetById(trx, assetId, { forUpdate: true });
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const settingsPaths = await this.repository.settingsReferencing(trx, assetId);
    const pageIds = await this.repository.pagesShowing(trx, assetId);
    if (settingsPaths.length > 0 || pageIds.length > 0) {
      throw assetInUse(settingsPaths, pageIds);
    }
    await this.repository.deleteAsset(trx, assetId);
    await this.writer.record(trx, {
      action: consoleAction("consoleDeleteStorefrontAsset"),
      targetType: "storefront_asset",
      targetId: row.id,
      before: auditView(row),
      after: null,
    });
    // Last: an upload of the same image waits for this row's storage key and stores its file after the removal.
    await this.storage.delete(row.storageKey);
    return row;
  }
}

/**
 * The request hash of console.settings.assets.upload (see the file header): the parts in the order sent, the files as
 * their part name, file name, size and SHA-256.
 */
@Injectable()
@IdempotencyHooksFor(["consoleUploadStorefrontAsset"])
export class AssetUploadIdempotencyHooks implements IdempotencyHooks {
  hashInput(input: IdempotentInput): unknown {
    const body = input.body;
    const fileOf = (part: MultipartFile): unknown[] => [
      "file",
      part.name,
      part.fileName,
      part.bytes.length,
      sha256(part.bytes),
    ];
    return {
      path: input.path,
      query: input.query,
      upload:
        body instanceof MultipartBody
          ? {
              tooLarge: body.tooLarge,
              parts: body.parts.map((part) =>
                part.type === "file" ? fileOf(part) : ["field", part.name, part.value],
              ),
            }
          : null,
    };
  }
}
