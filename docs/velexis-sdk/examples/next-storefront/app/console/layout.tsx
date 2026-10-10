import Link from "next/link";
import type { ReactNode } from "react";
import { currentStaff } from "@/lib/velexis";
import { signOutStaffAction } from "./sign-in/actions";

export const metadata = { title: "Console", robots: { index: false, follow: false } };

/**
 * Console shell. The layout does not redirect (the sign-in page lives under /console too): the middleware protects
 * /console/*, and every page / server action calls `requireStaff()` with the roles or permissions it needs.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const me = await currentStaff();
  const can = (p: string) => !!me?.permissions.some((x) => x === p);
  return (
    <div className="console" data-env={me?.tenant.environment}>
      {me?.tenant.environment === "test" && <div className="test-banner">TEST — Amadeus test environment</div>}
      {me && (
        <header className="console-header">
          <strong>{me.tenant.name} console</strong>
          <nav>
            <Link href="/console/bookings">Bookings</Link>
            <Link href="/console/pnr">PNR</Link>
            {can("queues:read") && <Link href="/console/queues">Queues</Link>}
            {can("amadeus:read") && <Link href="/console/search">Availability &amp; raw search</Link>}
          </nav>
          <span>
            {me.staff.fullName} · {me.staff.role}
          </span>
          <form action={signOutStaffAction} className="inline">
            <button type="submit">Sign out</button>
          </form>
        </header>
      )}
      <div className="console-body">{children}</div>
    </div>
  );
}
