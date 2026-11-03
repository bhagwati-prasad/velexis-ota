"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { descriptorSuffixProblem } from "@/app/(app)/otas/[tenantId]/payments/descriptor-rules";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { otaPath } from "@/lib/roles";
import { stripeConnectCookie, writeCookies } from "@/lib/session";
import {
  DESCRIPTOR_STRINGS,
  ERROR_MESSAGES,
  STRIPE_ACCOUNT_STRINGS,
  STRIPE_KEYS_STRINGS,
  USE_VELEXIS_STRINGS,
} from "@/lib/strings";
import { ifMatchOf, isTenantId } from "@/lib/tenant";

/**
 * The server actions of the payments page (README §2 `/otas/[tenantId]/payments`; flows/stripe-payments-account.md §A
 * item 3 and §C to §E; PF-60 to PF-62): the card statement suffix (PFE-016, below), and Stripe Connect, the OTA's own
 * Stripe keys, their verification and the way back to Velexis payments (PFE-024, at the end of the module).
 *
 * `saveStatementDescriptor` checks the card statement descriptor suffix with the rules of
 * `descriptor-rules.ts` (the API's, through Zod), then calls `updatePaymentConnection` (`PATCH
 * /v1/tenants/{tenantId}/payment-connections/{environment}`) with the connection's version the form was rendered with in
 * `If-Match`, so a change someone else made in the meantime answers `412 PRECONDITION_FAILED` instead of being
 * overwritten. Owners and admins may call it; the API refuses other roles with `403` all the same. It returns the
 * portal's own text only, never the API's.
 */

type Environment = components["schemas"]["Environment"];

/** The body field of `updatePaymentConnection`, and the name of the form's field. */
const SUFFIX_FIELD = "statementDescriptorSuffix";

/** The JSON pointer of the suffix in the API's field errors. */
const SUFFIX_PATH = `/${SUFFIX_FIELD}`;

/**
 * The suffix field: trimmed, then refused with the portal's message of the first rule of `descriptor-rules.ts` it
 * breaks, the rules the browser applied before it sent the form.
 */
const DESCRIPTOR_SUFFIX = z
  .string()
  .trim()
  .superRefine((value, context) => {
    const problem = descriptorSuffixProblem(value);
    if (problem !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: DESCRIPTOR_STRINGS.problems[problem] });
    }
  });

/** A connection version as the form carries it (`PaymentConnection.version`, at least 1). */
const VERSION = /^[1-9][0-9]{0,14}$/;

const ENVIRONMENTS: readonly Environment[] = ["test", "live"];

function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

/** What the form shows after a submission. */
export interface DescriptorState {
  readonly status: "idle" | "saved" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  /** The connection version the next submission sends in `If-Match` (the saved one after a success). */
  readonly version: number;
  /** The suffix the field shows: the saved one after a success, what was sent after a failure. */
  readonly suffix: string;
  /** The problem of the suffix, in the portal's own words. */
  readonly fieldError?: string;
  /** A problem that belongs to no field (stale version, OTA not active, rate limit, API unavailable). */
  readonly message?: string;
  /** The page is out of date: the form offers "Reload the page" (a stale version, a lost role or connection). */
  readonly reload?: true;
}

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * The portal's message for each code of an API field error on the suffix: the request validation answers the JSON
 * Schema keyword (`minLength`, `maxLength`, `pattern`), the service the rule of descriptor.ts.
 */
const API_RULE_MESSAGES: Readonly<Record<string, string>> = {
  minLength: DESCRIPTOR_STRINGS.problems.minLength,
  maxLength: DESCRIPTOR_STRINGS.problems.maxLength,
  forbiddenCharacter: DESCRIPTOR_STRINGS.problems.forbiddenCharacter,
  characters: DESCRIPTOR_STRINGS.problems.characters,
  letter: DESCRIPTOR_STRINGS.problems.letter,
  start: DESCRIPTOR_STRINGS.problems.start,
};

