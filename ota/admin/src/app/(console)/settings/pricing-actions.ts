// The server actions of the markup and fee rule settings (OAD-013; routes.md §9, api-changes part 2 §2.1 and §2.2,
// README §7, OADR-0018 points 4 and 5, OADR-0005): creating, changing and deleting the OTA's pricing rules through the
// SDK's console namespace with the client `requireStaff` hands back (the staff token of the request, the service key,
// the environment of the switch, the end-user headers). Settings are shared by the test and live environments, so the
// environment changes nothing here.
//
//   createMarkupRule   console.settings.markupRules.create   settings:write   the form's idempotency key
//   updateMarkupRule   console.settings.markupRules.update   settings:write   `ifMatch` = the displayed version
//   deleteMarkupRule   console.settings.markupRules.delete   settings:write   `ifMatch` = the displayed version
//   createFeeRule      console.settings.feeRules.create      settings:write   the form's idempotency key
//   updateFeeRule      console.settings.feeRules.update      settings:write   `ifMatch` = the displayed version
//   deleteFeeRule      console.settings.feeRules.delete      settings:write   `ifMatch` = the displayed version
//
// Each starts with `requireStaff("settings:write")` (owners and admins; an agent's, a finance member's or a viewer's
// forged POST gets "You do not have permission to do this (settings:write)" before any call; the API decides and
// audits all the same), then validates the form with the Zod mirror of `MarkupRuleInput` / `FeeRuleInput`
// (pricing-rules.ts `ruleFormSchema`; a hidden field that does not parse: "This form is out of date"), then makes one
// SDK call.
//
// - **Create** sends the form's values with the documented defaults filled in by the form (no `null` field), under the
//   idempotency key the page rendered with the form: a double submit or a retry after a timeout replays the same
//   create instead of making a second rule. The key after a failure is the shared one of lib/action-state.ts
//   (`withNextActionKey`): a final `4xx` the API stored under the key brings a new one, everything else keeps it.
// - **Update** sends only the fields the form changed (pricing-rules.ts `updateBodyOf`, against the rule the page
//   rendered), with `ifMatch` = the version the page displayed; a form sent unchanged makes no call. The default rule's
//   form has no scope, priority, active or window inputs (they stay as seeded, OADR-0005 point 3 revised 2026-10-30,
//   FIX-W34-OTA): the action reads them from the rendered rule and never sends them, whatever a forged POST carries.
// - **Delete** sends `ifMatch` = the displayed version and, after a success, goes to the list. The default rule is
//   never offered for deletion; the API refuses it anyway (`409 CONFLICT`, `default_rule`).
//
// An update and a delete carry no idempotency key (the contract has none: `If-Match` makes a replay a `412`), so their
// answers bring no new one. A success answers the API's `warnings[]` as the API sent them (a fixed amount in another
// currency than the storefront's default, a markup that can sell below net), which the form shows, and revalidates the
// list and the rule's page, whose new render brings the new version and a new key. The API's codes become the form's
// state, never `error.tsx`: its field errors on the field that caused them (pricing-rules.ts `ruleFieldOf`), `409
// CONFLICT` `default_rule` and `412 PRECONDITION_FAILED` in this page's words; only redirects and bugs are thrown.
"use server";

import type { StaffPermission } from "@velexis/ota-sdk";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ZodError } from "zod";

