"use client";

import { type BoundaryError, RouteError } from "@/components/error-view";
import { ERROR_PAGE_STRINGS } from "@/lib/strings";

/**
 * The error page of the signed-in area (README §5, known issue KI-007): an unexpected error of a page of the shell.
 * Next.js renders it inside `(app)/layout.tsx`, so it sits in the shell's `<main>` with the navigation around it, and
 * leads back to My OTAs. A client component, as Next.js requires.
 */
export default function SignedInError({
  error,
  reset,
}: {
  readonly error: BoundaryError;
  readonly reset: () => void;
}) {
  return (
    <RouteError
      error={error}
      reset={reset}
      back={{ href: "/dashboard", label: ERROR_PAGE_STRINGS.dashboardLink }}
    />
  );
}
