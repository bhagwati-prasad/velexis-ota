"use client";

import { type BoundaryError, RouteError } from "@/components/error-view";
import { ERROR_PAGE_STRINGS } from "@/lib/strings";

/**
 * The error page of the root segment (README §5, known issue KI-007): an unexpected error that no area's `error.tsx`
 * caught, such as one of an area's own layout or of a page outside the areas. It renders in the root layout, so it has
 * its own `<main>`, and leads back to the home page. A client component, as Next.js requires.
 */
export default function RootError({
  error,
  reset,
}: {
  readonly error: BoundaryError;
  readonly reset: () => void;
}) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6 py-16 focus:outline-none"
    >
      <RouteError error={error} reset={reset} back={{ href: "/", label: ERROR_PAGE_STRINGS.homeLink }} />
    </main>
  );
}
