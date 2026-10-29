// `/shopping` (README §5, routes.md §6, OADR-0018 point 7, OAD-010): shopping on behalf of a caller. Staff search,
// compare and quote Amadeus flights with the raw, read-only console operations of OBE-067 (`amadeus:read`: owner, admin,
// agent): Flight Offers Search, Flight Availabilities Search, Branded Fares Upsell and Flight Offers Price, each a
// server action of actions.ts run from results.tsx. The prices are Amadeus **net** prices, before the OTA's markup and
// fees, and the page says so above everything it shows. The admin never calls a customer-scope operation (`flights.*`):
// its service key is console-only.
//
// What this server component renders:
//   - the heading, the net-price notice and the audit note (each raw read is an audited read);
//   - that booking on behalf comes later (`console.bookings.create` is deferred, scope §3.4), with the two ways staff
//     have instead: the storefront, and the PNR lookup's import of a booking made in the Amadeus terminal;
//   - for orientation, the OTA's default markup rule (`console.settings.markupRules.list`, `settings:read`, read here
//     and never sent to the browser as a rule: only its description), which says how far a storefront price is above
//     the net prices of the page; a role without `settings:read` gets no tile and no request;
//   - the environment and the OTA's Amadeus offices, and a warning when the environment has no Amadeus connection;
//   - the console of results.tsx (the two searches and an offer's branded fares and confirmed price).
//
// No Amadeus call is made while the page renders: every one starts from a button, in a server action. Next.js hides a
// server component's error from `error.tsx` in production, so the codes are handled here (routes.md §1, OAD-004): an
// expired access token goes to `/auth/refresh?next=/shopping`, an ended session to the portal (`redirectOnSessionError`),
// a failure of `console.auth.me` renders the console's message, and a failure of the markup rules is shown in their
// tile while the searches stay usable.
import type { ConsoleStaffProfile, MarkupRule } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";

import { ErrorState } from "@/components/error-state";
import { formatMoney, type MoneyValue } from "@/components/money";
import { toneClasses } from "@/components/status-badge";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { cn } from "@/lib/utils";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import { ShoppingConsole } from "./results";

export const metadata: Metadata = { title: "Shopping on behalf" };

/** The route of the page (where an expired session comes back to). */
const SHOPPING_PATH = "/shopping";
/** The permission of the raw reads (`x-permission` of the consoleAmadeus* reads). */
const READ_PERMISSION = "amadeus:read";
/** The permission of the markup rules. */
const SETTINGS_PERMISSION = "settings:read";
/** Markup rules per page, and the most pages read to find the default rule (priority 1000, the last of most lists). */
const MARKUP_PAGE_SIZE = 100;
const MARKUP_MAX_PAGES = 5;

const PAGE_STRINGS = Object.freeze({
  title: "Shopping on behalf",
  intro:
    "Search, compare and quote Amadeus flights for a caller: offers, seats per booking class, branded fares and a confirmed price.",
  netTitle: "Net prices",
  net: "Every price on this page is an Amadeus net price: before this OTA's markup and fees, not the price a customer pays. Do not quote it to a customer as the selling price.",
  audited:
    "Each search, branded fares request and price confirmation calls Amadeus and is recorded in the audit trail.",
  laterTitle: "Booking on behalf comes later",
  later:
    "The console cannot book these offers yet: booking on behalf waits for console.bookings.create, which is deferred. To book, send the customer to the storefront, or book in the Amadeus terminal and import the booking through the",
  pnr: "PNR lookup",
  environment: (environment: string) => `Environment: ${environment === "live" ? "LIVE" : "test"}.`,
  offices: (offices: string) => `Amadeus offices: ${offices}.`,
  noOffices: "This OTA has no Amadeus office set up in this environment.",
  noSupplier:
    "No Amadeus connection is active in this environment, so Amadeus refuses the searches. The OTA's owner sets it up in the portal.",
  markupTitle: "Default markup rule, for orientation",
  markupExplained:
    "The storefront prices an offer with the first markup rule that matches it (by priority) and the stackable rules before it, then adds the fees when a price is confirmed; this default rule applies when no other rule matches.",
  markupOff: "This rule is switched off.",
  markupNone: "This OTA has no default markup rule.",
  markupFailed: "The markup rules could not be read.",
  markupRules: "Markup rules",
  requestId: "Request id",
  forbiddenTitle: "You cannot shop on behalf of callers",
  unavailableTitle: "Shopping could not be opened",
});

