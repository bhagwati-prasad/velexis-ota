"use client";

import { useId, useState } from "react";
import { useLocationSearch } from "@velexis/ota-sdk/react";
import type { Schemas } from "@velexis/ota-sdk";

/**
 * Airport / city autocomplete. Debounced `reference.locations.search` (publishable key, direct to the API).
 * Submits the IATA code in a hidden input named `name`.
 */
export function LocationInput({ name, label, defaultCode = "" }: { name: string; label: string; defaultCode?: string }) {
  const id = useId();
  const [text, setText] = useState(defaultCode);
  const [picked, setPicked] = useState<Schemas["Location"] | null>(null);
  const [open, setOpen] = useState(false);
  const { locations, loading, error } = useLocationSearch(picked ? "" : text, { debounceMs: 200, minLength: 2, limit: 8 });

  return (
    <div className="location-input">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={picked ? `${picked.name} (${picked.iataCode})` : text}
        onChange={(e) => {
          setPicked(null);
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        role="combobox"
        aria-expanded={open && locations.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        autoComplete="off"
        required
      />
      <input type="hidden" name={name} value={picked?.iataCode ?? (/^[A-Za-z]{3}$/.test(text) ? text.toUpperCase() : "")} />
      {loading && <span className="muted">Searching…</span>}
      {error && <span className="error">{error.message}</span>}
      {open && locations.length > 0 && (
        <ul id={`${id}-list`} role="listbox">
          {locations.map((l) => (
            <li
              key={l.id}
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
                setPicked(l);
                setOpen(false);
              }}
            >
              <strong>{l.iataCode}</strong> {l.subType === "CITY" ? `${l.cityName} (all airports)` : l.name} · {l.countryName}
              {l.subType === "CITY" && l.airports.length > 0 && <span className="muted"> {l.airports.map((a) => a.iataCode).join(", ")}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
