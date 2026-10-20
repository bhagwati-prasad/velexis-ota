import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getSetupProgress, retrySetup, revealSetupKeys } from "@/app/(app)/otas/[tenantId]/setup/actions";
import { ProvisioningProgress } from "@/components/provisioning-progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { otaPath } from "@/lib/roles";
import { SETUP_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: SETUP_STRINGS.title };

/** An OTA id as the platform issues it (`ten_` + ULID); anything else is not an OTA of the account. */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Answers that mean the session is over. */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/** Leaves the page for an ended session, an unverified account or an OTA the account is no member of. */
function leaveOn(code: PlatformErrorCode, tenantId: string): void {
  if (SESSION_ENDED.has(code)) {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/setup") }).toString()}`);
  }
  if (code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
  if (code === "NOT_FOUND") {
    // The API answers 404 for an OTA the account is not a member of, so ids cannot be probed.
    notFound();
  }
}

/** The page's frame: one `h1` (the OTA's name once it is known) and the introduction. */
function SetupFrame({
  name,
  children,
}: {
  readonly name?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="mx-auto grid max-w-3xl gap-8">
      <div className="grid gap-2">
        <p className="text-sm font-medium text-muted-foreground">{SETUP_STRINGS.title}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{name ?? SETUP_STRINGS.title}</h1>
        <p className="text-muted-foreground">{SETUP_STRINGS.intro}</p>
      </div>
      {children}
    </div>
  );
}

/** The page when the OTA or its progress could not be read. */
function SetupUnavailable({ name, message }: { readonly name?: string; readonly message: string }) {
  return (
    <SetupFrame name={name}>
      <Alert variant="destructive">
        <AlertTitle>{SETUP_STRINGS.unavailableTitle}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </SetupFrame>
  );
}

/**
 * `/otas/[tenantId]/setup` (README §2 Signed in; flow provisioning.md §4 and "Failure handling"; PF-11): the set-up
 * progress of a new OTA for any member. The page reads the OTA (`getTenant`: its name, primary host and the caller's
 * role) and the progress (`getSetupProgress`, i.e. `getProvisioning`) on the server; `ProvisioningProgress` then polls
 * every 2 seconds until the set-up is over. Owners get "Retry the set-up" on a failed OTA and "Reveal the test keys"
 * once it is active. The keys are never read here: they come only from the owner's click, so a reload never shows
 * them again.
 */
export default async function SetupPage({ params }: { readonly params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  if (!TENANT_ID.test(tenantId)) {
    notFound();
  }
  const api = await platformApi();
  const [tenant, progress] = await Promise.all([
    api.GET("/v1/tenants/{tenantId}", { params: { path: { tenantId } } }),
    getSetupProgress(tenantId),
  ]);
  if (tenant.error !== undefined) {
    leaveOn(tenant.error.code, tenantId);
  }
  if (progress.status === "failed") {
    leaveOn(progress.code, tenantId);
  }
  // Rate limit, API unavailable and the like: the portal's message for the code, never the API's text.
  if (tenant.error !== undefined) {
    return <SetupUnavailable message={errorMessage(tenant.error)} />;
  }
  if (progress.status === "failed") {
    return <SetupUnavailable name={tenant.data.name} message={progress.message} />;
  }

  return (
    <SetupFrame name={tenant.data.name}>
      <ProvisioningProgress
        initial={progress.progress}
        isOwner={tenant.data.myRole === "owner"}
        storefrontUrl={`https://${tenant.data.primaryHost}/`}
        dashboardHref={otaPath(tenantId)}
        apiKeysHref={otaPath(tenantId, "/api-keys")}
        poll={getSetupProgress.bind(null, tenantId)}
        retry={retrySetup.bind(null, tenantId)}
        reveal={revealSetupKeys.bind(null, tenantId)}
      />
    </SetupFrame>
  );
}
