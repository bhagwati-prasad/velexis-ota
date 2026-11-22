"use client";

import { type BoundaryError, RouteError } from "@/components/error-view";
import { ERROR_PAGE_STRINGS } from "@/lib/strings";

/**
 * The error page of the public pages (README §5, known issue KI-007). Next.js renders it inside
 * `(marketing)/layout.tsx`, between the header and the footer, where each page renders its own `<main>`, and it leads
 * back to the home page. A client component, as Next.js requires.
 */
export default function MarketingError({
  error,
  reset,
}: {
  readonly error: BoundaryError;
  readonly reset: () => void;
}) {
  return (
    <main id="main-content" tabIndex={-1} className="flex-1 px-6 py-16 focus:outline-none">
      <RouteError error={error} reset={reset} back={{ href: "/", label: ERROR_PAGE_STRINGS.homeLink }} />
    </main>
  );
}
