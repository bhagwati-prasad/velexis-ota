// Travellers' identity documents and discount cards at rest (OBE-036; ota/docs/data-model.md §4, ADR-0010, db README
// §8, the OTA document's setCheckoutTravelers and TravelerDocumentInput, SDK guide B3 §2.2 "Document numbers").
//
// `checkout_travelers.documents_ciphertext` holds the traveller's Amadeus `documents[]` (numbers included) and
// `discount_eligibility_ciphertext` the `discountEligibility[]` (card and certificate numbers included), each as JSON
// envelope-encrypted with the KEKs of MASTER_KEY_DIR (`@velexis/crypto`: a fresh data key per value, AES-256-GCM) and
// the associated data of its place, `tenant_<key>.checkout_travelers.<column>:<ctr_…>`, so a ciphertext copied to
// another traveller, column or tenant does not decrypt. `encryption_key_id` repeats the KEK id (both values of a row
// are sealed together, under one KEK). An empty list is stored as NULL. No other column holds a number: the readable
// columns are names, the date of birth, gender, contact, loyalty programmes and the emergency contact.
//
// Answers carry only what the task and the contract let stay readable (`readableDocument`, `readableDiscount`): the
// document type, the number masked to its last 4 characters (`numberMasked`, "•••••4821"), the expiry date, the
// countries and the holder flag; the issue date, place of issue and birth place stay inside the ciphertext, and
// discount card and certificate numbers are masked the same way. A document sent back without `number` (a response
// document, or a form that edits only the expiry date) keeps the stored number of the traveller's document with the
// same type and issuing country, and the hidden fields it omits (`documentsToStore`); a masked value never matches the
// number pattern of the document, so it is refused before it gets here.
//
// Decrypted values live in memory for the request only and are never logged; plaintext buffers are zeroed after use.
import { Inject, Injectable, type FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types";
import { aadFor, decryptValue, encryptValue, LocalFileKeyProvider, type KeyProvider } from "@velexis/crypto";
import type { TenantSchema } from "@velexis/db";
import type { ApiConfig } from "../config";

type Schemas = components["schemas"];
export type TravelerDocument = Schemas["TravelerDocument"];
export type TravelerDocumentInput = Schemas["TravelerDocumentInput"];
export type AmadeusDiscount = Schemas["AmadeusDiscount"];
type DocumentType = Schemas["AmadeusDocumentType"];

/** Injection token of the KEKs that seal the traveller columns (MASTER_KEY_DIR, MASTER_KEY_CURRENT). */
export const CHECKOUT_KEY_PROVIDER = "CHECKOUT_KEY_PROVIDER";

/**
 * The KEKs of MASTER_KEY_DIR, MASTER_KEY_CURRENT wrapping new data keys (ADR-0010, ADR-0026). Nest awaits the factory,
 * so the API does not start without them (a `KeyProviderError` names the file, never its content).
 */
export const checkoutKeyProvider: FactoryProvider<Promise<KeyProvider>> = {
  provide: CHECKOUT_KEY_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<ApiConfig, true>) =>
    LocalFileKeyProvider.fromDir(
      config.get("MASTER_KEY_DIR", { infer: true }),
      config.get("MASTER_KEY_CURRENT", { infer: true }),
    ),
};

/** The table of the sealed columns. */
const TABLE = "checkout_travelers";
export const DOCUMENTS_COLUMN = "documents_ciphertext";
export const DISCOUNTS_COLUMN = "discount_eligibility_ciphertext";

/** A document as sealed: the Amadeus IdentityDocument fields with the full number. */
export interface StoredDocument {
  readonly documentType: DocumentType;
  readonly number: string;
  readonly issuanceDate?: string;
  readonly expiryDate?: string;
  readonly issuanceCountry?: string;
  readonly issuanceLocation?: string;
  readonly nationality?: string;
  readonly birthPlace?: string;
  readonly validityCountry?: string;
  readonly birthCountry?: string;
  readonly holder: boolean;
}

/** The optional text fields of a document, in the document's order. */
const DOCUMENT_FIELDS = [
  "issuanceDate",
  "expiryDate",
  "issuanceCountry",
  "issuanceLocation",
  "nationality",
  "birthPlace",
  "validityCountry",
  "birthCountry",
] as const;

/** The fields an answer leaves out, which a document sent back without them keeps from the stored one. */
const HIDDEN_FIELDS: ReadonlySet<string> = new Set(["issuanceDate", "issuanceLocation", "birthPlace"]);

/** The readable fields of an answer's document, besides the type, the masked number and the holder flag. */
const READABLE_FIELDS = [
  "expiryDate",
  "issuanceCountry",
  "nationality",
  "validityCountry",
  "birthCountry",
] as const;

/** The mask in front of the last 4 characters (B1 SavedTravelerDocument, TravelerDocument.numberMasked). */
export const MASK = "•••••";

/** A number masked to its last 4 characters; a number of 4 characters or fewer is masked whole. */
export function maskNumber(value: string): string {
  return value.length <= 4 ? MASK : `${MASK}${value.slice(-4)}`;
}

/** The document as an answer shows it: no full number, no issue date, place of issue or birth place. */
export function readableDocument(document: StoredDocument): TravelerDocument {
  const readable: TravelerDocument = {
    documentType: document.documentType,
    numberMasked: maskNumber(document.number),
  };
  for (const field of READABLE_FIELDS) {
    const value = document[field];
    if (value !== undefined) {
      readable[field] = value;
    }
  }
  readable.holder = document.holder;
  return readable;
}

