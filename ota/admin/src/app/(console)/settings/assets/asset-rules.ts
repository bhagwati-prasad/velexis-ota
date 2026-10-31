// The storefront images of the OTA admin (OAD-014; routes.md §9, api-changes part 2 §2.5, OADR-0012 points 2 and 3):
// what the assets page (page.tsx), its upload and delete dialogs (upload-form.tsx), the server actions (actions.ts) and
// the storefront settings' image pickers share. A module without a directive, for the reason settings-rules.ts gives:
// the kinds and their labels, the limits the API enforces, the check a file gets before it is sent, the list's URL
// model and the texts of the API's refusals. It imports of the SDK only types and no server-only module.
//
// The API reads the type from the file's bytes and refuses anything but PNG, JPEG and WebP (and ICO for a favicon),
// above 1 MB, and logos above 2000 × 2000 pixels (`422 ASSET_INVALID`, `details.reason` `type`, `size`,
// `dimensions`). The admin refuses an SVG and a file above 1 MB before any call (`fileProblemOf`), in the browser and
// again in the server action: an SVG is never an image the API stores (a same-origin SVG can run script), and a file
// above 1 MB would only be refused after crossing the network twice (the server action's body limit is 2 MB,
// next.config.ts). Everything else is left to the API, whose answer is shown in the same words.
import type { StorefrontAsset } from "@velexis/ota-sdk";

import type { Choice } from "@/app/(console)/bookings/[bookingId]/action-rules";

/** What an image is for (`StorefrontAssetKind`). */
export type AssetKind = StorefrontAsset["kind"];

/** The kinds, in the document's order, with what each is for. */
export const ASSET_KINDS: readonly (Choice<AssetKind> & { readonly detail: string })[] = Object.freeze([
  {
    value: "logo",
    label: "Logo",
    detail: "The main logo, for light backgrounds; at most 2000 × 2000 pixels.",
  },
  {
    value: "logo_dark",
    label: "Logo for dark backgrounds",
    detail: "Shown on a dark header; at most 2000 × 2000 pixels.",
  },
  {
    value: "logo_square",
    label: "Square logo",
    detail: "For e-mails and icons; at most 2000 × 2000 pixels.",
  },
  { value: "favicon", label: "Favicon", detail: "The icon of the browser tab; ICO files are accepted too." },
  { value: "og_image", label: "Social sharing image", detail: "Shown when a storefront page is shared." },
  { value: "page_image", label: "Page image", detail: "Shown in content pages (![alt text](ast_…))." },
]);

/** The label of a kind ("Favicon"), or the value itself for a kind this list does not know. */
export function assetKindLabel(kind: string): string {
  return ASSET_KINDS.find((choice) => choice.value === kind)?.label ?? kind;
}

/** Whether `value` is one of the kinds. */
export function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === "string" && ASSET_KINDS.some((choice) => choice.value === value);
}

/** The largest file the API stores: 1 MB (1 048 576 bytes). */
export const MAX_ASSET_BYTES = 1_048_576;

/** The `accept` of the file input: the types the API stores, by MIME type and extension; never SVG. */
export const ACCEPTED_FILE_TYPES =
  "image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon,.png,.jpg,.jpeg,.webp,.ico";

/** The longest file name the API keeps (`fileName`, 1 to 200 characters). */
export const MAX_FILE_NAME_LENGTH = 200;

/** The fields of the upload and delete forms. */
export const ASSET_FIELDS = Object.freeze({
  file: "file",
  kind: "kind",
  fileName: "fileName",
  assetId: "assetId",
});

/** An asset id as the API writes it. */
export const ASSET_ID_PATTERN = /^ast_[0-9A-Za-z]{16,40}$/;

/** The assets page, which the upload and the delete revalidate. */
export const ASSETS_PATH = "/settings/assets";

/**
 * The upload button's label: the dialog's trigger, and the disabled button that names the permission to the other
 * roles (the page is a server component, which cannot read the constants of the dialog's client module).
 */
export const UPLOAD_LABEL = "Upload an image";

/** What a refusal of `ASSET_INVALID` says, by `details.reason` (and the admin's own check before the call). */
export const ASSET_INVALID_MESSAGES = Object.freeze({
  type: "Upload a PNG, JPEG or WebP image (an ICO file for a favicon). SVG files are not accepted.",
  size: "The image is larger than 1 MB. Make it smaller and upload it again.",
  dimensions: "A logo may be at most 2000 × 2000 pixels. Make it smaller and upload it again.",
} as const);

export type AssetInvalidReason = keyof typeof ASSET_INVALID_MESSAGES;

/** What the admin reads of a file before sending it. */
export interface FileFacts {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  /** The file's first bytes as text (an SVG or any XML starts with `<`), when they were read. */
  readonly head?: string;
}

/** The start of a markup file (SVG, XML, HTML), after a byte order mark and white space. */
const MARKUP_START = /^\uFEFF?\s*</;

/**
 * Whether a file is an SVG (or other markup): by its type, its extension or its first bytes. PNG, JPEG, WebP and ICO
 * files never start with `<`, so a file whose first bytes do is no image the API stores.
 */
export function isSvgFile(file: FileFacts): boolean {
  const type = file.type.toLowerCase();
  return (
    type === "image/svg+xml" ||
    /\.svgz?$/i.test(file.name.trim()) ||
    (file.head !== undefined && MARKUP_START.test(file.head))
  );
}

/**
 * Why the admin refuses a file before sending it: `type` for an SVG (or any markup), `size` for an empty file or one
 * above 1 MB; `undefined` when it goes to the API, which checks the rest.
 */
