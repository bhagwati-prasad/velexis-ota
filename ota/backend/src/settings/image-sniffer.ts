// The image sniffer of the storefront assets (OBE-071; OADR-0012 point 2, api-changes part 2 §2.5): what an uploaded
// file is, read from its first bytes, and its dimensions, read from its header. The declared `Content-Type` and the
// file name are never looked at, so an SVG, an HTML page or a stylesheet renamed to `logo.png` is no image here. No
// image library and no decoding: the stack has none (the files are stored as uploaded, not re-encoded), and the
// header fields below are all the API needs.
//
//   PNG   the 8-byte signature `89 50 4E 47 0D 0A 1A 0A`, then the IHDR chunk (length 13): width and height as 32-bit
//         big-endian integers
//   JPEG  `FF D8 FF`, then the markers up to the first start-of-frame (SOF0–SOF15 except DHT, JPG and DAC): height and
//         width as 16-bit big-endian integers; a scan or the end of the image before a frame, or a frame of height 0
//         (defined later by a DNL marker), is a header that cannot be read
//   WebP  `RIFF`, the RIFF size, `WEBP`, then the first chunk: `VP8 ` (lossy: a key frame's start code `9D 01 2A` and
//         14-bit sizes), `VP8L` (lossless: the signature `2F` and 14-bit sizes minus one) or `VP8X` (extended: 24-bit
//         canvas sizes minus one)
//   ICO   the reserved 0, the type 1 (an icon; 2, a cursor, is not one) and at least one directory entry of 16 bytes,
//         each of whose images lies inside the file and starts as a PNG or a bitmap (a BITMAPINFOHEADER of 40, 108 or
//         124 bytes) does; the dimensions are the largest entry's (a 0 in the directory means 256)
//
// Anything else, a header cut short, and a width or height of 0 is `null`: the upload answers `422 ASSET_INVALID`
// (`details.reason = "type"`, assets.service.ts). Which kinds may be which type (ICO for favicons only) and the size
// and dimension limits are the service's rules, not the sniffer's. Pure: no I/O.

/** The image types an asset can have (`storefront_assets.content_type`, `file_extension`). */
export type SniffedFormat = "png" | "jpeg" | "webp" | "ico";

/** What the sniffer read from a file. */
export interface SniffedImage {
  readonly format: SniffedFormat;
  /** The MIME type stored and served (`storefront_assets.content_type`). */
  readonly contentType: "image/png" | "image/jpeg" | "image/webp" | "image/x-icon";
  /** The extension of the public URL (`storefront_assets.file_extension`). */
  readonly extension: "png" | "jpg" | "webp" | "ico";
  /** Width in pixels, at least 1. */
  readonly width: number;
  /** Height in pixels, at least 1. */
  readonly height: number;
}

const TYPES: Readonly<Record<SniffedFormat, Pick<SniffedImage, "contentType" | "extension">>> = Object.freeze(
  {
    png: { contentType: "image/png", extension: "png" },
    jpeg: { contentType: "image/jpeg", extension: "jpg" },
    webp: { contentType: "image/webp", extension: "webp" },
    ico: { contentType: "image/x-icon", extension: "ico" },
  },
);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Whether `bytes` holds `expected` at `offset`. */
function startsWith(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + expected.length) {
    return false;
  }
  return expected.every((value, index) => bytes[offset + index] === value);
}

/** Whether `bytes` holds the ASCII text `text` at `offset`. */
function hasAscii(bytes: Uint8Array, text: string, offset: number): boolean {
  return startsWith(
    bytes,
    [...text].map((character) => character.charCodeAt(0)),
    offset,
  );
}

const u16be = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
const u16le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
const u24le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
/** Unsigned 32-bit integers (multiplied, not shifted, so values above 2^31 stay positive). */
const u32be = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) * 0x1000000 +
  (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
const u32le = (bytes: Uint8Array, offset: number): number =>
  u24le(bytes, offset) + (bytes[offset + 3] ?? 0) * 0x1000000;

/** The largest size a dimension may have: what a PostgreSQL `integer` holds. */
const MAX_DIMENSION = 0x7fffffff;

/** The image, when both dimensions are usable. */
function image(format: SniffedFormat, width: number, height: number): SniffedImage | null {
  const usable = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= MAX_DIMENSION;
  return usable(width) && usable(height) ? { format, ...TYPES[format], width, height } : null;
}

/** PNG: the IHDR chunk right after the signature. */
function png(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 24 || u32be(bytes, 8) !== 13 || !hasAscii(bytes, "IHDR", 12)) {
    return null;
  }
  return image("png", u32be(bytes, 16), u32be(bytes, 20));
}