/** The message of the API's first field error on the suffix, or `undefined` when none is about the suffix. */
function apiFieldError(error: ApiError): string | undefined {
  const fieldError = error.fieldErrors.find((candidate) => candidate.path === SUFFIX_PATH);
  if (fieldError === undefined) {
    return undefined;
  }
  return Object.hasOwn(API_RULE_MESSAGES, fieldError.code)
    ? API_RULE_MESSAGES[fieldError.code]
    : DESCRIPTOR_STRINGS.problems.rules;
}

/**
 * The messages of a failed `updatePaymentConnection` that belong to no field, and whether they ask for a reload.
 * `VALIDATION_FAILED` without an error on the suffix is a problem the person cannot fix (the `If-Match` header, the
 * path): the form is stale. Other codes get the portal's message for the code.
 */
const FAILURES: Readonly<Partial<Record<PlatformErrorCode, { message: string; reload?: true }>>> = {
  PRECONDITION_FAILED: { message: DESCRIPTOR_STRINGS.stale, reload: true },
  TENANT_NOT_ACTIVE: { message: DESCRIPTOR_STRINGS.notActive, reload: true },
  FORBIDDEN: { message: DESCRIPTOR_STRINGS.forbidden, reload: true },
  NOT_FOUND: { message: DESCRIPTOR_STRINGS.removed, reload: true },
  VALIDATION_FAILED: { message: DESCRIPTOR_STRINGS.formExpired, reload: true },
  RATE_LIMITED: { message: DESCRIPTOR_STRINGS.rateLimited },
};

/**
 * Saves the card statement descriptor suffix of one Velexis-mode payment connection from the form's field
 * `statementDescriptorSuffix`, with the hidden fields `tenantId`, `environment` and `version` (the `If-Match` version).
 * Returns the saved suffix and the connection's new version, or the problems; the payments page is revalidated after a
 * save, so its card shows the new suffix.
 */
export async function saveStatementDescriptor(
  previous: DescriptorState,
  formData: FormData,
): Promise<DescriptorState> {
  const suffix = text(formData, SUFFIX_FIELD);
  const tenantId = text(formData, "tenantId");
  const environment = text(formData, "environment");
  const version = text(formData, "version");
  const failed = (
    code: PlatformErrorCode,
    problem: { fieldError?: string; message?: string; reload?: true },
  ): DescriptorState => ({
    status: "failed",
    code,
    // A refused save changes nothing: the next one is checked against the same version.
    version: VERSION.test(version) ? Number(version) : previous.version,
    suffix,
    ...problem,
  });

  if (!isTenantId(tenantId) || !isEnvironment(environment) || !VERSION.test(version)) {
    // The form always carries all three; without them a save could not name its connection or version.
    return failed("VALIDATION_FAILED", { message: DESCRIPTOR_STRINGS.formExpired, reload: true });
  }
  const parsed = DESCRIPTOR_SUFFIX.safeParse(suffix);
  if (!parsed.success) {
    // The browser checks the same rules before it sends the form; this catches a form posted without them.
    return failed("VALIDATION_FAILED", {
      fieldError: parsed.error.issues[0]?.message ?? DESCRIPTOR_STRINGS.problems.rules,
    });
  }

  const api = await platformApi();
  const result = await api.PATCH("/v1/tenants/{tenantId}/payment-connections/{environment}", {
    params: { path: { tenantId, environment }, header: { "If-Match": ifMatchOf(Number(version)) } },
    body: { statementDescriptorSuffix: parsed.data },
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      // The session ended (the middleware renews an access token that is only expired): sign in again.
      redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/payments") }).toString()}`);
    }
    if (code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-pending");
    }
    const fieldError = code === "VALIDATION_FAILED" ? apiFieldError(result.error) : undefined;
    if (fieldError !== undefined) {
      return failed(code, { fieldError });
    }
    return failed(code, FAILURES[code] ?? { message: errorMessage(result.error) });
  }

  // The card shows the saved suffix: render the page again.
  revalidatePath(otaPath(tenantId, "/payments"));
  return {
    status: "saved",
    version: result.data.version,
    suffix: result.data.statementDescriptorSuffix ?? parsed.data,
  };
}

