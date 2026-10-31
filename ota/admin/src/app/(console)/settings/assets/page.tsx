// `/settings/assets` (README §5, routes.md §9, OAD-014): the images the OTA uploaded for its storefront (logos, favicon,
// social sharing image, page images), through `console.settings.assets.list` (`settings:read`, every role), newest
// first, with the API's `kind` filter and cursor paging. Images are shared by the test and live environments.
//
// The URL is the state: `kind` (one of the kinds; none: every image) and `cursor` (the `page.nextCursor` of the
// previous page, which "Next page" sets and "First page" drops). A link with a value the API would refuse is never
// sent: the page says so, with a link to every image. Each row: the file name with a link that opens the image (its
// public address on the API host, `getPublicAsset`; the admin's CSP shows images of its own origin only, so the list
// names them instead of showing them), the kind, the type read from its bytes, the size, the dimensions, the upload
// time in the OTA's time zone and the id the storefront settings and pages reference.
//
// Owners and admins (`settings:write`) get "Upload an image" and each row's "Delete" (upload-form.tsx, on
// `ConfirmDialog` with a key rendered here once per render); every other role sees the list read only (the button
// disabled, naming the permission). The page says that images are stored as uploaded, metadata included (OADR-0012).
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this
// list, an ended session to the portal (`redirectOnSessionError`), and every other API error renders the console's
// message for its code with the request id, with "Try again" (and "First page" for `400 VALIDATION_FAILED`, a cursor
// the API refused).
import type { StaffPermission, StorefrontAsset } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { formatInstant, queryOf } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { PermissionGate } from "@/components/permission-gate";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can, type StaffEnvironment } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { cn } from "@/lib/utils";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import {
  ASSETS_PAGE_SIZE,
  ASSETS_PATH,
  ASSET_KINDS,
  UPLOAD_LABEL,
  assetHref,
  assetKindLabel,
  assetListHref,
  assetListQueryOf,
  dimensionsOf,
  formatBytes,
  type AssetKind,
} from "./asset-rules";
import { DeleteAssetDialog, UploadAssetDialog } from "./upload-form";

export const metadata: Metadata = { title: "Storefront images" };

