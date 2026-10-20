import type { components } from "@velexis/api-types/platform";
import { CircleCheck, CircleDashed } from "lucide-react";
import Link from "next/link";

import { ONBOARDING_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/** One item of `getOnboarding` (PADR-0018). */
export type OnboardingItem = components["schemas"]["OnboardingItem"];

/** Where an item's link goes: a page of the portal, the storefront, or nowhere (a link the portal does not trust). */
export type ChecklistLink =
  | { readonly kind: "portal"; readonly href: string }
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "none" };

/**
 * The link of an item's `href`: a portal path (`/account/security`, `/otas/<id>/api-keys`; one leading `/`, no
 * backslash or control character), or an `https:` URL (the storefront of `storefront_open`). Anything else (another
 * scheme, a protocol-relative `//host`) renders as text: the API sends only these two kinds, and a link is never
 * built from what the portal cannot vouch for.
 */
export function checklistLink(href: string): ChecklistLink {
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/[\\\u0000-\u001f\u007f]/.test(href)) {
    return { kind: "none" };
  }
  if (href.startsWith("/")) {
    return href.startsWith("//") ? { kind: "none" } : { kind: "portal", href };
  }
  try {
    const url = new URL(href);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? { kind: "external", href: url.href }
      : { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}

const LINK_CLASSES = "font-medium underline-offset-4 hover:underline";

function ItemLink({ item }: { readonly item: OnboardingItem }) {
  const link = checklistLink(item.href);
  if (link.kind === "portal") {
    return (
      <Link href={link.href} className={LINK_CLASSES}>
        {item.label}
      </Link>
    );
  }
  if (link.kind === "external") {
    // The storefront: a site of its own, opened in the same tab like any other step.
    return (
      <a href={link.href} className={LINK_CLASSES}>
        {item.label}
      </a>
    );
  }
  return <span className="font-medium">{item.label}</span>;
}

export interface OnboardingChecklistProps {
  /** The items of `getOnboarding`, in its order (account items for the caller, M5 items only while switched on). */
  readonly items: readonly OnboardingItem[];
  readonly className?: string;
}

/**
 * The onboarding checklist of the OTA dashboard (README §4, PADR-0018, PF-12): every item of `getOnboarding`, in the
 * API's order, with its label as a link to the page that completes it and its state in words ("Done" or "To do"), so
 * the state never rests on the icon alone. Done items stay in the list: it is computed on every request and the
 * portal stores nothing about it. A server component without state.
 */
export function OnboardingChecklist({ items, className }: OnboardingChecklistProps) {
  const done = items.filter((item) => item.done).length;
  return (
    <section
      aria-labelledby="onboarding-title"
      className={cn("grid gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs", className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="onboarding-title" className="text-lg font-semibold tracking-tight">
          {ONBOARDING_STRINGS.title}
        </h2>
        {items.length === 0 ? null : (
          <p className="text-sm text-muted-foreground" data-testid="onboarding-progress">
            {ONBOARDING_STRINGS.progress(done, items.length)}
          </p>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{ONBOARDING_STRINGS.intro}</p>
      {items.length === 0 ? (
        <p className="text-sm">{ONBOARDING_STRINGS.empty}</p>
      ) : (
        <ol aria-labelledby="onboarding-title" className="grid gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              data-item={item.id}
              data-done={item.done ? "true" : "false"}
              className="flex items-center gap-3 rounded-lg border px-3 py-2"
            >
              {item.done ? (
                <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-emerald-700" />
              ) : (
                <CircleDashed aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <ItemLink item={item} />
              </span>
              <span
                data-state
                className={cn("shrink-0 text-sm", item.done ? "text-emerald-900" : "text-muted-foreground")}
              >
                {item.done ? ONBOARDING_STRINGS.done : ONBOARDING_STRINGS.toDo}
              </span>
            </li>
          ))}
        </ol>
      )}
      {items.length > 0 && done === items.length ? (
        <p className="text-sm font-medium">{ONBOARDING_STRINGS.allDone}</p>
      ) : null}
    </section>
  );
}
