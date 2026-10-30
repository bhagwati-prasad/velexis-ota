// `/settings/templates` (README §5, routes.md §9, OAD-015): the e-mail templates of the OTA, through
// `console.settings.templates.list` (`settings:read`, every role): the **effective** template of every key the API
// knows, for every language of the storefront, by key, then language (not paginated). Templates are shared by the test
// and live environments.
//
// Each row: the e-mail (its words and key, a link to its editor `/settings/templates/<key>/email/<locale>`), the
// language, where the template comes from (the OTA's own, `Customised`; the default copy provisioning saved for the
// language, which is not customised but has a version; the language's template it inherits, `Inherited from en`; or
// the code default), whether it is sent (an inactive own template leaves the e-mails to the language's template or the
// default) and the last change in the OTA's time zone (an inherited template has no row, so no change, of its own: the
// row points to its language's template, whose row shows it). The rows are grouped by who receives the e-mails:
// customer accounts, bookings (the traveller) and staff alerts.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this
// list, an ended session to the portal (`redirectOnSessionError`), and every other API error renders the console's
// message for its code with the request id and "Try again".
import type { NotificationTemplate, StaffPermission } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";

import { formatInstant } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import {
  SETTINGS_READ,
  SETTINGS_WRITE,
  TEMPLATES_PATH,
  TEMPLATE_AUDIENCES,
  templateAudienceOf,
  templateKeyLabel,
  templatePath,
  templateRefOf,
  templateSourceOf,
  type TemplateAudience,
} from "../content-rules";
import { TemplateSourceBadge } from "./template-form";

export const metadata: Metadata = { title: "E-mail templates" };

const PAGE_STRINGS = Object.freeze({
  title: "E-mail templates",
  intro:
    "The e-mails the OTA sends, per language. Each starts as the Velexis default; change its subject and bodies to make it your own, preview it with sample data, or reset it to the default. They are shared by the test and live environments, and the next e-mail uses a saved template.",
  readOnly:
    "Read only: changing templates needs the permission settings:write. You can open and preview each one.",
  columns: {
    email: "E-mail",
    language: "Language",
    source: "Template",
    sending: "Sending",
    updated: "Last changed",
  },
  active: "Sent",
  inactive: "Not sent: the language's template or the default is used",
  never: "Never changed",
  // An inherited template has no row of its own, so no last change of its own: the language's row shows it.
  inheritedChange: (language: string) => `See the ${language} template`,
  empty: "The OTA has no languages with templates yet.",
  unavailableTitle: "The templates could not be loaded",
  forbiddenTitle: "You cannot open the e-mail templates",
  retry: "Try again",
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const READ_PERMISSION: StaffPermission = SETTINGS_READ;
const WRITE_PERMISSION: StaffPermission = SETTINGS_WRITE;
/** The order of the groups. */
const AUDIENCES: readonly TemplateAudience[] = ["customers", "travellers", "staff"];

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

/** The templates of one group, by key, then language. */
function TemplatesTable({
  audience,
  templates,
  timeZone,
}: {
  readonly audience: TemplateAudience;
  readonly templates: readonly NotificationTemplate[];
  readonly timeZone: string;
}) {
  const columns = Object.values(PAGE_STRINGS.columns);
  const headingId = `templates-${audience}`;
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <h2 id={headingId} className="text-lg font-semibold">
        {TEMPLATE_AUDIENCES[audience]}
      </h2>
      <Table>
        <TableCaption className="sr-only">{TEMPLATE_AUDIENCES[audience]}</TableCaption>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column} scope="col">
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {templates.map((template) => {
            const ref = templateRefOf(template.key, template.channel, template.locale);
            const label = templateKeyLabel(template.key);
            return (
              <TableRow
                key={`${template.key}/${template.channel}/${template.locale}`}
                data-template={template.key}
              >
                <TableCell>
                  <div className="grid gap-0.5">
                    {ref === undefined ? (
                      <span className="font-medium">{label}</span>
                    ) : (
                      <Link
                        href={templatePath(ref)}
                        className="font-medium text-primary underline underline-offset-4"
                        aria-label={`${label} (${template.locale})`}
                      >
                        {label}
                      </Link>
                    )}
                    <code className="text-xs text-muted-foreground">{template.key}</code>
                  </div>
                </TableCell>
                <TableCell>{template.locale}</TableCell>
                <TableCell>
                  <TemplateSourceBadge
                    source={templateSourceOf(template)}
                    inheritedFrom={template.inheritedFrom}
                  />
                </TableCell>
                <TableCell>{template.isActive ? PAGE_STRINGS.active : PAGE_STRINGS.inactive}</TableCell>
                <TableCell>
                  {template.updatedAt !== null
                    ? formatInstant(template.updatedAt, timeZone)
                    : template.inheritedFrom !== null
                      ? PAGE_STRINGS.inheritedChange(template.inheritedFrom)
                      : PAGE_STRINGS.never}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

export default async function TemplatesPage() {
  const here = TEMPLATES_PATH;

  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, here);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }
  const { staff } = request;

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

  let templates: NotificationTemplate[];
  try {
    templates = (await request.console.settings.templates.list()).data;
  } catch (error) {
    const failure = await apiFailure(error, here);
    return (
      <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
        {/* The same URL again: the list is read anew. */}
        <a href={here} className={LINK_CLASS}>
          {PAGE_STRINGS.retry}
        </a>
      </ErrorState>
    );
  }

  const timeZone = staff.tenant.timeZone;
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
        <p className="max-w-3xl text-muted-foreground">{PAGE_STRINGS.intro}</p>
        {can(staff, WRITE_PERMISSION) ? null : (
          <p className="text-sm text-muted-foreground">{PAGE_STRINGS.readOnly}</p>
        )}
      </div>
      {templates.length === 0 ? (
        <p className="text-muted-foreground">{PAGE_STRINGS.empty}</p>
      ) : (
        AUDIENCES.map((audience) => {
          const group = templates.filter((template) => templateAudienceOf(template.key) === audience);
          return group.length === 0 ? null : (
            <TemplatesTable key={audience} audience={audience} templates={group} timeZone={timeZone} />
          );
        })
      )}
    </div>
  );
}
