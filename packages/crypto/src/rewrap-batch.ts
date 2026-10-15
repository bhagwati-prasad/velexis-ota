import { rewrapValue, type EncryptedValue } from "./envelope.js";
import { DecryptionError, type KeyProvider } from "./key-provider.js";

/**
 * The shared batch helper of KEK rotation (ADR-0010, Rotation step 3). Each backend owns its data, so each
 * calls `rewrapBatch` from its own `secrets:rewrap` command with its own `fetch` and `update`: the platform
 * backend for the platform ciphertext columns, the OTA backend once per table of every tenant schema.
 */

/** The batch size when the caller gives none. */
export const REWRAP_DEFAULT_BATCH_SIZE = 500;
/** The largest batch `rewrapBatch` accepts. */
export const REWRAP_MAX_BATCH_SIZE = 10_000;

/** One row as `fetch` returns it: its id, its `encryption_key_id` and the ciphertext columns that id covers. */
export interface RewrapRow {
  /** The row's primary key, also the keyset cursor. */
  readonly id: string;
  /** The row's `encryption_key_id`. */
  readonly kekId: string;
  /**
   * Every ciphertext column that the row's `encryption_key_id` covers, by column name, `null` where the column is
   * NULL. Usually one column; two where a table keeps two values under one id (`secret_ciphertext` and
   * `webhook_secret_ciphertext` of `platform.credential_submissions`, `documents_ciphertext` and
   * `discount_eligibility_ciphertext` of the tenant traveller tables).
   */
  readonly ciphertexts: Readonly<Record<string, Uint8Array | null>>;
}

/** The page that `fetch` is asked for. */
export interface RewrapPage {
  /** The current KEK: return only rows whose `encryption_key_id` is another one. */
  readonly currentKekId: string;
  /** Keyset pagination: return only rows whose id sorts after this one, or from the start when `null`. */
  readonly afterId: string | null;
  /** Return at most this many rows, in ascending id order. */
  readonly limit: number;
}

/** One row's re-wrapped values, as `update` is asked to write them. */
export interface RewrapChange {
  readonly id: string;
  /** The KEK that now wraps every data key of the row: write it to `encryption_key_id`. */
  readonly kekId: string;
  /** The new value of every column that was not NULL, by column name. */
  readonly ciphertexts: Readonly<Record<string, Buffer>>;
  /**
   * The row exactly as `fetch` returned it. `update` writes only while every column of `previous.ciphertexts`
   * (NULL ones included) and the `encryption_key_id` still hold these values: the optimistic check.
   */
  readonly previous: RewrapRow;
}

/** A pino logger or NestJS `PinoLogger` fits. `rewrapBatch` passes it counts only. */
export interface RewrapLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface RewrapBatchOptions {
  /**
   * One page of rows whose `encryption_key_id` is not `currentKekId`, with an id after `afterId`, in ascending id
   * order, at most `limit` of them; for example `WHERE encryption_key_id <> $1 AND id > $2 ORDER BY id LIMIT $3`.
   * Leave out rows without any ciphertext in the query itself, never after its `LIMIT`: the pass ends at the first
   * empty page, so a page emptied by such a filter would end it early and hide the rows after it from
   * `remainingByKekId`. A short page does not end the pass.
   */
  readonly fetch: (page: RewrapPage) => Promise<readonly RewrapRow[]>;
  /**
   * Writes the new ciphertexts and `encryption_key_id` of one row in one statement, guarded by the optimistic
   * check on `previous`, and resolves to `true` when it changed the row, `false` when the check matched no row
   * (someone changed it in between).
   */
  readonly update: (change: RewrapChange) => Promise<boolean>;
  /** The associated data of one value: `(row, column) => aadFor(schema, table, column, row.id)`. */
  readonly aadFor: (row: RewrapRow, column: string) => string;
  readonly keys: KeyProvider;
  /** Rows per `fetch`, 1 to `REWRAP_MAX_BATCH_SIZE`; 500 by default. */
  readonly batchSize?: number;
  readonly logger?: RewrapLogger;
}

export interface RewrapResult {
  /** Rows written under the current KEK. */
  readonly rewrapped: number;
  /** Rows that changed between `fetch` and `update`; they were left as the other writer left them. */
  readonly skipped: number;
  /** Rows with a value that did not authenticate at its place (`DecryptionError`); they were left unchanged. */
  readonly failed: number;
  /**
   * Rows still not under the current KEK after the run, by `encryption_key_id`, counted with `fetch`. An empty
   * object means the old KEKs wrap nothing any more in this row source.
   */
  readonly remainingByKekId: Readonly<Record<string, number>>;
}

type Outcome = "rewrapped" | "skipped" | "failed" | "unchanged";

interface Counts {
  rewrapped: number;
  skipped: number;
  failed: number;
}

function assertBatchSize(batchSize: unknown): asserts batchSize is number {
  if (
    typeof batchSize !== "number" ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > REWRAP_MAX_BATCH_SIZE
  ) {
    throw new RangeError(`rewrapBatch(): batchSize must be an integer from 1 to ${REWRAP_MAX_BATCH_SIZE}`);
  }
}

