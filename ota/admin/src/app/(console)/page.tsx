// The dashboard `/` (README §5, routes.md §2, OAD-005): what needs staff in the environment of the switch, and the
// latest activity, as tiles that link the pre-filtered lists. Each tile is read and rendered only with its permission
// (`visibleTiles`, dashboard-tiles.tsx): the needs-attention counts and the latest bookings with `bookings:read`, the
// authorised payments with `payments:read`, the last queue read with `queues:read` (so a finance user sees payments
// but no queue). The reads run in parallel, each on its own: one that fails shows the console's message and request
// id in its tile's place, and the other tiles stay.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=/`, an
// ended session to the portal (`redirectOnSessionError`), whichever read meets it, and every other API error is the
// state of its tile. None of these reads calls Amadeus or is audited.
import type { ConsoleBookingPage, ConsolePayment, QueueSnapshot } from "@velexis/ota-sdk";
import type { Metadata } from "next";

import {
  ATTENTION_COUNTS,
  AUTHORIZED_PAYMENTS_PARAMS,
  AttentionTiles,
  AuthorizedPaymentsTile,
  DASHBOARD_PATH,
  LAST_SNAPSHOT_PARAMS,
  LATEST_BOOKINGS_PARAMS,
  LatestBookingsTile,
  QueueSnapshotTile,
  attentionParams,
  visibleTiles,
  type AttentionCount,
  type TileOutcome,
} from "@/app/(console)/dashboard-tiles";
import { ErrorState } from "@/components/error-state";
import { isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { redirectOnSessionError } from "@/lib/session";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

export const metadata: Metadata = { title: "Dashboard" };

const PAGE_STRINGS = Object.freeze({
  title: "Dashboard",
  intro: (environment: string) =>
    `What needs staff in the ${environment} environment, and the latest activity. Each tile opens its list.`,
  unavailableTitle: "The dashboard could not be loaded",
  nothing: "Your role has no tile on this dashboard. The navigation lists what you can open.",
});

/**
 * An error of the OTA API as a tile's state: `TOKEN_EXPIRED` and an ended session redirect (Next.js's redirect is
 * thrown on), anything that is not an API error is thrown for the error boundary, and an API error is returned.
 */
async function apiFailure(error: unknown): Promise<VelexisErrorLike> {
  if (!isVelexisErrorLike(error)) {
    throw error;
  }
  try {
    await redirectOnSessionError(error, DASHBOARD_PATH);
  } catch (thrown) {
    // `redirectOnSessionError` throws the same error back when it is not about the session.
    if (thrown !== error) {
      throw thrown;
    }
  }
  return error;
}

/** A read that never rejects: its answer, or its error. */
function settle<Value>(
  read: Promise<Value>,
): Promise<{ ok: true; value: Value } | { ok: false; error: unknown }> {
  return read.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/** A settled read as a tile's outcome: a session error redirects, any other API error is the tile's state. */
async function outcomeOf<Value>(
  settled: { ok: true; value: Value } | { ok: false; error: unknown },
): Promise<TileOutcome<Value>> {
  return settled.ok ? settled : { ok: false, error: await apiFailure(settled.error) };
}

/** A read the role may not make: never sent. */
const SKIPPED = Promise.resolve(undefined);

export default async function DashboardPage() {
  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }
  const { staff, environment, console: con } = request;
  const timeZone = staff.tenant.timeZone;
  const tiles = visibleTiles(staff);
  const context = { now: Date.now(), timeZone };

  // Every read of a tile the role holds, in parallel; none of a tile it does not.
  const [counts, payments, snapshot, latest] = await Promise.all([
    tiles.includes("attention")
      ? Promise.all(
          ATTENTION_COUNTS.map(async (count) => ({
            count,
            settled: await settle(con.bookings.list(attentionParams(count, context))),
          })),
        )
      : SKIPPED,
    tiles.includes("payments")
      ? settle(
          con.payments
            .list({ ...AUTHORIZED_PAYMENTS_PARAMS })
            .then((page) => ({ data: page.data, nextCursor: page.page.nextCursor })),
        )
      : SKIPPED,
    tiles.includes("queue")
      ? settle(con.queues.listSnapshots({ ...LAST_SNAPSHOT_PARAMS }).then((page) => page.data[0]))
      : SKIPPED,
    tiles.includes("latest") ? settle(con.bookings.list({ ...LATEST_BOOKINGS_PARAMS })) : SKIPPED,
  ]);

  // In order: the first session error redirects; the other API errors become their tiles' states.
  const attention: { count: AttentionCount; outcome: TileOutcome<ConsoleBookingPage> }[] = [];
  for (const { count, settled } of counts ?? []) {
    attention.push({ count, outcome: await outcomeOf(settled) });
  }
  const paymentsOutcome:
    | TileOutcome<{ readonly data: readonly ConsolePayment[]; readonly nextCursor: string | null }>
    | undefined = payments === undefined ? undefined : await outcomeOf(payments);
  const snapshotOutcome: TileOutcome<QueueSnapshot | undefined> | undefined =
    snapshot === undefined ? undefined : await outcomeOf(snapshot);
  const latestOutcome: TileOutcome<ConsoleBookingPage> | undefined =
    latest === undefined ? undefined : await outcomeOf(latest);

  return (
    <div className="grid gap-8">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
        <p className="text-muted-foreground">{PAGE_STRINGS.intro(environment)}</p>
      </div>
      {tiles.length === 0 ? <p>{PAGE_STRINGS.nothing}</p> : null}
      {counts === undefined ? null : <AttentionTiles counts={attention} />}
      {paymentsOutcome === undefined && snapshotOutcome === undefined ? null : (
        <div className="grid gap-8 xl:grid-cols-2">
          {paymentsOutcome === undefined ? null : (
            <AuthorizedPaymentsTile outcome={paymentsOutcome} timeZone={timeZone} />
          )}
          {snapshotOutcome === undefined ? null : (
            <QueueSnapshotTile outcome={snapshotOutcome} timeZone={timeZone} />
          )}
        </div>
      )}
      {latestOutcome === undefined ? null : (
        <LatestBookingsTile outcome={latestOutcome} timeZone={timeZone} />
      )}
    </div>
  );
}
