// `/settings/templates/[key]/[channel]/[locale]` (README §5, routes.md §9, OAD-015): one e-mail template, through
// `console.settings.templates.get` (`settings:read`, every role): the effective template of the key, channel (`email`)
// and locale, the one e-mails in that locale use (the locale's own row, its language's row, or the code default), with
// the variables its key allows.
//
// - The heading says where the template comes from: the OTA's own (`customised`), the default copy provisioning saved
//   for the locale (not customised, but a row with a version, so a save sends `If-Match`), its language's template
//   (`inheritedFrom`: a save creates the locale's own row, without `If-Match`) or the code default; and whether it is
//   sent.
// - The editor (template-form.tsx): the subject, the HTML body and the text body with the variable allow-list and a
//   short help of the template language beside them; "Save" (`console.settings.templates.put`, owners and admins) with
//   `ifMatch` = the version shown here when there is one; "Preview" (`console.settings.templates.preview`, every role)
//   renders the draft with sample data in a sandboxed frame without scripts (preview-frame.tsx); `422 TEMPLATE_INVALID`
//   is listed per part and line. "Reset to default" (`console.settings.templates.reset`, owners and admins) deletes the
//   locale's own row; the page then shows what serves the locale.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this
// page, an ended session to the portal (`redirectOnSessionError`), an address the API would refuse (never sent) and
// its `400 VALIDATION_FAILED` render the page's own "not found" state inside the shell, and every other API error
// renders the console's message for its code with the request id and "Try again".
import type { NotificationTemplate, StaffPermission } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";

import { formatInstant } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { Badge } from "@/components/ui/badge";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import {
  SETTINGS_READ,
  SETTINGS_WRITE,
  TEMPLATES_PATH,
  templateKeyLabel,
  templatePath,
  templateRefOf,
  templateSourceOf,
  type TemplateRef,
} from "../../../../content-rules";
import { ResetTemplateDialog, TemplateEditor, TemplateSourceBadge } from "../../../template-form";

export const metadata: Metadata = { title: "E-mail template" };

