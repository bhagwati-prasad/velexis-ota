"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { otaPath } from "@/lib/roles";
import {
  AMADEUS_LIVE_STRINGS,
  AMADEUS_SETTINGS_STRINGS,
  ERROR_MESSAGES,
  OWN_CREDENTIALS_STRINGS,
} from "@/lib/strings";
import { ifMatchOf, isTenantId } from "@/lib/tenant";

/**
 * The server actions of the Amadeus page (README §2 `/otas/[tenantId]/amadeus`; flows/amadeus-connection.md §C to §E;
 * PF-51 to PF-53): the connection settings (PFE-018, below), and live access, the OTA's own credentials and the
 * verification they wait for (PFE-023, at the end of the module).
 *
 * `saveAmadeusSettings` checks the settings form with Zod (the shapes of the platform document's
 * `UpdateAmadeusConnectionRequest`), then calls `updateAmadeusConnection` (`PATCH
 * /v1/tenants/{tenantId}/amadeus-connections/{environment}`) with the connection's version the form was rendered with in
 * `If-Match`, so a change someone else made in the meantime answers `412 PRECONDITION_FAILED` instead of being
 * overwritten. The form sends every setting: the office defaults it has a value for, the ticketing defaults as a whole
 * object and the monitored queues as a whole list, as the API replaces them; the API writes only what differs. Whether
 * an office is one of the connection's is the API's check (the form offers no other). Owners and admins may call it;
 * the API refuses other roles with `403` all the same. It returns the portal's own text only, never the API's.
 */

type Schemas = components["schemas"];
type Environment = Schemas["Environment"];
type AmadeusConnection = Schemas["AmadeusConnection"];
type UpdateAmadeusConnectionRequest = Schemas["UpdateAmadeusConnectionRequest"];
type TicketingDefaults = Schemas["AmadeusTicketingDefaults"];
type AutomatedProcess = Schemas["AmadeusAutomatedProcessDefault"];
type MonitoredQueue = Schemas["AmadeusMonitoredQueue"];
type AgreementOption = NonNullable<TicketingDefaults["ticketingAgreement"]>["option"];
type AutomatedCode = AutomatedProcess["code"];

/** One automated process of the form, as typed (`AmadeusAutomatedProcessDefault`; the delay in days, no `D`). */
export interface AutomatedProcessValues {
  readonly code: string;
  readonly queueNumber: string;
  readonly queueCategory: string;
  /** Empty: the process names no office. */
  readonly officeId: string;
  /** Days, without the `D` of the API. */
  readonly delay: string;
  readonly text: string;
}

/** One monitored queue of the form, as typed (`AmadeusMonitoredQueue`). */
export interface MonitoredQueueValues {
  readonly officeId: string;
  readonly queueId: string;
  readonly category: string;
}

/** The values of the settings form, as typed. An empty office, agreement or issue keeps or leaves the value unset. */
export interface AmadeusSettingsValues {
  readonly defaultOfficeId: string;
  readonly queuingOfficeId: string;
  readonly ownerOfficeId: string;
  /** A `ticketingAgreement.option`, or empty for none. */
  readonly agreementOption: string;
  /** The `ticketingAgreement.delay` in days, without the `D`; only the delayed options send it. */
  readonly agreementDelay: string;
  /** `"true"`, `"false"`, or empty for not set. */
  readonly issue: string;
  readonly automatedProcess: readonly AutomatedProcessValues[];
  readonly monitoredQueues: readonly MonitoredQueueValues[];
}

/**
 * Where a problem of the form shows: a field (`defaultOfficeId`, `agreementDelay`, …), a field of a row
 * (`automatedProcess.<index>.<field>`, `monitoredQueues.<index>.<field>`, the index in the order sent) or a whole list
 * (`automatedProcess`, `monitoredQueues`).
 */
export type SettingsErrorKey = string;

/** What the form shows after a submission. */
export interface AmadeusSettingsState {
  readonly status: "idle" | "saved" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  /** The connection version the next submission sends in `If-Match` (the saved one after a success). */
  readonly version: number;
  /** The connection the form shows: the page's before a submission, the API's answer after a save. */
  readonly connection?: AmadeusConnection;
  /** What was sent, after a failure: the form shows it again. */
  readonly values?: AmadeusSettingsValues;
  /** Messages per field, row field or list, in the portal's own words. */
  readonly fieldErrors: Readonly<Record<SettingsErrorKey, string>>;
  /** A problem that belongs to no field (stale version, OTA not active, rate limit, API unavailable). */
  readonly message?: string;
  /** The page is out of date: the form offers "Reload the page" (a stale version, a lost role or connection). */
  readonly reload?: true;
}

const PROBLEMS = AMADEUS_SETTINGS_STRINGS.problems;

/** `AmadeusOfficeId` of the platform document. */
const OFFICE_ID = /^[A-Z0-9]{9}$/;
/** A count of days or a queue number or category of an automated process (`^[0-9]{1,3}$`, `^[0-9]{1,3}D$`). */
const UP_TO_THREE_DIGITS = /^[0-9]{1,3}$/;
/** `AmadeusMonitoredQueue`: `queueId` 0–99, `category` 0–254; `monitoredQueues` at most 20. */
const QUEUE_ID_MAX = 99;
const CATEGORY_MAX = 254;
const MONITORED_QUEUES_MAX = 20;
/** `AmadeusAutomatedProcessDefault.text`: at most 200 characters (code points, as JSON Schema counts them). */
const TEXT_MAX = 200;
/** A connection version as the form carries it (`AmadeusConnection.version`, at least 1). */
const VERSION = /^[1-9][0-9]{0,14}$/;

