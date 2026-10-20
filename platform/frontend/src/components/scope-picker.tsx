import type { components as OtaComponents } from "@velexis/api-types";

import { API_KEY_SCOPE_STRINGS, API_KEYS_STRINGS, STAFF_PERMISSION_LABELS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The scopes of a secret API key (README §4; PADR-0005 item 6; flow api-keys.md step 2) and their rules, which
 * `api-keys/actions.ts` checks before it calls the API, as `api-key-rules.ts` of the platform API checks them again.
 * The values are the OTA contract's `ConsoleApiKeyScope` and `StaffPermission` (`@velexis/api-types`): an object with
 * one entry per value, checked with `satisfies Record<…, true>`, does not compile when the OTA document adds or
 * removes a value until the list follows. A key has one use:
 *
 * - `storefront` (the default): customer operations only; it excludes every other scope;
 * - `console`: console operations with a staff token;
 * - `console:automation` (implies `console`): console operations without a staff token, with exactly the
 *   `StaffPermission` values listed next to it, at least one. Permissions are allowed only with it.
 *
 * No directive: the server action uses the rules, and the create form (a client component) renders `ScopePicker`, a
 * controlled component without state of its own.
 */

/** `ConsoleApiKeyScope` of the OTA contract: `storefront`, `console`, `console:automation`. */
export type ConsoleApiKeyScope = OtaComponents["schemas"]["ConsoleApiKeyScope"];
/** `StaffPermission` of the OTA contract (`bookings:read`, …). */
export type StaffPermission = OtaComponents["schemas"]["StaffPermission"];

/** One entry per `ConsoleApiKeyScope` value, in the order of the OTA document. */
const CONSOLE_SCOPES = {
  storefront: true,
  console: true,
  "console:automation": true,
} as const satisfies Record<ConsoleApiKeyScope, true>;

/** One entry per `StaffPermission` value, in the order of the OTA document. */
const PERMISSIONS = {
  "bookings:read": true,
  "bookings:write": true,
  "bookings:issue": true,
  "bookings:cancel": true,
  "customers:read": true,
  "queues:read": true,
  "supplier_requests:read": true,
  "amadeus:read": true,
  "amadeus:write": true,
  "settings:read": true,
  "settings:write": true,
  "payments:read": true,
  "payments:capture": true,
  "payments:refund": true,
} as const satisfies Record<StaffPermission, true>;

/** The `ConsoleApiKeyScope` values, in the order of the OTA document. */
export const CONSOLE_API_KEY_SCOPES: readonly ConsoleApiKeyScope[] = Object.freeze(
  Object.keys(CONSOLE_SCOPES) as ConsoleApiKeyScope[],
);

/** The `StaffPermission` values, in the order of the OTA document. */
export const STAFF_PERMISSIONS: readonly StaffPermission[] = Object.freeze(
  Object.keys(PERMISSIONS) as StaffPermission[],
);

/** The use a new secret key starts with (PADR-0005 item 6). */
export const DEFAULT_SCOPE: ConsoleApiKeyScope = "storefront";

/** `value` is a `ConsoleApiKeyScope` value. */
export function isConsoleScope(value: unknown): value is ConsoleApiKeyScope {
  return typeof value === "string" && Object.hasOwn(CONSOLE_SCOPES, value);
}

/** `value` is a `StaffPermission` value. */
export function isPermission(value: unknown): value is StaffPermission {
  return typeof value === "string" && Object.hasOwn(PERMISSIONS, value);
}

/** What the picker holds: the key's use and, for `console:automation`, its permissions. */
export interface ScopeSelection {
  readonly scope: ConsoleApiKeyScope;
  readonly permissions: readonly StaffPermission[];
}

/**
 * The `scopes` of `createApiKey` for a selection: the use alone, and for `console:automation` its permissions
 * after it (`["console:automation", "bookings:read"]`, the form of the OTA contract's example).
 */
export function scopesOf(selection: ScopeSelection): string[] {
  return [selection.scope, ...selection.permissions];
}

/** A broken scope rule; the message of each is in `scopeMessage`. */
export type ScopeProblem =
  | "scopeRequired"
  | "unknownScope"
  | "scopeCombination"
  | "permissionsWithoutAutomation"
  | "automationNeedsPermission";

/** The broken rule of a secret key's `scopes`, or `undefined` when they are valid (empty means the default). */
export function scopeProblem(scopes: readonly string[]): ScopeProblem | undefined {
  if (scopes.some((scope) => !isConsoleScope(scope) && !isPermission(scope))) {
    return "unknownScope";
  }
  const permissions = scopes.filter(isPermission);
  const uses = scopes.filter(isConsoleScope);
  const automation = uses.includes("console:automation");
  if (permissions.length > 0 && !automation) {
    return "permissionsWithoutAutomation";
  }
  if (uses.includes("storefront") && uses.length > 1) {
    return "scopeCombination";
  }
  if (automation && permissions.length === 0) {
    return "automationNeedsPermission";
  }
  return undefined;
}

/** The portal's message for a scope problem (also for the API's field error codes of `scopes`). */
export function scopeMessage(problem: string): string {
  switch (problem) {
    case "scopeRequired":
      return API_KEYS_STRINGS.scopeRequired;
    case "unknownScope":
      return API_KEYS_STRINGS.scopeUnknown;
    case "permissionsWithoutAutomation":
      return API_KEYS_STRINGS.permissionsWithoutAutomation;
    case "automationNeedsPermission":
      return API_KEYS_STRINGS.automationNeedsPermission;
    default:
      // `scopeCombination`, and the API's own codes (`notAllowed`, `uniqueItems`, `pattern`).
      return API_KEYS_STRINGS.scopeCombination;
  }
}

/** The id of the radio button of `scope` in the picker `idPrefix`; the first one is the target of the summary. */
export function scopeInputId(idPrefix: string, scope: ConsoleApiKeyScope): string {
  return `${idPrefix}-scope-${scope.replace(":", "-")}`;
}

export interface ScopePickerProps {
  /** Makes the ids of the picker unique on the page. */
  readonly idPrefix: string;
  readonly value: ScopeSelection;
  readonly onChange: (value: ScopeSelection) => void;
  /** The error of the field: the portal's check, or the API's field errors at `/scopes`. */
  readonly error?: string | undefined;
}

/**
 * The use of a secret key as radio buttons (`name="scope"`) and the permissions as checkboxes
 * (`name="permissions"`). The permissions can only be chosen for `console:automation`: for the other uses their
 * fieldset is disabled, so they are neither checked nor sent, and the action refuses a submission that sends them
 * all the same (PF-30 AC2). The picker keeps the chosen permissions while another use is selected, so choosing
 * Console automation again brings them back.
 */
export function ScopePicker({ idPrefix, value, onChange, error }: ScopePickerProps) {
  const hintId = `${idPrefix}-scopes-hint`;
  const errorId = error === undefined ? undefined : `${idPrefix}-scopes-error`;
  const describedBy = [hintId, errorId].filter((id) => id !== undefined).join(" ");
  const automation = value.scope === "console:automation";
  const permissionsHintId = `${idPrefix}-permissions-hint`;

  function togglePermission(permission: StaffPermission, checked: boolean): void {
    const permissions = checked
      ? STAFF_PERMISSIONS.filter((each) => each === permission || value.permissions.includes(each))
      : value.permissions.filter((each) => each !== permission);
    onChange({ scope: value.scope, permissions });
  }

  return (
    <fieldset
      className="grid gap-4"
      aria-describedby={describedBy}
      data-invalid={errorId === undefined ? undefined : true}
      data-field="scopes"
    >
      <legend className="mb-2 text-sm font-medium">{API_KEYS_STRINGS.scopesLegend}</legend>
      <p id={hintId} className="text-sm text-muted-foreground">
        {API_KEYS_STRINGS.scopesHint}
      </p>
      <div className="grid gap-3">
        {CONSOLE_API_KEY_SCOPES.map((scope) => {
          const id = scopeInputId(idPrefix, scope);
          const checked = value.scope === scope;
          const strings = API_KEY_SCOPE_STRINGS[scope];
          return (
            <div
              key={scope}
              className={cn(
                "flex items-start gap-3 rounded-xl border p-4",
                checked ? "border-primary ring-1 ring-primary" : undefined,
              )}
            >
              <input
                type="radio"
                id={id}
                name="scope"
                value={scope}
                checked={checked}
                onChange={() => onChange({ scope, permissions: value.permissions })}
                aria-describedby={`${id}-hint`}
                aria-invalid={errorId === undefined ? undefined : true}
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <div className="grid flex-1 gap-1">
                <label htmlFor={id} className="font-semibold">
                  {strings.label}
                </label>
                <span id={`${id}-hint`} className="text-sm text-muted-foreground">
                  {strings.hint}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <fieldset
        disabled={!automation}
        aria-describedby={permissionsHintId}
        className="grid gap-3 rounded-xl border p-4 disabled:opacity-60"
        data-field="permissions"
      >
        <legend className="px-1 text-sm font-medium">{API_KEYS_STRINGS.permissionsLegend}</legend>
        <p id={permissionsHintId} className="text-sm text-muted-foreground">
          {API_KEYS_STRINGS.permissionsHint}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {STAFF_PERMISSIONS.map((permission) => {
            const id = `${idPrefix}-permission-${permission.replace(":", "-")}`;
            return (
              <div key={permission} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  id={id}
                  name="permissions"
                  value={permission}
                  // Shown and sent only for Console automation; the choice is kept for when it comes back.
                  checked={automation && value.permissions.includes(permission)}
                  disabled={!automation}
                  onChange={(event) => togglePermission(permission, event.target.checked)}
                  className="mt-1 size-4 shrink-0 accent-primary"
                />
                <label htmlFor={id} className="grid text-sm">
                  <span>{STAFF_PERMISSION_LABELS[permission]}</span>
                  <code className="text-xs text-muted-foreground">{permission}</code>
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>
      {errorId === undefined ? null : (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
