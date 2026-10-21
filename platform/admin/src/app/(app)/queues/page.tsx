import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { QUEUE_LIST_STRINGS as S, formatAge, formatCount } from "@/lib/strings";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: S.title };

type QueueCounts = components["schemas"]["QueueCounts"];

/** A count cell; a non-zero failed count is highlighted, and always written as a number too. */
function Count({ value, attention = false }: { readonly value: number; readonly attention?: boolean }) {
  return (
    <span className={cn("tabular-nums", attention && value > 0 && "font-medium text-red-900")}>
      {formatCount(value)}
    </span>
  );
}

function QueueTable({
  id,
  caption,
  queues,
}: {
  readonly id: string;
  readonly caption: string;
  readonly queues: readonly QueueCounts[];
}) {
  if (queues.length === 0) {
    return <p className="text-sm text-muted-foreground">{S.empty}</p>;
  }
  return (
    <Table data-queues={id}>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{S.columnQueue}</TableHead>
          <TableHead scope="col" className="text-right">
            {S.columnWaiting}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {S.columnActive}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {S.columnDelayed}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {S.columnFailed}
          </TableHead>
          <TableHead scope="col">{S.columnOldest}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {queues.map((queue) => (
          <TableRow key={queue.name} data-queue={queue.name}>
            <TableHead scope="row" className="font-normal">
              <Link
                href={`/queues/${encodeURIComponent(queue.name)}`}
                className="font-mono font-medium underline-offset-4 hover:underline focus-visible:underline"
              >
                {queue.name}
              </Link>
            </TableHead>
            <TableCell className="text-right">
              <Count value={queue.waiting} />
            </TableCell>
            <TableCell className="text-right">
              <Count value={queue.active} />
            </TableCell>
            <TableCell className="text-right">
              <Count value={queue.delayed} />
            </TableCell>
            <TableCell className="text-right">
              <Count value={queue.failed} attention />
            </TableCell>
            <TableCell>
              {queue.oldestWaitingSeconds === null ? (
                <span className="text-muted-foreground">{S.noneWaiting}</span>
              ) : (
                formatAge(queue.oldestWaitingSeconds)
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Section({
  id,
  title,
  intro,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid content-start gap-3">
      <div className="grid gap-1">
        <h2 id={id} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{intro}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * `/queues` (README §2, PF-84): the BullMQ counts of every queue of both backends from `adminListQueues`, in two
 * tables: the platform queues (their failed jobs can be retried) and the OTA queues, `ota-tenant-ops` included (view
 * only). Each row shows the waiting, active, delayed and failed jobs and the age of the oldest waiting one, and links
 * to the queue's failed jobs (`/queues/<queue>`). The API reads Redis only; while it cannot, it answers
 * `SERVICE_UNAVAILABLE` and the page says so.
 */
export default async function QueuesPage() {
  const api = await platformApi();
  const result = await api.GET("/v1/admin/queues");
  if (
    result.error !== undefined &&
    (result.error.code === "UNAUTHENTICATED" || result.error.code === "TOKEN_EXPIRED")
  ) {
    redirect("/sign-in");
  }
  const queues = result.data?.data ?? [];
  return (
    <div className="mx-auto grid max-w-6xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{S.title}</h1>
        <p className="text-muted-foreground">{S.intro}</p>
      </div>
      {result.error === undefined ? (
        <>
          <Section id="queues-platform" title={S.platformTitle} intro={S.platformIntro}>
            <QueueTable
              id="platform"
              caption={S.platformTitle}
              queues={queues.filter((queue) => queue.owner === "platform")}
            />
          </Section>
          <Section id="queues-ota" title={S.otaTitle} intro={S.otaIntro}>
            {/* Every queue that is not the platform's is view only, whatever owner a newer API might name. */}
            <QueueTable
              id="ota"
              caption={S.otaTitle}
              queues={queues.filter((queue) => queue.owner !== "platform")}
            />
          </Section>
        </>
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>
            {result.error.code === "SERVICE_UNAVAILABLE" ? S.unavailable : errorMessage(result.error)}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
