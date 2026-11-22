"use client";

import { type BoundaryError, RouteError } from "@/components/error-view";
import { ERROR_PAGE_STRINGS } from "@/lib/strings";

/**
 * The error page of the sign-in and sign-up pages (README §5, known issue KI-007). The area has no layout of its own,
 * so the page has its own `<main>`, in the look of the area's pages, and leads back to sign-in. A client component, as
 * Next.js requires.
 */
export default function AuthError({
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
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-16 focus:outline-none"
    >
      <RouteError
        error={error}
        reset={reset}
        back={{ href: "/sign-in", label: ERROR_PAGE_STRINGS.signInLink }}
      />
    </main>
  );
}
