// `/queues/[queueId]` (README §5, routes.md §5, OAD-009): one Amadeus office queue of the OTA in the environment of the
// switch (`queues:read`: owner, admin, agent), as the booking queue view where staff spot the PNRs no booking owns before
// cleaning the queue in Amadeus by hand (OADR-0003 follow-up, backend README "Runbook: cleaning the booking queue").
//
// - Without `read` or `cursor` the page shows the last stored read of the queue, with its PNRs
//   (`console.queues.listSnapshots({ queueId, officeId, category, limit: 1, include: ["items"] })`, no Amadeus call):
//   the scheduled poller's or a staff member's.
// - "Read now" is a GET form to `?read=1`: `console.queues.list({ queueId, officeId, category, limit })` reads Amadeus
//   (Queue List) and stores the read as a snapshot, whose first page it shows; "Next page" pages that stored snapshot
//   with the API's `cursor` (`?cursor=…`, the snapshot's office and category kept, as the API binds a cursor to them),
//   without calling Amadeus again. An expired session comes back to the stored view, never to a second read.
// - Each PNR links to the OTA's booking of its record locator (the API's `bookingId`, `bookingReference`,
//   `bookingStatus`), or is an orphan, marked "No booking", with "Import", which opens `/pnr?recordLocator=…`
//   (queue-views.tsx). No queue item actions (remove, move) in the MVP (scope §2.3).
// - "Earlier reads": the queue's newest stored snapshots (`listSnapshots({ …, limit: 10 })`): when, by whom, how many PNRs.
//
// The URL's values are checked as the API checks them (a queue number from 0 to 99, a category from 0 to 254, an office
// id of 9 letters and digits): a value the API would refuse is never sent. Next.js hides a server component's error from
// `error.tsx` in production, so the codes the console can answer are handled here, on the server (routes.md §1,
// OAD-004): `TOKEN_EXPIRED` goes to `/auth/refresh?next=`, an ended session to the portal (`redirectOnSessionError`),
// `403 OFFICE_NOT_ALLOWED` (an office the OTA's connection does not hold) and every other API error render the
// console's message for the code with the request id, a cursor the API no longer takes asks to open the queue again.
import type { ConsoleApi, ConsoleQueuePage, QueueItem, QueueSnapshot } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { formatInstant } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeError, errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import {
  CATEGORY_MAX,
  CATEGORY_PARAM,
  CURSOR_PARAM,
  MAX_CURSOR_LENGTH,
  OFFICE_ID_PATTERN,
  OFFICE_PARAM,
  QUEUES_PATH,
  QUEUES_PERMISSION,
  QUEUE_ID_MAX,
  QueueItemsTable,
  QueueWarnings,
  READ_PARAM,
  actorText,
  parseQueueNumber,
  queueHref,
  type QueueScope,
} from "../queue-views";

export const metadata: Metadata = { title: "Queue" };

