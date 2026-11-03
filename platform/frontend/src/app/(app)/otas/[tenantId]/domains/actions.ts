"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { otaPath } from "@/lib/roles";
import { DOMAINS_STRINGS } from "@/lib/strings";
import { isTenantId } from "@/lib/tenant";

/**
 * The server actions of the domains page (README §2 `/otas/[tenantId]/domains` and §5; flows/custom-domains.md; PF-41):
 * `addDomain` (`addDomain`: a custom storefront domain, answered with the DNS records to create) and `changeDomain`
 * ("Check now" through `checkDomain`, "Make primary" through `makeDomainPrimary`, "Remove" through `removeDomain`).
 * Owners and admins may call them; the API refuses other roles all the same. None needs a step-up.
 *
 * Each checks what it sends first, calls the API with the session and the end-user headers (`platformApi()`), and
 * revalidates the page after a change, so its list shows the domains as they are now. An ended session goes to sign-in
 * and back to the domains page. Messages are the portal's own text, never the API's: a host name the API refuses
 * (`DOMAIN_INVALID`, `DOMAIN_TAKEN`) shows at the field, `FEATURE_DISABLED` (the switch is off or the plan has no custom
 * domains) answers `upgrade` so the page shows the upgrade hint, and `checkDomain`'s rate limit (one check per domain
 * per minute) says when to try again.
 */

type Schemas = components["schemas"];

/** A storefront domain as the API answers it. */
export type Domain = Schemas["Domain"];

/** The state of the add form. */
export interface AddDomainState {
  readonly status: "idle" | "added" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  /** The host name as typed: kept after a failure, empty after the domain was added. */
  readonly hostname: string;
  /** The problem of the host name field. */
  readonly fieldError?: string;
  /** A problem that belongs to no field. */
  readonly message?: string;
  /** The new domain with the DNS records to create (`dnsRecords`), after it was added. */
  readonly domain?: Domain;
  /** `FEATURE_DISABLED`: custom domains are off or not in the plan; the form gives way to the upgrade hint. */
  readonly upgrade?: true;
}

/** What `changeDomain` does: "Check now", "Make primary" or "Remove". */
export type DomainIntent = "check" | "makePrimary" | "remove";

/** The state of the domain actions: the outcome of the last one, shown above the domains. */
export interface DomainActionState {
  readonly status: "idle" | "done" | "failed";
  /** The action and the domain the outcome is about. */
  readonly intent?: DomainIntent;
  readonly domainId?: string;
  readonly code?: PlatformErrorCode;
  /** What happened, or why it did not, in the portal's words. */
  readonly message?: string;
  /** `FEATURE_DISABLED`: custom domains are off or not in the plan; the page shows the upgrade hint. */
  readonly upgrade?: true;
  /** The message asks for a reload (the check's result, or a page that is out of date): the notice links to it. */
  readonly reload?: true;
}

/** Refusals of a domain action whose message asks for a reload: the page no longer shows the domain as it is. */
const RELOAD_CODES: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "CONFLICT",
  "DOMAIN_NOT_VERIFIED",
  "FORBIDDEN",
  "NOT_FOUND",
  "TENANT_NOT_ACTIVE",
]);

/** A domain id (`DomainId` of the platform document: `dom_` + ULID). */
const DOMAIN_ID = /^dom_[0-9A-HJKMNP-TV-Z]{26}$/;

/** `AddDomainRequest.hostname`: at most 254 characters (253 and a trailing dot), counted in code points. */
const HOSTNAME_MAX = 253;

/**
 * Something that is no host name at all: a URL (a scheme, a path, a port, credentials) or a text with spaces. The
 * rest of the host name rules (labels, IDN, Velexis and shared hosting hosts) is the API's (`DOMAIN_INVALID`).
 */
const NOT_A_HOST = /[\s/:@?#\\]/u;

const INTENTS: readonly DomainIntent[] = ["check", "makePrimary", "remove"];

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function isIntent(value: string): value is DomainIntent {
  return (INTENTS as readonly string[]).includes(value);
}

/** The problem of a typed host name before any call, or `undefined` when the API should judge it. */
function hostnameProblem(hostname: string): string | undefined {
  if (hostname === "") {
    return DOMAINS_STRINGS.hostnameRequired;
  }
  if (NOT_A_HOST.test(hostname)) {
    return DOMAINS_STRINGS.hostnameNotHost;
  }
  // A trailing dot is allowed (the API drops it), so the limit counts without it.
  return [...hostname.replace(/\.$/u, "")].length > HOSTNAME_MAX
    ? DOMAINS_STRINGS.hostnameTooLong
    : undefined;
}

/**
 * Ends the request when the session is over: sign in again and come back to the domains page; an unverified account
 * goes to `/verify-pending` (the middleware renews an access token that is only expired).
 */
function leaveOnSessionEnd(error: ApiError, tenantId: string): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/domains") }).toString()}`);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
}