// ---- Stripe Connect, own Stripe keys and Velexis payments (PFE-024) -----------------------------------------------

/**
 * `connectStripe`, `submitStripeKeys`, `getKeysSubmissionStatus` and `switchToVelexis` (PFE-024; flows/stripe-payments-
 * account.md §C to §E; PF-61, PF-62). Each refuses a form or an id it cannot name a resource with without a call, calls
 * the API with the session and the end-user headers, sends an ended session to sign-in and back to the payments page
 * and an unverified account to `/verify-pending`, and answers the portal's own text only, never the API's.
 *
 * - `connectStripe` (`startStripeConnect`, owners and admins, behind a TOTP step-up: `REAUTH_REQUIRED` answers
 *   `stepUp`, and `useStepUpAction` sends the same form again after the code). The answer's `authorizeUrl` must be
 *   Stripe's authorize page (`https://connect.stripe.com/oauth/authorize?…`, the document's pattern) without
 *   credentials or a fragment; anything else is never followed. The action then sets the Stripe Connect cookie (the
 *   OTA's id, not a secret: Stripe's redirect back names no OTA, and a refused callback returns to this page with it)
 *   and ends with `redirect()` to that URL, which the router follows as a top-level navigation (README §7: the policy
 *   restricts frames and form posts, not navigations). The URL is the API's, never one built here, and it holds the
 *   single-use state, so it is neither logged nor put anywhere else.
 * - `submitStripeKeys` (`submitStripeApiKeys`, owners and admins, behind a step-up): the publishable key, the secret or
 *   restricted key and the webhook signing secret of one environment, each trimmed at its ends and checked with the
 *   document's patterns and the API's environment rule. The secret key and the webhook secret go to the API and
 *   nowhere else: never logged, never put in the state the action returns (which holds only the publishable key, not
 *   a secret) and never rendered. `202` answers the submission to follow and the webhook endpoint to create in Stripe.
 * - `getKeysSubmissionStatus` (`getCredentialSubmission`, owners and admins): what the keys form polls every 2 seconds;
 *   a final answer (`applied`, `failed`, `superseded`) revalidates the page, so the card shows the account in use.
 * - `switchToVelexis` (`useVelexisPayments`, owners, behind a step-up, after the page's confirmation): the connection of
 *   one environment returns to the Velexis Stripe account; payments taken before keep the account they were taken
 *   with. `PAYOUT_ACCOUNT_REQUIRED` (live) links to the payout account page.
 */

type CredentialSubmission = components["schemas"]["CredentialSubmission"];

/**
 * A submission as the portal shows it: its id, status and verification result. The API's `errorMessage` stays on the
 * server (the portal shows its own words for `errorCode`), and the submission never holds a secret.
 */
export type KeysSubmissionView = Pick<CredentialSubmission, "id" | "status" | "errorCode">;

/** A credential submission id (`CredentialSubmissionId` of the platform document: `crs_` + ULID). */
const SUBMISSION_ID = /^crs_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The statuses after which a submission changes no more (`CredentialSubmission.status`). */
const FINAL_SUBMISSION_STATUSES: readonly string[] = ["applied", "failed", "superseded"];

/** `details.reason` of a refusal, when the API sent one. */
function reasonOf(error: ApiError): unknown {
  return error.details["reason"];
}

/**
 * Ends the request when the session is over: sign in again and come back to the payments page (the middleware renews
 * an access token that is only expired); an unverified account goes to `/verify-pending`.
 */
function leaveOnSessionEnd(error: ApiError, tenantId: string): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/payments") }).toString()}`);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
}

// ---- Stripe Connect -----------------------------------------------------------------------------------------------

