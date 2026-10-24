// The booking documents attached to the booking e-mails (OBE-055; OADR-0013 item 8,
// ota/docs/flows/ticketing-and-documents.md §3 step 7). It runs in the worker only, for the notifications processor
// (notifications.processor.ts), and only reads what the documents module wrote (`booking_documents`,
// `booking_tickets`, documents/documents.processor.ts) and the files it stored.
//
//   booking.confirmed  the booking's itinerary: its newest `ready` row;
//   booking.ticketed   the e-ticket receipts: the newest `ready` receipt of every e-ticket of the booking
//                      (`booking_tickets.document_type = ETICKET`), in ticket number order;
//   booking.updated    the booking's itinerary, as booking.confirmed (OADR-0013 item 4 as revised on 2026-10-23: a
//                      contacts change, a staff patch with `notifyCustomer`), except the short notice of the same key to
//                      the previous contact address (`update.contactNotice` true in its payload, CONTACT_NOTICE_VARIABLE),
//                      which attaches nothing: it has no plan and is sent at once, without attachments.
//
// When the e-mail is claimed, `plan` decides in the claim's transaction (the documents are rendered after the commit
// that queued the e-mail, in the `ota-documents` queue, so the first claim usually finds them missing):
//   attach  every document is `ready`: the e-mail is sent with them (`documents.attached` is true);
//   wait    some are not ready and they were asked for less than ATTACHMENT_WAIT_MS (2 minutes) ago: the row is
//           released without an attempt and claimed again ATTACHMENT_RECHECK_MS later (the processor adds a delayed
//           `notify` for it), or at the end of the wait;
//   link    some are still not ready after the wait, none was ever asked for, or the e-mail names no booking: it is
//           sent without attachments (`documents.attached` is false), and the template points to the booking page
//           instead, where the documents can be downloaded once they are ready.
// The wait runs from when the documents were asked for: the newest booking event that asks for them
// (DOCUMENT_TRIGGERS of documents.processor.ts: every trigger renders an itinerary, those with `receipts` the e-ticket
// receipts). The record step and the ticketing job write that event in the transaction that queues the e-mail, so they
// wait the full 2 minutes; an e-mail queued later for a booking whose itinerary failed long ago (the `booking.updated`
// of a contacts change, OBE-048, or of a staff patch, OBE-062) goes with the link at once instead of waiting for nothing.
// All or nothing: a receipt that failed for one ticket sends the e-mail with the link, never with part of the receipts.
//
// `load` reads the files of an `attach` plan from storage just before the e-mail is sent, outside any transaction:
// only keys under this tenant's `tenant_<key>/documents/` prefix, each checked against its SHA-256
// (`booking_documents.content_hash`), at most MAX_ATTACHMENT_BYTES in all. A file that is missing, changed or too big
// makes the e-mail wait again (inside the wait) or go with the link (after it), and is logged with ids only. The bytes
// exist in the worker's memory only while the e-mail is sent; they are never logged, queued or stored again.
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { StorageAdapter } from "@velexis/db/storage";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { DOCUMENT_TRIGGERS } from "../documents/documents.processor";
import { TenantContext } from "../tenancy/tenant-context";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import type { EmailAttachment } from "./mailer.gateway";
import type { NotificationRow } from "./outbox.repository";
import { isTemplateKey, type TemplateKey } from "./templates/registry";

/** How long an e-mail waits for its documents after they were asked for (OADR-0013 item 8). */
export const ATTACHMENT_WAIT_MS = 2 * 60_000;

/** How soon a waiting e-mail is claimed again. */
export const ATTACHMENT_RECHECK_MS = 5_000;

/** The most bytes the attachments of one e-mail may have in all; more goes with the link. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Injection token of the worker's StorageAdapter for the attachments (notifications.module.ts). */
export const ATTACHMENT_STORAGE = "NOTIFICATION_ATTACHMENT_STORAGE";

