// The early card check of the console's free text (FIX-W67-KI001, known issue KI-001, and FIX-W68-CARDTEXT, lead
// decision (37c); ADR-0011, OADR-0004): a note, a reason, a remark, a tag or a markup rule's notes for staff never hold
// a card number. The OTA API refuses one in every console free-text field (`400 VALIDATION_FAILED`, field code
// `card_data`, before anything is stored or sent); the server actions of the forms that send such a field refuse it
// first, at the field and with the API's own words, so the text never leaves the admin's server. The detector is
// @velexis/logger's `holdsCardNumber`, the one the API uses, so both always agree.
//
// Server side only: the detector stays out of the browser bundle (`server-only` fails a build that imports this module
// from a client component), and the server actions never log the text, the number or the form.
import "server-only";

import { holdsCardNumber } from "@velexis/logger";

/** The kind of a free text, which names it in the refusal's message. */
export type CardTextKind = "note" | "reason" | "remark" | "tag";

/** The API's message for each kind (ota/backend/src/common/http/card-free-text.ts `CARD_DATA_MESSAGES`). */
export const CARD_TEXT_MESSAGES: Readonly<Record<CardTextKind, string>> = Object.freeze({
  note: "A note never holds a card number: remove it.",
  reason: "A reason never holds a card number: remove it.",
  remark: "A remark never holds a card number: remove it.",
  tag: "A tag never holds a card number: remove it.",
});

/** True when a staff text holds no card number (Zod's `.refine` of a free-text field). */
export function withoutCardNumber(text: string): boolean {
  return !holdsCardNumber(text);
}
