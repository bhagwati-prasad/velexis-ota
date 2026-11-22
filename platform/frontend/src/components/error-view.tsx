"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { ERROR_PAGE_STRINGS } from "@/lib/strings";

/** The error an `error.tsx` boundary receives: Next.js gives a server error a `digest` and a generic message. */
export type BoundaryError = Error & { readonly digest?: string };

/** The way back from the error page. */
export interface ErrorBackLink {
  readonly href: string;
  readonly label: string;
}

/** A digest as Next.js writes it (a short hash); anything else is not shown. */
const DIGEST = /^[A-Za-z0-9_-]{1,64}$/;

/** The digest of `error` when it is one to show as a reference for support. */
export function referenceOf(error: { readonly digest?: unknown }): string | undefined {
  return typeof error.digest === "string" && DIGEST.test(error.digest) ? error.digest : undefined;
}

export interface ErrorViewProps {
  /** The reference for support (`referenceOf`), if any. */
  readonly reference?: string | undefined;
  /** "Try again". */
  readonly onRetry: () => void;
  /** A retry is under way: the button waits. */
  readonly retrying?: boolean;
  readonly back: ErrorBackLink;
  /**
   * The way back as a plain link that loads a new document, for `global-error.tsx`, which replaces the root layout
   * and with it the router that `next/link` needs.
   */
  readonly documentLink?: boolean;
}

/**
 * The content of the portal's error pages (README §5, known issue KI-007): the page's one `h1`, the portal's words,
 * "Try again" and the way back. It never shows the error's message or stack, which can carry details of the server;
 * only a server error's digest, the reference of its log line, as Next.js's own production page does. The page around
 * it decides the landmark.
 */
export function ErrorView({
  reference,
  onRetry,
  retrying = false,
  back,
  documentLink = false,
}: ErrorViewProps) {
  return (
    <section aria-labelledby="error-title" data-page="error" className="mx-auto grid max-w-xl gap-4 py-8">
      <TriangleAlert aria-hidden="true" className="size-8 text-destructive" />
      <h1 id="error-title" className="text-3xl font-semibold tracking-tight">
        {ERROR_PAGE_STRINGS.title}
      </h1>
      <p>{ERROR_PAGE_STRINGS.text}</p>
      {reference === undefined ? null : (
        <p className="text-sm text-muted-foreground">{ERROR_PAGE_STRINGS.reference(reference)}</p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={onRetry} disabled={retrying}>
          {ERROR_PAGE_STRINGS.tryAgain}
        </Button>
        <Button asChild variant="outline">
          {documentLink ? (
            <a href={back.href}>{back.label}</a>
          ) : (
            <Link href={back.href} prefetch={false}>
              {back.label}
            </Link>
          )}
        </Button>
      </div>
    </section>
  );
}

export interface RouteErrorProps {
  readonly error: BoundaryError;
  /** The boundary's `reset` from Next.js. */
  readonly reset: () => void;
  readonly back: ErrorBackLink;
}

/**
 * The error page of a route segment (`error.tsx`): "Try again" asks the server for the segment again
 * (`router.refresh()`) and re-renders it (`reset()`) in one transition, so an error of a server component is retried,
 * not only the boundary's client state.
 */
export function RouteError({ error, reset, back }: RouteErrorProps) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  return (
    <ErrorView
      reference={referenceOf(error)}
      retrying={retrying}
      onRetry={() => {
        startRetry(() => {
          router.refresh();
          reset();
        });
      }}
      back={back}
    />
  );
}
