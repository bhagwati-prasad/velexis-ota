"use client";

// The order's edits on a booking's page (OAD-008, routes.md §3.2 "Actions": edit travellers, contacts, remarks and the
// ticketing agreement; resync), and the small form fields every action dialog of the page uses.
//
// - `BookingEditPanel` (the Travellers and contacts tab, `bookings:write` and `consoleActions.canPatch`): one
//   confirmation dialog per element, each a `console.bookings.patch` of that element only (`patchBooking`): a
//   traveller's name, date of birth, gender, e-mail and phone (merged over the stored traveller by the API); a contact,
//   which replaces the order's contact of the same purpose (so every field of it is in the dialog, prefilled, and its
//   language kept); a new general remark (added to the order's remarks); the ticketing agreement (`option` and, for the
//   two delays, `delay`). Each sends `ifMatch` = the version the page displayed and a required reason; a `412` asks
//   for a reload. Identity documents are not edited here (their numbers are masked on this page). The API replaces a
//   traveller's `contact` and an order contact whole, so their dialogs also post the stored contact (`kept`, JSON of
//   action-rules.ts `keptContactOf`): the action sends what the dialog does not show (other phones, a phone's device
//   type, a state, a post box, a middle name, a traveller's address) back as it was.
// - `ResyncForm` (`bookings:write` and `consoleActions.canResync`): `console.bookings.resync`, safe to repeat, with the
//   differences it applied listed under the button. The API keeps no reason for it, so it is a plain form.
//
// No input here, or in any other dialog of the page, asks for a card: no card number, holder, expiry or security code
// (OADR-0018 point 8). Every input has `autoComplete="off"`, so a browser offers nothing it saved either.
import { LoaderCircleIcon } from "lucide-react";
import { startTransition, useActionState, useId, type FormEvent, type ReactNode } from "react";

import {
  AGREEMENT_OPTIONS,
  BOOKING_ID_FIELD,
  CONTACT_PURPOSES,
  GENDERS,
  KEPT_FIELD,
  NOTIFY_FIELD,
  PATCH_ELEMENT_FIELD,
  PATCH_FIELDS,
  REMARK_TYPES,
  VERSION_FIELD,
  labelOfChoice,
  type Choice,
  type PatchElement,
} from "@/app/(console)/bookings/[bookingId]/action-rules";
import { patchBooking, resyncBooking, type ResyncState } from "@/app/(console)/bookings/[bookingId]/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { INITIAL_ACTION_STATE, fieldError, type ActionState } from "@/lib/action-state";
import type { StaffEnvironment } from "@/lib/permissions";
import { cn } from "@/lib/utils";

// ---- Fields shared by the page's dialogs --------------------------------------------------------------------------

const CONTROL_CLASS =
  "border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:border-destructive";

/** A field's error message, linked to its input with `aria-describedby`. */
function FieldMessage({ id, message }: { readonly id: string; readonly message: string | undefined }) {
  return message === undefined ? null : (
    <p id={id} className="text-sm font-medium text-destructive">
      {message}
    </p>
  );
}

/** `aria-describedby` and `aria-invalid` of an input with an optional hint and an optional error. */
function describedBy(hintId: string | undefined, errorId: string, error: string | undefined) {
  const ids = [hintId, error === undefined ? undefined : errorId].filter(
    (id): id is string => id !== undefined,
  );
  return {
    ...(ids.length === 0 ? {} : { "aria-describedby": ids.join(" ") }),
    ...(error === undefined ? {} : { "aria-invalid": true as const }),
  };
}

interface FieldProps {
  /** The form field's name (action-rules.ts). */
  readonly name: string;
  readonly label: string;
  /** The dialog's state: the field shows its error. */
  readonly state: ActionState;
  readonly hint?: string;
}

