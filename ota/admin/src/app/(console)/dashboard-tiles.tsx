// The tiles of the dashboard `/` (README §5, routes.md §2, OAD-005): what the page's server component read, each tile
// with its own permission, and the parameters of those reads. The page (page.tsx) makes every SDK call; these are
// server components without state, data fetching or hooks, so only the HTML they render reaches the browser. A module
// without a directive (a page file may export its page only).
//
//   Needs attention          `console.bookings.list({ …, limit: 1 })` → `totalCount`, one count per saved view of the
//                            bookings list (bookings/views.ts): ticketing failed or in manual review, a ticketing
//                            deadline within 24 h, and an outcome unknown (reconciling, `status=pending`). The
//                            parameters come from the view's own filters (`listParams`), so a count and the list its
//                            card links (`viewHref`) always ask the API the same question (`bookings:read`)
//   Authorised, not captured `console.payments.list({ status: "authorized", limit: 5 })`, linking
//                            `/payments?status=authorized` (`payments:read`)
//   Last queue read          `console.queues.listSnapshots({ limit: 1 })`, linking that queue and `/queues`
//                            (`queues:read`)
//   Latest bookings          `console.bookings.list({ sort: "-created", limit: 10 })`, linking `/bookings`
//                            (`bookings:read`)
//
// A tile whose permission the role does not hold is neither read nor rendered. A read that fails shows its message and
// request id in its tile's place; the other tiles stay.
import type {
  ConsoleBookingPage,
  ConsolePayment,
  ConsoleStaffProfile,
  QueueSnapshot,
  StaffPermission,
} from "@velexis/ota-sdk";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  BOOKING_VIEWS,
  bookingRow,
  formatInstant,
  listParams,
  viewHref,
  type BookingListParams,
  type BookingView,
  type ListContext,
} from "@/app/(console)/bookings/views";
import { actorText, queueHref, QUEUES_PATH, QUEUES_PERMISSION } from "@/app/(console)/queues/queue-views";
import { DEFAULT_LOCALE, Money } from "@/components/money";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeError, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";

// ---- Routes, permissions and reads ------------------------------------------------------------------------------------

/** The route of the dashboard. */
export const DASHBOARD_PATH = "/";
/** The bookings list. */
const BOOKINGS_PATH = "/bookings";
/** The payments list. */
const PAYMENTS_PATH = "/payments";

/** The permission of each tile (scope §1.3: bookings and payments every role, queues owner, admin and agent). */
export const TILE_PERMISSIONS = Object.freeze({
  attention: "bookings:read",
  payments: "payments:read",
  queue: QUEUES_PERMISSION,
  latest: "bookings:read",
} as const satisfies Readonly<Record<string, StaffPermission>>);

/** A tile of the dashboard. */
export type TileId = keyof typeof TILE_PERMISSIONS;

/** The tiles `staff` may read, in display order: a tile the role cannot read is neither read nor rendered. */
export function visibleTiles(staff: ConsoleStaffProfile): readonly TileId[] {
  return (Object.keys(TILE_PERMISSIONS) as TileId[]).filter((tile) => can(staff, TILE_PERMISSIONS[tile]));
}

/** The authorised payments the tile lists. */
export const AUTHORIZED_PAYMENTS_LIMIT = 5;
/** The latest bookings the tile lists. */
export const LATEST_BOOKINGS_LIMIT = 10;
/** The status of a payment that waits for capture (`Payment.status`, the payments list's `status` filter). */
const AUTHORIZED = "authorized";

/** The link of the authorised payments: the payments list filtered by that status (routes.md §7). */
export const AUTHORIZED_PAYMENTS_HREF = `${PAYMENTS_PATH}?${new URLSearchParams({ status: AUTHORIZED }).toString()}`;

/** `console.payments.list` of the tile. */
export const AUTHORIZED_PAYMENTS_PARAMS = Object.freeze({
  status: AUTHORIZED,
  limit: AUTHORIZED_PAYMENTS_LIMIT,
} as const);

/** `console.queues.listSnapshots` of the tile: the newest stored read of any queue. */
export const LAST_SNAPSHOT_PARAMS = Object.freeze({ limit: 1 } as const);

/** `console.bookings.list` of the latest bookings. */
export const LATEST_BOOKINGS_PARAMS = Object.freeze({
  sort: "-created",
  limit: LATEST_BOOKINGS_LIMIT,
} as const);