/** The discount entry as an answer shows it: card and certificate numbers masked to their last 4 characters. */
export function readableDiscount(discount: AmadeusDiscount): AmadeusDiscount {
  const readable: AmadeusDiscount = { ...discount };
  if (discount.cardNumber !== undefined) {
    readable.cardNumber = maskNumber(discount.cardNumber);
  }
  if (discount.certificateNumber !== undefined) {
    readable.certificateNumber = maskNumber(discount.certificateNumber);
  }
  return readable;
}

/** The documents to store for a traveller, and the indexes of input documents without a number to keep. */
export interface DocumentsToStore {
  readonly documents: StoredDocument[];
  readonly missing: number[];
}

/**
 * The documents a setTravelers request stores for a traveller: each input document as sent (`holder` defaults to
 * true), or — sent without `number` — with the number of the stored document of the same type and issuing country and
 * the hidden fields it omits. An input document without a number and without such a stored document is in `missing`
 * (`422 TRAVELER_DATA_INVALID`, `REQUIRED` at its `number`). `numberMasked` of an input is ignored.
 */
export function documentsToStore(
  inputs: readonly TravelerDocumentInput[],
  stored: readonly StoredDocument[],
): DocumentsToStore {
  const documents: StoredDocument[] = [];
  const missing: number[] = [];
  inputs.forEach((input, index) => {
    const kept =
      input.number === undefined
        ? stored.find(
            (document) =>
              document.documentType === input.documentType &&
              document.issuanceCountry === input.issuanceCountry,
          )
        : undefined;
    const number = input.number ?? kept?.number;
    if (number === undefined) {
      missing.push(index);
      return;
    }
    const document: Record<string, unknown> = { documentType: input.documentType, number };
    for (const field of DOCUMENT_FIELDS) {
      const value = input[field] ?? (HIDDEN_FIELDS.has(field) ? kept?.[field] : undefined);
      if (value !== undefined) {
        document[field] = value;
      }
    }
    document["holder"] = input.holder ?? true;
    documents.push(document as unknown as StoredDocument);
  });
  return { documents, missing };
}

/** The sealed columns of a traveller (`null` for an empty list). */
export interface SealedTraveler {
  readonly documentsCiphertext: Buffer | null;
  readonly discountEligibilityCiphertext: Buffer | null;
  /** The KEK of both values, `null` when neither is stored. */
  readonly encryptionKeyId: string | null;
}

/** The decrypted lists of a traveller. */
export interface OpenedTraveler {
  readonly documents: StoredDocument[];
  readonly discounts: AmadeusDiscount[];
}

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A decrypted documents list; anything else was never sealed by this module (an internal error). */
function parseDocuments(value: unknown): StoredDocument[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        isRecord(item) && typeof item["documentType"] === "string" && typeof item["number"] === "string",
    )
  ) {
    throw new Error("a sealed documents list cannot be read");
  }
  return value as StoredDocument[];
}

function parseDiscounts(value: unknown): AmadeusDiscount[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error("a sealed discount list cannot be read");
  }
  return value as AmadeusDiscount[];
}

@Injectable()
export class TravelerDocuments {
  constructor(@Inject(CHECKOUT_KEY_PROVIDER) private readonly keys: KeyProvider) {}

  /** Seals a traveller's documents and discount entries for its row `travelerRowId` (`ctr_…`) of `schema`. */
  async seal(
    schema: TenantSchema,
    travelerRowId: string,
    documents: readonly StoredDocument[],
    discounts: readonly AmadeusDiscount[],
  ): Promise<SealedTraveler> {
    const documentsSealed =
      documents.length === 0
        ? undefined
        : await encryptValue(JSON.stringify(documents), {
            aad: aadFor(schema, TABLE, DOCUMENTS_COLUMN, travelerRowId),
            keys: this.keys,
          });
    const discountsSealed =
      discounts.length === 0
        ? undefined
        : await encryptValue(JSON.stringify(discounts), {
            aad: aadFor(schema, TABLE, DISCOUNTS_COLUMN, travelerRowId),
            keys: this.keys,
          });
    return {
      documentsCiphertext: documentsSealed?.ciphertext ?? null,
      discountEligibilityCiphertext: discountsSealed?.ciphertext ?? null,
      encryptionKeyId: documentsSealed?.kekId ?? discountsSealed?.kekId ?? null,
    };
  }

  /** The decrypted lists of a traveller row; a value that does not authenticate throws (`DecryptionError`). */
  async open(
    schema: TenantSchema,
    travelerRowId: string,
    sealed: Pick<SealedTraveler, "documentsCiphertext" | "discountEligibilityCiphertext">,
  ): Promise<OpenedTraveler> {
    const documents =
      sealed.documentsCiphertext === null
        ? []
        : parseDocuments(
            await this.decrypt(schema, DOCUMENTS_COLUMN, travelerRowId, sealed.documentsCiphertext),
          );
    const discounts =
      sealed.discountEligibilityCiphertext === null
        ? []
        : parseDiscounts(
            await this.decrypt(schema, DISCOUNTS_COLUMN, travelerRowId, sealed.discountEligibilityCiphertext),
          );
    return { documents, discounts };
  }

  private async decrypt(
    schema: TenantSchema,
    column: string,
    travelerRowId: string,
    value: Buffer,
  ): Promise<unknown> {
    const plaintext = await decryptValue(value, {
      aad: aadFor(schema, TABLE, column, travelerRowId),
      keys: this.keys,
    });
    try {
      return JSON.parse(plaintext.toString("utf8")) as unknown;
    } finally {
      plaintext.fill(0);
    }
  }
}