const PAGE_STRINGS = Object.freeze({
  title: "Storefront images",
  intro:
    "Logos, the favicon, the social sharing image and the images of content pages. They are shared by the test and live environments; choose them in the storefront settings or reference a page image in a page.",
  metadata:
    "Images are stored exactly as uploaded: metadata in a file (camera, location, author) is kept and public with the image.",
  readOnly: "Read only: uploading and deleting images needs the permission settings:write.",
  storefront: "Choose the logos and the favicon in the storefront settings.",
  filters: "Image kind",
  all: "All images",
  pages: "Pages",
  firstPage: "First page",
  nextPage: "Next page",
  columns: {
    image: "Image",
    kind: "Kind",
    type: "Type",
    size: "Size",
    dimensions: "Dimensions",
    uploaded: "Uploaded",
    id: "Id",
    actions: "Actions",
  },
  open: "Open",
  openLabel: (fileName: string) => `Open ${fileName} in a new tab`,
  empty: "No image of this kind yet.",
  emptyAll: "No image yet. Upload the logo and the favicon first.",
  unavailableTitle: "The images could not be loaded",
  forbiddenTitle: "You cannot open the storefront images",
  invalidTitle: "This link has a filter the list cannot use",
  invalid: "Its kind or its page is not valid.",
  retry: "Try again",
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const PAGE_LINK_CLASS =
  "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";
const READ_PERMISSION: StaffPermission = "settings:read";
const WRITE_PERMISSION: StaffPermission = "settings:write";

/**
 * An error of the OTA API as the page's state: `TOKEN_EXPIRED` and an ended session redirect (Next.js's redirect is
 * thrown on), anything that is not an API error is thrown for the error boundary, and an API error is returned.
 */
async function apiFailure(error: unknown, here: string): Promise<VelexisErrorLike> {
  if (!isVelexisErrorLike(error)) {
    throw error;
  }
  try {
    await redirectOnSessionError(error, here);
  } catch (thrown) {
    // `redirectOnSessionError` throws the same error back when it is not about the session.
    if (thrown !== error) {
      throw thrown;
    }
  }
  return error;
}

/** The kind filter: every image, then each kind (links: the URL is the state). */
function KindFilter({ kind }: { readonly kind: AssetKind | undefined }) {
  const options: readonly { readonly value: AssetKind | undefined; readonly label: string }[] = [
    { value: undefined, label: PAGE_STRINGS.all },
    ...ASSET_KINDS.map((choice) => ({ value: choice.value, label: choice.label })),
  ];
  return (
    <nav aria-label={PAGE_STRINGS.filters} className="flex flex-wrap gap-2">
      {options.map((option) => (
        <Link
          key={option.label}
          href={assetListHref(option.value)}
          {...(option.value === kind ? { "aria-current": "page" as const } : {})}
          className={cn(PAGE_LINK_CLASS, option.value === kind && "border-primary bg-primary/10")}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}

/** The images of one page, newest first. */
function AssetsTable({
  assets,
  kind,
  timeZone,
  canWrite,
  environment,
}: {
  readonly assets: readonly StorefrontAsset[];
  readonly kind: AssetKind | undefined;
  readonly timeZone: string;
  readonly canWrite: boolean;
  readonly environment: StaffEnvironment;
}) {
  const columns = Object.values(PAGE_STRINGS.columns).filter(
    (column) => canWrite || column !== PAGE_STRINGS.columns.actions,
  );
  return (
    <Table>
      <TableCaption className="sr-only">{PAGE_STRINGS.title}</TableCaption>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column} scope="col">
              {column}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {assets.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="h-20 text-center text-muted-foreground">
              {kind === undefined ? PAGE_STRINGS.emptyAll : PAGE_STRINGS.empty}
            </TableCell>
          </TableRow>
        ) : (
          assets.map((asset) => {
            const href = assetHref(asset.url);
            return (
              <TableRow key={asset.id} data-asset={asset.id}>
                <TableCell>
                  <div className="grid gap-0.5">
                    <span className="font-medium">{asset.fileName}</span>
                    {href === undefined ? null : (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={PAGE_STRINGS.openLabel(asset.fileName)}
                        className="text-xs font-medium text-primary underline underline-offset-4"
                      >
                        {PAGE_STRINGS.open}
                      </a>
                    )}
                  </div>
                </TableCell>
                <TableCell>{assetKindLabel(asset.kind)}</TableCell>
                <TableCell>{asset.contentType}</TableCell>
                <TableCell className="tabular-nums">{formatBytes(asset.sizeBytes)}</TableCell>
                <TableCell className="tabular-nums">{dimensionsOf(asset)}</TableCell>
                <TableCell>{formatInstant(asset.createdAt, timeZone)}</TableCell>
                <TableCell>
                  <code className="text-xs">{asset.id}</code>
                </TableCell>
                {canWrite ? (
                  <TableCell>
                    <DeleteAssetDialog
                      assetId={asset.id}
                      fileName={asset.fileName}
                      environment={environment}
                      idempotencyKey={crypto.randomUUID()}
                    />
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

/** "First page" on a later page, "Next page" while there is one. */
function Paging({
  kind,
  onLaterPage,
  nextCursor,
}: {
  readonly kind: AssetKind | undefined;
  readonly onLaterPage: boolean;
  readonly nextCursor: string | null;
}) {
  if (!onLaterPage && nextCursor === null) {
    return null;
  }
  return (
    <nav aria-label={PAGE_STRINGS.pages} className="flex flex-wrap justify-end gap-2">
      {onLaterPage ? (
        <Link href={assetListHref(kind)} className={PAGE_LINK_CLASS}>
          {PAGE_STRINGS.firstPage}
        </Link>
      ) : null}
      {nextCursor === null ? null : (
        <Link href={assetListHref(kind, nextCursor)} className={PAGE_LINK_CLASS}>
          {PAGE_STRINGS.nextPage}
        </Link>
      )}
    </nav>
  );
}

/** The heading, the notices, the upload and the filter, above whatever the page shows. */
function PageShell({
  request,
  kind,
  children,
}: {
  readonly request: ConsoleRequest;
  readonly kind: AssetKind | undefined;
  readonly children: ReactNode;
}) {
  const canWrite = can(request.staff, WRITE_PERMISSION);
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
          <p className="max-w-3xl text-muted-foreground">{PAGE_STRINGS.intro}</p>
          <p role="note" className="max-w-3xl text-sm">
            {PAGE_STRINGS.metadata}
          </p>
          {canWrite ? null : <p className="text-sm text-muted-foreground">{PAGE_STRINGS.readOnly}</p>}
          <p className="text-sm">
            <Link href="/settings/storefront" className={LINK_CLASS}>
              {PAGE_STRINGS.storefront}
            </Link>
          </p>
        </div>
        <PermissionGate profile={request.staff} permission={WRITE_PERMISSION} label={UPLOAD_LABEL}>
          <UploadAssetDialog
            environment={request.environment}
            idempotencyKey={crypto.randomUUID()}
            defaultKind={kind ?? "logo"}
          />
        </PermissionGate>
      </div>
      <KindFilter kind={kind} />
      {children}
    </div>
  );
}

export default async function StorefrontAssetsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const list = assetListQueryOf(queryOf(await searchParams));
  const here = assetListHref(list.kind, list.cursor);

  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, here);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }

  if (!can(request.staff, READ_PERMISSION)) {
    return (
      <ErrorState
        title={PAGE_STRINGS.forbiddenTitle}
        description={{
          message: errorMessage({
            code: "FORBIDDEN",
            status: 403,
            requestId: null,
            fieldErrors: [],
            retryable: false,
            details: { requiredPermission: READ_PERMISSION },
          }),
        }}
      />
    );
  }

  if (list.invalid.length > 0) {
    return (
      <PageShell request={request} kind={undefined}>
        <section role="alert" className="grid max-w-xl gap-3">
          <h2 className="text-xl font-semibold">{PAGE_STRINGS.invalidTitle}</h2>
          <p>{PAGE_STRINGS.invalid}</p>
          <Link href={ASSETS_PATH} className={LINK_CLASS}>
            {PAGE_STRINGS.all}
          </Link>
        </section>
      </PageShell>
    );
  }

  let assets: StorefrontAsset[];
  let nextCursor: string | null;
  try {
    const page = await request.console.settings.assets.list({
      limit: ASSETS_PAGE_SIZE,
      ...(list.kind === undefined ? {} : { kind: list.kind }),
      ...(list.cursor === undefined ? {} : { cursor: list.cursor }),
    });
    assets = page.data;
    nextCursor = page.page.nextCursor;
  } catch (error) {
    const failure = await apiFailure(error, here);
    return (
      <PageShell request={request} kind={list.kind}>
        <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
          {/* The same URL again: the list is read anew. */}
          <a href={here} className={LINK_CLASS}>
            {PAGE_STRINGS.retry}
          </a>
          {failure.code === "VALIDATION_FAILED" ? (
            <Link href={assetListHref(list.kind)} className={LINK_CLASS}>
              {PAGE_STRINGS.firstPage}
            </Link>
          ) : null}
        </ErrorState>
      </PageShell>
    );
  }

  return (
    <PageShell request={request} kind={list.kind}>
      <AssetsTable
        assets={assets}
        kind={list.kind}
        timeZone={request.staff.tenant.timeZone}
        canWrite={can(request.staff, WRITE_PERMISSION)}
        environment={request.environment}
      />
      <Paging kind={list.kind} onLaterPage={list.cursor !== undefined} nextCursor={nextCursor} />
    </PageShell>
  );
}