/** The JPEG markers of a start of frame: SOF0–SOF15 without DHT (C4), JPG (C8) and DAC (CC). */
const JPEG_FRAMES: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** JPEG markers without a length: TEM, RST0–RST7 and SOI. */
const JPEG_STANDALONE = (marker: number): boolean => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);

/** JPEG: the markers after SOI up to the first frame header. */
function jpeg(bytes: Uint8Array): SniffedImage | null {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    // Fill bytes: any number of 0xFF before a marker.
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00) {
      return null;
    }
    if (JPEG_STANDALONE(marker)) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      // The end of the image, or a scan, before any frame header.
      return null;
    }
    if (offset + 2 > bytes.length) {
      return null;
    }
    const length = u16be(bytes, offset);
    if (length < 2) {
      return null;
    }
    if (JPEG_FRAMES.has(marker)) {
      // length (2), precision (1), height (2), width (2)
      if (length < 7 || offset + 7 > bytes.length) {
        return null;
      }
      return image("jpeg", u16be(bytes, offset + 5), u16be(bytes, offset + 3));
    }
    offset += length;
  }
  return null;
}

/** WebP: the first chunk of the RIFF container. */
function webp(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 30) {
    return null;
  }
  if (hasAscii(bytes, "VP8 ", 12)) {
    // A key frame (bit 0 of the frame tag clear) and its start code.
    if (((bytes[20] ?? 1) & 0x01) !== 0 || !startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) {
      return null;
    }
    return image("webp", u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  if (hasAscii(bytes, "VP8L", 12)) {
    if (bytes[20] !== 0x2f) {
      return null;
    }
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    const width = 1 + (b1 | ((b2 & 0x3f) << 8));
    const height = 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10));
    return image("webp", width, height);
  }
  if (hasAscii(bytes, "VP8X", 12)) {
    return image("webp", 1 + u24le(bytes, 24), 1 + u24le(bytes, 27));
  }
  return null;
}

/** The sizes of the BITMAPINFOHEADER versions a bitmap icon image starts with (V1, V4, V5). */
const DIB_HEADER_SIZES: ReadonlySet<number> = new Set([40, 108, 124]);

/** ICO: the directory, each image inside the file and a PNG or a bitmap; the largest entry's dimensions. */
function ico(bytes: Uint8Array): SniffedImage | null {
  const count = u16le(bytes, 4);
  const directoryEnd = 6 + count * 16;
  if (count === 0 || bytes.length < directoryEnd) {
    return null;
  }
  let best: { width: number; height: number } | undefined;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = bytes[entry] === 0 ? 256 : (bytes[entry] ?? 0);
    const height = bytes[entry + 1] === 0 ? 256 : (bytes[entry + 1] ?? 0);
    const size = u32le(bytes, entry + 8);
    const offset = u32le(bytes, entry + 12);
    if (size === 0 || offset < directoryEnd || offset + size > bytes.length) {
      return null;
    }
    if (!startsWith(bytes, PNG_SIGNATURE, offset) && !DIB_HEADER_SIZES.has(u32le(bytes, offset))) {
      return null;
    }
    if (best === undefined || width * height > best.width * best.height) {
      best = { width, height };
    }
  }
  return best === undefined ? null : image("ico", best.width, best.height);
}

/**
 * The image `bytes` holds, read from its first bytes and its header, or `null` when it is no PNG, JPEG, WebP or ICO
 * file, or its header cannot be read (see the file header).
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return png(bytes);
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return jpeg(bytes);
  }
  if (hasAscii(bytes, "RIFF", 0) && hasAscii(bytes, "WEBP", 8)) {
    return webp(bytes);
  }
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) {
    return ico(bytes);
  }
  return null;
}