const ENVIRONMENTS: readonly Environment[] = ["test", "live"];
const AGREEMENT_OPTIONS: readonly AgreementOption[] = ["CONFIRM", "DELAY_TO_QUEUE", "DELAY_TO_CANCEL"];
/** The agreements whose automatic step waits: only they send a delay (`settings-form.tsx` enables the field for them). */
const DELAYED_AGREEMENTS: readonly string[] = ["DELAY_TO_QUEUE", "DELAY_TO_CANCEL"];
const AUTOMATED_CODES: readonly AutomatedCode[] = ["IMMEDIATE", "DELAYED", "ERROR"];

function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

function isAgreementOption(value: string): value is AgreementOption {
  return (AGREEMENT_OPTIONS as readonly string[]).includes(value);
}

function isAutomatedCode(value: string): value is AutomatedCode {
  return (AUTOMATED_CODES as readonly string[]).includes(value);
}

/** A count written with up to three digits, without its leading zeros (`"007"` → `"7"`). */
function digits(value: string): string {
  return String(Number(value));
}

/** The length of a text as the API's JSON Schema counts it: Unicode code points. */
function codePoints(value: string): number {
  return [...value].length;
}

/** An office of a select: empty (none chosen) or an office id. */
const OPTIONAL_OFFICE = z.string().refine((value) => value === "" || OFFICE_ID.test(value), PROBLEMS.office);

/** Up to three digits, or empty. */
const optionalDigits = (message: string) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || UP_TO_THREE_DIGITS.test(value), message);

/** A whole number from 0 to `max`, written with up to three digits. */
const boundedNumber = (max: number, message: string) =>
  z
    .string()
    .trim()
    .refine((value) => UP_TO_THREE_DIGITS.test(value) && Number(value) <= max, message);

const AUTOMATED_PROCESS = z.object({
  code: z.string().refine(isAutomatedCode, PROBLEMS.automatedCode),
  queueNumber: optionalDigits(PROBLEMS.queueNumber),
  queueCategory: optionalDigits(PROBLEMS.queueCategory),
  officeId: OPTIONAL_OFFICE,
  delay: optionalDigits(PROBLEMS.delay),
  text: z
    .string()
    .trim()
    .refine((value) => codePoints(value) <= TEXT_MAX, PROBLEMS.text),
});

const MONITORED_QUEUE = z.object({
  officeId: z.string().refine((value) => OFFICE_ID.test(value), PROBLEMS.office),
  queueId: boundedNumber(QUEUE_ID_MAX, PROBLEMS.monitoredQueueId),
  category: boundedNumber(CATEGORY_MAX, PROBLEMS.monitoredCategory),
});

/** The form, checked; the problems' paths are the error keys (`monitoredQueues.1.queueId`). */
const SETTINGS_FORM = z
  .object({
    defaultOfficeId: OPTIONAL_OFFICE,
    queuingOfficeId: OPTIONAL_OFFICE,
    ownerOfficeId: OPTIONAL_OFFICE,
    agreementOption: z
      .string()
      .refine((value) => value === "" || isAgreementOption(value), PROBLEMS.agreementOption),
    agreementDelay: z.string().trim(),
    issue: z
      .string()
      .refine((value) => value === "" || value === "true" || value === "false", PROBLEMS.issue),
    // The document sets no `maxItems` for `automatedProcess`, so neither does the form (Next.js caps the body at 1 MB).
    automatedProcess: z.array(AUTOMATED_PROCESS),
    // `maxItems: 20` of the document. Zod checks the bound before any row, so an oversized list is refused with this
    // one message: its rows and the form's rules below (`superRefine`) are not checked then.
    monitoredQueues: z.array(MONITORED_QUEUE).max(MONITORED_QUEUES_MAX, PROBLEMS.tooManyQueues),
  })
  .superRefine((form, context) => {
    if (
      DELAYED_AGREEMENTS.includes(form.agreementOption) &&
      !(form.agreementDelay === "" || UP_TO_THREE_DIGITS.test(form.agreementDelay))
    ) {
      context.addIssue({ code: "custom", path: ["agreementDelay"], message: PROBLEMS.delay });
    }
    // Each queue at most once (`uniqueItems`): the same office, number and category twice is refused at the later one.
    const seen = new Set<string>();
    form.monitoredQueues.forEach((queue, index) => {
      if (
        !OFFICE_ID.test(queue.officeId) ||
        !UP_TO_THREE_DIGITS.test(queue.queueId) ||
        !UP_TO_THREE_DIGITS.test(queue.category)
      ) {
        return;
      }
      const identity = `${queue.officeId}:${Number(queue.queueId)}:${Number(queue.category)}`;
      if (seen.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["monitoredQueues", index, "queueId"],
          message: PROBLEMS.duplicate,
        });
      }
      seen.add(identity);
    });
  });

type SettingsForm = z.infer<typeof SETTINGS_FORM>;

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Every value of a repeated field, in form order; a file reads as empty. */
function texts(formData: FormData, name: string): string[] {
  return formData.getAll(name).map((value) => (typeof value === "string" ? value : ""));
}

/**
 * The rows of repeated fields: one row per position, each field from the list of its name. `undefined` when the lists
 * differ in length (a forged or broken form: the rows cannot be told apart).
 */
function rowsOf<Field extends string>(
  formData: FormData,
  names: Readonly<Record<Field, string>>,
): Record<Field, string>[] | undefined {
  const fields = Object.keys(names) as Field[];
  const columns = fields.map((field) => texts(formData, names[field]));
  const length = columns[0]?.length ?? 0;
  if (columns.some((column) => column.length !== length)) {
    return undefined;
  }
  return Array.from({ length }, (_, index) => {
    const row = {} as Record<Field, string>;
    fields.forEach((field, position) => {
      row[field] = columns[position]?.[index] ?? "";
    });
    return row;
  });
}

