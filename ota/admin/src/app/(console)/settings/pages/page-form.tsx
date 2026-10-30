"use client";

// The content pages' client side (OAD-015; routes.md §9, api-changes part 2 §2.4, OADR-0012 points 5 and 6): the form
// a page is created and changed with, its Markdown help, and the delete dialog. The pages are server components that
// read the API; this module never imports the SDK or the session code, and its components get plain values (a page as
// the API answered it, the storefront's languages), never a token.
//
// - **The form** (`PageForm`): a new page's address (`/p/<slug>`) and language, which are fixed from then on; the
//   kind, the title, the body in the Markdown subset (with a short help of the syntax), published, listed in the footer
//   and the footer order. It posts to pages/actions.ts, which validates it again (content-rules.ts) and shows its field
//   errors on the fields (`aria-describedby`). A new page carries the idempotency key the page rendered (`useActionKey`:
//   a double submit creates one page; a final refusal the API stored under the key brings a new one); a page's form
//   carries its id and the displayed version (`If-Match`).
// - **A refused body** (`422 UNPROCESSABLE` with `details.line`): the message is shown next to the line it names, in
//   the lines around it as they were sent (the line numbered and marked), with "Go to line N", which selects that line
//   in the body.
// - **Delete** (`DeletePageDialog`) is `ConfirmDialog` without a reason (the contract's `DELETE` takes none,
//   `askReason={false}`), with the displayed version.
//
// Every input has `autoComplete="off"`; nothing here asks for a card.
import { LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import {
  startTransition,
  useActionState,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { CheckboxField, SelectField, TextField } from "@/app/(console)/bookings/[bookingId]/patch-form";
import { ConfirmDialog, useActionKey } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ACTION_KEY_FIELD, INITIAL_ACTION_STATE, fieldError, type ActionState } from "@/lib/action-state";
import type { StaffEnvironment } from "@/lib/permissions";
import { cn } from "@/lib/utils";

import {
  MARKDOWN_HELP,
  MARKDOWN_REFUSED,
  PAGE_FIELDS,
  PAGE_KINDS,
  PAGE_LIMITS,
  PAGES_PATH,
  bodyLineOf,
  lineExcerpt,
  lineRange,
  normalizeLineBreaks,
  storefrontPathOf,
  type PageKind,
} from "../content-rules";
import { createPage, deletePage, updatePage } from "./actions";

export const PAGE_FORM_STRINGS = Object.freeze({
  sections: { address: "Address and language", content: "Content", storefront: "On the storefront" },
  slug: "Address",
  slugHint: `The page's address on the storefront, /p/<address>: lower-case letters and digits with single hyphens, at most ${PAGE_LIMITS.slug} characters. It cannot be changed later.`,
  locale: "Language",
  localeHint: "One of the storefront's languages. A translation is another page with the same address.",
  localeUnknown:
    "The storefront's languages could not be loaded: type the language code (such as en or fr-CA). It cannot be changed later.",
  kind: "Kind",
  kindHint: "The legal kinds are the pages the storefront settings' legal links point to.",
  title: "Title",
  titleHint: `The page's top heading and its browser title, at most ${PAGE_LIMITS.title} characters.`,
  body: "Body",
  bodyHint: `Markdown subset, at most ${PAGE_LIMITS.body.toLocaleString("en-GB")} characters. The help above lists what it allows.`,
  helpSummary: "Markdown help: what the body may use",
  helpSyntax: "You write",
  helpMeaning: "The storefront shows",
  helpImages: "Page images are on the Assets page.",
  excerptLabel: (line: number) => `The body around line ${line}, as it was sent`,
  goToLine: (line: number) => `Go to line ${line}`,
  isPublished: "Published on the storefront",
  isPublishedHint: "Unpublished, the page is a draft that only the console shows.",
  showInFooter: "Listed in the storefront footer",
  sortOrder: "Footer order",
  sortOrderHint: `Lower numbers come first in the footer and the lists (0 to ${PAGE_LIMITS.sortOrderMax}).`,
  create: "Create page",
  creating: "Creating…",
  save: "Save",
  saving: "Saving…",
  backToList: "All pages",
  requestId: (requestId: string) => `Request id ${requestId}`,
  delete: "Delete page",
  deleteTitle: (title: string) => `Delete the page ${title}?`,
  deleteSummary: (path: string, locale: string) =>
    `The page ${path} (${locale}) is deleted, and the storefront stops showing it within 5 minutes. A page whose address a legal link of the storefront settings names cannot be deleted: change the link first, or unpublish the page instead. The images it showed stay on the Assets page.`,
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";

/** The short help of the Markdown subset, collapsed above the body. */
export function MarkdownHelp() {
  return (
    <details className="rounded-md border px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">{PAGE_FORM_STRINGS.helpSummary}</summary>
      <table className="mt-2 w-full text-left text-sm">
        <thead>
          <tr>
            <th scope="col" className="py-1 pr-4 font-medium">
              {PAGE_FORM_STRINGS.helpSyntax}
            </th>
            <th scope="col" className="py-1 font-medium">
              {PAGE_FORM_STRINGS.helpMeaning}
            </th>
          </tr>
        </thead>
        <tbody>
          {MARKDOWN_HELP.map((entry) => (
            <tr key={entry.syntax} className="align-top">
              <td className="py-1 pr-4">
                <code className="whitespace-nowrap text-xs">{entry.syntax}</code>
              </td>
              <td className="py-1">{entry.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2">{MARKDOWN_REFUSED}</p>
      <p className="mt-1">
        <Link href="/settings/assets?kind=page_image" className={LINK_CLASS}>
          {PAGE_FORM_STRINGS.helpImages}
        </Link>
      </p>
    </details>
  );
}

/**
 * The body: a text area with its hint and, after a refusal, the message next to the line it names, in the lines
 * around it as they were sent, with "Go to line N".
 */
function BodyField({
  state,
  defaultValue,
  sentBody,
}: {
  readonly state: ActionState;
  readonly defaultValue: string;
  /** The body as the last submission sent it, which the refusal's line counts in. */
  readonly sentBody: string;
}) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const error = fieldError(state, PAGE_FIELDS.bodyMarkdown);
  const line = error === undefined ? undefined : bodyLineOf(state);
  const excerpt = line === undefined ? [] : lineExcerpt(sentBody, line);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  function goToLine(): void {
    const element = textarea.current;
    if (element === null || line === undefined) {
      return;
    }
    const range = lineRange(element.value, line);
    if (range === undefined) {
      return;
    }
    element.focus();
    element.setSelectionRange(range.start, range.end);
  }

  const message = (
    <p id={errorId} className="text-sm font-medium text-destructive">
      {error}
    </p>
  );
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{PAGE_FORM_STRINGS.body}</Label>
      <p id={hintId} className="text-xs text-muted-foreground">
        {PAGE_FORM_STRINGS.bodyHint}
      </p>
      <Textarea
        ref={textarea}
        id={id}
        name={PAGE_FIELDS.bodyMarkdown}
        rows={18}
        defaultValue={defaultValue}
        autoComplete="off"
        className="field-sizing-fixed font-mono text-sm"
        aria-describedby={error === undefined ? hintId : `${hintId} ${errorId}`}
        {...(error === undefined ? {} : { "aria-invalid": true })}
      />
      {error === undefined ? null : excerpt.length === 0 ? (
        message
      ) : (
        <div className="grid gap-2 rounded-md border border-destructive/40 p-3" data-body-error="">
          <ol aria-label={PAGE_FORM_STRINGS.excerptLabel(line ?? 0)} className="grid gap-0.5">
            {excerpt.map((row) => (
              <li
                key={row.number}
                data-line={row.number}
                {...(row.number === line ? { "aria-current": "true" as const } : {})}
                className={cn(
                  "grid grid-cols-[3rem_1fr] gap-x-3 border-l-2 px-1 py-0.5",
                  // A mark beside the line, not a tint under it: the message keeps its contrast on the page's
                  // background (the destructive colour on a destructive tint is below 4.5:1).
                  row.number === line ? "border-destructive font-semibold" : "border-transparent",
                )}
              >
                <span
                  className={cn(
                    "text-right font-mono text-xs tabular-nums",
                    row.number === line ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {row.number}
                </span>
                <code className="font-mono text-xs break-all whitespace-pre-wrap">
                  {row.text === "" ? "\u00a0" : row.text}
                </code>
                {row.number === line ? <div className="col-start-2">{message}</div> : null}
              </li>
            ))}
          </ol>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={goToLine}>
              {PAGE_FORM_STRINGS.goToLine(line ?? 0)}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A group of fields under a heading. */
function FormSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-4 rounded-md border p-4">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The values a form starts with: a page's, or a new page's documented defaults. */
export interface PageFormValues {
  readonly kind: PageKind;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly isPublished: boolean;
  readonly showInFooter: boolean;
  readonly sortOrder: number;
}

/** The defaults of a new page (StorefrontPageInput). */
export const NEW_PAGE_VALUES: PageFormValues = Object.freeze({
  kind: "content",
  title: "",
  bodyMarkdown: "",
  isPublished: false,
  showInFooter: false,
  sortOrder: PAGE_LIMITS.sortOrderDefault,
});

export type PageFormProps =
  | {
      readonly mode: "create";
      /** The idempotency key rendered with the page (`crypto.randomUUID()`, once per render). */
      readonly idempotencyKey: string;
      /** The storefront's languages, the default first; `undefined` when they could not be read. */
      readonly locales: readonly string[] | undefined;
      /** The language chosen at first: the storefront's default. */
      readonly defaultLocale: string;
    }
  | {
      readonly mode: "edit";
      readonly pageId: string;
      /** The page's `version`, the `If-Match` of the save. */
      readonly version: number;
      readonly values: PageFormValues;
    };

/** The form of a new page or of a page's own page. */
export function PageForm(props: PageFormProps) {
  const [state, dispatch, pending] = useActionState(
    props.mode === "create" ? createPage : updatePage,
    INITIAL_ACTION_STATE,
  );
  const actionKey = useActionKey(props.mode === "create" ? props.idempotencyKey : "", state);
  // The body as the last submission sent it: a refusal's line counts in it.
  const [sentBody, setSentBody] = useState("");
  const values = props.mode === "create" ? NEW_PAGE_VALUES : props.values;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const body = formData.get(PAGE_FIELDS.bodyMarkdown);
    setSentBody(typeof body === "string" ? normalizeLineBreaks(body) : "");
    startTransition(() => dispatch(formData));
  }

  return (
    <form noValidate onSubmit={submit} className="grid max-w-4xl gap-6">
      {props.mode === "create" ? (
        <input type="hidden" name={ACTION_KEY_FIELD} value={actionKey} />
      ) : (
        <>
          <input type="hidden" name={PAGE_FIELDS.pageId} value={props.pageId} />
          <input type="hidden" name={PAGE_FIELDS.version} value={String(props.version)} />
        </>
      )}
      {/* A saved page starts again from the saved values (its new version); a refused one keeps what was typed. */}
      <div key={props.mode === "edit" ? props.version : "new"} className="grid gap-6">
        {props.mode === "create" ? (
          <FormSection title={PAGE_FORM_STRINGS.sections.address}>
            <TextField
              name={PAGE_FIELDS.slug}
              label={PAGE_FORM_STRINGS.slug}
              hint={PAGE_FORM_STRINGS.slugHint}
              state={state}
              maxLength={PAGE_LIMITS.slug}
            />
            {props.locales === undefined ? (
              <TextField
                name={PAGE_FIELDS.locale}
                label={PAGE_FORM_STRINGS.locale}
                hint={PAGE_FORM_STRINGS.localeUnknown}
                state={state}
                defaultValue={props.defaultLocale}
              />
            ) : (
              <SelectField
                name={PAGE_FIELDS.locale}
                label={PAGE_FORM_STRINGS.locale}
                hint={PAGE_FORM_STRINGS.localeHint}
                state={state}
                choices={props.locales.map((locale) => ({ value: locale, label: locale }))}
                defaultValue={props.defaultLocale}
              />
            )}
          </FormSection>
        ) : null}
        <FormSection title={PAGE_FORM_STRINGS.sections.content}>
          <SelectField
            name={PAGE_FIELDS.kind}
            label={PAGE_FORM_STRINGS.kind}
            hint={PAGE_FORM_STRINGS.kindHint}
            state={state}
            choices={PAGE_KINDS}
            defaultValue={values.kind}
          />
          <TextField
            name={PAGE_FIELDS.title}
            label={PAGE_FORM_STRINGS.title}
            hint={PAGE_FORM_STRINGS.titleHint}
            state={state}
            defaultValue={values.title}
            maxLength={PAGE_LIMITS.title}
          />
          <MarkdownHelp />
          <BodyField state={state} defaultValue={values.bodyMarkdown} sentBody={sentBody} />
        </FormSection>
        <FormSection title={PAGE_FORM_STRINGS.sections.storefront}>
          <CheckboxField
            name={PAGE_FIELDS.isPublished}
            label={PAGE_FORM_STRINGS.isPublished}
            hint={PAGE_FORM_STRINGS.isPublishedHint}
            state={state}
            defaultChecked={values.isPublished}
          />
          <CheckboxField
            name={PAGE_FIELDS.showInFooter}
            label={PAGE_FORM_STRINGS.showInFooter}
            state={state}
            defaultChecked={values.showInFooter}
          />
          <TextField
            name={PAGE_FIELDS.sortOrder}
            label={PAGE_FORM_STRINGS.sortOrder}
            hint={PAGE_FORM_STRINGS.sortOrderHint}
            state={state}
            inputMode="numeric"
            defaultValue={String(values.sortOrder)}
          />
        </FormSection>
      </div>

      <div className="grid gap-3">
        {state.message === undefined ? null : (
          <div
            role={state.ok === true ? "status" : "alert"}
            className={cn(
              "grid gap-1 rounded-md border px-3 py-2 text-sm",
              state.ok === true ? "text-foreground" : "border-destructive/40",
            )}
          >
            <p className={state.ok === true ? "" : "font-medium text-destructive"}>{state.message}</p>
            {state.requestId === undefined ? null : (
              <p className="text-muted-foreground">{PAGE_FORM_STRINGS.requestId(state.requestId)}</p>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : null}
            {props.mode === "create"
              ? pending
                ? PAGE_FORM_STRINGS.creating
                : PAGE_FORM_STRINGS.create
              : pending
                ? PAGE_FORM_STRINGS.saving
                : PAGE_FORM_STRINGS.save}
          </Button>
          <Link href={PAGES_PATH} className={LINK_CLASS}>
            {PAGE_FORM_STRINGS.backToList}
          </Link>
        </div>
      </div>
    </form>
  );
}

export interface DeletePageDialogProps {
  readonly pageId: string;
  readonly title: string;
  readonly slug: string;
  readonly locale: string;
  /** The page's `version`, the `If-Match` of the delete. */
  readonly version: number;
  /** The environment of the request (pages are shared by both; the dialog shows it as every dialog does). */
  readonly environment: StaffEnvironment;
  /** The key `ConfirmDialog` renders with its form; the delete itself takes none. */
  readonly idempotencyKey: string;
}

/** "Delete page" and its confirmation (no reason: the contract's `DELETE` takes none). */
export function DeletePageDialog({
  pageId,
  title,
  slug,
  locale,
  version,
  environment,
  idempotencyKey,
}: DeletePageDialogProps) {
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline">
          {PAGE_FORM_STRINGS.delete}
        </Button>
      }
      title={PAGE_FORM_STRINGS.deleteTitle(title)}
      summary={<p>{PAGE_FORM_STRINGS.deleteSummary(storefrontPathOf(slug), locale)}</p>}
      confirmLabel={PAGE_FORM_STRINGS.delete}
      environment={environment}
      action={deletePage}
      idempotencyKey={idempotencyKey}
      askReason={false}
      fields={{ [PAGE_FIELDS.pageId]: pageId, [PAGE_FIELDS.version]: String(version) }}
    />
  );
}
