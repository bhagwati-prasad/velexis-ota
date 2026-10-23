"use client";

// The environment of the console shell (README §4 "Environment switch", OADR-0018 point 6, routes.md §1): the TEST /
// LIVE badge, the switch for staff who may open live, the warning strip of live mode and the notice of a refused live
// environment. The switch posts to the server action of `(console)/env-actions.ts`, which sets `__Host-vx_env` only
// to an environment the session allows; this module never reads or writes a cookie itself.
import { TriangleAlertIcon, InfoIcon, XIcon } from "lucide-react";
import { startTransition, useActionState, useEffect, useState } from "react";

import { resetEnvironment, switchEnvironment } from "@/app/(console)/env-actions";
import { toneClasses } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";
import type { StaffEnvironment } from "@/lib/permissions";
import { cn } from "@/lib/utils";

export const ENVIRONMENT_STRINGS = Object.freeze({
  label: "Environment",
  test: "TEST",
  live: "LIVE",
  switchTo: (environment: string) => `Switch to ${environment}`,
  liveWarning: "LIVE environment: bookings, tickets and payments here are real.",
  liveRefused: "Live is not available for this OTA or role.",
  liveRefusedDetail: "The console has switched back to the test environment.",
  dismiss: "Dismiss",
});

/** The environments in the switch's order. */
const ENVIRONMENTS: readonly StaffEnvironment[] = ["test", "live"];

/** The badge of an environment: TEST quietly, LIVE as a warning (the shell and the dialogs show it). */
export function EnvironmentBadge({
  environment,
  className,
}: {
  readonly environment: StaffEnvironment;
  readonly className?: string;
}) {
  return (
    <Badge
      variant="outline"
      data-environment={environment}
      className={cn(
        "font-semibold tracking-wide",
        environment === "live" ? "border-amber-600 bg-amber-400 text-amber-950" : toneClasses("neutral"),
        className,
      )}
    >
      <span className="sr-only">{ENVIRONMENT_STRINGS.label}: </span>
      {ENVIRONMENT_STRINGS[environment]}
    </Badge>
  );
}

/**
 * The TEST / LIVE switch, for staff whose session lists `live` (the layout renders it only then; a viewer never
 * sees it). Each button is the submit button of a small form whose hidden `environment` is its value, posted to
 * `switchEnvironment`, which checks it against the session again; it also works without JavaScript (a server action
 * form). A refusal is shown beside the switch.
 */
export function EnvironmentSwitch({ environment }: { readonly environment: StaffEnvironment }) {
  const [state, dispatch, pending] = useActionState(switchEnvironment, INITIAL_ACTION_STATE);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="group"
        aria-label={ENVIRONMENT_STRINGS.label}
        className="inline-flex rounded-md border bg-background p-0.5 shadow-xs"
      >
        {ENVIRONMENTS.map((option) => {
          const current = option === environment;
          return (
            <form key={option} action={dispatch} className="contents">
              <input type="hidden" name="environment" value={option} />
              <button
                type="submit"
                aria-pressed={current}
                disabled={current || pending}
                title={current ? undefined : ENVIRONMENT_STRINGS.switchTo(ENVIRONMENT_STRINGS[option])}
                className={cn(
                  "rounded-sm px-3 py-1 text-xs font-semibold tracking-wide outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default",
                  current && option === "live" && "bg-amber-400 text-amber-950",
                  current && option === "test" && "bg-secondary text-secondary-foreground",
                  !current && "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {ENVIRONMENT_STRINGS[option]}
              </button>
            </form>
          );
        })}
      </div>
      {state.ok === false && state.message !== undefined ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

export interface EnvironmentBannerProps {
  /** The environment the request works in. */
  readonly environment: StaffEnvironment;
  /**
   * The environment cookie asked for live and the API or the session refused it, so the request fell back to test
   * (`getConsoleRequest` of lib/velexis.ts).
   */
  readonly liveRefused: boolean;
}

/**
 * The strips under the shell's header: in live mode a warning that the data is real; after a refused live
 * environment the notice of routes.md §1 ("Live is not available for this OTA or role"). A server component cannot
 * write cookies, so the banner resets `__Host-vx_env` to test through `resetEnvironment` once it is shown; the
 * notice stays until it is dismissed, also when the reset re-renders the page without the refusal.
 */
export function EnvironmentBanner({ environment, liveRefused }: EnvironmentBannerProps) {
  const [notice, setNotice] = useState(liveRefused);
  useEffect(() => {
    if (!liveRefused) {
      return;
    }
    setNotice(true);
    startTransition(async () => {
      await resetEnvironment();
    });
  }, [liveRefused]);

  return (
    <>
      {environment === "live" ? (
        <div
          role="note"
          className="flex items-center gap-2 border-b border-amber-500 bg-amber-300 px-6 py-2 text-sm font-medium text-amber-950"
        >
          <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
          {ENVIRONMENT_STRINGS.liveWarning}
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          className="flex items-start gap-3 border-b border-sky-200 bg-sky-50 px-6 py-3 text-sm text-sky-950"
        >
          <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p className="flex-1">
            <span className="font-medium">{ENVIRONMENT_STRINGS.liveRefused}</span>{" "}
            {ENVIRONMENT_STRINGS.liveRefusedDetail}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => setNotice(false)}
          >
            <XIcon aria-hidden="true" />
            {ENVIRONMENT_STRINGS.dismiss}
          </Button>
        </div>
      ) : null}
    </>
  );
}
