import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { DomainTable, type DomainRow } from "@/app/(app)/domains/domain-table";
import type { ListPage } from "@/components/data-table";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { DOMAIN_KIND_LABELS, DOMAIN_LIST_STRINGS as S, STATUS_LABELS } from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type AdminDomain = Schemas["AdminDomain"];
type Kind = AdminDomain["kind"];
type VerificationStatus = AdminDomain["verificationStatus"];
type TlsStatus = AdminDomain["tlsStatus"];
type SearchParams = Record<string, string | string[] | undefined>;

/** The filters of `adminListDomains` that the URL carries; an absent or empty parameter is no filter. */
interface DomainFilters {
  readonly kind?: Kind;
  readonly verificationStatus?: VerificationStatus;
  readonly tlsStatus?: TlsStatus;
  readonly cursor?: string;
}

// Every value of the platform document has a label: a new one fails the type check until it has one.
const KIND_NAMES: Readonly<Record<Kind, string>> = DOMAIN_KIND_LABELS;
const VERIFICATION_NAMES: Readonly<Record<VerificationStatus, string>> = STATUS_LABELS.domain;
const TLS_NAMES: Readonly<Record<TlsStatus, string>> = STATUS_LABELS.tls;

/** The `maxLength` of the `Cursor` parameter. */
const CURSOR_MAX_LENGTH = 512;

/** A query parameter: `""` when absent, `undefined` when repeated (a URL no filter bar writes). */
function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : undefined;
}

/** `value` is empty (no filter) or one of `names`' keys. */
function oneOf<Value extends string>(
  names: Readonly<Record<Value, string>>,
  value: string,
): value is Value | "" {
  return value === "" || Object.hasOwn(names, value);
}

/**
 * The filters of the page URL, or `undefined` when one of them is not a value the API takes: the page then says so
 * instead of showing an unfiltered list under a filtered address.
 */
function parseDomainFilters(params: SearchParams): DomainFilters | undefined {
  const kind = single(params.kind);
  const verificationStatus = single(params.verificationStatus);
  const tlsStatus = single(params.tlsStatus);
  const cursor = single(params.cursor);
  if (
    kind === undefined ||
    verificationStatus === undefined ||
    tlsStatus === undefined ||
    cursor === undefined
  ) {
    return undefined;
  }
  if (
    !oneOf(KIND_NAMES, kind) ||
    !oneOf(VERIFICATION_NAMES, verificationStatus) ||
    !oneOf(TLS_NAMES, tlsStatus) ||
    cursor.length > CURSOR_MAX_LENGTH
  ) {
    return undefined;
  }
  return {
    ...(kind === "" ? {} : { kind }),
    ...(verificationStatus === "" ? {} : { verificationStatus }),
    ...(tlsStatus === "" ? {} : { tlsStatus }),
    ...(cursor === "" ? {} : { cursor }),
  };
}

/**
 * The fields of one host that the table shows. The rows go to a client component, so everything they hold is sent to
 * the browser: only these fields go, whatever else an answer might carry.
 */
function rowOf(domain: AdminDomain): DomainRow {
  return {
    id: domain.id,
    tenantId: domain.tenantId,
    tenantKey: domain.tenantKey,
    hostname: domain.hostname,
    kind: domain.kind,
    isPrimary: domain.isPrimary,
    verificationStatus: domain.verificationStatus,
    verifiedAt: domain.verifiedAt,
    verificationDeadlineAt: domain.verificationDeadlineAt,
    lastCheckedAt: domain.lastCheckedAt,
    lastCheckError: domain.lastCheckError,
    checkFailures: domain.checkFailures,
    tlsStatus: domain.tlsStatus,
    tlsExpiresAt: domain.tlsExpiresAt,
    tlsCheckedAt: domain.tlsCheckedAt,
    createdAt: domain.createdAt,
  };
}

function sessionEnded(error: ApiError | undefined): boolean {
  return error?.code === "UNAUTHENTICATED" || error?.code === "TOKEN_EXPIRED";
}

const LINK_CLASS = "font-medium underline underline-offset-4";

/**
 * `/domains` (README §2, flows/custom-domains.md step 8, flows/platform-admin-operations.md §G, PADR-0004, PF-92): the
 * storefront hosts of every OTA from `adminListDomains`, newest first: each custom domain with its DNS verification
 * (the window's end while pending, the last check and what it found missing, the failed daily re-checks) and its
 * certificate (TLS status, expiry, last probe), and the Velexis sub-domains. `FilterBar` keeps the kind, the DNS
 * verification status and the TLS status in the URL (the dashboard links `?kind=custom&verificationStatus=pending`)
 * and `DataTable` pages with the cursor of the answer, so every list is a link another admin can open. Each host can
 * be checked now ("Re-check"); a custom domain can be removed with a reason ("Remove"). A filter the API would refuse
 * shows a notice instead of a list and asks the API for no list.
 */
export default async function DomainsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const filters = parseDomainFilters(await searchParams);
  const api = await platformApi();
  const domains =
    filters === undefined ? undefined : await api.GET("/v1/admin/domains", { params: { query: filters } });
  if (sessionEnded(domains?.error)) {
    redirect("/sign-in");
  }

  const fields: FilterField[] = [
    {
      kind: "select",
      name: "kind",
      label: S.kindLabel,
      options: Object.entries(KIND_NAMES).map(([value, label]) => ({ value, label })),
    },
    {
      kind: "select",
      name: "verificationStatus",
      label: S.verificationLabel,
      options: Object.entries(VERIFICATION_NAMES).map(([value, label]) => ({ value, label })),
    },
    {
      kind: "select",
      name: "tlsStatus",
      label: S.tlsLabel,
      options: Object.entries(TLS_NAMES).map(([value, label]) => ({ value, label })),
    },
  ];

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{S.title}</h1>
        <p className="text-muted-foreground">{S.intro}</p>
      </div>
      <FilterBar fields={fields} label={S.filtersLabel} />
      {domains === undefined || domains.error?.code === "VALIDATION_FAILED" ? (
        <Alert>
          <AlertDescription>
            <p>{S.invalidFilters}</p>
            {/* The filter bar's "Clear filters" shows only for a filter it has, not for a bad cursor alone. */}
            <p>
              <Link href="/domains" className={LINK_CLASS}>
                {S.showAll}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : domains.error === undefined ? (
        <DomainTable
          domains={domains.data.data.map(rowOf)}
          page={{ nextCursor: domains.data.page.nextCursor } satisfies ListPage}
        />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(domains.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