/** A text input with its label, hint and error. */
export function TextField({
  name,
  label,
  state,
  hint,
  defaultValue,
  type = "text",
  inputMode,
  placeholder,
  maxLength,
}: FieldProps & {
  readonly defaultValue?: string | undefined;
  readonly type?: "text" | "email" | "date" | "tel";
  readonly inputMode?: "text" | "decimal" | "numeric" | "email" | "tel";
  readonly placeholder?: string;
  readonly maxLength?: number;
}) {
  const id = useId();
  const error = fieldError(state, name);
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <Input
        id={id}
        name={name}
        type={type}
        autoComplete="off"
        {...(defaultValue === undefined ? {} : { defaultValue })}
        {...(inputMode === undefined ? {} : { inputMode })}
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(maxLength === undefined ? {} : { maxLength })}
        {...describedBy(hintId, `${id}-error`, error)}
      />
      <FieldMessage id={`${id}-error`} message={error} />
    </div>
  );
}

/** A native select with its label and error; the first option asks for a choice when there is no default. */
export function SelectField({
  name,
  label,
  state,
  hint,
  choices,
  defaultValue,
  placeholder = "Choose…",
}: FieldProps & {
  readonly choices: readonly Choice[];
  readonly defaultValue?: string | undefined;
  readonly placeholder?: string;
}) {
  const id = useId();
  const error = fieldError(state, name);
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <select
        id={id}
        name={name}
        defaultValue={defaultValue ?? ""}
        autoComplete="off"
        className={CONTROL_CLASS}
        {...describedBy(hintId, `${id}-error`, error)}
      >
        <option value="">{placeholder}</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      <FieldMessage id={`${id}-error`} message={error} />
    </div>
  );
}

/** A checkbox that posts `true` when ticked. */
export function CheckboxField({
  name,
  label,
  state,
  hint,
  defaultChecked = false,
}: FieldProps & { readonly defaultChecked?: boolean }) {
  const id = useId();
  const error = fieldError(state, name);
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          name={name}
          value="true"
          defaultChecked={defaultChecked}
          className="size-4 accent-primary"
          {...describedBy(hintId, `${id}-error`, error)}
        />
        <Label htmlFor={id}>{label}</Label>
      </div>
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldMessage id={`${id}-error`} message={error} />
    </div>
  );
}

/** A group of radio buttons (a `fieldset` with its legend); controlled when `value` and `onChange` are given. */
export function RadioField({
  name,
  label,
  state,
  hint,
  choices,
  value,
  onChange,
  details,
}: FieldProps & {
  readonly choices: readonly Choice[];
  readonly value?: string | undefined;
  readonly onChange?: (value: string) => void;
  /** What a choice does, under its label. */
  readonly details?: Readonly<Record<string, ReactNode>>;
}) {
  const id = useId();
  const error = fieldError(state, name);
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <fieldset className="grid gap-2" {...describedBy(hintId, `${id}-error`, error)}>
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {choices.map((choice) => (
        <div key={choice.value} className="grid gap-0.5">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={name}
              value={choice.value}
              className="size-4 accent-primary"
              {...(value === undefined ? {} : { checked: value === choice.value })}
              {...(onChange === undefined ? {} : { onChange: () => onChange(choice.value) })}
            />
            {choice.label}
          </label>
          {details?.[choice.value] === undefined ? null : (
            <p className="pl-6 text-xs text-muted-foreground">{details[choice.value]}</p>
          )}
        </div>
      ))}
      <FieldMessage id={`${id}-error`} message={error} />
    </fieldset>
  );
}

// ---- The order's edits ----------------------------------------------------------------------------------------------