const LINK_CLASS = "font-medium text-primary underline underline-offset-4";
const MUTED = "text-sm text-muted-foreground";

/**
 * An error of the OTA API as the page's state: `TOKEN_EXPIRED` and an ended session redirect (Next.js's redirect is
 * thrown on), anything that is not an API error is thrown for the error boundary, and an API error is returned.
 */
async function apiFailure(error: unknown): Promise<VelexisErrorLike> {
  if (!isVelexisErrorLike(error)) {
    throw error;
  }
  try {
    await redirectOnSessionError(error, SHOPPING_PATH);
  } catch (thrown) {
    // `redirectOnSessionError` throws the same error back when it is not about the session.
    if (thrown !== error) {
      throw thrown;
    }
  }
  return error;
}

// ---- The default markup rule ----------------------------------------------------------------------------------------

/** What the markup tile shows. */
type MarkupTile =
  | { readonly kind: "rule"; readonly rule: MarkupRule }
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly error: VelexisErrorLike };

/** The OTA's default markup rule (`isDefault`), from the pages of `console.settings.markupRules.list`. */
async function defaultMarkupRule(request: ConsoleRequest): Promise<MarkupTile> {
  try {
    let page = await request.console.settings.markupRules.list({ limit: MARKUP_PAGE_SIZE });
    for (let read = 1; ; read += 1) {
      const rule = page.data.find((candidate) => candidate.isDefault);
      if (rule !== undefined) {
        return { kind: "rule", rule };
      }
      const next = read < MARKUP_MAX_PAGES ? await page.next() : null;
      if (next === null) {
        return { kind: "none" };
      }
      page = next;
    }
  } catch (error) {
    return { kind: "failed", error: await apiFailure(error) };
  }
}

/** A percentage of the document (`"5.0000"`) as people write it (`5`, `2.5`, `-3`). */
function percentText(value: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(value);
  if (match === null) {
    return value;
  }
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  return `${match[1] ?? ""}${match[2] ?? ""}${fraction === "" ? "" : `.${fraction}`}`;
}

/** An amount of a rule, formatted. */
function moneyText(value: MoneyValue): string {
  return formatMoney(value) ?? `${value.amount} ${value.currency}`;
}

const APPLIES_PER: Readonly<Record<MarkupRule["appliesPer"], string>> = Object.freeze({
  booking: "per booking",
  traveler: "per traveller",
  segment: "per segment",
});

/** What a markup rule adds to the net price, in words (OADR-0005 point 4). */
function markupDescription(rule: MarkupRule): string {
  const percentage =
    rule.percentage === undefined || rule.percentage === null
      ? undefined
      : `${percentText(rule.percentage)} % of the net price`;
  const fixed = rule.fixed === undefined || rule.fixed === null ? undefined : moneyText(rule.fixed);
  const amount =
    rule.calculation === "percentage"
      ? (percentage ?? "0 % of the net price")
      : rule.calculation === "fixed"
        ? (fixed ?? "a fixed amount")
        : [percentage, fixed].filter((part): part is string => part !== undefined).join(" plus ");
  const caps = [
    rule.min === undefined || rule.min === null ? undefined : `at least ${moneyText(rule.min)}`,
    rule.max === undefined || rule.max === null ? undefined : `at most ${moneyText(rule.max)}`,
  ].filter((part): part is string => part !== undefined);
  const per = APPLIES_PER[rule.appliesPer] ?? rule.appliesPer;
  return caps.length === 0 ? `${amount}, ${per}.` : `${amount}, ${per} (${caps.join(", ")} each).`;
}