/** A needs-attention count: the saved view of the bookings list it counts and links. */
export interface AttentionCount {
  readonly id: "ticketing-problems" | "deadline-24h" | "reconciling";
  readonly title: string;
  readonly hint: string;
  readonly view: BookingView;
}

/** The saved view `id` of the bookings list. */
function savedView(id: AttentionCount["id"]): BookingView {
  const view = BOOKING_VIEWS.find((candidate) => candidate.id === id);
  if (view === undefined) {
    throw new TypeError(`no saved bookings view ${id}`);
  }
  return view;
}

/** The counts of "Needs attention" (routes.md §2), in display order. */
export const ATTENTION_COUNTS: readonly AttentionCount[] = [
  {
    id: "ticketing-problems",
    title: "Ticketing failed or in manual review",
    hint: "Issue the tickets, or settle the review.",
    view: savedView("ticketing-problems"),
  },
  {
    id: "deadline-24h",
    title: "Ticketing deadline within 24 h",
    hint: "Confirmed or partially ticketed bookings to issue before the deadline.",
    view: savedView("deadline-24h"),
  },
  {
    id: "reconciling",
    title: "Outcome unknown (reconciling)",
    hint: "Supplier timeouts the reconciliation is still settling.",
    view: savedView("reconciling"),
  },
];

/** The link of a count: its saved view of the bookings list. */
export function attentionHref(count: AttentionCount): string {
  return viewHref(count.view);
}

/**
 * `console.bookings.list` of a count: the filters of its saved view as the bookings list sends them for the view's link
 * (`listParams`: `deadlineWithin=24h` becomes `ticketingDeadlineBefore` = now + 24 h), with `limit: 1`, no sort and no
 * cursor. The card shows the answer's `totalCount` (`countText`).
 */
export function attentionParams(count: AttentionCount, context: ListContext): BookingListParams {
  const query = new URLSearchParams();
  for (const [name, values] of Object.entries(count.view.filters)) {
    for (const value of values ?? []) {
      query.append(name, value);
    }
  }
  const list = listParams(query, context);
  if (list.invalid.length > 0) {
    throw new TypeError(`the saved view ${count.view.id} has filters the API would refuse`);
  }
  const params: BookingListParams = { ...list.params, limit: 1 };
  delete params.sort;
  delete params.cursor;
  return params;
}

/** The outcome of one read: its answer, or the API's error. */
export type TileOutcome<Value> =
  { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: VelexisErrorLike };

// ---- Words ------------------------------------------------------------------------------------------------------------

