// `/signed-out`: where `POST /auth/sign-out` lands (README §3). It needs no session; the tenant cookie, which the
// sign-out keeps, makes "Back to the portal" open this OTA's console page in the portal (PADR-0007 §5).
import type { Metadata } from "next";
import { cookies } from "next/headers";

import { getConfig } from "@/config";
import { portalConsoleUrl, readSessionCookies } from "@/lib/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Signed out" };

export default async function SignedOutPage() {
  const { tenantId } = readSessionCookies(await cookies());
  const portal = portalConsoleUrl(getConfig().PUBLIC_PORTAL_URL, tenantId);
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-6"
    >
      <h1 className="text-xl font-semibold">You have signed out</h1>
      <p className="text-muted-foreground">
        Your console session has ended on this device. To work in the console again, open it from the portal.
      </p>
      <p>
        <a href={portal} className="font-medium text-primary underline underline-offset-4">
          Back to the portal
        </a>
      </p>
    </main>
  );
}
