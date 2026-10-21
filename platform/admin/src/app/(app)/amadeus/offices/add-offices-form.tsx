"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";

import { addOffices, type AddOfficesField, type AddOfficesState } from "@/app/(app)/amadeus/offices/actions";
import { isStepUpRequired, useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ADD_OFFICES_STRINGS as S } from "@/lib/strings";

/**
 * "Add offices" on `/amadeus/offices` (README §2; flows/amadeus-connection.md §A step 4; `adminAddAmadeusOffices`,
 * PF-90): the admin picks the account whose pool gets the offices, pastes the office ids Amadeus issued (one per line)
 * and may add notes for all of them, such as the order reference. The answer lists the created offices and the
 * skipped ids (already in the pool, or repeated in the list); a success empties the list, so the same ids are not sent
 * twice, and the revalidated page lists the new offices. The props are the accounts' ids and names.
 */

const IDLE: AddOfficesState = { status: "idle" };

/** `maxLength` of the notes (`AddAmadeusOfficesRequest.notes`; the action checks it again, in code points). */
const NOTES_MAX = 2000;

const SELECT_CLASS =
  "h-9 w-full max-w-sm rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive";

/** An account whose pool can get offices: its id (`ama_…`) and its name with its environment. */
export interface AccountOption {
  readonly id: string;
  readonly label: string;
}

export interface AddOfficesFormProps {
  /** The Velexis Amadeus accounts; `null` when they could not be loaded. */
  readonly accounts: readonly AccountOption[] | null;
  /** The account chosen first: the one of the page's environment filter, when there is one. */
  readonly defaultAccountId?: string | undefined;
}

/** The `aria-describedby` and `aria-invalid` of a field with a hint and maybe a message. */
function described(
  id: string,
  error: string | undefined,
): { "aria-describedby": string; "aria-invalid"?: true } {
  return error === undefined
    ? { "aria-describedby": `${id}-hint` }
    : { "aria-describedby": `${id}-hint ${id}-error`, "aria-invalid": true };
}

function FieldError({ id, error }: { readonly id: string; readonly error: string | undefined }) {
  return error === undefined ? null : (
    <p id={`${id}-error`} className="text-sm font-medium text-destructive">
      {error}
    </p>
  );
}

/** The created offices and the skipped ids of the last addition. */
function AddedOutcome({
  created,
  skipped,
}: {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
}) {
  return (
    <div role="status" data-notice="done" className="grid gap-3 rounded-lg border px-4 py-3 text-sm">
      <div className="grid gap-1" data-outcome="created">
        <p className="font-medium">{S.createdTitle(created.length)}</p>
        {created.length === 0 ? null : (
          <ul aria-label={S.createdCaption} className="flex flex-wrap gap-2 font-mono text-xs">
            {created.map((officeId, index) => (
              <li key={`${index}:${officeId}`} className="rounded border px-2 py-0.5">
                {officeId}
              </li>
            ))}
          </ul>
        )}
      </div>
      {skipped.length === 0 ? null : (
        <div className="grid gap-1" data-outcome="skipped">
          <p className="font-medium">{S.skippedTitle(skipped.length)}</p>
          <ul aria-label={S.skippedCaption} className="flex flex-wrap gap-2 font-mono text-xs">
            {skipped.map((officeId, index) => (
              <li key={`${index}:${officeId}`} className="rounded border px-2 py-0.5">
                {officeId}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function AddOfficesForm({ accounts, defaultAccountId }: AddOfficesFormProps) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(addOffices, IDLE);
  const [choice, setChoice] = useState(defaultAccountId ?? accounts?.[0]?.id ?? "");
  // A choice the list no longer holds (the revalidated page lists the accounts of now) falls back to the first.
  const accountId = accounts?.some((account) => account.id === choice) ? choice : (accounts?.[0]?.id ?? "");
  const [officeIds, setOfficeIds] = useState("");
  const [notes, setNotes] = useState("");
  const id = useId();
  const ids = { account: `${id}-account`, officeIds: `${id}-office-ids`, notes: `${id}-notes` } as const;

  // A success empties the list and the notes, once per answer, so the same ids are not sent twice. A step-up request
  // is the previous state with `stepUp: true` (README §4): after an earlier success it still reads `done`, and the
  // list stays until the answer.
  const done = state.status === "done" && !isStepUpRequired(state);
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    if (done) {
      setOfficeIds("");
      setNotes("");
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!isPending) {
      dispatch(new FormData(event.currentTarget));
    }
  }

  const fieldErrors: Readonly<Partial<Record<AddOfficesField, string>>> =
    state.status === "failed" ? state.fieldErrors : {};
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-4 rounded-xl border p-6">
      <div className="grid gap-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight">
          {S.title}
        </h2>
        <p className="text-sm text-muted-foreground">{S.intro}</p>
      </div>
      {accounts === null ? (
        <p className="text-sm">{S.accountsUnavailable}</p>
      ) : accounts.length === 0 ? (
        <p className="text-sm">
          {S.noAccount}{" "}
          <Link href="/amadeus/accounts" className="font-medium underline underline-offset-4">
            {S.accountsLink}
          </Link>
        </p>
      ) : (
        <form onSubmit={onSubmit} noValidate className="grid max-w-2xl gap-4">
          {state.status === "failed" && state.message !== "" ? (
            <Alert variant="destructive" data-notice="failed" data-code={state.code}>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor={ids.account}>{S.accountLabel}</Label>
            <p id={`${ids.account}-hint`} className="text-sm text-muted-foreground">
              {S.accountHint}
            </p>
            <select
              id={ids.account}
              name="amadeusAccountId"
              value={accountId}
              className={SELECT_CLASS}
              {...described(ids.account, fieldErrors.amadeusAccountId)}
              onChange={(event) => setChoice(event.currentTarget.value)}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </select>
            <FieldError id={ids.account} error={fieldErrors.amadeusAccountId} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.officeIds}>{S.officeIdsLabel}</Label>
            <p id={`${ids.officeIds}-hint`} className="text-sm text-muted-foreground">
              {S.officeIdsHint}
            </p>
            <Textarea
              id={ids.officeIds}
              name="officeIds"
              value={officeIds}
              rows={6}
              spellCheck={false}
              autoCapitalize="characters"
              autoComplete="off"
              className="max-w-sm font-mono"
              {...described(ids.officeIds, fieldErrors.officeIds)}
              onChange={(event) => setOfficeIds(event.currentTarget.value)}
            />
            <FieldError id={ids.officeIds} error={fieldErrors.officeIds} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.notes}>{S.notesLabel}</Label>
            <p id={`${ids.notes}-hint`} className="text-sm text-muted-foreground">
              {S.notesHint}
            </p>
            <Input
              id={ids.notes}
              name="notes"
              value={notes}
              maxLength={NOTES_MAX}
              autoComplete="off"
              {...described(ids.notes, fieldErrors.notes)}
              onChange={(event) => setNotes(event.currentTarget.value)}
            />
            <FieldError id={ids.notes} error={fieldErrors.notes} />
          </div>
          <div>
            <Button type="submit" disabled={isPending}>
              {isPending ? S.adding : S.add}
            </Button>
          </div>
        </form>
      )}
      {done && state.status === "done" ? (
        <AddedOutcome created={state.created} skipped={state.skipped} />
      ) : null}
      {stepUpDialog}
    </section>
  );
}