/** Renders the domains page again, so its list shows the change. */
function refreshDomains(tenantId: string): void {
  revalidatePath(otaPath(tenantId, "/domains"));
}

/** A whole number of `details`, or `undefined`. */
function detailNumber(error: ApiError, name: string): number | undefined {
  const value = error.details[name];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Messages of failures common to every domain operation; other codes get the portal's message for the code. */
const FAILURE_MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  TENANT_NOT_ACTIVE: DOMAINS_STRINGS.notActive,
  FORBIDDEN: DOMAINS_STRINGS.forbidden,
  NOT_FOUND: DOMAINS_STRINGS.removedMeanwhile,
  RATE_LIMITED: DOMAINS_STRINGS.rateLimited,
  VALIDATION_FAILED: DOMAINS_STRINGS.formExpired,
};

function failureMessage(error: ApiError): string {
  return FAILURE_MESSAGES[error.code] ?? errorMessage(error);
}

/**
 * Adds a custom domain (`addDomain`) from the field `hostname` with the hidden `tenantId`, and answers the new domain
 * with the DNS records to create (PF-41 AC1). The API normalises the host name (lower case, punycode, no trailing dot)
 * and judges it; the portal only refuses what is no host name at all.
 */
export async function addDomain(_previous: AddDomainState, formData: FormData): Promise<AddDomainState> {
  const tenantId = text(formData, "tenantId");
  const hostname = text(formData, "hostname").trim();
  if (!isTenantId(tenantId)) {
    // The form always carries it.
    return { status: "failed", code: "VALIDATION_FAILED", hostname, message: DOMAINS_STRINGS.formExpired };
  }
  const problem = hostnameProblem(hostname);
  if (problem !== undefined) {
    return { status: "failed", code: "VALIDATION_FAILED", hostname, fieldError: problem };
  }

  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/domains", {
    params: { path: { tenantId } },
    body: { hostname },
  });
  if (result.error !== undefined) {
    const { error } = result;
    leaveOnSessionEnd(error, tenantId);
    const failed = { status: "failed", code: error.code, hostname } as const;
    if (error.code === "DOMAIN_INVALID") {
      return { ...failed, fieldError: DOMAINS_STRINGS.hostnameInvalid };
    }
    if (error.code === "DOMAIN_TAKEN") {
      return { ...failed, fieldError: DOMAINS_STRINGS.hostnameTaken };
    }
    if (error.code === "VALIDATION_FAILED") {
      // `/hostname` is the only field the form sends: anything else means the form has expired.
      return error.fieldErrors.some((fieldError) => fieldError.path === "/hostname")
        ? { ...failed, fieldError: DOMAINS_STRINGS.hostnameInvalid }
        : { ...failed, message: DOMAINS_STRINGS.formExpired };
    }
    if (error.code === "PLAN_LIMIT_REACHED") {
      return { ...failed, message: DOMAINS_STRINGS.planLimit(detailNumber(error, "limit")) };
    }
    return error.code === "FEATURE_DISABLED"
      ? { ...failed, upgrade: true }
      : { ...failed, message: failureMessage(error) };
  }
  refreshDomains(tenantId);
  return { status: "added", hostname: "", domain: result.data };
}

/** The message of a refused "Check now" (`checkDomain`). */
function checkFailure(error: ApiError): string {
  if (error.code === "RATE_LIMITED") {
    return DOMAINS_STRINGS.checkRateLimited(error.retryAfterSeconds);
  }
  if (error.code === "CONFLICT") {
    return error.details["reason"] === "subdomain"
      ? DOMAINS_STRINGS.subdomainConflict
      : DOMAINS_STRINGS.alreadyVerified;
  }
  return failureMessage(error);
}

/** The message of a refused "Make primary" (`makeDomainPrimary`). */
function makePrimaryFailure(error: ApiError): string {
  return error.code === "DOMAIN_NOT_VERIFIED" ? DOMAINS_STRINGS.notVerified : failureMessage(error);
}

