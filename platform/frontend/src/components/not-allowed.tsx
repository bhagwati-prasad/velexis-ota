import { ShieldX } from "lucide-react";
import Link from "next/link";

import { otaPath, type TenantRole } from "@/lib/roles";
import { NOT_ALLOWED_STRINGS, ROLE_LABELS } from "@/lib/strings";

export interface NotAllowedProps {
  /** The OTA of the page. */
  readonly tenantId: string;
  /** The caller's role in it (`getTenant` `myRole`), named on the page. */
  readonly role: TenantRole;
}

/**
 * The not-allowed page (README §2 and §4): what a page of an OTA renders instead of its content when the caller's
 * role may not open it (scope §1.2), for someone who reached it by URL, since the navigation never links to it. It
 * names the role, says who can help and leads back to the OTA overview. The API refuses the page's operations for
 * that role again (`403 FORBIDDEN`). A server component; it renders the page's one `h1`.
 */
export function NotAllowed({ tenantId, role }: NotAllowedProps) {
  return (
    <section
      aria-labelledby="not-allowed-title"
      data-page="not-allowed"
      className="mx-auto grid max-w-xl gap-4 py-8"
    >
      <ShieldX aria-hidden="true" className="size-8 text-muted-foreground" />
      <h1 id="not-allowed-title" className="text-3xl font-semibold tracking-tight">
        {NOT_ALLOWED_STRINGS.title}
      </h1>
      <p>{NOT_ALLOWED_STRINGS.intro(ROLE_LABELS[role])}</p>
      <p className="text-muted-foreground">{NOT_ALLOWED_STRINGS.askOwner}</p>
      <p>
        <Link href={otaPath(tenantId)} className="font-medium underline underline-offset-4">
          {NOT_ALLOWED_STRINGS.backToOverview}
        </Link>
      </p>
    </section>
  );
}
