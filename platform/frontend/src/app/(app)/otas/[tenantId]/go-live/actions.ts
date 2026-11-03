"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  checkedFromMissing,
  type CheckedPreconditions,
} from "@/app/(app)/otas/[tenantId]/go-live/preconditions";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { otaPath } from "@/lib/roles";
import { GO_LIVE_STRINGS } from "@/lib/strings";
import { isTenantId } from "@/lib/tenant";

/**
 * The server action of the go-live page (README §2 `/otas/[tenantId]/go-live`; scope PF-14; the platform document's
 * `goLive`): `goLiveNow` sends `POST /v1/tenants/{tenantId}/go-live` with `{confirm: true}`, the session and the
 * end-user headers. The API is owners only, behind the live switch and a TOTP step-up within 15 minutes:
 * `REAUTH_REQUIRED` answers `stepUp`, and `useStepUpAction` sends the same switch again after the code. A `422
 * LIVE_PRECONDITIONS_UNMET` answers what its `details.missing` says of every precondition, so the page's checklist shows
 * what to complete; nothing changed then. A switch revalidates every page of the OTA (its banner, its API keys' live
 * tab) and answers the OTA's storefront host for the live view. Messages are the portal's own text, never the API's.
 */

/** What the go-live switch shows after an attempt. */
export interface GoLiveState {
  readonly status: "idle" | "live" | "unmet" | "failed";
  /** The error code of a refusal, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  /** What the answer decided of the preconditions: all six after `LIVE_PRECONDITIONS_UNMET`, `mfa` after `MFA_REQUIRED`. */
  readonly checked?: CheckedPreconditions;
  /** `details.missing` named a precondition the portal has no words for (or none at all). */
  readonly otherMissing?: true;
  readonly message?: string;
  /** The message goes with the link to the account's security page (`MFA_REQUIRED`). */
  readonly security?: true;
  /** The page is out of date: "Reload the page". */
  readonly reload?: true;
  /** The API asked for a step-up (`REAUTH_REQUIRED`): `useStepUpAction` opens the dialog. */
  readonly stepUp?: true;
  /** The OTA is live now: the host of its storefront and since when, from the answer. */
  readonly live?: { readonly primaryHost: string; readonly liveEnabledAt: string | null };
}

type GoLiveProblem = Pick<GoLiveState, "message" | "security" | "reload" | "stepUp" | "checked">;

/** The portal's answer to each code of a refused `goLive`; other codes get the portal's message for the code. */
const FAILURES: Readonly<Partial<Record<PlatformErrorCode, GoLiveProblem>>> = {
  // Shown when the person cancels the step-up dialog that opens now.
  REAUTH_REQUIRED: { message: GO_LIVE_STRINGS.stepUpCancelled, stepUp: true },
  MFA_REQUIRED: { message: GO_LIVE_STRINGS.mfaRequired, security: true, checked: { mfa: "missing" } },
  FEATURE_DISABLED: { message: GO_LIVE_STRINGS.featureDisabled, reload: true },
  TENANT_NOT_ACTIVE: { message: GO_LIVE_STRINGS.notActive, reload: true },
  FORBIDDEN: { message: GO_LIVE_STRINGS.forbidden, reload: true },
  NOT_FOUND: { message: GO_LIVE_STRINGS.removed, reload: true },
  VALIDATION_FAILED: { message: GO_LIVE_STRINGS.formExpired, reload: true },
  RATE_LIMITED: { message: GO_LIVE_STRINGS.rateLimited },
};

/**
 * The route pattern of the OTA layout, `app/(app)/otas/[tenantId]/layout.tsx`. Next.js derives a page's layout tags
 * from its route pattern with the route group (`/(app)/otas/[tenantId]/layout`), unlike a URL, so the group belongs
 * in the pattern: without it the tag matches no page.
 */
const OTA_LAYOUT = "/(app)/otas/[tenantId]";

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Ends the request when the session is over: sign in again and come back to the go-live page; an unverified account
 * goes to `/verify-pending` (the middleware renews an access token that is only expired).
 */
function leaveOnSessionEnd(error: ApiError, tenantId: string): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/go-live") }).toString()}`);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
}

/** Switches the OTA of the field `tenantId` to live (`goLive`; see the module comment). */
export async function goLiveNow(_previous: GoLiveState, formData: FormData): Promise<GoLiveState> {
  const tenantId = text(formData, "tenantId");
  if (!isTenantId(tenantId)) {
    // The page always sends it.
    return {
      status: "failed",
      code: "VALIDATION_FAILED",
      message: GO_LIVE_STRINGS.formExpired,
      reload: true,
    };
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/go-live", {
    params: { path: { tenantId } },
    body: { confirm: true },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    if (result.error.code === "LIVE_PRECONDITIONS_UNMET") {
      const { checked, otherMissing } = checkedFromMissing(result.error.details["missing"]);
      return {
        status: "unmet",
        code: "LIVE_PRECONDITIONS_UNMET",
        checked,
        ...(otherMissing ? { otherMissing: true } : {}),
      };
    }
    return {
      status: "failed",
      code: result.error.code,
      ...(FAILURES[result.error.code] ?? { message: errorMessage(result.error) }),
    };
  }
  // Every page below the OTA layout: the banner leaves test mode, the API keys page gets its live tab, this page its
  // live view. Next.js tags a layout by its route pattern, route group included (only a page also by its URL), hence
  // the pattern; the pages are dynamic, so nothing of another OTA is cached to lose.
  revalidatePath(OTA_LAYOUT, "layout");
  return {
    status: "live",
    live: { primaryHost: result.data.primaryHost, liveEnabledAt: result.data.liveEnabledAt },
  };
}
