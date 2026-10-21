import "server-only";

import { create } from "qrcode";

/**
 * QR codes of the portal (README §2 `/account/security`; PF-04 AC1): the `otpauth://` URI of a pending TOTP set-up,
 * encoded on the server with the `qrcode` package, so the browser gets the finished geometry and neither the encoder
 * nor a third-party QR service ever sees the secret. The answer is plain data (the size of the square and one SVG
 * path of its dark modules) that a component renders as an inline `<svg>`: no markup string, no `data:` URL and
 * nothing for `dangerouslySetInnerHTML`.
 */

/** A QR code as an SVG: a `size` × `size` square (quiet zone included) and the path of its dark modules. */
export interface QrCode {
  /** The width and height in modules, the quiet zone included: the `viewBox` is `0 0 size size`. */
  readonly size: number;
  /** The dark modules as filled rectangles, one per horizontal run (`M<x> <y>h<n>v1h-<n>z`). */
  readonly path: string;
}

/** The quiet zone around the symbol, in modules: the 4 that ISO/IEC 18004 asks for, so every scanner finds it. */
export const QR_QUIET_ZONE = 4;

/**
 * The longest text `qrCode` encodes. An `otpauth://` URI of the platform is about 150 characters; the limit keeps an
 * unexpected answer from producing a symbol too dense to scan (version 10 at level M holds 213 bytes).
 */
export const QR_MAX_TEXT_LENGTH = 512;

/**
 * The QR code of `text` (error correction level M, which survives a smudged or partly covered screen and still keeps
 * an authenticator URI at a low version). Throws for an empty or over-long text; the caller never passes one.
 */
export function qrCode(text: string): QrCode {
  if (text.length === 0 || text.length > QR_MAX_TEXT_LENGTH) {
    throw new RangeError("A QR code needs a text of 1 to 512 characters.");
  }
  const { modules } = create(text, { errorCorrectionLevel: "M" });
  const width = modules.size;
  // The matrix holds 1 for a dark module and 0 for a light one.
  const isDark = (row: number, column: number): boolean => modules.get(row, column) !== 0;
  const commands: string[] = [];
  for (let row = 0; row < width; row += 1) {
    let column = 0;
    while (column < width) {
      if (!isDark(row, column)) {
        column += 1;
        continue;
      }
      const start = column;
      while (column < width && isDark(row, column)) {
        column += 1;
      }
      const run = column - start;
      commands.push(`M${start + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h${run}v1h-${run}z`);
    }
  }
  return { size: width + 2 * QR_QUIET_ZONE, path: commands.join("") };
}
