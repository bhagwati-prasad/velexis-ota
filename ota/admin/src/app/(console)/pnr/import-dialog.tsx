"use client";

// "Import as a booking" on the PNR lookup `/pnr` (OAD-009, routes.md §4 step 2, console-operations flow §3 step 4): the
// confirmation dialog of `console.bookings.import` (`importBooking`) on OAD-004's `ConfirmDialog`, so the import gets
// what every console action gets: the summary, the environment badge, the live warning, a required reason and the
// idempotency key the page rendered once (a double click or a retry after a timeout replays the import instead of
// making a second booking; the key after a failure is the shared one of `ConfirmDialog`'s `useActionKey` and
// lib/action-state.ts, never this dialog's own).
//
// Its inputs: the pricing mode (`markup_rules`, `net`, or `override` with a selling total in the order's currency,
// offered when the page knows that currency), the customer the booking belongs to (the search of
// `console.customers.list`, active accounts, for staff with `customers:read`; none: a guest booking), the contact e-mail
// when the order has none, the confirmation e-mail, tags and an internal note. The hidden fields are the record locator,
// the match's Amadeus order id (the import never picks another order of the locator) and the order's currency.
//
// After a success the dialog opens the new booking's page (routes.md §4); when the API answered warnings with it (a
// confirmation that could not be queued) it stays and shows them with a link to the booking. After `409
// ORDER_ALREADY_IMPORTED` (a second import, by this form or by someone else) it links the existing booking. No input
// asks for a card, and every input has `autoComplete="off"`.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useId, useState, useTransition } from "react";

import { CheckboxField, RadioField, TextField } from "@/app/(console)/bookings/[bookingId]/patch-form";
import { ConfirmDialog, type ConfirmAction } from "@/components/confirm-dialog";
import { Money, type MoneyValue } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fieldError, type ActionState } from "@/lib/action-state";
import type { StaffEnvironment } from "@/lib/permissions";

import { importBooking, searchCustomers } from "./actions";
import {
  CONTACT_EMAIL_FIELD,
  CURRENCY_FIELD,
  CUSTOMER_FIELD,
  CUSTOMER_QUERY_MAX_LENGTH,
  DEFAULT_PRICING_MODE,
  FLIGHT_ORDER_FIELD,
  NOTE_FIELD,
  NOTE_MAX_LENGTH,
  PRICING_MODE_FIELD,
  PRICING_MODES,
  REFERENCE_FIELD,
  SELLING_TOTAL_FIELD,
  SEND_CONFIRMATION_FIELD,
  TAGS_FIELD,
  TAGS_MAX,
  TAG_MAX_LENGTH,
  bookingPath,
  importWarningsOf,
  importedBookingOf,
  type CustomerChoice,
  type CustomerSearchState,
  type ImportState,
  type PricingMode,
} from "./import-rules";

export const IMPORT_STRINGS = Object.freeze({
  trigger: "Import as a booking",
  title: (reference: string) => `Import ${reference} as a booking?`,
  summary: (flightOrderId: string) =>
    `Amadeus order ${flightOrderId} becomes a booking of this OTA (channel import). Nothing is paid through Velexis: its payment status is "not applicable".`,
  net: "Net price of the order:",
  manualReview: "An order without tickets goes to manual review: issue it from the booking's page.",
  confirm: "Import",
  pricing: "Selling price",
  pricingDetails: {
    markup_rules: "Priced as the storefront would: the OTA's markup and fee rules.",
    net: "Sold at the price Amadeus charges: no markup, no fee.",
    override: "Sold at the total you enter: at least the net price, in the order's currency.",
  } satisfies Record<PricingMode, string>,
  sellingTotal: (currency: string) => `Selling total (${currency})`,
  sellingTotalHint: "Digits with at most two decimals, like 1450.00.",
  customer: "Customer",
  customerHint: "Attach the booking to a customer's account, or keep it a guest booking.",
  customerSearch: "Find a customer by e-mail address or name",
  search: "Search",
  searching: "Searching…",
  guest: "No customer: a guest booking",
  noCustomer: "No active customer matches.",
  contactEmail: "Contact e-mail",
  contactEmailHint:
    "Only when the order has no e-mail address: the booking's contact otherwise comes from the order or the customer.",
  sendConfirmation: "Send the booking confirmation to the contact",
  tags: "Tags",
  tagsHint: `Up to ${TAGS_MAX}, separated by commas, at most ${TAG_MAX_LENGTH} characters each.`,
  note: "Internal note",
  noteHint: "Saved on the booking's timeline for staff only.",
  existing: "This order is already a booking of this OTA:",
  openBooking: (reference: string) => `Open booking ${reference}`,
});