export const PATCH_STRINGS = Object.freeze({
  title: "Edit the Amadeus order",
  description:
    "Each change is sent to Amadeus (Flight Order Management PATCH) with the version shown on this page; if someone changed the booking meanwhile, reload and try again.",
  editTraveler: (name: string) => `Edit ${name}`,
  editTravelerTitle: (name: string) => `Edit the traveller ${name}?`,
  editTravelerSummary:
    "The name, date of birth, gender, e-mail and phone are sent to Amadeus and merged over the traveller's other data; the rest of the traveller's contact (other phones, an address) is kept. Identity documents are not changed here.",
  editContact: (purpose: string) => `Edit the ${purpose.toLowerCase()} contact`,
  editContactTitle: (purpose: string) => `Edit the ${purpose.toLowerCase()} contact?`,
  editContactSummary:
    "The contact replaces the order's contact of the same purpose: every field below is sent as it is, and what the order has besides (other phones, a state, a post box) is kept.",
  addRemark: "Add a remark",
  addRemarkTitle: "Add a remark to the order?",
  addRemarkSummary: "The remark is added to the order's remarks in Amadeus; the other remarks stay.",
  agreement: "Change the ticketing agreement",
  agreementTitle: "Change the ticketing agreement?",
  agreementSummary:
    "Amadeus applies the option when the order is not issued in time. The ticketing deadline follows the new agreement.",
  save: "Save to Amadeus",
  notify: "E-mail the traveller about the change",
  notifyHint: "The booking's contact e-mail gets the updated booking.",
  firstName: "First name",
  lastName: "Last name",
  dateOfBirth: "Date of birth",
  companyName: "Company",
  gender: "Gender",
  email: "E-mail",
  phoneCountryCode: "Phone country code",
  phoneNumber: "Phone number",
  addressLine1: "Address",
  addressLine2: "Address, second line",
  postalCode: "Postal code",
  cityName: "City",
  countryCode: "Country code",
  remarkType: "Remark type",
  remarkText: "Remark",
  remarkTextHint: "Amadeus stores remarks in capital letters.",
  agreementOption: "Option",
  agreementDelay: "Delay",
  agreementDelayHint: "Whole days, like 2D (for the two delay options only).",
});

/** A traveller as its dialog edits it. */
export interface TravelerEditValues {
  /** The Amadeus traveller id (`travelerId`: `"1"`). */
  readonly travelerId: string;
  /** The name the page shows, for the button and the title. */
  readonly label: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth?: string | undefined;
  readonly gender?: string | undefined;
  readonly email?: string | undefined;
  readonly phoneCountryCode?: string | undefined;
  readonly phoneNumber?: string | undefined;
  /** The stored contact as JSON (`kept`, action-rules.ts `keptFieldOf`), sent back with the edits. */
  readonly kept?: string | undefined;
}

/** A contact of the order as its dialog edits it. */
export interface ContactEditValues {
  readonly purpose: string;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly companyName?: string | undefined;
  readonly email?: string | undefined;
  readonly phoneCountryCode?: string | undefined;
  readonly phoneNumber?: string | undefined;
  readonly addressLine1?: string | undefined;
  readonly addressLine2?: string | undefined;
  readonly postalCode?: string | undefined;
  readonly cityName?: string | undefined;
  readonly countryCode?: string | undefined;
  /** Kept as it is (a hidden field): the contact is replaced whole. */
  readonly language?: string | undefined;
  /** The stored contact as JSON (`kept`, action-rules.ts `keptFieldOf`), sent back with the edits. */
  readonly kept?: string | undefined;
}

export interface BookingEditPanelProps {
  readonly bookingId: string;
  /** The booking `version` the page displayed (`ifMatch`). */
  readonly version: number;
  readonly environment: StaffEnvironment;
  /** One key per dialog, rendered with the page (a patch sends none; the dialog posts it all the same). */
  readonly idempotencyKeys: Readonly<Record<string, string>>;
  readonly travelers: readonly TravelerEditValues[];
  readonly contacts: readonly ContactEditValues[];
  readonly agreement: { readonly option?: string | undefined; readonly delay?: string | undefined };
}

/** The hidden fields of a patch dialog. */
function patchFields(
  bookingId: string,
  version: number,
  element: PatchElement,
  extra: Record<string, string> = {},
) {
  return {
    [BOOKING_ID_FIELD]: bookingId,
    [VERSION_FIELD]: String(version),
    [PATCH_ELEMENT_FIELD]: element,
    ...extra,
  };
}

/** The key of a dialog of the panel. */
function keyOf(keys: Readonly<Record<string, string>>, name: string): string {
  return keys[name] ?? keys["default"] ?? "";
}

