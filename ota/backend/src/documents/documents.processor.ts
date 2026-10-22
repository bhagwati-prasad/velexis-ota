// The booking documents' queue (OBE-053; OADR-0013 items 6 and 7, ADR-0017, ota/docs/flows/ticketing-and-documents.md
// §3 step 7 and §4, ota/docs/architecture.md §6): what asks for a document, the job that renders it, and its consumer.
//
// Requests (both processes, `DocumentRequests`). The booking events are the triggers: OrderRecorder.event (the bookings
// module's one way to write a booking event) calls `afterBookingEvent` in the transaction that writes the event,
//   booking.created    the order was recorded: the itinerary, and a receipt per e-ticket when the order came back issued;
//   booking.ticketed   tickets were stored: a receipt per e-ticket and a new itinerary (the previous one superseded);
//   booking.cancelled  a new itinerary, marked cancelled;
// and after that transaction's commit (`afterCommit` of TenantTx; a rollback drops them) the jobs go to `ota-documents`:
// `document.render {tenantId, bookingId, kind, bookingVersion[, ticketId]}`, the booking's version as the transaction
// left it. The job key `document.render:<bookingId>:<kind>:<bookingVersion>[:<ticketId>]` is the job's BullMQ
// deduplication id (BullMQ refuses custom job ids with more than two colons) for DEDUPLICATION_TTL_MS, so a second job
// for the same key is not added; one added later is a no-op of the render below. The enqueue never fails the caller: it
// gives up after ENQUEUE_TIMEOUT_MS (Redis down), logged, and the booking keeps its earlier documents.
//
// Rendering (worker, `DocumentRenderService`), outside any transaction except the short ones named:
//   1. read (T1) the booking, its travellers (type and last 4 of the document only), segments and tickets, the brand
//      and the square logo's asset row (documents.repository.ts); skip a booking that is gone or has no flights yet,
//      and a receipt of a ticket that is not one of its e-tickets;
//   2. read the logo's bytes from storage (`tenant_<key>/assets/…` of this tenant only, its SHA-256 checked; PNG and
//      JPEG only, the formats a PDF embeds; otherwise, or when the image cannot be embedded, the document is rendered
//      without it) and render the PDF (renderers/); compute its SHA-256;
//   3. when the newest ready version of the document has this SHA-256, nothing is stored: the render is a no-op
//      (`unchanged`); otherwise the file is stored at `tenant_<key>/documents/<bookingId>/<documentId>.pdf`;
//   4. write (T2): lock the booking `FOR UPDATE` (the one lock taken; the row insert's foreign-key lock is the
//      booking's and the ticket's, OADR-0003 point 11) and check its version against T1's: a booking that changed
//      meanwhile is read and rendered again (at most RENDER_ROUNDS times), so an older render never replaces a newer
//      one; then insert the `ready` row and supersede the document's other rows, or, when the newest ready one has the
//      same SHA-256 by now, insert nothing (the file stored in step 3 is deleted).
// The same booking data always gives the same bytes (renderers/itinerary.renderer.ts), so rendering a booking version
// twice gives one row and one hash. A failure (the renderer, storage, the database) writes or keeps one `failed` row of
// the document, which supersedes nothing, and fails the job: BullMQ retries it (5 attempts, exponential backoff from
// 30 s, ADR-0009), and the next ready version supersedes the failed row.
//
// The consumer (`DocumentsProcessor`, concurrency 2, architecture §6) checks the payload (a job that is not one fails at
// once, UnrecoverableError) and resolves the tenant through the platform cache: `active` and `suspended` tenants get
// their documents (a suspended OTA's travellers keep theirs, OADR-0014 point 4), any other tenant is skipped. Log lines
// carry ids, the kind, sizes and error names, never booking data.
import { createHash } from "node:crypto";
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { StorageAdapter } from "@velexis/db/storage";
import { UnrecoverableError, type Job, type JobsOptions, type Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { OTA_QUEUE, otaWorkerOptions } from "../common/queues/queue-names";
import { jobTenant } from "../jobs/fan-out";
import { PlatformCache } from "../tenancy/platform-cache";
import type { PlatformTenant, TenantStatus } from "../tenancy/platform-read.types";
import { TenantContext } from "../tenancy/tenant-context";
import { afterCommit, TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  DOCUMENT_KINDS,
  DocumentsRepository,
  FAILED_CONTENT_HASH,
  type DocumentKind,
  type DocumentSlot,
  type LogoAssetRow,
  type RenderSource,
} from "./documents.repository";
import {
  E_TICKET_TYPE,
  eTicketReceiptFileName,
  renderETicketReceipt,
} from "./renderers/e-ticket-receipt.renderer";
import {
  DOCUMENT_LOCALE,
  itineraryFileName,
  PDF_CONTENT_TYPE,
  renderItinerary,
  type DocumentData,
  type DocumentLogo,
} from "./renderers/itinerary.renderer";

/** The job of `ota-documents` (architecture §6). */
export const DOCUMENT_RENDER_JOB = "document.render";

/** Injection token of the worker's StorageAdapter (documents.module.ts). */
export const DOCUMENT_STORAGE = "DOCUMENT_STORAGE";

/** How long BullMQ refuses a second job of the same key: the day completed jobs are kept (ADR-0009). */
export const DEDUPLICATION_TTL_MS = 24 * 60 * 60_000;

/** How long the enqueue after the commit may take before it gives up (as the outbox's, OBE-030). */
export const ENQUEUE_TIMEOUT_MS = 2000;

/** How often a render reads the booking again when it changed while the document was rendered. */
export const RENDER_ROUNDS = 3;

/** The tenant statuses whose documents are rendered (OADR-0014 point 4). */
export const DOCUMENT_TENANT_STATUSES: readonly TenantStatus[] = Object.freeze(["active", "suspended"]);

/** The booking statuses whose documents are rendered: a booking with an order. */
const DOCUMENTED_STATUSES: readonly string[] = Object.freeze([
  "confirmed",
  "ticketed",
  "partially_ticketed",
  "cancelled",
]);

const TENANT_ID = /^ten_[0-9A-Za-z]{1,60}$/;
const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;
const TICKET_ID = /^tkt_[0-9A-Za-z]{16,40}$/;

/** The payload of `document.render` (ADR-0009: ids and the version, nothing else). */
export interface DocumentRenderJobData {
  readonly tenantId: string;
  readonly bookingId: string;
  readonly kind: DocumentKind;
  /** The booking's `version` when the job was asked for. */
  readonly bookingVersion: number;
  /** `booking_tickets.id`: only, and always, for an `e_ticket_receipt`. */
  readonly ticketId?: string;
}

/** The job key: `document.render:<bookingId>:<kind>:<bookingVersion>[:<ticketId>]`. */
export function documentRenderKey(data: Omit<DocumentRenderJobData, "tenantId">): string {
  const key = `${DOCUMENT_RENDER_JOB}:${data.bookingId}:${data.kind}:${data.bookingVersion}`;
  return data.ticketId === undefined ? key : `${key}:${data.ticketId}`;
}

/** The `document.render` job of `data`, as `Queue.add`/`addBulk` take it: the key as its deduplication id. */
export function documentRenderJob(data: DocumentRenderJobData): {
  readonly name: string;
  readonly data: DocumentRenderJobData;
  readonly opts: JobsOptions;
} {
  return {
    name: DOCUMENT_RENDER_JOB,
    data,
    opts: { deduplication: { id: documentRenderKey(data), ttl: DEDUPLICATION_TTL_MS } },
  };
}

/** The payload of a `document.render` job, or `undefined` when it is not one (extra fields included). */
export function parseDocumentRenderJobData(data: unknown): DocumentRenderJobData | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const { tenantId, bookingId, kind, bookingVersion, ticketId, ...rest } = data as Record<string, unknown>;
  if (
    Object.keys(rest).length > 0 ||
    typeof tenantId !== "string" ||
    !TENANT_ID.test(tenantId) ||
    typeof bookingId !== "string" ||
    !BOOKING_ID.test(bookingId) ||
    typeof kind !== "string" ||
    !(DOCUMENT_KINDS as readonly string[]).includes(kind) ||
    typeof bookingVersion !== "number" ||
    !Number.isSafeInteger(bookingVersion) ||
    bookingVersion < 1
  ) {
    return undefined;
  }
  const receipt = kind === "e_ticket_receipt";
  if (receipt !== (ticketId !== undefined)) {
    return undefined;
  }
  if (ticketId !== undefined && (typeof ticketId !== "string" || !TICKET_ID.test(ticketId))) {
    return undefined;
  }
  return {
    tenantId,
    bookingId,
    kind: kind as DocumentKind,
    bookingVersion,
    ...(ticketId === undefined ? {} : { ticketId }),
  };
}

