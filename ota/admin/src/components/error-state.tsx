// The state a console page shows instead of its content when the OTA API refused or failed (routes.md §1, README §10):
// a heading, the message of lib/errors.ts for the error's code (never the API's own message or a stack), the request
// id to quote to support, and the ways on. Server components render it for the codes they handle on the server
// (Next.js hides a server component's error from `error.tsx` in production); `error.tsx` renders it for the rest.
// Server or client; no state.
import type { ReactNode } from "react";

import { describeError, type ErrorDescription } from "@/lib/errors";
import { cn } from "@/lib/utils";

export const ERROR_STATE_STRINGS = Object.freeze({
  requestId: "Request id",
  reference: "Error reference",
});

export interface ErrorStateProps {
  /** The heading ("This page could not be loaded"). */
  readonly title: string;
  /** The error, described by lib/errors.ts; or a description of its own. */
  readonly error?: unknown;
  readonly description?: ErrorDescription;
  /** The `digest` Next.js gives a server error in production, the only reference left of it. */
  readonly digest?: string | undefined;
  /** Links or buttons: "Try again", "Back to the portal". */
  readonly children?: ReactNode;
  /** The heading level: `h1` for a full page, `h2` inside the shell (default). */
  readonly level?: 1 | 2;
  readonly className?: string;
}

/** An error in the admin's own words, with its request id. */
export function ErrorState({
  title,
  error,
  description,
  digest,
  children,
  level = 2,
  className,
}: ErrorStateProps) {
  const { message, requestId } = description ?? describeError(error);
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <section role="alert" className={cn("grid max-w-xl gap-3", className)}>
      <Heading className="text-xl font-semibold">{title}</Heading>
      <p>{message}</p>
      {requestId === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          {ERROR_STATE_STRINGS.requestId}: <code>{requestId}</code>
        </p>
      )}
      {requestId === undefined && digest !== undefined && digest !== "" ? (
        <p className="text-sm text-muted-foreground">
          {ERROR_STATE_STRINGS.reference}: <code>{digest}</code>
        </p>
      ) : null}
      {children === undefined ? null : <div className="flex flex-wrap items-center gap-4">{children}</div>}
    </section>
  );
}
