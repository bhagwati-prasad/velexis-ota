// `/queues` (README §5, routes.md §5, OAD-009): the Amadeus office queues of the OTA in the environment of the switch,
// each with its last stored read, from `console.queues.listSnapshots` (`queues:read`: owner, admin, agent; no Amadeus
// call, not audited). The API has no list of the monitored queues themselves (they are set per OTA and environment in
// the portal, `platform.supplier_connections.monitored_queues`), so the page groups the newest snapshots by office,
// queue and category: a queue the scheduled poller read (`fetchedBy: null`) is a monitored one, the others are the
// queues staff read. Each links to `/queues/[queueId]` (queues/[queueId]/page.tsx), where "Read now" calls Amadeus.
//
// "Open a queue" is a plain GET form to this page (`?queueId=50&category=0&officeId=…`), which sends a valid queue on to
// its own page and names what is not valid (a queue number from 0 to 99, a category from 0 to 254, one of the OTA's
// offices: the API's own bounds), so it works without JavaScript and opens queues no one has read yet.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=/queues`, an
// ended session to the portal (`redirectOnSessionError`), and every other API error renders the console's message for
// its code with the request id, with "Try again".
import type { ConsoleStaffProfile, QueueSnapshot } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { formatInstant } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import {
  CATEGORY_MAX,
  CATEGORY_PARAM,
  OFFICE_ID_PATTERN,
  OFFICE_PARAM,
  QUEUES_PATH,
  QUEUES_PERMISSION,
  QUEUE_ID_MAX,
  QUEUE_PARAM,
  actorText,
  parseQueueNumber,
  queueHref,
  type QueueScope,
} from "./queue-views";

export const metadata: Metadata = { title: "Queues" };