const PAGE_STRINGS = Object.freeze({
  title: (queueId: number) => `Queue ${queueId}`,
  back: "All queues",
  scope: (office: string | undefined, category: number | undefined) =>
    `${office === undefined ? "The OTA's queuing office" : `Office ${office}`} · category ${category ?? 0}`,
  readNow: "Read now from Amadeus",
  readHint:
    "Reads the queue in Amadeus now and stores the read as a snapshot; its pages come from that snapshot.",
  // The read's own office and category: a URL without them shows the newest stored read of any office and category.
  fresh: (at: string, by: string, count: number, office: string, category: number) =>
    `Read from Amadeus at ${at} by ${by} (office ${office}, category ${category}): ${count} PNR${count === 1 ? "" : "s"}.`,
  stored: (at: string, by: string, count: number, office: string, category: number) =>
    `Last stored read, at ${at} by ${by} (office ${office}, category ${category}): ${count} PNR${count === 1 ? "" : "s"}. Read now for the queue as it is.`,
  notRead: "This queue has not been read in this environment yet. Read now to see its PNRs.",
  pnrs: "PNRs",
  pages: "Pages",
  nextPage: "Next page",
  history: "Earlier reads",
  historyCaption: (queueId: number) => `Stored reads of queue ${queueId}`,
  noHistory: "No stored read yet.",
  historyUnavailable: "The earlier reads could not be loaded.",
  notFoundTitle: "No such queue",
  notFound: `Amadeus queue numbers go from 0 to ${QUEUE_ID_MAX}.`,
  invalidTitle: "This link has values the queue cannot use",
  invalid: (labels: string) => `Not valid: ${labels}.`,
  clear: "Open the queue without them",
  staleCursorTitle: "This page of the read is no longer available",
  staleCursor: "The stored read it pages may have expired (reads are kept 30 days). Open the queue again.",
  unavailableTitle: "The queue could not be read",
  forbiddenTitle: "You cannot open the queues",
  retry: "Try again",
  columns: {
    readAt: "Read at",
    readBy: "Read by",
    pnrs: "PNRs",
    office: "Office",
    category: "Category",
  },
  parameters: {
    [OFFICE_PARAM]: "Office",
    [CATEGORY_PARAM]: "Category",
    [CURSOR_PARAM]: "Page",
  } as Readonly<Record<string, string>>,
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const PAGE_LINK_CLASS =
  "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

/** PNRs per page of a fresh read. */
const PAGE_SIZE = 50;
/** The stored reads "Earlier reads" lists. */
const HISTORY_SIZE = 10;

type SearchParams = Record<string, string | string[] | undefined>;

/** The one value of a search parameter (the first of a repeated one). */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

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

// ---- The URL ----------------------------------------------------------------------------------------------------------

/** What the page shows: the stored read, a fresh read (`read=1`), or a later page of one (`cursor`). */
type View =
  | { readonly kind: "stored" }
  | { readonly kind: "read" }
  | { readonly kind: "page"; readonly cursor: string };

/** The queue and the view a URL asks for, or the names of its parameters the API would refuse. */
type Parsed =
  | { readonly ok: true; readonly scope: QueueScope; readonly view: View }
  | { readonly ok: false; readonly invalid: readonly string[] };

function parseQuery(queueId: number, query: SearchParams): Parsed {
  const invalid: string[] = [];
  const officeText = firstOf(query[OFFICE_PARAM])?.trim().toUpperCase();
  const officeId = officeText === undefined || officeText === "" ? undefined : officeText;
  if (officeId !== undefined && !OFFICE_ID_PATTERN.test(officeId)) {
    invalid.push(OFFICE_PARAM);
  }
  const category = parseQueueNumber(firstOf(query[CATEGORY_PARAM]), CATEGORY_MAX);
  if (category === null) {
    invalid.push(CATEGORY_PARAM);
  }
  const cursor = firstOf(query[CURSOR_PARAM]);
  if (
    cursor !== undefined &&
    (cursor === "" || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor))
  ) {
    invalid.push(CURSOR_PARAM);
  }
  if (invalid.length > 0 || category === null) {
    return { ok: false, invalid };
  }
  const scope: QueueScope = { queueId, officeId, category };
  if (cursor !== undefined) {
    return { ok: true, scope, view: { kind: "page", cursor } };
  }
  return { ok: true, scope, view: { kind: firstOf(query[READ_PARAM]) === "1" ? "read" : "stored" } };
}

/** The filters of the API's queue operations for `scope` (only those the URL names). */
function scopeParams(scope: QueueScope): { officeId?: string; category?: number } {
  return {
    ...(scope.officeId === undefined ? {} : { officeId: scope.officeId }),
    ...(scope.category === undefined ? {} : { category: scope.category }),
  };
}

// ---- Loading ----------------------------------------------------------------------------------------------------------

/** The PNRs the page shows and the read they come from (none for a queue that was never read). */
type Shown =
  | { readonly kind: "fresh"; readonly page: ConsoleQueuePage }
  | { readonly kind: "stored"; readonly snapshot: QueueSnapshot | undefined };

type Load =
  { readonly ok: true; readonly shown: Shown } | { readonly ok: false; readonly error: VelexisErrorLike };

async function loadView(con: ConsoleApi, scope: QueueScope, view: View, here: string): Promise<Load> {
  try {
    if (view.kind === "stored") {
      const stored = await con.queues.listSnapshots({
        queueId: scope.queueId,
        ...scopeParams(scope),
        limit: 1,
        include: ["items"],
      });
      return { ok: true, shown: { kind: "stored", snapshot: stored.data[0] } };
    }
    const page = await con.queues.list({
      queueId: scope.queueId,
      ...scopeParams(scope),
      limit: PAGE_SIZE,
      ...(view.kind === "page" ? { cursor: view.cursor } : {}),
    });
    return { ok: true, shown: { kind: "fresh", page } };
  } catch (error) {
    return { ok: false, error: await apiFailure(error, here) };
  }
}

/** The queue's newest stored reads, or the API's refusal (shown in place of the list, never instead of the page). */
async function loadHistory(
  con: ConsoleApi,
  scope: QueueScope,
  here: string,
): Promise<
  | { readonly ok: true; readonly snapshots: QueueSnapshot[] }
  | { readonly ok: false; readonly error: VelexisErrorLike }
> {
  try {
    const page = await con.queues.listSnapshots({
      queueId: scope.queueId,
      ...scopeParams(scope),
      limit: HISTORY_SIZE,
    });
    return { ok: true, snapshots: page.data };
  } catch (error) {
    return { ok: false, error: await apiFailure(error, here) };
  }
}

// ---- Pieces -----------------------------------------------------------------------------------------------------------

/** The heading, the queue's office and category, "Read now" and the way back. */
function QueueHeader({ scope }: { readonly scope: QueueScope }) {
  return (
    <header className="grid gap-3">
      <Link href={QUEUES_PATH} className={LINK_CLASS}>
        {PAGE_STRINGS.back}
      </Link>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title(scope.queueId)}</h1>
        <p className="text-muted-foreground">{PAGE_STRINGS.scope(scope.officeId, scope.category)}</p>
      </div>
      {/* A GET form, so "Read now" is a link-like request that works without JavaScript and is never prefetched. */}
      <form
        method="get"
        action={queueHref({ queueId: scope.queueId })}
        className="grid justify-items-start gap-1"
      >
        {scope.officeId === undefined ? null : (
          <input type="hidden" name={OFFICE_PARAM} value={scope.officeId} />
        )}
        {scope.category === undefined ? null : (
          <input type="hidden" name={CATEGORY_PARAM} value={String(scope.category)} />
        )}
        <input type="hidden" name={READ_PARAM} value="1" />
        <Button type="submit" variant="outline" size="sm" aria-describedby="queue-read-hint">
          {PAGE_STRINGS.readNow}
        </Button>
        <p id="queue-read-hint" className="text-xs text-muted-foreground">
          {PAGE_STRINGS.readHint}
        </p>
      </form>
    </header>
  );
}

