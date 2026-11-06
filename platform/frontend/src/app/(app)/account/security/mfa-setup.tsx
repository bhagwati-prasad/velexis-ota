"use client";

import type { PlatformErrorCode } from "@velexis/errors";
import { useActionState, useEffect, useRef, useState } from "react";

import {
  beginMfaSetup,
  confirmMfaSetup,
  replaceRecoveryCodes,
  turnOffMfa,
  type MfaDisableState,
  type MfaEnableState,
  type MfaSetupState,
  type PendingMfaSetup,
  type RecoveryCodesState,
} from "@/app/(app)/account/security/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { DateTime } from "@/components/date-time";
import { FormField } from "@/components/form-field";
import { SecretRevealPanel } from "@/components/secret-reveal-panel";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { MFA_ENROLMENT_STRINGS, SECURITY_STRINGS } from "@/lib/strings";

/**
 * The two-factor section of `/account/security` (README §2 and §5; PF-04; PADR-0008):
 *
 * - **Off:** "Set up two-factor authentication" asks `beginMfaSetup` for a pending secret; the QR code (encoded on the
 *   server, rendered here as an inline SVG) and the base32 secret show with a code field; `confirmMfaSetup` turns MFA
 *   on and answers the ten recovery codes, which show once in `SecretRevealPanel` [PF-04 AC1].
 * - **On:** "Replace the recovery codes" and "Turn off two-factor authentication", each after a `ConfirmDialog` and
 *   through `useStepUpAction`: without a TOTP step-up in the last 15 minutes the API asks for one, `StepUpDialog` takes
 *   the code, and the same action runs again [PF-04 AC3]. A platform admin cannot turn MFA off and is told so.
 *
 * `MfaEnrolment` (below) is the same set-up for the MFA enrolment page `/mfa-enrolment` (PFE-030), with the page's own
 * actions and "Continue" to the page the account asked for once MFA is on, instead of the controls of an account that
 * has MFA.
 *
 * The secret, the QR code and the recovery codes live in React state only, for as long as they are needed: never in
 * storage, cookies, the URL or the history, and the page's own markup never holds them, so a reload shows none of them.
 */

export interface MfaSetupProps {
  /** `getMe.mfaEnabled` when the page was rendered. */
  readonly mfaEnabled: boolean;
  /** `getMe.mfaEnabledAt`. */
  readonly mfaEnabledAt: string | null;
  /** Platform admins keep MFA on (PADR-0006). */
  readonly isPlatformAdmin: boolean;
  /** The account's time zone, for the date MFA was turned on. */
  readonly timeZone: string;
}

const IDLE_SETUP: MfaSetupState = Object.freeze({ status: "idle" });
const IDLE_ENABLE: MfaEnableState = Object.freeze({ status: "idle" });
const IDLE_DISABLE: MfaDisableState = Object.freeze({ status: "idle" });
const IDLE_CODES: RecoveryCodesState = Object.freeze({ status: "idle" });

/** The codes after which the page is out of date: a reload shows the current two-factor state. */
const RELOAD_CODES: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "MFA_ALREADY_ENABLED",
  "MFA_REQUIRED",
]);

/** The action whose answer is the latest: only its message shows. */
type Latest = "setup" | "enable" | "disable" | "replace";

/** Recovery codes being shown, with the panel's heading; `key` gives each new set a panel of its own. */
interface ShownCodes {
  readonly key: number;
  readonly title: string;
  readonly codes: readonly string[];
}

/** The QR code of a pending set-up as an inline SVG, from the geometry `lib/qr.ts` made on the server. */
function QrImage({ qr }: { readonly qr: PendingMfaSetup["qr"] }) {
  return (
    <svg
      role="img"
      aria-label={SECURITY_STRINGS.mfaQrLabel}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      width={200}
      height={200}
      shapeRendering="crispEdges"
      className="rounded-md border"
      data-qr="totp"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={qr.path} fill="#000000" />
    </svg>
  );
}

