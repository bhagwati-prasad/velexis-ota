// The shared pieces of the queue pages `/queues` and `/queues/[queueId]` (OAD-009, routes.md §5, README §5): the URL of
// a queue view, the rules of its parameters as the API takes them, who read a snapshot, and the table of a queue's PNRs
// with each one's link: to the OTA's booking of its record locator, or, for an orphan (no booking of the OTA owns it),
// "Import", which opens the PNR lookup `/pnr?recordLocator=…` (pnr/import-rules.ts `pnrHref`) where staff look it up
// and import it. Server components without state, data fetching or hooks; only the HTML they render reaches the
// browser. A module without a directive, imported by both pages (a page file may export its page only).
//
// No queue item actions (remove, move) in the MVP (scope §2.3): staff clean the queue in Amadeus by hand (backend
// README "Runbook: cleaning the booking queue"), with this view of the orphans beforehand.
import type { ConsoleActor, QueueItem, QueueSnapshot } from "@velexis/ota-sdk";
import Link from "next/link";

import { formatLocalTime } from "@/app/(console)/bookings/views";
import { bookingPath, pnrHref } from "@/app/(console)/pnr/import-rules";
import { StatusBadge, toneClasses } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

// ---- URLs and parameters ----------------------------------------------------------------------------------------------

/** The route of the queues. */
export const QUEUES_PATH = "/queues";
/** The permission of the queue pages (`x-permission` of both queue operations: owner, admin, agent). */
export const QUEUES_PERMISSION = "queues:read";

/** The queue number of the open form (`/queues?queueId=50`), which `/queues` sends on to `/queues/50`. */
export const QUEUE_PARAM = "queueId";
/** The office whose queue is read (Queue List `officeId`; none: the connection's queuing office). */
export const OFFICE_PARAM = "officeId";
/** The queue category (Queue List `category`; the API's default 0). */
export const CATEGORY_PARAM = "category";
/** "Read now" (`read=1`): a fresh Queue List read, stored as a snapshot. */
export const READ_PARAM = "read";
/** The page of a fresh read's stored snapshot (`page.nextCursor`). */
export const CURSOR_PARAM = "cursor";

/** The highest queue number (`queueId` maximum of the OTA document). */
export const QUEUE_ID_MAX = 99;
/** The highest category (`ConsoleQueueCategory` maximum). */
export const CATEGORY_MAX = 254;
/** An Amadeus office id (`ConsoleQueueOfficeId`). */
export const OFFICE_ID_PATTERN = /^[A-Z0-9]{9}$/;
/** The longest cursor the page passes on; the API's cursors are far shorter. */
export const MAX_CURSOR_LENGTH = 400;

/**
 * A whole number from 0 to `max` as a URL writes it (`"50"`): `undefined` when the parameter is absent or empty, `null`
 * when it is not one (a value the API would refuse, which is never sent).
 */
export function parseQueueNumber(value: string | undefined, max: number): number | undefined | null {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const text = value.trim();
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(text)) {
    return null;
  }
  const number = Number(text);
  return number <= max ? number : null;
}

/** Which queue a view shows: the number, and the office and category when the URL names them. */
export interface QueueScope {
  readonly queueId: number;
  readonly officeId?: string | undefined;
  readonly category?: number | undefined;
}

/** The URL of a queue's view; with `read`, "Read now"; with `cursor`, a later page of a fresh read. */
export function queueHref(
  scope: QueueScope,
  options: { readonly read?: boolean; readonly cursor?: string } = {},
): string {
  const query = new URLSearchParams();
  if (scope.officeId !== undefined) {
    query.set(OFFICE_PARAM, scope.officeId);
  }
  if (scope.category !== undefined) {
    query.set(CATEGORY_PARAM, String(scope.category));
  }
  if (options.read === true) {
    query.set(READ_PARAM, "1");
  }
  if (options.cursor !== undefined) {
    query.set(CURSOR_PARAM, options.cursor);
  }
  const path = `${QUEUES_PATH}/${scope.queueId}`;
  const text = query.toString();
  return text === "" ? path : `${path}?${text}`;
}

// ---- Words ------------------------------------------------------------------------------------------------------------

export const QUEUE_STRINGS = Object.freeze({
  poller: "Scheduled poller",
  apiKey: "API key",
  staff: "Staff member",
  unknown: "Unknown",
  noBooking: "No booking",
  orphan: "Orphan: no booking of this OTA has this record locator",
  import: "Import",
  itemsCaption: (queueId: number) => `PNRs on queue ${queueId}`,
  noItems: "No PNR on this queue.",
  warnings: "Amadeus warnings",
  columns: {
    recordLocator: "Record locator",
    created: "Created",
    travelers: "Travellers",
    flights: "Flights",
    booking: "Booking",
  },
});

const LINK_CLASS = "font-medium text-primary underline underline-offset-4";