/** The customer search the dialog calls: the server action, or a fake in tests. */
export type CustomerSearch = (query: string) => Promise<CustomerSearchState>;

export interface ImportDialogProps {
  /** The record locator that was looked up. */
  readonly reference: string;
  /** The match's Amadeus order id. */
  readonly flightOrderId: string;
  /** The order's currency (an override's selling total is in it); `null` when the page does not know it. */
  readonly currency: string | null;
  /** The order's net grand total, shown in the summary. */
  readonly net: MoneyValue | null;
  /** The environment the import runs in. */
  readonly environment: StaffEnvironment;
  /** The idempotency key rendered with the page (`crypto.randomUUID()`, once per render). */
  readonly idempotencyKey: string;
  /** The staff member may search customers (`customers:read`); without it the booking is a guest booking. */
  readonly canSearchCustomers: boolean;
}

/** The "Import as a booking" button of an importable match and its confirmation dialog. */
export function ImportDialog({
  reference,
  flightOrderId,
  currency,
  net,
  environment,
  idempotencyKey,
  canSearchCustomers,
}: ImportDialogProps) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<ImportState | undefined>(undefined);
  // `importBooking`, and what its answer means for the page: a new booking without warnings is opened at once.
  const action = useCallback<ConfirmAction>(
    async (state, form) => {
      const next = await importBooking(state, form);
      setOutcome(next);
      const booking = importedBookingOf(next);
      if (next.ok === true && booking !== undefined && importWarningsOf(next).length === 0) {
        router.push(bookingPath(booking.id));
      }
      return next;
    },
    [router],
  );
  const imported = outcome?.ok === true ? importedBookingOf(outcome) : undefined;

  return (
    <div className="grid justify-items-start gap-1">
      <ConfirmDialog
        trigger={
          <Button type="button" size="sm">
            {IMPORT_STRINGS.trigger}
          </Button>
        }
        title={IMPORT_STRINGS.title(reference)}
        summary={
          <div className="grid gap-2">
            <p>{IMPORT_STRINGS.summary(flightOrderId)}</p>
            {net === null ? null : (
              <p>
                {IMPORT_STRINGS.net} <Money value={net} />.
              </p>
            )}
            <p>{IMPORT_STRINGS.manualReview}</p>
          </div>
        }
        confirmLabel={IMPORT_STRINGS.confirm}
        environment={environment}
        action={action}
        idempotencyKey={idempotencyKey}
        destructive={false}
        fields={{
          [REFERENCE_FIELD]: reference,
          [FLIGHT_ORDER_FIELD]: flightOrderId,
          ...(currency === null ? {} : { [CURRENCY_FIELD]: currency }),
        }}
      >
        {(state) => (
          <ImportFields state={state} currency={currency} canSearchCustomers={canSearchCustomers} />
        )}
      </ConfirmDialog>
      {imported === undefined ? null : (
        <Link
          href={bookingPath(imported.id)}
          className="text-sm font-medium text-primary underline underline-offset-4"
        >
          {IMPORT_STRINGS.openBooking(imported.reference)}
        </Link>
      )}
    </div>
  );
}

/** The dialog's inputs above the reason; `state` is the dialog's, for the field errors and the existing booking. */
function ImportFields({
  state,
  currency,
  canSearchCustomers,
}: {
  readonly state: ActionState;
  readonly currency: string | null;
  readonly canSearchCustomers: boolean;
}) {
  const [mode, setMode] = useState<PricingMode>(DEFAULT_PRICING_MODE);
  const existing = state.ok === false ? importedBookingOf(state) : undefined;
  const choices =
    currency === null ? PRICING_MODES.filter((choice) => choice.value !== "override") : PRICING_MODES;
  return (
    <>
      {existing === undefined ? null : (
        <p role="note" className="rounded-md border px-3 py-2 text-sm">
          {IMPORT_STRINGS.existing}{" "}
          <Link
            href={bookingPath(existing.id)}
            className="font-medium text-primary underline underline-offset-4"
          >
            {IMPORT_STRINGS.openBooking(existing.reference)}
          </Link>
        </p>
      )}
      <RadioField
        name={PRICING_MODE_FIELD}
        label={IMPORT_STRINGS.pricing}
        state={state}
        choices={choices}
        value={mode}
        onChange={(value) => setMode(value as PricingMode)}
        details={IMPORT_STRINGS.pricingDetails}
      />
      {mode === "override" && currency !== null ? (
        <TextField
          name={SELLING_TOTAL_FIELD}
          label={IMPORT_STRINGS.sellingTotal(currency)}
          hint={IMPORT_STRINGS.sellingTotalHint}
          state={state}
          inputMode="decimal"
          maxLength={13}
        />
      ) : null}
      {canSearchCustomers ? <CustomerPicker state={state} search={searchCustomers} /> : null}
      <TextField
        name={CONTACT_EMAIL_FIELD}
        type="email"
        inputMode="email"
        label={IMPORT_STRINGS.contactEmail}
        hint={IMPORT_STRINGS.contactEmailHint}
        state={state}
        maxLength={254}
      />
      <CheckboxField name={SEND_CONFIRMATION_FIELD} label={IMPORT_STRINGS.sendConfirmation} state={state} />
      <TextField
        name={TAGS_FIELD}
        label={IMPORT_STRINGS.tags}
        hint={IMPORT_STRINGS.tagsHint}
        state={state}
        maxLength={TAGS_MAX * (TAG_MAX_LENGTH + 2)}
      />
      <NoteField state={state} />
    </>
  );
}

