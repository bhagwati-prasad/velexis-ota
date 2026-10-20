import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import type { ApiKey, ApiKeyEnvironment } from "@/app/(app)/otas/[tenantId]/api-keys/actions";
import { CreateKeyForm } from "@/app/(app)/otas/[tenantId]/api-keys/create-key-form";
import { ApiKeysTable, type KeyRow, type KeyState } from "@/app/(app)/otas/[tenantId]/api-keys/keys-table";
import { NotAllowed } from "@/components/not-allowed";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { platformApi, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { can, otaPath } from "@/lib/roles";
import { API_KEYS_STRINGS } from "@/lib/strings";
import { requireTenant, type Tenant } from "@/lib/tenant";

export const metadata: Metadata = { title: API_KEYS_STRINGS.title };

type ApiKeyList = components["schemas"]["ApiKeyList"];

/**
 * The environments with a tab. Live keys exist only once the OTA is live (`LIVE_MODE_NOT_ENABLED` before), and their
 * tab comes with the go-live switch (PFE-026, M5); the table and the create form already take an environment.
 */
function environmentsOf(_tenant: Tenant): ApiKeyEnvironment[] {
  return ["test"];
}

/**
 * `listApiKeys` with the revoked keys (they stay listed: the audit log refers to them). An ended session goes to
 * sign-in and back to this page, an unverified account to `/verify-pending`, an OTA the caller is no member of (any
 * more) to the not-found page; other failures are returned for the page to show the portal's message.
 */
async function loadKeys(tenantId: string): Promise<ApiResult<ApiKeyList>> {
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/api-keys", {
    params: { path: { tenantId }, query: { includeRevoked: true } },
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/api-keys") }).toString()}`);
    }
    if (code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-pending");
    }
    if (code === "NOT_FOUND") {
      notFound();
    }
  }
  return result;
}

/** Whether a key works at `now`: revoked, expired (its `expiresAt` passed), or active. */
function stateOf(apiKey: ApiKey, now: number): KeyState {
  if (apiKey.revokedAt !== null) {
    return "revoked";
  }
  return apiKey.expiresAt !== null && Date.parse(apiKey.expiresAt) <= now ? "expired" : "active";
}

/**
 * `/otas/[tenantId]/api-keys` (README §2 Signed in; flow api-keys.md; PADR-0005; PF-30): the OTA's API keys for owners
 * and admins, one tab per environment (test; live with M5). Each tab lists its keys (`ApiKeysTable`: name, kind,
 * prefix and `…last4`, origins or scopes, creator, last use, expiry, state; edit, roll, revoke) and the form for a new
 * key (`CreateKeyForm`). The tenant comes from the layout's `getTenant` (the same request's cached answer); another
 * role gets the not-allowed page without a call. A key is shown once, from the answer of the create or roll action:
 * this page never has it, so a reload never shows it again. While the OTA is not active the keys are read-only.
 */
export default async function ApiKeysPage({ params }: Readonly<{ params: Promise<{ tenantId: string }> }>) {
  const { tenantId } = await params;
  const loaded = await requireTenant(tenantId);
  if (loaded.error !== undefined) {
    // The layout renders the portal's message for this failure in place of the page.
    return null;
  }
  const { tenant } = loaded;
  if (!can(tenant.myRole, "manageApiKeys")) {
    return <NotAllowed tenantId={tenant.id} role={tenant.myRole} />;
  }
  const keys = await loadKeys(tenant.id);
  // One instant for every row, so each key's state is decided once and the browser renders what the server did.
  const now = Date.now();
  const writable = tenant.status === "active";
  const environments = environmentsOf(tenant);

  function rowsOf(environment: ApiKeyEnvironment): KeyRow[] {
    return (keys.data?.data ?? [])
      .filter((apiKey) => apiKey.environment === environment)
      .map((apiKey) => ({ apiKey, state: stateOf(apiKey, now) }));
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{API_KEYS_STRINGS.title}</h1>
        <p className="text-muted-foreground">{API_KEYS_STRINGS.intro}</p>
      </div>

      {tenant.status === "active" ? null : (
        <Alert role="status" data-notice="read-only">
          <AlertTitle>{API_KEYS_STRINGS.readOnlyTitle}</AlertTitle>
          <AlertDescription>{API_KEYS_STRINGS.readOnly[tenant.status]}</AlertDescription>
        </Alert>
      )}

      {/* The test tab always exists and opens first. */}
      <Tabs defaultValue="test" className="gap-6">
        <TabsList aria-label={API_KEYS_STRINGS.environmentsLabel}>
          {environments.map((environment) => (
            <TabsTrigger key={environment} value={environment}>
              {API_KEYS_STRINGS.tab(environment)}
            </TabsTrigger>
          ))}
        </TabsList>
        {environments.map((environment) => (
          <TabsContent key={environment} value={environment} className="grid gap-10">
            <section aria-labelledby={`api-keys-${environment}-list`} className="grid gap-4">
              <div className="grid gap-1">
                <h2 id={`api-keys-${environment}-list`} className="text-xl font-semibold tracking-tight">
                  {API_KEYS_STRINGS.listTitle(environment)}
                </h2>
                <p className="text-sm text-muted-foreground">{API_KEYS_STRINGS.listIntro}</p>
              </div>
              {keys.error === undefined ? (
                <ApiKeysTable
                  tenantId={tenant.id}
                  environment={environment}
                  rows={rowsOf(environment)}
                  writable={writable}
                />
              ) : (
                <Alert variant="destructive">
                  <AlertTitle>{API_KEYS_STRINGS.listUnavailableTitle}</AlertTitle>
                  <AlertDescription>{errorMessage(keys.error)}</AlertDescription>
                </Alert>
              )}
            </section>
            <section aria-labelledby={`api-keys-${environment}-create`} className="grid max-w-2xl gap-4">
              <div className="grid gap-1">
                <h2 id={`api-keys-${environment}-create`} className="text-xl font-semibold tracking-tight">
                  {API_KEYS_STRINGS.createTitle(environment)}
                </h2>
                <p className="text-sm text-muted-foreground">{API_KEYS_STRINGS.createIntro}</p>
              </div>
              <CreateKeyForm tenantId={tenant.id} environment={environment} writable={writable} />
            </section>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
