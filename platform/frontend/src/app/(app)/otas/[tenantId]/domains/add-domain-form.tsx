"use client";

import { startTransition, useActionState, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { addDomain, type AddDomainState } from "@/app/(app)/otas/[tenantId]/domains/actions";
import { UpgradeHint } from "@/app/(app)/otas/[tenantId]/domains/domain-actions";
import { DnsRecordsTable } from "@/components/dns-records-table";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DOMAINS_STRINGS } from "@/lib/strings";

/**
 * "Add a custom domain" (README §2 `/otas/[tenantId]/domains`; flows/custom-domains.md step 1; PF-41 AC1): owners and
 * admins type a host name (`travel.acme.com`, or an apex such as `acme.com`); `addDomain` adds it, and the answer shows
 * at once in `DnsRecordsTable`: the `TXT` record that proves ownership and both routing options (the `CNAME` for a
 * sub-domain, the `A`/`AAAA` records for an apex), with copy buttons. The page renders the form while
 * `features.customDomains` is on, the OTA is active and `listPlans` does not say the plan has no custom domains; an
 * answer `FEATURE_DISABLED` (the switch went off, or the plan has none) puts the upgrade hint in its place. A host name
 * the API refuses (`DOMAIN_INVALID`, `DOMAIN_TAKEN`) shows at the field; the field keeps what was typed after a
 * failure and is emptied once the domain is added (the page's list then shows it as well).
 */

export interface AddDomainFormProps {
  readonly tenantId: string;
  /** The caller is an owner: the upgrade hint links to billing. */
  readonly isOwner: boolean;
  /** The IANA zone of the dates of the new domain (the OTA's). */
  readonly timeZone: string;
  /**
   * The plan's limit of custom domains when the OTA's custom domains reach it (`listPlans`): the limit takes the
   * fields' place. The form stays mounted for it, so the answer of the add that filled the plan (its records to
   * create) stays in view after the revalidation that counts the new domain.
   */
  readonly limitReached?: number | undefined;
}

const IDLE: AddDomainState = { status: "idle", hostname: "" };

/** The id of the host name field, which the error summary links to. */
const HOSTNAME_ID = "add-domain-hostname";

/** The add form (see the module comment). */
export function AddDomainForm({ tenantId, isOwner, timeZone, limitReached }: AddDomainFormProps) {
  const [state, dispatch, isPending] = useActionState(addDomain, IDLE);
  const [hostname, setHostname] = useState(state.hostname);
  // The new domain's records stay until "Done"; a later submission replaces them.
  const [dismissed, setDismissed] = useState<AddDomainState | undefined>(undefined);
  const added = useRef<HTMLDivElement>(null);

  // Each answer sets the field in the render that shows it: empty after an add, as typed after a refusal.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    setHostname(state.hostname);
  }
  // The records to create take the focus, so the next step is read first.
  useEffect(() => {
    if (state.status === "added") {
      added.current?.focus();
    }
  }, [state]);

  const summary = useMemo<FormErrorItem[]>(() => {
    const items: FormErrorItem[] = [];
    if (state.fieldError !== undefined) {
      items.push({ message: state.fieldError, fieldId: HOSTNAME_ID });
    }
    if (state.message !== undefined) {
      items.push({ message: state.message });
    }
    return items;
  }, [state]);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    // React would reset the field after the action; the component's state already holds it.
    event.preventDefault();
    if (isPending) {
      return;
    }
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  }

  if (state.upgrade === true) {
    return (
      <Alert data-upgrade-hint="">
        <AlertTitle>{DOMAINS_STRINGS.upgradeTitle}</AlertTitle>
        <AlertDescription>
          <p>
            <UpgradeHint tenantId={tenantId} isOwner={isOwner} />
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-4">
      {state.status === "added" && state.domain !== undefined && dismissed !== state ? (
        <div
          ref={added}
          tabIndex={-1}
          role="group"
          aria-labelledby="add-domain-added-title"
          className="grid gap-3 rounded-lg border p-4 focus:outline-none"
          data-domain-added={state.domain.hostname}
        >
          <div className="grid gap-1">
            <p id="add-domain-added-title" className="font-medium">
              {DOMAINS_STRINGS.addedTitle(state.domain.hostname)}
            </p>
            <p className="text-sm text-muted-foreground">{DOMAINS_STRINGS.addedIntro}</p>
          </div>
          <DnsRecordsTable domain={state.domain} timeZone={timeZone} />
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setDismissed(state)}>
              {DOMAINS_STRINGS.addedDismiss}
            </Button>
          </div>
        </div>
      ) : null}
      {limitReached === undefined ? null : (
        <p className="text-sm" data-plan-limit="">
          {DOMAINS_STRINGS.planLimit(limitReached)}
        </p>
      )}
      {/* `action` keeps a form sent before the page hydrated from going out as a GET with the host in the URL. */}
      {limitReached !== undefined ? null : (
        <form
          action={dispatch}
          onSubmit={onSubmit}
          noValidate
          aria-labelledby="add-domain-title"
          className="grid gap-4"
          data-add-domain-form=""
        >
          <input type="hidden" name="tenantId" value={tenantId} />
          <FormErrorSummary errors={summary} />
          <FormField
            id={HOSTNAME_ID}
            name="hostname"
            label={DOMAINS_STRINGS.hostnameLabel}
            description={DOMAINS_STRINGS.hostnameHint}
            error={state.fieldError}
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            maxLength={254}
            required
          />
          <div>
            <Button type="submit" disabled={isPending}>
              {isPending ? DOMAINS_STRINGS.adding : DOMAINS_STRINGS.add}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