/** What the "Connect Stripe" form shows after an attempt that did not leave for Stripe. */
export interface ConnectState {
  readonly status: "idle" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  readonly message?: string;
  /** The page is out of date: the form offers "Reload the page". */
  readonly reload?: true;
  /** The API asked for a step-up (`REAUTH_REQUIRED`): `useStepUpAction` opens the dialog. */
  readonly stepUp?: true;
}

type ConnectProblem = Pick<ConnectState, "message" | "reload" | "stepUp">;

/** The portal's message for each code of a refused `startStripeConnect`. */
const CONNECT_FAILURES: Readonly<Partial<Record<PlatformErrorCode, ConnectProblem>>> = {
  // Shown when the person cancels the step-up dialog that opens now.
  REAUTH_REQUIRED: { message: STRIPE_ACCOUNT_STRINGS.stepUpCancelled, stepUp: true },
  MFA_REQUIRED: { message: STRIPE_ACCOUNT_STRINGS.mfaRequired },
  FEATURE_DISABLED: { message: STRIPE_ACCOUNT_STRINGS.featureDisabled, reload: true },
  TENANT_NOT_ACTIVE: { message: STRIPE_ACCOUNT_STRINGS.notActive, reload: true },
  FORBIDDEN: { message: STRIPE_ACCOUNT_STRINGS.forbidden, reload: true },
  NOT_FOUND: { message: STRIPE_ACCOUNT_STRINGS.removed, reload: true },
  VALIDATION_FAILED: { message: STRIPE_ACCOUNT_STRINGS.formExpired, reload: true },
  RATE_LIMITED: { message: STRIPE_ACCOUNT_STRINGS.rateLimited },
  // Redis, where the state lives, is down.
  SERVICE_UNAVAILABLE: { message: STRIPE_ACCOUNT_STRINGS.unavailable },
};

/** Stripe's Connect OAuth authorize page (`StripeConnectStart.authorizeUrl`: `^https://connect\.stripe\.com/oauth/authorize\?`). */
const STRIPE_AUTHORIZE_ORIGIN = "https://connect.stripe.com";
const STRIPE_AUTHORIZE_PATH = "/oauth/authorize";

/**
 * The authorize URL of the answer, when it is Stripe's authorize page with a query and without credentials or a
 * fragment; `undefined` otherwise, and the browser is not sent anywhere.
 */
function authorizeUrlOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(`${STRIPE_AUTHORIZE_ORIGIN}${STRIPE_AUTHORIZE_PATH}?`)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const clean =
    url.origin === STRIPE_AUTHORIZE_ORIGIN &&
    url.pathname === STRIPE_AUTHORIZE_PATH &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    url.search.length > 1;
  return clean ? url.href : undefined;
}

/**
 * Starts connecting the OTA's own Stripe account (`POST /v1/tenants/{tenantId}/payment-connections/stripe-connect/
 * start`) from the "Connect Stripe" form (the hidden field `tenantId`), and sends the browser to Stripe. Returns only
 * when the start was refused.
 */
export async function connectStripe(_previous: ConnectState, formData: FormData): Promise<ConnectState> {
  const tenantId = text(formData, "tenantId");
  const failed = (code: PlatformErrorCode, problem: ConnectProblem): ConnectState => ({
    status: "failed",
    code,
    ...problem,
  });
  if (!isTenantId(tenantId)) {
    return failed("VALIDATION_FAILED", { message: STRIPE_ACCOUNT_STRINGS.formExpired, reload: true });
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/payment-connections/stripe-connect/start", {
    params: { path: { tenantId } },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    return failed(
      result.error.code,
      CONNECT_FAILURES[result.error.code] ?? { message: errorMessage(result.error) },
    );
  }
  const authorizeUrl = authorizeUrlOf(result.data.authorizeUrl);
  if (authorizeUrl === undefined) {
    return failed("INTERNAL_ERROR", { message: STRIPE_ACCOUNT_STRINGS.invalidAnswer });
  }
  // The callback reads it to find this OTA's payments page when Stripe or the API refuses the connection.
  writeCookies(await cookies(), [stripeConnectCookie(tenantId)]);
  redirect(authorizeUrl);
}