/** A message of the latest action: a status message after a change, an alert after a refusal. */
function Notice({
  message,
  code,
  problem,
}: {
  readonly message: string | undefined;
  readonly code: PlatformErrorCode | undefined;
  readonly problem: boolean;
}) {
  if (message === undefined) {
    return null;
  }
  if (!problem) {
    return (
      <p role="status" data-notice="done" className="rounded-lg border px-4 py-3 text-sm font-medium">
        {message}
      </p>
    );
  }
  return (
    <Alert variant="destructive" data-notice="failed" data-code={code}>
      <AlertDescription>
        <p>{message}</p>
        {code !== undefined && RELOAD_CODES.has(code) ? (
          <p>
            {/* A full reload, so the page shows the two-factor state as it is now. */}
            <a href="/account/security" className="font-medium underline underline-offset-4">
              {SECURITY_STRINGS.sessionsReload}
            </a>
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** The pending set-up: the QR code, the secret, and the form that confirms it with a code. */
function PendingSetup({
  setup,
  state,
  confirm,
  confirming,
  onCancel,
}: {
  readonly setup: PendingMfaSetup;
  readonly state: MfaEnableState;
  readonly confirm: (formData: FormData) => void;
  readonly confirming: boolean;
  readonly onCancel: () => void;
}) {
  const minutes = Math.max(1, Math.ceil(setup.expiresIn / 60));
  return (
    <div className="grid gap-6" data-mfa="pending">
      <div className="grid gap-3">
        <h3 className="font-semibold">{SECURITY_STRINGS.mfaScanTitle}</h3>
        <p className="text-sm text-muted-foreground">{SECURITY_STRINGS.mfaScanIntro}</p>
        <QrImage qr={setup.qr} />
        <CopyField label={SECURITY_STRINGS.mfaSecretLabel} value={setup.secret} />
        <p className="text-sm text-muted-foreground">{SECURITY_STRINGS.mfaSecretHint}</p>
        <p className="text-sm text-muted-foreground">{SECURITY_STRINGS.mfaExpiresIn(minutes)}</p>
      </div>
      <form action={confirm} noValidate className="grid gap-4">
        <h3 className="font-semibold">{SECURITY_STRINGS.mfaConfirmTitle}</h3>
        {state.status === "failed" && state.message !== undefined ? (
          <Alert variant="destructive" data-notice="failed" data-code={state.code}>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}
        <FormField
          label={SECURITY_STRINGS.mfaCodeLabel}
          name="code"
          description={SECURITY_STRINGS.mfaCodeHint}
          error={state.status === "failed" ? state.fieldError : undefined}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          required
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={confirming}>
            {confirming ? SECURITY_STRINGS.mfaConfirming : SECURITY_STRINGS.mfaConfirm}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={confirming}>
            {SECURITY_STRINGS.mfaCancel}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function MfaSetup({ mfaEnabled, mfaEnabledAt, isPlatformAdmin, timeZone }: MfaSetupProps) {
  const [setupState, begin, starting] = useActionState(beginMfaSetup, IDLE_SETUP);
  const [enableState, confirm, confirming] = useActionState(confirmMfaSetup, IDLE_ENABLE);
  const disable = useStepUpAction(turnOffMfa, IDLE_DISABLE);
  const replace = useStepUpAction(replaceRecoveryCodes, IDLE_CODES);

  const [enabled, setEnabled] = useState(mfaEnabled);
  const [setup, setSetup] = useState<PendingMfaSetup | undefined>(undefined);
  const [shownCodes, setShownCodes] = useState<ShownCodes | undefined>(undefined);
  const [latest, setLatest] = useState<Latest | undefined>(undefined);

  // The page rendered again (after a change here, or a reload of its data): its state wins.
  const [renderedEnabled, setRenderedEnabled] = useState(mfaEnabled);
  if (renderedEnabled !== mfaEnabled) {
    setRenderedEnabled(mfaEnabled);
    setEnabled(mfaEnabled);
  }

  // Each answer updates the section once, in the render that shows it.
  const [seenSetup, setSeenSetup] = useState(setupState);
  if (seenSetup !== setupState) {
    setSeenSetup(setupState);
    setLatest("setup");
    if (setupState.setup !== undefined) {
      setSetup(setupState.setup);
    }
  }
  const [seenEnable, setSeenEnable] = useState(enableState);
  if (seenEnable !== enableState) {
    setSeenEnable(enableState);
    setLatest("enable");
    if (enableState.status === "enabled") {
      setEnabled(true);
      setSetup(undefined);
      if (enableState.recoveryCodes !== undefined) {
        setShownCodes({
          key: (shownCodes?.key ?? 0) + 1,
          title: SECURITY_STRINGS.recoveryCodesTitle,
          codes: enableState.recoveryCodes,
        });
      }
    } else if (enableState.status === "expired") {
      setSetup(undefined);
    }
  }
  const [seenDisable, setSeenDisable] = useState(disable.state);
  if (seenDisable !== disable.state) {
    setSeenDisable(disable.state);
    setLatest("disable");
    if (disable.state.status === "disabled") {
      setEnabled(false);
      setShownCodes(undefined);
    }
  }
  const [seenReplace, setSeenReplace] = useState(replace.state);
  if (seenReplace !== replace.state) {
    setSeenReplace(replace.state);
    setLatest("replace");
    if (replace.state.status === "replaced" && replace.state.recoveryCodes !== undefined) {
      setShownCodes({
        key: (shownCodes?.key ?? 0) + 1,
        title: SECURITY_STRINGS.newRecoveryCodesTitle,
        codes: replace.state.recoveryCodes,
      });
    }
  }

  const notice =
    latest === "setup"
      ? { message: setupState.message, code: setupState.code, problem: setupState.status === "failed" }
      : latest === "enable" && enableState.status !== "failed"
        ? // A refused code shows in the set-up form itself.
          { message: enableState.message, code: enableState.code, problem: true }
        : latest === "disable"
          ? {
              message: disable.state.message,
              code: disable.state.code,
              problem: disable.state.status !== "disabled",
            }
          : latest === "replace"
            ? {
                message: replace.state.status === "replaced" ? undefined : replace.state.message,
                code: replace.state.code,
                problem: true,
              }
            : undefined;

  const showEnabledSince = enabled && mfaEnabled && mfaEnabledAt !== null;

  return (
    <div className="grid gap-6" data-mfa={enabled ? "on" : "off"}>
      {shownCodes === undefined ? null : (
        <SecretRevealPanel
          key={shownCodes.key}
          title={shownCodes.title}
          secrets={shownCodes.codes.map((value, index) => ({
            label: SECURITY_STRINGS.recoveryCodeLabel(index + 1),
            value,
          }))}
          onDismiss={() => setShownCodes(undefined)}
        >
          <p className="text-sm">{SECURITY_STRINGS.recoveryCodesIntro}</p>
          {latest === "replace" && replace.state.status === "replaced" ? (
            <p role="status" className="text-sm font-medium">
              {replace.state.message}
            </p>
          ) : null}
        </SecretRevealPanel>
      )}
      {notice === undefined ? null : <Notice {...notice} />}

      {enabled ? (
        <div className="grid gap-4">
          <p className="text-sm">
            {SECURITY_STRINGS.mfaOnIntro}
            {showEnabledSince ? (
              <>
                {" "}
                {SECURITY_STRINGS.mfaOnSince}{" "}
                <DateTime value={mfaEnabledAt} mode="date" timeZone={timeZone} />.
              </>
            ) : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <ConfirmDialog
              trigger={
                <Button type="button" variant="outline" disabled={replace.isPending}>
                  {replace.isPending ? SECURITY_STRINGS.replacingCodes : SECURITY_STRINGS.replaceCodes}
                </Button>
              }
              title={SECURITY_STRINGS.replaceCodesTitle}
              description={SECURITY_STRINGS.replaceCodesDescription}
              confirmLabel={SECURITY_STRINGS.replaceCodesConfirm}
              destructive={false}
              onConfirm={() => replace.dispatch(new FormData())}
            />
            {isPlatformAdmin ? null : (
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="outline" disabled={disable.isPending}>
                    {disable.isPending ? SECURITY_STRINGS.turningOff : SECURITY_STRINGS.turnOff}
                  </Button>
                }
                title={SECURITY_STRINGS.turnOffTitle}
                description={SECURITY_STRINGS.turnOffDescription}
                confirmLabel={SECURITY_STRINGS.turnOffConfirm}
                onConfirm={() => disable.dispatch(new FormData())}
              />
            )}
          </div>
          {isPlatformAdmin ? (
            <p className="text-sm text-muted-foreground" data-notice="platform-admin">
              {SECURITY_STRINGS.platformAdminKeepsMfa}
            </p>
          ) : null}
        </div>
      ) : setup === undefined ? (
        <div className="grid gap-4">
          <p className="text-sm">{SECURITY_STRINGS.mfaOffIntro}</p>
          <form action={begin}>
            <Button type="submit" disabled={starting}>
              {starting
                ? SECURITY_STRINGS.mfaStarting
                : latest === "enable" && enableState.status === "expired"
                  ? SECURITY_STRINGS.mfaStartAgain
                  : SECURITY_STRINGS.mfaStart}
            </Button>
          </form>
        </div>
      ) : (
        <PendingSetup
          setup={setup}
          state={latest === "enable" ? enableState : IDLE_ENABLE}
          confirm={confirm}
          confirming={confirming}
          onCancel={() => setSetup(undefined)}
        />
      )}
      {disable.stepUpDialog}
      {replace.stepUpDialog}
    </div>
  );
}

export interface MfaEnrolmentProps {
  /** Starts the set-up (`startMfaSetup`): the enrolment page's `beginEnrolment`. */
  readonly begin: (previous: MfaSetupState, formData: FormData) => Promise<MfaSetupState>;
  /**
   * Confirms it with the typed code (`enableMfa`): the enrolment page's `confirmEnrolment`, which renders no page
   * again, so the recovery codes stay on screen until the person continues.
   */
  readonly confirm: (previous: MfaEnableState, formData: FormData) => Promise<MfaEnableState>;
  /** Where "Continue" goes once MFA is on: the page's `next` as `safeNextPath()` kept it, or `/dashboard`. */
  readonly continueTo: string;
}

/**
 * The set-up of `/mfa-enrolment` (PFE-030; PF-04 AC1 and AC4): the same steps as the security page's set-up (QR code
 * and base32 secret, the confirming code, the ten recovery codes shown once in `SecretRevealPanel`), and nothing more
 * reaches the browser: the secret, the QR code's geometry and the codes come only in the actions' answers and live in
 * React state. Once MFA is on (or was turned on elsewhere, `MFA_ALREADY_ENABLED`), "Continue" leaves for `continueTo`
 * with a full page load, so the signed-in layout reads the account afresh.
 */
export function MfaEnrolment({ begin, confirm, continueTo }: MfaEnrolmentProps) {
  const [setupState, start, starting] = useActionState(begin, IDLE_SETUP);
  const [enableState, submitCode, confirming] = useActionState(confirm, IDLE_ENABLE);

  const [setup, setSetup] = useState<PendingMfaSetup | undefined>(undefined);
  const [codes, setCodes] = useState<readonly string[] | undefined>(undefined);
  const [enabled, setEnabled] = useState(false);
  const [latest, setLatest] = useState<"setup" | "enable" | undefined>(undefined);

  // Each answer updates the set-up once, in the render that shows it.
  const [seenSetup, setSeenSetup] = useState(setupState);
  if (seenSetup !== setupState) {
    setSeenSetup(setupState);
    setLatest("setup");
    if (setupState.setup !== undefined) {
      setSetup(setupState.setup);
    } else if (setupState.code === "MFA_ALREADY_ENABLED") {
      setEnabled(true);
    }
  }
  const [seenEnable, setSeenEnable] = useState(enableState);
  if (seenEnable !== enableState) {
    setSeenEnable(enableState);
    setLatest("enable");
    if (enableState.status === "enabled" || enableState.code === "MFA_ALREADY_ENABLED") {
      setEnabled(true);
      setSetup(undefined);
      setCodes(enableState.recoveryCodes);
    } else if (enableState.status === "expired") {
      setSetup(undefined);
    }
  }

  // The new state takes the focus once MFA is on, so a screen reader reads it and the codes come next.
  const enabledHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (enabled) {
      enabledHeading.current?.focus();
    }
  }, [enabled]);

  if (enabled) {
    // Turned on here: no message once the codes are stored, or, when the answer had no codes of the document's shape,
    // an alert that says to replace them on the security page. Turned on elsewhere (`MFA_ALREADY_ENABLED`): a status.
    const enabledHere = latest === "enable" && enableState.status === "enabled";
    const codesMissing = enabledHere && enableState.recoveryCodes === undefined;
    const message =
      codes !== undefined
        ? undefined
        : enabledHere
          ? enableState.message
          : MFA_ENROLMENT_STRINGS.alreadyEnabled;
    return (
      <div className="grid gap-6" data-mfa="on">
        <div className="grid gap-2">
          <h3 ref={enabledHeading} tabIndex={-1} className="font-semibold focus:outline-none">
            {MFA_ENROLMENT_STRINGS.enabledTitle}
          </h3>
          <p className="text-sm">{MFA_ENROLMENT_STRINGS.enabledIntro}</p>
        </div>
        {codes === undefined ? null : (
          <SecretRevealPanel
            title={SECURITY_STRINGS.recoveryCodesTitle}
            secrets={codes.map((value, index) => ({
              label: SECURITY_STRINGS.recoveryCodeLabel(index + 1),
              value,
            }))}
            onDismiss={() => setCodes(undefined)}
          >
            <p className="text-sm">{SECURITY_STRINGS.recoveryCodesIntro}</p>
          </SecretRevealPanel>
        )}
        <Notice message={message} code={codesMissing ? enableState.code : undefined} problem={codesMissing} />
        <div>
          {/* A full page load: the signed-in layout reads `getMe` again, now without the enrolment. */}
          <Button asChild size="lg">
            <a href={continueTo}>{MFA_ENROLMENT_STRINGS.continue}</a>
          </Button>
        </div>
      </div>
    );
  }

  // A refused code shows in the set-up form itself; an expired set-up and a refused start show above.
  const notice =
    latest === "setup" && setupState.status === "failed"
      ? { message: setupState.message, code: setupState.code }
      : latest === "enable" && enableState.status === "expired"
        ? { message: enableState.message, code: enableState.code }
        : undefined;

  return (
    <div className="grid gap-6" data-mfa="off">
      {notice === undefined ? null : <Notice message={notice.message} code={notice.code} problem />}
      {setup === undefined ? (
        <form action={start}>
          <Button type="submit" size="lg" disabled={starting}>
            {starting
              ? SECURITY_STRINGS.mfaStarting
              : latest === "enable" && enableState.status === "expired"
                ? SECURITY_STRINGS.mfaStartAgain
                : SECURITY_STRINGS.mfaStart}
          </Button>
        </form>
      ) : (
        <PendingSetup
          setup={setup}
          state={latest === "enable" ? enableState : IDLE_ENABLE}
          confirm={submitCode}
          confirming={confirming}
          onCancel={() => setSetup(undefined)}
        />
      )}
    </div>
  );
}