export const DASHBOARD_STRINGS = Object.freeze({
  attentionTitle: "Needs attention",
  attentionIntro: "Each count opens the bookings list with the same filters.",
  booking: "booking",
  bookings: "bookings",
  notCounted: "Not counted",
  openList: "Open the list",
  retry: "Try again",
  requestId: "Request id",
  paymentsTitle: "Authorised, not captured",
  paymentsIntro: "Stripe authorisations that wait for capture, newest first.",
  paymentsCaption: "Authorised payments that wait for capture",
  paymentsEmpty: "No payment waits for capture.",
  paymentsMore: "More authorised payments wait than are shown here.",
  allAuthorized: "All authorised payments",
  noBooking: "No booking yet",
  queueTitle: "Last queue read",
  queueIntro: "The newest stored read of an Amadeus office queue, by the scheduled poller or a staff member.",
  queueEmpty: "No queue has been read in this environment yet.",
  queue: (queueId: number) => `Queue ${queueId}`,
  openQueue: (queueId: number) => `Open queue ${queueId}`,
  allQueues: "All queues",
  latestTitle: "Latest bookings",
  latestCaption: "The latest bookings, newest first",
  latestEmpty: "No bookings yet in this environment.",
  allBookings: "All bookings",
  guest: "Guest booking",
  more: (count: number) => `+${count} more`,
  columns: {
    payment: "Payment",
    booking: "Booking",
    authorized: "Authorised",
    created: "Created",
    reference: "Reference",
    status: "Status",
    travelers: "Travellers",
    trip: "Route and departure",
    total: "Total",
  },
  snapshot: {
    queue: "Queue",
    office: "Office",
    category: "Category",
    readAt: "Read at",
    readBy: "Read by",
    pnrs: "PNRs",
  },
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const MUTED = "text-xs text-muted-foreground";
const ROW_LINK_CLASS = "font-mono font-medium underline-offset-4 hover:underline focus-visible:underline";

// ---- Counts -----------------------------------------------------------------------------------------------------------

/** The highest exact `totalCount` of `console.bookings.list`: above it the API answers `null`. */
const TOTAL_COUNT_LIMIT = 10_000;

/** What a count shows. */
export interface CountText {
  /** `3`, `10,000+`, or `1+` when the API gave no `totalCount` and has more than the one row read. */
  readonly text: string;
  /** Exactly one booking (the noun's number). */
  readonly one: boolean;
  /** At least one booking: the card is highlighted. */
  readonly any: boolean;
}

/**
 * The count of a page of `console.bookings.list` read with `limit: 1`: its `totalCount` (exact up to 10 000, `null`
 * above), or, without one, the rows read with a `+` when there is a next page.
 */
export function countText(page: Pick<ConsoleBookingPage, "data" | "page" | "totalCount">): CountText {
  const format = new Intl.NumberFormat(DEFAULT_LOCALE);
  if (page.totalCount === null) {
    return { text: `${format.format(TOTAL_COUNT_LIMIT)}+`, one: false, any: true };
  }
  if (page.totalCount !== undefined) {
    return { text: format.format(page.totalCount), one: page.totalCount === 1, any: page.totalCount > 0 };
  }
  const shown = page.data.length;
  const more = page.page.nextCursor !== null;
  return {
    text: more ? `${format.format(shown)}+` : format.format(shown),
    one: shown === 1 && !more,
    any: shown > 0 || more,
  };
}

/** A read's error in its tile: the message of lib/errors.ts, the request id and "Try again". */
function TileFailure({ error }: { readonly error: VelexisErrorLike }) {
  const { message, requestId } = describeError(error);
  return (
    <div role="alert" className="grid gap-1 text-sm">
      <p>{message}</p>
      {requestId === undefined ? null : (
        <p className="text-muted-foreground">
          {DASHBOARD_STRINGS.requestId}: <code>{requestId}</code>
        </p>
      )}
      <p>
        {/* The dashboard again: every tile is read anew. */}
        <a href={DASHBOARD_PATH} className={LINK_CLASS}>
          {DASHBOARD_STRINGS.retry}
        </a>
      </p>
    </div>
  );
}

const CARD_CLASS =
  "grid h-full content-start gap-2 rounded-xl border bg-card p-4 text-card-foreground shadow-sm";

/** One count: a card linking the bookings list with the count's filters. */
function AttentionCard({
  count,
  outcome,
}: {
  readonly count: AttentionCount;
  readonly outcome: TileOutcome<ConsoleBookingPage>;
}) {
  const href = attentionHref(count);
  if (!outcome.ok) {
    return (
      <div data-count={count.id} className={CARD_CLASS}>
        <span className="text-sm font-medium">{count.title}</span>
        <span className="text-xl font-semibold">{DASHBOARD_STRINGS.notCounted}</span>
        <TileFailure error={outcome.error} />
        <Link href={href} className={LINK_CLASS}>
          {DASHBOARD_STRINGS.openList}
        </Link>
      </div>
    );
  }
  const shown = countText(outcome.value);
  return (
    <Link
      href={href}
      data-count={count.id}
      data-attention={shown.any ? "true" : "false"}
      className={cn(
        CARD_CLASS,
        "outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
        shown.any && "border-amber-500 bg-amber-50",
      )}
    >
      <span className="text-sm font-medium">{count.title}</span>
      <span className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums">{shown.text}</span>
        <span className="text-sm">{shown.one ? DASHBOARD_STRINGS.booking : DASHBOARD_STRINGS.bookings}</span>
      </span>
      <span className={MUTED}>{count.hint}</span>
    </Link>
  );
}

/** The needs-attention counts, each linking its saved view of the bookings list. */
export function AttentionTiles({
  counts,
}: {
  readonly counts: readonly {
    readonly count: AttentionCount;
    readonly outcome: TileOutcome<ConsoleBookingPage>;
  }[];
}) {
  return (
    <Tile
      id="dashboard-attention"
      title={DASHBOARD_STRINGS.attentionTitle}
      intro={DASHBOARD_STRINGS.attentionIntro}
    >
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {counts.map(({ count, outcome }) => (
          <li key={count.id}>
            <AttentionCard count={count} outcome={outcome} />
          </li>
        ))}
      </ul>
    </Tile>
  );
}

// ---- Tiles ------------------------------------------------------------------------------------------------------------

/** A tile: a region named by its heading, with an introduction, its content and the links under it. */
function Tile({
  id,
  title,
  intro,
  links,
  children,
  className,
}: {
  readonly id: string;
  readonly title: string;
  readonly intro?: string;
  readonly links?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className={cn("grid content-start gap-3", className)}>
      <div className="grid gap-1">
        <h2 id={headingId} className="text-xl font-semibold">
          {title}
        </h2>
        {intro === undefined ? null : <p className="text-sm text-muted-foreground">{intro}</p>}
      </div>
      {children}
      {links === undefined ? null : <div className="flex flex-wrap items-center gap-4">{links}</div>}
    </section>
  );
}

/** The detail page of a booking. */
function bookingPath(bookingId: string): string {
  return `${BOOKINGS_PATH}/${encodeURIComponent(bookingId)}`;
}

/** The authorised payments that wait for capture, linking the payments list filtered by that status. */
export function AuthorizedPaymentsTile({
  outcome,
  timeZone,
}: {
  readonly outcome: TileOutcome<{
    readonly data: readonly ConsolePayment[];
    readonly nextCursor: string | null;
  }>;
  readonly timeZone: string;
}) {
  const links = (
    <Link href={AUTHORIZED_PAYMENTS_HREF} className={LINK_CLASS}>
      {DASHBOARD_STRINGS.allAuthorized}
    </Link>
  );
  if (!outcome.ok) {
    return (
      <Tile id="dashboard-payments" title={DASHBOARD_STRINGS.paymentsTitle} links={links}>
        <TileFailure error={outcome.error} />
      </Tile>
    );
  }
  const { data, nextCursor } = outcome.value;
  const columns = [
    DASHBOARD_STRINGS.columns.payment,
    DASHBOARD_STRINGS.columns.booking,
    DASHBOARD_STRINGS.columns.authorized,
    DASHBOARD_STRINGS.columns.created,
  ];
  return (
    <Tile
      id="dashboard-payments"
      title={DASHBOARD_STRINGS.paymentsTitle}
      intro={DASHBOARD_STRINGS.paymentsIntro}
      links={links}
    >
      <Table>
        <TableCaption className="sr-only">{DASHBOARD_STRINGS.paymentsCaption}</TableCaption>
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
          {data.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-16 text-center text-muted-foreground">
                {DASHBOARD_STRINGS.paymentsEmpty}
              </TableCell>
            </TableRow>
          ) : (
            data.map((payment) => (
              <TableRow key={payment.id}>
                <TableCell>
                  <Link
                    href={`${PAYMENTS_PATH}/${encodeURIComponent(payment.id)}`}
                    className={cn(ROW_LINK_CLASS, "text-xs")}
                  >
                    {payment.id}
                  </Link>
                </TableCell>
                <TableCell>
                  {payment.booking === null ? (
                    <span className="text-muted-foreground">{DASHBOARD_STRINGS.noBooking}</span>
                  ) : (
                    <Link href={bookingPath(payment.booking.id)} className={ROW_LINK_CLASS}>
                      {payment.booking.reference}
                    </Link>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Money value={payment.amountAuthorized} className="font-medium" />
                </TableCell>
                <TableCell>
                  <time dateTime={payment.createdAt}>{formatInstant(payment.createdAt, timeZone)}</time>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {nextCursor === null ? null : <p className="text-sm">{DASHBOARD_STRINGS.paymentsMore}</p>}
    </Tile>
  );
}

/** The newest stored read of a queue, linking that queue's page and the queues. */
export function QueueSnapshotTile({
  outcome,
  timeZone,
}: {
  readonly outcome: TileOutcome<QueueSnapshot | undefined>;
  readonly timeZone: string;
}) {
  const snapshot = outcome.ok ? outcome.value : undefined;
  const links = (
    <>
      {snapshot === undefined ? null : (
        <Link
          href={queueHref({
            queueId: snapshot.queueId,
            officeId: snapshot.officeId,
            category: snapshot.category,
          })}
          className={LINK_CLASS}
        >
          {DASHBOARD_STRINGS.openQueue(snapshot.queueId)}
        </Link>
      )}
      <Link href={QUEUES_PATH} className={LINK_CLASS}>
        {DASHBOARD_STRINGS.allQueues}
      </Link>
    </>
  );
  return (
    <Tile
      id="dashboard-queue"
      title={DASHBOARD_STRINGS.queueTitle}
      {...(outcome.ok ? { intro: DASHBOARD_STRINGS.queueIntro } : {})}
      links={links}
    >
      {!outcome.ok ? (
        <TileFailure error={outcome.error} />
      ) : snapshot === undefined ? (
        <p className="text-sm text-muted-foreground">{DASHBOARD_STRINGS.queueEmpty}</p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{DASHBOARD_STRINGS.snapshot.queue}</dt>
          <dd className="font-medium">{DASHBOARD_STRINGS.queue(snapshot.queueId)}</dd>
          <dt className="text-muted-foreground">{DASHBOARD_STRINGS.snapshot.office}</dt>
          <dd className="font-mono">{snapshot.officeId}</dd>
          <dt className="text-muted-foreground">{DASHBOARD_STRINGS.snapshot.category}</dt>
          <dd>{snapshot.category}</dd>
          <dt className="text-muted-foreground">{DASHBOARD_STRINGS.snapshot.readAt}</dt>
          <dd>
            <time dateTime={snapshot.fetchedAt}>{formatInstant(snapshot.fetchedAt, timeZone)}</time>
          </dd>
          <dt className="text-muted-foreground">{DASHBOARD_STRINGS.snapshot.readBy}</dt>
          <dd>{actorText(snapshot.fetchedBy)}</dd>
          <dt className="text-muted-foreground">{DASHBOARD_STRINGS.snapshot.pnrs}</dt>
          <dd className="tabular-nums">{snapshot.itemCount}</dd>
        </dl>
      )}
    </Tile>
  );
}

/** The latest bookings of the OTA, newest first, linking the bookings list. */
export function LatestBookingsTile({
  outcome,
  timeZone,
}: {
  readonly outcome: TileOutcome<ConsoleBookingPage>;
  readonly timeZone: string;
}) {
  const links = (
    <Link href={BOOKINGS_PATH} className={LINK_CLASS}>
      {DASHBOARD_STRINGS.allBookings}
    </Link>
  );
  if (!outcome.ok) {
    return (
      <Tile id="dashboard-latest" title={DASHBOARD_STRINGS.latestTitle} links={links}>
        <TileFailure error={outcome.error} />
      </Tile>
    );
  }
  const rows = outcome.value.data.map((summary) => bookingRow(summary, timeZone));
  const columns = [
    DASHBOARD_STRINGS.columns.reference,
    DASHBOARD_STRINGS.columns.status,
    DASHBOARD_STRINGS.columns.travelers,
    DASHBOARD_STRINGS.columns.trip,
    DASHBOARD_STRINGS.columns.total,
    DASHBOARD_STRINGS.columns.created,
  ];
  return (
    <Tile id="dashboard-latest" title={DASHBOARD_STRINGS.latestTitle} links={links}>
      <Table>
        <TableCaption className="sr-only">{DASHBOARD_STRINGS.latestCaption}</TableCaption>
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
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-16 text-center text-muted-foreground">
                {DASHBOARD_STRINGS.latestEmpty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id} data-booking={row.id}>
                <TableCell>
                  <div className="grid gap-0.5">
                    <Link href={bookingPath(row.id)} className={ROW_LINK_CLASS}>
                      {row.reference}
                    </Link>
                    {row.guest ? <span className={MUTED}>{DASHBOARD_STRINGS.guest}</span> : null}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="grid justify-items-start gap-1">
                    <StatusBadge kind="booking" status={row.status} />
                    <StatusBadge kind="ticketing" status={row.ticketingStatus} />
                  </div>
                </TableCell>
                <TableCell>
                  <div className="grid gap-0.5">
                    <span>{row.leadTraveler}</span>
                    {row.otherTravelers > 0 ? (
                      <span className={MUTED}>{DASHBOARD_STRINGS.more(row.otherTravelers)}</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="grid gap-0.5">
                    <span className="font-medium">{row.route}</span>
                    <span className={MUTED}>
                      {row.tripType} · <time dateTime={row.departure.dateTime}>{row.departure.label}</time>
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Money value={row.total} className="font-medium" />
                </TableCell>
                <TableCell>
                  <time dateTime={row.created.dateTime}>{row.created.label}</time>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Tile>
  );
}
