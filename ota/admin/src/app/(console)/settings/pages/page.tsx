// `/settings/pages` (README §5, routes.md §9, OAD-015): the content pages of the hosted storefront (terms, privacy, FAQ
// and the OTA's own pages), through `console.settings.pages.list` (`settings:read`, every role), drafts included, in
// the API's order (footer order, then address, then language), with its `locale` and `published` filters and cursor
// paging. Pages are shared by the test and live environments.
//
// The URL is the state: `locale` (one language, typed in the filter and put in the API's spelling: `fr_ca` is `fr-CA`),
// `published` (`true` the published pages,
// `false` the drafts; none: every page) and `cursor` (the `page.nextCursor` of the previous page, which "Next page"
// sets and "First page" drops). A link with a value the API would refuse is never sent: the page says so, with a link
// to every page. Each row: the title (a link to the page), its address on the storefront (`/p/<slug>`), the language,
// the kind, published (since when) or draft, listed in the footer, the footer order and the last change in the OTA's
// time zone.
//
// Owners and admins (`settings:write`) get "New page" (`/settings/pages/new`); every other role sees the list read only
// (the button disabled, naming the permission).
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this
// list, an ended session to the portal (`redirectOnSessionError`), and every other API error renders the console's
// message for its code with the request id, with "Try again" (and "First page" for `400 VALIDATION_FAILED`, a cursor
// the API refused).
import type { StaffPermission, StorefrontPage } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { formatInstant, queryOf } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { PermissionGate } from "@/components/permission-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { cn } from "@/lib/utils";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import {
  NEW_PAGE_PATH,
  PAGES_PAGE_SIZE,
  PAGES_PATH,
  SETTINGS_READ,
  SETTINGS_WRITE,
  pageKindLabel,
  pageListHref,
  pageListQueryOf,
  pagePath,
  storefrontPathOf,
  type PageListQuery,
} from "../content-rules";

export const metadata: Metadata = { title: "Content pages" };

const PAGE_STRINGS = Object.freeze({
  title: "Content pages",
  intro:
    "The pages of the hosted storefront: terms, privacy, FAQ and your own pages, written in a Markdown subset, one page per address and language. They are shared by the test and live environments, and the storefront shows a change within 5 minutes.",
  readOnly: "Read only: creating, changing and deleting pages needs the permission settings:write.",
  newPage: "New page",
  filters: "Page status",
  all: "All pages",
  published: "Published",
  drafts: "Drafts",
  language: "Language",
  languageHint: "such as en",
  filter: "Filter",
  allLanguages: "All languages",
  pages: "Pages",
  firstPage: "First page",
  nextPage: "Next page",
  columns: {
    title: "Title",
    address: "Address",
    language: "Language",
    kind: "Kind",
    status: "Status",
    footer: "Footer",
    order: "Order",
    updated: "Last changed",
  },
  publishedSince: (since: string) => `Published since ${since}`,
  publishedBadge: "Published",
  draftBadge: "Draft",
  inFooter: "Listed",
  notInFooter: "Not listed",
  empty: "No page matches these filters.",
  emptyAll:
    "No page yet. Create the terms and the privacy policy first, then link them in the storefront settings.",
  unavailableTitle: "The pages could not be loaded",
  forbiddenTitle: "You cannot open the content pages",
  invalidTitle: "This link has a filter the list cannot use",
  invalid: "Its language, its status or its page is not valid.",
  retry: "Try again",
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const PAGE_LINK_CLASS =
  "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";
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

/** The status links (every page, published, drafts) and the language form: the URL is the state. */
function Filters({ list }: { readonly list: Pick<PageListQuery, "locale" | "published"> }) {
  const options: readonly { readonly value: boolean | undefined; readonly label: string }[] = [
    { value: undefined, label: PAGE_STRINGS.all },
    { value: true, label: PAGE_STRINGS.published },
    { value: false, label: PAGE_STRINGS.drafts },
  ];
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <nav aria-label={PAGE_STRINGS.filters} className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Link
            key={option.label}
            href={pageListHref({ locale: list.locale, published: option.value })}
            {...(option.value === list.published ? { "aria-current": "page" as const } : {})}
            className={cn(PAGE_LINK_CLASS, option.value === list.published && "border-primary bg-primary/10")}
          >
            {option.label}
          </Link>
        ))}
      </nav>
      {/* A plain GET form to this page: it needs no JavaScript, and the status filter is kept. */}
      <form method="get" action={PAGES_PATH} className="flex flex-wrap items-end gap-2">
        {list.published === undefined ? null : (
          <input type="hidden" name="published" value={String(list.published)} />
        )}
        <div className="grid gap-1">
          <label htmlFor="pages-locale" className="text-sm font-medium">
            {PAGE_STRINGS.language}
          </label>
          <Input
            id="pages-locale"
            name="locale"
            defaultValue={list.locale ?? ""}
            placeholder={PAGE_STRINGS.languageHint}
            autoComplete="off"
            className="h-8 w-32"
          />
        </div>
        <Button type="submit" variant="outline" size="sm">
          {PAGE_STRINGS.filter}
        </Button>
        {list.locale === undefined ? null : (
          <Link href={pageListHref({ published: list.published })} className={LINK_CLASS}>
            {PAGE_STRINGS.allLanguages}
          </Link>
        )}
      </form>
    </div>
  );
}

