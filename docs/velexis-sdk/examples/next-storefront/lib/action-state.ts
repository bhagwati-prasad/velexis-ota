/**
 * Serializable server-action results (shared by server actions and client components).
 * SDK error classes do not survive the server-action boundary, so actions return `VelexisErrorData`.
 */
import type { VelexisErrorData } from "@velexis/ota-sdk/react";
import type { Money } from "@velexis/ota-sdk";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: VelexisErrorData };

/** State for `useActionState` forms. */
export interface FormState {
  ok?: boolean;
  message?: string;
  error?: VelexisErrorData;
}

/** Price change surfaced by an action (PRICE_CHANGED → show and let the customer accept). */
export interface PriceChange {
  oldPrice?: Money;
  newPrice?: Money;
  pricedOfferId?: string;
}

export const initialFormState: FormState = {};

/** The message of a field error for a JSON pointer prefix (e.g. `/travelers/0/name/firstName`). */
export function fieldError(error: VelexisErrorData | undefined, path: string): string | undefined {
  const fe = error?.fieldErrors.find((f) => f.path === path || f.path.startsWith(path + "/"));
  return fe ? fe.message ?? fe.code : undefined;
}

/** Human-readable text for common error codes. */
export function describeError(error: VelexisErrorData): string {
  switch (error.code) {
    case "OFFER_EXPIRED":
    case "SEARCH_EXPIRED":
      return "These prices have expired. Please search again.";
    case "CHECKOUT_EXPIRED":
      return "Your checkout session expired. Please start again from the flight.";
    case "SOLD_OUT":
      return "This fare is no longer available.";
    case "PAYMENT_DECLINED":
      return "Your payment was declined. Try another card.";
    case "PAYMENT_REQUIRED":
      return "The payment is not authorised yet.";
    case "RATE_LIMITED":
      return "Too many attempts — please wait a moment and try again.";
    case "SUPPLIER_TIMEOUT":
    case "SUPPLIER_UNAVAILABLE":
    case "SUPPLIER_ERROR":
      return "The airline system did not answer in time. Please try again.";
    case "UNAUTHENTICATED":
    case "TOKEN_EXPIRED":
      return "Please sign in again.";
    case "FORBIDDEN":
    case "SCOPE_NOT_ALLOWED":
      return "You are not allowed to do this.";
    case "PRECONDITION_FAILED":
    case "VERSION_CONFLICT":
      return "This record changed in the meantime. Reload the page and try again.";
    default:
      return error.message || "Something went wrong.";
  }
}
