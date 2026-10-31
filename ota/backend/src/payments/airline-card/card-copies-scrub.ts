// The one-off scrub of the card copies stored before FIX-W29-SECURITY (lead decision (1) of 2026-10-26, FIX-W30-OTA;
// OADR-0004 point 2 and its dated notes, conventions §9: a backfill of tenant data is a batched job per tenant, never a
// migration). Since FIX-W29-SECURITY (2026-10-24) every stored copy of a card keeps its brand and last 4 only: the
// shared redactor of @velexis/logger drops a card's holder and expiry (`holder`, `holderName`, `expiryDate`,
// `expiryMonth`, `expiryYear`) anywhere in a card and below a form of payment. Rows written before it may still hold
// them, in the copies of an airline-card payment's Flight Create Orders and of the later order reads:
//
//   bookings.form_of_payments          the order's forms of payment (as `redactPayload(formOfPayments)` wrote them)
//   bookings.order_snapshot            the order (`redactPayload(order)`)
//   supplier_requests.request_body     the bodies of the Amadeus calls (`supplierRequestBody`: the redactor, then the
//   supplier_requests.response_body   e-mails and phones masked, a body over 64 KB as `{truncated, bytes, preview}`)
//
// `scrubCardCopies` rewrites them through the current redactor, in batches, for one tenant schema, and changes nothing
// else: no other column (not `version`, `updated_at` or the row's other jsonb), and a copy the redactor leaves as it is
// is not written at all. The redactor is a fixed point of its own output (masked numbers stay masked, `[REDACTED]`
// stays), so a second run, or a run over rows written since 2026-10-24, writes nothing. A form of payment is redacted as
// what it is (`{formOfPayments: …}`), so a card's holder and expiry go wherever they sit in it. The e-mail and phone
// masking of `supplier_requests` is not applied again (it is already applied, and masking a masked phone would cut it
// further). The preview of a truncated body is text, not JSON the redactor can read: it is cut before the first card or
// form of payment whose value holds a card's holder or expiry (`scrubbedPreview`), the rest of the preview kept.
//
// Each batch is one short `tenantTx` transaction (velexis_ota_app, the tenant's schema by `set_config`): a keyset read of
// at most `batchSize` rows after the last id, without a lock, of the rows whose copies name a holder or an expiry key
// (a text match; most bookings match through their travellers' documents, whose expiry stays), then an update of each
// changed row compared with what was read (`IS NOT DISTINCT FROM` the copies read): a row that changed meanwhile was
// written by the current code, is skipped (`skipped`) and left to a second run. No lock is held across batches; an
// update locks one row for the length of its batch's transaction, in id order. The command of
// scrub-card-copies.command.ts runs it per tenant.
//
// Nothing here logs or returns a copy: the counts only.
import { sql, tenantTx, type TenantDb } from "@velexis/db";
import { redactPayload } from "@velexis/logger";

/** How many rows one batch reads at most. */
export const SCRUB_BATCH_SIZE = 100;

/**
 * The prefilter of the rows a batch reads, matched case-insensitively against the jsonb's text: a holder or an expiry
 * key, also inside a string (the preview of a truncated body, whose quotes the text escapes).
 */
export const CARD_COPY_KEY_PATTERN = String.raw`\\?"(holder([-_]?name)?|expiry[-_]?(date|month|year))\\?"`;

/** The key of a card or of a form of payment in JSON text, and the space before its value. */
const CARD_KEY_IN_TEXT =
  /"(?:form[-_]?of[-_]?payments|credit[-_]?card|payment[-_]?card|card|virtual[-_]?credit[-_]?card[-_]?details)"\s*:\s*/gi;
/** A card's holder or expiry key in JSON text. */
const HOLDER_OR_EXPIRY_IN_TEXT = /"(?:holder(?:[-_]?name)?|expiry[-_]?(?:date|month|year))"\s*:/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `bookings.form_of_payments` as the current redactor keeps it: everything below a form of payment is redacted. */
export function scrubbedFormOfPayments(value: unknown): unknown {
  return redactPayload({ formOfPayments: value }).formOfPayments;
}