/** The default markup rule, for orientation beside the net prices. */
function MarkupTileView({ tile }: { readonly tile: MarkupTile }) {
  return (
    <section aria-labelledby="shopping-markup" className="grid max-w-3xl gap-2 rounded-xl border p-4">
      <h2 id="shopping-markup" className="text-base font-semibold">
        {PAGE_STRINGS.markupTitle}
      </h2>
      {tile.kind === "rule" ? (
        <>
          <p data-markup-rule={tile.rule.id}>
            <span className="font-medium">{tile.rule.name}</span>: {markupDescription(tile.rule)}
          </p>
          {tile.rule.isActive ? null : <p className="text-sm font-medium">{PAGE_STRINGS.markupOff}</p>}
          <p className={MUTED}>{PAGE_STRINGS.markupExplained}</p>
        </>
      ) : tile.kind === "none" ? (
        <p>{PAGE_STRINGS.markupNone}</p>
      ) : (
        <div role="alert" className="grid gap-1 text-sm">
          <p>
            {PAGE_STRINGS.markupFailed} {errorMessage(tile.error)}
          </p>
          {tile.error.requestId === null || tile.error.requestId === "" ? null : (
            <p className="text-muted-foreground">
              {PAGE_STRINGS.requestId}: <code>{tile.error.requestId}</code>
            </p>
          )}
        </div>
      )}
      <p className="text-sm">
        <Link href="/settings/markups" prefetch={false} className={LINK_CLASS}>
          {PAGE_STRINGS.markupRules}
        </Link>
      </p>
    </section>
  );
}

// ---- The page -----------------------------------------------------------------------------------------------------------

/** The heading, the notices and the environment's Amadeus offices. */
function Notices({
  staff,
  environment,
}: {
  readonly staff: ConsoleStaffProfile;
  readonly environment: string;
}) {
  const { supplier } = staff.tenant;
  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
        <p className="text-muted-foreground">{PAGE_STRINGS.intro}</p>
        <p className={MUTED}>
          {PAGE_STRINGS.environment(environment)}{" "}
          {supplier.officeIds.length === 0
            ? PAGE_STRINGS.noOffices
            : PAGE_STRINGS.offices(supplier.officeIds.join(", "))}
        </p>
      </div>
      <div
        role="note"
        className={cn("grid max-w-3xl gap-1 rounded-md px-3 py-2 text-sm", toneClasses("info"))}
      >
        <p className="font-medium">{PAGE_STRINGS.netTitle}</p>
        <p>{PAGE_STRINGS.net}</p>
        <p>{PAGE_STRINGS.audited}</p>
      </div>
      {supplier.connected ? null : (
        <p role="note" className={cn("max-w-3xl rounded-md px-3 py-2 text-sm", toneClasses("warning"))}>
          {PAGE_STRINGS.noSupplier}
        </p>
      )}
      <section aria-labelledby="shopping-later" className="grid max-w-3xl gap-1">
        <h2 id="shopping-later" className="text-base font-semibold">
          {PAGE_STRINGS.laterTitle}
        </h2>
        <p className="text-sm">
          {PAGE_STRINGS.later}{" "}
          <Link href="/pnr" prefetch={false} className={LINK_CLASS}>
            {PAGE_STRINGS.pnr}
          </Link>
          .
        </p>
      </section>
    </>
  );
}

export default async function ShoppingPage() {
  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={await apiFailure(error)} />;
  }
  const { staff, environment } = request;

  if (!can(staff, READ_PERMISSION)) {
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

  const markup = can(staff, SETTINGS_PERMISSION) ? await defaultMarkupRule(request) : undefined;
  return (
    <div className="grid gap-6">
      <Notices staff={staff} environment={environment} />
      {markup === undefined ? null : <MarkupTileView tile={markup} />}
      <ShoppingConsole environment={environment} defaultCurrency={staff.tenant.defaultCurrency} />
    </div>
  );
}