/** Who read a snapshot: the scheduled poller (`fetchedBy: null`), a staff member by name, an API key. */
export function actorText(actor: ConsoleActor | null): string {
  if (actor === null) {
    return QUEUE_STRINGS.poller;
  }
  if (actor.type === "api_key") {
    return actor.name ?? QUEUE_STRINGS.apiKey;
  }
  if (actor.type === "staff") {
    return actor.name ?? actor.email ?? actor.id ?? QUEUE_STRINGS.staff;
  }
  return actor.name ?? actor.id ?? QUEUE_STRINGS.unknown;
}

/** The warnings of a read as sentences. */
export function warningTexts(warnings: QueueSnapshot["warnings"]): string[] {
  return warnings
    .map((warning) => warning.detail ?? warning.title)
    .filter((text): text is string => typeof text === "string" && text !== "");
}

/** Amadeus's warnings of a read, when there are any. */
export function QueueWarnings({ warnings }: { readonly warnings: QueueSnapshot["warnings"] }) {
  const texts = warningTexts(warnings);
  return texts.length === 0 ? null : (
    <div role="note" className={cn("grid gap-1 rounded-md px-3 py-2 text-sm", toneClasses("warning"))}>
      <p className="font-medium">{QUEUE_STRINGS.warnings}</p>
      <ul className="list-disc pl-5">
        {/* By position: two warnings of a read may say the same. */}
        {texts.map((text, index) => (
          <li key={index}>{text}</li>
        ))}
      </ul>
    </div>
  );
}

// ---- The PNRs of a queue ----------------------------------------------------------------------------------------------

/** A traveller's name as a PNR writes it (`MOREAU/CLAIRE`). */
function travelerName(traveler: QueueItem["travelers"][number]): string {
  const name = [traveler.lastName, traveler.firstName].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return name.length === 0 ? QUEUE_STRINGS.unknown : name.join("/");
}

/** An air segment of a PNR: the flight, where it lands and when (local). */
function segmentText(segment: QueueItem["segments"][number]): string {
  const flight = [segment.carrierCode, segment.number].filter((part) => part !== null).join(" ");
  const arrival =
    segment.arrivalLocalDateTime === null ? "" : `, ${formatLocalTime(segment.arrivalLocalDateTime)}`;
  return `${flight === "" ? QUEUE_STRINGS.unknown : flight} → ${segment.arrivalIataCode ?? QUEUE_STRINGS.unknown}${arrival}`;
}

/** What the OTA has of a PNR: its booking, or (an orphan) the way to import it. */
function BookingCell({ item }: { readonly item: QueueItem }) {
  if (item.bookingId !== null) {
    return (
      <div className="grid justify-items-start gap-1">
        <Link href={bookingPath(item.bookingId)} prefetch={false} className={cn("font-mono", LINK_CLASS)}>
          {item.bookingReference ?? item.bookingId}
        </Link>
        {item.bookingStatus === null ? null : <StatusBadge kind="booking" status={item.bookingStatus} />}
      </div>
    );
  }
  return (
    <div className="grid justify-items-start gap-1" data-orphan="true">
      <span
        title={QUEUE_STRINGS.orphan}
        className={cn("rounded-md px-2 py-0.5 text-xs font-medium", toneClasses("warning"))}
      >
        {QUEUE_STRINGS.noBooking}
      </span>
      {/* No prefetch: opening the lookup reads Amadeus and is audited, which only a click should do. */}
      <Link href={pnrHref(item.recordLocator)} prefetch={false} className={cn("text-sm", LINK_CLASS)}>
        {QUEUE_STRINGS.import}
        <span className="sr-only"> {item.recordLocator}</span>
      </Link>
    </div>
  );
}

/** The PNRs of one read of a queue, each with its booking or, for an orphan, "Import". */
export function QueueItemsTable({
  queueId,
  items,
}: {
  readonly queueId: number;
  readonly items: readonly QueueItem[];
}) {
  const columns = Object.values(QUEUE_STRINGS.columns);
  return (
    <Table>
      <TableCaption className="sr-only">{QUEUE_STRINGS.itemsCaption(queueId)}</TableCaption>
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
        {items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="h-20 text-center text-muted-foreground">
              {QUEUE_STRINGS.noItems}
            </TableCell>
          </TableRow>
        ) : (
          items.map((item) => (
            <TableRow key={item.pnrId} data-record-locator={item.recordLocator}>
              <TableCell className="font-mono font-medium">{item.recordLocator}</TableCell>
              <TableCell>
                {item.creationDateTime === null
                  ? QUEUE_STRINGS.unknown
                  : formatLocalTime(item.creationDateTime)}
              </TableCell>
              <TableCell>{item.travelers.map(travelerName).join(", ")}</TableCell>
              <TableCell>
                <ul className="grid gap-0.5">
                  {item.segments.map((segment, index) => (
                    <li key={index}>{segmentText(segment)}</li>
                  ))}
                </ul>
              </TableCell>
              <TableCell>
                <BookingCell item={item} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