import { fromZod, withNextActionKey, type ActionState } from "@/lib/action-state";
import { fromVelexisError, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { requireStaff, type StaffContext } from "@/lib/session";

import {
  HIDDEN_RULE_FIELDS,
  RULE_FIELDS,
  RULE_ID_PATTERN,
  RULE_MESSAGES,
  RULE_PATHS,
  feeInputOf,
  isDefaultRuleForm,
  markupInputOf,
  parseOriginal,
  ruleBodyOfForm,
  ruleFieldOf,
  ruleFormInput,
  ruleFormSchema,
  rulePath,
  updateBodyOf,
  withDefaultRuleValues,
  withoutDefaultRuleFields,
  type PricingRule,
  type RuleActionState,
  type RuleKind,
} from "./pricing-rules";

/** The permission of every write here (scope §1.3: owner and admin). */
const WRITE_PERMISSION: StaffPermission = "settings:write";

const STRINGS = Object.freeze({
  created: {
    markup: "Markup rule created. It applies to the next search; offers already shown keep their prices.",
    fee: "Fee rule created. It applies from the next pricing; offers already priced keep their fees.",
  } satisfies Record<RuleKind, string>,
  saved: {
    markup: "Saved. The change applies to the next search; offers already shown keep their prices.",
    fee: "Saved. The change applies from the next pricing; offers already priced keep their fees.",
  } satisfies Record<RuleKind, string>,
  unchanged: "Nothing to save: the rule is as shown.",
  gone: {
    markup: "This markup rule no longer exists. Go back to the list of markup rules.",
    fee: "This fee rule no longer exists. Go back to the list of fee rules.",
  } satisfies Record<RuleKind, string>,
  defaultRuleUpdate:
    "The default rule always matches every offer: its scope stays empty, it stays active with no validity window, and its priority stays 1000. Change its percentage instead.",
  defaultRuleDelete:
    "The default rule cannot be deleted: it is the catch-all that every offer matches. Change its percentage instead.",
  busy: "This rule is still being saved. Send the same form again in a moment.",
});

/** A rule's `version` as the page rendered it: a positive whole number. */
const VERSION = /^[1-9][0-9]{0,9}$/;
/** An idempotency key as the page renders it (`crypto.randomUUID()`). */
const ACTION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Form fields ------------------------------------------------------------------------------------------------

/** A text field of the form that matches `pattern`, or `undefined`. */
function hiddenOf(form: FormData, name: string, pattern: RegExp): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/** The state of a form whose hidden fields are not the page's. */
function staleForm(): ActionState {
  return { ok: false, code: "VALIDATION_FAILED", message: RULE_MESSAGES.staleForm };
}

/** The state of a form that failed its schema. */
function invalid(error: ZodError): ActionState {
  return fromZod(error);
}

/** The staff context of an action, or the state of its refusal (a missing permission, an ended or refused session). */
async function staffFor(
  permission: StaffPermission,
): Promise<{ readonly context: StaffContext } | { readonly state: ActionState }> {
  try {
    return { context: await requireStaff(permission) };
  } catch (error) {
    return { state: fromVelexisError(error) };
  }
}

// ---- Failures ---------------------------------------------------------------------------------------------------

type Operation = "create" | "update" | "delete";

/**
 * The state of a failed call: lib/errors.ts's message, request id and field errors, the field errors on the form's
 * fields (`ruleFieldOf`: a scope list's item on its list, a money object on its amount, a currency on the one
 * currency field), and this page's words for the codes it knows. A field error of a hidden field (`If-Match`, the
 * rule id) means the form is out of date. Redirects and bugs are thrown again (`fromVelexisError`).
 */
function failureOf(kind: RuleKind, operation: Operation, error: unknown): ActionState {
  const base = fromVelexisError(error);
  const apiError = error as VelexisErrorLike;
  const fieldErrors: Record<string, string> = {};
  for (const [name, message] of Object.entries(base.fieldErrors ?? {})) {
    const field = ruleFieldOf(name);
    if (!Object.hasOwn(fieldErrors, field)) {
      fieldErrors[field] = message;
    }
  }
  let state: ActionState = {
    ...base,
    ...(Object.keys(fieldErrors).length === 0 ? {} : { fieldErrors: Object.freeze(fieldErrors) }),
  };
  if (Object.keys(fieldErrors).some((name) => HIDDEN_RULE_FIELDS.has(name))) {
    state = { ...state, message: RULE_MESSAGES.staleForm };
  }
  const reason = apiError.details?.["reason"];
  if (apiError.code === "CONFLICT" && reason === "default_rule") {
    state = {
      ...state,
      message: operation === "delete" ? STRINGS.defaultRuleDelete : STRINGS.defaultRuleUpdate,
    };
  } else if (apiError.code === "CONFLICT" && reason === "idempotency_key_in_use") {
    state = { ...state, message: STRINGS.busy };
  } else if (apiError.code === "NOT_FOUND" && operation !== "create") {
    state = { ...state, message: STRINGS.gone[kind] };
  }
  return state;
}

/** The answer of a save: the message, the rule and the API's warnings as it sent them. */
function savedState(message: string, rule: PricingRule): RuleActionState {
  const warnings = rule.warnings ?? [];
  return {
    ok: true,
    message,
    rule: { id: rule.id, name: rule.name },
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

// ---- Create -----------------------------------------------------------------------------------------------------

async function createRule(kind: RuleKind, form: FormData): Promise<RuleActionState> {
  const staff = await staffFor(WRITE_PERMISSION);
  if ("state" in staff) {
    return staff.state;
  }
  const key = hiddenOf(form, RULE_FIELDS.actionKey, ACTION_KEY);
  if (key === undefined) {
    return staleForm();
  }
  const parsed = ruleFormSchema(kind).safeParse(ruleFormInput(kind, form));
  if (!parsed.success) {
    return invalid(parsed.error);
  }
  const { console: con, staff: profile } = staff.context;
  const body = ruleBodyOfForm(kind, parsed.data, profile.tenant.timeZone);

  let rule: PricingRule;
  try {
    rule =
      kind === "markup"
        ? await con.settings.markupRules.create(markupInputOf(body), { idempotencyKey: key })
        : await con.settings.feeRules.create(feeInputOf(body), { idempotencyKey: key });
  } catch (error) {
    const state = failureOf(kind, "create", error);
    // `failureOf` threw anything that is not an API error, so `error` has the API error's shape here.
    return isVelexisErrorLike(error) ? withNextActionKey(state, error) : state;
  }
  revalidatePath(RULE_PATHS[kind]);
  return savedState(STRINGS.created[kind], rule);
}

/**
 * "Create markup rule" (`console.settings.markupRules.create`, `settings:write`): the form's name, description,
 * scope, calculation, amounts, unit, caps, priority, stacking, active flag and window, under the form's idempotency
 * key. A success answers the new rule and the API's warnings; the form opens the rule, or stays to show them.
 */
export async function createMarkupRule(_state: ActionState, form: FormData): Promise<RuleActionState> {
  return createRule("markup", form);
}

/**
 * "Create fee rule" (`console.settings.feeRules.create`, `settings:write`): the form's name, label, fee type,
 * scope with card brands, calculation, amounts, unit, caps, refundable flag, priority, active flag and window, under
 * the form's idempotency key.
 */
export async function createFeeRule(_state: ActionState, form: FormData): Promise<RuleActionState> {
  return createRule("fee", form);
}

// ---- Update -----------------------------------------------------------------------------------------------------

async function updateRule(kind: RuleKind, form: FormData): Promise<RuleActionState> {
  const staff = await staffFor(WRITE_PERMISSION);
  if ("state" in staff) {
    return staff.state;
  }
  const ruleId = hiddenOf(form, RULE_FIELDS.ruleId, RULE_ID_PATTERN[kind]);
  const version = hiddenOf(form, RULE_FIELDS.version, VERSION);
  const original = parseOriginal(kind, form.get(RULE_FIELDS.original));
  if (ruleId === undefined || version === undefined || original === undefined) {
    return staleForm();
  }
  const { console: con, staff: profile } = staff.context;
  const timeZone = profile.tenant.timeZone;
  // The default rule's form has no inputs for what stays fixed: those values are the rendered rule's, never sent.
  const defaultRule = isDefaultRuleForm(kind, form);
  const input = ruleFormInput(kind, form);
  const parsed = ruleFormSchema(kind).safeParse(
    defaultRule ? withDefaultRuleValues(input, original, timeZone) : input,
  );
  if (!parsed.success) {
    return invalid(parsed.error);
  }
  const body = updateBodyOf(ruleBodyOfForm(kind, parsed.data, timeZone), original, timeZone);
  const changes = defaultRule ? withoutDefaultRuleFields(body) : body;
  if (Object.keys(changes).length === 0) {
    return { ok: true, message: STRINGS.unchanged };
  }

  let rule: PricingRule;
  try {
    rule =
      kind === "markup"
        ? await con.settings.markupRules.update({
            markupRuleId: ruleId,
            ifMatch: Number(version),
            ...changes,
          })
        : await con.settings.feeRules.update({ feeRuleId: ruleId, ifMatch: Number(version), ...changes });
  } catch (error) {
    return failureOf(kind, "update", error);
  }
  revalidatePath(rulePath(kind, ruleId));
  revalidatePath(RULE_PATHS[kind]);
  return savedState(STRINGS.saved[kind], rule);
}

/**
 * "Save" of a markup rule's page (`console.settings.markupRules.update`, `settings:write`): the fields the form
 * changed, `ifMatch` = the version the page displayed. A success answers the saved rule and the API's warnings.
 */
export async function updateMarkupRule(_state: ActionState, form: FormData): Promise<RuleActionState> {
  return updateRule("markup", form);
}

/** "Save" of a fee rule's page (`console.settings.feeRules.update`, `settings:write`), as `updateMarkupRule`. */
export async function updateFeeRule(_state: ActionState, form: FormData): Promise<RuleActionState> {
  return updateRule("fee", form);
}

// ---- Delete -----------------------------------------------------------------------------------------------------

async function deleteRule(kind: RuleKind, form: FormData): Promise<ActionState> {
  const staff = await staffFor(WRITE_PERMISSION);
  if ("state" in staff) {
    return staff.state;
  }
  const ruleId = hiddenOf(form, RULE_FIELDS.ruleId, RULE_ID_PATTERN[kind]);
  const version = hiddenOf(form, RULE_FIELDS.version, VERSION);
  if (ruleId === undefined || version === undefined) {
    return staleForm();
  }
  const { console: con } = staff.context;
  try {
    if (kind === "markup") {
      await con.settings.markupRules.delete({ markupRuleId: ruleId, ifMatch: Number(version) });
    } else {
      await con.settings.feeRules.delete({ feeRuleId: ruleId, ifMatch: Number(version) });
    }
  } catch (error) {
    return failureOf(kind, "delete", error);
  }
  revalidatePath(RULE_PATHS[kind]);
  revalidatePath(rulePath(kind, ruleId));
  redirect(RULE_PATHS[kind]);
}

/**
 * "Delete" of a markup rule's page (`console.settings.markupRules.delete`, `settings:write`): `ifMatch` = the
 * displayed version; then the list. Bookings and priced offers keep their amounts.
 */
export async function deleteMarkupRule(_state: ActionState, form: FormData): Promise<ActionState> {
  return deleteRule("markup", form);
}

/** "Delete" of a fee rule's page (`console.settings.feeRules.delete`, `settings:write`), as `deleteMarkupRule`. */
export async function deleteFeeRule(_state: ActionState, form: FormData): Promise<ActionState> {
  return deleteRule("fee", form);
}