/** The names of the form's fields (README §2 `/amadeus`); the rows repeat theirs once per row. */
const AUTOMATED_FIELDS = {
  code: "automatedCode",
  queueNumber: "automatedQueueNumber",
  queueCategory: "automatedQueueCategory",
  officeId: "automatedOfficeId",
  delay: "automatedDelay",
  text: "automatedText",
} as const;

const QUEUE_FIELDS = {
  officeId: "queueOfficeId",
  queueId: "queueId",
  category: "queueCategory",
} as const;

/** The form's values as sent, or `undefined` when its rows cannot be read. */
function valuesFrom(formData: FormData): AmadeusSettingsValues | undefined {
  const automatedProcess = rowsOf(formData, AUTOMATED_FIELDS);
  const monitoredQueues = rowsOf(formData, QUEUE_FIELDS);
  if (automatedProcess === undefined || monitoredQueues === undefined) {
    return undefined;
  }
  return {
    defaultOfficeId: text(formData, "defaultOfficeId"),
    queuingOfficeId: text(formData, "queuingOfficeId"),
    ownerOfficeId: text(formData, "ownerOfficeId"),
    agreementOption: text(formData, "agreementOption"),
    agreementDelay: text(formData, "agreementDelay"),
    issue: text(formData, "issue"),
    automatedProcess,
    monitoredQueues,
  };
}

/** One automated process of the checked form, as the API takes it: empty fields left out. */
function automatedProcessOf(row: SettingsForm["automatedProcess"][number]): AutomatedProcess {
  const queue = {
    ...(row.queueNumber === "" ? {} : { number: digits(row.queueNumber) }),
    ...(row.queueCategory === "" ? {} : { category: digits(row.queueCategory) }),
  };
  return {
    code: row.code as AutomatedCode,
    ...(Object.keys(queue).length === 0 ? {} : { queue }),
    ...(row.officeId === "" ? {} : { officeId: row.officeId }),
    ...(row.delay === "" ? {} : { delay: `${digits(row.delay)}D` }),
    ...(row.text === "" ? {} : { text: row.text }),
  };
}

/** The ticketing defaults of the checked form, as a whole object (`{}` when nothing is set). */
function ticketingDefaultsOf(form: SettingsForm): TicketingDefaults {
  const option = form.agreementOption;
  const delayed = DELAYED_AGREEMENTS.includes(option) && form.agreementDelay !== "";
  return {
    ...(isAgreementOption(option)
      ? { ticketingAgreement: { option, ...(delayed ? { delay: `${digits(form.agreementDelay)}D` } : {}) } }
      : {}),
    ...(form.automatedProcess.length === 0
      ? {}
      : { automatedProcess: form.automatedProcess.map(automatedProcessOf) }),
    ...(form.issue === "" ? {} : { issue: form.issue === "true" }),
  };
}

/** The request of the checked form: the offices chosen, the ticketing defaults and the monitored queues. */
function requestOf(form: SettingsForm): UpdateAmadeusConnectionRequest {
  const monitoredQueues: MonitoredQueue[] = form.monitoredQueues.map((queue) => ({
    officeId: queue.officeId,
    queueId: Number(queue.queueId),
    category: Number(queue.category),
  }));
  return {
    ...(form.defaultOfficeId === "" ? {} : { defaultOfficeId: form.defaultOfficeId }),
    ...(form.queuingOfficeId === "" ? {} : { queuingOfficeId: form.queuingOfficeId }),
    ...(form.ownerOfficeId === "" ? {} : { ownerOfficeId: form.ownerOfficeId }),
    ticketingDefaults: ticketingDefaultsOf(form),
    monitoredQueues,
  };
}

/** The first message for each key of the form's problems. */
function problemsOf(error: z.ZodError): Record<SettingsErrorKey, string> {
  const problems: Record<SettingsErrorKey, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    problems[key] ??= issue.message;
  }
  return problems;
}

/** The field of a form row each field of an automated process in the API's body maps to. */
const API_AUTOMATED_FIELDS: Readonly<Record<string, keyof AutomatedProcessValues>> = {
  code: "code",
  "queue/number": "queueNumber",
  "queue/category": "queueCategory",
  officeId: "officeId",
  delay: "delay",
  text: "text",
};

/** The portal's message for each field of an automated process. */
const AUTOMATED_MESSAGES: Readonly<Record<keyof AutomatedProcessValues, string>> = {
  code: PROBLEMS.automatedCode,
  queueNumber: PROBLEMS.queueNumber,
  queueCategory: PROBLEMS.queueCategory,
  officeId: PROBLEMS.office,
  delay: PROBLEMS.delay,
  text: PROBLEMS.text,
};

const QUEUE_MESSAGES: Readonly<Record<keyof MonitoredQueueValues, string>> = {
  officeId: PROBLEMS.office,
  queueId: PROBLEMS.monitoredQueueId,
  category: PROBLEMS.monitoredCategory,
};

/** The form field and message of each JSON pointer of the API that is not inside a list. */
const API_FIELDS: Readonly<Record<string, readonly [SettingsErrorKey, string]>> = {
  "/defaultOfficeId": ["defaultOfficeId", PROBLEMS.office],
  "/queuingOfficeId": ["queuingOfficeId", PROBLEMS.office],
  "/ownerOfficeId": ["ownerOfficeId", PROBLEMS.office],
  "/ticketingDefaults/ticketingAgreement": ["agreementOption", PROBLEMS.agreementOption],
  "/ticketingDefaults/ticketingAgreement/option": ["agreementOption", PROBLEMS.agreementOption],
  "/ticketingDefaults/ticketingAgreement/delay": ["agreementDelay", PROBLEMS.delay],
  "/ticketingDefaults/issue": ["issue", PROBLEMS.issue],
};

const AUTOMATED_POINTER = /^\/ticketingDefaults\/automatedProcess\/(0|[1-9][0-9]*)\/(.+)$/;
const QUEUE_POINTER = /^\/monitoredQueues\/(0|[1-9][0-9]*)\/(officeId|queueId|category)$/;