/** What a key attaches. */
export type AttachedDocuments = "itinerary" | "e_ticket_receipts";

/** The keys that attach booking documents, and which (see the file header). */
export const ATTACHMENT_RULES: Readonly<Partial<Record<TemplateKey, AttachedDocuments>>> = Object.freeze({
  "booking.confirmed": "itinerary",
  "booking.ticketed": "e_ticket_receipts",
  "booking.updated": "itinerary",
});

/** The ticket type that gets a receipt (`booking_tickets.document_type`), as the documents module renders them. */
const E_TICKET = "ETICKET";

/** A `ready` booking document that an e-mail attaches. */
export interface AttachmentDocument {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly storageKey: string;
  /** SHA-256 of the file, 64 lower-case hex characters. */
  readonly contentHash: string;
}

/** What the sender does with an e-mail of a key that attaches documents (see the file header). */
export type AttachmentPlan =
  | {
      readonly kind: "attach";
      readonly documents: readonly AttachmentDocument[];
      /** When they were asked for (the wait of a file that turns out unusable); `undefined` when never. */
      readonly askedAt: Date | undefined;
    }
  | { readonly kind: "wait"; readonly until: Date }
  | { readonly kind: "link" };

/** The ready documents of one booking, as `plan` reads them. */
export interface BookingDocumentsState {
  /** The newest ready itinerary, or `undefined`. */
  readonly itinerary: AttachmentDocument | undefined;
  /** The booking's e-tickets (`booking_tickets.id`), in number order. */
  readonly eTicketIds: readonly string[];
  /** The newest ready receipt of each e-ticket that has one, by `booking_tickets.id`. */
  readonly receipts: ReadonlyMap<string, AttachmentDocument>;
  /** The newest booking event that asked for an itinerary; `undefined` when none did. */
  readonly itineraryAskedAt: Date | undefined;
  /** The newest booking event that asked for the e-ticket receipts; `undefined` when none did. */
  readonly receiptsAskedAt: Date | undefined;
}

/** The documents `rule` asks for, when every one is ready; `undefined` otherwise. */
export function readyDocuments(
  rule: AttachedDocuments,
  state: BookingDocumentsState | undefined,
): readonly AttachmentDocument[] | undefined {
  if (state === undefined) {
    return undefined;
  }
  if (rule === "itinerary") {
    return state.itinerary === undefined ? undefined : [state.itinerary];
  }
  if (state.eTicketIds.length === 0) {
    return undefined;
  }
  const receipts: AttachmentDocument[] = [];
  for (const ticketId of state.eTicketIds) {
    const receipt = state.receipts.get(ticketId);
    if (receipt === undefined) {
      return undefined;
    }
    receipts.push(receipt);
  }
  return receipts;
}

/**
 * When an e-mail whose documents were asked for at `askedAt` is claimed again while they are not ready at `now`;
 * `undefined` when the wait is over or they were never asked for (the e-mail goes with the link).
 */
export function waitUntil(askedAt: Date | undefined, now: Date): Date | undefined {
  if (askedAt === undefined) {
    return undefined;
  }
  const end = askedAt.getTime() + ATTACHMENT_WAIT_MS;
  if (now.getTime() >= end) {
    return undefined;
  }
  return new Date(Math.min(end, now.getTime() + ATTACHMENT_RECHECK_MS));
}

/** The plan of one e-mail of a key that attaches `rule` (see the file header). */
export function planAttachments(
  rule: AttachedDocuments,
  input: {
    readonly now: Date;
    /** The booking's documents; `undefined` for an e-mail without a booking. */
    readonly state: BookingDocumentsState | undefined;
  },
): AttachmentPlan {
  if (input.state === undefined) {
    return { kind: "link" };
  }
  const askedAt = rule === "itinerary" ? input.state.itineraryAskedAt : input.state.receiptsAskedAt;
  const documents = readyDocuments(rule, input.state);
  if (documents !== undefined) {
    return { kind: "attach", documents, askedAt };
  }
  const until = waitUntil(askedAt, input.now);
  return until === undefined ? { kind: "link" } : { kind: "wait", until };
}

