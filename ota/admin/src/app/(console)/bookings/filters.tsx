"use client";

// The saved views and the filters of `/bookings` (routes.md §3.1, OAD-006). Both write the URL's search parameters
// and nothing else: the page's server component reads the same parameters (views.ts) and calls
// `console.bookings.list` with them, so every view of the list is a link staff can share, and the back button goes
// back to the previous filters. A choice (a status, the sort, a yes/no filter) applies at once; text and days apply
// when staff submit the filters. Either way the position goes (the cursor and `asOf`: the list starts again on its
// first page) and the other parameters stay. A value the API would refuse is shown at its field and never written.
// Without JavaScript the form is a plain GET form to the same page, which reads it the same way.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import {
  BOOKING_FILTERS,
  BOOKING_VIEWS,
  BOOKINGS_PATH,
  VIEW_GROUPS,
  activeView,
  bookingsHref,
  checkFilters,
  clearedHref,
  filterValuesOf,
  hasFilters,
  isPositionParam,
  viewHref,
  type DateFilter,
  type FilterErrors,
  type FilterName,
  type FilterValues,
  type ListFilter,
  type MultiFilter,
  type QueryLike,
  type SelectFilter,
  type TextFilter,
} from "@/app/(console)/bookings/views";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export const FILTER_STRINGS = Object.freeze({
  viewsLabel: "Saved views",
  filtersLabel: "Booking filters",
  apply: "Apply filters",
  clear: "Clear filters",
  more: "More filters",
  any: "Any",
  selected: (count: number) => `${count} selected`,
  linkFilters: "Also filtered by",
  remove: (label: string) => `Remove the filter ${label}`,
});

const FIELD_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive";
const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";

/** The query of the page being rendered; an empty one before Next.js has it. */
function useQuery(): URLSearchParams {
  return useSearchParams() ?? new URLSearchParams();
}

/**
 * The saved views (routes.md §3.1): the needs-attention work lists and the other preset lists, each a link with its
 * filters. The view whose filters are exactly the URL's is marked as the current page.
 */
