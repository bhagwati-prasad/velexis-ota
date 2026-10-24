"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { descriptorSuffixProblem } from "@/app/(app)/otas/[tenantId]/payments/descriptor-rules";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { otaPath } from "@/lib/roles";
import { DESCRIPTOR_STRINGS } from "@/lib/strings";
import { ifMatchOf, isTenantId } from "@/lib/tenant";

/**
 * The server action of the payments page (README §2 `/otas/[tenantId]/payments`; flows/stripe-payments-account.md §A
 * item 3; PF-60). `saveStatementDescriptor` checks the card statement descriptor suffix with the rules of
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