/**
 * The form's key and message of one API field error, or `undefined` for a path the form has no field for (the
 * `If-Match` header, the path, a row the form did not send): the form is stale then. The office rule of the service
 * (`unknown`) and the request validation's keywords get the field's own message.
 */
function apiProblem(
  path: string,
  code: string,
  values: AmadeusSettingsValues,
): readonly [SettingsErrorKey, string] | undefined {
  const field = Object.hasOwn(API_FIELDS, path) ? API_FIELDS[path] : undefined;
  if (field !== undefined) {
    return field;
  }
  if (path === "/monitoredQueues") {
    return [
      "monitoredQueues",
      code === "maxItems"
        ? PROBLEMS.tooManyQueues
        : code === "uniqueItems"
          ? PROBLEMS.duplicate
          : PROBLEMS.rules,
    ];
  }
  const automated = AUTOMATED_POINTER.exec(path);
  if (automated !== null) {
    const [, index = "", pointer = ""] = automated;
    const rowField = Object.hasOwn(API_AUTOMATED_FIELDS, pointer) ? API_AUTOMATED_FIELDS[pointer] : undefined;
    if (rowField === undefined || Number(index) >= values.automatedProcess.length) {
      return undefined;
    }
    return [`automatedProcess.${index}.${rowField}`, AUTOMATED_MESSAGES[rowField]];
  }
  const queue = QUEUE_POINTER.exec(path);
  if (queue !== null) {
    const [, index = "", rowField = ""] = queue;
    if (Number(index) >= values.monitoredQueues.length) {
      return undefined;
    }
    return [`monitoredQueues.${index}.${rowField}`, QUEUE_MESSAGES[rowField as keyof MonitoredQueueValues]];
  }
  return undefined;
}

/** The API's field errors on the form's fields, by key (the first per key); empty when none is about the form. */
function apiFieldErrors(error: ApiError, values: AmadeusSettingsValues): Record<SettingsErrorKey, string> {
  const problems: Record<SettingsErrorKey, string> = {};
  for (const fieldError of error.fieldErrors) {
    const problem = apiProblem(fieldError.path, fieldError.code, values);
    if (problem !== undefined) {
      problems[problem[0]] ??= problem[1];
    }
  }
  return problems;
}

/**
 * The messages of a failed `updateAmadeusConnection` that belong to no field, and whether they ask for a reload.
 * `VALIDATION_FAILED` without an error on a field of the form is a problem the person cannot fix (the `If-Match`
 * header, the path): the form is stale. Other codes get the portal's message for the code.
 */
const FAILURES: Readonly<Partial<Record<PlatformErrorCode, { message: string; reload?: true }>>> = {
  PRECONDITION_FAILED: { message: AMADEUS_SETTINGS_STRINGS.stale, reload: true },
  TENANT_NOT_ACTIVE: { message: AMADEUS_SETTINGS_STRINGS.notActive, reload: true },
  FORBIDDEN: { message: AMADEUS_SETTINGS_STRINGS.forbidden, reload: true },
  NOT_FOUND: { message: AMADEUS_SETTINGS_STRINGS.removed, reload: true },
  VALIDATION_FAILED: { message: AMADEUS_SETTINGS_STRINGS.formExpired, reload: true },
  RATE_LIMITED: { message: AMADEUS_SETTINGS_STRINGS.rateLimited },
};

/** The values of an empty form, for a submission whose rows cannot be read. */
const NO_VALUES: AmadeusSettingsValues = {
  defaultOfficeId: "",
  queuingOfficeId: "",
  ownerOfficeId: "",
  agreementOption: "",
  agreementDelay: "",
  issue: "",
  automatedProcess: [],
  monitoredQueues: [],
};

/**
 * Saves the settings of one Amadeus connection from the form (the hidden fields `tenantId`, `environment` and
 * `version`, the `If-Match` version). Returns the connection as the API saved it, with its new version, or the problems
 * and what was sent; the Amadeus page is revalidated after a save, so its card shows the new offices.
 */
export async function saveAmadeusSettings(
  previous: AmadeusSettingsState,
  formData: FormData,
): Promise<AmadeusSettingsState> {
  const tenantId = text(formData, "tenantId");
  const environment = text(formData, "environment");
  const version = text(formData, "version");
  const values = valuesFrom(formData);
  const failed = (
    code: PlatformErrorCode,
    problem: { fieldErrors?: Record<SettingsErrorKey, string>; message?: string; reload?: true },
  ): AmadeusSettingsState => ({
    status: "failed",
    code,
    // A refused save changes nothing: the next one is checked against the same version.
    version: VERSION.test(version) ? Number(version) : previous.version,
    values: values ?? previous.values ?? NO_VALUES,
    fieldErrors: problem.fieldErrors ?? {},
    ...(problem.message === undefined ? {} : { message: problem.message }),
    ...(problem.reload === undefined ? {} : { reload: problem.reload }),
  });

  if (
    !isTenantId(tenantId) ||
    !isEnvironment(environment) ||
    !VERSION.test(version) ||
    values === undefined
  ) {
    // The form always carries all three and whole rows; without them a save could not name its connection, its
    // version or its queues.
    return failed("VALIDATION_FAILED", { message: AMADEUS_SETTINGS_STRINGS.formExpired, reload: true });
  }
  const parsed = SETTINGS_FORM.safeParse(values);
  if (!parsed.success) {
    return failed("VALIDATION_FAILED", { fieldErrors: problemsOf(parsed.error) });
  }

  const api = await platformApi();
  const result = await api.PATCH("/v1/tenants/{tenantId}/amadeus-connections/{environment}", {
    params: { path: { tenantId, environment }, header: { "If-Match": ifMatchOf(Number(version)) } },
    body: requestOf(parsed.data),
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      // The session ended (the middleware renews an access token that is only expired): sign in again.
      redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/amadeus") }).toString()}`);
    }
    if (code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-pending");
    }
    const fieldErrors = code === "VALIDATION_FAILED" ? apiFieldErrors(result.error, values) : {};
    if (Object.keys(fieldErrors).length > 0) {
      return failed(code, { fieldErrors });
    }
    return failed(code, FAILURES[code] ?? { message: errorMessage(result.error) });
  }

  // The card shows the saved offices: render the page again.
  revalidatePath(otaPath(tenantId, "/amadeus"));
  return { status: "saved", version: result.data.version, connection: result.data, fieldErrors: {} };
}

