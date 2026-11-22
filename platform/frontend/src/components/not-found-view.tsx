import { SearchX } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { NOT_FOUND_STRINGS } from "@/lib/strings";

/** A way back from the not-found page. */
export interface NotFoundLink {
  readonly href: string;
  readonly label: string;
}

export interface NotFoundViewProps {
  /** What the page says under its heading. */
  readonly text: string;
  /** The ways back, the first one as the main action. */
  readonly links: readonly NotFoundLink[];
}

/**
 * The content of the portal's not-found pages (README §5, known issue KI-007): the page's one `h1`, what happened in
 * the portal's words and the ways back. A server component without data; the page around it decides the landmark
 * (`app/not-found.tsx` renders its own `<main>`, `app/(app)/not-found.tsx` sits in the signed-in shell's).
 */
export function NotFoundView({ text, links }: NotFoundViewProps) {
  return (
    <section
      aria-labelledby="not-found-title"
      data-page="not-found"
      className="mx-auto grid max-w-xl gap-4 py-8"
    >
      <SearchX aria-hidden="true" className="size-8 text-muted-foreground" />
      <h1 id="not-found-title" className="text-3xl font-semibold tracking-tight">
        {NOT_FOUND_STRINGS.title}
      </h1>
      <p>{text}</p>
      <ul className="flex flex-wrap gap-3">
        {links.map((link, index) => (
          <li key={link.href}>
            <Button asChild variant={index === 0 ? "default" : "outline"}>
              <Link href={link.href} prefetch={false}>
                {link.label}
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