/** The phone fields of a traveller or a contact. */
function PhoneFields({
  state,
  countryCode,
  number,
}: {
  readonly state: ActionState;
  readonly countryCode?: string | undefined;
  readonly number?: string | undefined;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3">
      <TextField
        name={PATCH_FIELDS.phoneCountryCode}
        label={PATCH_STRINGS.phoneCountryCode}
        state={state}
        defaultValue={countryCode}
        inputMode="tel"
        maxLength={4}
      />
      <TextField
        name={PATCH_FIELDS.phoneNumber}
        label={PATCH_STRINGS.phoneNumber}
        state={state}
        defaultValue={number}
        inputMode="numeric"
        maxLength={15}
      />
    </div>
  );
}

/** The "tell the traveller" checkbox of a patch (unticked: the API's default). */
function NotifyField({ state }: { readonly state: ActionState }) {
  return (
    <CheckboxField
      name={NOTIFY_FIELD}
      label={PATCH_STRINGS.notify}
      hint={PATCH_STRINGS.notifyHint}
      state={state}
    />
  );
}

/** The dialog of one traveller. */
export function TravelerEditDialog({
  bookingId,
  version,
  environment,
  idempotencyKey,
  traveler,
}: {
  readonly bookingId: string;
  readonly version: number;
  readonly environment: StaffEnvironment;
  readonly idempotencyKey: string;
  readonly traveler: TravelerEditValues;
}) {
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline" size="sm">
          {PATCH_STRINGS.editTraveler(traveler.label)}
        </Button>
      }
      title={PATCH_STRINGS.editTravelerTitle(traveler.label)}
      summary={<p>{PATCH_STRINGS.editTravelerSummary}</p>}
      confirmLabel={PATCH_STRINGS.save}
      environment={environment}
      action={patchBooking}
      idempotencyKey={idempotencyKey}
      destructive={false}
      fields={patchFields(bookingId, version, "traveler", {
        [PATCH_FIELDS.travelerId]: traveler.travelerId,
        ...(traveler.kept === undefined ? {} : { [KEPT_FIELD]: traveler.kept }),
      })}
    >
      {(state) => (
        <>
          <div className="grid grid-cols-2 gap-3">
            <TextField
              name={PATCH_FIELDS.firstName}
              label={PATCH_STRINGS.firstName}
              state={state}
              defaultValue={traveler.firstName}
              maxLength={60}
            />
            <TextField
              name={PATCH_FIELDS.lastName}
              label={PATCH_STRINGS.lastName}
              state={state}
              defaultValue={traveler.lastName}
              maxLength={60}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField
              name={PATCH_FIELDS.dateOfBirth}
              label={PATCH_STRINGS.dateOfBirth}
              state={state}
              type="date"
              defaultValue={traveler.dateOfBirth}
            />
            <SelectField
              name={PATCH_FIELDS.gender}
              label={PATCH_STRINGS.gender}
              state={state}
              choices={GENDERS}
              defaultValue={traveler.gender}
              placeholder="Not set"
            />
          </div>
          <TextField
            name={PATCH_FIELDS.email}
            label={PATCH_STRINGS.email}
            state={state}
            type="email"
            defaultValue={traveler.email}
            maxLength={120}
          />
          <PhoneFields state={state} countryCode={traveler.phoneCountryCode} number={traveler.phoneNumber} />
          <NotifyField state={state} />
        </>
      )}
    </ConfirmDialog>
  );
}