// ---- Live access, own credentials and their verification (PFE-023) ------------------------------------------------

/**
 * `requestLiveAccess`, `submitOwnCredentials` and `getSubmissionStatus` (PFE-023; flows/amadeus-connection.md §C and
 * §D; PF-51, PF-52). Each refuses a form or an id it cannot name a resource with without a call, calls the API with the
 * session and the end-user headers, sends an ended session to sign-in and back to the Amadeus page and an unverified
 * account to `/verify-pending`, and answers the portal's own text only, never the API's.
 *
 * - `requestLiveAccess` (`requestLiveAmadeus`, owners): the optional note for Velexis, trimmed, at most 1000
 *   characters. The API inserts the live connection without an office (`pending_verification`); the page is
 *   revalidated, so it shows that connection with the commercial onboarding that follows.
 * - `submitOwnCredentials` (`submitAmadeusCredentials`, owners and admins, behind a TOTP step-up: `REAUTH_REQUIRED`
 *   answers `stepUp`, and `useStepUpAction` sends the same form again after the code): the client id, the client
 *   secret, the office ids and the default, queuing and owner offices (the last two left out when "same as the
 *   default office"). The client secret goes to the API and nowhere else: it is never logged, never put in the state
 *   the action returns (which holds only the non-secret values) and never rendered.
 * - `getSubmissionStatus` (`getCredentialSubmission`, owners and admins): what `SubmissionStatus` polls every 2
 *   seconds. A final answer (`applied`, `failed`, `superseded`) revalidates the page, so the connection card shows
 *   the credentials the connection uses now (or the ones it kept).
 */

type CredentialSubmission = Schemas["CredentialSubmission"];
type SubmitAmadeusCredentialsRequest = Schemas["SubmitAmadeusCredentialsRequest"];

/**
 * A submission as the portal shows it: its id, status and verification result. The API's `errorMessage` stays on the
 * server (the portal shows its own words for `errorCode`), and the submission never holds a secret.
 */
export type SubmissionView = Pick<CredentialSubmission, "id" | "status" | "errorCode">;

/** A credential submission id (`CredentialSubmissionId` of the platform document: `crs_` + ULID). */
const SUBMISSION_ID = /^crs_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The statuses after which a submission changes no more (`CredentialSubmission.status`). */
const FINAL_SUBMISSION_STATUSES: readonly string[] = ["applied", "failed", "superseded"];

/** `RequestLiveAmadeusRequest.note`: at most 1000 characters (code points, as JSON Schema counts them). */
const NOTE_MAX = 1_000;

/** `SubmitAmadeusCredentialsRequest`: a client id of at most 200 characters without white space. */
const CLIENT_ID_MAX = 200;
const NO_WHITE_SPACE = /^\S+$/u;
/** `OwnAmadeusClientSecret`: 1 to 512 characters. */
const CLIENT_SECRET_MAX = 512;
/** `SubmitAmadeusCredentialsRequest.officeIds`: 1 to 50 office ids, each at most once. */
const OFFICE_IDS_MAX = 50;

const LIVE = AMADEUS_LIVE_STRINGS;
const OWN = OWN_CREDENTIALS_STRINGS;
const OWN_PROBLEMS = OWN_CREDENTIALS_STRINGS.problems;

/**
 * Ends the request when the session is over: sign in again and come back to the Amadeus page (the middleware renews an
 * access token that is only expired); an unverified account goes to `/verify-pending`.
 */
function leaveOnSessionEnd(error: ApiError, tenantId: string): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/amadeus") }).toString()}`);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
}

/** `details.reason` of a refusal, when the API sent one. */
function reasonOf(error: ApiError): unknown {
  return error.details["reason"];
}

// ---- Live access --------------------------------------------------------------------------------------------------

/** What the live access form shows after a request. */
export interface LiveRequestState {
  readonly status: "idle" | "requested" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  /** The note as sent, after a failure, so the form shows it again; empty after a request. */
  readonly note: string;
  /** A problem with the note: shown at the field. */
  readonly fieldError?: string;
  /** A problem that belongs to no field. */
  readonly message?: string;
  /** The page is out of date: the form offers "Reload the page". */
  readonly reload?: true;
  /** The plan does not include live mode (`FEATURE_DISABLED`): the form links to the billing page. */
  readonly billing?: true;
}

type LiveProblem = Pick<LiveRequestState, "fieldError" | "message" | "reload" | "billing">;

/** The portal's message for each code of a refused `requestLiveAmadeus` that needs no closer look. */
const LIVE_FAILURES: Readonly<Partial<Record<PlatformErrorCode, LiveProblem>>> = {
  FEATURE_DISABLED: { message: LIVE.notInPlan, billing: true },
  TENANT_NOT_ACTIVE: { message: LIVE.notActive, reload: true },
  FORBIDDEN: { message: LIVE.forbidden, reload: true },
  NOT_FOUND: { message: LIVE.removed, reload: true },
  RATE_LIMITED: { message: LIVE.rateLimited },
};