/** The pages of one page of the list. */
function PagesTable({
  pages,
  filtered,
  timeZone,
}: {
  readonly pages: readonly StorefrontPage[];
  readonly filtered: boolean;
  readonly timeZone: string;
}) {
  const columns = Object.values(PAGE_STRINGS.columns);
  return (
    <Table>
      <TableCaption className="sr-only">{PAGE_STRINGS.title}</TableCaption>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column} scope="col">
              {column}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {pages.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="h-20 text-center text-muted-foreground">
              {filtered ? PAGE_STRINGS.empty : PAGE_STRINGS.emptyAll}
            </TableCell>
          </TableRow>
        ) : (
          pages.map((page) => (
            <TableRow key={page.id} data-page={page.id}>
              <TableCell>
                <Link
                  href={pagePath(page.id)}
                  className="font-medium text-primary underline underline-offset-4"
                >
                  {page.title}
                </Link>
              </TableCell>
              <TableCell>
                <code className="text-xs">{storefrontPathOf(page.slug)}</code>
              </TableCell>
              <TableCell>{page.locale}</TableCell>
              <TableCell>{pageKindLabel(page.kind)}</TableCell>
              <TableCell>
                {page.isPublished ? (
                  <div className="grid gap-0.5">
                    <Badge variant="secondary">{PAGE_STRINGS.publishedBadge}</Badge>
                    {page.publishedAt === null ? null : (
                      <span className="text-xs text-muted-foreground">
                        {PAGE_STRINGS.publishedSince(formatInstant(page.publishedAt, timeZone))}
                      </span>
                    )}
                  </div>
                ) : (
                  <Badge variant="outline">{PAGE_STRINGS.draftBadge}</Badge>
                )}
              </TableCell>
              <TableCell>{page.showInFooter ? PAGE_STRINGS.inFooter : PAGE_STRINGS.notInFooter}</TableCell>
              <TableCell className="tabular-nums">{page.sortOrder}</TableCell>
              <TableCell>{formatInstant(page.updatedAt, timeZone)}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

/** "First page" on a later page, "Next page" while there is one. */
function Paging({
  list,
  nextCursor,
}: {
  readonly list: Pick<PageListQuery, "locale" | "published" | "cursor">;
  readonly nextCursor: string | null;
}) {
  if (list.cursor === undefined && nextCursor === null) {
    return null;
  }
  return (
    <nav aria-label={PAGE_STRINGS.pages} className="flex flex-wrap justify-end gap-2">
      {list.cursor === undefined ? null : (
        <Link href={pageListHref(list)} className={PAGE_LINK_CLASS}>
          {PAGE_STRINGS.firstPage}
        </Link>
      )}
      {nextCursor === null ? null : (
        <Link href={pageListHref(list, nextCursor)} className={PAGE_LINK_CLASS}>
          {PAGE_STRINGS.nextPage}
        </Link>
      )}
    </nav>
  );
}

/** The heading, the notices and "New page", above whatever the page shows. */
function PageShell({
  request,
  children,
}: {
  readonly request: ConsoleRequest;
  readonly children: ReactNode;
}) {
  const canWrite = can(request.staff, WRITE_PERMISSION);
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
          <p className="max-w-3xl text-muted-foreground">{PAGE_STRINGS.intro}</p>
          {canWrite ? null : <p className="text-sm text-muted-foreground">{PAGE_STRINGS.readOnly}</p>}
        </div>
        <PermissionGate profile={request.staff} permission={WRITE_PERMISSION} label={PAGE_STRINGS.newPage}>
          <Button asChild>
            <Link href={NEW_PAGE_PATH}>{PAGE_STRINGS.newPage}</Link>
          </Button>
        </PermissionGate>
      </div>
      {children}
    </div>
  );
}

export default async function ContentPagesPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const list = pageListQueryOf(queryOf(await searchParams));
  const here = pageListHref(list, list.cursor);

  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, here);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }

  if (!can(request.staff, READ_PERMISSION)) {
    return (
      <ErrorState
        title={PAGE_STRINGS.forbiddenTitle}
        description={{
          message: errorMessage({
            code: "FORBIDDEN",
            status: 403,
            requestId: null,
            fieldErrors: [],
            retryable: false,
            details: { requiredPermission: READ_PERMISSION },
          }),
        }}
      />
    );
  }

  if (list.invalid.length > 0) {
    return (
      <PageShell request={request}>
        <section role="alert" className="grid max-w-xl gap-3">
          <h2 className="text-xl font-semibold">{PAGE_STRINGS.invalidTitle}</h2>
          <p>{PAGE_STRINGS.invalid}</p>
          <Link href={PAGES_PATH} className={LINK_CLASS}>
            {PAGE_STRINGS.all}
          </Link>
        </section>
      </PageShell>
    );
  }

  let pages: StorefrontPage[];
  let nextCursor: string | null;
  try {
    const page = await request.console.settings.pages.list({
      limit: PAGES_PAGE_SIZE,
      ...(list.locale === undefined ? {} : { locale: list.locale }),
      ...(list.published === undefined ? {} : { published: list.published }),
      ...(list.cursor === undefined ? {} : { cursor: list.cursor }),
    });
    pages = page.data;
    nextCursor = page.page.nextCursor;
  } catch (error) {
    const failure = await apiFailure(error, here);
    return (
      <PageShell request={request}>
        <Filters list={list} />
        <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
          {/* The same URL again: the list is read anew. */}
          <a href={here} className={LINK_CLASS}>
            {PAGE_STRINGS.retry}
          </a>
          {failure.code === "VALIDATION_FAILED" ? (
            <Link href={pageListHref(list)} className={LINK_CLASS}>
              {PAGE_STRINGS.firstPage}
            </Link>
          ) : null}
        </ErrorState>
      </PageShell>
    );
  }

  return (
    <PageShell request={request}>
      <Filters list={list} />
      <PagesTable
        pages={pages}
        filtered={list.locale !== undefined || list.published !== undefined}
        timeZone={request.staff.tenant.timeZone}
      />
      <Paging list={list} nextCursor={nextCursor} />
    </PageShell>
  );
}