/** The customer search and the choice it offers (`customerId`; the guest booking first, chosen at first). */
function CustomerPicker({ state, search }: { readonly state: ActionState; readonly search: CustomerSearch }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<CustomerSearchState | undefined>(undefined);
  const [selected, setSelected] = useState("");
  const [pending, startSearch] = useTransition();
  const error = fieldError(state, CUSTOMER_FIELD);
  const customers: readonly CustomerChoice[] = result?.ok === true ? (result.customers ?? []) : [];

  function run(): void {
    startSearch(async () => {
      const found = await search(query);
      setResult(found);
      // A customer chosen before stays chosen only when the new search lists them.
      const kept = found.customers?.some((customer) => customer.id === selected) === true;
      if (!kept) {
        setSelected("");
      }
    });
  }

  return (
    <fieldset
      className="grid gap-2"
      aria-describedby={error === undefined ? `${id}-hint` : `${id}-hint ${id}-error`}
      {...(error === undefined ? {} : { "aria-invalid": true })}
    >
      <legend className="mb-1 text-sm font-medium">{IMPORT_STRINGS.customer}</legend>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {IMPORT_STRINGS.customerHint}
      </p>
      <Label htmlFor={`${id}-query`}>{IMPORT_STRINGS.customerSearch}</Label>
      <div className="flex gap-2">
        {/* No `name`: the search text is never posted with the import. */}
        <Input
          id={`${id}-query`}
          type="search"
          value={query}
          autoComplete="off"
          maxLength={CUSTOMER_QUERY_MAX_LENGTH}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Enter searches; it never sends the import.
            if (event.key === "Enter") {
              event.preventDefault();
              run();
            }
          }}
        />
        <Button type="button" variant="outline" onClick={run} disabled={pending} aria-busy={pending}>
          {pending ? IMPORT_STRINGS.searching : IMPORT_STRINGS.search}
        </Button>
      </div>
      {result?.ok === false && result.message !== undefined ? (
        <p role="alert" className="text-sm text-destructive">
          {result.message}
        </p>
      ) : null}
      <div className="grid gap-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={CUSTOMER_FIELD}
            value=""
            checked={selected === ""}
            onChange={() => setSelected("")}
            className="size-4 accent-primary"
          />
          {IMPORT_STRINGS.guest}
        </label>
        {customers.map((customer) => (
          <label key={customer.id} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={CUSTOMER_FIELD}
              value={customer.id}
              checked={selected === customer.id}
              onChange={() => setSelected(customer.id)}
              className="size-4 accent-primary"
            />
            <span>{customer.name === null ? customer.email : `${customer.name} (${customer.email})`}</span>
          </label>
        ))}
      </div>
      {result?.ok === true && customers.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {IMPORT_STRINGS.noCustomer}
        </p>
      ) : null}
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** The internal note, with its error. */
function NoteField({ state }: { readonly state: ActionState }) {
  const id = useId();
  const error = fieldError(state, NOTE_FIELD);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{IMPORT_STRINGS.note}</Label>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {IMPORT_STRINGS.noteHint}
      </p>
      <Textarea
        id={id}
        name={NOTE_FIELD}
        rows={2}
        maxLength={NOTE_MAX_LENGTH}
        autoComplete="off"
        aria-describedby={error === undefined ? `${id}-hint` : `${id}-hint ${id}-error`}
        {...(error === undefined ? {} : { "aria-invalid": true })}
      />
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
