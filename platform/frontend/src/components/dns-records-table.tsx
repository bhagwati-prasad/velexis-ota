"use client";

import type { components } from "@velexis/api-types/platform";
import { Copy } from "lucide-react";
import { useState } from "react";

import { DateTime } from "@/components/date-time";
import { Button } from "@/components/ui/button";
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
type DnsRecord = components["schemas"]["DnsRecord"];

/**
 * The words for a `lastCheckError` (flows/custom-domains.md step 2: `txt_missing`, `txt_mismatch`, `cname_missing`,
 * `cname_wrong_target`, `a_wrong_address`, `dns_timeout`); a value the portal does not know yet reads as the
 * general message, so a code is never shown raw. A plain function of a client module: server code must not call it
 * (Next.js hands server components a reference to it, not the function), only this module and tests do.
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

/** The address record types the API lists for an apex domain, in its order (`A`, and `AAAA` only when it is set). */
function addressTypes(records: readonly DnsRecord[]): string[] {
  return [
    ...new Set(
      records.filter((record) => record.type === "A" || record.type === "AAAA").map((record) => record.type),
    ),
  ];
}

/**
 * What the records are for (PADR-0004 item 2): the `TXT` record proves ownership; the routing takes either the `CNAME`
 * (a sub-domain such as `travel.acme.com`) or the address records (an apex such as `acme.com`, which cannot have a
 * CNAME). Only the record types the API lists are named, so an `AAAA` record is mentioned only when the platform has an
 * IPv6 address. A verified domain is told to keep them, since the daily re-check reads them.
 */
function RecordsGuide({ domain }: { readonly domain: DnsRecordsTableProps["domain"] }) {
  const records = domain.dnsRecords;
  const hasTxt = records.some((record) => record.type === "TXT");
  const hasCname = records.some((record) => record.type === "CNAME");
  const addresses = addressTypes(records);
  const routing = hasCname || addresses.length > 0;
  return (
    <div className="grid gap-1 text-sm" data-records-guide="">
      <p>
        {domain.verificationStatus === "verified"
          ? DOMAINS_STRINGS.keepRecords
          : DOMAINS_STRINGS.recordsIntro}
      </p>
      {hasTxt || routing ? (
        <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
          {hasTxt ? <li data-guide="ownership">{DOMAINS_STRINGS.ownershipStep}</li> : null}
          {routing ? <li data-guide="routing">{DOMAINS_STRINGS.routingStep(hasCname, addresses)}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

/** What the last copy did, announced in the table's live region. */
type CopyOutcome = { readonly status: "copied"; readonly message: string } | { readonly status: "failed" };

interface CopyableValueProps {
  /** The text to show and copy (a record's name or value). */
  readonly value: string;
  /** The button's accessible name ("Copy the value of the TXT record"). */
  readonly label: string;
  /** What the live region says after a copy. */
  readonly copiedMessage: string;
  readonly onOutcome: (outcome: CopyOutcome) => void;
}

/**
 * A value of a record with its copy button. The button has no text of its own (only its accessible name and a
 * tooltip), so the cell reads as the value it copies; the outcome goes to the table's live region, which every button
 * shares and none is described by (it would read another record's outcome as the button's description).
 */
function CopyableValue({ value, label, copiedMessage, onOutcome }: CopyableValueProps) {
  async function copy(): Promise<void> {
    try {
      // `navigator.clipboard` is missing outside a secure context; that lands in the catch too.
      await navigator.clipboard.writeText(value);
      onOutcome({ status: "copied", message: copiedMessage });
    } catch {
      onOutcome({ status: "failed" });
    }
  }
  return (
    <div className="flex items-start gap-1">
      <code className="min-w-0 flex-1 self-center break-all">{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={label}
        title={label}
        onClick={() => void copy()}
      >
        <Copy aria-hidden="true" />
      </Button>
    </div>
  );
}

/**
 * The DNS records to create for a custom domain and the result of its last check (README §4, PADR-0004 item 2): what
 * each record is for (the `TXT _velexis.<host>` ownership record, and the routing record: `CNAME`, or `A`/`AAAA` for
 * an apex), then the records as the API lists them, each name and value with a copy button (the outcome is announced
 * in one polite live region below the table). For a pending domain, the last check in words and the verification
 * deadline follow; a failed domain shows its last check only (its window has ended; "Check now" starts a new one). The
 * sub-domain needs no record. A client component for the copy buttons; the values come from its props (the page's
 * list and the add form's answer) and go to the clipboard only when the person asks.
 */
export function DnsRecordsTable({ domain, timeZone = "UTC" }: DnsRecordsTableProps) {
  const [outcome, setOutcome] = useState<CopyOutcome | undefined>(undefined);
  const verified = domain.verificationStatus === "verified";
  return (
    <div className="grid gap-3" data-dns-records={domain.hostname}>
      {domain.dnsRecords.length === 0 ? (
        <p className="text-sm text-muted-foreground">{DOMAINS_STRINGS.recordsNone}</p>
      ) : (
        <>
          <RecordsGuide domain={domain} />
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
                  <TableCell className="align-top leading-8">{record.type}</TableCell>
                  <TableCell className="whitespace-normal">
                    <CopyableValue
                      value={record.name}
                      label={DOMAINS_STRINGS.copyName(record.type)}
                      copiedMessage={DOMAINS_STRINGS.copiedName(record.type)}
                      onOutcome={setOutcome}
                    />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <CopyableValue
                      value={record.value}
                      label={DOMAINS_STRINGS.copyValue(record.type)}
                      copiedMessage={DOMAINS_STRINGS.copiedValue(record.type)}
                      onOutcome={setOutcome}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p
            role="status"
            aria-live="polite"
            className="min-h-5 text-sm text-muted-foreground"
            data-copy-status=""
          >
            {outcome === undefined
              ? ""
              : outcome.status === "copied"
                ? outcome.message
                : DOMAINS_STRINGS.copyFailed}
          </p>
        </>
      )}
      {verified ? null : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          <div className="contents" data-detail="lastCheck">
            <dt className="text-muted-foreground">{DOMAINS_STRINGS.lastCheck}</dt>
            <dd>
              <LastCheck domain={domain} timeZone={timeZone} />
            </dd>
          </div>
          {domain.verificationStatus !== "pending" || domain.verificationDeadlineAt === null ? null : (
            <div className="contents" data-detail="verificationDeadlineAt">
              <dt className="text-muted-foreground">{DOMAINS_STRINGS.verifyBy}</dt>
              <dd>
                <DateTime value={domain.verificationDeadlineAt} timeZone={timeZone} />
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
