"use client";

// The sections of `/settings/storefront` (OAD-014; routes.md §9, api-changes part 2 §2.3, OADR-0012, OADR-0004,
// OADR-0008): one form per section of the storefront settings, in the page's tabs (brand and theme; locales and
// markets; features; policies; payments; legal and support; SEO and consent; operations). Each form posts its section
// complete to its own server action (actions.ts), with the settings' version the page displayed (`ifMatch`), and shows
// the action's answer: "Saved" with the API's `warnings[]`, or the refusal with its request id and the field errors on
// their fields (`aria-describedby`). The page is a server component that reads the API; this module never imports the
// SDK or the session code, and gets plain values (the settings as the API answered them, the uploaded images, the time
// zones), never a token.
//
// - Every tab stays mounted while another is shown (`forceMount`), so switching tabs keeps what was typed. A save
//   revalidates the page: every form gets the new version, and a form whose section changed (the one just saved, or
//   one someone else changed) starts again from the saved values (`key`), while the others keep what was typed.
// - Staff without `settings:write` (agents, finance, viewers) see every section read only: the fields disabled, no
//   "Save" (the actions refuse them anyway).
// - The airline card in live stays off while the platform's switch is off: the switch cannot be read from here, so the
//   live box is offered only when the API already has it on (to turn it off); the API refuses turning it on until the
//   platform's security review switches it on (`403 FEATURE_DISABLED`, shown on the box).
//
// Every input has `autoComplete="off"`; nothing here asks for a card.
import type { StorefrontSettings } from "@velexis/ota-sdk";
import { LoaderCircleIcon, PlusIcon } from "lucide-react";
import { startTransition, useActionState, useId, useState, type FormEvent, type ReactNode } from "react";

import {
  CheckboxField,
  RadioField,
  SelectField,
  TextField,
} from "@/app/(console)/bookings/[bookingId]/patch-form";
import type { ConfirmAction } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { INITIAL_ACTION_STATE, fieldError, type ActionState } from "@/lib/action-state";
import { cn } from "@/lib/utils";

import { RuleWarnings } from "../pricing-rule-form";
import {
  saveAirlineCard,
  saveBrand,
  saveBranding,
  saveConsent,
  saveCurrencies,
  saveFeatures,
  saveLegal,
  saveLocales,
  saveMarkets,
  saveOperations,
  savePolicies,
  saveSeo,
  saveSupport,
} from "./actions";
import {
  CARD_BRANDS,
  CONSENT_CATEGORIES,
  CONSENT_REGIMES,
  LEGAL_LINK_KINDS,
  LEGAL_LINK_TARGETS,
  MAX_LIST_LENGTH,
  PAYMENT_TIMING,
  STOREFRONT_TABS,
  TICKETING_POLICIES,
  VERSION_FIELD,
  warningsOf,
  type SettingsSection,
  type StorefrontTab,
} from "./settings-rules";
import { AssetPicker, ThemeEditor, type AssetsByKind } from "./theme-editor";

type Market = StorefrontSettings["markets"]["list"][number];
type LegalLink = StorefrontSettings["legal"]["links"][number];

// ---- Words ------------------------------------------------------------------------------------------------------

