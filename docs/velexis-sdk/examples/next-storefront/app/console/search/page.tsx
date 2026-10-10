import { mustBeStaff } from "@/lib/velexis";
import { SearchConsole } from "./search-console";

/** Console search: seat availability per booking class + raw Amadeus offers (net) with console-scope pricing. */
export default async function ConsoleSearchPage() {
  const me = await mustBeStaff({ permissions: ["amadeus:read"], returnTo: "/console/search" });
  return (
    <section>
      <h1>Availability &amp; raw search</h1>
      <p className="muted">
        {me.tenant.environment === "test" ? "Amadeus TEST" : "Amadeus PRODUCTION"} · offices {me.tenant.supplier.officeIds.join(", ") || "—"} · raw prices are NET
      </p>
      <SearchConsole canPrice={me.permissions.includes("bookings:write")} />
    </section>
  );
}
