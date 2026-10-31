"use client";

// The markup and fee rule settings' client side (OAD-013; routes.md §9, OADR-0005 points 3–7): the one form both
// kinds of rules use to be created and changed, the delete dialog, and the pieces the six pages share (the lists' table,
// filter and paging, a rule's read-only view, the explanation of how rules apply). The pages are server components
// that read the API; this module never imports the SDK or the session code, and its components get plain values (a
// rule as the API answered it, the OTA's time zone and currency), never a token.
//
// - **The form** (`PricingRuleForm`): the rule's name and notes (a fee rule's label and type), the scope (origins,
//   destinations, countries, airlines, cabins, traveller types, trip types, sources, channels, the net range, a fee's
//   card brands), the calculation with its percentage and fixed amount, the one currency of the amounts, the unit, the
//   caps, the priority, stacking (a markup rule) or refundable (a fee rule), the active flag and the validity window in
//   the OTA's time zone. It posts to the server actions of pricing-actions.ts, which validate it with the Zod mirror of
//   pricing-rules.ts, and shows their field errors on the fields (`aria-describedby`) and the API's `warnings[]` after a
//   save (a fixed amount in another currency than the storefront's default, a markup that can sell below net). A create
//   carries the idempotency key the page rendered (`useActionKey`, lib/action-state.ts: a double submit creates one
//   rule) and opens the new rule, or stays to show its warnings; an edit carries the displayed version (`If-Match`)
//   and the rule as the page rendered it, so only what changed is sent. The default markup rule's scope, priority,
//   active flag and validity window are not editable: it always matches every offer (OADR-0005 point 3, revised
//   2026-10-30; FIX-W34-OTA). Its form shows them read-only with why, has no inputs for them and marks itself
//   (`defaultRule`), so the action never sends them.
// - **Delete** (`DeleteRuleDialog`) is `ConfirmDialog` without a reason (the contract's `DELETE` takes none,
//   `askReason={false}`), never offered for the default rule.
//
// Every input has `autoComplete="off"`; nothing here asks for a card.
import type { FeeRule, MarkupRule } from "@velexis/ota-sdk";
import { LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  startTransition,
  useActionState,
  useCallback,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  CheckboxField,
  RadioField,
  SelectField,
  TextField,
} from "@/app/(console)/bookings/[bookingId]/patch-form";
import { ConfirmDialog, useActionKey, type ConfirmAction } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { INITIAL_ACTION_STATE, fieldError, type ActionState } from "@/lib/action-state";
import type { StaffEnvironment } from "@/lib/permissions";
import { cn } from "@/lib/utils";

import {
  createFeeRule,
  createMarkupRule,
  deleteFeeRule,
  deleteMarkupRule,
  updateFeeRule,
  updateMarkupRule,
} from "./pricing-actions";
import {
  APPLIES_PER,
  CALCULATIONS,
  FEE_TYPES,
  RULE_FIELDS,
  RULE_PATHS,
  capsText,
  calculationText,
  currencyOfRule,
  labelOf,
  localOfInstant,
  newRulePath,
  rulePath,
  ruleBodyOfRule,
  ruleListHref,
  savedRuleOf,
  scopeFieldsOf,
  scopeLines,
  scopeText,
  usesFixed,
  usesPercentage,
  warningsOf,
  windowText,
  type Calculation,
  type FeeType,
  type PricingRule,
  type RuleKind,
  type ScopeChoiceField,
  type SettingsWarning,
} from "./pricing-rules";

// ---- Words ------------------------------------------------------------------------------------------------------

