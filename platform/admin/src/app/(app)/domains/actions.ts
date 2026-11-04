"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  DOMAIN_ACTION_STRINGS as S,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  REASON_STRINGS,
} from "@/lib/strings";

/**
 * The server actions of `/domains` (README §2 and §4; flows/custom-domains.md step 8; flows/platform-admin-operations.md
 * §G; PADR-0004; PF-92): check a storefront host now (`adminRecheckDomain`: the DNS check its status calls for and the
 * TLS probe, queued at once) and remove an abusive custom domain of any OTA (`adminRemoveDomain`, **reason**).
 *
 * Every action checks its form with Zod before it calls the platform API, so made-up fields send nothing. An ended
 * session goes to `/sign-in` and back to the domains; `REAUTH_REQUIRED` returns the previous state with `stepUp: true`,
 * so `useStepUpAction` asks for a TOTP code and runs the action again with the same form data (neither operation asks
 * for one today; the console handles it the same way everywhere). A success revalidates the domains, the dashboard
 * (its count of pending domains) and, for a removal, the OTA's page (its domains tab). The states carry only what the
 * table shows, in the admin's own words: never the API's message.
 */

/** A refused action, in the admin's words. */
export interface DomainActionFailure {
  readonly status: "failed";
  /** The error code, for tests and the `data-code` of the notice; never shown. */
  readonly code: PlatformErrorCode;
  readonly message: string;
  readonly domainId: string;
}

interface StepUpFlag {
  readonly stepUp?: true;
}

interface Idle {
  readonly status: "idle";
}

/** The state of the re-check of a host. */
export type RecheckDomainState = StepUpFlag &
  (
    | Idle
    | { readonly status: "done"; readonly domainId: string; readonly hostname: string }
    | DomainActionFailure
  );

/** The state of the removal of a custom domain. */
export type RemoveDomainState = StepUpFlag &
  (
    | Idle
    | { readonly status: "done"; readonly domainId: string; readonly hostname: string }
    | DomainActionFailure
  );

// ---- Form fields ------------------------------------------------------------------------------------------------

/** `AdminDomain.id` and `TenantId` of the platform document. */
const DOMAIN_ID = z.string().regex(/^dom_[0-9A-HJKMNP-TV-Z]{26}$/);
const TENANT_ID = z.string().regex(/^ten_[0-9A-HJKMNP-TV-Z]{26}$/);
/**
 * The host name the outcome names (`format: hostname`, lower case): at most 253 characters of letters, digits, dots and
 * hyphens. It only words the outcome; the API acts on the id.
 */
const HOSTNAME = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/);

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * What is wrong with `value` as an `AdminReason` (5–500 code points after trimming), or `undefined`: the rule of
 * `reasonProblem` in `ReasonDialog`, which a server module cannot import (it is a client module).
 */
function reasonProblem(value: string): string | undefined {
  const length = [...value.trim()].length;
  if (length === 0) {
    return REASON_STRINGS.required;
  }
  if (length < REASON_MIN_LENGTH) {
    return REASON_STRINGS.tooShort;
  }
  return length > REASON_MAX_LENGTH ? REASON_STRINGS.tooLong : undefined;
}

// ---- Answers ------------------------------------------------------------------------------------------------------

const DOMAINS_PATH = "/domains";