/** The portal's message for a refused `requestLiveAmadeus`. */
function liveFailure(error: ApiError): LiveProblem {
  if (error.code === "VALIDATION_FAILED") {
    // The note is the only field of the body; anything else (the path) is a form the person cannot fix.
    return error.fieldErrors.some((fieldError) => fieldError.path === "/note")
      ? { fieldError: LIVE.noteLength }
      : { message: LIVE.formExpired, reload: true };
  }
  if (error.code === "CONFLICT") {
    const reason = reasonOf(error);
    if (reason === "live_connection_exists") {
      return { message: LIVE.exists, reload: true };
    }
    return reason === "live_account_missing"
      ? { message: LIVE.accountMissing }
      : { message: ERROR_MESSAGES.CONFLICT, reload: true };
  }
  return LIVE_FAILURES[error.code] ?? { message: errorMessage(error) };
}

/**
 * Asks Velexis for a live Amadeus office (`POST /v1/tenants/{tenantId}/amadeus-connections/live/request`) from the
 * live access form (the hidden field `tenantId` and the optional `note`). A request revalidates the Amadeus page, which
 * then shows the live connection waiting for its office.
 */
export async function requestLiveAccess(
  _previous: LiveRequestState,
  formData: FormData,
): Promise<LiveRequestState> {
  const tenantId = text(formData, "tenantId");
  const note = text(formData, "note").trim();
  const failed = (code: PlatformErrorCode, problem: LiveProblem): LiveRequestState => ({
    status: "failed",
    code,
    note,
    ...problem,
  });

  if (!isTenantId(tenantId)) {
    return failed("VALIDATION_FAILED", { message: LIVE.formExpired, reload: true });
  }
  if (codePoints(note) > NOTE_MAX) {
    return failed("VALIDATION_FAILED", { fieldError: LIVE.noteLength });
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/amadeus-connections/live/request", {
    params: { path: { tenantId } },
    // The note is optional; an empty one is left out (`minLength: 1`).
    body: note === "" ? {} : { note },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    return failed(result.error.code, liveFailure(result.error));
  }
  // The page shows the live connection, waiting for its office.
  revalidatePath(otaPath(tenantId, "/amadeus"));
  return { status: "requested", note: "" };
}

// ---- Own credentials ----------------------------------------------------------------------------------------------

/** The fields of the own credentials form. */
export type OwnCredentialsField =
  "clientId" | "clientSecret" | "officeIds" | "defaultOfficeId" | "queuingOfficeId" | "ownerOfficeId";

/** The non-secret values of the own credentials form, as typed. The client secret is never one of them. */
export interface OwnCredentialsValues {
  readonly clientId: string;
  /** The office ids as typed: one per line (commas and spaces separate them too). */
  readonly officeIds: string;
  readonly defaultOfficeId: string;
  /** Empty: the same as the default office (left out of the body). */
  readonly queuingOfficeId: string;
  /** Empty: the same as the default office (left out of the body). */
  readonly ownerOfficeId: string;
}

/** What the own credentials form shows after a submission. Never holds the client secret. */
export interface OwnCredentialsState {
  readonly status: "idle" | "submitted" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  /** The non-secret values as sent, so the form shows them again. */
  readonly values: OwnCredentialsValues;
  /** Messages per field, in the portal's own words. */
  readonly fieldErrors: Readonly<Partial<Record<OwnCredentialsField, string>>>;
  /** A problem that belongs to no field. */
  readonly message?: string;
  /** The page is out of date: the form offers "Reload the page". */
  readonly reload?: true;
  /** The API asked for a step-up (`REAUTH_REQUIRED`): `useStepUpAction` opens the dialog. */
  readonly stepUp?: true;
  /** The submission the API accepted (`202`), which `SubmissionStatus` follows. */
  readonly submission?: SubmissionView;
}

/**
 * The office ids of the form's text, in the order typed: separated by line breaks, commas, semicolons or spaces,
 * upper-cased (the document's `AmadeusOfficeId` is upper case). `own-credentials-form.tsx` reads the text the same way
 * to fill the office selects; the test keeps both equal.
 */
function officeIdsOf(value: string): string[] {
  return value
    .split(/[\s,;]+/u)
    .filter((part) => part !== "")
    .map((part) => part.toUpperCase());
}

/** The form, checked; the problems' paths are the fields. The client secret is checked, never trimmed or kept. */
const OWN_CREDENTIALS_FORM = z
  .object({
    clientId: z
      .string()
      .trim()
      .min(1, OWN_PROBLEMS.clientIdRequired)
      .refine(
        (value) => codePoints(value) <= CLIENT_ID_MAX && NO_WHITE_SPACE.test(value),
        OWN_PROBLEMS.clientIdFormat,
      ),
    clientSecret: z
      .string()
      .min(1, OWN_PROBLEMS.clientSecretRequired)
      .refine((value) => codePoints(value) <= CLIENT_SECRET_MAX, OWN_PROBLEMS.clientSecretLength),
    // `maxItems: 50` of the document. Zod checks the bound before any office id, so an oversized list is refused with
    // this one message: its ids and the office rules below (`superRefine`) are not checked then.
    officeIds: z.array(z.string()).max(OFFICE_IDS_MAX, OWN_PROBLEMS.officeIdsTooMany),
    defaultOfficeId: z.string(),
    queuingOfficeId: z.string(),
    ownerOfficeId: z.string(),
  })
  .superRefine((form, context) => {
    const { officeIds } = form;
    const officeProblem = (message: string) =>
      context.addIssue({ code: "custom", path: ["officeIds"], message });
    if (officeIds.length === 0) {
      officeProblem(OWN_PROBLEMS.officeIdsRequired);
    } else if (officeIds.some((officeId) => !OFFICE_ID.test(officeId))) {
      officeProblem(OWN_PROBLEMS.officeIdFormat);
    } else if (new Set(officeIds).size !== officeIds.length) {
      officeProblem(OWN_PROBLEMS.officeIdsDuplicate);
    }
    // The three offices must be among the office ids typed (the API checks it again).
    const valid = new Set(officeIds.filter((officeId) => OFFICE_ID.test(officeId)));
    if (!valid.has(form.defaultOfficeId)) {
      context.addIssue({
        code: "custom",
        path: ["defaultOfficeId"],
        message: form.defaultOfficeId === "" ? OWN_PROBLEMS.defaultOfficeRequired : OWN_PROBLEMS.office,
      });
    }
    for (const field of ["queuingOfficeId", "ownerOfficeId"] as const) {
      if (form[field] !== "" && !valid.has(form[field])) {
        context.addIssue({ code: "custom", path: [field], message: OWN_PROBLEMS.office });
      }
    }
  });