/** The dialog of one contact of the order (it replaces the contact of its purpose). */
export function ContactEditDialog({
  bookingId,
  version,
  environment,
  idempotencyKey,
  contact,
}: {
  readonly bookingId: string;
  readonly version: number;
  readonly environment: StaffEnvironment;
  readonly idempotencyKey: string;
  readonly contact: ContactEditValues;
}) {
  const purpose = labelOfChoice(CONTACT_PURPOSES, contact.purpose);
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline" size="sm">
          {PATCH_STRINGS.editContact(purpose)}
        </Button>
      }
      title={PATCH_STRINGS.editContactTitle(purpose)}
      summary={<p>{PATCH_STRINGS.editContactSummary}</p>}
      confirmLabel={PATCH_STRINGS.save}
      environment={environment}
      action={patchBooking}
      idempotencyKey={idempotencyKey}
      destructive={false}
      fields={patchFields(bookingId, version, "contact", {
        [PATCH_FIELDS.purpose]: contact.purpose,
        ...(contact.language === undefined ? {} : { [PATCH_FIELDS.language]: contact.language }),
        ...(contact.kept === undefined ? {} : { [KEPT_FIELD]: contact.kept }),
      })}
    >
      {(state) => (
        <>
          <div className="grid grid-cols-2 gap-3">
            <TextField
              name={PATCH_FIELDS.firstName}
              label={PATCH_STRINGS.firstName}
              state={state}
              defaultValue={contact.firstName}
              maxLength={60}
            />
            <TextField
              name={PATCH_FIELDS.lastName}
              label={PATCH_STRINGS.lastName}
              state={state}
              defaultValue={contact.lastName}
              maxLength={60}
            />
          </div>
          <TextField
            name={PATCH_FIELDS.companyName}
            label={PATCH_STRINGS.companyName}
            state={state}
            defaultValue={contact.companyName}
            maxLength={60}
          />
          <TextField
            name={PATCH_FIELDS.email}
            label={PATCH_STRINGS.email}
            state={state}
            type="email"
            defaultValue={contact.email}
            maxLength={120}
          />
          <PhoneFields state={state} countryCode={contact.phoneCountryCode} number={contact.phoneNumber} />
          <TextField
            name={PATCH_FIELDS.addressLine1}
            label={PATCH_STRINGS.addressLine1}
            state={state}
            defaultValue={contact.addressLine1}
            maxLength={70}
          />
          <TextField
            name={PATCH_FIELDS.addressLine2}
            label={PATCH_STRINGS.addressLine2}
            state={state}
            defaultValue={contact.addressLine2}
            maxLength={70}
          />
          <div className="grid grid-cols-3 gap-3">
            <TextField
              name={PATCH_FIELDS.postalCode}
              label={PATCH_STRINGS.postalCode}
              state={state}
              defaultValue={contact.postalCode}
              maxLength={17}
            />
            <TextField
              name={PATCH_FIELDS.cityName}
              label={PATCH_STRINGS.cityName}
              state={state}
              defaultValue={contact.cityName}
              maxLength={35}
            />
            <TextField
              name={PATCH_FIELDS.countryCode}
              label={PATCH_STRINGS.countryCode}
              state={state}
              defaultValue={contact.countryCode}
              maxLength={2}
            />
          </div>
          <NotifyField state={state} />
        </>
      )}
    </ConfirmDialog>
  );
}

/** The dialog that adds a general remark. */
export function RemarkAddDialog({
  bookingId,
  version,
  environment,
  idempotencyKey,
}: {
  readonly bookingId: string;
  readonly version: number;
  readonly environment: StaffEnvironment;
  readonly idempotencyKey: string;
}) {
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline" size="sm">
          {PATCH_STRINGS.addRemark}
        </Button>
      }
      title={PATCH_STRINGS.addRemarkTitle}
      summary={<p>{PATCH_STRINGS.addRemarkSummary}</p>}
      confirmLabel={PATCH_STRINGS.save}
      environment={environment}
      action={patchBooking}
      idempotencyKey={idempotencyKey}
      destructive={false}
      fields={patchFields(bookingId, version, "remark")}
    >
      {(state) => (
        <>
          <SelectField
            name={PATCH_FIELDS.remarkType}
            label={PATCH_STRINGS.remarkType}
            state={state}
            choices={REMARK_TYPES}
            defaultValue="GENERAL_MISCELLANEOUS"
          />
          <TextField
            name={PATCH_FIELDS.remarkText}
            label={PATCH_STRINGS.remarkText}
            hint={PATCH_STRINGS.remarkTextHint}
            state={state}
            maxLength={200}
          />
        </>
      )}
    </ConfirmDialog>
  );
}

