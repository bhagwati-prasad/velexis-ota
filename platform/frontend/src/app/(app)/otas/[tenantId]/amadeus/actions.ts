"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { otaPath } from "@/lib/roles";
import { AMADEUS_SETTINGS_STRINGS } from "@/lib/strings";
import { ifMatchOf, isTenantId } from "@/lib/tenant";

/**
 * The server action of the Amadeus page (README §2 `/otas/[tenantId]/amadeus`; flows/amadeus-connection.md §E; PF-53).
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
    automatedProcess: z.array(AUTOMATED_PROCESS),
    monitoredQueues: z.array(MONITORED_QUEUE).max(MONITORED_QUEUES_MAX, PROBLEMS.tooManyQueues),
  })
  .superRefine((form, context) => {
    if (
      DELAYED_AGREEMENTS.includes(form.agreementOption) &&
      !(form.agreementDelay === "" || UP_TO_THREE_DIGITS.test(form.agreementDelay))
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["agreementDelay"], message: PROBLEMS.delay });
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
          code: z.ZodIssueCode.custom,
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