type OwnCredentialsForm = z.infer<typeof OWN_CREDENTIALS_FORM>;

/** The request of the checked form: the queuing and owner offices only when chosen (the API defaults them). */
function credentialsRequestOf(form: OwnCredentialsForm): SubmitAmadeusCredentialsRequest {
  return {
    clientId: form.clientId,
    clientSecret: form.clientSecret,
    officeIds: form.officeIds,
    defaultOfficeId: form.defaultOfficeId,
    ...(form.queuingOfficeId === "" ? {} : { queuingOfficeId: form.queuingOfficeId }),
    ...(form.ownerOfficeId === "" ? {} : { ownerOfficeId: form.ownerOfficeId }),
  };
}

/** The field and message of each JSON pointer of the API outside the office list. */
const CREDENTIAL_FIELDS: Readonly<Record<string, readonly [OwnCredentialsField, string]>> = {
  "/clientId": ["clientId", OWN_PROBLEMS.clientIdFormat],
  "/clientSecret": ["clientSecret", OWN_PROBLEMS.clientSecretLength],
  "/defaultOfficeId": ["defaultOfficeId", OWN_PROBLEMS.office],
  "/queuingOfficeId": ["queuingOfficeId", OWN_PROBLEMS.office],
  "/ownerOfficeId": ["ownerOfficeId", OWN_PROBLEMS.office],
};

/** The message of each JSON Schema keyword at `/officeIds` itself. */
const OFFICE_LIST_MESSAGES: Readonly<Record<string, string>> = {
  uniqueItems: OWN_PROBLEMS.officeIdsDuplicate,
  maxItems: OWN_PROBLEMS.officeIdsTooMany,
  minItems: OWN_PROBLEMS.officeIdsRequired,
};

const OFFICE_ID_POINTER = /^\/officeIds\/(0|[1-9][0-9]*)$/;

/**
 * The field and message of one API field error, or `undefined` for a path the form has no field for (a header, the
 * path, an office the form did not send): the form is stale then. The JSON Schema keywords and the service's office
 * rule (`unknown`) get the field's own message; an empty secret (`minLength`) its own.
 */
function credentialProblem(
  path: string,
  code: string,
  sentOffices: number,
): readonly [OwnCredentialsField, string] | undefined {
  if (path === "/clientSecret" && code === "minLength") {
    return ["clientSecret", OWN_PROBLEMS.clientSecretRequired];
  }
  const field = Object.hasOwn(CREDENTIAL_FIELDS, path) ? CREDENTIAL_FIELDS[path] : undefined;
  if (field !== undefined) {
    return field;
  }
  if (path === "/officeIds") {
    return [
      "officeIds",
      Object.hasOwn(OFFICE_LIST_MESSAGES, code)
        ? (OFFICE_LIST_MESSAGES[code] ?? OWN_PROBLEMS.rules)
        : OWN_PROBLEMS.rules,
    ];
  }
  const office = OFFICE_ID_POINTER.exec(path);
  if (office !== null && Number(office[1]) < sentOffices) {
    return ["officeIds", OWN_PROBLEMS.officeIdFormat];
  }
  return undefined;
}

/** The API's field errors on the form's fields (the first per field); empty when none is about the form. */
function credentialFieldErrors(
  error: ApiError,
  sentOffices: number,
): Partial<Record<OwnCredentialsField, string>> {
  const problems: Partial<Record<OwnCredentialsField, string>> = {};
  for (const fieldError of error.fieldErrors) {
    const problem = credentialProblem(fieldError.path, fieldError.code, sentOffices);
    if (problem !== undefined) {
      problems[problem[0]] ??= problem[1];
    }
  }
  return problems;
}

type CredentialProblem = Pick<OwnCredentialsState, "message" | "reload" | "stepUp">;

/** The portal's message for each code of a refused `submitAmadeusCredentials` that is about no field. */
const CREDENTIAL_FAILURES: Readonly<Partial<Record<PlatformErrorCode, CredentialProblem>>> = {
  // Shown when the person cancels the step-up dialog that opens now.
  REAUTH_REQUIRED: { message: OWN.stepUpCancelled, stepUp: true },
  MFA_REQUIRED: { message: OWN.mfaRequired },
  FEATURE_DISABLED: { message: OWN.featureDisabled, reload: true },
  TENANT_NOT_ACTIVE: { message: OWN.notActive, reload: true },
  FORBIDDEN: { message: OWN.forbidden, reload: true },
  NOT_FOUND: { message: OWN.removed, reload: true },
  // A field error on nothing the form sent (a header, the path): a form the person cannot fix.
  VALIDATION_FAILED: { message: OWN.formExpired, reload: true },
  RATE_LIMITED: { message: OWN.rateLimited },
};

