"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  revokeKey,
  rollKey,
  updateKey,
  type ApiKey,
  type ExpireOldIn,
  type RevokeKeyState,
  type RolledKey,
  type RollKeyState,
  type UpdateKeyState,
} from "@/app/(app)/otas/[tenantId]/api-keys/actions";
import { RecommendedSetups } from "@/app/(app)/otas/[tenantId]/api-keys/create-key-form";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField } from "@/components/form-field";
import { OriginsField, originInputId } from "@/components/origins-field";
import { isConsoleScope, isPermission } from "@/components/scope-picker";
import { SecretRevealPanel } from "@/components/secret-reveal-panel";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  API_KEY_KIND_LABELS,
  API_KEY_SCOPE_STRINGS,
  API_KEYS_STRINGS,
  ROLL_EXPIRY_LABELS,
  STAFF_PERMISSION_LABELS,
} from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The key list of the API keys page (README §2 `/otas/[tenantId]/api-keys` and §4 `DataTable`; flow api-keys.md
 * steps 1 and 5–7; PF-30 AC4, AC5): one row per key of the tab's environment with its name, kind, prefix and
 * `…last4`, origins or scopes, creator, last use (up to 5 minutes stale), expiry and state, and per working key
 * "Edit" (name, and origins of a publishable key), "Roll" (with when the old key stops working; the new key shows
 * once above the list, with the old key's expiry) and "Revoke" (`ConfirmDialog`). The rows come from the page (a
 * server component), which computes each key's state once per request, so the server and the browser render the same.
 */

/** Whether a key works: `revoked` and `expired` keys no longer authenticate. */
export type KeyState = "active" | "expired" | "revoked";

/** One row: the key as `listApiKeys` answers it (never the key itself) and its state. */
export interface KeyRow {
  readonly apiKey: ApiKey;
  readonly state: KeyState;
}

/** The visible part of a key: `sk_test_Ab12Cd…Wx90`. */
function maskedOf(apiKey: Pick<ApiKey, "prefix" | "last4">): string {
  return API_KEYS_STRINGS.maskedKey(apiKey.prefix, apiKey.last4);
}

/** The words a screen reader reads after an action's name ("Roll" → "Roll Storefront (sk_test_…)"). */
function ActionTarget({ apiKey }: { readonly apiKey: ApiKey }) {
  return <span className="sr-only">{API_KEYS_STRINGS.actionTarget(apiKey.name, maskedOf(apiKey))}</span>;
}

const STATE_LABELS: Readonly<Record<KeyState, string>> = {
  active: API_KEYS_STRINGS.stateActive,
  expired: API_KEYS_STRINGS.stateExpired,
  revoked: API_KEYS_STRINGS.stateRevoked,
};

const STATE_CLASSES: Readonly<Record<KeyState, string>> = {
  active: "border-transparent bg-emerald-100 text-emerald-900",
  expired: "border-transparent bg-amber-100 text-amber-900",
  revoked: "border-transparent bg-secondary text-secondary-foreground",
};

