"use client";

import { useEffect } from "react";

import { checkKeyAvailability, type KeyCheckStatus } from "@/app/(app)/otas/new/actions";
import { FormField } from "@/components/form-field";
import { Input } from "@/components/ui/input";
import { WIZARD_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The key field of the create-OTA wizard (README §4 `KeyAvailabilityField`, PF-10 AC1). While the person types, it
 * shows the storefront address the key gets (`<key>.<STOREFRONT_BASE_DOMAIN>`) and, once typing pauses, whether the
 * key is free: the `checkKeyAvailability` server action calls `checkTenantKey`. A key that breaks the key rules is
 * reported at once, without a call. Nothing is submitted: `createTenant` checks the key again.
 */

/** How long typing must pause before the key is checked. */
export const KEY_CHECK_DELAY_MS = 400;

/** The `TenantKey` rule of the platform document (`createOta` checks it again on the server). */
export const TENANT_KEY_PATTERN = /^[a-z][a-z0-9]{2,29}$/;

/** The longest key: 30 characters. */
const KEY_MAX = 30;

/**
 * Where the check of the current key stands: nothing typed, broken rules, waiting, the answer, or `unavailable`: the
 * wizard's submit was refused with `TENANT_KEY_UNAVAILABLE` (taken since the check, or reserved; the API does not say
 * which).
 */
export type KeyFieldStatus = "empty" | "checking" | KeyCheckStatus | "unavailable";

/** The check of one key. */
export interface KeyFieldCheck {
  readonly key: string;
  readonly status: KeyFieldStatus;
  /** The storefront host from the API's answer. */
  readonly storefrontHost?: string | undefined;
}

/**
 * The key a name suggests: its letters and digits in lower case, accents dropped, starting with a letter, at most 30
 * characters ("Acme Travel" → "acmetravel"). It may still be too short; the field says so.
 */
export function keyFromName(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^[0-9]+/, "")
    .slice(0, KEY_MAX);
}

/** The text of each status; nothing while the field is empty. */
const STATUS_TEXT: Readonly<Record<KeyFieldStatus, string | undefined>> = {
  empty: undefined,
  checking: WIZARD_STRINGS.keyChecking,
  available: WIZARD_STRINGS.keyAvailable,
  invalid: WIZARD_STRINGS.keyInvalid,
  reserved: WIZARD_STRINGS.keyReserved,
  taken: WIZARD_STRINGS.keyTaken,
  unchecked: WIZARD_STRINGS.keyUnchecked,
  unavailable: WIZARD_STRINGS.keyUnavailable,
};

/** The text of `status` (what the field shows, and the wizard's message for a refused key). */
export function keyStatusText(status: KeyFieldStatus): string | undefined {
  return STATUS_TEXT[status];
}

/** What the key itself says, before the API is asked: nothing typed, broken rules, or worth a check. */
function localStatus(key: string): "empty" | "invalid" | "checking" {
  return key === "" ? "empty" : TENANT_KEY_PATTERN.test(key) ? "checking" : "invalid";
}

/** A status that makes the key unusable. */
export function isKeyRefused(status: KeyFieldStatus): boolean {
  return status === "invalid" || status === "reserved" || status === "taken" || status === "unavailable";
}

export interface KeyAvailabilityFieldProps {
  /** The key as typed. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** `STOREFRONT_BASE_DOMAIN`, for the address preview. */
  readonly baseDomain: string;
  /** The check of the current key (kept by the wizard, which needs it to go on). */
  readonly check: KeyFieldCheck;
  /** Receives every new state of the check; a stable function (a state setter). */
  readonly onCheck: (check: KeyFieldCheck) => void;
  /** The error of the field (a refused step or submission); it replaces the live status. */
  readonly error?: string | undefined;
}

/** The key with its address preview and its live availability (`name="key"`). */
export function KeyAvailabilityField({
  value,
  onChange,
  baseDomain,
  check,
  onCheck,
  error,
}: KeyAvailabilityFieldProps) {
  useEffect(() => {
    const local = localStatus(value);
    onCheck({ key: value, status: local });
    if (local !== "checking") {
      return undefined;
    }
    // Only the answer for the key still in the field counts: a newer key cancels the older check.
    let current = true;
    const timer = setTimeout(() => {
      checkKeyAvailability(value).then(
        (result) => {
          if (current) {
            onCheck({ key: value, status: result.status, storefrontHost: result.storefrontHost });
          }
        },
        () => {
          if (current) {
            onCheck({ key: value, status: "unchecked" });
          }
        },
      );
    }, KEY_CHECK_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [value, onCheck]);

  // Until the effect has reported on a new key, the status follows from the key itself.
  const status: KeyFieldStatus = check.key === value ? check.status : localStatus(value);
  const host =
    check.key === value && check.storefrontHost !== undefined
      ? check.storefrontHost
      : `${value === "" ? WIZARD_STRINGS.keyPlaceholder : value}.${baseDomain}`;
  const statusText = error === undefined ? STATUS_TEXT[status] : undefined;
  const addressId = "key-availability-address";
  const statusId = "key-availability-status";

  return (
    <div className="grid gap-2">
      <FormField
        label={WIZARD_STRINGS.keyLabel}
        name="key"
        description={WIZARD_STRINGS.keyHint}
        error={error}
      >
        {(control) => (
          <Input
            {...control}
            aria-describedby={[control["aria-describedby"], addressId, statusId]
              .filter((id) => id !== undefined)
              .join(" ")}
            value={value}
            onChange={(event) => onChange(event.target.value.toLowerCase())}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={KEY_MAX}
            placeholder={WIZARD_STRINGS.keyPlaceholder}
          />
        )}
      </FormField>
      <p id={addressId} className="text-sm text-muted-foreground">
        {WIZARD_STRINGS.keyAddress(host)}
      </p>
      <p
        id={statusId}
        role="status"
        data-status={status}
        className={cn(
          "min-h-5 text-sm",
          status === "available" ? "text-emerald-700" : undefined,
          isKeyRefused(status) ? "text-destructive" : undefined,
          status === "checking" || status === "unchecked" ? "text-muted-foreground" : undefined,
        )}
      >
        {statusText}
      </p>
    </div>
  );
}