/** The message of a refused "Remove" (`removeDomain`). */
function removeFailure(error: ApiError): string {
  return error.code === "CONFLICT" && error.details["reason"] === "subdomain"
    ? DOMAINS_STRINGS.subdomainConflict
    : failureMessage(error);
}

const FAILURES: Readonly<Record<DomainIntent, (error: ApiError) => string>> = {
  check: checkFailure,
  makePrimary: makePrimaryFailure,
  remove: removeFailure,
};

/**
 * The state of a refused action: the upgrade hint for `FEATURE_DISABLED`, otherwise the action's words, with the
 * reload link when the page no longer shows the domain as it is.
 */
function refused(intent: DomainIntent, domainId: string, error: ApiError): DomainActionState {
  const failed = { status: "failed", intent, domainId, code: error.code } as const;
  if (error.code === "FEATURE_DISABLED") {
    return { ...failed, upgrade: true };
  }
  const message = FAILURES[intent](error);
  return RELOAD_CODES.has(error.code) && message !== DOMAINS_STRINGS.subdomainConflict
    ? { ...failed, message, reload: true }
    : { ...failed, message };
}

/**
 * One action on a domain, from the field `intent` (`check`, `makePrimary`, `remove`) with the hidden `tenantId` and
 * `domainId`, plus `hostname` and `verificationStatus` for the words of the outcome (the API's answer names the host
 * where it has one):
 *
 * - `check`: `checkDomain` queues the DNS check of a pending or failed custom domain (a failed one first gets a new
 *   72-hour window); its result shows in the list within a minute.
 * - `makePrimary`: `makeDomainPrimary` makes a verified domain the primary storefront host (the sub-domain always may
 *   be made primary again).
 * - `remove`: `removeDomain` deletes a custom domain (the page asks first with `ConfirmDialog`).
 */
export async function changeDomain(
  _previous: DomainActionState,
  formData: FormData,
): Promise<DomainActionState> {
  const tenantId = text(formData, "tenantId");
  const domainId = text(formData, "domainId");
  const intent = text(formData, "intent");
  const typed = text(formData, "hostname");
  if (!isTenantId(tenantId) || !DOMAIN_ID.test(domainId) || !isIntent(intent)) {
    return { status: "failed", code: "VALIDATION_FAILED", message: DOMAINS_STRINGS.formExpired };
  }
  // The host name only words the outcome; a form that carries none (or no host name) reads as "The domain".
  const hostname = typed !== "" && [...typed].length <= HOSTNAME_MAX ? typed : DOMAINS_STRINGS.theDomain;
  const target = { tenantId, domainId };
  const api = await platformApi();

  if (intent === "check") {
    const result = await api.POST("/v1/tenants/{tenantId}/domains/{domainId}/check", {
      params: { path: target },
    });
    if (result.error !== undefined) {
      leaveOnSessionEnd(result.error, tenantId);
      return refused(intent, domainId, result.error);
    }
    refreshDomains(tenantId);
    const restarted = text(formData, "verificationStatus") === "failed";
    return {
      status: "done",
      intent,
      domainId,
      message: restarted
        ? DOMAINS_STRINGS.checkRestarted(result.data.hostname)
        : DOMAINS_STRINGS.checkStarted(result.data.hostname),
      // The check's result shows in the list once the worker has run it: the notice links to a reload.
      reload: true,
    };
  }

  if (intent === "makePrimary") {
    const result = await api.POST("/v1/tenants/{tenantId}/domains/{domainId}/make-primary", {
      params: { path: target },
    });
    if (result.error !== undefined) {
      leaveOnSessionEnd(result.error, tenantId);
      return refused(intent, domainId, result.error);
    }
    refreshDomains(tenantId);
    // The OTA backend links a primary custom domain only once its certificate is issued (FIX-W38-OTA).
    const waitsForCertificate = result.data.kind === "custom" && result.data.tlsStatus !== "issued";
    return {
      status: "done",
      intent,
      domainId,
      message: DOMAINS_STRINGS.primaryDone(result.data.hostname, waitsForCertificate),
    };
  }

  const result = await api.DELETE("/v1/tenants/{tenantId}/domains/{domainId}", { params: { path: target } });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    return refused(intent, domainId, result.error);
  }
  refreshDomains(tenantId);
  return { status: "done", intent, domainId, message: DOMAINS_STRINGS.removedDone(hostname) };
}