/** What a key may do: the origins of a publishable key, or the use and permissions of a secret key. */
function KeyAccess({ apiKey }: { readonly apiKey: ApiKey }) {
  if (apiKey.kind === "publishable") {
    return apiKey.allowedOrigins.length === 0 ? (
      <span className="text-muted-foreground">{API_KEYS_STRINGS.noOrigins}</span>
    ) : (
      <ul className="grid gap-0.5" data-field="allowedOrigins">
        {apiKey.allowedOrigins.map((origin) => (
          <li key={origin} className="break-all">
            {origin}
          </li>
        ))}
      </ul>
    );
  }
  const uses = apiKey.scopes.filter(isConsoleScope);
  const permissions = apiKey.scopes.filter(isPermission);
  // A value the portal does not know yet (a newer OTA document) still shows, as it is.
  const unknown = apiKey.scopes.filter((scope) => !isConsoleScope(scope) && !isPermission(scope));
  return (
    <div className="grid gap-1" data-field="scopes">
      {uses.map((scope) => (
        <span key={scope} className="font-medium" data-scope={scope}>
          {API_KEY_SCOPE_STRINGS[scope].label}
        </span>
      ))}
      {permissions.length === 0 && unknown.length === 0 ? null : (
        <ul className="grid gap-0.5 text-muted-foreground">
          {permissions.map((permission) => (
            <li key={permission} title={STAFF_PERMISSION_LABELS[permission]}>
              <code className="text-xs">{permission}</code>
            </li>
          ))}
          {unknown.map((scope) => (
            <li key={scope}>
              <code className="text-xs">{scope}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Edit ----------------------------------------------------------------------------------------------------------

const UPDATE_IDLE: UpdateKeyState = { status: "idle", fieldErrors: {} };

/** The edit form inside the dialog: the name and, for a publishable key, its origins. */
function EditKeyForm({
  tenantId,
  apiKey,
  onSaved,
  onCancel,
}: {
  readonly tenantId: string;
  readonly apiKey: ApiKey;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}) {
  const idPrefix = `edit-${apiKey.id}`;
  const [state, dispatch, pending] = useActionState(updateKey, UPDATE_IDLE);
  const [name, setName] = useState(apiKey.name);
  const [origins, setOrigins] = useState<readonly string[]>(apiKey.allowedOrigins);
  const handled = useRef<UpdateKeyState>(UPDATE_IDLE);

  useEffect(() => {
    // Once per answer, even when the parent renders again with a new callback.
    if (handled.current === state) {
      return;
    }
    handled.current = state;
    if (state.status === "saved") {
      onSaved();
    }
  }, [state, onSaved]);

  const summary = useMemo<FormErrorItem[]>(() => {
    const items: FormErrorItem[] = [];
    if (state.fieldErrors.name !== undefined) {
      items.push({ message: state.fieldErrors.name, fieldId: `${idPrefix}-name` });
    }
    for (const [row, message] of Object.entries(state.fieldErrors.origins ?? {}).sort(
      ([left], [right]) => Number(left) - Number(right),
    )) {
      items.push({ message, fieldId: originInputId(idPrefix, Number(row)) });
    }
    if (state.fieldErrors.allowedOrigins !== undefined) {
      items.push({ message: state.fieldErrors.allowedOrigins, fieldId: originInputId(idPrefix, 0) });
    }
    if (state.message !== undefined) {
      items.push({ message: state.message });
    }
    return items;
  }, [state, idPrefix]);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) {
      return;
    }
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }

  return (
    <form action={dispatch} onSubmit={onSubmit} noValidate className="grid gap-5">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="keyId" value={apiKey.id} />
      <input type="hidden" name="kind" value={apiKey.kind} />
      <input type="hidden" name="environment" value={apiKey.environment} />
      <FormErrorSummary errors={summary} />
      <FormField
        id={`${idPrefix}-name`}
        name="name"
        label={API_KEYS_STRINGS.nameLabel}
        description={API_KEYS_STRINGS.nameHint}
        error={state.fieldErrors.name}
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
        required
        maxLength={100}
      />
      {apiKey.kind === "publishable" ? (
        <OriginsField
          idPrefix={idPrefix}
          environment={apiKey.environment}
          origins={origins}
          onChange={setOrigins}
          error={state.fieldErrors.allowedOrigins}
          rowErrors={state.fieldErrors.origins}
        />
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {API_KEYS_STRINGS.cancel}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? API_KEYS_STRINGS.editSubmitting : API_KEYS_STRINGS.editSubmit}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---- Roll ----------------------------------------------------------------------------------------------------------

const ROLL_IDLE: RollKeyState = { status: "idle" };

const ROLL_OPTIONS: readonly ExpireOldIn[] = ["now", "1h", "24h", "7d"];

/** The roll form inside the dialog: when the old key stops working. */
function RollKeyForm({
  tenantId,
  apiKey,
  onRolled,
  onCancel,
}: {
  readonly tenantId: string;
  readonly apiKey: ApiKey;
  readonly onRolled: (rolled: RolledKey) => void;
  readonly onCancel: () => void;
}) {
  const idPrefix = `roll-${apiKey.id}`;
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(rollKey, ROLL_IDLE);
  const [expireOldIn, setExpireOldIn] = useState<ExpireOldIn>("24h");
  const handled = useRef<RollKeyState>(ROLL_IDLE);

  useEffect(() => {
    if (handled.current === state) {
      return;
    }
    handled.current = state;
    if (state.status === "rolled" && state.rolled !== undefined) {
      onRolled(state.rolled);
    }
  }, [state, onRolled]);

  const summary = useMemo<FormErrorItem[]>(
    () => (state.message === undefined ? [] : [{ message: state.message }]),
    [state],
  );

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isPending) {
      return;
    }
    dispatch(new FormData(event.currentTarget));
  }

  return (
    <>
      <form action={dispatch} onSubmit={onSubmit} noValidate className="grid gap-5">
        <input type="hidden" name="tenantId" value={tenantId} />
        <input type="hidden" name="keyId" value={apiKey.id} />
        <FormErrorSummary errors={summary} />
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">{API_KEYS_STRINGS.rollLegend}</legend>
          {ROLL_OPTIONS.map((option) => {
            const id = `${idPrefix}-${option}`;
            return (
              <div key={option} className="flex items-center gap-2">
                <input
                  type="radio"
                  id={id}
                  name="expireOldIn"
                  value={option}
                  checked={expireOldIn === option}
                  onChange={() => setExpireOldIn(option)}
                  className="size-4 shrink-0 accent-primary"
                />
                <label htmlFor={id} className="text-sm">
                  {ROLL_EXPIRY_LABELS[option]}
                </label>
              </div>
            );
          })}
        </fieldset>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {API_KEYS_STRINGS.cancel}
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? API_KEYS_STRINGS.rollSubmitting : API_KEYS_STRINGS.rollSubmit}
          </Button>
        </DialogFooter>
      </form>
      {stepUpDialog}
    </>
  );
}

// ---- The actions of one key ----------------------------------------------------------------------------------------

const REVOKE_IDLE: RevokeKeyState = { status: "idle" };

/** "Edit", "Roll" and "Revoke" of a key that is not revoked, with the outcome of the last one. */
function KeyActions({
  tenantId,
  apiKey,
  writable,
  onRolled,
}: {
  readonly tenantId: string;
  readonly apiKey: ApiKey;
  readonly writable: boolean;
  readonly onRolled: (rolled: RolledKey) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [saved, setSaved] = useState(false);
  const [revoke, dispatchRevoke, revoking] = useActionState(revokeKey, REVOKE_IDLE);
  const masked = maskedOf(apiKey);

  const onSaved = useCallback(() => {
    setEditing(false);
    setSaved(true);
  }, []);
  const onKeyRolled = useCallback(
    (rolled: RolledKey) => {
      setRolling(false);
      onRolled(rolled);
    },
    [onRolled],
  );

  function confirmRevoke(): void {
    const formData = new FormData();
    formData.set("tenantId", tenantId);
    formData.set("keyId", apiKey.id);
    setSaved(false);
    startTransition(() => dispatchRevoke(formData));
  }

  const busy = !writable || revoking || revoke.status === "revoked";
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Dialog open={editing} onOpenChange={setEditing}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={busy}>
              {API_KEYS_STRINGS.edit}
              <ActionTarget apiKey={apiKey} />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{API_KEYS_STRINGS.editTitle(apiKey.name)}</DialogTitle>
              <DialogDescription>{API_KEYS_STRINGS.editIntro}</DialogDescription>
            </DialogHeader>
            {/* The content unmounts when the dialog closes, so each opening starts from the key as listed. */}
            <EditKeyForm
              tenantId={tenantId}
              apiKey={apiKey}
              onSaved={onSaved}
              onCancel={() => setEditing(false)}
            />
          </DialogContent>
        </Dialog>
        <Dialog open={rolling} onOpenChange={setRolling}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={busy}>
              {API_KEYS_STRINGS.roll}
              <ActionTarget apiKey={apiKey} />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{API_KEYS_STRINGS.rollTitle(apiKey.name)}</DialogTitle>
              <DialogDescription>{API_KEYS_STRINGS.rollIntro}</DialogDescription>
            </DialogHeader>
            <RollKeyForm
              tenantId={tenantId}
              apiKey={apiKey}
              onRolled={onKeyRolled}
              onCancel={() => setRolling(false)}
            />
          </DialogContent>
        </Dialog>
        <ConfirmDialog
          trigger={
            <Button type="button" variant="outline" size="sm" disabled={busy}>
              {revoking ? API_KEYS_STRINGS.revoking : API_KEYS_STRINGS.revoke}
              <ActionTarget apiKey={apiKey} />
            </Button>
          }
          title={API_KEYS_STRINGS.revokeTitle(apiKey.name)}
          description={API_KEYS_STRINGS.revokeDescription(masked)}
          confirmLabel={API_KEYS_STRINGS.revokeConfirm}
          onConfirm={confirmRevoke}
        />
      </div>
      {revoke.status === "failed" && revoke.message !== undefined ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {revoke.message}
        </p>
      ) : null}
      <p role="status" className="text-sm text-muted-foreground">
        {revoke.status === "revoked" ? API_KEYS_STRINGS.revoked : saved ? API_KEYS_STRINGS.saved : ""}
      </p>
    </div>
  );
}

// ---- The table -----------------------------------------------------------------------------------------------------

/** The new key of the last roll, above the list, with when the old key stops working (PF-30 AC4). */
function RolledKeyPanel({
  rolled,
  oldKey,
  onDismiss,
}: {
  readonly rolled: RolledKey;
  readonly oldKey: string;
  readonly onDismiss: () => void;
}) {
  return (
    <SecretRevealPanel
      title={API_KEYS_STRINGS.rolledTitle(rolled.apiKey.name)}
      secrets={[{ label: API_KEYS_STRINGS.rolledKeyLabel(rolled.apiKey.kind), value: rolled.key }]}
      onDismiss={onDismiss}
    >
      <p className="text-sm" data-field="previousExpiry">
        {rolled.oldKeyStopped
          ? API_KEYS_STRINGS.oldKeyStopped(oldKey)
          : API_KEYS_STRINGS.oldKeyWorksUntil(oldKey)}
        <DateTime value={rolled.previous.expiresAt} className="font-medium" />
        {rolled.oldKeyStopped ? "." : `. ${API_KEYS_STRINGS.oldKeySwitch}`}
      </p>
      <p className="text-sm">{API_KEYS_STRINGS.createdListed(maskedOf(rolled.apiKey))}</p>
      <RecommendedSetups />
    </SecretRevealPanel>
  );
}

export interface ApiKeysTableProps {
  readonly tenantId: string;
  /** The environment of the tab, for the caption. */
  readonly environment: ApiKey["environment"];
  /** The keys of the environment, as the page loaded them, newest first. */
  readonly rows: readonly KeyRow[];
  /** Keys can be changed (the OTA is `active`); otherwise the actions are disabled and the page says why. */
  readonly writable: boolean;
}

/** The keys of one environment and their actions; a rolled key shows once above them. */
export function ApiKeysTable({ tenantId, environment, rows, writable }: ApiKeysTableProps) {
  // The last roll's new key, in this component's memory only; "I have stored it" drops it.
  const [rolled, setRolled] = useState<{ readonly key: RolledKey; readonly oldKey: string } | undefined>(
    undefined,
  );

  const columns = useMemo<ColumnDef<KeyRow, unknown>[]>(
    () => [
      {
        id: "name",
        header: API_KEYS_STRINGS.columnName,
        cell: ({ row }) => <span className="font-medium">{row.original.apiKey.name}</span>,
      },
      {
        id: "kind",
        header: API_KEYS_STRINGS.columnKind,
        cell: ({ row }) => API_KEY_KIND_LABELS[row.original.apiKey.kind],
      },
      {
        id: "key",
        header: API_KEYS_STRINGS.columnKey,
        cell: ({ row }) => <code className="text-xs whitespace-nowrap">{maskedOf(row.original.apiKey)}</code>,
      },
      {
        id: "access",
        header: API_KEYS_STRINGS.columnAccess,
        cell: ({ row }) => <KeyAccess apiKey={row.original.apiKey} />,
      },
      {
        id: "created",
        header: API_KEYS_STRINGS.columnCreated,
        cell: ({ row }) => {
          const { createdAt, createdBy } = row.original.apiKey;
          return (
            <span className="grid">
              <DateTime value={createdAt} mode="date" />
              <span className="text-muted-foreground">
                {createdBy === null
                  ? API_KEYS_STRINGS.createdAtSetup
                  : API_KEYS_STRINGS.createdBy(createdBy.fullName)}
              </span>
            </span>
          );
        },
      },
      {
        id: "lastUsed",
        header: API_KEYS_STRINGS.columnLastUsed,
        cell: ({ row }) => {
          const { lastUsedAt } = row.original.apiKey;
          return lastUsedAt === null ? (
            <span className="text-muted-foreground">{API_KEYS_STRINGS.neverUsed}</span>
          ) : (
            <DateTime value={lastUsedAt} />
          );
        },
      },
      {
        id: "expires",
        header: API_KEYS_STRINGS.columnExpires,
        cell: ({ row }) => {
          const { expiresAt } = row.original.apiKey;
          return expiresAt === null ? (
            <span className="text-muted-foreground">{API_KEYS_STRINGS.noExpiry}</span>
          ) : (
            <DateTime value={expiresAt} />
          );
        },
      },
      {
        id: "status",
        header: API_KEYS_STRINGS.columnStatus,
        cell: ({ row }) => {
          const { state, apiKey } = row.original;
          return (
            <span className="grid gap-1">
              <Badge variant="outline" data-state={state} className={cn("w-fit", STATE_CLASSES[state])}>
                {STATE_LABELS[state]}
              </Badge>
              {apiKey.revokedAt === null ? null : (
                <DateTime value={apiKey.revokedAt} className="text-muted-foreground" />
              )}
            </span>
          );
        },
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{API_KEYS_STRINGS.columnActions}</span>,
        cell: ({ row }) =>
          row.original.state === "revoked" ? null : (
            <KeyActions
              tenantId={tenantId}
              apiKey={row.original.apiKey}
              writable={writable}
              onRolled={(key) => setRolled({ key, oldKey: maskedOf(row.original.apiKey) })}
            />
          ),
      },
    ],
    [tenantId, writable],
  );

  return (
    <div className="grid gap-4">
      {rolled === undefined ? null : (
        // A new panel for each roll: a panel dismissed before does not hide the next key.
        <RolledKeyPanel
          key={rolled.key.apiKey.id}
          rolled={rolled.key}
          oldKey={rolled.oldKey}
          // "I have stored it": the panel hides the key, and this copy of it goes too.
          onDismiss={() =>
            setRolled((previous) =>
              previous === undefined ? undefined : { ...previous, key: { ...previous.key, key: "" } },
            )
          }
        />
      )}
      <div className="overflow-x-auto">
        <DataTable
          caption={API_KEYS_STRINGS.listCaption(environment)}
          columns={columns}
          data={rows}
          emptyMessage={API_KEYS_STRINGS.empty}
          getRowId={(row) => row.apiKey.id}
        />
      </div>
    </div>
  );
}