export const SECTION_STRINGS = Object.freeze({
  tabs: "Storefront settings sections",
  save: (title: string) => `Save ${title.toLowerCase()}`,
  saving: "Saving…",
  requestId: (requestId: string) => `Request id ${requestId}`,
  sections: {
    brand: {
      title: "Brand",
      description: "The OTA's name in the storefront and in e-mails.",
    },
    branding: {
      title: "Branding and theme",
      description:
        "Logos, colours, fonts and corner radius of the hosted storefront. Custom CSS is not offered (OADR-0012).",
    },
    locales: {
      title: "Locales",
      description:
        "The languages of the storefront's content (pages, e-mails). The storefront's interface is English in the MVP.",
    },
    currencies: {
      title: "Currencies",
      description:
        "The currencies travellers may choose; each must be an active currency with at most 2 decimals.",
    },
    markets: {
      title: "Markets",
      description: "Points of sale with their default currency and locale, both supported by the storefront.",
    },
    features: {
      title: "Features",
      description: "What the storefront offers; the plan can still switch a feature off.",
    },
    policies: {
      title: "Policies",
      description: "When tickets are issued, how cards are checked, and how long offers and checkouts last.",
    },
    airlineCard: {
      title: "Airline card",
      description:
        "Travellers pay with their card directly to the airline, which charges it when the tickets are issued (OADR-0004).",
    },
    legal: {
      title: "Legal",
      description: "The versions sign-up records, and the legal links of the footer and the sign-up form.",
    },
    support: {
      title: "Support",
      description: "The customer support contact shown to travellers; its e-mail is the Reply-To of e-mails.",
    },
    seo: { title: "SEO", description: "Defaults of the storefront's page titles and descriptions." },
    consent: { title: "Cookie consent", description: "The consent banner and its cookie categories." },
    operations: {
      title: "Operations",
      description: "Where staff alerts go, and the Amadeus queue every new order is placed on.",
    },
  } satisfies Record<SettingsSection, { readonly title: string; readonly description: string }>,
  // Brand
  brandName: "Brand name",
  brandNameHint: "Shown in the storefront and in e-mails.",
  legalName: "Legal name",
  legalNameHint: "The registered company name for footers and e-mails. Optional.",
  timeZone: "Time zone",
  timeZoneHint: "Support hours and the dates in e-mails use it.",
  // Locales and currencies
  defaultLocale: "Default locale",
  defaultLocaleHint: "Like en or fr-CA.",
  supportedLocales: "Supported locales",
  supportedLocalesHint: "Separated by commas, the default included; at most 20.",
  defaultCurrency: "Default currency",
  defaultCurrencyHint: "Like EUR.",
  supportedCurrencies: "Supported currencies",
  supportedCurrenciesHint: "Separated by commas, the default included; at most 20.",
  // Markets
  defaultMarket: "Default market",
  defaultMarketHint: "The country code of one of the markets below, or empty for none.",
  market: (index: number) => `Market ${index}`,
  marketCountry: "Country code",
  marketName: "Name",
  marketCurrency: "Currency",
  marketLocale: "Locale",
  addMarket: "Add a market",
  removeMarket: (index: number) => `Remove market ${index}`,
  noMarkets: "No market: the storefront uses its default currency and locale everywhere.",
  // Features
  features: {
    guestCheckout: ["Guest checkout", "Travellers may book without an account."],
    customerAccounts: ["Customer accounts", "Sign-up, sign-in and the account pages."],
    ancillaries: ["Extras", "Extra bags and other services are sold in checkout."],
    brandedFareUpsell: ["Branded fares", "The fare families are offered after an offer is chosen."],
    selfServiceCancellation: [
      "Self-service cancellation",
      "Travellers may cancel from their booking's page.",
    ],
  } satisfies Record<keyof StorefrontSettings["features"], readonly [string, string]>,
  // Policies
  ticketingPolicy: "Ticketing",
  paymentTiming:
    "Payment timing: the card is authorised before the booking is made, the only timing of the MVP.",
  require3ds: "Always ask for 3-D Secure on card payments",
  cardBrands: "Accepted card brands",
  cardBrandsHint: "For Stripe and airline-card payments; at least one.",
  requireEmailVerification: "Customers verify their e-mail address before booking with their account",
  offerTtl: "Offer lifetime (minutes)",
  offerTtlHint: "How long searched and priced offers stay valid; 5 to 240.",
  checkoutTtl: "Checkout lifetime (minutes)",
  checkoutTtlHint: "How long an open checkout stays valid; 5 to 1440.",
  // Airline card
  airlineCardNetPrice:
    "Airline-card bookings are sold at the airline's price: your markups and fees do not apply to them. Saving with active markup or fee rules gives a warning.",
  enabledTest: "Offer the airline card in the test environment",
  enabledLive: "Offer the airline card in the live environment",
  liveOff:
    "Live stays off until the platform turns the airline card on after its security review; the API refuses it until then.",
  liveOn: "On in live: untick to stop offering it.",
  // Legal
  termsVersion: "Terms version",
  privacyVersion: "Privacy policy version",
  versionHint: "Recorded with each sign-up. Optional; at most 40 characters.",
  link: (index: number) => `Link ${index}`,
  linkKind: "What it is for",
  linkLabel: "Link text",
  linkTarget: "Goes to",
  linkUrl: "Address (https)",
  linkSlug: "Page slug",
  linkSlugHint: "A content page of the storefront (Settings → Pages); it cannot be deleted while linked.",
  addLink: "Add a link",
  removeLink: (index: number) => `Remove link ${index}`,
  noLinks: "No legal link.",
  // Support
  supportEmail: "Support e-mail",
  supportPhone: "Support phone",
  phoneHint: "International format, like +4722334455. Optional.",
  supportHours: "Opening hours",
  helpCenterUrl: "Help centre (https)",
  emergencyPhone: "24/7 phone for travellers on the road",
  // SEO
  titleTemplate: "Title template",
  titleTemplateHint: "One %s where the page title goes, like %s | Acme Travel.",
  defaultTitle: "Default title",
  defaultDescription: "Default description",
  ogImage: "Social sharing image",
  ogImageHint: "Shown when a page is shared.",
  robotsIndex: "Search engines may index the live storefront",
  robotsFollow: "Search engines may follow its links",
  robotsHint: "The test storefront is never indexed.",
  // Consent
  regime: "Privacy regime",
  bannerRequired: "Show the consent banner before setting cookies that are not necessary",
  policyVersion: "Cookie policy version",
  policyVersionHint: "Travellers are asked again when it changes. Optional.",
  categoriesTitle: "Cookie categories",
  categoryIncluded: "Show this category",
  categoryRequired: "Required (cannot be switched off)",
  categoryDefault: "On by default",
  categoryTitle: "Title",
  categoryDescription: "Explanation",
  // Operations
  opsAlertEmail: "Staff alert e-mail",
  opsAlertEmailHint:
    "Ticketing failures, manual reviews and airline-card bookings are reported here; empty: the OTA's owners.",
  queueNumber: "Booking queue number",
  queueNumberHint:
    "The Amadeus queue of the queuing office where every new order is placed, so an order made during a timeout can be found (0 to 99; empty: none).",
  queueCategory: "Booking queue category",
  queueCategoryHint: "0 to 255.",
});

