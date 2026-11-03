"use client";

import Link from "next/link";
import {
  createContext,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  changeDomain,
  type Domain,
  type DomainActionState,
  type DomainIntent,
} from "@/app/(app)/otas/[tenantId]/domains/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { otaPath } from "@/lib/roles";
import { DOMAINS_STRINGS } from "@/lib/strings";

/**
 * The actions on the OTA's domains (README §2 `/otas/[tenantId]/domains`; flows/custom-domains.md steps 2, 5 and 7;
 * PF-41 AC2, AC4): "Check now" for a custom domain that is pending or failed, "Make primary" for a verified domain that
 * is not primary (the sub-domain always: making it primary again needs neither the switch nor the plan), and "Remove"
 * for a custom domain, after `ConfirmDialog`. The page renders `DomainActionsProvider` around its domain lists and one
 * `DomainActions` per domain the caller may change; all of them share one `changeDomain` action, so one change runs at
 * a time and its outcome shows in one notice above the lists, which stays when the domain it is about leaves the list
 * (a removal) and takes the focus when the button that was pressed is gone (a removal, a new primary).
 */

/** What the buttons of every domain share. */
interface DomainActionsContextValue {
  /** The action running, and the domain it is about. */
  readonly running?: { readonly intent: DomainIntent; readonly domainId: string } | undefined;
  readonly run: (domain: Domain, intent: DomainIntent) => void;
}

const DomainActionsContext = createContext<DomainActionsContextValue | null>(null);

function useDomainActions(): DomainActionsContextValue {
  const value = useContext(DomainActionsContext);
  if (value === null) {
    throw new Error("DomainActions renders outside DomainActionsProvider.");
  }
  return value;
}

const IDLE: DomainActionState = { status: "idle" };

/** The upgrade hint of `FEATURE_DISABLED`: owners get the billing page, admins are told an owner chooses the plan. */
export function UpgradeHint({ tenantId, isOwner }: { readonly tenantId: string; readonly isOwner: boolean }) {
  return isOwner ? (
    <>
      {DOMAINS_STRINGS.upgrade}{" "}
      <Link href={otaPath(tenantId, "/billing")} className="font-medium underline underline-offset-4">
        {DOMAINS_STRINGS.billingLink}
      </Link>
    </>
  ) : (
    DOMAINS_STRINGS.upgradeAskOwner
  );
}

