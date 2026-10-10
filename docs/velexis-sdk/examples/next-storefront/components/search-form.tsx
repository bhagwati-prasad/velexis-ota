"use client";

import { useActionState, useState } from "react";
import { searchFlightsAction } from "@/app/flights/actions";
import { initialFormState } from "@/lib/action-state";
import { ErrorMessage } from "./error-message";
import { LocationInput } from "./location-input";

export function SearchForm({ defaults }: { defaults: { departureDate: string; returnDate: string; minDate: string } }) {
  const [state, action, pending] = useActionState(searchFlightsAction, initialFormState);
  const [tripType, setTripType] = useState<"round_trip" | "one_way">("round_trip");
  const [adults, setAdults] = useState(1);

  return (
    <form action={action} className="search-form">
      <fieldset className="trip-type">
        <label>
          <input type="radio" name="tripType" value="round_trip" checked={tripType === "round_trip"} onChange={() => setTripType("round_trip")} /> Return
        </label>
        <label>
          <input type="radio" name="tripType" value="one_way" checked={tripType === "one_way"} onChange={() => setTripType("one_way")} /> One way
        </label>
      </fieldset>
      <LocationInput name="origin" label="From" />
      <LocationInput name="destination" label="To" />
      <label>
        Depart
        <input type="date" name="departureDate" defaultValue={defaults.departureDate} min={defaults.minDate} required />
      </label>
      {tripType === "round_trip" && (
        <label>
          Return
          <input type="date" name="returnDate" defaultValue={defaults.returnDate} min={defaults.minDate} required />
        </label>
      )}
      <label>
        Adults
        <input type="number" name="adults" min={1} max={9} value={adults} onChange={(e) => setAdults(Number(e.target.value))} />
      </label>
      <label>
        Children (2–11)
        <input type="number" name="children" min={0} max={8} defaultValue={0} />
      </label>
      <label>
        Infants (under 2)
        <input type="number" name="infants" min={0} max={adults} defaultValue={0} />
      </label>
      <label>
        Cabin
        <select name="travelClass" defaultValue="ECONOMY">
          <option value="ECONOMY">Economy</option>
          <option value="PREMIUM_ECONOMY">Premium economy</option>
          <option value="BUSINESS">Business</option>
          <option value="FIRST">First</option>
        </select>
      </label>
      <label>
        <input type="checkbox" name="nonStop" /> Direct flights only
      </label>
      <button type="submit" disabled={pending}>{pending ? "Searching flights… (up to a minute)" : "Search flights"}</button>
      {state.message && <p className="error">{state.message}</p>}
      <ErrorMessage error={state.error} showFields />
    </form>
  );
}