const MUTED = "text-xs text-muted-foreground";

// ---- Shared pieces ----------------------------------------------------------------------------------------------

/** `aria-describedby` and `aria-invalid` of a control with an optional hint and an optional error. */
function describedBy(hintId: string | undefined, errorId: string, error: string | undefined) {
  const ids = [hintId, error === undefined ? undefined : errorId].filter(
    (id): id is string => id !== undefined,
  );
  return {
    ...(ids.length === 0 ? {} : { "aria-describedby": ids.join(" ") }),
    ...(error === undefined ? {} : { "aria-invalid": true as const }),
  };
}

/** A field's error, linked to its control. */
function FieldMessage({ id, message }: { readonly id: string; readonly message: string | undefined }) {
  return message === undefined ? null : (
    <p id={id} className="text-sm font-medium text-destructive">
      {message}
    </p>
  );
}

/** A text area with its label, hint and error. */
function TextAreaField({
  name,
  label,
  hint,
  state,
  defaultValue,
  maxLength,
}: {
  readonly name: string;
  readonly label: string;
  readonly hint?: string;
  readonly state: ActionState;
  readonly defaultValue: string;
  readonly maxLength: number;
}) {
  const id = useId();
  const error = fieldError(state, name);
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {hint === undefined ? null : (
        <p id={hintId} className={MUTED}>
          {hint}
        </p>
      )}
      <Textarea
        id={id}
        name={name}
        rows={2}
        defaultValue={defaultValue}
        maxLength={maxLength}
        autoComplete="off"
        {...describedBy(hintId, `${id}-error`, error)}
      />
      <FieldMessage id={`${id}-error`} message={error} />
    </div>
  );
}

