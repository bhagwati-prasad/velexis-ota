import { otaPath } from "@/lib/roles";
import type { GO_LIVE_STRINGS } from "@/lib/strings";

/**
 * The preconditions of going live (README §2 `/otas/[tenantId]/go-live`; scope PF-14 AC1; the platform document's
 * `goLive`), shared by the go-live page, its client component and its action: Next.js lets a page export only its own
 * fields and a `"use server"` module only async functions, so what the three read lives here, without a directive.
 *
 * The API is the judge: `goLive` checks every precondition and answers `422 LIVE_PRECONDITIONS_UNMET` with all the
 * missing ones in `details.missing`. No call checks them without trying the switch, so before the first try the page
 * knows only what the onboarding checklist and the account say for sure (`initialStates`), and every try's answer
 * replaces the list (`statesAfterAnswer`).
 */

/** A precondition, as `details.missing` names it (one key of `GO_LIVE_STRINGS.preconditions`, so each has words). */
export type LivePrecondition = keyof typeof GO_LIVE_STRINGS.preconditions;

/** The preconditions in the order of the platform document (and of `details.missing`). */
export const LIVE_PRECONDITIONS = Object.freeze([
  "amadeus_live",
  "payments_live",
  "payout_account",
  "plan_live_mode",
  "subscription",
  "mfa",
] as const satisfies readonly LivePrecondition[]);

/** What the page knows of one precondition: met, missing, or not known before the API checks it. */
export type PreconditionState = "met" | "missing" | "unchecked";

/** The state of every precondition. */
export type PreconditionStates = Readonly<Record<LivePrecondition, PreconditionState>>;

/** `value` is a precondition the portal has words for. */
export function isLivePrecondition(value: unknown): value is LivePrecondition {
  return typeof value === "string" && (LIVE_PRECONDITIONS as readonly string[]).includes(value);
}

/**
 * The page that completes a precondition: the Amadeus page (a live office, or the OTA's own live credentials), the
 * payments page (the live payment mode), the payout account, billing (the plan and the subscription), and the
 * account's security page (two-factor sign-in, which is the account's, not the OTA's).
 */
export function preconditionHref(tenantId: string, precondition: LivePrecondition): string {
  switch (precondition) {
    case "amadeus_live":
      return otaPath(tenantId, "/amadeus");
    case "payments_live":
      return otaPath(tenantId, "/payments");
    case "payout_account":
      return otaPath(tenantId, "/payments/payout-account");
    case "plan_live_mode":
    case "subscription":
      return otaPath(tenantId, "/billing");
    case "mfa":
      return "/account/security";
  }
}

/** One item of `getOnboarding` as far as the checklist reads it. */
export interface OnboardingFact {
  readonly id: string;
  readonly done: boolean;
}

/** What the page knows before the first try. */
export interface KnownFacts {
  /** The signed-in owner's `mfaEnabled` (`getMe`): the `mfa` precondition is the caller's own. */
  readonly mfaEnabled: boolean;
  /** The items of `getOnboarding`, or `undefined` when it could not be read. */
  readonly onboarding: readonly OnboardingFact[] | undefined;
}

/**
 * The checklist before the first try, from what is certain only: `mfa` from the account (exactly what `goLive` reads
 * again), and `amadeus_live` missing when the onboarding item `live_requested` is not done, because that means the OTA
 * has no live Amadeus connection at all (PADR-0018: done once one exists in any status, or the OTA is live). Every
 * other onboarding item differs from its precondition (`payments_ready` reads the test connection, `plan_chosen` no
 * subscription id), so the rest wait for the API's answer.
 */
export function initialStates(facts: KnownFacts): PreconditionStates {
  const liveRequested = facts.onboarding?.find((item) => item.id === "live_requested");
  return {
    amadeus_live: liveRequested !== undefined && !liveRequested.done ? "missing" : "unchecked",
    payments_live: "unchecked",
    payout_account: "unchecked",
    plan_live_mode: "unchecked",
    subscription: "unchecked",
    mfa: facts.mfaEnabled ? "met" : "missing",
  };
}

/** What an answer of `goLive` says of the preconditions: each one it decided, met or missing. */
export type CheckedPreconditions = Readonly<Partial<Record<LivePrecondition, "met" | "missing">>>;

/**
 * The checklist after an answer: `LIVE_PRECONDITIONS_UNMET` decides all six (the ones in `details.missing` are missing,
 * every other one is met: the API checks them all), `MFA_REQUIRED` only `mfa`; what an answer does not decide keeps its
 * state.
 */
export function statesAfterAnswer(
  states: PreconditionStates,
  checked: CheckedPreconditions,
): PreconditionStates {
  const next: Record<LivePrecondition, PreconditionState> = { ...states };
  for (const precondition of LIVE_PRECONDITIONS) {
    const decided = checked[precondition];
    if (decided !== undefined) {
      next[precondition] = decided;
    }
  }
  return next;
}

/**
 * The answer of `422 LIVE_PRECONDITIONS_UNMET`: every precondition met or missing, and whether an unknown one is. Only
 * a list that names something decides: an answer without a list (or with an empty one) decides nothing, so no item
 * reads "Done" on the strength of an answer that said nothing about it.
 */
export function checkedFromMissing(missing: unknown): {
  readonly checked: CheckedPreconditions;
  readonly otherMissing: boolean;
} {
  const listed = Array.isArray(missing) ? (missing as unknown[]) : [];
  if (listed.length === 0) {
    return { checked: {}, otherMissing: true };
  }
  const checked: Partial<Record<LivePrecondition, "met" | "missing">> = {};
  for (const precondition of LIVE_PRECONDITIONS) {
    checked[precondition] = listed.includes(precondition) ? "missing" : "met";
  }
  // A precondition of a newer API: the page has no words for it, and it must not look as if everything were met.
  const otherMissing = listed.some((value) => !isLivePrecondition(value));
  return { checked, otherMissing };
}