/** The PNRs of the read the page shows, with the read's facts, its warnings and, for a fresh read, its next page. */
function QueueItems({
  scope,
  shown,
  timeZone,
}: {
  readonly scope: QueueScope;
  readonly shown: Shown;
  readonly timeZone: string;
}) {
  let snapshot: QueueSnapshot | undefined;
  let items: readonly QueueItem[];
  let nextCursor: string | null = null;
  if (shown.kind === "fresh") {
    snapshot = shown.page.snapshot;
    items = shown.page.data;
    nextCursor = shown.page.page.nextCursor;
  } else {
    snapshot = shown.snapshot;
    items = snapshot?.items ?? [];
  }
  return (
    <section aria-labelledby="queue-items-heading" className="grid gap-3">
      <h2 id="queue-items-heading" className="text-lg font-semibold">
        {PAGE_STRINGS.pnrs}
      </h2>
      {snapshot === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {PAGE_STRINGS.notRead}
        </p>
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {(shown.kind === "fresh" ? PAGE_STRINGS.fresh : PAGE_STRINGS.stored)(
              formatInstant(snapshot.fetchedAt, timeZone),
              actorText(snapshot.fetchedBy),
              snapshot.itemCount,
              snapshot.officeId,
              snapshot.category,
            )}
          </p>
          <QueueWarnings warnings={snapshot.warnings} />
          <QueueItemsTable queueId={scope.queueId} items={items} />
          {nextCursor === null ? null : (
            <nav aria-label={PAGE_STRINGS.pages} className="flex justify-end">
              <Link
                href={queueHref(
                  { queueId: snapshot.queueId, officeId: snapshot.officeId, category: snapshot.category },
                  { cursor: nextCursor },
                )}
                prefetch={false}
                className={PAGE_LINK_CLASS}
              >
                {PAGE_STRINGS.nextPage}
              </Link>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

/** "Earlier reads": the queue's newest stored snapshots. */
function History({
  queueId,
  history,
  timeZone,
}: {
  readonly queueId: number;
  readonly history: Awaited<ReturnType<typeof loadHistory>>;
  readonly timeZone: string;
}) {
  const columns = Object.values(PAGE_STRINGS.columns);
  return (
    <section aria-labelledby="queue-history-heading" className="grid gap-3">
      <h2 id="queue-history-heading" className="text-lg font-semibold">
        {PAGE_STRINGS.history}
      </h2>
      {history.ok ? (
        <Table>
          <TableCaption className="sr-only">{PAGE_STRINGS.historyCaption(queueId)}</TableCaption>
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
            {history.snapshots.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-16 text-center text-muted-foreground">
                  {PAGE_STRINGS.noHistory}
                </TableCell>
              </TableRow>
            ) : (
              history.snapshots.map((snapshot) => (
                <TableRow key={snapshot.id}>
                  <TableCell>
                    <time dateTime={snapshot.fetchedAt}>{formatInstant(snapshot.fetchedAt, timeZone)}</time>
                  </TableCell>
                  <TableCell>{actorText(snapshot.fetchedBy)}</TableCell>
                  <TableCell className="tabular-nums">{snapshot.itemCount}</TableCell>
                  <TableCell className="font-mono">{snapshot.officeId}</TableCell>
                  <TableCell>{snapshot.category}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      ) : (
        <p role="alert" className="text-sm text-destructive">
          {PAGE_STRINGS.historyUnavailable} {describeError(history.error).message}
          {history.error.requestId === null ? "" : ` (request id ${history.error.requestId})`}
        </p>
      )}
    </section>
  );
}

function QueueShell({ scope, children }: { readonly scope: QueueScope; readonly children: ReactNode }) {
  return (
    <div className="grid gap-6">
      <QueueHeader scope={scope} />
      {children}
    </div>
  );
}

/** The page's state for a queue number the API would refuse: no request. */
function NotFound() {
  return (
    <ErrorState title={PAGE_STRINGS.notFoundTitle} description={{ message: PAGE_STRINGS.notFound }}>
      <Link href={QUEUES_PATH} className={LINK_CLASS}>
        {PAGE_STRINGS.back}
      </Link>
    </ErrorState>
  );
}

export default async function QueuePage({
  params,
  searchParams,
}: Readonly<{ params: Promise<{ queueId: string }>; searchParams: Promise<SearchParams> }>) {
  const { queueId: queueText } = await params;
  const query = await searchParams;
  const queueId = parseQueueNumber(queueText, QUEUE_ID_MAX);
  const parsed = queueId === undefined || queueId === null ? undefined : parseQuery(queueId, query);
  // Where an expired session comes back to: the queue's stored view (or the same page of a read), never a new read.
  const here =
    parsed?.ok === true
      ? queueHref(parsed.scope, parsed.view.kind === "page" ? { cursor: parsed.view.cursor } : {})
      : QUEUES_PATH;

  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, here);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }
  const { staff } = request;

  if (!can(staff, QUEUES_PERMISSION)) {
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
            details: { requiredPermission: QUEUES_PERMISSION },
          }),
        }}
      />
    );
  }

  if (queueId === undefined || queueId === null || parsed === undefined) {
    return <NotFound />;
  }
  if (!parsed.ok) {
    const scope: QueueScope = { queueId };
    return (
      <QueueShell scope={scope}>
        <section role="alert" className="grid max-w-xl gap-3">
          <h2 className="text-xl font-semibold">{PAGE_STRINGS.invalidTitle}</h2>
          <p>
            {PAGE_STRINGS.invalid(
              parsed.invalid.map((name) => PAGE_STRINGS.parameters[name] ?? name).join(", "),
            )}
          </p>
          <Link href={queueHref(scope)} className={LINK_CLASS}>
            {PAGE_STRINGS.clear}
          </Link>
        </section>
      </QueueShell>
    );
  }

  const { scope, view } = parsed;
  const timeZone = staff.tenant.timeZone;
  const loaded = await loadView(request.console, scope, view, here);
  if (!loaded.ok) {
    const { error } = loaded;
    if (view.kind === "page" && error.code === "VALIDATION_FAILED") {
      return (
        <QueueShell scope={scope}>
          <ErrorState
            title={PAGE_STRINGS.staleCursorTitle}
            description={{ message: PAGE_STRINGS.staleCursor, ...describeRequestId(error) }}
          >
            <Link href={queueHref(scope)} className={LINK_CLASS}>
              {PAGE_STRINGS.title(scope.queueId)}
            </Link>
          </ErrorState>
        </QueueShell>
      );
    }
    return (
      <QueueShell scope={scope}>
        <ErrorState title={PAGE_STRINGS.unavailableTitle} error={error}>
          {/* The same view again: a stored view or a page reads no Amadeus; a read is read again on this click only. */}
          <a
            href={queueHref(
              scope,
              view.kind === "page" ? { cursor: view.cursor } : { read: view.kind === "read" },
            )}
            className={LINK_CLASS}
          >
            {PAGE_STRINGS.retry}
          </a>
        </ErrorState>
      </QueueShell>
    );
  }

  const history = await loadHistory(request.console, scope, here);
  return (
    <QueueShell scope={scope}>
      <QueueItems scope={scope} shown={loaded.shown} timeZone={timeZone} />
      <History queueId={scope.queueId} history={history} timeZone={timeZone} />
    </QueueShell>
  );
}

/** The request id of an error as an error description takes it. */
function describeRequestId(error: VelexisErrorLike): { readonly requestId?: string } {
  return error.requestId === null || error.requestId === "" ? {} : { requestId: error.requestId };
}
