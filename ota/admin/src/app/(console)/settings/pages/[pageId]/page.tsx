// `/settings/pages/[pageId]` (README §5, routes.md §9, OAD-015): one content page, through
// `console.settings.pages.get` (`settings:read`, every role), and, at `/settings/pages/new`, the form of a new page
// (`new` is never a page id: ids are `stp_…`).
//
// - **A page.** Owners and admins (`settings:write`) get its form (page-form.tsx): the kind, the title, the body in the
//   Markdown subset with its help, published, listed in the footer and the footer order, saved with
//   `console.settings.pages.update` and `ifMatch` = the version shown here; a body the API refuses is shown next to
//   the line it names. "Delete page" (`console.settings.pages.delete`, the same `ifMatch`) asks no reason; a page that a
//   legal link of the storefront settings names is refused by the API with that reason. Every other role (agent,
//   finance, viewer) sees the page read only, its body as written, with the permission that changing it needs.
// - **A new page** (`settings:write` only; the other roles get a state naming the permission, without a request but
//   `console.auth.me`): the address and the language as well, which are fixed once the page exists. The languages are
//   the storefront settings' (`console.settings.storefront.get`, the default first); when they cannot be read the form
//   takes a typed code and says so. The form carries the idempotency key rendered here, once per render.
//
// A page names its address on the storefront (`/p/<slug>`), and a published one links it, "View on storefront", with
// the storefront origin console.auth.me answers (`ConsoleTenant.storefrontUrl`, `<storefrontUrl>/p/<slug>`; lead
// decision (2f) of 2026-10-30, third batch, FIX-W36-OTA): a draft, and a profile without the origin (an answer from
// before the field), get no link.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this
// page, an ended session to the portal (`redirectOnSessionError`), an id that is not a page id (never sent) and
// `404 NOT_FOUND` render the page's own "not found" state inside the shell, and every other API error renders the
// console's message for its code with the request id and "Try again".
import type { StaffPermission, StorefrontPage, StorefrontSettings } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";

import { formatInstant } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { Badge } from "@/components/ui/badge";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import {
  NEW_PAGE_PATH,
  NEW_PAGE_SEGMENT,
  PAGE_ID_PATTERN,
  PAGES_PATH,
  SETTINGS_READ,
  SETTINGS_WRITE,
  pageKindLabel,
  pagePath,
  storefrontPageUrlOf,
  storefrontPathOf,
} from "../../content-rules";
import { DeletePageDialog, PageForm } from "../page-form";

export const metadata: Metadata = { title: "Content page" };

