"use client";

import type { components } from "@velexis/api-types/platform";
import {
  startTransition,
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  saveAmadeusSettings,
  type AmadeusSettingsState,
  type AmadeusSettingsValues,
  type AutomatedProcessValues,
  type MonitoredQueueValues,
} from "@/app/(app)/otas/[tenantId]/amadeus/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { otaPath } from "@/lib/roles";
import { AMADEUS_SETTINGS_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The settings form of one Amadeus connection (README §2 `/otas/[tenantId]/amadeus`; flows/amadeus-connection.md §E;
 * PF-53), for owners and admins: the default, queuing and owner offices (selects that offer only the connection's
 * offices), the ticketing defaults of new flight orders (the ticketing agreement and its delay, whether orders are issued
 * at once, and the automated processes, rows to add and remove) and the monitored queues (rows to add and remove, at
 * most 20). `saveAmadeusSettings` checks the form and calls `updateAmadeusConnection` with the connection's version in
 * `If-Match`; after a save the form shows the settings as the API saved them, and a stale version shows the reload
 * message. While the OTA is not `active` the form is disabled with the reason (PADR-0014 item 5: the API answers
 * `TENANT_NOT_ACTIVE` then). The form holds nothing secret.
 */

type Schemas = components["schemas"];
type AmadeusConnection = Schemas["AmadeusConnection"];
type Environment = Schemas["Environment"];
type TenantStatus = Schemas["TenantStatus"];

const STRINGS = AMADEUS_SETTINGS_STRINGS;

/** `AmadeusMonitoredQueue` list of the document: at most 20 queues. */
export const MONITORED_QUEUES_MAX = 20;

/** The agreements whose automatic step waits: only they take a delay (the action sends it for them only). */
const DELAYED_AGREEMENTS: readonly string[] = ["DELAY_TO_QUEUE", "DELAY_TO_CANCEL"];

/** `ticketingAgreement.delay` and an automated process's `delay` as the API stores them: days and a `D`. */
const DAYS = /^([0-9]{1,3})D$/;

/** The days of a stored delay (`"2D"` → `"2"`); a value of another shape as it is, for the person to fix. */
function daysOf(delay: string | undefined): string {
  if (delay === undefined) {
    return "";
  }
  return DAYS.exec(delay)?.[1] ?? delay;
}

/** `officeId` when it is one of the connection's offices, else empty: a select offers no other office. */
function officeOf(officeId: string | null | undefined, officeIds: readonly string[]): string {
  return officeId !== null && officeId !== undefined && officeIds.includes(officeId) ? officeId : "";
}

/** The form values of a connection's settings, as `listAmadeusConnections` or `updateAmadeusConnection` answers them. */
export function valuesOf(connection: AmadeusConnection): AmadeusSettingsValues {
  const { officeIds, ticketingDefaults } = connection;
  const issue = ticketingDefaults.issue;
  return {
    defaultOfficeId: officeOf(connection.defaultOfficeId, officeIds),
    queuingOfficeId: officeOf(connection.queuingOfficeId, officeIds),
    ownerOfficeId: officeOf(connection.ownerOfficeId, officeIds),
    agreementOption: ticketingDefaults.ticketingAgreement?.option ?? "",
    agreementDelay: daysOf(ticketingDefaults.ticketingAgreement?.delay),
    issue: issue === undefined ? "" : String(issue),
    automatedProcess: (ticketingDefaults.automatedProcess ?? []).map((entry) => ({
      code: entry.code,
      queueNumber: entry.queue?.number ?? "",
      queueCategory: entry.queue?.category ?? "",
      officeId: officeOf(entry.officeId, officeIds),
      delay: daysOf(entry.delay),
      text: entry.text ?? "",
    })),
    monitoredQueues: connection.monitoredQueues.map((queue) => ({
      officeId: officeOf(queue.officeId, officeIds),
      queueId: String(queue.queueId),
      category: String(queue.category),
    })),
  };
}

/** The fields of the form that are not in a list, in form order. */
type SingleField =
  "defaultOfficeId" | "queuingOfficeId" | "ownerOfficeId" | "agreementOption" | "agreementDelay" | "issue";

const SINGLE_FIELDS: readonly SingleField[] = [
  "defaultOfficeId",
  "queuingOfficeId",
  "ownerOfficeId",
  "agreementOption",
  "agreementDelay",
  "issue",
];

const AUTOMATED_FIELDS: readonly (keyof AutomatedProcessValues)[] = [
  "code",
  "queueNumber",
  "queueCategory",
  "officeId",
  "delay",
  "text",
];

const QUEUE_FIELDS: readonly (keyof MonitoredQueueValues)[] = ["officeId", "queueId", "category"];

/** One row of a list, with a key of its own: removing a row keeps the others' fields and errors where they are. */
interface Row<Values> {
  readonly key: number;
  readonly values: Values;
}

/** What the form edits. */
interface Editor {
  readonly fields: Readonly<Record<SingleField, string>>;
  readonly automated: readonly Row<AutomatedProcessValues>[];
  readonly queues: readonly Row<MonitoredQueueValues>[];
  /** The key of the next row. */
  readonly nextKey: number;
}

/** The editor of `values`, its rows keyed from `firstKey` on (from 0 on the server and at hydration). */
function editorOf(values: AmadeusSettingsValues, firstKey: number): Editor {
  let key = firstKey;
  const automated = values.automatedProcess.map((entry) => ({ key: key++, values: entry }));
  const queues = values.monitoredQueues.map((queue) => ({ key: key++, values: queue }));
  return {
    fields: {
      defaultOfficeId: values.defaultOfficeId,
      queuingOfficeId: values.queuingOfficeId,
      ownerOfficeId: values.ownerOfficeId,
      agreementOption: values.agreementOption,
      agreementDelay: values.agreementDelay,
      issue: values.issue,
    },
    automated,
    queues,
    nextKey: key,
  };
}

/** The values a state shows: what was sent after a failure, else the connection (the page's, or the saved one). */
function stateValues(state: AmadeusSettingsState, connection: AmadeusConnection): AmadeusSettingsValues {
  return state.values ?? valuesOf(state.connection ?? connection);
}

/** The ids of one form's elements: one form per connection, so per environment. */
function idsOf(environment: Environment) {
  const prefix = `amadeus-${environment}`;
  return {
    field: (name: SingleField) => `${prefix}-${name}`,
    automated: (key: number, name: keyof AutomatedProcessValues) => `${prefix}-automated-${key}-${name}`,
    queue: (key: number, name: keyof MonitoredQueueValues) => `${prefix}-queue-${key}-${name}`,
    automatedList: `${prefix}-automated`,
    queueList: `${prefix}-queues`,
  };
}

type Ids = ReturnType<typeof idsOf>;

/** The problems of an answer: by element id (a field's, or a list's), and the error summary in form order. */
interface Problems {
  readonly byId: Readonly<Record<string, string>>;
  readonly summary: readonly FormErrorItem[];
}

/**
 * The problems of `state`, placed on the fields of `editor` (the rows `state` was answered for, in the order sent): each
 * error key (`monitoredQueues.1.queueId`) becomes the id of its field, and the summary lists them in form order, a
 * list's own problem after its rows, then the problem of no field.
 */
function problemsOf(state: AmadeusSettingsState, editor: Editor, ids: Ids): Problems {
  const places: { key: string; id: string; linked: boolean }[] = [
    ...SINGLE_FIELDS.map((field) => ({ key: field, id: ids.field(field), linked: true })),
    ...editor.automated.flatMap((row, index) =>
      AUTOMATED_FIELDS.map((field) => ({
        key: `automatedProcess.${index}.${field}`,
        id: ids.automated(row.key, field),
        linked: true,
      })),
    ),
    { key: "automatedProcess", id: ids.automatedList, linked: false },
    ...editor.queues.flatMap((row, index) =>
      QUEUE_FIELDS.map((field) => ({
        key: `monitoredQueues.${index}.${field}`,
        id: ids.queue(row.key, field),
        linked: true,
      })),
    ),
    { key: "monitoredQueues", id: ids.queueList, linked: false },
  ];
  const byId: Record<string, string> = {};
  const summary: FormErrorItem[] = [];
  const placed = new Set<string>();
  for (const place of places) {
    const message = Object.hasOwn(state.fieldErrors, place.key) ? state.fieldErrors[place.key] : undefined;
    if (message !== undefined) {
      byId[place.id] = message;
      summary.push(place.linked ? { message, fieldId: place.id } : { message });
      placed.add(place.key);
    }
  }
  // A problem the form has no place for still shows, in the summary.
  for (const [key, message] of Object.entries(state.fieldErrors)) {
    if (!placed.has(key)) {
      summary.push({ message });
    }
  }
  if (state.message !== undefined) {
    summary.push({ message: state.message });
  }
  return { byId, summary };
}

const SELECT_CLASSES = cn(
  "border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none md:text-sm",
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  "aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

/** The `<option>`s of the connection's offices. */
function officeOptions(officeIds: readonly string[]): ReactNode[] {
  return officeIds.map((officeId) => (
    <option key={officeId} value={officeId}>
      {officeId}
    </option>
  ));
}

/** The `<option>`s of a record of labels, in its order. */
function labelOptions(labels: Readonly<Record<string, string>>): ReactNode[] {
  return Object.entries(labels).map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ));
}