/** The dialog of the ticketing agreement. */
export function AgreementDialog({
  bookingId,
  version,
  environment,
  idempotencyKey,
  agreement,
}: {
  readonly bookingId: string;
  readonly version: number;
  readonly environment: StaffEnvironment;
  readonly idempotencyKey: string;
  readonly agreement: BookingEditPanelProps["agreement"];
}) {
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline" size="sm">
          {PATCH_STRINGS.agreement}
        </Button>
      }
      title={PATCH_STRINGS.agreementTitle}
      summary={<p>{PATCH_STRINGS.agreementSummary}</p>}
      confirmLabel={PATCH_STRINGS.save}
      environment={environment}
      action={patchBooking}
      idempotencyKey={idempotencyKey}
      destructive={false}
      fields={patchFields(bookingId, version, "ticketingAgreement")}
    >
      {(state) => (
        <>
          <SelectField
            name={PATCH_FIELDS.agreementOption}
            label={PATCH_STRINGS.agreementOption}
            state={state}
            choices={AGREEMENT_OPTIONS}
            defaultValue={agreement.option}
          />
          <TextField
            name={PATCH_FIELDS.agreementDelay}
            label={PATCH_STRINGS.agreementDelay}
            hint={PATCH_STRINGS.agreementDelayHint}
            state={state}
            defaultValue={agreement.delay}
            maxLength={4}
          />
        </>
      )}
    </ConfirmDialog>
  );
}

/** The order's edits of the Travellers and contacts tab: one dialog per traveller and contact, a remark, the agreement. */
export function BookingEditPanel({
  bookingId,
  version,
  environment,
  idempotencyKeys,
  travelers,
  contacts,
  agreement,
}: BookingEditPanelProps) {
  const common = { bookingId, version, environment };
  return (
    <section aria-label={PATCH_STRINGS.title} className="grid gap-2 rounded-md border p-4">
      <h2 className="font-semibold">{PATCH_STRINGS.title}</h2>
      <p className="text-sm text-muted-foreground">{PATCH_STRINGS.description}</p>
      <div className="flex flex-wrap items-start gap-2">
        {travelers.map((traveler) => (
          <TravelerEditDialog
            key={traveler.travelerId}
            {...common}
            idempotencyKey={keyOf(idempotencyKeys, `traveler:${traveler.travelerId}`)}
            traveler={traveler}
          />
        ))}
        {contacts.map((contact) => (
          <ContactEditDialog
            key={contact.purpose}
            {...common}
            idempotencyKey={keyOf(idempotencyKeys, `contact:${contact.purpose}`)}
            contact={contact}
          />
        ))}
        <RemarkAddDialog {...common} idempotencyKey={keyOf(idempotencyKeys, "remark")} />
        <AgreementDialog
          {...common}
          idempotencyKey={keyOf(idempotencyKeys, "agreement")}
          agreement={agreement}
        />
      </div>
    </section>
  );
}

// ---- Resync ---------------------------------------------------------------------------------------------------------

export const RESYNC_STRINGS = Object.freeze({
  button: "Resync from Amadeus",
  working: "Resyncing…",
  changes: "Changes applied",
  requestId: (requestId: string) => `Request id ${requestId}`,
});

/**
 * "Resync from Amadeus" (`console.bookings.resync`): reads the order again and applies what changed (safe to repeat;
 * the API allows one per 10 s). The answer's differences are listed under the button.
 */
export function ResyncForm({ bookingId }: { readonly bookingId: string }) {
  const [state, dispatch, pending] = useActionState<ResyncState, FormData>(
    resyncBooking,
    INITIAL_ACTION_STATE,
  );
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }
  const changes = state.changes ?? [];
  return (
    <form onSubmit={submit} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name={BOOKING_ID_FIELD} value={bookingId} />
      <Button type="submit" variant="outline" disabled={pending} aria-busy={pending}>
        {pending ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : null}
        {pending ? RESYNC_STRINGS.working : RESYNC_STRINGS.button}
      </Button>
      {state.message === undefined ? null : (
        <div
          role={state.ok === true ? "status" : "alert"}
          className={cn(
            "grid gap-1 text-sm",
            state.ok === true ? "text-muted-foreground" : "text-destructive",
          )}
        >
          <p>{state.message}</p>
          {state.requestId === undefined ? null : <p>{RESYNC_STRINGS.requestId(state.requestId)}</p>}
          {changes.length === 0 ? null : (
            <ul aria-label={RESYNC_STRINGS.changes} className="grid gap-0.5 text-foreground">
              {changes.map((change) => (
                <li key={change.path}>
                  <span className="font-medium">{change.label}</span>: {change.before} → {change.after}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
