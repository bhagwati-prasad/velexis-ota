// Unit tests of the image sniffer (OBE-071; OADR-0012 point 2): the type comes from the first bytes and the dimensions
// from the header of PNG, JPEG, WebP and ICO files; anything else, an SVG called `logo.png` included, is no image.
import { describe, expect, it } from "vitest";
import {
  buildIco,
  buildIconBitmap,
  buildJpeg,
  buildPng,
  buildWebp,
  CSS_FILE,
  PNG_SIGNATURE,
  SVG_IMAGE,
} from "../../test/builders/images";
import { sniffImage } from "./image-sniffer";

describe("sniffImage", () => {
  it("reads a PNG's type and dimensions from its signature and IHDR chunk", () => {
    expect(sniffImage(buildPng({ width: 640, height: 160 }))).toEqual({
      format: "png",
      contentType: "image/png",
      extension: "png",
      width: 640,
      height: 160,
    });
    // Large dimensions are read as unsigned integers.
    expect(sniffImage(buildPng({ width: 70_000, height: 3 }))).toMatchObject({ width: 70_000, height: 3 });
  });

  it("reads a JPEG's dimensions from its first frame header, after APP segments and fill bytes", () => {
    expect(sniffImage(buildJpeg({ width: 1200, height: 800 }))).toEqual({
      format: "jpeg",
      contentType: "image/jpeg",
      extension: "jpg",
      width: 1200,
      height: 800,
    });
    expect(sniffImage(buildJpeg({ width: 3, height: 65_535, frame: 0xc2, fill: 4 }))).toMatchObject({
      width: 3,
      height: 65_535,
    });
  });

  it("reads lossy, lossless and extended WebP files", () => {
    expect(sniffImage(buildWebp("VP8 ", 1024, 512))).toEqual({
      format: "webp",
      contentType: "image/webp",
      extension: "webp",
      width: 1024,
      height: 512,
    });
    expect(sniffImage(buildWebp("VP8L", 16_384, 1))).toMatchObject({ width: 16_384, height: 1 });
    expect(sniffImage(buildWebp("VP8X", 2001, 300))).toMatchObject({ width: 2001, height: 300 });
  });

  it("reads an icon file of PNG and bitmap images, with the largest image's dimensions", () => {
    const icon = buildIco([
      { width: 16, height: 16, data: buildIconBitmap(16, 16) },
      { width: 256, height: 256 },
      { width: 32, height: 32 },
    ]);

    expect(sniffImage(icon)).toEqual({
      format: "ico",
      contentType: "image/x-icon",
      extension: "ico",
      width: 256,
      height: 256,
    });
  });

  it("refuses an SVG renamed to .png, and a stylesheet, HTML and GIF: no image is read from a file name [OBE-071 AC1]", () => {
    for (const text of [
      SVG_IMAGE,
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      CSS_FILE,
      "<!doctype html><html><body><script>alert(1)</script></body></html>",
      "GIF89a\x01\x00\x01\x00\x80\x00\x00",
      "",
    ]) {
      expect([text.slice(0, 20), sniffImage(Buffer.from(text, "latin1"))]).toEqual([text.slice(0, 20), null]);
    }
  });

  it("refuses files whose header is cut short or cannot be read", () => {
    const png = buildPng({ width: 10, height: 10 });
    // The signature alone, a cut IHDR, and an IHDR of another length.
    expect(sniffImage(PNG_SIGNATURE)).toBeNull();
    expect(sniffImage(png.subarray(0, 20))).toBeNull();
    const longHeader = Buffer.from(png);
    longHeader.writeUInt32BE(14, 8);
    expect(sniffImage(longHeader)).toBeNull();
    // A JPEG whose scan starts before any frame header, one cut inside its segments, one whose frame has height 0.
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00]))).toBeNull();
    expect(sniffImage(buildJpeg({ width: 10, height: 10 }).subarray(0, 40))).toBeNull();
    expect(sniffImage(buildJpeg({ width: 10, height: 0 }))).toBeNull();
    // WebP: a lossy frame that is no key frame, a lossless one without its signature, an unknown first chunk.
    const interFrame = buildWebp("VP8 ", 10, 10);
    interFrame[20] = 0x51;
    expect(sniffImage(interFrame)).toBeNull();
    const unsigned = buildWebp("VP8L", 10, 10);
    unsigned[20] = 0x00;
    expect(sniffImage(unsigned)).toBeNull();
    const other = buildWebp("VP8X", 10, 10);
    other.write("ALPH", 12, "ascii");
    expect(sniffImage(other)).toBeNull();
  });

  it("refuses cursors and icon files whose images are outside the file or are neither PNG nor bitmap", () => {
    expect(sniffImage(buildIco([{ width: 32, height: 32 }], 2))).toBeNull();
    expect(sniffImage(buildIco([]))).toBeNull();
    expect(sniffImage(buildIco([{ width: 32, height: 32, data: Buffer.from(SVG_IMAGE) }]))).toBeNull();
    const cut = buildIco([{ width: 32, height: 32 }]);
    expect(sniffImage(cut.subarray(0, cut.length - 1))).toBeNull();
  });

  it("refuses a width or height of 0", () => {
    expect(sniffImage(buildPng({ width: 0, height: 10 }))).toBeNull();
    expect(sniffImage(buildPng({ width: 10, height: 0 }))).toBeNull();
    expect(sniffImage(buildJpeg({ width: 0, height: 10 }))).toBeNull();
    expect(sniffImage(buildWebp("VP8 ", 0, 10))).toBeNull();
  });
});
