import Link from "next/link";
import { customerClient, getStorefront, mustBeCustomer } from "@/lib/velexis";
import { deleteSavedTravelerAction } from "../actions";
import { TravelerForm } from "./traveler-form";

/** Saved travellers (documents are listed masked; full numbers only on the edit form). */
export default async function SavedTravelersPage() {
  await mustBeCustomer("/account/travelers");
  const sf = await getStorefront();
  if (!sf.features.savedTravelers) return <p>Saved travellers are not available.</p>;
  const vx = await customerClient();
  const travelers: Awaited<ReturnType<typeof vx.account.savedTravelers.get>>[] = [];
  for await (const t of await vx.account.savedTravelers.list({ limit: 20 })) travelers.push(t);

  return (
    <section>
      <h1>Saved travellers</h1>
      <nav className="tabs">
        <Link href="/account">Profile</Link>
        <Link href="/account/travelers" aria-current="page">Saved travellers</Link>
      </nav>
      {travelers.length === 0 && <p>No saved travellers yet — add one to check out faster.</p>}
      <ul>
        {travelers.map((t) => (
          <li key={t.id}>
            <strong>
              {t.name.firstName} {t.name.lastName}
            </strong>{" "}
            {t.isAccountHolder && <span className="tag">you</span>} · born {t.dateOfBirth}
            {t.documents.map((d) => (
              <span key={d.id} className={`muted doc-${d.expiryStatus}`}>
                {" "}
                · {d.documentType.toLowerCase()} {d.numberMasked} {d.expiryStatus === "expiring_soon" ? "(expires soon)" : d.expiryStatus === "expired" ? "(expired)" : ""}
              </span>
            ))}
            {t.loyaltyPrograms.map((l) => (
              <span key={`${l.programOwner}${l.id}`} className="muted"> · {l.programOwner} {l.id}</span>
            ))}
            <form action={deleteSavedTravelerAction.bind(null, t.id)} className="inline">
              <button type="submit">Remove</button>
            </form>
          </li>
        ))}
      </ul>
      <h2>Add a traveller</h2>
      <TravelerForm />
    </section>
  );
}