/** The outcome of the last action: a status message, or an alert for a refusal. */
function DomainNotice({
  state,
  tenantId,
  isOwner,
  focusOn,
}: {
  readonly state: DomainActionState;
  readonly tenantId: string;
  readonly isOwner: boolean;
  /** The state whose outcome takes the focus (its button is gone), or `undefined`. */
  readonly focusOn: DomainActionState | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOn !== undefined && focusOn === state) {
      ref.current?.focus();
    }
  }, [focusOn, state]);
  const failed = state.status === "failed";
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role={failed ? "alert" : "status"}
      className={
        state.status === "idle"
          ? "sr-only"
          : failed
            ? "grid gap-1 rounded-lg border border-destructive/50 px-4 py-3 text-sm font-medium text-destructive focus:outline-none"
            : "grid gap-1 rounded-lg border px-4 py-3 text-sm focus:outline-none"
      }
      data-domain-notice={state.status}
    >
      {state.status === "idle" ? null : (
        <>
          <p data-notice-message="">
            {state.upgrade === true ? <UpgradeHint tenantId={tenantId} isOwner={isOwner} /> : state.message}
          </p>
          {state.reload === true ? (
            <p>
              {/* A full reload, so the list shows the domains (and the caller's role) as they are now. */}
              <a href={otaPath(tenantId, "/domains")} className="font-medium underline underline-offset-4">
                {DOMAINS_STRINGS.reload}
              </a>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export interface DomainActionsProviderProps {
  readonly tenantId: string;
  /** The caller is an owner: the upgrade hint links to billing (admins do not see billing). */
  readonly isOwner: boolean;
  readonly children: ReactNode;
}

/** Holds the one `changeDomain` action of the page and shows its outcome above `children` (the domain lists). */
export function DomainActionsProvider({ tenantId, isOwner, children }: DomainActionsProviderProps) {
  const [state, dispatch, isPending] = useActionState(changeDomain, IDLE);
  const [running, setRunning] = useState<DomainActionsContextValue["running"]>(undefined);

  const run = useCallback(
    (domain: Domain, intent: DomainIntent) => {
      const formData = new FormData();
      formData.set("tenantId", tenantId);
      formData.set("domainId", domain.id);
      formData.set("intent", intent);
      formData.set("hostname", domain.hostname);
      formData.set("verificationStatus", domain.verificationStatus);
      setRunning({ intent, domainId: domain.id });
      // `useActionState`'s dispatch outside a form's action runs in a transition of its own.
      startTransition(() => dispatch(formData));
    },
    [tenantId, dispatch],
  );

  // A removal or a new primary takes away the button that was pressed: the outcome takes the focus instead.
  const focusOn =
    state.status === "done" && (state.intent === "remove" || state.intent === "makePrimary")
      ? state
      : undefined;
  const value = useMemo<DomainActionsContextValue>(
    () => ({ running: isPending ? running : undefined, run }),
    [isPending, running, run],
  );
  return (
    <DomainActionsContext.Provider value={value}>
      <DomainNotice state={state} tenantId={tenantId} isOwner={isOwner} focusOn={focusOn} />
      {children}
    </DomainActionsContext.Provider>
  );
}

/**
 * Which actions a domain offers (see the module comment). A plain function of a client module: `DomainActions` and
 * tests call it, never server code.
 */
export function domainActionsOf(domain: Pick<Domain, "kind" | "verificationStatus" | "isPrimary">): {
  readonly check: boolean;
  readonly makePrimary: boolean;
  readonly remove: boolean;
} {
  const custom = domain.kind === "custom";
  return {
    check: custom && domain.verificationStatus !== "verified",
    makePrimary: domain.verificationStatus === "verified" && !domain.isPrimary,
    remove: custom,
  };
}

/** The domain an action's button is about, read with its label. */
function Target({ hostname }: { readonly hostname: string }) {
  return <span className="sr-only">{DOMAINS_STRINGS.actionTarget(hostname)}</span>;
}

/** The buttons of one domain; nothing when it offers no action (the primary sub-domain). */
export function DomainActions({ domain }: { readonly domain: Domain }) {
  const { running, run } = useDomainActions();
  const offered = domainActionsOf(domain);
  if (!offered.check && !offered.makePrimary && !offered.remove) {
    return null;
  }
  const busy = running !== undefined;
  const mine = (intent: DomainIntent) => running?.intent === intent && running.domainId === domain.id;
  return (
    <div className="flex flex-wrap gap-2" data-domain-actions={domain.hostname}>
      {offered.check ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => run(domain, "check")}
        >
          {mine("check") ? DOMAINS_STRINGS.checking : DOMAINS_STRINGS.checkNow}
          <Target hostname={domain.hostname} />
        </Button>
      ) : null}
      {offered.makePrimary ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => run(domain, "makePrimary")}
        >
          {mine("makePrimary") ? DOMAINS_STRINGS.makingPrimary : DOMAINS_STRINGS.makePrimary}
          <Target hostname={domain.hostname} />
        </Button>
      ) : null}
      {offered.remove ? (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="outline" size="sm" disabled={busy}>
              {mine("remove") ? DOMAINS_STRINGS.removing : DOMAINS_STRINGS.remove}
              <Target hostname={domain.hostname} />
            </Button>
          }
          title={DOMAINS_STRINGS.removeTitle(domain.hostname)}
          description={DOMAINS_STRINGS.removeDescription}
          confirmLabel={DOMAINS_STRINGS.removeConfirm}
          onConfirm={() => run(domain, "remove")}
        />
      ) : null}
    </div>
  );
}
