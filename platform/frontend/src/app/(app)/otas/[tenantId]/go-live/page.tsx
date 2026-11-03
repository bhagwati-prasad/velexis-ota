import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { GoLiveSwitch } from "@/app/(app)/otas/[tenantId]/go-live/go-live-switch";
import { initialStates, type OnboardingFact } from "@/app/(app)/otas/[tenantId]/go-live/preconditions";
import { NotAllowed } from "@/components/not-allowed";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiError, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { can, otaPath } from "@/lib/roles";
import { GO_LIVE_STRINGS } from "@/lib/strings";
import { requireTenant } from "@/lib/tenant";

export const metadata: Metadata = { title: GO_LIVE_STRINGS.title };

type Account = components["schemas"]["Account"];
type OnboardingChecklist = components["schemas"]["OnboardingChecklist"];

/**
 * Ends the request when the session is over: sign in again and come back to this page; an unverified account goes to
 * `/verify-pending`.
 */
function leaveOnSessionEnd(error: ApiError, tenantId: string): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/go-live") }).toString()}`);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
}

/**
 * `getMe`: the milestone switches (`features.liveSwitch`) and the owner's own `mfaEnabled` (the `mfa` precondition).
 * An ended session goes to sign-in and back to this page, an unverified account to `/verify-pending`; other failures
 * are returned for the page to show the portal's message.
 */
async function loadMe(tenantId: string): Promise<ApiResult<Account>> {
  const api = await platformApi();
  const result = await api.GET("/v1/me");
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
  }
  return result;
}

/**
 * `getOnboarding` (PADR-0018), for what it says for sure about the preconditions before the first try
 * (`initialStates`). An ended session goes to sign-in and back, an unverified account to `/verify-pending`, an OTA the
 * caller is no member of (any more) to the not-found page; any other failure only leaves the checklist without that
 * help (the switch itself checks everything).
 */
async function loadOnboarding(tenantId: string): Promise<readonly OnboardingFact[] | undefined> {
  const api = await platformApi();
  const result: ApiResult<OnboardingChecklist> = await api.GET("/v1/tenants/{tenantId}/onboarding", {
    params: { path: { tenantId } },
  });
  if (result.error === undefined) {
    return result.data.items;
  }
  leaveOnSessionEnd(result.error, tenantId);
  if (result.error.code === "NOT_FOUND") {
    notFound();
  }
  return undefined;
}

/**
 * `/otas/[tenantId]/go-live` (README §2 Signed in; scope PF-14; the platform document's `goLive`): owners switch the
 * OTA's storefront to live. Any other role gets the not-allowed page without another call (the navigation shows the
 * entry to owners only, while `features.liveSwitch` is on). The page reads `getMe` (the switch and the owner's MFA) and,
 * while the OTA is in test mode, `getOnboarding` side by side; the tenant comes from the layout's `getTenant`.
 *
 * With the switch off it says that live mode is not open yet, and offers nothing. Otherwise `GoLiveSwitch` shows the six
 * preconditions with links to the pages that complete them and "Go live" (`ConfirmDialog`, then the step-up), or, once
 * the OTA is live, its live storefront. A failed `getMe` shows the portal's message in place of both.
 */
export default async function GoLivePage({ params }: Readonly<{ params: Promise<{ tenantId: string }> }>) {
  const { tenantId } = await params;
  const loaded = await requireTenant(tenantId);
  if (loaded.error !== undefined) {
    // The layout renders the portal's message for this failure in place of the page.
    return null;
  }
  const { tenant } = loaded;
  if (!can(tenant.myRole, "goLive")) {
    return <NotAllowed tenantId={tenant.id} role={tenant.myRole} />;
  }
  const live = tenant.storefrontEnvironment === "live";
  const [me, onboarding] = await Promise.all([
    loadMe(tenant.id),
    live ? Promise.resolve(undefined) : loadOnboarding(tenant.id),
  ]);

  let content: ReactNode;
  if (me.error !== undefined) {
    content = (
      <Alert variant="destructive">
        <AlertTitle>{GO_LIVE_STRINGS.unavailableTitle}</AlertTitle>
        <AlertDescription>{errorMessage(me.error)}</AlertDescription>
      </Alert>
    );
  } else if (!me.data.features.liveSwitch && !live) {
    content = (
      <section
        aria-labelledby="go-live-off-title"
        data-go-live="switch-off"
        className="grid gap-2 rounded-xl border p-5"
      >
        <h2 id="go-live-off-title" className="text-lg font-semibold tracking-tight">
          {GO_LIVE_STRINGS.switchOffTitle}
        </h2>
        <p className="text-sm text-muted-foreground">{GO_LIVE_STRINGS.switchOff}</p>
      </section>
    );
  } else {
    // An OTA that is live keeps its live view even if the switch was turned off again: it is information only.
    content = (
      <GoLiveSwitch
        tenantId={tenant.id}
        tenantStatus={tenant.status}
        primaryHost={tenant.primaryHost}
        live={live ? { liveEnabledAt: tenant.liveEnabledAt } : null}
        timeZone={tenant.timeZone}
        initial={initialStates({ mfaEnabled: me.data.mfaEnabled, onboarding })}
      />
    );
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{GO_LIVE_STRINGS.title}</h1>
        <p className="text-muted-foreground">{GO_LIVE_STRINGS.intro}</p>
      </div>
      {content}
    </div>
  );
}
