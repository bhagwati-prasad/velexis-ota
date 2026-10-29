// Builders of image files for the storefront assets (OBE-071): the bytes of PNG, JPEG, WebP and ICO files with the
// dimensions a test asks for, as the image sniffer (src/settings/image-sniffer.ts) reads them, and of files that are
// no image (an SVG, a stylesheet). The PNG is a complete, decodable image (zlib-compressed rows and CRCs); the JPEG and
// WebP builders write their headers and a few bytes of data, which is all the sniffer reads. Builders only build
// values; uploading them is the test's job (conventions §10).
//
//   const logo = buildPng({ width: 640, height: 160 });
//   const big = buildPng({ width: 10, height: 10, sizeBytes: 1_200_000 });
//   const svg = Buffer.from(SVG_IMAGE);
import { deflateSync } from "node:zlib";

/** The CRC-32 table of PNG chunks (ISO 3309). */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC of type and data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngOptions {
  readonly width: number;
  readonly height: number;
  /**
   * The file size in bytes: a private ancillary chunk (`vxPd`, which decoders skip) pads the file to it. At least the
   * size of the image without padding plus 12 bytes.
   */
  readonly sizeBytes?: number;
  /** A byte that makes files of the same dimensions differ (the colour of every pixel). */
  readonly shade?: number;
}

/** A grey 8-bit greyscale PNG of `width` × `height` (see PngOptions). */
export function buildPng(options: PngOptions): Buffer {
  const { width, height } = options;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  // Small images get real rows; for very large dimensions (a refused logo) one row stands for all, which the sniffer
  // never decodes.
  const rows = width * height <= 1_000_000 ? height : 1;
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(width <= 1_000_000 ? width : 1, options.shade ?? 0x80),
  ]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: rows }, () => row)));
  const parts = [PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", pixels)];
  const end = chunk("IEND", Buffer.alloc(0));
  const unpadded = parts.reduce((sum, part) => sum + part.length, end.length);
  if (options.sizeBytes !== undefined) {
    const padding = options.sizeBytes - unpadded - 12;
    if (padding < 0) {
      throw new RangeError(
        `buildPng: ${options.sizeBytes} bytes is smaller than the image (${unpadded + 12})`,
      );
    }
    parts.push(chunk("vxPd", Buffer.alloc(padding, 0x2e)));
  }
  return Buffer.concat([...parts, end]);
}

export interface JpegOptions {
  readonly width: number;
  readonly height: number;
  /** The start-of-frame marker: `0xc0` baseline (default), `0xc2` progressive. */
  readonly frame?: number;
  /** Extra 0xFF fill bytes before the frame marker. */
  readonly fill?: number;
}

/** The header of a JPEG file (SOI, a JFIF APP0, an Exif-like APP1, a DQT, the frame header) and a scan. */
export function buildJpeg(options: JpegOptions): Buffer {
  const segment = (marker: number, data: Buffer): Buffer => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(data.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), length, data]);
  };
  const frame = Buffer.alloc(15);
  frame[0] = 8; // precision
  frame.writeUInt16BE(options.height, 1);
  frame.writeUInt16BE(options.width, 3);
  frame[5] = 3; // components
  frame.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 6);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    segment(0xe1, Buffer.from("Exif\0\0 camera metadata stays in the file", "latin1")),
    segment(0xdb, Buffer.alloc(65, 1)),
    Buffer.alloc(options.fill ?? 0, 0xff),
    segment(options.frame ?? 0xc0, frame),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}

/** The RIFF container of a WebP file around one chunk. */
function riff(fourCc: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), Buffer.from(fourCc, "ascii"), size, data]);
  const total = Buffer.alloc(4);
  total.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF", "ascii"), total, body]);
}

/** A WebP file of `width` × `height` with a `VP8 ` (lossy), `VP8L` (lossless) or `VP8X` (extended) first chunk. */
export function buildWebp(kind: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
  if (kind === "VP8 ") {
    const data = Buffer.alloc(20, 0);
    data.set([0x50, 0x02, 0x00], 0); // a key frame's frame tag
    data.set([0x9d, 0x01, 0x2a], 3);
    data.writeUInt16LE(width & 0x3fff, 6);
    data.writeUInt16LE(height & 0x3fff, 8);
    return riff(kind, data);
  }
  if (kind === "VP8L") {
    const bits = (width - 1) | ((height - 1) << 14);
    const data = Buffer.alloc(12, 0);
    data[0] = 0x2f;
    data.writeUInt32LE(bits >>> 0, 1);
    return riff(kind, data);
  }
  const data = Buffer.alloc(10, 0);
  data[0] = 0x10; // alpha
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return riff(kind, data);
}

/** One image of an ICO file: its directory size (256 is written as 0) and its data. */
export interface IcoEntry {
  readonly width: number;
  readonly height: number;
  /** The image's bytes: a PNG, or a bitmap starting with a BITMAPINFOHEADER. Default: a PNG of the size. */
  readonly data?: Buffer;
}

/** A BITMAPINFOHEADER bitmap as an icon image holds it (the header and a few pixels). */
export function buildIconBitmap(width: number, height: number): Buffer {
  const header = Buffer.alloc(40 + 16, 0);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  return header;
}

/** An icon file (type 1) with these images, or a cursor file (type 2). */
export function buildIco(entries: readonly IcoEntry[], type: 1 | 2 = 1): Buffer {
  const images = entries.map((entry) => entry.data ?? buildPng({ width: entry.width, height: entry.height }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(type, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const directory = entries.map((entry, index) => {
    const image = images[index] ?? Buffer.alloc(0);
    const row = Buffer.alloc(16, 0);
    row[0] = entry.width >= 256 ? 0 : entry.width;
    row[1] = entry.height >= 256 ? 0 : entry.height;
    row.writeUInt16LE(1, 4);
    row.writeUInt16LE(32, 6);
    row.writeUInt32LE(image.length, 8);
    row.writeUInt32LE(offset, 12);
    offset += image.length;
    return row;
  });
  return Buffer.concat([header, ...directory, ...images]);
}

/** An SVG image with a script: what must never be stored, whatever its file is called. */
export const SVG_IMAGE =
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40">' +
  '<script>alert(document.domain)</script><rect width="100" height="40" fill="#0b5fff"/></svg>\n';

/** A stylesheet: no CSS uploads either. */
export const CSS_FILE = "body { background: url(https://tracker.invalid/pixel.png); }\n";
