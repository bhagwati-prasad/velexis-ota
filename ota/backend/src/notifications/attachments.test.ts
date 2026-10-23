// The attachments of the booking e-mails without PostgreSQL or SMTP (OBE-055; OADR-0013 item 8): what an e-mail does
// with its booking's documents (attach, wait, link), the delayed `notify` that claims a waiting one again
// (notifications.processor.ts `wakeJob`) and the checks of the files it attaches. The claim's reads and the sending
// through Mailpit run in test/integration/notifications/booking-emails.int.test.ts.
import { createHash } from "node:crypto";
import type { StorageAdapter } from "@velexis/db/storage";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../tenancy/tenant-context";
import {
  ATTACHMENT_RECHECK_MS,
  ATTACHMENT_WAIT_MS,
  attachmentRuleOf,
  MAX_ATTACHMENT_BYTES,
  NotificationAttachments,
  planAttachments,
  readyDocuments,
  waitUntil,
  type AttachmentDocument,
  type BookingDocumentsState,
} from "./attachments";
import { wakeJob } from "./notifications.processor";

const QUEUED = new Date("2026-11-01T10:00:00.000Z");
const at = (ms: number): Date => new Date(QUEUED.getTime() + ms);

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function document(id: string, bytes: Buffer = Buffer.from(`%PDF ${id}`)): AttachmentDocument {
  return {
    id,
    fileName: `${id}.pdf`,
    contentType: "application/pdf",
    storageKey: `tenant_alpha/documents/bkg_01J9ZA2B4C6D8E0F2G4H6J8K0M/${id}.pdf`,
    contentHash: sha256(bytes),
  };
}

const ITINERARY = document("doc_itinerary");
const RECEIPT_A = document("doc_receipt_a");
const RECEIPT_B = document("doc_receipt_b");

function state(overrides: Partial<BookingDocumentsState> = {}): BookingDocumentsState {
  return {
    itinerary: undefined,
    eTicketIds: [],
    receipts: new Map(),
    itineraryAskedAt: undefined,
    receiptsAskedAt: undefined,
    ...overrides,
  };
}

describe("the documents an e-mail attaches", () => {
  it("[OBE-055 AC2] booking.confirmed attaches the itinerary and booking.ticketed every e-ticket's receipt", () => {
    expect(attachmentRuleOf("booking.confirmed")).toBe("itinerary");
    expect(attachmentRuleOf("booking.ticketed")).toBe("e_ticket_receipts");
    expect(attachmentRuleOf("booking.cancelled")).toBeUndefined();
    expect(attachmentRuleOf("staff.manual_review")).toBeUndefined();
    expect(attachmentRuleOf("booking.unknown")).toBeUndefined();

    expect(readyDocuments("itinerary", state({ itinerary: ITINERARY }))).toEqual([ITINERARY]);
    expect(
      readyDocuments(
        "e_ticket_receipts",
        state({
          eTicketIds: ["tkt_b", "tkt_a"],
          receipts: new Map([
            ["tkt_a", RECEIPT_A],
            ["tkt_b", RECEIPT_B],
          ]),
        }),
      ),
    ).toEqual([RECEIPT_B, RECEIPT_A]);
  });

  it("are all ready or none: a missing receipt, no e-ticket or no itinerary attaches nothing", () => {
    expect(readyDocuments("itinerary", state())).toBeUndefined();
    expect(readyDocuments("itinerary", undefined)).toBeUndefined();
    expect(readyDocuments("e_ticket_receipts", state())).toBeUndefined();
    expect(
      readyDocuments(
        "e_ticket_receipts",
        state({ eTicketIds: ["tkt_a", "tkt_b"], receipts: new Map([["tkt_a", RECEIPT_A]]) }),
      ),
    ).toBeUndefined();
  });
});

describe("planAttachments", () => {
  const ready = state({ itinerary: ITINERARY, itineraryAskedAt: QUEUED });

  it("[OBE-055 AC2] attaches the documents once they are ready, at any time", () => {
    for (const now of [at(0), at(ATTACHMENT_WAIT_MS), at(10 * ATTACHMENT_WAIT_MS)]) {
      expect(planAttachments("itinerary", { now, state: ready })).toEqual({
        kind: "attach",
        documents: [ITINERARY],
        askedAt: QUEUED,
      });
    }
  });

  it("[OBE-055 step 3] waits up to 2 minutes after they were asked for, checking every few seconds, then links", () => {
    const asked = state({ itineraryAskedAt: QUEUED });
    const plan = (now: Date) => planAttachments("itinerary", { now, state: asked });

    expect(plan(at(0))).toEqual({ kind: "wait", until: at(ATTACHMENT_RECHECK_MS) });
    expect(plan(at(ATTACHMENT_WAIT_MS - 1000))).toEqual({ kind: "wait", until: at(ATTACHMENT_WAIT_MS) });
    expect(plan(at(ATTACHMENT_WAIT_MS))).toEqual({ kind: "link" });
    expect(plan(at(ATTACHMENT_WAIT_MS + 1))).toEqual({ kind: "link" });
    expect(ATTACHMENT_WAIT_MS).toBe(2 * 60_000);
  });

  it("waits for the receipts from the event that asked for them, not from the itinerary's", () => {
    const receipts = state({
      eTicketIds: ["tkt_a"],
      itineraryAskedAt: at(ATTACHMENT_WAIT_MS),
      receiptsAskedAt: QUEUED,
    });

    expect(planAttachments("e_ticket_receipts", { now: at(ATTACHMENT_WAIT_MS), state: receipts })).toEqual({
      kind: "link",
    });
    expect(planAttachments("itinerary", { now: at(ATTACHMENT_WAIT_MS), state: receipts })).toEqual({
      kind: "wait",
      until: at(ATTACHMENT_WAIT_MS + ATTACHMENT_RECHECK_MS),
    });
  });

  it("sends with the link at once when nothing asked for the documents, or the e-mail has no booking", () => {
    expect(planAttachments("itinerary", { now: at(0), state: state() })).toEqual({ kind: "link" });
    expect(planAttachments("itinerary", { now: at(0), state: undefined })).toEqual({ kind: "link" });
  });

  it("waitUntil is the next check or the end of the wait, whichever comes first", () => {
    expect(waitUntil(QUEUED, at(0))).toEqual(at(ATTACHMENT_RECHECK_MS));
    expect(waitUntil(QUEUED, at(ATTACHMENT_WAIT_MS - 1))).toEqual(at(ATTACHMENT_WAIT_MS));
    expect(waitUntil(QUEUED, at(ATTACHMENT_WAIT_MS))).toBeUndefined();
    expect(waitUntil(undefined, at(0))).toBeUndefined();
  });
});

