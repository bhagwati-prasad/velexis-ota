// `/portal` (README §5, routes.md §11, OAD-012): links back to the portal's pages of this OTA (API keys, domains,
// Amadeus, payments and Stripe, team, billing, go-live and the OTA's settings). These areas belong to the platform, so
// the admin only links to them; every role sees the page, and the portal checks its own roles when a page opens.
//
// The links come from `lib/portal-links.ts`: the configured `PUBLIC_PORTAL_URL` and the id of the session's OTA
// (`console.auth.me`, `tenant.id`) only. The page makes no call of its own besides the request's `console.auth.me`,
// which the shell makes too (React `cache`: once per request); its failure is handled on the server as on the other
// pages (routes.md §1, OAD-004): an expired session goes to `/auth/refresh` and an ended one to the portal
// (`getConsoleRequest` redirects itself), any other API error renders the console's message with the request id.
import type { Metadata } from "next";

import { getConfig } from "@/config";
import { ErrorState } from "@/components/error-state";
import { isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { portalLinks } from "@/lib/portal-links";
import { redirectOnSessionError } from "@/lib/session";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

export const metadata: Metadata = { title: "Portal links" };

const PAGE_STRINGS = Object.freeze({
  title: "Portal links",
  intro: (tenant: string) =>
    `${tenant}'s API keys, domains, Amadeus and Stripe connections, team, billing and go-live are managed in the Velexis portal. These links open this OTA's pages there.`,
  roles:
    "The portal decides what your portal account may open there: some pages are for owners, admins or finance members only.",
  unavailableTitle: "The portal links could not be shown",
  noLinks:
    "This session's OTA has no id the portal knows, so no link can be built. Open the console again from the portal.",
  areas: "Portal pages of this OTA",
});

/** Where an expired session comes back to. */
const PORTAL_PAGE_PATH = "/portal";

/**
 * An error of the OTA API as the page's state: `TOKEN_EXPIRED` and an ended session redirect (Next.js's redirect is
 * thrown on), anything that is not an API error is thrown for the error boundary, and an API error is returned.
 */
async function apiFailure(error: unknown, here: string): Promise<VelexisErrorLike> {
  if (!isVelexisErrorLike(error)) {
    throw error;
  }
  try {
    await redirectOnSessionError(error, here);
  } catch (thrown) {
    // `redirectOnSessionError` throws the same error back when it is not about the session.
    if (thrown !== error) {
      throw thrown;
    }
  }
  return error;
}

export default async function PortalPage() {
  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, PORTAL_PAGE_PATH);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }
  const { tenant } = request.staff;
  const links = portalLinks(getConfig().PUBLIC_PORTAL_URL, tenant.id);

  return (
    <div className="grid gap-6">
      <div className="grid max-w-3xl gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
        <p className="text-muted-foreground">{PAGE_STRINGS.intro(tenant.name)}</p>
        <p className="text-sm text-muted-foreground">{PAGE_STRINGS.roles}</p>
      </div>
      {links.length === 0 ? (
        <ErrorState title={PAGE_STRINGS.unavailableTitle} description={{ message: PAGE_STRINGS.noLinks }} />
      ) : (
        <nav aria-label={PAGE_STRINGS.areas}>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {links.map((link) => (
              <li key={link.id} className="grid content-start gap-1 rounded-lg border p-4">
                <a
                  href={link.href}
                  className="font-medium text-primary underline-offset-4 hover:underline focus-visible:underline"
                >
                  {link.label}
                </a>
                <p className="text-sm text-muted-foreground">{link.description}</p>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
