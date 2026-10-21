import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AdminList, type AdminRow, type RevokeRule } from "@/app/(app)/admins/admin-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { ADMIN_LIST_STRINGS as S } from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type PlatformAdmin = components["schemas"]["PlatformAdmin"];

/**
 * Whether `admin` can be revoked by the signed-in admin `selfId`: never one's own rights, and never the last admin's
 * (the API refuses both with `FORBIDDEN`). The list has no status, so "last" is the only admin of the list; when
 * another admin is disabled, the API still refuses the last active one (`last_admin`), and the action words it.
 */
function revokeRule(admin: PlatformAdmin, admins: readonly PlatformAdmin[], selfId: string): RevokeRule {
  if (admin.accountId === selfId) {
    return "self";
  }
  return admins.length <= 1 ? "last_admin" : "allowed";
}

/**
 * `/admins` (README §2, PF-86): every platform admin (`adminListAdmins`, by name, not paginated) with **Grant admin
 * rights** (an existing account's e-mail address and a reason, with the step-up) and **Revoke** per row (the step-up).
 * The page asks `adminGetMe` for the signed-in admin, so its own row (and the last admin's) has the revoke button
 * disabled with a note: revoking oneself is not offered. When either call fails, the page shows the failure instead of
 * the list, since it could not tell which row is the admin's own. The client component gets the fields the table shows
 * and each row's rule.
 */
export default async function AdminsPage() {
  const api = await platformApi();
  const [admins, me] = await Promise.all([api.GET("/v1/admin/admins"), api.GET("/v1/admin/me")]);
  const ended = [admins.error?.code, me.error?.code].some(
    (code) => code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED",
  );
  if (ended) {
    redirect("/sign-in");
  }
  const failure = admins.error ?? me.error;
  const list = admins.data?.data;
  const selfId = me.data?.id;

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{S.title}</h1>
        <p className="text-muted-foreground">{S.intro}</p>
      </div>
      {failure !== undefined || list === undefined || selfId === undefined ? (
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(failure ?? "INTERNAL_ERROR")}</AlertDescription>
        </Alert>
      ) : (
        <AdminList
          admins={list.map((admin): AdminRow => ({
            accountId: admin.accountId,
            email: admin.email,
            fullName: admin.fullName,
            mfaEnabled: admin.mfaEnabled,
            lastLoginAt: admin.lastLoginAt,
            revoke: revokeRule(admin, list, selfId),
          }))}
        />
      )}
    </div>
  );
}