/** The digits fields of the rows: short, numeric, never filled in by the browser. */
const DIGITS_INPUT = { inputMode: "numeric", autoComplete: "off", spellCheck: false, maxLength: 3 } as const;

export interface AmadeusSettingsFormProps {
  readonly tenantId: string;
  /** The id of the heading that names the form (the page's heading of the connection's settings). */
  readonly labelledBy: string;
  /** The connection as `listAmadeusConnections` answered it: its offices, settings and version. */
  readonly connection: AmadeusConnection;
  /** The OTA's status: only an `active` OTA's connections change. */
  readonly tenantStatus: TenantStatus;
}

/**
 * The form; after a refused save the fields keep what was sent, after a save they show the saved settings. The fields
 * are controlled and the form posts its data to the action in a transition, so nothing resets them behind the person's
 * back.
 */
export function AmadeusSettingsForm({
  tenantId,
  labelledBy,
  connection,
  tenantStatus,
}: AmadeusSettingsFormProps) {
  const { environment, officeIds } = connection;
  const ids = idsOf(environment);
  const initialState = useMemo<AmadeusSettingsState>(
    () => ({ status: "idle", version: connection.version, connection, fieldErrors: {} }),
    [connection],
  );
  const [state, dispatch, pending] = useActionState(saveAmadeusSettings, initialState);
  // From the state, not the props: a form posted before the page hydrated comes back rendered with the action's
  // answer, and its fields show what was sent.
  const [editor, setEditor] = useState<Editor>(() => editorOf(stateValues(state, connection), 0));
  const [problems, setProblems] = useState<Problems>(() => problemsOf(state, editor, ids));
  const writable = tenantStatus === "active";
  const addAutomatedButton = useRef<HTMLButtonElement>(null);
  const addQueueButton = useRef<HTMLButtonElement>(null);
  /** The list whose row was just removed: its "Add" button takes the focus once the row is gone. */
  const focusAfterRemove = useRef<"automated" | "queues" | null>(null);

  // Each answer of the action sets the fields and the problems, in the render that shows the answer.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    const next = editorOf(stateValues(state, connection), editor.nextKey);
    setAnswered(state);
    setEditor(next);
    setProblems(problemsOf(state, next, ids));
  }

  const setField = (field: SingleField, value: string): void => {
    setEditor((previous) => ({ ...previous, fields: { ...previous.fields, [field]: value } }));
  };
  const setAutomated = (key: number, field: keyof AutomatedProcessValues, value: string): void => {
    setEditor((previous) => ({
      ...previous,
      automated: previous.automated.map((row) =>
        row.key === key ? { key, values: { ...row.values, [field]: value } } : row,
      ),
    }));
  };
  const setQueue = (key: number, field: keyof MonitoredQueueValues, value: string): void => {
    setEditor((previous) => ({
      ...previous,
      queues: previous.queues.map((row) =>
        row.key === key ? { key, values: { ...row.values, [field]: value } } : row,
      ),
    }));
  };
  // A new row's office: the default office, or the connection's first.
  const firstOffice = officeOf(connection.defaultOfficeId, officeIds) || (officeIds[0] ?? "");
  const addAutomated = (): void => {
    setEditor((previous) => ({
      ...previous,
      automated: [
        ...previous.automated,
        {
          key: previous.nextKey,
          values: {
            code: "IMMEDIATE",
            queueNumber: "",
            queueCategory: "",
            officeId: "",
            delay: "",
            text: "",
          },
        },
      ],
      nextKey: previous.nextKey + 1,
    }));
  };
  const addQueue = (): void => {
    setEditor((previous) =>
      previous.queues.length >= MONITORED_QUEUES_MAX
        ? previous
        : {
            ...previous,
            queues: [
              ...previous.queues,
              { key: previous.nextKey, values: { officeId: firstOffice, queueId: "", category: "0" } },
            ],
            nextKey: previous.nextKey + 1,
          },
    );
  };
  const removeAutomated = (key: number): void => {
    setEditor((previous) => ({
      ...previous,
      automated: previous.automated.filter((row) => row.key !== key),
    }));
    focusAfterRemove.current = "automated";
  };
  const removeQueue = (key: number): void => {
    setEditor((previous) => ({ ...previous, queues: previous.queues.filter((row) => row.key !== key) }));
    focusAfterRemove.current = "queues";
  };
  // A "Remove" button goes with its row, which would leave the focus nowhere (the page's start for a screen reader):
  // once the row is gone, the focus moves to the "Add" button of its list (enabled again after a queue at the limit).
  useEffect(() => {
    const list = focusAfterRemove.current;
    if (list !== null) {
      focusAfterRemove.current = null;
      (list === "automated" ? addAutomatedButton : addQueueButton).current?.focus();
    }
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!writable || pending) {
      // A second save while one is on its way would carry the same version and be refused as stale.
      return;
    }
    const formData = new FormData(event.currentTarget);
    startTransition(() => {
      dispatch(formData);
    });
  }

  const { fields } = editor;
  const delayed = DELAYED_AGREEMENTS.includes(fields.agreementOption);
  const queuesFull = editor.queues.length >= MONITORED_QUEUES_MAX;

  /** One of the three office selects; the placeholder only while no office of the connection is chosen. */
  const officeSelect = (
    field: "defaultOfficeId" | "queuingOfficeId" | "ownerOfficeId",
    label: string,
    hint: string,
  ) => (
    <FormField
      id={ids.field(field)}
      name={field}
      label={label}
      description={hint}
      error={problems.byId[ids.field(field)]}
    >
      {(control) => (
        <select
          {...control}
          value={fields[field]}
          onChange={(event) => setField(field, event.target.value)}
          className={SELECT_CLASSES}
        >
          {fields[field] === "" ? <option value="">{STRINGS.officePlaceholder}</option> : null}
          {officeOptions(officeIds)}
        </select>
      )}
    </FormField>
  );

  return (
    // `action` serves a form posted before the page hydrated (Next.js then runs the action on the server and renders
    // its answer), so the fields never go into a GET query string. Once hydrated, `onSubmit` sends the data itself:
    // its `preventDefault` keeps React from running `action` and resetting the form after it.
    <form
      action={dispatch}
      onSubmit={onSubmit}
      noValidate
      aria-labelledby={labelledBy}
      className="grid gap-6"
      data-amadeus-settings-form={environment}
    >
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="environment" value={environment} />
      <input type="hidden" name="version" value={String(state.version)} />

      {tenantStatus === "active" ? null : (
        <Alert role="status" data-settings-read-only="">
          <AlertTitle>{STRINGS.readOnlyTitle}</AlertTitle>
          <AlertDescription>{STRINGS.readOnly[tenantStatus]}</AlertDescription>
        </Alert>
      )}
      <FormErrorSummary errors={problems.summary} />
      {state.reload === true ? (
        <p className="text-sm">
          {/* A full reload, so the page shows the connection as it is now, with its new version. */}
          <a href={otaPath(tenantId, "/amadeus")} className="font-medium underline underline-offset-4">
            {STRINGS.reload}
          </a>
        </p>
      ) : null}
      {state.status === "saved" ? (
        <p role="status" className="rounded-lg border px-4 py-3 text-sm font-medium" data-saved="">
          {STRINGS.saved}
        </p>
      ) : null}

      <fieldset disabled={!writable} className="grid gap-6">
        <fieldset className="grid gap-4" data-group="offices">
          <legend className="mb-3 font-semibold tracking-tight">{STRINGS.officesLegend}</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            {officeSelect("defaultOfficeId", STRINGS.defaultOfficeLabel, STRINGS.defaultOfficeHint)}
            {officeSelect("queuingOfficeId", STRINGS.queuingOfficeLabel, STRINGS.queuingOfficeHint)}
            {officeSelect("ownerOfficeId", STRINGS.ownerOfficeLabel, STRINGS.ownerOfficeHint)}
          </div>
        </fieldset>

        <fieldset className="grid gap-4" data-group="ticketing">
          <legend className="mb-1 font-semibold tracking-tight">{STRINGS.ticketingLegend}</legend>
          <p className="text-sm text-muted-foreground">{STRINGS.ticketingIntro}</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              id={ids.field("agreementOption")}
              name="agreementOption"
              label={STRINGS.agreementLabel}
              error={problems.byId[ids.field("agreementOption")]}
            >
              {(control) => (
                <select
                  {...control}
                  value={fields.agreementOption}
                  onChange={(event) => setField("agreementOption", event.target.value)}
                  className={SELECT_CLASSES}
                >
                  {labelOptions(STRINGS.agreementOptions)}
                </select>
              )}
            </FormField>
            <FormField
              id={ids.field("agreementDelay")}
              name="agreementDelay"
              label={STRINGS.delayLabel}
              description={STRINGS.delayHint}
              error={problems.byId[ids.field("agreementDelay")]}
              value={fields.agreementDelay}
              onChange={(event) => setField("agreementDelay", event.target.value)}
              // Only a delayed agreement takes a delay: a disabled field is not sent, and its days come back with one.
              disabled={!delayed}
              {...DIGITS_INPUT}
            />
            <FormField
              id={ids.field("issue")}
              name="issue"
              label={STRINGS.issueLabel}
              error={problems.byId[ids.field("issue")]}
            >
              {(control) => (
                <select
                  {...control}
                  value={fields.issue}
                  onChange={(event) => setField("issue", event.target.value)}
                  className={SELECT_CLASSES}
                >
                  {labelOptions(STRINGS.issueOptions)}
                </select>
              )}
            </FormField>
          </div>

          <div className="grid gap-3" id={ids.automatedList} data-list="automatedProcess">
            <div className="grid gap-1">
              <h3 className="text-sm font-semibold">{STRINGS.automatedTitle}</h3>
              <p className="text-sm text-muted-foreground">{STRINGS.automatedIntro}</p>
            </div>
            {problems.byId[ids.automatedList] === undefined ? null : (
              <p className="text-sm font-medium text-destructive">{problems.byId[ids.automatedList]}</p>
            )}
            {editor.automated.length === 0 ? (
              <p className="text-sm text-muted-foreground">{STRINGS.automatedNone}</p>
            ) : null}
            {editor.automated.map((row, index) => {
              const id = (field: keyof AutomatedProcessValues) => ids.automated(row.key, field);
              const error = (field: keyof AutomatedProcessValues) => problems.byId[id(field)];
              return (
                <fieldset key={row.key} className="grid gap-3 rounded-lg border p-4" data-automated-row="">
                  <legend className="px-1 text-sm font-medium">{STRINGS.automatedRow(index + 1)}</legend>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <FormField
                      id={id("code")}
                      name="automatedCode"
                      label={STRINGS.automatedCodeLabel}
                      error={error("code")}
                    >
                      {(control) => (
                        <select
                          {...control}
                          value={row.values.code}
                          onChange={(event) => setAutomated(row.key, "code", event.target.value)}
                          className={SELECT_CLASSES}
                        >
                          {labelOptions(STRINGS.automatedCodes)}
                        </select>
                      )}
                    </FormField>
                    <FormField
                      id={id("queueNumber")}
                      name="automatedQueueNumber"
                      label={STRINGS.queueNumberLabel}
                      error={error("queueNumber")}
                      value={row.values.queueNumber}
                      onChange={(event) => setAutomated(row.key, "queueNumber", event.target.value)}
                      {...DIGITS_INPUT}
                    />
                    <FormField
                      id={id("queueCategory")}
                      name="automatedQueueCategory"
                      label={STRINGS.queueCategoryLabel}
                      error={error("queueCategory")}
                      value={row.values.queueCategory}
                      onChange={(event) => setAutomated(row.key, "queueCategory", event.target.value)}
                      {...DIGITS_INPUT}
                    />
                    <FormField
                      id={id("officeId")}
                      name="automatedOfficeId"
                      label={STRINGS.officeLabel}
                      error={error("officeId")}
                    >
                      {(control) => (
                        <select
                          {...control}
                          value={row.values.officeId}
                          onChange={(event) => setAutomated(row.key, "officeId", event.target.value)}
                          className={SELECT_CLASSES}
                        >
                          <option value="">{STRINGS.officeNone}</option>
                          {officeOptions(officeIds)}
                        </select>
                      )}
                    </FormField>
                    <FormField
                      id={id("delay")}
                      name="automatedDelay"
                      label={STRINGS.automatedDelayLabel}
                      error={error("delay")}
                      value={row.values.delay}
                      onChange={(event) => setAutomated(row.key, "delay", event.target.value)}
                      {...DIGITS_INPUT}
                    />
                  </div>
                  <FormField
                    id={id("text")}
                    name="automatedText"
                    label={STRINGS.textLabel}
                    error={error("text")}
                    value={row.values.text}
                    onChange={(event) => setAutomated(row.key, "text", event.target.value)}
                    autoComplete="off"
                    maxLength={200}
                  />
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={STRINGS.removeAutomated(index + 1)}
                      onClick={() => removeAutomated(row.key)}
                    >
                      {STRINGS.remove}
                    </Button>
                  </div>
                </fieldset>
              );
            })}
            <div>
              <Button ref={addAutomatedButton} type="button" variant="outline" onClick={addAutomated}>
                {STRINGS.addAutomated}
              </Button>
            </div>
          </div>
        </fieldset>

        <fieldset className="grid gap-3" id={ids.queueList} data-list="monitoredQueues">
          <legend className="mb-1 font-semibold tracking-tight">{STRINGS.queuesTitle}</legend>
          <p className="text-sm text-muted-foreground">{STRINGS.queuesIntro}</p>
          {problems.byId[ids.queueList] === undefined ? null : (
            <p className="text-sm font-medium text-destructive">{problems.byId[ids.queueList]}</p>
          )}
          {editor.queues.length === 0 ? (
            <p className="text-sm text-muted-foreground">{STRINGS.queuesNone}</p>
          ) : null}
          {editor.queues.map((row, index) => {
            const id = (field: keyof MonitoredQueueValues) => ids.queue(row.key, field);
            const error = (field: keyof MonitoredQueueValues) => problems.byId[id(field)];
            return (
              <fieldset key={row.key} className="grid gap-3 rounded-lg border p-4" data-queue-row="">
                <legend className="px-1 text-sm font-medium">{STRINGS.queueRow(index + 1)}</legend>
                <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <FormField
                    id={id("officeId")}
                    name="queueOfficeId"
                    label={STRINGS.officeLabel}
                    error={error("officeId")}
                  >
                    {(control) => (
                      <select
                        {...control}
                        value={row.values.officeId}
                        onChange={(event) => setQueue(row.key, "officeId", event.target.value)}
                        className={SELECT_CLASSES}
                      >
                        {row.values.officeId === "" ? (
                          <option value="">{STRINGS.officePlaceholder}</option>
                        ) : null}
                        {officeOptions(officeIds)}
                      </select>
                    )}
                  </FormField>
                  <FormField
                    id={id("queueId")}
                    name="queueId"
                    label={STRINGS.queueIdLabel}
                    description={STRINGS.queueIdHint}
                    error={error("queueId")}
                    value={row.values.queueId}
                    onChange={(event) => setQueue(row.key, "queueId", event.target.value)}
                    {...DIGITS_INPUT}
                  />
                  <FormField
                    id={id("category")}
                    name="queueCategory"
                    label={STRINGS.categoryLabel}
                    description={STRINGS.categoryHint}
                    error={error("category")}
                    value={row.values.category}
                    onChange={(event) => setQueue(row.key, "category", event.target.value)}
                    {...DIGITS_INPUT}
                  />
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={STRINGS.removeQueue(index + 1)}
                      onClick={() => removeQueue(row.key)}
                    >
                      {STRINGS.remove}
                    </Button>
                  </div>
                </div>
              </fieldset>
            );
          })}
          <div className="grid gap-2">
            <div>
              <Button
                ref={addQueueButton}
                type="button"
                variant="outline"
                onClick={addQueue}
                disabled={queuesFull}
              >
                {STRINGS.addQueue}
              </Button>
            </div>
            {queuesFull ? <p className="text-sm text-muted-foreground">{STRINGS.queuesFull}</p> : null}
          </div>
        </fieldset>
      </fieldset>

      <div>
        <Button type="submit" disabled={!writable || pending}>
          {pending ? STRINGS.submitting : STRINGS.submit}
        </Button>
      </div>
    </form>
  );
}