// ---- Own Stripe keys ----------------------------------------------------------------------------------------------

/** The fields of the keys form. */
export type StripeKeysField = "publishableKey" | "secretKey" | "webhookSecret";

/** The webhook endpoint the OTA creates in its Stripe dashboard, as `submitStripeApiKeys` answered it. */
export interface WebhookSetup {
  readonly url: string;
  readonly events: readonly string[];
}

/** What the keys form shows after a submission. Never holds the secret key or the webhook secret. */
export interface StripeKeysState {
  readonly status: "idle" | "submitted" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  /** The publishable key as sent (not a secret: the storefront's browser uses it), so the form shows it again. */
  readonly publishableKey: string;
  /** Messages per field, in the portal's own words. */
  readonly fieldErrors: Readonly<Partial<Record<StripeKeysField, string>>>;
  /** A problem that belongs to no field. */
  readonly message?: string;
  /** The page is out of date: the form offers "Reload the page". */
  readonly reload?: true;
  /** The API asked for a step-up (`REAUTH_REQUIRED`): `useStepUpAction` opens the dialog. */
  readonly stepUp?: true;
  /** The submission the API accepted (`202`), which the form follows until it is final. */
  readonly submission?: KeysSubmissionView;
  /** The webhook endpoint to create in Stripe, from the same answer. */
  readonly webhook?: WebhookSetup;
}

/** `SubmitStripeApiKeysRequest`: every key at most 255 characters. */
const KEY_MAX = 255;
/** The webhook signing secret: the document's `^whsec_[A-Za-z0-9_-]+$` and the API's 8 characters at least. */
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9_-]{8,}$/;
/** `StripeApiKeysSubmitted.webhookUrl`: the OTA backend's receiver of one connection. */
const WEBHOOK_PATH = /^\/webhooks\/stripe\/c\/ppc_[0-9A-HJKMNP-TV-Z]{26}$/;
/** `StripeApiKeysSubmitted.webhookEvents` items. */
const WEBHOOK_EVENT = /^[a-z_]+(\.[a-z_]+)+$/;

const KEYS = STRIPE_KEYS_STRINGS;

/** The problem of each key of the form, in its order; the secret values are checked, never kept or put in a message. */
function keyProblems(
  environment: Environment,
  values: Readonly<Record<StripeKeysField, string>>,
): Partial<Record<StripeKeysField, string>> {
  const problems: Partial<Record<StripeKeysField, string>> = {};
  const { publishableKey, secretKey, webhookSecret } = values;
  if (publishableKey === "") {
    problems.publishableKey = KEYS.problems.publishableKeyRequired;
  } else if (publishableKey.length > KEY_MAX) {
    problems.publishableKey = KEYS.problems.tooLong;
  } else if (!new RegExp(`^pk_${environment}_[A-Za-z0-9]+$`).test(publishableKey)) {
    problems.publishableKey = KEYS.problems.publishableKey(environment);
  }
  if (secretKey === "") {
    problems.secretKey = KEYS.problems.secretKeyRequired;
  } else if (secretKey.length > KEY_MAX) {
    problems.secretKey = KEYS.problems.tooLong;
  } else if (!new RegExp(`^(sk|rk)_${environment}_[A-Za-z0-9]+$`).test(secretKey)) {
    problems.secretKey = KEYS.problems.secretKey(environment);
  }
  if (webhookSecret === "") {
    problems.webhookSecret = KEYS.problems.webhookSecretRequired;
  } else if (webhookSecret.length > KEY_MAX) {
    problems.webhookSecret = KEYS.problems.tooLong;
  } else if (!WEBHOOK_SECRET.test(webhookSecret)) {
    problems.webhookSecret = KEYS.problems.webhookSecret;
  }
  return problems;
}