export const RULE_STRINGS = Object.freeze({
  kinds: {
    markup: {
      title: "Markup rules",
      one: "markup rule",
      newRule: "New markup rule",
      create: "Create markup rule",
      empty: "No markup rule matches this filter.",
    },
    fee: {
      title: "Fee rules",
      one: "fee rule",
      newRule: "New fee rule",
      create: "Create fee rule",
      empty: "No fee rule matches this filter.",
    },
  } satisfies Record<RuleKind, Record<string, string>>,
  filters: "Rule filter",
  filterAll: "All rules",
  filterActive: "Active",
  filterInactive: "Inactive",
  pages: "Pages",
  firstPage: "First page",
  nextPage: "Next page",
  columns: {
    priority: "Priority",
    rule: "Rule",
    scope: "Applies to",
    amount: "Amount",
    status: "Status",
  },
  defaultBadge: "Default",
  stackableBadge: "Stackable",
  refundableBadge: "Refundable",
  nonRefundableBadge: "Kept on cancellation",
  active: "Active",
  inactive: "Inactive",
  // The form
  sections: {
    rule: "Rule",
    scope: "Applies to",
    amount: "Amount",
    order: "Order and validity",
  },
  name: "Name",
  nameHint: "Shown in the OTA admin only.",
  description: "Notes for staff",
  label: "Label",
  labelHint: "Shown to travellers in the price breakdown.",
  feeType: "Fee type",
  scopeHint:
    "Leave a field empty to match every offer for it. A list matches when one of the offer's values is in it.",
  defaultScope: "The default rule matches every offer: its scope cannot be narrowed.",
  defaultFixed:
    "The default rule always matches, so every offer gets a base markup: it stays active, has no validity window and keeps priority 1000 (rules with a lower number are checked before it). Its name, notes, calculation, amounts, unit, caps and stacking can still change.",
  minNet: "Lowest net total",
  maxNet: "Highest net total",
  netHint: "Inclusive, in the offer's currency.",
  calculation: "Calculation",
  percentage: "Percentage",
  markupPercentageHint: "Of the net price; -100 to 999.9999, a negative one is a discount.",
  feePercentageHint: "Of the base amount; 0 to 100.",
  fixedAmount: "Fixed amount",
  markupAmountHint: "Per unit, at most two decimals; a negative one is a discount.",
  feeAmountHint: "Per unit, at most two decimals.",
  currency: "Currency of the amounts",
  currencyHint:
    "The fixed amount and the caps share it. They apply only to offers in this currency: there is no conversion.",
  appliesPer: "Computed",
  minAmount: "Lowest amount per unit",
  maxAmount: "Highest amount per unit",
  capHint: "Optional cap of the computed amount, per unit.",
  priority: "Priority",
  priorityHint: "0 to 100,000; lower numbers are checked first. The default rule has 1000.",
  stackable: "Stackable: adds to the base markup instead of competing with it",
  refundable: "Refundable: refunded when a booking is cancelled",
  isActive: "Active",
  activeFrom: (timeZone: string) => `Active from (${timeZone})`,
  activeUntil: (timeZone: string) => `Active until (${timeZone})`,
  windowHint: "Optional. The start is included, the end is not.",
  save: "Save changes",
  saving: "Saving…",
  creating: "Creating…",
  warningsTitle: "Saved with warnings:",
  requestId: (requestId: string) => `Request id ${requestId}`,
  openRule: (name: string) => `Open ${name}`,
  backToList: (title: string) => `All ${title.toLowerCase()}`,
  // The read-only view
  details: {
    scope: "Applies to",
    everyOffer: "Every offer",
    amount: "Amount",
    caps: "Caps",
    noCaps: "None",
    priority: "Priority",
    stacking: "Stacking",
    stackable: "Adds to the base markup",
    notStackable: "Competes for the base markup",
    refund: "On cancellation",
    refunded: "Refunded",
    kept: "Kept",
    feeType: "Fee type",
    label: "Label",
    description: "Notes",
    status: "Status",
    window: "Validity",
  },
  // Delete
  delete: "Delete rule",
  deleteTitle: (one: string, name: string) => `Delete the ${one} ${name}?`,
  deleteSummary: {
    markup:
      "The rule no longer applies from the next search. Bookings and priced offers keep their amounts. Rules are shared by the test and live environments.",
    fee: "The rule no longer applies from the next pricing. Priced offers, checkouts and bookings keep their fee lines. Rules are shared by the test and live environments.",
  } satisfies Record<RuleKind, string>,
  // How rules apply
  explainerTitle: "How rules apply",
  explainer: {
    markup: [
      "Rules are checked by priority, lowest number first, then by id. A rule matches an offer when it is active, inside its validity window, and every scope field you filled matches.",
      "The first matching rule that is not stackable is the base markup: the rules that are not stackable after it are not checked.",
      "Every matching stackable rule with a lower priority number than the base rule adds its markup to it (every matching stackable rule when no base rule matches).",
      "The default rule (priority 1000) matches every offer, so a search always has a base rule; it cannot be deleted.",
      "A percentage applies to the net price, or to each traveller's or segment's share of it; a fixed amount is multiplied by the number of units; the caps bound the amount per unit. Negative markups are discounts, but the selling price is never below zero.",
      "Changes apply to the next search; offers already shown keep their prices until they expire.",
    ],
    fee: [
      "Each fee is charged at the step of its type: service and ticketing fees when an offer is priced, card fees when the card brand is known, extras fees per extra, cancellation fees in the cancellation quote. Change fees are stored but not charged in the MVP.",
      "Fees do not stack: for each fee type, the first matching rule applies, by priority (lowest number first), then by id. A narrower rule with a lower number overrides a general one.",
      "A rule matches when it is active, inside its validity window, and every scope field you filled matches; card brands only match card fees.",
      "A cancellation keeps the fees that are not refundable.",
      "Changes apply from the next pricing; priced offers, checkouts and bookings keep their fee lines.",
    ],
  } satisfies Record<RuleKind, readonly string[]>,
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const PAGE_LINK_CLASS =
  "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";
const MUTED = "text-xs text-muted-foreground";

// ---- Shared pieces ----------------------------------------------------------------------------------------------

/** How rules of a kind combine (OADR-0005 points 3 and 7), collapsed under its heading. */
export function PricingExplainer({ kind }: { readonly kind: RuleKind }) {
  return (
    <details className="max-w-3xl rounded-md border px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">{RULE_STRINGS.explainerTitle}</summary>
      <ul className="mt-3 grid list-disc gap-2 pl-5 text-sm text-muted-foreground">
        {RULE_STRINGS.explainer[kind].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </details>
  );
}

/** The API's warnings of a saved rule, as it sent them. */
export function RuleWarnings({ warnings }: { readonly warnings: readonly SettingsWarning[] }) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <div
      role="note"
      className="grid gap-1 rounded-md border border-amber-500 bg-amber-100 px-3 py-2 text-sm text-amber-950"
    >
      <p className="font-medium">{RULE_STRINGS.warningsTitle}</p>
      <ul className="grid list-disc gap-1 pl-5">
        {warnings.map((warning) => (
          <li key={`${warning.code}-${warning.path ?? ""}`} data-warning={warning.code}>
            {warning.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The badges of a rule: default, active or inactive, stackable or refundable. */
export function RuleBadges({ kind, rule }: { readonly kind: RuleKind; readonly rule: PricingRule }) {
  const markup = kind === "markup" ? (rule as MarkupRule) : undefined;
  const fee = kind === "fee" ? (rule as FeeRule) : undefined;
  return (
    <span className="flex flex-wrap gap-1">
      {markup?.isDefault === true ? <Badge variant="secondary">{RULE_STRINGS.defaultBadge}</Badge> : null}
      <Badge
        variant="outline"
        data-active={rule.isActive}
        className={rule.isActive ? "border-transparent bg-emerald-100 text-emerald-900" : ""}
      >
        {rule.isActive ? RULE_STRINGS.active : RULE_STRINGS.inactive}
      </Badge>
      {markup?.stackable === true ? <Badge variant="outline">{RULE_STRINGS.stackableBadge}</Badge> : null}
      {fee === undefined ? null : (
        <Badge variant="outline">
          {fee.refundable ? RULE_STRINGS.refundableBadge : RULE_STRINGS.nonRefundableBadge}
        </Badge>
      )}
    </span>
  );
}

/** The list's filter: every rule, the active ones, the inactive ones (links: the URL is the state). */
export function RuleListFilter({
  kind,
  active,
}: {
  readonly kind: RuleKind;
  readonly active: boolean | undefined;
}) {
  const options: readonly { readonly value: boolean | undefined; readonly label: string }[] = [
    { value: undefined, label: RULE_STRINGS.filterAll },
    { value: true, label: RULE_STRINGS.filterActive },
    { value: false, label: RULE_STRINGS.filterInactive },
  ];
  return (
    <nav aria-label={RULE_STRINGS.filters} className="flex flex-wrap gap-2">
      {options.map((option) => (
        <Link
          key={option.label}
          href={ruleListHref(kind, option.value)}
          {...(option.value === active ? { "aria-current": "page" as const } : {})}
          className={cn(PAGE_LINK_CLASS, option.value === active && "border-primary bg-primary/10")}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}

/** "First page" on a later page, "Next page" while there is one. */
export function RuleListPaging({
  kind,
  active,
  onLaterPage,
  nextCursor,
}: {
  readonly kind: RuleKind;
  readonly active: boolean | undefined;
  readonly onLaterPage: boolean;
  readonly nextCursor: string | null;
}) {
  if (!onLaterPage && nextCursor === null) {
    return null;
  }
  return (
    <nav aria-label={RULE_STRINGS.pages} className="flex flex-wrap justify-end gap-2">
      {onLaterPage ? (
        <Link href={ruleListHref(kind, active)} className={PAGE_LINK_CLASS}>
          {RULE_STRINGS.firstPage}
        </Link>
      ) : null}
      {nextCursor === null ? null : (
        <Link href={ruleListHref(kind, active, nextCursor)} className={PAGE_LINK_CLASS}>
          {RULE_STRINGS.nextPage}
        </Link>
      )}
    </nav>
  );
}

/** The rules of one page, in the order the API evaluates them (priority, then id). */
export function RulesTable({
  kind,
  rules,
  timeZone,
}: {
  readonly kind: RuleKind;
  readonly rules: readonly PricingRule[];
  readonly timeZone: string;
}) {
  const columns = Object.values(RULE_STRINGS.columns);
  return (
    <Table>
      <TableCaption className="sr-only">{RULE_STRINGS.kinds[kind].title}</TableCaption>
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
        {rules.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="h-20 text-center text-muted-foreground">
              {RULE_STRINGS.kinds[kind].empty}
            </TableCell>
          </TableRow>
        ) : (
          rules.map((rule) => {
            const caps = capsText(rule);
            const fee = kind === "fee" ? (rule as FeeRule) : undefined;
            return (
              <TableRow key={rule.id} data-rule={rule.id}>
                <TableCell className="tabular-nums">{rule.priority}</TableCell>
                <TableCell>
                  <div className="grid gap-1">
                    <Link
                      href={rulePath(kind, rule.id)}
                      className="font-medium underline-offset-4 hover:underline focus-visible:underline"
                    >
                      {rule.name}
                    </Link>
                    {fee === undefined ? null : (
                      <span className={MUTED}>
                        {labelOf(FEE_TYPES, fee.feeType)} · “{fee.label}”
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="max-w-80 whitespace-normal">{scopeText(kind, rule.scope)}</TableCell>
                <TableCell className="whitespace-normal">
                  <div className="grid gap-0.5">
                    <span>{calculationText(kind, rule)}</span>
                    {caps === undefined ? null : <span className={MUTED}>{caps}</span>}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="grid gap-1">
                    <RuleBadges kind={kind} rule={rule} />
                    <span className={MUTED}>{windowText(rule, timeZone)}</span>
                  </div>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

/** A rule as staff without `settings:write` see it: every field, read only. */
export function RuleDetails({
  kind,
  rule,
  timeZone,
}: {
  readonly kind: RuleKind;
  readonly rule: PricingRule;
  readonly timeZone: string;
}) {
  const words = RULE_STRINGS.details;
  const lines = scopeLines(kind, rule.scope);
  const markup = kind === "markup" ? (rule as MarkupRule) : undefined;
  const fee = kind === "fee" ? (rule as FeeRule) : undefined;
  const rows: { readonly term: string; readonly value: ReactNode }[] = [
    ...(fee === undefined
      ? []
      : [
          { term: words.feeType, value: labelOf(FEE_TYPES, fee.feeType) },
          { term: words.label, value: fee.label },
        ]),
    ...(markup?.description === null || markup?.description === undefined
      ? []
      : [{ term: words.description, value: markup.description }]),
    {
      term: words.scope,
      value:
        lines.length === 0 ? (
          words.everyOffer
        ) : (
          <ul className="grid gap-0.5">
            {lines.map((line) => (
              <li key={line.label}>
                {line.label}: {line.value}
              </li>
            ))}
          </ul>
        ),
    },
    { term: words.amount, value: calculationText(kind, rule) },
    { term: words.caps, value: capsText(rule) ?? words.noCaps },
    { term: words.priority, value: rule.priority },
    ...(markup === undefined
      ? []
      : [{ term: words.stacking, value: markup.stackable ? words.stackable : words.notStackable }]),
    ...(fee === undefined
      ? []
      : [{ term: words.refund, value: fee.refundable ? words.refunded : words.kept }]),
    { term: words.status, value: rule.isActive ? RULE_STRINGS.active : RULE_STRINGS.inactive },
    { term: words.window, value: windowText(rule, timeZone) },
  ];
  return (
    <dl className="grid max-w-3xl gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]">
      {rows.map((row) => (
        <div key={row.term} className="contents">
          <dt className="text-sm font-medium text-muted-foreground">{row.term}</dt>
          <dd className="text-sm">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The default markup rule's priority, active flag and validity window, read-only with why (FIX-W34-OTA): the form
 * has no inputs for them, so they are never sent.
 */
function DefaultRuleFixed({ rule, timeZone }: { readonly rule: MarkupRule; readonly timeZone: string }) {
  const words = RULE_STRINGS.details;
  const rows = [
    { term: words.priority, value: String(rule.priority) },
    { term: words.status, value: rule.isActive ? RULE_STRINGS.active : RULE_STRINGS.inactive },
    { term: words.window, value: windowText(rule, timeZone) },
  ];
  return (
    <div className="grid gap-2">
      <p className="text-sm">{RULE_STRINGS.defaultFixed}</p>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[12rem_1fr]">
        {rows.map((row) => (
          <div key={row.term} className="contents">
            <dt className="text-sm font-medium text-muted-foreground">{row.term}</dt>
            <dd className="text-sm">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---- Form fields ------------------------------------------------------------------------------------------------

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

/** A `datetime-local` input in the OTA's time zone, with its label, hint and error. */
function DateTimeField({
  name,
  label,
  hint,
  state,
  defaultValue,
}: {
  readonly name: string;
  readonly label: string;
  readonly hint: string;
  readonly state: ActionState;
  readonly defaultValue: string;
}) {
  const id = useId();
  const error = fieldError(state, name);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <p id={`${id}-hint`} className={MUTED}>
        {hint}
      </p>
      <input
        id={id}
        name={name}
        type="datetime-local"
        defaultValue={defaultValue}
        autoComplete="off"
        step={defaultValue.length > 16 ? 1 : 60}
        className="flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
        {...describedBy(`${id}-hint`, `${id}-error`, error)}
      />
      <FieldMessage id={`${id}-error`} message={error} />
    </div>
  );
}

/** A text area with its label and error. */
function TextAreaField({
  name,
  label,
  state,
  defaultValue,
  maxLength,
}: {
  readonly name: string;
  readonly label: string;
  readonly state: ActionState;
  readonly defaultValue: string;
  readonly maxLength: number;
}) {
  const id = useId();
  const error = fieldError(state, name);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        name={name}
        rows={2}
        defaultValue={defaultValue}
        maxLength={maxLength}
        autoComplete="off"
        {...describedBy(undefined, `${id}-error`, error)}
      />
      <FieldMessage id={`${id}-error`} message={error} />
    </div>
  );
}

/** A scope list chosen with checkboxes (a `fieldset` with its legend), each posting its value. */
function CheckboxGroupField({
  field,
  state,
  defaultValues,
}: {
  readonly field: ScopeChoiceField;
  readonly state: ActionState;
  readonly defaultValues: readonly string[];
}) {
  const id = useId();
  const error = fieldError(state, field.name);
  const hintId = field.hint === undefined ? undefined : `${id}-hint`;
  return (
    <fieldset className="grid gap-2" {...describedBy(hintId, `${id}-error`, error)}>
      <legend className="mb-1 text-sm font-medium">{field.label}</legend>
      {field.hint === undefined ? null : (
        <p id={hintId} className={MUTED}>
          {field.hint}
        </p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {field.choices.map((choice) => (
          <label key={choice.value} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name={field.name}
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

/** A group of fields under a heading. */
function FormSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-4 rounded-md border p-4">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

// ---- The form ---------------------------------------------------------------------------------------------------

export interface PricingRuleFormProps {
  readonly kind: RuleKind;
  /** The OTA's time zone (`console.auth.me`): the validity window is typed in it. */
  readonly timeZone: string;
  /** The currency the amounts of a new rule are in at first: the OTA's default currency. */
  readonly defaultCurrency: string;
}

export type CreateRuleFormProps = PricingRuleFormProps & {
  readonly mode: "create";
  /** The idempotency key rendered with the page (`crypto.randomUUID()`, once per render). */
  readonly idempotencyKey: string;
};

export type EditRuleFormProps = PricingRuleFormProps & {
  readonly mode: "edit";
  /** The rule as the API answered it; its `version` is the `If-Match` of the save. */
  readonly rule: PricingRule;
};

/** The defaults the form starts with: a rule's values, or a new rule's documented defaults. */
interface FormDefaults {
  readonly name: string;
  readonly description: string;
  readonly label: string;
  readonly feeType: FeeType | undefined;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly calculation: Calculation;
  readonly percentage: string;
  readonly fixedAmount: string;
  readonly minAmount: string;
  readonly maxAmount: string;
  readonly currency: string;
  readonly appliesPer: string;
  readonly priority: string;
  readonly stackable: boolean;
  readonly refundable: boolean;
  readonly isActive: boolean;
  readonly activeFrom: string;
  readonly activeUntil: string;
}

function defaultsOf(props: CreateRuleFormProps | EditRuleFormProps): FormDefaults {
  if (props.mode === "create") {
    return {
      name: "",
      description: "",
      label: "",
      feeType: undefined,
      scope: {},
      calculation: "percentage",
      percentage: "",
      fixedAmount: "",
      minAmount: "",
      maxAmount: "",
      currency: props.defaultCurrency,
      // MarkupRuleInput's and FeeRuleInput's defaults.
      appliesPer: props.kind === "markup" ? "traveler" : "booking",
      priority: "100",
      stackable: false,
      refundable: false,
      isActive: true,
      activeFrom: "",
      activeUntil: "",
    };
  }
  const { rule, kind, timeZone } = props;
  const markup = kind === "markup" ? (rule as MarkupRule) : undefined;
  const fee = kind === "fee" ? (rule as FeeRule) : undefined;
  return {
    name: rule.name,
    description: markup?.description ?? "",
    label: fee?.label ?? "",
    feeType: fee?.feeType,
    scope: rule.scope as Readonly<Record<string, unknown>>,
    calculation: rule.calculation,
    percentage: rule.percentage ?? "",
    fixedAmount: rule.fixed?.amount ?? "",
    minAmount: rule.min?.amount ?? "",
    maxAmount: rule.max?.amount ?? "",
    currency: currencyOfRule(rule) ?? props.defaultCurrency,
    appliesPer: rule.appliesPer,
    priority: String(rule.priority),
    stackable: markup?.stackable ?? false,
    refundable: fee?.refundable ?? false,
    isActive: rule.isActive,
    activeFrom: localOfInstant(rule.activeFrom ?? "", timeZone),
    activeUntil: localOfInstant(rule.activeUntil ?? "", timeZone),
  };
}

/** The server action of a form. */
function actionOf(kind: RuleKind, mode: "create" | "edit"): ConfirmAction {
  if (mode === "create") {
    return kind === "markup" ? createMarkupRule : createFeeRule;
  }
  return kind === "markup" ? updateMarkupRule : updateFeeRule;
}

/** The form of a new rule or of a rule's page. */
export function PricingRuleForm(props: CreateRuleFormProps | EditRuleFormProps) {
  const { kind, mode, timeZone } = props;
  const router = useRouter();
  const saveAction = actionOf(kind, mode);
  // A new rule without warnings is opened at once; with warnings the form stays to show them.
  const action = useCallback<ConfirmAction>(
    async (previous, form) => {
      const next = await saveAction(previous, form);
      const saved = savedRuleOf(next);
      if (mode === "create" && next.ok === true && saved !== undefined && warningsOf(next).length === 0) {
        router.push(rulePath(kind, saved.id));
      }
      return next;
    },
    [saveAction, mode, kind, router],
  );
  const [state, dispatch, pending] = useActionState(action, INITIAL_ACTION_STATE);
  const actionKey = useActionKey(props.mode === "create" ? props.idempotencyKey : "", state);
  const defaults = defaultsOf(props);
  const [calculation, setCalculation] = useState<Calculation>(defaults.calculation);
  const [feeType, setFeeType] = useState<string>(defaults.feeType ?? "");
  const words = RULE_STRINGS.kinds[kind];
  const isDefaultRule = props.mode === "edit" && kind === "markup" && (props.rule as MarkupRule).isDefault;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }

  const saved = savedRuleOf(state);
  if (mode === "create" && state.ok === true && saved !== undefined) {
    // Created: the rule is opened (no warnings), or its warnings are shown with the way to it.
    return (
      <div role="status" className="grid max-w-3xl gap-3">
        <p>{state.message}</p>
        <RuleWarnings warnings={warningsOf(state)} />
        <div className="flex flex-wrap gap-4">
          <Link href={rulePath(kind, saved.id)} className={LINK_CLASS}>
            {RULE_STRINGS.openRule(saved.name)}
          </Link>
          <Link href={RULE_PATHS[kind]} className={LINK_CLASS}>
            {RULE_STRINGS.backToList(words.title)}
          </Link>
        </div>
      </div>
    );
  }

  const percentageHint =
    kind === "markup" ? RULE_STRINGS.markupPercentageHint : RULE_STRINGS.feePercentageHint;
  const amountHint = kind === "markup" ? RULE_STRINGS.markupAmountHint : RULE_STRINGS.feeAmountHint;
  const scopeDefaults = defaults.scope;
  const codesOf = (key: string): string => {
    const values = scopeDefaults[key];
    return Array.isArray(values) ? values.join(", ") : "";
  };
  const listOf = (key: string): readonly string[] => {
    const values = scopeDefaults[key];
    return Array.isArray(values) ? (values as string[]) : [];
  };
  const boundOf = (key: string): string => {
    const value = scopeDefaults[key];
    return typeof value === "string" ? value : "";
  };

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-label={mode === "create" ? words.create : `${RULE_STRINGS.save}: ${defaults.name}`}
      className="grid max-w-3xl gap-6"
    >
      {props.mode === "create" ? (
        <input type="hidden" name={RULE_FIELDS.actionKey} value={actionKey} />
      ) : (
        <>
          <input type="hidden" name={RULE_FIELDS.ruleId} value={props.rule.id} />
          <input type="hidden" name={RULE_FIELDS.version} value={String(props.rule.version)} />
          <input
            type="hidden"
            name={RULE_FIELDS.original}
            value={JSON.stringify(ruleBodyOfRule(kind, props.rule))}
          />
          {isDefaultRule ? <input type="hidden" name={RULE_FIELDS.defaultRule} value="true" /> : null}
        </>
      )}

      <FormSection title={RULE_STRINGS.sections.rule}>
        <TextField
          name={RULE_FIELDS.name}
          label={RULE_STRINGS.name}
          hint={RULE_STRINGS.nameHint}
          state={state}
          defaultValue={defaults.name}
          maxLength={120}
        />
        {kind === "markup" ? (
          <TextAreaField
            name={RULE_FIELDS.description}
            label={RULE_STRINGS.description}
            state={state}
            defaultValue={defaults.description}
            maxLength={1000}
          />
        ) : (
          <>
            <TextField
              name={RULE_FIELDS.label}
              label={RULE_STRINGS.label}
              hint={RULE_STRINGS.labelHint}
              state={state}
              defaultValue={defaults.label}
              maxLength={80}
            />
            <RadioField
              name={RULE_FIELDS.feeType}
              label={RULE_STRINGS.feeType}
              state={state}
              choices={FEE_TYPES}
              value={feeType}
              onChange={setFeeType}
              details={Object.fromEntries(FEE_TYPES.map((choice) => [choice.value, choice.detail]))}
            />
          </>
        )}
      </FormSection>

      <FormSection title={RULE_STRINGS.sections.scope}>
        {isDefaultRule ? (
          <p className="text-sm">{RULE_STRINGS.defaultScope}</p>
        ) : (
          <>
            <p className={MUTED}>{RULE_STRINGS.scopeHint}</p>
            {scopeFieldsOf(kind).map((field) =>
              field.type === "codes" ? (
                <TextField
                  key={field.name}
                  name={field.name}
                  label={field.label}
                  hint={`${field.hint} For example ${field.example}.`}
                  state={state}
                  defaultValue={codesOf(field.key)}
                />
              ) : (
                <CheckboxGroupField
                  key={field.name}
                  field={field}
                  state={state}
                  defaultValues={listOf(field.key)}
                />
              ),
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                name={RULE_FIELDS.minNet}
                label={RULE_STRINGS.minNet}
                hint={RULE_STRINGS.netHint}
                state={state}
                defaultValue={boundOf("minNet")}
                inputMode="decimal"
                maxLength={13}
              />
              <TextField
                name={RULE_FIELDS.maxNet}
                label={RULE_STRINGS.maxNet}
                hint={RULE_STRINGS.netHint}
                state={state}
                defaultValue={boundOf("maxNet")}
                inputMode="decimal"
                maxLength={13}
              />
            </div>
          </>
        )}
      </FormSection>

      <FormSection title={RULE_STRINGS.sections.amount}>
        <RadioField
          name={RULE_FIELDS.calculation}
          label={RULE_STRINGS.calculation}
          state={state}
          choices={CALCULATIONS[kind]}
          value={calculation}
          onChange={(value) => setCalculation(value as Calculation)}
        />
        {/* Kept in the form while hidden, so a calculation chosen again finds what was typed; the action sends only
            the values the calculation uses. */}
        <div hidden={!usesPercentage(calculation)}>
          <TextField
            name={RULE_FIELDS.percentage}
            label={RULE_STRINGS.percentage}
            hint={percentageHint}
            state={state}
            defaultValue={defaults.percentage}
            inputMode="decimal"
            maxLength={9}
          />
        </div>
        <div hidden={!usesFixed(calculation)}>
          <TextField
            name={RULE_FIELDS.fixedAmount}
            label={RULE_STRINGS.fixedAmount}
            hint={amountHint}
            state={state}
            defaultValue={defaults.fixedAmount}
            inputMode="decimal"
            maxLength={14}
          />
        </div>
        <TextField
          name={RULE_FIELDS.currency}
          label={RULE_STRINGS.currency}
          hint={RULE_STRINGS.currencyHint}
          state={state}
          defaultValue={defaults.currency}
          maxLength={3}
        />
        <SelectField
          name={RULE_FIELDS.appliesPer}
          label={RULE_STRINGS.appliesPer}
          state={state}
          choices={APPLIES_PER}
          defaultValue={defaults.appliesPer}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name={RULE_FIELDS.minAmount}
            label={RULE_STRINGS.minAmount}
            hint={RULE_STRINGS.capHint}
            state={state}
            defaultValue={defaults.minAmount}
            inputMode="decimal"
            maxLength={14}
          />
          <TextField
            name={RULE_FIELDS.maxAmount}
            label={RULE_STRINGS.maxAmount}
            hint={RULE_STRINGS.capHint}
            state={state}
            defaultValue={defaults.maxAmount}
            inputMode="decimal"
            maxLength={14}
          />
        </div>
      </FormSection>

      <FormSection title={RULE_STRINGS.sections.order}>
        {isDefaultRule ? (
          <DefaultRuleFixed rule={props.rule as MarkupRule} timeZone={timeZone} />
        ) : (
          <TextField
            name={RULE_FIELDS.priority}
            label={RULE_STRINGS.priority}
            hint={RULE_STRINGS.priorityHint}
            state={state}
            defaultValue={defaults.priority}
            inputMode="numeric"
            maxLength={6}
          />
        )}
        {kind === "markup" ? (
          <CheckboxField
            name={RULE_FIELDS.stackable}
            label={RULE_STRINGS.stackable}
            state={state}
            defaultChecked={defaults.stackable}
          />
        ) : (
          <CheckboxField
            name={RULE_FIELDS.refundable}
            label={RULE_STRINGS.refundable}
            state={state}
            defaultChecked={defaults.refundable}
          />
        )}
        {isDefaultRule ? null : (
          <>
            <CheckboxField
              name={RULE_FIELDS.isActive}
              label={RULE_STRINGS.isActive}
              state={state}
              defaultChecked={defaults.isActive}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <DateTimeField
                name={RULE_FIELDS.activeFrom}
                label={RULE_STRINGS.activeFrom(timeZone)}
                hint={RULE_STRINGS.windowHint}
                state={state}
                defaultValue={defaults.activeFrom}
              />
              <DateTimeField
                name={RULE_FIELDS.activeUntil}
                label={RULE_STRINGS.activeUntil(timeZone)}
                hint={RULE_STRINGS.windowHint}
                state={state}
                defaultValue={defaults.activeUntil}
              />
            </div>
          </>
        )}
      </FormSection>

      <div className="grid gap-3">
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
              <p className="text-muted-foreground">{RULE_STRINGS.requestId(state.requestId)}</p>
            )}
          </div>
        )}
        {state.ok === true ? <RuleWarnings warnings={warningsOf(state)} /> : null}
        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : null}
            {pending
              ? mode === "create"
                ? RULE_STRINGS.creating
                : RULE_STRINGS.saving
              : mode === "create"
                ? words.create
                : RULE_STRINGS.save}
          </Button>
          <Link href={RULE_PATHS[kind]} className={LINK_CLASS}>
            {RULE_STRINGS.backToList(words.title)}
          </Link>
        </div>
      </div>
    </form>
  );
}

// ---- Delete -----------------------------------------------------------------------------------------------------

export interface DeleteRuleDialogProps {
  readonly kind: RuleKind;
  readonly ruleId: string;
  readonly ruleName: string;
  /** The rule's `version`, the `If-Match` of the delete. */
  readonly version: number;
  /** The environment of the request (rules are shared by both; the dialog shows it as every dialog does). */
  readonly environment: StaffEnvironment;
  /** The key `ConfirmDialog` renders with its form; the delete itself takes none. */
  readonly idempotencyKey: string;
}

/** "Delete rule" and its confirmation (no reason: the contract's `DELETE` takes none). */
export function DeleteRuleDialog({
  kind,
  ruleId,
  ruleName,
  version,
  environment,
  idempotencyKey,
}: DeleteRuleDialogProps) {
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline">
          {RULE_STRINGS.delete}
        </Button>
      }
      title={RULE_STRINGS.deleteTitle(RULE_STRINGS.kinds[kind].one, ruleName)}
      summary={<p>{RULE_STRINGS.deleteSummary[kind]}</p>}
      confirmLabel={RULE_STRINGS.delete}
      environment={environment}
      action={kind === "markup" ? deleteMarkupRule : deleteFeeRule}
      idempotencyKey={idempotencyKey}
      askReason={false}
      fields={{ [RULE_FIELDS.ruleId]: ruleId, [RULE_FIELDS.version]: String(version) }}
    />
  );
}

/** A link styled as the lists' "New … rule" button. */
export function NewRuleLink({ kind }: { readonly kind: RuleKind }) {
  return (
    <Button asChild>
      <Link href={newRulePath(kind)}>{RULE_STRINGS.kinds[kind].newRule}</Link>
    </Button>
  );
}
