"use client";

// The e-mail template editor's client side (OAD-015; routes.md §9, api-changes part 2 §2.6, OADR-0013 point 3): the
// form of one template (key, channel, locale), its preview and the reset dialog. The page is a server component that
// reads the API; this module never imports the SDK or the session code, and its components get plain values (the
// template's parts and version, the address), never a token.
//
// - **The form** (`TemplateEditor`): the subject, the HTML body and the text body (Handlebars in the API's safe subset,
//   with the key's variables listed by the page), and "Send this template" (`isActive`). "Save" posts to
//   templates/actions.ts `saveTemplate` with the displayed version as `If-Match` when the locale has its own row;
//   roles without `settings:write` see the parts read only and no "Save". "Preview" (every role, `settings:read`)
//   posts the draft as the form holds it to `previewTemplate`, and the rendered e-mail is shown under the form in a
//   sandboxed frame without scripts (preview-frame.tsx).
// - **Refusals**: `422 TEMPLATE_INVALID` is listed per part and line ("HTML body, line 3: …") with "Go to line N",
//   which selects that line in its part, and each part shows its first problem on its field (`aria-describedby`).
// - **Reset** (`ResetTemplateDialog`) is `ConfirmDialog` without a reason (the contract's reset takes no body), offered
//   when the locale has its own row; without one the button is disabled and says why, and after a reset it stays to
//   show what serves the locale now.
//
// Every input has `autoComplete="off"`; nothing here asks for a card.
import { LoaderCircleIcon } from "lucide-react";
import {
  startTransition,
  useActionState,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { INITIAL_ACTION_STATE, fieldError, type ActionState } from "@/lib/action-state";
import type { StaffEnvironment } from "@/lib/permissions";
import { cn } from "@/lib/utils";

import {
  TEMPLATE_FIELDS,
  TEMPLATE_LIMITS,
  lineRange,
  previewOf,
  problemsOf,
  templatePartLabel,
  type TemplatePart,
  type TemplateProblem,
  type TemplateRef,
  type TemplateSource,
} from "../content-rules";
import { previewTemplate, resetTemplate, saveTemplate } from "./actions";
import { TemplatePreview } from "./preview-frame";

export const TEMPLATE_FORM_STRINGS = Object.freeze({
  subject: "Subject",
  subjectHint: `One line, at most ${TEMPLATE_LIMITS.subject} characters.`,
  bodyHtml: "HTML body",
  bodyHtmlHint: `The e-mail as HTML, at most ${TEMPLATE_LIMITS.bodyHtml.toLocaleString("en-GB")} characters. Values are HTML-escaped.`,
  bodyText: "Text body",
  bodyTextHint: `The same e-mail as plain text, for mail clients without HTML; at most ${TEMPLATE_LIMITS.bodyText.toLocaleString("en-GB")} characters.`,
  isActive: "Send this template",
  isActiveHint:
    "When off, the template is kept, and e-mails in this language use the template of its language or the default.",
  readOnly: "Read only: changing templates needs the permission settings:write. You can still preview it.",
  save: "Save",
  saving: "Saving…",
  preview: "Preview",
  previewing: "Rendering…",
  problemsTitle: "The template does not compile",
  goToLine: (part: TemplatePart, line: number) =>
    `Go to line ${line} of the ${part === "bodyHtml" ? "HTML body" : part === "bodyText" ? "text body" : "subject"}`,
  requestId: (requestId: string) => `Request id ${requestId}`,
  reset: "Reset to default",
  resetTitle: (key: string, locale: string) => `Reset the template ${key} in ${locale}?`,
  resetSummary: (locale: string) =>
    `The OTA's own template for ${locale} is deleted. E-mails in ${locale} then use the template of its language, or the default template, which the page shows after the reset. This cannot be undone: copy the parts first if you want to keep them.`,
  resetNone:
    "This language has no template of its own: it already uses the default or its language's template.",
  sources: {
    customised: "Customised",
    seeded: "Default (own copy)",
    inherited: (locale: string) => `Inherited from ${locale}`,
    default: "Default",
  },
});

/** Where a template comes from, as a badge (the list's rows and the editor's heading). */
export function TemplateSourceBadge({
  source,
  inheritedFrom,
}: {
  readonly source: TemplateSource;
  readonly inheritedFrom: string | null;
}) {
  const words = TEMPLATE_FORM_STRINGS.sources;
  if (source === "customised") {
    return <Badge>{words.customised}</Badge>;
  }
  if (source === "inherited") {
    return <Badge variant="secondary">{words.inherited(inheritedFrom ?? "")}</Badge>;
  }
  return <Badge variant="outline">{source === "seeded" ? words.seeded : words.default}</Badge>;
}

/** One part's control: the subject's input or a body's text area, with its label, hint and error. */
function PartField({
  part,
  label,
  hint,
  state,
  defaultValue,
  readOnly,
  multiline,
  control,
}: {
  readonly part: TemplatePart;
  readonly label: string;
  readonly hint: string;
  readonly state: ActionState;
  readonly defaultValue: string;
  readonly readOnly: boolean;
  readonly multiline: boolean;
  readonly control?: RefObject<HTMLTextAreaElement | null>;
}) {
  const id = useId();
  const error = fieldError(state, part);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = {
    "aria-describedby": error === undefined ? hintId : `${hintId} ${errorId}`,
    ...(error === undefined ? {} : { "aria-invalid": true as const }),
  };
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>
      {multiline ? (
        <Textarea
          ref={control}
          id={id}
          name={part}
          rows={part === TEMPLATE_FIELDS.bodyHtml ? 16 : 10}
          defaultValue={defaultValue}
          readOnly={readOnly}
          autoComplete="off"
          spellCheck={false}
          className="field-sizing-fixed font-mono text-sm"
          {...described}
        />
      ) : (
        <Input
          id={id}
          name={part}
          defaultValue={defaultValue}
          readOnly={readOnly}
          autoComplete="off"
          {...described}
        />
      )}
      {error === undefined ? null : (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The problems of a `422 TEMPLATE_INVALID`, per part and line, each with "Go to line N" when it names a line of a body.
 */
export function TemplateProblems({
  problems,
  onGoTo,
}: {
  readonly problems: readonly TemplateProblem[];
  readonly onGoTo?: (part: TemplatePart, line: number) => void;
}) {
  if (problems.length === 0) {
    return null;
  }
  return (
    <section
      aria-label={TEMPLATE_FORM_STRINGS.problemsTitle}
      className="grid gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm"
    >
      <h3 className="font-medium text-destructive">{TEMPLATE_FORM_STRINGS.problemsTitle}</h3>
      <ul className="grid gap-1.5">
        {problems.map((problem, index) => (
          <li
            key={`${problem.part}-${problem.line ?? "none"}-${index}`}
            data-part={problem.part}
            {...(problem.line === null ? {} : { "data-line": problem.line })}
            className="flex flex-wrap items-center gap-x-3 gap-y-1"
          >
            <span>
              <span className="font-medium">{templatePartLabel(problem.part)}</span>
              {problem.line === null ? ": " : `, line ${problem.line}: `}
              {problem.message}
            </span>
            {onGoTo !== undefined && problem.line !== null && problem.part !== TEMPLATE_FIELDS.subject ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onGoTo(problem.part, problem.line ?? 1)}
              >
                {TEMPLATE_FORM_STRINGS.goToLine(problem.part, problem.line)}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A message of an action's state: its text and request id, as a status or an alert. */
function StateMessage({ state, children }: { readonly state: ActionState; readonly children?: ReactNode }) {
  if (state.message === undefined) {
    return null;
  }
  return (
    <div
      role={state.ok === true ? "status" : "alert"}
      className={cn(
        "grid gap-1 rounded-md border px-3 py-2 text-sm",
        state.ok === true ? "text-foreground" : "border-destructive/40",
      )}
    >
      <p className={state.ok === true ? "" : "font-medium text-destructive"}>{state.message}</p>
      {state.requestId === undefined ? null : (
        <p className="text-muted-foreground">{TEMPLATE_FORM_STRINGS.requestId(state.requestId)}</p>
      )}
      {children}
    </div>
  );
}

/** The parts a template's form starts with. */
export interface TemplateFormValues {
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodyText: string;
  readonly isActive: boolean;
}

export interface TemplateEditorProps {
  /** The template's key, channel and locale. */
  readonly address: TemplateRef;
  /** The locale's own row's `version` (the `If-Match` of a save), `null` without one. */
  readonly version: number | null;
  readonly values: TemplateFormValues;
  /** `settings:write`: the parts can be changed and saved; otherwise read only (the preview stays). */
  readonly canWrite: boolean;
  /**
   * What the page showed (version, last change, source): when it changes (a save, a reset), the parts start again from
   * the template the page now shows; a refused save keeps what was typed.
   */
  readonly formKey: string;
}

/** The form of one template: its three parts, "Send this template", Save and Preview, and the preview under it. */
export function TemplateEditor({ address, version, values, canWrite, formKey }: TemplateEditorProps) {
  const [saveState, save, saving] = useActionState(saveTemplate, INITIAL_ACTION_STATE);
  const [previewState, preview, previewing] = useActionState(previewTemplate, INITIAL_ACTION_STATE);
  // The fields show the problems of whichever action ran last.
  const [last, setLast] = useState<"save" | "preview">("save");
  const form = useRef<HTMLFormElement>(null);
  const html = useRef<HTMLTextAreaElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const shown = last === "save" ? saveState : previewState;
  const rendered = previewOf(previewState);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canWrite) {
      return;
    }
    const formData = new FormData(event.currentTarget);
    setLast("save");
    startTransition(() => save(formData));
  }

  function runPreview(): void {
    if (form.current === null) {
      return;
    }
    const formData = new FormData(form.current);
    setLast("preview");
    startTransition(() => preview(formData));
  }

  function goTo(part: TemplatePart, line: number): void {
    const element =
      part === TEMPLATE_FIELDS.bodyHtml
        ? html.current
        : part === TEMPLATE_FIELDS.bodyText
          ? text.current
          : null;
    if (element === null) {
      return;
    }
    const range = lineRange(element.value, line);
    if (range === undefined) {
      return;
    }
    element.focus();
    element.setSelectionRange(range.start, range.end);
  }

  return (
    <div className="grid max-w-5xl gap-6">
      <form ref={form} noValidate onSubmit={submit} className="grid gap-6">
        <input type="hidden" name={TEMPLATE_FIELDS.templateKey} value={address.templateKey} />
        <input type="hidden" name={TEMPLATE_FIELDS.channel} value={address.channel} />
        <input type="hidden" name={TEMPLATE_FIELDS.locale} value={address.locale} />
        <input type="hidden" name={TEMPLATE_FIELDS.version} value={version === null ? "" : String(version)} />
        {canWrite ? null : <p className="text-sm text-muted-foreground">{TEMPLATE_FORM_STRINGS.readOnly}</p>}
        <div key={formKey} className="grid gap-4">
          <PartField
            part="subject"
            label={TEMPLATE_FORM_STRINGS.subject}
            hint={TEMPLATE_FORM_STRINGS.subjectHint}
            state={shown}
            defaultValue={values.subject}
            readOnly={!canWrite}
            multiline={false}
          />
          <PartField
            part="bodyHtml"
            label={TEMPLATE_FORM_STRINGS.bodyHtml}
            hint={TEMPLATE_FORM_STRINGS.bodyHtmlHint}
            state={shown}
            defaultValue={values.bodyHtml}
            readOnly={!canWrite}
            multiline
            control={html}
          />
          <PartField
            part="bodyText"
            label={TEMPLATE_FORM_STRINGS.bodyText}
            hint={TEMPLATE_FORM_STRINGS.bodyTextHint}
            state={shown}
            defaultValue={values.bodyText}
            readOnly={!canWrite}
            multiline
            control={text}
          />
          {canWrite ? <ActiveField defaultChecked={values.isActive} /> : null}
        </div>
        <TemplateProblems problems={problemsOf(shown)} onGoTo={goTo} />
        <div className="grid gap-3">
          <StateMessage state={shown} />
          <div className="flex flex-wrap items-center gap-3">
            {canWrite ? (
              <Button type="submit" disabled={saving} aria-busy={saving}>
                {saving ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : null}
                {saving ? TEMPLATE_FORM_STRINGS.saving : TEMPLATE_FORM_STRINGS.save}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={previewing}
              aria-busy={previewing}
              onClick={runPreview}
            >
              {previewing ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : null}
              {previewing ? TEMPLATE_FORM_STRINGS.previewing : TEMPLATE_FORM_STRINGS.preview}
            </Button>
          </div>
        </div>
      </form>
      {rendered === undefined ? null : <TemplatePreview preview={rendered} />}
    </div>
  );
}

/** "Send this template": a checkbox that posts `true` when ticked. */
function ActiveField({ defaultChecked }: { readonly defaultChecked: boolean }) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          name={TEMPLATE_FIELDS.isActive}
          value="true"
          defaultChecked={defaultChecked}
          className="size-4 accent-primary"
          aria-describedby={`${id}-hint`}
        />
        <Label htmlFor={id}>{TEMPLATE_FORM_STRINGS.isActive}</Label>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {TEMPLATE_FORM_STRINGS.isActiveHint}
      </p>
    </div>
  );
}

export interface ResetTemplateDialogProps {
  readonly address: TemplateRef;
  /** Whether the locale has its own row (a `version`): only that can be reset. */
  readonly hasOwnRow: boolean;
  /** The environment of the request (templates are shared by both; the dialog shows it as every dialog does). */
  readonly environment: StaffEnvironment;
  /** The key `ConfirmDialog` renders with its form; the reset itself takes none. */
  readonly idempotencyKey: string;
}

/** "Reset to default" and its confirmation (no reason: the contract's reset takes no body). */
export function ResetTemplateDialog({
  address,
  hasOwnRow,
  environment,
  idempotencyKey,
}: ResetTemplateDialogProps) {
  return (
    <div className="grid gap-1">
      <ConfirmDialog
        trigger={
          <Button type="button" variant="outline" disabled={!hasOwnRow}>
            {TEMPLATE_FORM_STRINGS.reset}
          </Button>
        }
        title={TEMPLATE_FORM_STRINGS.resetTitle(address.templateKey, address.locale)}
        summary={<p>{TEMPLATE_FORM_STRINGS.resetSummary(address.locale)}</p>}
        confirmLabel={TEMPLATE_FORM_STRINGS.reset}
        environment={environment}
        action={resetTemplate}
        idempotencyKey={idempotencyKey}
        askReason={false}
        fields={{
          [TEMPLATE_FIELDS.templateKey]: address.templateKey,
          [TEMPLATE_FIELDS.channel]: address.channel,
          [TEMPLATE_FIELDS.locale]: address.locale,
        }}
      />
      {hasOwnRow ? null : <p className="text-xs text-muted-foreground">{TEMPLATE_FORM_STRINGS.resetNone}</p>}
    </div>
  );
}