const PAGE_STRINGS = Object.freeze({
  back: "All templates",
  retry: "Try again",
  unavailableTitle: "The template could not be loaded",
  forbiddenTitle: "You cannot open the e-mail templates",
  notFoundTitle: "Template not found",
  notFound: "There is no e-mail template at this address. The link may be wrong.",
  sources: {
    customised: (locale: string) => `The OTA's own template for ${locale}.`,
    seeded: (locale: string) =>
      `The default template, saved for ${locale} when the OTA was set up. Saving a change makes it the OTA's own.`,
    inherited: (locale: string, language: string) =>
      `${locale} has no template of its own: its e-mails use the ${language} template shown here. Saving creates a template for ${locale}; the ${language} one stays.`,
    default: (locale: string) =>
      `The default template: ${locale} has no template of its own. Saving creates one.`,
  },
  version: (version: number, updated: string) => `Version ${version}, last changed ${updated}.`,
  inactive: (locale: string) =>
    `Not sent: e-mails in ${locale} use the template of its language or the default until this one is activated.`,
  shared: "Templates are shared by the test and live environments; the next e-mail uses a saved template.",
  variablesTitle: "Variables",
  variablesIntro:
    "What this e-mail's templates may use, written {{name}}. A name with [] is an item of a list: use it inside {{#each …}}.",
  noVariables: "This e-mail has no variables.",
  syntaxSummary: "Template language: what the parts may use",
  syntax: [
    ["{{booking.reference}}", "A variable of the list above; HTML-escaped in the HTML body."],
    [
      "{{#if booking.contact}} … {{else}} … {{/if}}",
      "Shown only when the variable has a value ({{#unless}} the opposite).",
    ],
    [
      "{{#each booking.segments}} {{origin}} {{/each}}",
      "Repeats for each item of a list; {{../brand.name}} reaches the outer level.",
    ],
    ["{{! a comment }}", "Not shown in the e-mail."],
  ] as const,
  syntaxRefused:
    "Not allowed: triple braces, helpers, partials, other variables than the list's, and values written in the template's tags.",
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const READ_PERMISSION: StaffPermission = SETTINGS_READ;
const WRITE_PERMISSION: StaffPermission = SETTINGS_WRITE;

/**
 * An error of the OTA API as the page's state: `TOKEN_EXPIRED` and an ended session redirect (Next.js's redirect is
 * thrown on), anything that is not an API error is thrown for the error boundary, and an API error is returned.
 */
async function apiFailure(error: unknown, here: string): Promise<VelexisErrorLike> {
  if (!isVelexisErrorLike(error)) {
    throw error;
  }
  try {
    await redirectOnSessionError(error, here);
  } catch (thrown) {
    // `redirectOnSessionError` throws the same error back when it is not about the session.
    if (thrown !== error) {
      throw thrown;
    }
  }
  return error;
}

/** "Template not found", inside the shell. */
function NotFound() {
  return (
    <ErrorState title={PAGE_STRINGS.notFoundTitle} description={{ message: PAGE_STRINGS.notFound }}>
      <Link href={TEMPLATES_PATH} className={LINK_CLASS}>
        {PAGE_STRINGS.back}
      </Link>
    </ErrorState>
  );
}

/** Where the template comes from, in words. */
function sourceText(template: NotificationTemplate): string {
  const source = templateSourceOf(template);
  if (source === "inherited") {
    return PAGE_STRINGS.sources.inherited(template.locale, template.inheritedFrom ?? "");
  }
  return PAGE_STRINGS.sources[source](template.locale);
}

/** The key's variables and a short help of the template language. */
function Variables({ template }: { readonly template: NotificationTemplate }) {
  return (
    <section aria-labelledby="template-variables" className="grid max-w-5xl gap-3 rounded-md border p-4">
      <h2 id="template-variables" className="text-base font-semibold">
        {PAGE_STRINGS.variablesTitle}
      </h2>
      <p className="text-sm text-muted-foreground">{PAGE_STRINGS.variablesIntro}</p>
      {template.variables.length === 0 ? (
        <p className="text-sm">{PAGE_STRINGS.noVariables}</p>
      ) : (
        <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
          {template.variables.map((variable) => (
            <div key={variable.name} className="contents">
              <dt>
                <code className="text-xs">{`{{${variable.name}}}`}</code>
              </dt>
              <dd>{variable.description}</dd>
            </div>
          ))}
        </dl>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">{PAGE_STRINGS.syntaxSummary}</summary>
        <dl className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-[auto_1fr]">
          {PAGE_STRINGS.syntax.map(([syntax, meaning]) => (
            <div key={syntax} className="contents">
              <dt>
                <code className="text-xs">{syntax}</code>
              </dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2">{PAGE_STRINGS.syntaxRefused}</p>
      </details>
    </section>
  );
}

export default async function TemplatePage({
  params,
}: Readonly<{ params: Promise<{ key: string; channel: string; locale: string }> }>) {
  const { key, channel, locale } = await params;
  const ref: TemplateRef | undefined = templateRefOf(key, channel, locale);
  // Where an expired session comes back to: this template (an address that is not one is never put into the URL).
  const here = ref === undefined ? TEMPLATES_PATH : templatePath(ref);

  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, here);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }
  const { staff, environment } = request;

  if (!can(staff, READ_PERMISSION)) {
    return (
      <ErrorState
        title={PAGE_STRINGS.forbiddenTitle}
        description={{
          message: errorMessage({
            code: "FORBIDDEN",
            status: 403,
            requestId: null,
            fieldErrors: [],
            retryable: false,
            details: { requiredPermission: READ_PERMISSION },
          }),
        }}
      />
    );
  }
  if (ref === undefined) {
    // The API would refuse it (`400 VALIDATION_FAILED`): no request.
    return <NotFound />;
  }

  let template: NotificationTemplate;
  try {
    template = await request.console.settings.templates.get(ref);
  } catch (error) {
    const failure = await apiFailure(error, here);
    if (failure.code === "VALIDATION_FAILED" || failure.code === "NOT_FOUND") {
      // A key this API does not know.
      return <NotFound />;
    }
    return (
      <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
        <a href={here} className={LINK_CLASS}>
          {PAGE_STRINGS.retry}
        </a>
        <Link href={TEMPLATES_PATH} className={LINK_CLASS}>
          {PAGE_STRINGS.back}
        </Link>
      </ErrorState>
    );
  }

  const canWrite = can(staff, WRITE_PERMISSION);
  const timeZone = staff.tenant.timeZone;
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Link href={TEMPLATES_PATH} className={LINK_CLASS}>
          {PAGE_STRINGS.back}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{templateKeyLabel(template.key)}</h1>
          <Badge variant="outline">{template.locale}</Badge>
          <TemplateSourceBadge source={templateSourceOf(template)} inheritedFrom={template.inheritedFrom} />
        </div>
        <p className="text-sm">
          <code className="text-xs">{template.key}</code>
        </p>
        <p className="max-w-3xl text-sm">{sourceText(template)}</p>
        {template.version === null || template.updatedAt === null ? null : (
          <p className="text-sm text-muted-foreground">
            {PAGE_STRINGS.version(template.version, formatInstant(template.updatedAt, timeZone))}
          </p>
        )}
        {template.isActive ? null : (
          <p className="max-w-3xl text-sm font-medium">{PAGE_STRINGS.inactive(template.locale)}</p>
        )}
        <p className="max-w-3xl text-sm text-muted-foreground">{PAGE_STRINGS.shared}</p>
      </div>
      <Variables template={template} />
      <TemplateEditor
        address={ref}
        version={template.version}
        values={{
          subject: template.subject ?? "",
          bodyHtml: template.bodyHtml ?? "",
          bodyText: template.bodyText,
          isActive: template.isActive,
        }}
        canWrite={canWrite}
        formKey={[
          template.version ?? "none",
          template.updatedAt ?? "none",
          template.inheritedFrom ?? "",
          String(template.customised),
        ].join("|")}
      />
      {canWrite ? (
        <ResetTemplateDialog
          address={ref}
          hasOwnRow={template.version !== null}
          environment={environment}
          idempotencyKey={crypto.randomUUID()}
        />
      ) : null}
    </div>
  );
}