/** The form field of each JSON pointer of the API's field errors. */
const KEY_POINTERS: Readonly<Record<string, StripeKeysField>> = {
  "/publishableKey": "publishableKey",
  "/secretKey": "secretKey",
  "/webhookSecret": "webhookSecret",
};

/**
 * The API's field errors on the form's fields (the first per field), in the portal's words: `maxLength` says the value
 * is too long, every other rule (the document's `pattern`, the service's `environment`) the field's format. Empty when
 * none is about a field of the form.
 */
function apiKeyProblems(error: ApiError, environment: Environment): Partial<Record<StripeKeysField, string>> {
  const messages: Readonly<Record<StripeKeysField, string>> = {
    publishableKey: KEYS.problems.publishableKey(environment),
    secretKey: KEYS.problems.secretKey(environment),
    webhookSecret: KEYS.problems.webhookSecret,
  };
  const problems: Partial<Record<StripeKeysField, string>> = {};
  for (const fieldError of error.fieldErrors) {
    const field = Object.hasOwn(KEY_POINTERS, fieldError.path) ? KEY_POINTERS[fieldError.path] : undefined;
    if (field !== undefined) {
      problems[field] ??= fieldError.code === "maxLength" ? KEYS.problems.tooLong : messages[field];
    }
  }
  return problems;
}

type KeysProblem = Pick<StripeKeysState, "message" | "reload" | "stepUp">;

/** The portal's message for each code of a refused `submitStripeApiKeys` that is about no field. */
const KEYS_FAILURES: Readonly<Partial<Record<PlatformErrorCode, KeysProblem>>> = {
  // Shown when the person cancels the step-up dialog that opens now.
  REAUTH_REQUIRED: { message: KEYS.stepUpCancelled, stepUp: true },
  MFA_REQUIRED: { message: KEYS.mfaRequired },
  FEATURE_DISABLED: { message: KEYS.featureDisabled, reload: true },
  TENANT_NOT_ACTIVE: { message: KEYS.notActive, reload: true },
  FORBIDDEN: { message: KEYS.forbidden, reload: true },
  NOT_FOUND: { message: KEYS.removed, reload: true },
  // A field error on nothing the form sent (the path): a form the person cannot fix.
  VALIDATION_FAILED: { message: KEYS.formExpired, reload: true },
  RATE_LIMITED: { message: KEYS.rateLimited },
};

/** The portal's message for a refused `submitStripeApiKeys` that is about no field. */
function keysFailure(error: ApiError): KeysProblem {
  if (error.code === "CONFLICT") {
    // A platform admin disabled the connection (lead decision of 2026-11-02, (2i)): nothing was written.
    return reasonOf(error) === "connection_disabled"
      ? { message: KEYS.connectionDisabled }
      : { message: ERROR_MESSAGES.CONFLICT, reload: true };
  }
  return KEYS_FAILURES[error.code] ?? { message: errorMessage(error) };
}

/**
 * The webhook endpoint of the answer: a URL of the OTA backend's receiver of one connection (no credentials, query or
 * fragment) and the events to enable. `undefined` for a URL of another shape, which is never shown.
 */