/** A list of checkboxes posting one field per ticked value (a `fieldset` with its legend). */
function CheckboxGroupField({
  name,
  label,
  hint,
  state,
  choices,
  defaultValues,
}: {
  readonly name: string;
  readonly label: string;
  readonly hint?: string;
  readonly state: ActionState;
  readonly choices: readonly { readonly value: string; readonly label: string }[];
  readonly defaultValues: readonly string[];
}) {
  const id = useId();
  const error = fieldError(state, name);
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <fieldset className="grid gap-2" {...describedBy(hintId, `${id}-error`, error)}>
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {hint === undefined ? null : (
        <p id={hintId} className={MUTED}>
          {hint}
        </p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {choices.map((choice) => (
          <label key={choice.value} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name={name}
              value={choice.value}
              defaultChecked={defaultValues.includes(choice.value)}
              className="size-4 accent-primary"
            />
            {choice.label}
          </label>
        ))}
      </div>
      <FieldMessage id={`${id}-error`} message={error} />
    </fieldset>
  );
}

/** The error of a whole list (`markets.list`), shown above its rows. */
function ListMessage({ state, name }: { readonly state: ActionState; readonly name: string }) {
  const message = fieldError(state, name);
  return message === undefined ? null : (
    <p role="alert" className="text-sm font-medium text-destructive">
      {message}
    </p>
  );
}

/** Rows of a list editor: each with a key that never changes (its fields' names) and its first values. */
function useRows<T>(initial: readonly T[]) {
  const [rows, setRows] = useState(() => initial.map((value, key) => ({ key, value })));
  const [nextKey, setNextKey] = useState(initial.length);
  return {
    rows,
    add(value: T) {
      setRows((previous) => [...previous, { key: nextKey, value }]);
      setNextKey((key) => key + 1);
    },
    remove(key: number) {
      setRows((previous) => previous.filter((row) => row.key !== key));
    },
  };
}

/**
 * One section's form: its heading, the hidden version (`ifMatch`), its fields (read only without `settings:write`),
 * the action's answer and "Save". The fields start again from the saved values when the section changed (`key`).
 */
function SectionForm({
  section,
  action,
  version,
  value,
  canWrite,
  children,
}: {
  readonly section: SettingsSection;
  readonly action: ConfirmAction;
  /** The settings' version the page displayed: the `If-Match` of the save. */
  readonly version: number;
  /** The section as the API answered it: a change of it starts the fields again. */
  readonly value: unknown;
  readonly canWrite: boolean;
  readonly children: (state: ActionState) => ReactNode;
}) {
  const headingId = useId();
  const [state, dispatch, pending] = useActionState(action, INITIAL_ACTION_STATE);
  const words = SECTION_STRINGS.sections[section];

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-labelledby={headingId}
      data-section={section}
      className="grid min-w-0 gap-4 rounded-md border p-4"
    >
      <div className="grid gap-1">
        <h2 id={headingId} className="text-base font-semibold">
          {words.title}
        </h2>
        <p className="text-sm text-muted-foreground">{words.description}</p>
      </div>
      <input type="hidden" name={VERSION_FIELD} value={String(version)} />
      <fieldset key={JSON.stringify(value)} disabled={!canWrite} className="grid min-w-0 gap-4">
        {children(state)}
      </fieldset>
      {state.message === undefined ? null : (
        <div
          role={state.ok === true ? "status" : "alert"}
          className={cn(
            "grid gap-1 rounded-md border px-3 py-2 text-sm",
            state.ok === true ? "text-foreground" : "border-destructive/40",
          )}
        >
          <p className={state.ok === true ? "" : "font-medium text-destructive"}>{state.message}</p>
          {state.requestId === undefined ? null : (
            <p className="text-muted-foreground">{SECTION_STRINGS.requestId(state.requestId)}</p>
          )}
        </div>
      )}
      {state.ok === true ? <RuleWarnings warnings={warningsOf(state)} /> : null}
      {canWrite ? (
        <div>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : null}
            {pending ? SECTION_STRINGS.saving : SECTION_STRINGS.save(words.title)}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

// ---- Sections ---------------------------------------------------------------------------------------------------

/** The markets: the default one and the rows of the list, each its own fieldset. */
function MarketsFields({
  markets,
  state,
}: {
  readonly markets: StorefrontSettings["markets"];
  readonly state: ActionState;
}) {
  const { rows, add, remove } = useRows<Market>(markets.list);
  return (
    <>
      <TextField
        name="markets.default"
        label={SECTION_STRINGS.defaultMarket}
        hint={SECTION_STRINGS.defaultMarketHint}
        state={state}
        defaultValue={markets.default ?? ""}
        maxLength={2}
      />
      <ListMessage state={state} name="markets.list" />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{SECTION_STRINGS.noMarkets}</p>
      ) : null}
      {rows.map((row, index) => (
        <fieldset key={row.key} className="grid gap-3 rounded-md border p-3" data-row={row.key}>
          <legend className="px-1 text-sm font-medium">{SECTION_STRINGS.market(index + 1)}</legend>
          <div className="grid gap-3 sm:grid-cols-4">
            <TextField
              name={`markets.list.${row.key}.countryCode`}
              label={SECTION_STRINGS.marketCountry}
              state={state}
              defaultValue={row.value.countryCode}
              maxLength={2}
            />
            <TextField
              name={`markets.list.${row.key}.name`}
              label={SECTION_STRINGS.marketName}
              state={state}
              defaultValue={row.value.name}
              maxLength={80}
            />
            <TextField
              name={`markets.list.${row.key}.currency`}
              label={SECTION_STRINGS.marketCurrency}
              state={state}
              defaultValue={row.value.currency}
              maxLength={3}
            />
            <TextField
              name={`markets.list.${row.key}.locale`}
              label={SECTION_STRINGS.marketLocale}
              state={state}
              defaultValue={row.value.locale}
              maxLength={6}
            />
          </div>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => remove(row.key)}>
              {SECTION_STRINGS.removeMarket(index + 1)}
            </Button>
          </div>
        </fieldset>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={rows.length >= MAX_LIST_LENGTH.markets}
          onClick={() => add({ countryCode: "", name: "", currency: "", locale: "" })}
        >
          <PlusIcon aria-hidden="true" />
          {SECTION_STRINGS.addMarket}
        </Button>
      </div>
    </>
  );
}

/** One legal link: what it is for, its text, and an external address or a content page. */
function LegalLinkRow({
  rowKey,
  index,
  link,
  state,
  onRemove,
}: {
  readonly rowKey: number;
  readonly index: number;
  readonly link: LegalLink | undefined;
  readonly state: ActionState;
  readonly onRemove: () => void;
}) {
  const [target, setTarget] = useState<"url" | "page">(
    link !== undefined && "pageSlug" in link ? "page" : "url",
  );
  const prefix = `legal.links.${rowKey}`;
  return (
    <fieldset className="grid gap-3 rounded-md border p-3" data-row={rowKey}>
      <legend className="px-1 text-sm font-medium">{SECTION_STRINGS.link(index)}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          name={`${prefix}.kind`}
          label={SECTION_STRINGS.linkKind}
          state={state}
          choices={LEGAL_LINK_KINDS}
          defaultValue={link?.kind ?? ""}
        />
        <TextField
          name={`${prefix}.label`}
          label={SECTION_STRINGS.linkLabel}
          state={state}
          defaultValue={link?.label ?? ""}
          maxLength={80}
        />
      </div>
      <RadioField
        name={`${prefix}.target`}
        label={SECTION_STRINGS.linkTarget}
        state={state}
        choices={LEGAL_LINK_TARGETS}
        value={target}
        onChange={(value) => setTarget(value === "page" ? "page" : "url")}
      />
      {/* The other target's field is kept, hidden (what was typed survives a change of mind); the form still posts it,
          and the action reads only the chosen target's field (settings-rules.ts `legalLinkSchema`). */}
      <div hidden={target !== "url"}>
        <TextField
          name={`${prefix}.url`}
          label={SECTION_STRINGS.linkUrl}
          state={state}
          defaultValue={link !== undefined && "url" in link ? link.url : ""}
        />
      </div>
      <div hidden={target !== "page"}>
        <TextField
          name={`${prefix}.pageSlug`}
          label={SECTION_STRINGS.linkSlug}
          hint={SECTION_STRINGS.linkSlugHint}
          state={state}
          defaultValue={link !== undefined && "pageSlug" in link ? link.pageSlug : ""}
        />
      </div>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={onRemove}>
          {SECTION_STRINGS.removeLink(index)}
        </Button>
      </div>
    </fieldset>
  );
}

/** The legal versions and links. */
function LegalFields({
  legal,
  state,
}: {
  readonly legal: StorefrontSettings["legal"];
  readonly state: ActionState;
}) {
  const { rows, add, remove } = useRows<LegalLink | undefined>(legal.links);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="legal.termsVersion"
          label={SECTION_STRINGS.termsVersion}
          hint={SECTION_STRINGS.versionHint}
          state={state}
          defaultValue={legal.termsVersion ?? ""}
          maxLength={40}
        />
        <TextField
          name="legal.privacyVersion"
          label={SECTION_STRINGS.privacyVersion}
          hint={SECTION_STRINGS.versionHint}
          state={state}
          defaultValue={legal.privacyVersion ?? ""}
          maxLength={40}
        />
      </div>
      <ListMessage state={state} name="legal.links" />
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{SECTION_STRINGS.noLinks}</p> : null}
      {rows.map((row, index) => (
        <LegalLinkRow
          key={row.key}
          rowKey={row.key}
          index={index + 1}
          link={row.value}
          state={state}
          onRemove={() => remove(row.key)}
        />
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={rows.length >= MAX_LIST_LENGTH.legalLinks}
          onClick={() => add(undefined)}
        >
          <PlusIcon aria-hidden="true" />
          {SECTION_STRINGS.addLink}
        </Button>
      </div>
    </>
  );
}

/** The ticketing policy (a choice the radio buttons keep) and the other policies. */
function PoliciesFields({
  policies,
  state,
}: {
  readonly policies: StorefrontSettings["policies"];
  readonly state: ActionState;
}) {
  const [ticketing, setTicketing] = useState<string>(policies.ticketingPolicy);
  return (
    <>
      <RadioField
        name="policies.ticketingPolicy"
        label={SECTION_STRINGS.ticketingPolicy}
        state={state}
        choices={TICKETING_POLICIES}
        value={ticketing}
        onChange={setTicketing}
        details={Object.fromEntries(TICKETING_POLICIES.map((choice) => [choice.value, choice.detail]))}
      />
      <input type="hidden" name="policies.paymentTiming" value={PAYMENT_TIMING} />
      <p className="text-sm text-muted-foreground">{SECTION_STRINGS.paymentTiming}</p>
      <CheckboxField
        name="policies.require3ds"
        label={SECTION_STRINGS.require3ds}
        state={state}
        defaultChecked={policies.require3ds}
      />
      <CheckboxGroupField
        name="policies.acceptedCardBrands"
        label={SECTION_STRINGS.cardBrands}
        hint={SECTION_STRINGS.cardBrandsHint}
        state={state}
        choices={CARD_BRANDS}
        defaultValues={policies.acceptedCardBrands}
      />
      <CheckboxField
        name="policies.requireEmailVerification"
        label={SECTION_STRINGS.requireEmailVerification}
        state={state}
        defaultChecked={policies.requireEmailVerification}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="policies.offerTtlMinutes"
          label={SECTION_STRINGS.offerTtl}
          hint={SECTION_STRINGS.offerTtlHint}
          state={state}
          defaultValue={String(policies.offerTtlMinutes)}
          inputMode="numeric"
          maxLength={3}
        />
        <TextField
          name="policies.checkoutTtlMinutes"
          label={SECTION_STRINGS.checkoutTtl}
          hint={SECTION_STRINGS.checkoutTtlHint}
          state={state}
          defaultValue={String(policies.checkoutTtlMinutes)}
          inputMode="numeric"
          maxLength={4}
        />
      </div>
    </>
  );
}

/** The airline card per environment; live is offered only to turn it off (see the module comment). */
function AirlineCardFields({
  airlineCard,
  state,
}: {
  readonly airlineCard: StorefrontSettings["airlineCard"];
  readonly state: ActionState;
}) {
  const id = useId();
  const liveError = fieldError(state, "airlineCard.enabledLive");
  const liveOn = airlineCard.enabledLive;
  return (
    <>
      <p
        role="note"
        className="rounded-md border border-amber-500 bg-amber-100 px-3 py-2 text-sm text-amber-950"
      >
        {SECTION_STRINGS.airlineCardNetPrice}
      </p>
      <CheckboxField
        name="airlineCard.enabledTest"
        label={SECTION_STRINGS.enabledTest}
        state={state}
        defaultChecked={airlineCard.enabledTest}
      />
      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          <input
            id={id}
            type="checkbox"
            name="airlineCard.enabledLive"
            value="true"
            defaultChecked={liveOn}
            disabled={!liveOn}
            className="size-4 accent-primary"
            {...describedBy(`${id}-hint`, `${id}-error`, liveError)}
          />
          <Label htmlFor={id}>{SECTION_STRINGS.enabledLive}</Label>
        </div>
        <p id={`${id}-hint`} className={MUTED}>
          {liveOn ? SECTION_STRINGS.liveOn : SECTION_STRINGS.liveOff}
        </p>
        <FieldMessage id={`${id}-error`} message={liveError} />
      </div>
    </>
  );
}

/** The cookie categories: each of the four shown or not, with its texts; only `necessary` may be required. */
function ConsentFields({
  consent,
  state,
}: {
  readonly consent: StorefrontSettings["consent"];
  readonly state: ActionState;
}) {
  return (
    <>
      <SelectField
        name="consent.regime"
        label={SECTION_STRINGS.regime}
        state={state}
        choices={CONSENT_REGIMES}
        defaultValue={consent.regime}
      />
      <CheckboxField
        name="consent.bannerRequired"
        label={SECTION_STRINGS.bannerRequired}
        state={state}
        defaultChecked={consent.bannerRequired}
      />
      <TextField
        name="consent.policyVersion"
        label={SECTION_STRINGS.policyVersion}
        hint={SECTION_STRINGS.policyVersionHint}
        state={state}
        defaultValue={consent.policyVersion ?? ""}
        maxLength={40}
      />
      <div className="grid gap-3">
        <p className="text-sm font-semibold">{SECTION_STRINGS.categoriesTitle}</p>
        {CONSENT_CATEGORIES.map((category) => {
          const saved = consent.categories.find((entry) => entry.id === category.value);
          const prefix = `consent.categories.${category.value}`;
          return (
            <fieldset key={category.value} className="grid gap-3 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{category.label}</legend>
              <CheckboxField
                name={`${prefix}.included`}
                label={SECTION_STRINGS.categoryIncluded}
                state={state}
                defaultChecked={saved !== undefined}
              />
              {category.value === "necessary" ? (
                <CheckboxField
                  name={`${prefix}.required`}
                  label={SECTION_STRINGS.categoryRequired}
                  state={state}
                  defaultChecked={saved?.required ?? true}
                />
              ) : null}
              <CheckboxField
                name={`${prefix}.defaultEnabled`}
                label={SECTION_STRINGS.categoryDefault}
                state={state}
                defaultChecked={saved?.defaultEnabled ?? category.value === "necessary"}
              />
              <TextField
                name={`${prefix}.title`}
                label={SECTION_STRINGS.categoryTitle}
                state={state}
                defaultValue={saved?.title ?? category.title}
                maxLength={80}
              />
              <TextAreaField
                name={`${prefix}.description`}
                label={SECTION_STRINGS.categoryDescription}
                state={state}
                defaultValue={saved?.description ?? category.description}
                maxLength={500}
              />
            </fieldset>
          );
        })}
      </div>
    </>
  );
}

// ---- The page's sections ----------------------------------------------------------------------------------------

export interface StorefrontSettingsSectionsProps {
  /** The settings as `console.settings.storefront.get` answered them. */
  readonly settings: StorefrontSettings;
  /** The uploaded images of the picker kinds (`console.settings.assets.list`). */
  readonly assets: AssetsByKind;
  /** The images could not be read: the pickers list the current choices only. */
  readonly assetsUnavailable: boolean;
  /** The IANA time zones to choose from (the server's list, with the saved one). */
  readonly timeZones: readonly string[];
  /** The staff member holds `settings:write`: the forms can be saved. */
  readonly canWrite: boolean;
  /** The tab shown first (`?tab=`). */
  readonly initialTab: StorefrontTab;
}

/** Every section of the storefront settings, in the page's tabs. */
export function StorefrontSettingsSections({
  settings,
  assets,
  assetsUnavailable,
  timeZones,
  canWrite,
  initialTab,
}: StorefrontSettingsSectionsProps) {
  const version = settings.version;
  const form = (
    section: SettingsSection,
    action: ConfirmAction,
    children: (state: ActionState) => ReactNode,
  ) => (
    <SectionForm
      key={section}
      section={section}
      action={action}
      version={version}
      value={settings[section]}
      canWrite={canWrite}
    >
      {children}
    </SectionForm>
  );

  const sections: Record<SettingsSection, ReactNode> = {
    brand: form("brand", saveBrand, (state) => (
      <>
        <TextField
          name="brand.name"
          label={SECTION_STRINGS.brandName}
          hint={SECTION_STRINGS.brandNameHint}
          state={state}
          defaultValue={settings.brand.name}
          maxLength={120}
        />
        <TextField
          name="brand.legalName"
          label={SECTION_STRINGS.legalName}
          hint={SECTION_STRINGS.legalNameHint}
          state={state}
          defaultValue={settings.brand.legalName ?? ""}
          maxLength={200}
        />
        <SelectField
          name="brand.timeZone"
          label={SECTION_STRINGS.timeZone}
          hint={SECTION_STRINGS.timeZoneHint}
          state={state}
          choices={timeZones.map((zone) => ({ value: zone, label: zone }))}
          defaultValue={settings.brand.timeZone}
        />
      </>
    )),
    branding: form("branding", saveBranding, (state) => (
      <ThemeEditor
        branding={settings.branding}
        assets={assets}
        assetsUnavailable={assetsUnavailable}
        state={state}
      />
    )),
    locales: form("locales", saveLocales, (state) => (
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="locales.default"
          label={SECTION_STRINGS.defaultLocale}
          hint={SECTION_STRINGS.defaultLocaleHint}
          state={state}
          defaultValue={settings.locales.default}
          maxLength={6}
        />
        <TextField
          name="locales.supported"
          label={SECTION_STRINGS.supportedLocales}
          hint={SECTION_STRINGS.supportedLocalesHint}
          state={state}
          defaultValue={settings.locales.supported.join(", ")}
        />
      </div>
    )),
    currencies: form("currencies", saveCurrencies, (state) => (
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="currencies.default"
          label={SECTION_STRINGS.defaultCurrency}
          hint={SECTION_STRINGS.defaultCurrencyHint}
          state={state}
          defaultValue={settings.currencies.default}
          maxLength={3}
        />
        <TextField
          name="currencies.supported"
          label={SECTION_STRINGS.supportedCurrencies}
          hint={SECTION_STRINGS.supportedCurrenciesHint}
          state={state}
          defaultValue={settings.currencies.supported.join(", ")}
        />
      </div>
    )),
    markets: form("markets", saveMarkets, (state) => (
      <MarketsFields markets={settings.markets} state={state} />
    )),
    features: form("features", saveFeatures, (state) => (
      <>
        {(
          Object.entries(SECTION_STRINGS.features) as [
            keyof StorefrontSettings["features"],
            readonly [string, string],
          ][]
        ).map(([name, [label, hint]]) => (
          <CheckboxField
            key={name}
            name={`features.${name}`}
            label={label}
            hint={hint}
            state={state}
            defaultChecked={settings.features[name]}
          />
        ))}
      </>
    )),
    policies: form("policies", savePolicies, (state) => (
      <PoliciesFields policies={settings.policies} state={state} />
    )),
    airlineCard: form("airlineCard", saveAirlineCard, (state) => (
      <AirlineCardFields airlineCard={settings.airlineCard} state={state} />
    )),
    legal: form("legal", saveLegal, (state) => <LegalFields legal={settings.legal} state={state} />),
    support: form("support", saveSupport, (state) => (
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="support.email"
          label={SECTION_STRINGS.supportEmail}
          type="email"
          state={state}
          defaultValue={settings.support.email ?? ""}
        />
        <TextField
          name="support.phone"
          label={SECTION_STRINGS.supportPhone}
          hint={SECTION_STRINGS.phoneHint}
          type="tel"
          state={state}
          defaultValue={settings.support.phone ?? ""}
          maxLength={16}
        />
        <TextField
          name="support.hours"
          label={SECTION_STRINGS.supportHours}
          state={state}
          defaultValue={settings.support.hours ?? ""}
          maxLength={200}
        />
        <TextField
          name="support.helpCenterUrl"
          label={SECTION_STRINGS.helpCenterUrl}
          state={state}
          defaultValue={settings.support.helpCenterUrl ?? ""}
        />
        <TextField
          name="support.emergencyPhone"
          label={SECTION_STRINGS.emergencyPhone}
          hint={SECTION_STRINGS.phoneHint}
          type="tel"
          state={state}
          defaultValue={settings.support.emergencyPhone ?? ""}
          maxLength={16}
        />
      </div>
    )),
    seo: form("seo", saveSeo, (state) => (
      <>
        <TextField
          name="seo.titleTemplate"
          label={SECTION_STRINGS.titleTemplate}
          hint={SECTION_STRINGS.titleTemplateHint}
          state={state}
          defaultValue={settings.seo.titleTemplate ?? ""}
          maxLength={120}
        />
        <TextField
          name="seo.defaultTitle"
          label={SECTION_STRINGS.defaultTitle}
          state={state}
          defaultValue={settings.seo.defaultTitle ?? ""}
          maxLength={120}
        />
        <TextAreaField
          name="seo.defaultDescription"
          label={SECTION_STRINGS.defaultDescription}
          state={state}
          defaultValue={settings.seo.defaultDescription ?? ""}
          maxLength={300}
        />
        <AssetPicker
          name="seo.ogImageAssetId"
          label={SECTION_STRINGS.ogImage}
          hint={SECTION_STRINGS.ogImageHint}
          kind="og_image"
          current={settings.seo.ogImageAssetId}
          assets={assets}
          unavailable={assetsUnavailable}
          state={state}
        />
        <CheckboxField
          name="seo.robots.index"
          label={SECTION_STRINGS.robotsIndex}
          hint={SECTION_STRINGS.robotsHint}
          state={state}
          defaultChecked={settings.seo.robots.index}
        />
        <CheckboxField
          name="seo.robots.follow"
          label={SECTION_STRINGS.robotsFollow}
          state={state}
          defaultChecked={settings.seo.robots.follow}
        />
      </>
    )),
    consent: form("consent", saveConsent, (state) => (
      <ConsentFields consent={settings.consent} state={state} />
    )),
    operations: form("operations", saveOperations, (state) => (
      <>
        <TextField
          name="operations.opsAlertEmail"
          label={SECTION_STRINGS.opsAlertEmail}
          hint={SECTION_STRINGS.opsAlertEmailHint}
          type="email"
          state={state}
          defaultValue={settings.operations.opsAlertEmail ?? ""}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="operations.bookingQueue.number"
            label={SECTION_STRINGS.queueNumber}
            hint={SECTION_STRINGS.queueNumberHint}
            state={state}
            defaultValue={
              settings.operations.bookingQueue.number === null
                ? ""
                : String(settings.operations.bookingQueue.number)
            }
            inputMode="numeric"
            maxLength={2}
          />
          <TextField
            name="operations.bookingQueue.category"
            label={SECTION_STRINGS.queueCategory}
            hint={SECTION_STRINGS.queueCategoryHint}
            state={state}
            defaultValue={String(settings.operations.bookingQueue.category)}
            inputMode="numeric"
            maxLength={3}
          />
        </div>
      </>
    )),
  };

  return (
    <Tabs defaultValue={initialTab} className="gap-4">
      <TabsList aria-label={SECTION_STRINGS.tabs} className="h-auto w-full flex-wrap justify-start sm:w-fit">
        {STOREFRONT_TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} className="flex-none">
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {STOREFRONT_TABS.map((tab) => (
        // Every tab stays mounted, so what was typed in one survives a visit to another.
        <TabsContent
          key={tab.value}
          value={tab.value}
          forceMount
          className="grid gap-6 data-[state=inactive]:hidden"
        >
          {tab.sections.map((section) => sections[section])}
        </TabsContent>
      ))}
    </Tabs>
  );
}
