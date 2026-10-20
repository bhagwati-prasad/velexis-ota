"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { CURSOR_PARAM, listHref, type ReadableSearchParams } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FILTER_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/** One choice of a select filter. */
export interface FilterOption {
  /** The value of the query parameter (a status of the platform document, a plan code). */
  readonly value: string;
  readonly label: string;
}

/** A free-text filter (`q`: key, name or owner e-mail); applied when the admin submits it. */
export interface SearchFilterField {
  readonly kind: "search";
  /** The query parameter of the list operation. */
  readonly name: string;
  readonly label: string;
  readonly placeholder?: string;
  /** The `maxLength` of the parameter in the platform document; `SEARCH_MAX_LENGTH` (254, as `q`) by default. */
  readonly maxLength?: number;
}

/** A filter with fixed choices (`status`, `planCode`, `kind`); applied as soon as the admin picks a choice. */
export interface SelectFilterField {
  readonly kind: "select";
  /** The query parameter of the list operation. */
  readonly name: string;
  readonly label: string;
  readonly options: readonly FilterOption[];
  /** The label of the empty choice (no filter); "Any" by default. */
  readonly anyLabel?: string;
}

export type FilterField = SearchFilterField | SelectFilterField;

/**
 * The longest free text a search filter takes unless its field says otherwise: the `maxLength` of `q` in
 * `adminListTenants` and `adminListAccounts`, the length of the longest e-mail address, so an owner's whole address
 * can be searched (PF-81).
 */
export const SEARCH_MAX_LENGTH = 254;

type FilterValues = Readonly<Record<string, string>>;

function valuesOf(
  fields: readonly FilterField[],
  searchParams: { get(name: string): string | null },
): FilterValues {
  return Object.fromEntries(fields.map((field) => [field.name, searchParams.get(field.name) ?? ""]));
}

/**
 * The URL after applying `values`: every filter of `fields` set or removed, the cursor removed (a new filter starts
 * again on the first page), every other parameter of `current` kept.
 */
export function filteredHref(
  pathname: string,
  current: ReadableSearchParams,
  fields: readonly FilterField[],
  values: FilterValues,
): string {
  const changes: Record<string, string | null> = { [CURSOR_PARAM]: null };
  for (const field of fields) {
    const value = values[field.name] ?? "";
    changes[field.name] = field.kind === "search" ? value.trim() : value;
  }
  return listHref(pathname, current, changes);
}

export interface FilterBarProps {
  /** The filters of the list, in display order. */
  readonly fields: readonly FilterField[];
  /** The accessible name of the search landmark; "Filters" by default. */
  readonly label?: string;
  readonly className?: string;
}

/**
 * The filters of a list page (README §4): their values live in the URL's search params, so a filtered list is a link
 * an admin can share (PF-81). A select applies at once and a search applies on submit; either way the other filters
 * and parameters stay, and the cursor goes (the list starts again on its first page). The server component of the
 * page reads the same params and calls the list operation with them.
 *
 * Without JavaScript the form is a plain GET form with the other parameters as hidden fields, so it still works.
 */
export function FilterBar({ fields, label = FILTER_STRINGS.label, className }: FilterBarProps) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams() ?? new URLSearchParams();
  const router = useRouter();
  const idPrefix = useId();
  const urlKey = searchParams.toString();

  // The fields follow the URL (a navigation, the back button, "Clear filters") and keep what the admin types between.
  const [values, setValues] = useState<FilterValues>(() => valuesOf(fields, searchParams));
  const [syncedKey, setSyncedKey] = useState(urlKey);
  if (syncedKey !== urlKey) {
    setSyncedKey(urlKey);
    setValues(valuesOf(fields, searchParams));
  }

  function apply(next: FilterValues): void {
    router.push(filteredHref(pathname, searchParams, fields, next), { scroll: false });
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    apply(values);
  }

  const names = new Set(fields.map((field) => field.name));
  const kept: [string, string][] = [];
  searchParams.forEach((value, name) => {
    if (!names.has(name) && name !== CURSOR_PARAM) {
      kept.push([name, value]);
    }
  });
  const filtered = fields.some((field) => (searchParams.get(field.name) ?? "") !== "");
  const cleared: Record<string, null> = { [CURSOR_PARAM]: null };
  for (const field of fields) {
    cleared[field.name] = null;
  }

  return (
    <form
      role="search"
      aria-label={label}
      method="get"
      action={pathname}
      onSubmit={submit}
      className={cn("flex flex-wrap items-end gap-4", className)}
    >
      {kept.map(([name, value], index) => (
        <input key={`${index}:${name}`} type="hidden" name={name} value={value} />
      ))}
      {fields.map((field) => {
        const id = `${idPrefix}-${field.name}`;
        const value = values[field.name] ?? "";
        return (
          <div key={field.name} className="grid gap-2">
            <Label htmlFor={id}>{field.label}</Label>
            {field.kind === "search" ? (
              <Input
                id={id}
                name={field.name}
                type="search"
                value={value}
                maxLength={field.maxLength ?? SEARCH_MAX_LENGTH}
                placeholder={field.placeholder}
                autoComplete="off"
                spellCheck={false}
                className="w-64"
                onChange={(event) => {
                  const typed = event.currentTarget.value;
                  setValues((current) => ({ ...current, [field.name]: typed }));
                }}
              />
            ) : (
              <select
                id={id}
                name={field.name}
                value={value}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onChange={(event) => {
                  const next = { ...values, [field.name]: event.currentTarget.value };
                  setValues(next);
                  apply(next);
                }}
              >
                <option value="">{field.anyLabel ?? FILTER_STRINGS.any}</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline">
          <Search aria-hidden="true" />
          {FILTER_STRINGS.search}
        </Button>
        {filtered ? (
          <Link
            href={listHref(pathname, searchParams, cleared)}
            className="text-sm font-medium underline underline-offset-4"
          >
            {FILTER_STRINGS.clear}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