function assertRow(row: RewrapRow): void {
  if (
    typeof row !== "object" ||
    row === null ||
    typeof row.id !== "string" ||
    typeof row.kekId !== "string" ||
    typeof row.ciphertexts !== "object" ||
    row.ciphertexts === null ||
    Object.keys(row.ciphertexts).length === 0
  ) {
    throw new TypeError(
      "rewrapBatch(): fetch must return rows with an id, a kekId and at least one ciphertext column",
    );
  }
}

/**
 * Every page of `fetch` from the start, by keyset pagination, until a page is empty. A short page does not end the
 * pass: a `fetch` that drops rows after its `LIMIT` must not hide the rows after them from `remainingByKekId`, the
 * count that decides whether an old KEK may be removed. A `fetch` that ignores the cursor is an error.
 */
async function* pages(
  fetchPage: RewrapBatchOptions["fetch"],
  currentKekId: string,
  limit: number,
): AsyncGenerator<readonly RewrapRow[]> {
  let afterId: string | null = null;
  for (;;) {
    const rows = await fetchPage({ currentKekId, afterId, limit });
    if (!Array.isArray(rows) || rows.length > limit) {
      throw new TypeError("rewrapBatch(): fetch must return an array of at most `limit` rows");
    }
    const last: RewrapRow | undefined = rows.at(-1);
    if (last === undefined) {
      return;
    }
    rows.forEach(assertRow);
    if (last.id === afterId) {
      throw new TypeError(
        "rewrapBatch(): fetch must return only rows after `afterId`, in ascending id order",
      );
    }
    yield rows;
    afterId = last.id;
  }
}

/** Re-wraps every value of one row and writes them with the optimistic check. No plaintext is ever returned. */
async function rewrapRow(
  row: RewrapRow,
  currentKekId: string,
  options: RewrapBatchOptions,
): Promise<Outcome> {
  const moved: Array<[string, Buffer]> = [];
  let changed = row.kekId !== currentKekId;
  for (const [column, ciphertext] of Object.entries(row.ciphertexts)) {
    if (ciphertext === null) {
      continue;
    }
    let value: EncryptedValue;
    try {
      value = await rewrapValue(ciphertext, { keys: options.keys, aad: options.aadFor(row, column) });
    } catch (error) {
      if (error instanceof DecryptionError) {
        return "failed";
      }
      throw error;
    }
    if (value.kekId !== currentKekId) {
      throw new Error("rewrapBatch(): the key provider's current KEK changed during the run");
    }
    changed ||= !value.ciphertext.equals(ciphertext);
    moved.push([column, value.ciphertext]);
  }
  if (!changed) {
    return "unchanged";
  }

  const written: unknown = await options.update({
    id: row.id,
    kekId: currentKekId,
    ciphertexts: Object.fromEntries(moved),
    previous: row,
  });
  if (typeof written !== "boolean") {
    throw new TypeError(
      "rewrapBatch(): update must resolve to true (row written) or false (row changed meanwhile)",
    );
  }
  return written ? "rewrapped" : "skipped";
}

/**
 * Moves every row of one row source to the current KEK (ADR-0010, KEK rotation). It fetches the rows whose
 * `encryption_key_id` is not the current KEK page by page (keyset pagination by id), re-wraps each value with
 * `rewrapValue` after checking it against its associated data, and writes the new ciphertexts and
 * `encryption_key_id` through `update`, guarded by an optimistic check on the old values. Only data keys are
 * re-wrapped; the data is not re-encrypted. A row changed meanwhile is skipped and counted, never overwritten.
 * A row that does not authenticate is left unchanged and counted as failed. Errors of `fetch`, `update` or the key
 * provider stop the run; rows written until then stay written, and a new run continues where this one stopped.
 *
 * Then it counts what is left under another KEK with `fetch` again, so `remainingByKekId` is `{}` once the old KEK
 * can be removed. Running it again changes nothing. No plaintext leaves the function, and it logs counts only.
 */
export async function rewrapBatch(options: RewrapBatchOptions): Promise<RewrapResult> {
  const batchSize = options.batchSize ?? REWRAP_DEFAULT_BATCH_SIZE;
  assertBatchSize(batchSize);
  const currentKekId = options.keys.currentKekId();
  const totals: Counts = { rewrapped: 0, skipped: 0, failed: 0 };

  for await (const rows of pages(options.fetch, currentKekId, batchSize)) {
    const batch: Counts = { rewrapped: 0, skipped: 0, failed: 0 };
    for (const row of rows) {
      const outcome = await rewrapRow(row, currentKekId, options);
      if (outcome !== "unchanged") {
        batch[outcome] += 1;
        totals[outcome] += 1;
      }
    }
    options.logger?.info({ rows: rows.length, ...batch }, "secrets.rewrap.batch");
  }

  const remaining = new Map<string, number>();
  for await (const rows of pages(options.fetch, currentKekId, batchSize)) {
    for (const row of rows) {
      if (row.kekId !== currentKekId) {
        remaining.set(row.kekId, (remaining.get(row.kekId) ?? 0) + 1);
      }
    }
  }
  const remainingByKekId = Object.fromEntries(
    [...remaining].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  options.logger?.info({ ...totals, remainingByKekId }, "secrets.rewrap.done");
  return { ...totals, remainingByKekId };
}