/** The portal's message for a refused `submitAmadeusCredentials` that is about no field. */
function credentialFailure(error: ApiError): CredentialProblem {
  if (error.code === "CONFLICT") {
    // A platform admin disabled the connection (lead decision of 2026-11-02, (2i)): nothing was written.
    return reasonOf(error) === "connection_disabled"
      ? { message: OWN.connectionDisabled }
      : { message: ERROR_MESSAGES.CONFLICT, reload: true };
  }
  return CREDENTIAL_FAILURES[error.code] ?? { message: errorMessage(error) };
}

/** The non-secret values of a submission, as typed. */
function credentialValuesFrom(formData: FormData): OwnCredentialsValues {
  return {
    clientId: text(formData, "clientId"),
    officeIds: text(formData, "officeIds"),
    defaultOfficeId: text(formData, "defaultOfficeId"),
    queuingOfficeId: text(formData, "queuingOfficeId"),
    ownerOfficeId: text(formData, "ownerOfficeId"),
  };
}

/**
 * Submits the OTA's own Amadeus credentials for one environment (`PUT
 * /v1/tenants/{tenantId}/amadeus-connections/{environment}/credentials`) from the own credentials form (the hidden
 * fields `tenantId` and `environment`). `202` answers the submission to follow and revalidates the page, so the
 * connection card shows that credentials are being verified; the connection itself changes only once they are.
 */
export async function submitOwnCredentials(
  previous: OwnCredentialsState,
  formData: FormData,
): Promise<OwnCredentialsState> {
  const tenantId = text(formData, "tenantId");
  const environment = text(formData, "environment");
  const values = credentialValuesFrom(formData);
  const failed = (
    code: PlatformErrorCode,
    problem: CredentialProblem & { readonly fieldErrors?: Partial<Record<OwnCredentialsField, string>> },
  ): OwnCredentialsState => ({
    status: "failed",
    code,
    values,
    fieldErrors: problem.fieldErrors ?? {},
    ...(problem.message === undefined ? {} : { message: problem.message }),
    ...(problem.reload === undefined ? {} : { reload: problem.reload }),
    ...(problem.stepUp === undefined ? {} : { stepUp: problem.stepUp }),
    // A refused submission leaves the one being verified (if any) as it was.
    ...(previous.submission === undefined ? {} : { submission: previous.submission }),
  });

  if (!isTenantId(tenantId) || !isEnvironment(environment)) {
    // The form always carries both; without them a submission could not name its connection.
    return failed("VALIDATION_FAILED", { message: OWN.formExpired, reload: true });
  }
  const parsed = OWN_CREDENTIALS_FORM.safeParse({
    clientId: values.clientId,
    clientSecret: text(formData, "clientSecret"),
    officeIds: officeIdsOf(values.officeIds),
    defaultOfficeId: values.defaultOfficeId,
    queuingOfficeId: values.queuingOfficeId,
    ownerOfficeId: values.ownerOfficeId,
  });
  if (!parsed.success) {
    // The messages are the portal's own and never hold a value; the secret is neither in them nor in the state.
    return failed("VALIDATION_FAILED", { fieldErrors: problemsOf(parsed.error) });
  }

  const api = await platformApi();
  const result = await api.PUT("/v1/tenants/{tenantId}/amadeus-connections/{environment}/credentials", {
    params: { path: { tenantId, environment } },
    body: credentialsRequestOf(parsed.data),
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    const fieldErrors =
      result.error.code === "VALIDATION_FAILED"
        ? credentialFieldErrors(result.error, parsed.data.officeIds.length)
        : {};
    if (Object.keys(fieldErrors).length > 0) {
      return failed(result.error.code, { fieldErrors });
    }
    return failed(result.error.code, credentialFailure(result.error));
  }

  const { id, status, errorCode } = result.data.submission;
  // The card shows the submission being verified; the connection keeps its credentials until they are.
  revalidatePath(otaPath(tenantId, "/amadeus"));
  return {
    status: "submitted",
    values: { ...values, clientId: parsed.data.clientId },
    fieldErrors: {},
    submission: { id, status, errorCode },
  };
}

// ---- The verification ---------------------------------------------------------------------------------------------

/** The answer of one read of a submission. */
export type SubmissionPoll =
  | { readonly status: "ok"; readonly submission: SubmissionView }
  | {
      readonly status: "failed";
      /** The error code, for tests; never shown. */
      readonly code: PlatformErrorCode;
      readonly message: string;
      /** The read may work when tried again (rate limit, API unavailable): polling goes on. */
      readonly transient: boolean;
      /** The wait of `Retry-After`, when the API sent one. */
      readonly retryAfterSeconds?: number;
    };

/** Read failures that may pass: polling goes on. */
const TRANSIENT_POLL_CODES: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

/**
 * Reads a submission of the OTA's own credentials (`GET /v1/tenants/{tenantId}/credential-submissions/{submissionId}`)
 * for `SubmissionStatus`. Ids that are none answer `NOT_FOUND` without a call. A final status revalidates the Amadeus
 * page, so the connection card shows the outcome.
 */
export async function getSubmissionStatus(tenantId: unknown, submissionId: unknown): Promise<SubmissionPoll> {
  if (!isTenantId(tenantId) || typeof submissionId !== "string" || !SUBMISSION_ID.test(submissionId)) {
    return { status: "failed", code: "NOT_FOUND", message: errorMessage("NOT_FOUND"), transient: false };
  }
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/credential-submissions/{submissionId}", {
    params: { path: { tenantId, submissionId } },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    const { code, retryAfterSeconds } = result.error;
    return {
      status: "failed",
      code,
      message: errorMessage(result.error),
      transient: TRANSIENT_POLL_CODES.has(code),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }
  const { id, status, errorCode } = result.data;
  if (FINAL_SUBMISSION_STATUSES.includes(status)) {
    // The connection card shows the credentials the connection uses now, or the ones it kept.
    revalidatePath(otaPath(tenantId, "/amadeus"));
  }
  return { status: "ok", submission: { id, status, errorCode } };
}