/** The booking events that ask for an itinerary, and those that ask for the e-ticket receipts (DOCUMENT_TRIGGERS). */
const ITINERARY_TRIGGERS: readonly string[] = Object.freeze(Object.keys(DOCUMENT_TRIGGERS));
const RECEIPT_TRIGGERS: readonly string[] = Object.freeze(
  Object.entries(DOCUMENT_TRIGGERS)
    .filter(([, trigger]) => trigger.receipts)
    .map(([type]) => type),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * True when a row's payload is the short notice of `booking.updated` to a previous contact address: its
 * `update.contactNotice` (CONTACT_NOTICE_VARIABLE) is true.
 */
export function isContactNotice(payload: unknown): boolean {
  const update = isRecord(payload) ? payload["update"] : undefined;
  return isRecord(update) && update["contactNotice"] === true;
}

/**
 * The rule of a row: its key's, or `undefined` for a key that attaches nothing and for the short notice of
 * `booking.updated` to a previous contact address (`payload`, see the file header).
 */
export function attachmentRuleOf(templateKey: string, payload?: unknown): AttachedDocuments | undefined {
  if (!isTemplateKey(templateKey) || (templateKey === "booking.updated" && isContactNotice(payload))) {
    return undefined;
  }
  return ATTACHMENT_RULES[templateKey];
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** An error's name for a log line (`Error` for anything that is not an Error with a plain name). */
function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : "Error";
}

/** Plans and loads the attachments of the booking e-mails (see the file header). Worker only. */
@Injectable()
export class NotificationAttachments {
  constructor(
    @Inject(ATTACHMENT_STORAGE) private readonly storage: StorageAdapter,
    private readonly tenants: TenantContext,
    @InjectPinoLogger(NotificationAttachments.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * In `trx`, the claim's transaction of the tenant of the current context: the plan of each claimed row whose key
   * attaches documents, by row id, with its booking's documents as `now` finds them. Rows of other keys, and the notice
   * of `booking.updated` to a previous contact address, have none.
   */
  async plan(
    trx: TenantTransaction,
    rows: readonly Pick<NotificationRow, "id" | "template_key" | "booking_id" | "payload">[],
    now: Date,
  ): Promise<ReadonlyMap<string, AttachmentPlan>> {
    const attaching = rows.filter((row) => attachmentRuleOf(row.template_key, row.payload) !== undefined);
    const plans = new Map<string, AttachmentPlan>();
    if (attaching.length === 0) {
      return plans;
    }
    const states = await this.documentsOf(
      trx,
      attaching.flatMap((row) => (row.booking_id === null ? [] : [row.booking_id])),
    );
    for (const row of attaching) {
      const rule = attachmentRuleOf(row.template_key, row.payload);
      if (rule === undefined) {
        continue;
      }
      plans.set(
        row.id,
        planAttachments(rule, {
          now,
          state: row.booking_id === null ? undefined : states.get(row.booking_id),
        }),
      );
    }
    return plans;
  }

  /**
   * The files of an `attach` plan, read from storage and checked (see the file header), or `undefined` when one of
   * them cannot be attached.
   */
  async load(
    notificationId: string,
    documents: readonly AttachmentDocument[],
  ): Promise<readonly EmailAttachment[] | undefined> {
    const prefix = `${this.tenants.require().schemaName}/documents/`;
    const files: EmailAttachment[] = [];
    let total = 0;
    for (const document of documents) {
      const unusable = (reason: string): undefined => {
        this.logger.warn(
          { notificationId, documentId: document.id, reason },
          "notifications.attachment_unusable",
        );
        return undefined;
      };
      if (!document.storageKey.startsWith(prefix)) {
        return unusable("foreign_key");
      }
      let bytes: Buffer | null;
      try {
        bytes = await this.storage.get(document.storageKey);
      } catch (error) {
        return unusable(`unreadable:${errorName(error)}`);
      }
      if (bytes === null) {
        return unusable("missing");
      }
      if (sha256(bytes) !== document.contentHash) {
        return unusable("content");
      }
      total += bytes.length;
      if (total > MAX_ATTACHMENT_BYTES) {
        return unusable("too_big");
      }
      files.push({ fileName: document.fileName, contentType: document.contentType, content: bytes });
    }
    return files;
  }

  /** The ready documents of `bookingIds` and when they were asked for (see BookingDocumentsState), by booking id. */
  private async documentsOf(
    trx: TenantTransaction,
    bookingIds: readonly string[],
  ): Promise<ReadonlyMap<string, BookingDocumentsState>> {
    const ids = [...new Set(bookingIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const tickets = await trx
      .selectFrom("booking_tickets")
      .select(["id", "booking_id as bookingId"])
      .where("booking_id", "in", ids)
      .where("document_type", "=", E_TICKET)
      .orderBy("booking_id")
      .orderBy("document_number")
      .orderBy("id")
      .execute();
    const documents = await trx
      .selectFrom("booking_documents")
      .select([
        "id",
        "booking_id as bookingId",
        "booking_ticket_id as ticketId",
        "kind",
        "file_name as fileName",
        "content_type as contentType",
        "storage_key as storageKey",
        "content_hash as contentHash",
      ])
      .where("booking_id", "in", ids)
      .where("status", "=", "ready")
      .where("kind", "in", ["itinerary", "e_ticket_receipt"])
      // The newest first: the first row of a document is the one attached.
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    const asked = await trx
      .selectFrom("booking_events")
      .select((eb) => ["booking_id as bookingId", "type", eb.fn.max("created_at").as("askedAt")])
      .where("booking_id", "in", ids)
      .where("type", "in", [...ITINERARY_TRIGGERS])
      .groupBy(["booking_id", "type"])
      .execute();
    const states = new Map<
      string,
      {
        itinerary: AttachmentDocument | undefined;
        eTicketIds: string[];
        receipts: Map<string, AttachmentDocument>;
        itineraryAskedAt: Date | undefined;
        receiptsAskedAt: Date | undefined;
      }
    >(
      ids.map((id) => [
        id,
        {
          itinerary: undefined,
          eTicketIds: [],
          receipts: new Map(),
          itineraryAskedAt: undefined,
          receiptsAskedAt: undefined,
        },
      ]),
    );
    const later = (current: Date | undefined, next: Date): Date =>
      current === undefined || next.getTime() > current.getTime() ? next : current;
    for (const event of asked) {
      const state = states.get(event.bookingId);
      if (state === undefined) {
        continue;
      }
      const askedAt = new Date(event.askedAt);
      state.itineraryAskedAt = later(state.itineraryAskedAt, askedAt);
      if (RECEIPT_TRIGGERS.includes(event.type)) {
        state.receiptsAskedAt = later(state.receiptsAskedAt, askedAt);
      }
    }
    for (const ticket of tickets) {
      states.get(ticket.bookingId)?.eTicketIds.push(ticket.id);
    }
    for (const row of documents) {
      const state = states.get(row.bookingId);
      if (state === undefined) {
        continue;
      }
      const document: AttachmentDocument = {
        id: row.id,
        fileName: row.fileName,
        contentType: row.contentType,
        storageKey: row.storageKey,
        contentHash: row.contentHash,
      };
      if (row.kind === "itinerary") {
        state.itinerary ??= document;
      } else if (row.ticketId !== null && !state.receipts.has(row.ticketId)) {
        state.receipts.set(row.ticketId, document);
      }
    }
    return states;
  }
}