/** Which documents a booking event asks for (see the file header). */
export const DOCUMENT_TRIGGERS: Readonly<Record<string, { readonly receipts: boolean }>> = Object.freeze({
  "booking.created": { receipts: true },
  "booking.ticketed": { receipts: true },
  "booking.cancelled": { receipts: false },
});

/** The jobs a transaction asked for, by job key, until its commit. */
const REQUESTED = new WeakMap<object, Map<string, DocumentRenderJobData>>();

/** Asks for the documents of booking events (see the file header). Both processes. */
@Injectable()
export class DocumentRequests {
  constructor(
    private readonly repository: DocumentsRepository,
    private readonly tenants: TenantContext,
    @InjectQueue(OTA_QUEUE.documents) private readonly queue: Queue,
    @InjectPinoLogger(DocumentRequests.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * In `trx`, an open transaction of `TenantTx.run` for the current tenant that wrote the booking event `eventType`:
   * the documents it asks for, enqueued after the commit. Events that ask for none are ignored.
   */
  async afterBookingEvent(trx: TenantTransaction, bookingId: string, eventType: string): Promise<void> {
    const trigger = DOCUMENT_TRIGGERS[eventType];
    if (trigger === undefined) {
      return;
    }
    const tenant = this.tenants.require();
    const targets = await this.repository.renderTargets(trx, bookingId);
    if (targets === undefined) {
      return;
    }
    const common = { tenantId: tenant.tenantId, bookingId, bookingVersion: targets.version };
    const wanted: DocumentRenderJobData[] = [
      { ...common, kind: "itinerary" },
      ...(trigger.receipts
        ? targets.eTicketIds.map((ticketId): DocumentRenderJobData => ({
            ...common,
            kind: "e_ticket_receipt",
            ticketId,
          }))
        : []),
    ];
    let requested = REQUESTED.get(trx);
    if (requested === undefined) {
      const jobs = new Map<string, DocumentRenderJobData>();
      afterCommit(trx, async () => {
        await this.enqueue(tenant.tenantId, [...jobs.values()]);
      });
      REQUESTED.set(trx, jobs);
      requested = jobs;
    }
    for (const job of wanted) {
      requested.set(documentRenderKey(job), job);
    }
  }

  /** Adds the jobs to `ota-documents`. Never throws: a failure or a timeout is logged. */
  async enqueue(tenantId: string, jobs: readonly DocumentRenderJobData[]): Promise<boolean> {
    if (jobs.length === 0) {
      return true;
    }
    let timer: NodeJS.Timeout | undefined;
    const added = this.queue.addBulk(jobs.map((job) => documentRenderJob(job))).then(
      () => true,
      (error: unknown) => {
        this.logger.warn({ tenantId, jobs: jobs.length, err: error }, "documents.enqueue_failed");
        return false;
      },
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), ENQUEUE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([added, timedOut]);
      if (result === "timeout") {
        this.logger.warn(
          { tenantId, jobs: jobs.length, timeoutMs: ENQUEUE_TIMEOUT_MS },
          "documents.enqueue_timeout",
        );
        return false;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Why a render did nothing. */
export type DocumentRenderSkip = "booking_not_found" | "booking_not_documented" | "ticket_not_found";

/** What one render did (kept with the BullMQ job): ids, sizes and counts, never booking data. */
export type DocumentRenderOutcome =
  | {
      readonly outcome: "rendered";
      readonly documentId: string;
      readonly sizeBytes: number;
      readonly contentHash: string;
      readonly superseded: number;
    }
  | {
      readonly outcome: "unchanged";
      readonly documentId: string;
      readonly contentHash: string;
      readonly superseded: number;
    }
  | { readonly outcome: "skipped"; readonly reason: DocumentRenderSkip };

/** The booking changed in every round of a render: the job is retried later. */
export class DocumentRenderConflictError extends Error {
  override readonly name = "DocumentRenderConflictError";

  constructor() {
    super(`The booking changed in each of ${RENDER_ROUNDS} rounds of the render`);
  }
}

/** A rendered document, before it is stored. */
interface RenderedDocument {
  readonly bytes: Buffer;
  readonly contentHash: string;
  readonly fileName: string;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** An error's name for a log line or a result (`Error` for anything that is not an Error with a plain name). */
function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : "Error";
}

/** The magic bytes of the image formats a PDF embeds. */
function looksLike(contentType: DocumentLogo["contentType"], bytes: Buffer): boolean {
  return contentType === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Renders and stores the documents of the tenant of the current context (see the file header). Worker only. */
@Injectable()
export class DocumentRenderService {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly repository: DocumentsRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(DOCUMENT_STORAGE) private readonly storage: StorageAdapter,
    @InjectPinoLogger(DocumentRenderService.name) private readonly logger: PinoLogger,
  ) {}

  /** Renders the document a job asks for, for `tenant` (the tenant of the current context). */
  async render(
    tenant: Pick<PlatformTenant, "name">,
    job: DocumentRenderJobData,
  ): Promise<DocumentRenderOutcome> {
    const slot: DocumentSlot = {
      bookingId: job.bookingId,
      kind: job.kind,
      ticketId: job.ticketId ?? null,
    };
    try {
      for (let round = 1; round <= RENDER_ROUNDS; round += 1) {
        const outcome = await this.round(tenant, slot);
        if (outcome !== "changed") {
          return outcome;
        }
        this.logger.debug({ bookingId: slot.bookingId, kind: slot.kind, round }, "documents.booking_changed");
      }
      throw new DocumentRenderConflictError();
    } catch (error) {
      if (!(error instanceof DocumentRenderConflictError)) {
        await this.recordFailure(slot);
      }
      this.logger.error(
        { bookingId: slot.bookingId, kind: slot.kind, ticketId: slot.ticketId, code: errorName(error) },
        "documents.render_failed",
      );
      throw error;
    }
  }

  /** One read, render, store and write; `changed` when the booking changed after the read. */
  private async round(
    tenant: Pick<PlatformTenant, "name">,
    slot: DocumentSlot,
  ): Promise<DocumentRenderOutcome | "changed"> {
    const source = await this.tx.run((trx) => this.repository.renderSource(trx, slot.bookingId));
    if (source === undefined) {
      return { outcome: "skipped", reason: "booking_not_found" };
    }
    if (!DOCUMENTED_STATUSES.includes(source.booking.status) || source.segments.length === 0) {
      return { outcome: "skipped", reason: "booking_not_documented" };
    }
    if (
      slot.ticketId !== null &&
      !source.tickets.some((ticket) => ticket.id === slot.ticketId && ticket.documentType === E_TICKET_TYPE)
    ) {
      return { outcome: "skipped", reason: "ticket_not_found" };
    }
    const document = await this.renderDocument(tenant, slot, source);
    const latestReady = (await this.tx.run((trx) => this.repository.currentDocuments(trx, slot))).find(
      (row) => row.status === "ready",
    );
    if (latestReady?.contentHash === document.contentHash) {
      // The same bytes are stored already: only resolve a failed row the earlier attempts left.
      return await this.write(slot, source.version, document, undefined);
    }
    const documentId = this.ids.newId("doc");
    const storageKey = `${this.tenants.require().schemaName}/documents/${slot.bookingId}/${documentId}.pdf`;
    await this.storage.put(storageKey, document.bytes, PDF_CONTENT_TYPE);
    let kept = false;
    try {
      const outcome = await this.write(slot, source.version, document, { documentId, storageKey });
      kept = outcome !== "changed" && outcome.outcome === "rendered";
      return outcome;
    } finally {
      if (!kept) {
        await this.storage.delete(storageKey).catch((error: unknown) => {
          this.logger.warn(
            { bookingId: slot.bookingId, code: errorName(error) },
            "documents.orphan_not_deleted",
          );
        });
      }
    }
  }

  /**
   * T2 (see the file header): the booking locked and its version checked; then the new row and the superseded ones,
   * or, without a stored file (or when the newest ready row has the same hash by now), the failed rows resolved.
   */
  private async write(
    slot: DocumentSlot,
    version: number,
    document: RenderedDocument,
    stored: { readonly documentId: string; readonly storageKey: string } | undefined,
  ): Promise<DocumentRenderOutcome | "changed"> {
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const current = await this.repository.lockBooking(trx, slot.bookingId);
      if (current === undefined) {
        return { outcome: "skipped", reason: "booking_not_found" } as const;
      }
      if (current.version !== version) {
        return "changed" as const;
      }
      const rows = await this.repository.currentDocuments(trx, slot);
      const latestReady = rows.find((row) => row.status === "ready");
      if (latestReady !== undefined && latestReady.contentHash === document.contentHash) {
        const superseded = await this.repository.supersede(
          trx,
          rows.filter((row) => row.id !== latestReady.id).map((row) => row.id),
          now,
        );
        this.logger.debug(
          { bookingId: slot.bookingId, kind: slot.kind, documentId: latestReady.id },
          "documents.unchanged",
        );
        return {
          outcome: "unchanged",
          documentId: latestReady.id,
          contentHash: document.contentHash,
          superseded,
        } as const;
      }
      if (stored === undefined) {
        // The newest ready row changed between the check and the lock: the next round stores this render.
        return "changed" as const;
      }
      await this.repository.insert(trx, {
        id: stored.documentId,
        booking_id: slot.bookingId,
        booking_ticket_id: slot.ticketId,
        kind: slot.kind,
        status: "ready",
        locale: DOCUMENT_LOCALE,
        file_name: document.fileName,
        content_type: PDF_CONTENT_TYPE,
        size_bytes: document.bytes.length,
        storage_key: stored.storageKey,
        content_hash: document.contentHash,
        generated_by: "system",
        created_at: now,
        updated_at: now,
      });
      const superseded = await this.repository.supersede(
        trx,
        rows.map((row) => row.id),
        now,
      );
      this.logger.info(
        {
          bookingId: slot.bookingId,
          kind: slot.kind,
          documentId: stored.documentId,
          sizeBytes: document.bytes.length,
          superseded,
        },
        "documents.rendered",
      );
      return {
        outcome: "rendered",
        documentId: stored.documentId,
        sizeBytes: document.bytes.length,
        contentHash: document.contentHash,
        superseded,
      } as const;
    });
  }

  /** The PDF of the slot; without the logo when the image cannot be embedded. */
  private async renderDocument(
    tenant: Pick<PlatformTenant, "name">,
    slot: DocumentSlot,
    source: RenderSource,
  ): Promise<RenderedDocument> {
    const logo = await this.logoOf(slot, source.logo);
    const data: DocumentData = {
      brand: source.brand ?? {
        name: tenant.name,
        legalName: null,
        supportEmail: null,
        supportPhone: null,
        primaryColor: null,
      },
      logo,
      booking: source.booking,
      travelers: source.travelers,
      segments: source.segments,
      tickets: source.tickets,
      airports: source.airports,
      airlines: source.airlines,
    };
    const print = (input: DocumentData): Promise<Buffer> =>
      slot.ticketId === null ? renderItinerary(input) : renderETicketReceipt(input, slot.ticketId);
    let bytes: Buffer;
    try {
      bytes = await print(data);
    } catch (error) {
      if (logo === null) {
        throw error;
      }
      this.logger.warn({ bookingId: slot.bookingId, code: errorName(error) }, "documents.logo_unusable");
      bytes = await print({ ...data, logo: null });
    }
    const ticket = source.tickets.find((candidate) => candidate.id === slot.ticketId);
    return {
      bytes,
      contentHash: sha256(bytes),
      fileName:
        ticket === undefined
          ? itineraryFileName(source.booking)
          : eTicketReceiptFileName(source.booking, ticket),
    };
  }

  /** The square logo's bytes, checked (see the file header), or `null`. */
  private async logoOf(slot: DocumentSlot, asset: LogoAssetRow | null): Promise<DocumentLogo | null> {
    if (asset === null) {
      return null;
    }
    const skip = (reason: string): null => {
      this.logger.warn({ bookingId: slot.bookingId, reason }, "documents.logo_skipped");
      return null;
    };
    const contentType = asset.contentType;
    if (contentType !== "image/png" && contentType !== "image/jpeg") {
      return skip("format");
    }
    if (!asset.storageKey.startsWith(`${this.tenants.require().schemaName}/`)) {
      return skip("foreign_key");
    }
    let bytes: Buffer | null;
    try {
      bytes = await this.storage.get(asset.storageKey);
    } catch (error) {
      return skip(`unreadable:${errorName(error)}`);
    }
    if (bytes === null) {
      return skip("missing");
    }
    if (sha256(bytes) !== asset.contentHash || !looksLike(contentType, bytes)) {
      return skip("content");
    }
    return { contentType, bytes };
  }

  /**
   * Records a failed render (see the file header): one `failed` row per document, kept while the job retries. Best
   * effort: a failure here (the database is what failed, say) is logged, and the job's own error is what BullMQ sees.
   */
  private async recordFailure(slot: DocumentSlot): Promise<void> {
    try {
      await this.tx.run(async (trx) => {
        const now = this.clock.now();
        const booking = await this.repository.lockBooking(trx, slot.bookingId);
        if (booking === undefined) {
          return;
        }
        const rows = await this.repository.currentDocuments(trx, slot);
        const failed = rows.find((row) => row.status === "failed");
        if (failed !== undefined) {
          await this.repository.touch(trx, failed.id, now);
          return;
        }
        const ticketNumber =
          slot.ticketId === null
            ? undefined
            : await this.repository.ticketNumber(trx, slot.bookingId, slot.ticketId);
        const documentId = this.ids.newId("doc");
        await this.repository.insert(trx, {
          id: documentId,
          booking_id: slot.bookingId,
          booking_ticket_id: slot.ticketId,
          kind: slot.kind,
          status: "failed",
          locale: DOCUMENT_LOCALE,
          file_name:
            ticketNumber === undefined
              ? itineraryFileName(booking)
              : eTicketReceiptFileName(booking, { documentNumber: ticketNumber }),
          content_type: PDF_CONTENT_TYPE,
          size_bytes: null,
          storage_key: `${this.tenants.require().schemaName}/documents/${slot.bookingId}/${documentId}.pdf`,
          content_hash: FAILED_CONTENT_HASH,
          generated_by: "system",
          created_at: now,
          updated_at: now,
        });
      });
    } catch (error) {
      this.logger.error(
        { bookingId: slot.bookingId, code: errorName(error) },
        "documents.failure_not_recorded",
      );
    }
  }
}

/** What a finished `document.render` job returns (BullMQ keeps it with the job). */
export type DocumentRenderJobResult =
  | ({
      readonly tenantId: string;
      readonly bookingId: string;
      readonly kind: DocumentKind;
    } & DocumentRenderOutcome)
  | {
      readonly tenantId: string;
      readonly bookingId: string;
      readonly kind: DocumentKind;
      readonly outcome: "tenant_skipped";
      readonly reason: string;
    };

/** The consumer of `ota-documents` (see the file header). */
@Processor(OTA_QUEUE.documents, otaWorkerOptions(OTA_QUEUE.documents))
export class DocumentsProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly renderer: DocumentRenderService,
    private readonly cache: PlatformCache,
    private readonly tenants: TenantContext,
    @InjectPinoLogger(DocumentsProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<DocumentRenderJobResult> {
    const data = job.name === DOCUMENT_RENDER_JOB ? parseDocumentRenderJobData(job.data) : undefined;
    if (data === undefined) {
      this.logger.error(
        { queue: job.queueName, jobId: job.id, jobName: String(job.name).slice(0, 64) },
        "documents.job_invalid",
      );
      throw new UnrecoverableError(
        "the job is not document.render {tenantId, bookingId, kind, bookingVersion}",
      );
    }
    const ids = { tenantId: data.tenantId, bookingId: data.bookingId, kind: data.kind };
    const tenant = await this.cache.tenantById(data.tenantId);
    if (tenant === null || !DOCUMENT_TENANT_STATUSES.includes(tenant.status)) {
      const reason = tenant === null ? "tenant_not_found" : `tenant_${tenant.status}`;
      this.logger.debug({ tenantId: data.tenantId, reason }, "documents.tenant_skipped");
      return { ...ids, outcome: "tenant_skipped", reason };
    }
    const outcome = await this.tenants.run(jobTenant(tenant, job), () => this.renderer.render(tenant, data));
    return { ...ids, ...outcome };
  }

  /** A job failed: logged with its id and attempt and the error's name, never the error (it may quote SQL). */
  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(
      { queue: OTA_QUEUE.documents, jobId: job?.id, attempt: job?.attemptsMade, code: errorName(error) },
      "documents.job_failed",
    );
  }

  /** Errors of the worker itself (its Redis connections); job failures are the `failed` events above. */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: OTA_QUEUE.documents, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }
}