describe("wakeJob, the delayed notify of the e-mails waiting for their documents", () => {
  const TENANT = "ten_01J9ZA2B4C6D8E0F2G4H6J8K0M";

  it("[OBE-055 step 3] runs at the end of the check's step, one job per tenant and step", () => {
    const due = at(ATTACHMENT_RECHECK_MS + 1);
    const wake = wakeJob(TENANT, due);
    const step = Math.ceil(due.getTime() / ATTACHMENT_RECHECK_MS);

    expect(wake).toEqual({
      jobId: `notify:${TENANT}:w${step}`,
      runAt: new Date(step * ATTACHMENT_RECHECK_MS),
    });
    // BullMQ accepts a custom id with a colon only when it has three parts.
    expect(wake.jobId.split(":")).toHaveLength(3);
    // Never before the e-mail is due, so the job finds it; e-mails due within one step share the job.
    for (const offset of [0, 1, ATTACHMENT_RECHECK_MS - 1]) {
      const within = new Date(step * ATTACHMENT_RECHECK_MS - offset);
      expect(wakeJob(TENANT, within)).toEqual(wake);
      expect(wakeJob(TENANT, within).runAt.getTime()).toBeGreaterThanOrEqual(within.getTime());
    }
    expect(wakeJob(TENANT, new Date(step * ATTACHMENT_RECHECK_MS + 1)).jobId).toBe(
      `notify:${TENANT}:w${step + 1}`,
    );
  });
});

describe("NotificationAttachments.load", () => {
  function attachmentsWith(files: Readonly<Record<string, Buffer | Error>>) {
    const storage = {
      get: vi.fn((key: string) => {
        const file = files[key];
        return file instanceof Error ? Promise.reject(file) : Promise.resolve(file ?? null);
      }),
    } as unknown as StorageAdapter;
    const tenants = { require: () => ({ schemaName: "tenant_alpha" }) } as unknown as TenantContext;
    const logger = { warn: vi.fn() } as unknown as PinoLogger;
    return { attachments: new NotificationAttachments(storage, tenants, logger), logger, storage };
  }

  it("[OBE-055 AC2] reads each file of the tenant's documents and checks its SHA-256", async () => {
    const bytes = Buffer.from("%PDF doc_itinerary");
    const { attachments } = attachmentsWith({ [ITINERARY.storageKey]: bytes });

    expect(await attachments.load("ntf_1", [ITINERARY])).toEqual([
      { fileName: "doc_itinerary.pdf", contentType: "application/pdf", content: bytes },
    ]);
  });

  it("attaches nothing when a file is missing, changed, unreadable, too big or outside the tenant's documents", async () => {
    const changed = document("doc_changed");
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    const tooBig = { ...document("doc_big"), contentHash: sha256(big) };
    const foreign = { ...ITINERARY, storageKey: `tenant_beta/documents/${ITINERARY.id}.pdf` };
    const unreadable = document("doc_unreadable");
    const { attachments, logger, storage } = attachmentsWith({
      [changed.storageKey]: Buffer.from("something else"),
      [tooBig.storageKey]: big,
      [unreadable.storageKey]: new Error("EACCES /var/lib/velexis/storage/tenant_alpha/…"),
      [foreign.storageKey]: Buffer.from("%PDF doc_itinerary"),
    });

    for (const documents of [[ITINERARY], [changed], [tooBig], [foreign], [unreadable]]) {
      expect(await attachments.load("ntf_1", documents)).toBeUndefined();
    }
    expect(
      vi.mocked(logger.warn).mock.calls.map(([fields]) => (fields as { reason: string }).reason),
    ).toEqual(["missing", "content", "too_big", "foreign_key", "unreadable:Error"]);
    // Another tenant's key is never read.
    expect(vi.mocked(storage.get).mock.calls.map(([key]) => key)).not.toContain(foreign.storageKey);
  });
});
