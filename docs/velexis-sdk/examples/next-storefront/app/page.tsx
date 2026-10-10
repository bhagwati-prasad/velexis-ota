import { getStorefront } from "@/lib/velexis";
import { SearchForm } from "@/components/search-form";

// flights.search can take up to 60 s (Amadeus); server actions inherit the page's max duration on serverless hosts.
export const maxDuration = 60;

/** Home: flight search form (location autocomplete runs client-side with the publishable key). */
export default async function HomePage() {
  const sf = await getStorefront();
  const today = new Date();
  const inDays = (d: number) => new Date(today.getTime() + d * 864e5).toISOString().slice(0, 10);
  return (
    <section className="hero">
      <h1>{sf.seo.defaultTitle}</h1>
      <SearchForm defaults={{ departureDate: inDays(14), returnDate: inDays(21), minDate: inDays(0) }} />
    </section>
  );
}