const PAGE_STRINGS = Object.freeze({
  back: "All pages",
  retry: "Try again",
  newTitle: "New content page",
  newIntro:
    "Choose the page's address and language first: both are fixed once the page exists, and a translation is another page with the same address. A new page is a draft until you publish it.",
  unavailableTitle: "The page could not be loaded",
  forbiddenTitle: "You cannot open the content pages",
  newForbiddenTitle: "You cannot create content pages",
  notFoundTitle: "Page not found",
  notFound: "This OTA has no content page with this id. It may have been deleted, or the link is wrong.",
  version: (version: number, updated: string) => `Version ${version}, last changed ${updated}.`,
  address: "Address on the storefront",
  addressNote: "on your storefront's domain",
  viewOnStorefront: "View on storefront",
  opensInNewTab: " (opens in a new tab)",
  published: "Published. The storefront shows a change within 5 minutes.",
  publishedSince: (since: string) =>
    `Published since ${since}. The storefront shows a change within 5 minutes.`,
  draft: "A draft: the storefront does not show it until it is published.",
  publishedBadge: "Published",
  draftBadge: "Draft",
  footerBadge: "In the footer",
  readOnly: "Read only: changing pages needs the permission settings:write.",
  shared: "Pages are shared by the test and live environments.",
  details: {
    kind: "Kind",
    language: "Language",
    footer: "Footer",
    order: "Footer order",
    body: "Body (Markdown subset)",
  },
  inFooter: "Listed in the footer",
  notInFooter: "Not listed in the footer",
  emptyBody: "No body yet.",
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const READ_PERMISSION: StaffPermission = SETTINGS_READ;
const WRITE_PERMISSION: StaffPermission = SETTINGS_WRITE;

/**
 * An error of the OTA API as the page's state: `TOKEN_EXPIRED` and an ended session redirect (Next.js's redirect is
 * thrown on), anything that is not an API error is thrown for the error boundary, and an API error is returned.
 */
async function apiFailure(error: unknown, here: string): Promise<VelexisErrorLike> {
  if (!isVelexisErrorLike(error)) {
    throw error;
  }
  try {
    await redirectOnSessionError(error, here);
  } catch (thrown) {
    // `redirectOnSessionError` throws the same error back when it is not about the session.
    if (thrown !== error) {
      throw thrown;
    }
  }
  return error;
}

/** The local refusal of a role without `permission`, in the words of the API's `403 FORBIDDEN`. */
function Forbidden({ title, permission }: { readonly title: string; readonly permission: StaffPermission }) {
  return (
    <ErrorState
      title={title}
      description={{
        message: errorMessage({
          code: "FORBIDDEN",
          status: 403,
          requestId: null,
          fieldErrors: [],
          retryable: false,
          details: { requiredPermission: permission },
        }),
      }}
    >
      <Link href={PAGES_PATH} className={LINK_CLASS}>
        {PAGE_STRINGS.back}
      </Link>
    </ErrorState>
  );
}

/** "Page not found", inside the shell. */
function NotFound() {
  return (
    <ErrorState title={PAGE_STRINGS.notFoundTitle} description={{ message: PAGE_STRINGS.notFound }}>
      <Link href={PAGES_PATH} className={LINK_CLASS}>
        {PAGE_STRINGS.back}
      </Link>
    </ErrorState>
  );
}

/** The storefront's languages, the default first, or `undefined` when they could not be read (session failures redirect). */
async function storefrontLocales(
  request: ConsoleRequest,
  here: string,
): Promise<{ readonly locales: readonly string[]; readonly defaultLocale: string } | undefined> {
  let settings: StorefrontSettings;
  try {
    settings = await request.console.settings.storefront.get();
  } catch (error) {
    await apiFailure(error, here);
    return undefined;
  }
  const { default: defaultLocale, supported } = settings.locales;
  return { locales: [...new Set([defaultLocale, ...supported])], defaultLocale };
}

/**
 * `/settings/pages/new`: the form of a new page, for owners and admins. Called, not rendered as an async component, so
 * the page awaits the storefront's languages itself.
 */
async function newPageView(request: ConsoleRequest) {
  if (!can(request.staff, WRITE_PERMISSION)) {
    return <Forbidden title={PAGE_STRINGS.newForbiddenTitle} permission={WRITE_PERMISSION} />;
  }
  const languages = await storefrontLocales(request, NEW_PAGE_PATH);
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Link href={PAGES_PATH} className={LINK_CLASS}>
          {PAGE_STRINGS.back}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.newTitle}</h1>
        <p className="max-w-3xl text-muted-foreground">{PAGE_STRINGS.newIntro}</p>
        <p className="max-w-3xl text-sm text-muted-foreground">{PAGE_STRINGS.shared}</p>
      </div>
      <PageForm
        mode="create"
        idempotencyKey={crypto.randomUUID()}
        locales={languages?.locales}
        defaultLocale={languages?.defaultLocale ?? request.staff.tenant.defaultLocale}
      />
    </div>
  );
}

/** A page as the roles without `settings:write` see it: its fields as text and its body as written. */
function PageDetails({ page }: { readonly page: StorefrontPage }) {
  const rows: readonly (readonly [string, string])[] = [
    [PAGE_STRINGS.details.kind, pageKindLabel(page.kind)],
    [PAGE_STRINGS.details.language, page.locale],
    [PAGE_STRINGS.details.footer, page.showInFooter ? PAGE_STRINGS.inFooter : PAGE_STRINGS.notInFooter],
    [PAGE_STRINGS.details.order, String(page.sortOrder)],
  ];
  return (
    <div className="grid max-w-4xl gap-4">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-medium">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <section className="grid gap-2">
        <h2 className="text-base font-semibold">{PAGE_STRINGS.details.body}</h2>
        {page.bodyMarkdown === "" ? (
          <p className="text-sm text-muted-foreground">{PAGE_STRINGS.emptyBody}</p>
        ) : (
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
            {page.bodyMarkdown}
          </pre>
        )}
      </section>
    </div>
  );
}

