import type { Metadata } from "next";

import { NotFoundView } from "@/components/not-found-view";
import { NOT_FOUND_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: NOT_FOUND_STRINGS.title };

/**
 * The not-found page of an address that matches no page of the portal, and of `notFound()` outside the signed-in area
 * (README §5, known issue KI-007). It renders in the root layout only, so it has its own `<main>`, the target of the
 * skip link, and offers the home page and My OTAs (the middleware sends a visitor without a session to sign-in). The
 * answer's status stays `404`.
 */
export default function NotFound() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6 py-16 focus:outline-none"
    >
      <NotFoundView
        text={NOT_FOUND_STRINGS.text}
        links={[
          { href: "/", label: NOT_FOUND_STRINGS.homeLink },
          { href: "/dashboard", label: NOT_FOUND_STRINGS.dashboardLink },
        ]}
      />
    </main>
  );
}