export function fileProblemOf(file: FileFacts): AssetInvalidReason | undefined {
  if (isSvgFile(file)) {
    return "type";
  }
  if (file.size > MAX_ASSET_BYTES) {
    return "size";
  }
  return undefined;
}

/** A size in bytes as staff read it: `48 KB`, `1.0 MB`, `812 bytes`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < MAX_ASSET_BYTES) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / MAX_ASSET_BYTES).toFixed(1)} MB`;
}

/** The dimensions of an image, or "size unknown" when its header gave none. */
export function dimensionsOf(asset: Pick<StorefrontAsset, "width" | "height">): string {
  return asset.width === null || asset.height === null
    ? "size unknown"
    : `${asset.width} × ${asset.height} px`;
}

/** An image as a picker lists it: its file name, dimensions and size. */
export function assetOptionLabel(
  asset: Pick<StorefrontAsset, "fileName" | "width" | "height" | "sizeBytes">,
): string {
  return `${asset.fileName} (${dimensionsOf(asset)}, ${formatBytes(asset.sizeBytes)})`;
}

/**
 * The public URL of an asset when it is an `http(s)` URL (`getPublicAsset` on the API host), for a link that opens it;
 * `undefined` for anything else, which is never put into a link.
 */
export function assetHref(url: string): string | undefined {
  if (!URL.canParse(url)) {
    return undefined;
  }
  const parsed = new URL(url);
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
}

// ---- The list's URL ---------------------------------------------------------------------------------------------

/** The page size of the list. */
export const ASSETS_PAGE_SIZE = 50;
/** The longest cursor the list passes on; the API's cursors are far shorter. */
const MAX_CURSOR_LENGTH = 2048;

/** What the list's URL asks for: one kind, the cursor, and the parameters the API would refuse. */
export interface AssetListQuery {
  readonly kind: AssetKind | undefined;
  readonly cursor: string | undefined;
  readonly invalid: readonly string[];
}

/** The list query of a URL: `kind` is one of the kinds or absent; one cursor of a sane length. */
export function assetListQueryOf(query: URLSearchParams): AssetListQuery {
  const invalid: string[] = [];
  const kinds = query.getAll("kind").filter((value) => value !== "");
  const [kindValue] = kinds;
  let kind: AssetKind | undefined;
  if (kinds.length > 1 || (kindValue !== undefined && !isAssetKind(kindValue))) {
    invalid.push("kind");
  } else if (kindValue !== undefined && isAssetKind(kindValue)) {
    kind = kindValue;
  }
  const cursors = query.getAll("cursor").filter((value) => value !== "");
  const [cursor] = cursors;
  if (cursors.length > 1 || (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH)) {
    invalid.push("cursor");
  }
  return { kind, cursor: invalid.includes("cursor") ? undefined : cursor, invalid };
}

/** The URL of the list with a kind and, on a later page, the cursor. */
export function assetListHref(kind: AssetKind | undefined, cursor?: string): string {
  const query = new URLSearchParams();
  if (kind !== undefined) {
    query.set("kind", kind);
  }
  if (cursor !== undefined) {
    query.set("cursor", cursor);
  }
  const search = query.toString();
  return search === "" ? ASSETS_PATH : `${ASSETS_PATH}?${search}`;
}

// ---- The API's refusals -----------------------------------------------------------------------------------------

/** The settings fields that can hold an image, by the JSON pointer `409 asset_in_use` names. */
const SETTINGS_PATH_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "/branding/logoAssetId": "the logo",
  "/branding/logoDarkAssetId": "the logo for dark backgrounds",
  "/branding/logoSquareAssetId": "the square logo",
  "/branding/faviconAssetId": "the favicon",
  "/seo/ogImageAssetId": "the social sharing image",
});

/** "a, b and c". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/**
 * `409 CONFLICT` `asset_in_use` of a delete in words: where the image is used (`details.settingsPaths`, the storefront
 * settings' fields; `details.pageIds`, the content pages that show it) and what to do first.
 */
export function inUseMessage(details: Readonly<Record<string, unknown>> | undefined): string {
  const paths = Array.isArray(details?.["settingsPaths"]) ? (details["settingsPaths"] as unknown[]) : [];
  const pages = Array.isArray(details?.["pageIds"]) ? (details["pageIds"] as unknown[]) : [];
  const places = paths
    .filter((path): path is string => typeof path === "string")
    .map((path) => SETTINGS_PATH_LABELS[path] ?? path);
  const where: string[] = [];
  if (places.length > 0) {
    where.push(`the storefront settings use it as ${listOf(places)}`);
  }
  if (pages.length > 0) {
    where.push(pages.length === 1 ? "a content page shows it" : `${pages.length} content pages show it`);
  }
  const reason = where.length === 0 ? "it is in use" : listOf(where);
  return `This image cannot be deleted: ${reason}. Choose another image there first (Settings → Storefront, Settings → Pages), then delete it.`;
}

/**
 * `409 CONFLICT` `asset_exists` of an upload in words: the same file is already an image of another kind
 * (`details.kind`, `details.assetId`); one asset holds one file.
 */
export function assetExistsMessage(details: Readonly<Record<string, unknown>> | undefined): string {
  const kind = details?.["kind"];
  const assetId = details?.["assetId"];
  const label = typeof kind === "string" ? assetKindLabel(kind).toLowerCase() : "another kind of image";
  const id = typeof assetId === "string" && ASSET_ID_PATTERN.test(assetId) ? ` (${assetId})` : "";
  return `This file is already your ${label}${id}. One file can be one kind of image only: delete that image first, or upload a different file.`;
}
