import type { Metadata } from "next";

import { NotFoundView } from "@/components/not-found-view";
import { NOT_FOUND_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: NOT_FOUND_STRINGS.title };

/**
 * The not-found page of the signed-in area (README §5, known issue KI-007): what `notFound()` renders for a page of
 * the shell, such as an OTA the account is not a member of (any more) or an id that is none (`requireTenant`, the OTA
 * layout and its pages; the API answers both with `404`, so the words do not say which). Next.js renders it inside
 * `(app)/layout.tsx`, so it sits in the shell's `<main>` with the navigation around it, and leads back to My OTAs.
 * The answer's status stays `404`.
 *
 * It renders its own `<title>` (React hoists it into the head, as Next.js's default not-found page does): caught by
 * this boundary below the root, the request keeps the metadata of the page it asked for ("Overview"), and the
 * `metadata` above applies only when Next.js renders the not-found page on its own.
 */
export default function SignedInNotFound() {
  return (
    <>
      <title>{`${NOT_FOUND_STRINGS.title} · Velexis`}</title>
      <NotFoundView
        text={NOT_FOUND_STRINGS.signedInText}
        links={[{ href: "/dashboard", label: NOT_FOUND_STRINGS.dashboardLink }]}
      />
    </>
  );
}