/** An ended session signs in again and comes back to the domains (the middleware renews a token that only expired). */
function signInIfEnded(error: ApiError): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: DOMAINS_PATH }).toString()}`);
  }
}

/** The admin's message for a failed call: the action's own for a code or a `CONFLICT` reason, else the catalogue's. */
function messageOf(
  error: ApiError,
  codes: Readonly<Partial<Record<PlatformErrorCode, string>>>,
  conflicts: Readonly<Record<string, string>> = {},
): string {
  const reason = error.details["reason"];
  if (error.code === "CONFLICT" && typeof reason === "string" && Object.hasOwn(conflicts, reason)) {
    return conflicts[reason] ?? errorMessage(error);
  }
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return S.rateLimitedFor(error.retryAfterSeconds);
  }
  return codes[error.code] ?? errorMessage(error);
}

function formExpired(domainId: string): DomainActionFailure {
  return { status: "failed", code: "VALIDATION_FAILED", message: S.formExpired, domainId };
}

// ---- Re-check -----------------------------------------------------------------------------------------------------

/**
 * Checks a host now (`adminRecheckDomain`) from the fields `domainId` and `hostname` (for the outcome's words): the API
 * queues the DNS check that fits a custom domain's status and the TLS probe, writes its audit row and answers `202`
 * before the jobs run, so the outcome says the checks are queued and the list shows their result once they ran. A
 * verified domain's DNS check runs every time, and its failure counts at most one strike per UTC day (FIX-W41-PLATFORM,
 * lead decision (2b) of 2026-11-04).
 * `SERVICE_UNAVAILABLE` (Redis did not take the jobs, which are the whole effect) is worded.
 */
export async function recheckDomain(
  previous: RecheckDomainState,
  formData: FormData,
): Promise<RecheckDomainState> {
  const domainId = DOMAIN_ID.safeParse(text(formData, "domainId"));
  const hostname = HOSTNAME.safeParse(text(formData, "hostname"));
  if (!domainId.success || !hostname.success) {
    return formExpired(domainId.data ?? "");
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/domains/{domainId}/recheck", {
    params: { path: { domainId: domainId.data } },
  });
  if (result.error !== undefined) {
    const { error } = result;
    signInIfEnded(error);
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    return {
      status: "failed",
      code: error.code,
      message: messageOf(error, {
        NOT_FOUND: S.domainGone,
        SERVICE_UNAVAILABLE: S.recheckUnavailable,
        VALIDATION_FAILED: S.formExpired,
      }),
      domainId: domainId.data,
    };
  }
  // The jobs change the host after this answer; the revalidated list shows them once they ran (a reload later).
  revalidatePath(DOMAINS_PATH);
  return { status: "done", domainId: domainId.data, hostname: hostname.data };
}

// ---- Remove -------------------------------------------------------------------------------------------------------

/**
 * Removes an abusive custom domain of any OTA (`adminRemoveDomain`, PF-92) from the fields `domainId`, `hostname` (for
 * the outcome's words), `tenantId` (the OTA's page to revalidate) and `reason` (5–500 characters after trimming, kept in
 * the audit log and out of the owners' e-mail). The API deletes the host, makes the sub-domain primary again when the
 * removed host was, stops the storefront and the TLS gate from serving it and e-mails the owners. An OTA's sub-domain
 * answers `CONFLICT` (`subdomain`); the table offers no removal for one.
 */
export async function removeDomain(
  previous: RemoveDomainState,
  formData: FormData,
): Promise<RemoveDomainState> {
  const domainId = DOMAIN_ID.safeParse(text(formData, "domainId"));
  const hostname = HOSTNAME.safeParse(text(formData, "hostname"));
  const tenantId = TENANT_ID.safeParse(text(formData, "tenantId"));
  if (!domainId.success || !hostname.success || !tenantId.success) {
    return formExpired(domainId.data ?? "");
  }
  const reason = text(formData, "reason");
  const problem = reasonProblem(reason);
  if (problem !== undefined) {
    return { status: "failed", code: "VALIDATION_FAILED", message: problem, domainId: domainId.data };
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/domains/{domainId}/remove", {
    params: { path: { domainId: domainId.data } },
    body: { reason: reason.trim() },
  });
  if (result.error !== undefined) {
    const { error } = result;
    signInIfEnded(error);
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    return {
      status: "failed",
      code: error.code,
      message: messageOf(
        error,
        { NOT_FOUND: S.domainGone, VALIDATION_FAILED: S.formExpired },
        { subdomain: S.subdomain },
      ),
      domainId: domainId.data,
    };
  }
  revalidatePath(DOMAINS_PATH);
  revalidatePath("/");
  revalidatePath(`/tenants/${tenantId.data}`);
  return { status: "done", domainId: domainId.data, hostname: hostname.data };
}