const PAGE_STRINGS = Object.freeze({
  title: "Queues",
  intro: (environment: string) =>
    `The Amadeus office queues of this OTA in the ${environment} environment, each with its last read: the queues the scheduled poller reads (set up in the portal) and the ones staff read.`,
  forbiddenTitle: "You cannot open the queues",
  unavailableTitle: "The queues could not be loaded",
  retry: "Try again",
  caption: "Queues read recently",
  empty:
    "No queue has been read in this environment yet. The scheduled poller reads the queues set up in the portal; open a queue below to read it now.",
  queue: (queueId: number) => `Queue ${queueId}`,
  monitored: "Yes, by the scheduled poller",
  notMonitored: "No",
  openTitle: "Open a queue",
  openHint: "Amadeus queue numbers go from 0 to 99, categories from 0 to 254.",
  queueNumber: "Queue number",
  category: "Category",
  office: "Office",
  defaultOffice: "The queuing office (default)",
  open: "Open queue",
  badQueue: `Enter a queue number from 0 to ${QUEUE_ID_MAX}.`,
  badCategory: `Enter a category from 0 to ${CATEGORY_MAX}.`,
  badOffice: "Choose one of this OTA's offices.",
  columns: {
    queue: "Queue",
    office: "Office",
    category: "Category",
    lastRead: "Last read",
    readBy: "Read by",
    pnrs: "PNRs",
    monitored: "Monitored",
  },
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const FIELD_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** The newest snapshots the page groups: enough for the polled queues of a day and the staff's recent reads. */
const SNAPSHOT_LIMIT = 100;

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

// ---- The open form ----------------------------------------------------------------------------------------------------

/** What the open form posted, and what of it is not valid. */
interface OpenRequest {
  readonly values: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly scope?: QueueScope;
}

/** The open form's values (`?queueId=…`), checked as the API checks them; `undefined` when the URL has none. */
function openRequestOf(query: SearchParams, offices: readonly string[]): OpenRequest | undefined {
  const queueText = firstOf(query[QUEUE_PARAM]);
  if (queueText === undefined) {
    return undefined;
  }
  const categoryText = firstOf(query[CATEGORY_PARAM]) ?? "";
  const officeText = (firstOf(query[OFFICE_PARAM]) ?? "").trim().toUpperCase();
  const values = { [QUEUE_PARAM]: queueText, [CATEGORY_PARAM]: categoryText, [OFFICE_PARAM]: officeText };
  const errors: Record<string, string> = {};
  const queueId = parseQueueNumber(queueText, QUEUE_ID_MAX);
  if (queueId === undefined || queueId === null) {
    errors[QUEUE_PARAM] = PAGE_STRINGS.badQueue;
  }
  const category = parseQueueNumber(categoryText, CATEGORY_MAX);
  if (category === null) {
    errors[CATEGORY_PARAM] = PAGE_STRINGS.badCategory;
  }
  if (officeText !== "" && (!OFFICE_ID_PATTERN.test(officeText) || !offices.includes(officeText))) {
    errors[OFFICE_PARAM] = PAGE_STRINGS.badOffice;
  }
  if (Object.keys(errors).length > 0 || queueId === undefined || queueId === null || category === null) {
    return { values, errors };
  }
  return {
    values,
    errors,
    scope: { queueId, category, officeId: officeText === "" ? undefined : officeText },
  };
}

/** One field of the open form, with its label and error. */
function FormField({
  id,
  label,
  error,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** `aria-invalid` and `aria-describedby` of a field with an error. */
function invalidProps(id: string, error: string | undefined) {
  return error === undefined ? {} : { "aria-invalid": true as const, "aria-describedby": `${id}-error` };
}

/** "Open a queue": a GET form to this page, which sends a valid queue on to its page. */
function OpenQueueForm({
  offices,
  request,
}: {
  readonly offices: readonly string[];
  readonly request: OpenRequest | undefined;
}) {
  const values = request?.values ?? {};
  const errors = request?.errors ?? {};
  return (
    <form
      method="get"
      action={QUEUES_PATH}
      aria-labelledby="open-queue-heading"
      className="grid max-w-2xl gap-3 rounded-xl border p-4"
    >
      <h2 id="open-queue-heading" className="text-lg font-semibold">
        {PAGE_STRINGS.openTitle}
      </h2>
      <p className="text-sm text-muted-foreground">{PAGE_STRINGS.openHint}</p>
      <div className="flex flex-wrap items-start gap-4">
        <FormField id="open-queue-id" label={PAGE_STRINGS.queueNumber} error={errors[QUEUE_PARAM]}>
          <Input
            id="open-queue-id"
            name={QUEUE_PARAM}
            type="number"
            min={0}
            max={QUEUE_ID_MAX}
            required
            inputMode="numeric"
            autoComplete="off"
            defaultValue={values[QUEUE_PARAM] ?? ""}
            className="w-28"
            {...invalidProps("open-queue-id", errors[QUEUE_PARAM])}
          />
        </FormField>
        <FormField id="open-queue-category" label={PAGE_STRINGS.category} error={errors[CATEGORY_PARAM]}>
          <Input
            id="open-queue-category"
            name={CATEGORY_PARAM}
            type="number"
            min={0}
            max={CATEGORY_MAX}
            inputMode="numeric"
            autoComplete="off"
            defaultValue={values[CATEGORY_PARAM] ?? "0"}
            className="w-28"
            {...invalidProps("open-queue-category", errors[CATEGORY_PARAM])}
          />
        </FormField>
        <FormField id="open-queue-office" label={PAGE_STRINGS.office} error={errors[OFFICE_PARAM]}>
          <select
            id="open-queue-office"
            name={OFFICE_PARAM}
            defaultValue={values[OFFICE_PARAM] ?? ""}
            autoComplete="off"
            className={FIELD_CLASS}
            {...invalidProps("open-queue-office", errors[OFFICE_PARAM])}
          >
            <option value="">{PAGE_STRINGS.defaultOffice}</option>
            {offices.map((office) => (
              <option key={office} value={office}>
                {office}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <div>
        <Button type="submit" variant="outline">
          {PAGE_STRINGS.open}
        </Button>
      </div>
    </form>
  );
}

// ---- The queues -------------------------------------------------------------------------------------------------------

/** One queue of the list: its newest snapshot and whether the scheduled poller reads it. */
interface QueueRow {
  readonly latest: QueueSnapshot;
  readonly monitored: boolean;
}

/** The newest snapshot of each office, queue and category (`snapshots` come newest first), by queue number. */
function queueRowsOf(snapshots: readonly QueueSnapshot[]): QueueRow[] {
  const rows = new Map<string, { latest: QueueSnapshot; monitored: boolean }>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.officeId}|${snapshot.queueId}|${snapshot.category}`;
    const row = rows.get(key);
    if (row === undefined) {
      rows.set(key, { latest: snapshot, monitored: snapshot.fetchedBy === null });
    } else if (snapshot.fetchedBy === null) {
      row.monitored = true;
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.latest.queueId - b.latest.queueId ||
      a.latest.officeId.localeCompare(b.latest.officeId) ||
      a.latest.category - b.latest.category,
  );
}

function QueuesTable({ rows, timeZone }: { readonly rows: readonly QueueRow[]; readonly timeZone: string }) {
  const columns = Object.values(PAGE_STRINGS.columns);
  return (
    <Table>
      <TableCaption className="sr-only">{PAGE_STRINGS.caption}</TableCaption>
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
            <TableCell colSpan={columns.length} className="h-20 text-center text-muted-foreground">
              {PAGE_STRINGS.empty}
            </TableCell>
          </TableRow>
        ) : (
          rows.map(({ latest, monitored }) => (
            <TableRow key={latest.id}>
              <TableCell>
                <Link
                  href={queueHref({
                    queueId: latest.queueId,
                    officeId: latest.officeId,
                    category: latest.category,
                  })}
                  className="font-medium underline-offset-4 hover:underline focus-visible:underline"
                >
                  {PAGE_STRINGS.queue(latest.queueId)}
                </Link>
              </TableCell>
              <TableCell className="font-mono">{latest.officeId}</TableCell>
              <TableCell>{latest.category}</TableCell>
              <TableCell>
                <time dateTime={latest.fetchedAt}>{formatInstant(latest.fetchedAt, timeZone)}</time>
              </TableCell>
              <TableCell>{actorText(latest.fetchedBy)}</TableCell>
              <TableCell className="tabular-nums">{latest.itemCount}</TableCell>
              <TableCell>{monitored ? PAGE_STRINGS.monitored : PAGE_STRINGS.notMonitored}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function QueuesShell({
  environment,
  staff,
  request,
  children,
}: {
  readonly environment: string;
  readonly staff: ConsoleStaffProfile;
  readonly request: OpenRequest | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
        <p className="text-muted-foreground">{PAGE_STRINGS.intro(environment)}</p>
      </div>
      {children}
      <OpenQueueForm offices={staff.tenant.supplier.officeIds} request={request} />
    </div>
  );
}

export default async function QueuesPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const query = await searchParams;

  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, QUEUES_PATH);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }
  const { staff, environment } = request;

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

  const open = openRequestOf(query, staff.tenant.supplier.officeIds);
  if (open?.scope !== undefined) {
    redirect(queueHref(open.scope));
  }

  let snapshots: QueueSnapshot[];
  try {
    snapshots = (await request.console.queues.listSnapshots({ limit: SNAPSHOT_LIMIT })).data;
  } catch (error) {
    const failure = await apiFailure(error, QUEUES_PATH);
    return (
      <QueuesShell environment={environment} staff={staff} request={open}>
        <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
          <a href={QUEUES_PATH} className={LINK_CLASS}>
            {PAGE_STRINGS.retry}
          </a>
        </ErrorState>
      </QueuesShell>
    );
  }

  return (
    <QueuesShell environment={environment} staff={staff} request={open}>
      <QueuesTable rows={queueRowsOf(snapshots)} timeZone={staff.tenant.timeZone} />
    </QueuesShell>
  );
}