export function BookingViews({ className }: { readonly className?: string }) {
  const query = useQuery();
  const current = activeView(query);
  const headingId = useId();
  return (
    <nav aria-labelledby={headingId} className={cn("grid gap-3", className)}>
      <h2 id={headingId} className="sr-only">
        {FILTER_STRINGS.viewsLabel}
      </h2>
      {VIEW_GROUPS.map((group) => (
        <div key={group.id} className="flex flex-wrap items-center gap-2">
          <span className="w-32 shrink-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group.label}
          </span>
          <ul className="flex flex-wrap gap-2">
            {BOOKING_VIEWS.filter((view) => view.group === group.id).map((view) => {
              const selected = current?.id === view.id;
              return (
                <li key={view.id}>
                  <Link
                    href={viewHref(view)}
                    title={view.description}
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "inline-flex h-8 items-center rounded-full border px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                      selected && "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
                    )}
                  >
                    {view.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The filters of the form: every one but those only a link sets. */
const FORM_FILTERS: readonly ListFilter[] = BOOKING_FILTERS.filter((filter) => filter.placement !== "link");
const LINK_FILTERS: readonly ListFilter[] = BOOKING_FILTERS.filter((filter) => filter.placement === "link");

/** Sets one filter's values. */
function withValues(values: FilterValues, name: FilterName, next: readonly string[]): FilterValues {
  return { ...values, [name]: next };
}

interface FieldProps<Filter extends ListFilter> {
  readonly filter: Filter;
  readonly id: string;
  readonly values: readonly string[];
  readonly error: string | undefined;
  readonly onChange: (values: readonly string[], apply: boolean) => void;
}

/** The message of a field, linked to it with `aria-describedby`. */
function FieldError({ id, error }: { readonly id: string; readonly error: string | undefined }) {
  return error === undefined ? null : (
    <p id={`${id}-error`} className="text-sm text-destructive">
      {error}
    </p>
  );
}

function errorProps(id: string, error: string | undefined) {
  return error === undefined ? {} : { "aria-invalid": true, "aria-describedby": `${id}-error` };
}

function TextField({
  filter,
  id,
  values,
  error,
  onChange,
}: FieldProps<TextFilter<FilterName> | DateFilter<FilterName>>) {
  const text = filter.kind === "text";
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{filter.label}</Label>
      <Input
        id={id}
        name={filter.name}
        type={text ? filter.inputType : "date"}
        value={values[0] ?? ""}
        {...(text
          ? {
              maxLength: filter.maxLength,
              autoComplete: "off",
              spellCheck: false,
              ...(filter.placeholder === undefined ? {} : { placeholder: filter.placeholder }),
            }
          : {})}
        className={cn(text && filter.inputType === "search" ? "w-72" : "w-44")}
        {...errorProps(id, error)}
        onChange={(event) => onChange([event.currentTarget.value], false)}
      />
      <FieldError id={id} error={error} />
    </div>
  );
}

function SelectField({ filter, id, values, error, onChange }: FieldProps<SelectFilter<FilterName>>) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{filter.label}</Label>
      <select
        id={id}
        name={filter.name}
        value={values[0] ?? ""}
        className={FIELD_CLASS}
        {...errorProps(id, error)}
        onChange={(event) => {
          const value = event.currentTarget.value;
          onChange(value === "" ? [] : [value], true);
        }}
      >
        <option value="">{filter.anyLabel}</option>
        {filter.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldError id={id} error={error} />
    </div>
  );
}

/** What a multi filter's button says: "Any", the chosen labels, or how many are chosen. */
function choiceSummary(filter: MultiFilter<FilterName>, values: readonly string[]): string {
  const labels = filter.options
    .filter((option) => values.includes(option.value))
    .map((option) => option.label);
  if (labels.length === 0) {
    return FILTER_STRINGS.any;
  }
  return labels.length <= 2 ? labels.join(", ") : FILTER_STRINGS.selected(labels.length);
}

/** Several choices in a disclosure: a checkbox per value of the document's enum. */
function MultiField({ filter, id, values, error, onChange }: FieldProps<MultiFilter<FilterName>>) {
  return (
    <div className="grid content-start gap-2">
      <span id={`${id}-label`} className="text-sm leading-none font-medium">
        {filter.label}
      </span>
      <details className="group relative">
        <summary
          aria-labelledby={`${id}-label ${id}-summary`}
          className={cn(
            FIELD_CLASS,
            "flex min-w-40 cursor-pointer list-none items-center justify-between gap-2",
          )}
          {...errorProps(id, error)}
        >
          <span id={`${id}-summary`}>{choiceSummary(filter, values)}</span>
          <span aria-hidden="true" className="text-muted-foreground group-open:rotate-180">
            ▾
          </span>
        </summary>
        <fieldset className="absolute z-20 mt-1 grid min-w-56 gap-2 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
          <legend className="sr-only">{filter.label}</legend>
          {filter.options.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={filter.name}
                value={option.value}
                checked={values.includes(option.value)}
                className="size-4 accent-primary"
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  const next = filter.options
                    .map((candidate) => candidate.value)
                    .filter((value) => (value === option.value ? checked : values.includes(value)));
                  onChange(next, true);
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      </details>
      <FieldError id={id} error={error} />
    </div>
  );
}

function FilterField(props: FieldProps<ListFilter>) {
  const { filter } = props;
  switch (filter.kind) {
    case "text":
    case "date":
      return <TextField {...props} filter={filter} />;
    case "select":
      return <SelectField {...props} filter={filter} />;
    case "multi":
      return <MultiField {...props} filter={filter} />;
  }
}

/** The parameters of `query` that are not filters or the position (the page size), kept as they are. */
function keptParameters(query: QueryLike): [string, string][] {
  const names = new Set<string>(BOOKING_FILTERS.map((filter) => filter.name));
  const kept: [string, string][] = [];
  query.forEach((value, name) => {
    if (!names.has(name) && !isPositionParam(name)) {
      kept.push([name, value]);
    }
  });
  return kept;
}

/**
 * The filters of the bookings list (routes.md §3.1): search, status, ticketing, payment, channel and sort in the first
 * row, the other filters of `consoleListBookings` under "More filters", and the filters only a link sets (a customer,
 * a staff member, a deadline instant) as chips that remove themselves.
 */
export function BookingFilters({ className }: { readonly className?: string }) {
  const query = useQuery();
  const router = useRouter();
  const idPrefix = useId();
  const urlKey = query.toString();

  // The fields follow the URL (a navigation, a saved view, the back button) and keep what staff type in between.
  const fromUrl = () => filterValuesOf(query);
  const [values, setValues] = useState<FilterValues>(fromUrl);
  const [errors, setErrors] = useState<FilterErrors>(() => checkFilters(fromUrl()).errors);
  const [syncedKey, setSyncedKey] = useState(urlKey);
  if (syncedKey !== urlKey) {
    setSyncedKey(urlKey);
    setValues(fromUrl());
    setErrors(checkFilters(fromUrl()).errors);
  }

  function apply(next: FilterValues): void {
    const checked = checkFilters(next);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length === 0) {
      router.push(bookingsHref(query, checked.values), { scroll: false });
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    apply(values);
  }

  const urlValues = checkFilters(filterValuesOf(query)).values;
  const field = (filter: ListFilter) => {
    const id = `${idPrefix}-${filter.name}`;
    return (
      <FilterField
        key={filter.name}
        filter={filter}
        id={id}
        values={values[filter.name] ?? []}
        error={errors[filter.name]}
        onChange={(next, applyNow) => {
          const changed = withValues(values, filter.name, next);
          setValues(changed);
          if (applyNow) {
            apply(changed);
          }
        }}
      />
    );
  };
  const more = FORM_FILTERS.filter((filter) => filter.placement === "more");
  const moreInUse = more.some(
    (filter) => (urlValues[filter.name] ?? []).length > 0 || errors[filter.name] !== undefined,
  );
  // A filter only a link sets has no field: a value the API would refuse shows on its chip, which removes it.
  const linkChips = LINK_FILTERS.filter(
    (filter) => (urlValues[filter.name] ?? []).length > 0 || errors[filter.name] !== undefined,
  );

  return (
    <form
      role="search"
      aria-label={FILTER_STRINGS.filtersLabel}
      method="get"
      action={BOOKINGS_PATH}
      onSubmit={submit}
      className={cn("grid gap-4", className)}
    >
      {keptParameters(query).map(([name, value], index) => (
        <input key={`${index}:${name}`} type="hidden" name={name} value={value} />
      ))}
      {LINK_FILTERS.flatMap((filter) =>
        (values[filter.name] ?? []).map((value, index) => (
          <input key={`${filter.name}:${index}`} type="hidden" name={filter.name} value={value} />
        )),
      )}
      <div className="flex flex-wrap items-start gap-4">
        {FORM_FILTERS.filter((filter) => filter.placement === "main").map(field)}
      </div>
      {/* Open when one of its filters is in use, so a filtered list never hides why. */}
      <details open={moreInUse} className="grid gap-4">
        <summary className="cursor-pointer text-sm font-medium">{FILTER_STRINGS.more}</summary>
        <div className="mt-4 flex flex-wrap items-start gap-4">{more.map(field)}</div>
      </details>
      {linkChips.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{FILTER_STRINGS.linkFilters}</span>
          {linkChips.map((filter) => (
            <span
              key={filter.name}
              className={cn(
                "inline-flex items-center gap-2 rounded-full border bg-secondary px-3 py-1",
                errors[filter.name] !== undefined && "border-destructive",
              )}
            >
              {filter.label}:{" "}
              <code>{(errors[filter.name] === undefined ? urlValues : values)[filter.name]?.join(", ")}</code>
              {errors[filter.name] === undefined ? null : (
                <span className="text-destructive">{errors[filter.name]}</span>
              )}
              <Link
                href={bookingsHref(query, withValues(urlValues, filter.name, []))}
                aria-label={FILTER_STRINGS.remove(filter.label)}
                className="font-medium text-muted-foreground hover:text-foreground"
              >
                ×
              </Link>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="outline">
          {FILTER_STRINGS.apply}
        </Button>
        {hasFilters(urlValues) ? (
          <Link href={clearedHref(query)} className={LINK_CLASS}>
            {FILTER_STRINGS.clear}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
