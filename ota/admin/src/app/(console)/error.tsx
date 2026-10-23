"use client";

// The error boundary of the console's pages (README §6 and §10, routes.md §1), inside the shell: the navigation and
// the header stay usable. It shows the message of lib/errors.ts for the error's code with its request id, and "Try
// again". An area that needs other words adds its own `error.tsx` that renders `ErrorState` the same way.
//
// In production Next.js replaces an error thrown in a server component with a generic one before it reaches this
// boundary: only the `digest` is left, which is shown as the reference that matches the server log. In development
// React keeps the name, the message and the stack of such an error, but not its `code`, `status` or `requestId`. So
// pages handle the codes they know on the server (a redirect, or a state of their own: `ErrorState`, routes.md §1) and
// this boundary is the fallback for everything else; only an error with the SDK error's shape that a client component
// throws keeps its code and request id here.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";

const ERROR_BOUNDARY_STRINGS = Object.freeze({
  title: "This page could not be loaded",
  retry: "Try again",
  dashboard: "Go to the dashboard",
});

export default function ConsoleError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  return (
    <ErrorState title={ERROR_BOUNDARY_STRINGS.title} error={error} digest={error.digest}>
      <Button
        type="button"
        disabled={retrying}
        onClick={() =>
          // A server component's error needs the server again: refresh the route, then re-render the segment.
          startRetry(() => {
            router.refresh();
            reset();
          })
        }
      >
        {ERROR_BOUNDARY_STRINGS.retry}
      </Button>
      <Link href="/" className="text-sm font-medium text-primary underline underline-offset-4">
        {ERROR_BOUNDARY_STRINGS.dashboard}
      </Link>
    </ErrorState>
  );
}