/** `bookings.order_snapshot` as the current redactor keeps it. */
export function scrubbedOrderSnapshot(value: unknown): unknown {
  return redactPayload(value);
}

/**
 * The end (exclusive) of the JSON value that starts at `from` in `text`: the matching close of an object or array,
 * strings and their escapes skipped, or the end of the text when it is cut first; `from` for a value that is neither.
 */
function valueEnd(text: string, from: number): number {
  const open = text[from];
  if (open !== "{" && open !== "[") {
    return from;
  }
  let depth = 0;
  let inString = false;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return text.length;
}

/**
 * The preview of a truncated body (the first part of its JSON text) without a card's holder or expiry: cut before the
 * first card or form of payment whose value (as far as the preview has it) holds one; unchanged otherwise.
 */
export function scrubbedPreview(preview: string): string {
  for (const match of preview.matchAll(CARD_KEY_IN_TEXT)) {
    const valueStart = match.index + match[0].length;
    if (HOLDER_OR_EXPIRY_IN_TEXT.test(preview.slice(valueStart, valueEnd(preview, valueStart)))) {
      return preview.slice(0, match.index);
    }
  }
  return preview;
}

/** A body `supplierRequestBody` cut to its first part: `{truncated: true, bytes, preview}`. */
function isTruncatedBody(
  value: unknown,
): value is { truncated: true; preview: string } & Record<string, unknown> {
  return isRecord(value) && value["truncated"] === true && typeof value["preview"] === "string";
}

/** A `supplier_requests` body as the current redactor keeps it (see the file header); `null` stays `null`. */
export function scrubbedSupplierBody(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (isTruncatedBody(value)) {
    return { ...value, preview: scrubbedPreview(value.preview) };
  }
  return redactPayload(value);
}

/** Whether a scrubbed copy differs from the stored one (their JSON texts, the key order as stored). */
export function copyChanged(stored: unknown, scrubbed: unknown): boolean {
  return JSON.stringify(stored ?? null) !== JSON.stringify(scrubbed ?? null);
}

/** What a run did to one table: the rows read, rewritten, and skipped because they changed meanwhile. */
export interface ScrubCounts {
  readonly read: number;
  readonly scrubbed: number;
  readonly skipped: number;
}

/** What a run did to one tenant schema. */
export interface ScrubOutcome {
  readonly bookings: ScrubCounts;
  readonly supplierRequests: ScrubCounts;
}

/** A jsonb value to compare with: the JSON text of what was read (SQL `NULL` for none), never a PostgreSQL array. */
const jsonb = (value: unknown) =>
  sql`${value === null || value === undefined ? null : JSON.stringify(value)}::jsonb`;

/** Scrubs `bookings.form_of_payments` and `order_snapshot` of `schema` (see the file header). */
async function scrubBookings(tenants: TenantDb, schema: string, batchSize: number): Promise<ScrubCounts> {
  let after = "";
  let read = 0;
  let scrubbed = 0;
  let skipped = 0;
  for (;;) {
    const batch = await tenantTx(tenants, schema, async (trx) => {
      const rows = await trx
        .selectFrom("bookings")
        .select(["id", "form_of_payments as formOfPayments", "order_snapshot as orderSnapshot"])
        .where("id", ">", after)
        .where((eb) =>
          eb.or([
            eb(sql`form_of_payments::text`, "~*", CARD_COPY_KEY_PATTERN),
            eb(sql`order_snapshot::text`, "~*", CARD_COPY_KEY_PATTERN),
          ]),
        )
        .orderBy("id")
        .limit(batchSize)
        .execute();
      let written = 0;
      let changedMeanwhile = 0;
      for (const row of rows) {
        const formOfPayments = scrubbedFormOfPayments(row.formOfPayments);
        const orderSnapshot = scrubbedOrderSnapshot(row.orderSnapshot);
        const fopChanged = copyChanged(row.formOfPayments, formOfPayments);
        const snapshotChanged = copyChanged(row.orderSnapshot, orderSnapshot);
        if (!fopChanged && !snapshotChanged) {
          continue;
        }
        const result = await trx
          .updateTable("bookings")
          .set({
            ...(fopChanged ? { form_of_payments: JSON.stringify(formOfPayments) } : {}),
            ...(snapshotChanged ? { order_snapshot: JSON.stringify(orderSnapshot) } : {}),
          })
          .where("id", "=", row.id)
          .where(sql<boolean>`form_of_payments is not distinct from ${jsonb(row.formOfPayments)}`)
          .where(sql<boolean>`order_snapshot is not distinct from ${jsonb(row.orderSnapshot)}`)
          .executeTakeFirst();
        if (result.numUpdatedRows > 0n) {
          written += 1;
        } else {
          changedMeanwhile += 1;
        }
      }
      return { ids: rows.map((row) => row.id), written, changedMeanwhile };
    });
    read += batch.ids.length;
    scrubbed += batch.written;
    skipped += batch.changedMeanwhile;
    const last = batch.ids.at(-1);
    if (batch.ids.length < batchSize || last === undefined) {
      return { read, scrubbed, skipped };
    }
    after = last;
  }
}