function webhookSetupOf(url: unknown, events: unknown): WebhookSetup | undefined {
  if (typeof url !== "string") {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const clean =
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    WEBHOOK_PATH.test(parsed.pathname);
  if (!clean) {
    return undefined;
  }
  const names = Array.isArray(events)
    ? events.filter((event): event is string => typeof event === "string" && WEBHOOK_EVENT.test(event))
    : [];
  return { url: parsed.href, events: names };
}

/**
 * Submits the OTA's own Stripe keys for one environment (`PUT /v1/tenants/{tenantId}/payment-connections/{environment}/
 * api-keys`) from the keys form (the hidden fields `tenantId` and `environment`). `202` answers the submission to follow
 * and the webhook endpoint, and revalidates the page, so the card shows that keys are being verified; the connection
 * itself changes only once Stripe accepted them.
 */
export async function submitStripeKeys(
  previous: StripeKeysState,
  formData: FormData,
): Promise<StripeKeysState> {
  const tenantId = text(formData, "tenantId");
  const environment = text(formData, "environment");
  const publishableKey = text(formData, "publishableKey").trim();
  const failed = (
    code: PlatformErrorCode,
    problem: KeysProblem & { readonly fieldErrors?: Partial<Record<StripeKeysField, string>> },
  ): StripeKeysState => ({
    status: "failed",
    code,
    publishableKey,
    fieldErrors: problem.fieldErrors ?? {},
    ...(problem.message === undefined ? {} : { message: problem.message }),
    ...(problem.reload === undefined ? {} : { reload: problem.reload }),
    ...(problem.stepUp === undefined ? {} : { stepUp: problem.stepUp }),
    // A refused submission leaves the one being verified (if any), and its webhook endpoint, as they were.
    ...(previous.submission === undefined ? {} : { submission: previous.submission }),
    ...(previous.webhook === undefined ? {} : { webhook: previous.webhook }),
  });

  if (!isTenantId(tenantId) || !isEnvironment(environment)) {
    // The form always carries both; without them a submission could not name its connection.
    return failed("VALIDATION_FAILED", { message: KEYS.formExpired, reload: true });
  }
  // The secrets are read here and passed to the API; no other line of the portal holds them.
  const secretKey = text(formData, "secretKey").trim();
  const webhookSecret = text(formData, "webhookSecret").trim();
  const problems = keyProblems(environment, { publishableKey, secretKey, webhookSecret });
  if (Object.keys(problems).length > 0) {
    return failed("VALIDATION_FAILED", { fieldErrors: problems });
  }

  const api = await platformApi();
  const result = await api.PUT("/v1/tenants/{tenantId}/payment-connections/{environment}/api-keys", {
    params: { path: { tenantId, environment } },
    body: { publishableKey, secretKey, webhookSecret },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    const fieldErrors =
      result.error.code === "VALIDATION_FAILED" ? apiKeyProblems(result.error, environment) : {};
    if (Object.keys(fieldErrors).length > 0) {
      return failed(result.error.code, { fieldErrors });
    }
    return failed(result.error.code, keysFailure(result.error));
  }

  const { id, status, errorCode } = result.data.submission;
  const webhook = webhookSetupOf(result.data.webhookUrl, result.data.webhookEvents);
  // The card shows the keys being verified; the connection keeps its account until Stripe accepted them.
  revalidatePath(otaPath(tenantId, "/payments"));
  return {
    status: "submitted",
    publishableKey,
    fieldErrors: {},
    submission: { id, status, errorCode },
    ...(webhook === undefined ? {} : { webhook }),
  };
}

// ---- The verification ---------------------------------------------------------------------------------------------

/** The answer of one read of a submission. */
export type KeysSubmissionPoll =
  | { readonly status: "ok"; readonly submission: KeysSubmissionView }
  | {
      readonly status: "failed";
      /** The error code, for tests; never shown. */
      readonly code: PlatformErrorCode;
      readonly message: string;
      /** The read may work when tried again (rate limit, API unavailable): polling goes on. */
      readonly transient: boolean;
      /** The wait of `Retry-After`, when the API sent one. */
      readonly retryAfterSeconds?: number;
    };

/** Read failures that may pass: polling goes on. */
const TRANSIENT_POLL_CODES: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

/**
 * Reads a submission of the OTA's own Stripe keys (`GET /v1/tenants/{tenantId}/credential-submissions/{submissionId}`)
 * for the keys form. Ids that are none answer `NOT_FOUND` without a call. A final status revalidates the payments page,
 * so the card shows the account the connection uses now.
 */
export async function getKeysSubmissionStatus(
  tenantId: unknown,
  submissionId: unknown,
): Promise<KeysSubmissionPoll> {
  if (!isTenantId(tenantId) || typeof submissionId !== "string" || !SUBMISSION_ID.test(submissionId)) {
    return { status: "failed", code: "NOT_FOUND", message: errorMessage("NOT_FOUND"), transient: false };
  }
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/credential-submissions/{submissionId}", {
    params: { path: { tenantId, submissionId } },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    const { code, retryAfterSeconds } = result.error;
    return {
      status: "failed",
      code,
      message: errorMessage(result.error),
      transient: TRANSIENT_POLL_CODES.has(code),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }
  const { id, status, errorCode } = result.data;
  if (FINAL_SUBMISSION_STATUSES.includes(status)) {
    // The card shows the account the connection uses now, or the one it kept.
    revalidatePath(otaPath(tenantId, "/payments"));
  }
  return { status: "ok", submission: { id, status, errorCode } };
}

// ---- Back to Velexis payments -------------------------------------------------------------------------------------

/** What "Use Velexis payments" shows after an attempt. */
export interface UseVelexisState {
  readonly status: "idle" | "switched" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  readonly message?: string;
  /** The page is out of date: "Reload the page". */
  readonly reload?: true;
  /** The API asked for a step-up (`REAUTH_REQUIRED`): `useStepUpAction` opens the dialog. */
  readonly stepUp?: true;
  /** The live connection needs a verified payout account (`PAYOUT_ACCOUNT_REQUIRED`): link to its page. */
  readonly payoutAccount?: true;
}

type UseVelexisProblem = Pick<UseVelexisState, "message" | "reload" | "stepUp" | "payoutAccount">;

/** The portal's message for each code of a refused `useVelexisPayments`. */
const USE_VELEXIS_FAILURES: Readonly<Partial<Record<PlatformErrorCode, UseVelexisProblem>>> = {
  // Shown when the person cancels the step-up dialog that opens now.
  REAUTH_REQUIRED: { message: USE_VELEXIS_STRINGS.stepUpCancelled, stepUp: true },
  MFA_REQUIRED: { message: USE_VELEXIS_STRINGS.mfaRequired },
  PAYOUT_ACCOUNT_REQUIRED: { message: USE_VELEXIS_STRINGS.payoutAccountRequired, payoutAccount: true },
  TENANT_NOT_ACTIVE: { message: USE_VELEXIS_STRINGS.notActive, reload: true },
  FORBIDDEN: { message: USE_VELEXIS_STRINGS.forbidden, reload: true },
  NOT_FOUND: { message: USE_VELEXIS_STRINGS.removed, reload: true },
  VALIDATION_FAILED: { message: USE_VELEXIS_STRINGS.formExpired, reload: true },
  RATE_LIMITED: { message: USE_VELEXIS_STRINGS.rateLimited },
};

/**
 * Returns the payment connection of one environment to the Velexis Stripe account (`POST /v1/tenants/{tenantId}/
 * payment-connections/{environment}/use-velexis`), with the fields `tenantId` and `environment`. A switch revalidates
 * the page, so the card shows the Velexis account.
 */
export async function switchToVelexis(
  _previous: UseVelexisState,
  formData: FormData,
): Promise<UseVelexisState> {
  const tenantId = text(formData, "tenantId");
  const environment = text(formData, "environment");
  const failed = (code: PlatformErrorCode, problem: UseVelexisProblem): UseVelexisState => ({
    status: "failed",
    code,
    ...problem,
  });
  if (!isTenantId(tenantId) || !isEnvironment(environment)) {
    return failed("VALIDATION_FAILED", { message: USE_VELEXIS_STRINGS.formExpired, reload: true });
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/payment-connections/{environment}/use-velexis", {
    params: { path: { tenantId, environment } },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    return failed(
      result.error.code,
      USE_VELEXIS_FAILURES[result.error.code] ?? { message: errorMessage(result.error) },
    );
  }
  // The card shows the Velexis account and its statement suffix form.
  revalidatePath(otaPath(tenantId, "/payments"));
  return { status: "switched" };
}
