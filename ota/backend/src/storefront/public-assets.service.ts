// The public read of the storefront assets, getPublicAsset (OBE-071; api-changes part 2 §4.2, OADR-0012 point 3 and
// its revision of 2026-10-30): the file behind `GET /v1/assets/{tenantKey}/{assetId}.{ext}`, for
// public-assets.controller.ts. It lives in the storefront context, which imports nothing of the settings context
// (lead decision (2a) of 2026-10-30, FIX-W34-OTA; the guard test is module-direction.test.ts): the settings context
// uploads and deletes the assets (settings/assets.service.ts) and may depend on this one, never the reverse. It reads
// the `storefront_assets` row through the storefront context's own repository and `TenantTx`, and the file through the
// StorageAdapter of ADR-0017 (the documents module's `documentStorageProvider`, STORAGE_DRIVER and STORAGE_DIR), as
// the upload wrote it.
//
// publicFile: the path's tenant key chooses the OTA, whatever credential comes with the request (the tenant guard
// leaves this operation alone): read through the platform cache, served while `active` or `suspended` (a suspended
// storefront's maintenance page still shows its logo); the asset row in that tenant's schema (`TenantContext.run`,
// `TenantTx`), its extension the path's; the file read from storage, checked to lie under the tenant's `assets/` and
// against `content_hash` (a mismatch is `500` and an error line, never the bytes). Anything unknown is
// `404 NOT_FOUND`. The controller sets the headers. Log lines carry ids and reasons, never a file name or bytes.
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { StorageAdapter } from "@velexis/db/storage";
import { AppError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { DOCUMENT_STORAGE } from "../documents/documents.processor";
import { PlatformCache } from "../tenancy/platform-cache";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx } from "../tenancy/tenant-tx";
import { StorefrontRepository } from "./storefront.repository";

/** The tenant statuses whose images are served: a suspended storefront still shows its logo. */
const SERVED_STATUSES: ReadonlySet<string> = new Set(["active", "suspended"]);

/** A file's bytes and the type they carry, for getPublicAsset. */
export interface PublicAssetFile {
  readonly bytes: Buffer;
  readonly contentType: string;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

@Injectable()
export class PublicAssetsService {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly repository: StorefrontRepository,
    private readonly cache: PlatformCache,
    @Inject(DOCUMENT_STORAGE) private readonly storage: StorageAdapter,
    @InjectPinoLogger(PublicAssetsService.name) private readonly logger: PinoLogger,
  ) {}

  /** The file of the public URL `/v1/assets/<tenantKey>/<assetId>.<ext>` (see the file header). */
  async publicFile(tenantKey: string, assetId: string, extension: string): Promise<PublicAssetFile> {
    const platform = await this.cache.tenantByKey(tenantKey);
    if (platform === null || !SERVED_STATUSES.has(platform.status)) {
      this.logger.info(
        { assetId, reason: platform === null ? "tenant_unknown" : "tenant_not_served" },
        "assets.public_refused",
      );
      throw new AppError("NOT_FOUND");
    }
    const tenant: RequestTenant = {
      tenantId: platform.id,
      key: platform.key,
      schemaName: platform.schemaName,
      environment: platform.storefrontEnvironment,
      caller: { type: "anonymous", id: "anonymous" },
      actor: { type: "guest", id: null },
      requestId: this.tenants.requestId() ?? "",
    };
    const row = await this.tenants.run(tenant, () =>
      this.tx.run((trx) => this.repository.assetById(trx, assetId)),
    );
    if (row === undefined || row.fileExtension !== extension) {
      this.logger.info({ assetId, reason: "no_asset" }, "assets.public_refused");
      throw new AppError("NOT_FOUND");
    }
    if (!row.storageKey.startsWith(`${platform.schemaName}/assets/`)) {
      this.logger.error({ assetId, tenantId: platform.id }, "assets.foreign_storage_key");
      throw new AppError("NOT_FOUND");
    }
    const bytes = await this.storage.get(row.storageKey);
    if (bytes === null) {
      this.logger.warn({ assetId, tenantId: platform.id }, "assets.file_missing");
      throw new AppError("NOT_FOUND");
    }
    if (sha256(bytes) !== row.contentHash) {
      this.logger.error({ assetId, tenantId: platform.id }, "assets.file_corrupt");
      throw new AppError("INTERNAL_ERROR");
    }
    return { bytes, contentType: row.contentType };
  }
}
