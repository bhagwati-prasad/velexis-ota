import type { components } from "@velexis/api-types/platform";

import { DateTime } from "@/components/date-time";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DNS_CHECK_ERRORS, DOMAINS_STRINGS } from "@/lib/strings";

/** A storefront domain as `listDomains` answers it. */
export type Domain = components["schemas"]["Domain"];

/**
 * The words for a `lastCheckError` (flows/custom-domains.md step 3: `txt_missing`, `txt_mismatch`, `cname_missing`,
 * `cname_wrong_target`, `a_wrong_address`, `dns_timeout`); a value the portal does not know yet reads as the
 * general message, so a code is never shown raw.
 */
export function dnsCheckMessage(lastCheckError: string): string {
  return Object.hasOwn(DNS_CHECK_ERRORS, lastCheckError)
    ? (DNS_CHECK_ERRORS[lastCheckError] ?? DOMAINS_STRINGS.checkFailed)
    : DOMAINS_STRINGS.checkFailed;
}

export interface DnsRecordsTableProps {
  /** The domain whose records and last check to show. */
  readonly domain: Pick<
    Domain,
    | "hostname"
    | "verificationStatus"
    | "dnsRecords"
    | "verificationDeadlineAt"
    | "lastCheckedAt"
    | "lastCheckError"
  >;
  /** The IANA zone of the dates (the OTA's); UTC when absent. */
  readonly timeZone?: string;
}

/** The result of the last DNS check: when it ran and what it found, in words. */
function LastCheck({
  domain,
  timeZone,
}: {
  readonly domain: DnsRecordsTableProps["domain"];
  readonly timeZone: string;
}) {
  if (domain.lastCheckedAt === null) {
    return <span>{DOMAINS_STRINGS.notChecked}</span>;
  }
  return (
    <span>
      <DateTime value={domain.lastCheckedAt} timeZone={timeZone} />
      {": "}
      <span data-check-result={domain.lastCheckError ?? "passed"}>
        {domain.lastCheckError === null
          ? DOMAINS_STRINGS.checkPassed
          : dnsCheckMessage(domain.lastCheckError)}
      </span>
    </span>
  );
}

/**
 * The DNS records to create for a custom domain and the result of its last check (README §4, PADR-0004 item 2): the
 * `TXT _velexis.<host>` ownership record and the routing record (`CNAME`, or `A`/`AAAA` for an apex), as the API lists
 * them; then, for a domain that is not verified yet, the last check and its deadline. The sub-domain needs no record.
 * A server component; the copy buttons and the domain actions come with PFE-022.
 */
export function DnsRecordsTable({ domain, timeZone = "UTC" }: DnsRecordsTableProps) {
  const pending = domain.verificationStatus !== "verified";
  return (
    <div className="grid gap-3" data-dns-records={domain.hostname}>
      {domain.dnsRecords.length === 0 ? (
        <p className="text-sm text-muted-foreground">{DOMAINS_STRINGS.recordsNone}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{DOMAINS_STRINGS.recordsCaption(domain.hostname)}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{DOMAINS_STRINGS.recordType}</TableHead>
              <TableHead scope="col">{DOMAINS_STRINGS.recordName}</TableHead>
              <TableHead scope="col">{DOMAINS_STRINGS.recordValue}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {domain.dnsRecords.map((record, index) => (
              // The records have no id of their own; their position in the API's list is stable for one answer.
              <TableRow key={`${index}:${record.type}:${record.name}`} data-record={record.type}>
                <TableCell>{record.type}</TableCell>
                <TableCell className="whitespace-normal break-all">
                  <code>{record.name}</code>
                </TableCell>
                <TableCell className="whitespace-normal break-all">
                  <code>{record.value}</code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {pending ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          <div className="contents" data-detail="lastCheck">
            <dt className="text-muted-foreground">{DOMAINS_STRINGS.lastCheck}</dt>
            <dd>
              <LastCheck domain={domain} timeZone={timeZone} />
            </dd>
          </div>
          {domain.verificationDeadlineAt === null ? null : (
            <div className="contents" data-detail="verificationDeadlineAt">
              <dt className="text-muted-foreground">{DOMAINS_STRINGS.verifyBy}</dt>
              <dd>
                <DateTime value={domain.verificationDeadlineAt} timeZone={timeZone} />
              </dd>
            </div>
          )}
        </dl>
      ) : null}
    </div>
  );
}