export default async function ContentPagePage({ params }: Readonly<{ params: Promise<{ pageId: string }> }>) {
  const { pageId } = await params;
  const isNew = pageId === NEW_PAGE_SEGMENT;
  const valid = PAGE_ID_PATTERN.test(pageId);
  // Where an expired session comes back to: this page (an id that is not one is never put into the URL).
  const here = isNew ? NEW_PAGE_PATH : valid ? pagePath(pageId) : PAGES_PATH;

  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, here);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }
  const { staff, environment } = request;

  if (!can(staff, READ_PERMISSION)) {
    return <Forbidden title={PAGE_STRINGS.forbiddenTitle} permission={READ_PERMISSION} />;
  }
  if (isNew) {
    return newPageView(request);
  }
  if (!valid) {
    // The API would refuse it (`400 VALIDATION_FAILED`): no request.
    return <NotFound />;
  }

  let page: StorefrontPage;
  try {
    page = await request.console.settings.pages.get({ pageId });
  } catch (error) {
    const failure = await apiFailure(error, here);
    if (failure.code === "NOT_FOUND") {
      return <NotFound />;
    }
    return (
      <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
        <a href={here} className={LINK_CLASS}>
          {PAGE_STRINGS.retry}
        </a>
        <Link href={PAGES_PATH} className={LINK_CLASS}>
          {PAGE_STRINGS.back}
        </Link>
      </ErrorState>
    );
  }

  const timeZone = staff.tenant.timeZone;
  const canWrite = can(staff, WRITE_PERMISSION);
  const storefrontHref = page.isPublished
    ? storefrontPageUrlOf(staff.tenant.storefrontUrl, page.slug)
    : undefined;
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Link href={PAGES_PATH} className={LINK_CLASS}>
          {PAGE_STRINGS.back}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{page.title}</h1>
          {page.isPublished ? (
            <Badge variant="secondary">{PAGE_STRINGS.publishedBadge}</Badge>
          ) : (
            <Badge variant="outline">{PAGE_STRINGS.draftBadge}</Badge>
          )}
          {page.showInFooter ? <Badge variant="outline">{PAGE_STRINGS.footerBadge}</Badge> : null}
          <Badge variant="outline">{page.locale}</Badge>
        </div>
        <p className="text-sm">
          {PAGE_STRINGS.address}: <code>{storefrontPathOf(page.slug)}</code>{" "}
          <span className="text-muted-foreground">{PAGE_STRINGS.addressNote}</span>
          {storefrontHref === undefined ? null : (
            <>
              {" "}
              <a
                href={storefrontHref}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK_CLASS}
                data-storefront-link=""
              >
                {PAGE_STRINGS.viewOnStorefront}
                <span className="sr-only">{PAGE_STRINGS.opensInNewTab}</span>
              </a>
            </>
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          {PAGE_STRINGS.version(page.version, formatInstant(page.updatedAt, timeZone))}
        </p>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {!page.isPublished
            ? PAGE_STRINGS.draft
            : page.publishedAt === null
              ? PAGE_STRINGS.published
              : PAGE_STRINGS.publishedSince(formatInstant(page.publishedAt, timeZone))}{" "}
          {PAGE_STRINGS.shared}
        </p>
      </div>
      {canWrite ? (
        <>
          <PageForm
            mode="edit"
            pageId={page.id}
            version={page.version}
            values={{
              kind: page.kind,
              title: page.title,
              bodyMarkdown: page.bodyMarkdown,
              isPublished: page.isPublished,
              showInFooter: page.showInFooter,
              sortOrder: page.sortOrder,
            }}
          />
          <div>
            <DeletePageDialog
              pageId={page.id}
              title={page.title}
              slug={page.slug}
              locale={page.locale}
              version={page.version}
              environment={environment}
              idempotencyKey={crypto.randomUUID()}
            />
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{PAGE_STRINGS.readOnly}</p>
          <PageDetails page={page} />
        </>
      )}
    </div>
  );
}