/** Scrubs `supplier_requests.request_body` and `response_body` of `schema` (see the file header). */
async function scrubSupplierRequests(
  tenants: TenantDb,
  schema: string,
  batchSize: number,
): Promise<ScrubCounts> {
  let after = "";
  let read = 0;
  let scrubbed = 0;
  let skipped = 0;
  for (;;) {
    const batch = await tenantTx(tenants, schema, async (trx) => {
      const rows = await trx
        .selectFrom("supplier_requests")
        .select(["id", "request_body as requestBody", "response_body as responseBody"])
        .where("id", ">", after)
        .where((eb) =>
          eb.or([
            eb(sql`request_body::text`, "~*", CARD_COPY_KEY_PATTERN),
            eb(sql`response_body::text`, "~*", CARD_COPY_KEY_PATTERN),
          ]),
        )
        .orderBy("id")
        .limit(batchSize)
        .execute();
      let written = 0;
      let changedMeanwhile = 0;
      for (const row of rows) {
        const requestBody = scrubbedSupplierBody(row.requestBody);
        const responseBody = scrubbedSupplierBody(row.responseBody);
        const requestChanged = copyChanged(row.requestBody, requestBody);
        const responseChanged = copyChanged(row.responseBody, responseBody);
        if (!requestChanged && !responseChanged) {
          continue;
        }
        const result = await trx
          .updateTable("supplier_requests")
          .set({
            ...(requestChanged ? { request_body: JSON.stringify(requestBody) } : {}),
            ...(responseChanged ? { response_body: JSON.stringify(responseBody) } : {}),
          })
          .where("id", "=", row.id)
          .where(sql<boolean>`request_body is not distinct from ${jsonb(row.requestBody)}`)
          .where(sql<boolean>`response_body is not distinct from ${jsonb(row.responseBody)}`)
          .executeTakeFirst();
        if (result.numUpdatedRows > 0n) {
          written += 1;
        } else {
          changedMeanwhile += 1;
        }
      }
      return { ids: rows.map((row) => row.id), written, changedMeanwhile };
    });
    read += batch.ids.length;
    scrubbed += batch.written;
    skipped += batch.changedMeanwhile;
    const last = batch.ids.at(-1);
    if (batch.ids.length < batchSize || last === undefined) {
      return { read, scrubbed, skipped };
    }
    after = last;
  }
}

/**
 * Scrubs the stored card copies of the tenant schema `schema` (see the file header): `bookings`, then
 * `supplier_requests`, `batchSize` rows per transaction. Throws what the database throws; a run that stopped is simply
 * run again.
 */
export async function scrubCardCopies(
  tenants: TenantDb,
  schema: string,
  options: { readonly batchSize?: number } = {},
): Promise<ScrubOutcome> {
  const batchSize = options.batchSize ?? SCRUB_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError("scrubCardCopies: the batch size must be a positive integer");
  }
  return {
    bookings: await scrubBookings(tenants, schema, batchSize),
    supplierRequests: await scrubSupplierRequests(tenants, schema, batchSize),
  };
}
