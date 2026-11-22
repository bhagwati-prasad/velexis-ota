"use client";

import "./globals.css";

import { type BoundaryError, ErrorView, referenceOf } from "@/components/error-view";
import { ERROR_PAGE_STRINGS } from "@/lib/strings";

/**
 * The error page of the root layout itself (README §5, known issue KI-007): Next.js renders it in place of the root
 * layout, so it brings its own `<html>`, `<body>`, title, styles and `<main>`. The router is not mounted around it, so
 * "Try again" only re-renders (`reset()`) and the way back to the home page loads a new document. A client component,
 * as Next.js requires.
 */
export default function GlobalError({
  error,
  reset,
}: {
  readonly error: BoundaryError;
  readonly reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <title>{`${ERROR_PAGE_STRINGS.title} · Velexis`}</title>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6 py-16 focus:outline-none"
        >
          <ErrorView
            reference={referenceOf(error)}
            onRetry={reset}
            back={{ href: "/", label: ERROR_PAGE_STRINGS.homeLink }}
            documentLink
          />
        </main>
      </body>
    </html>
  );
}
