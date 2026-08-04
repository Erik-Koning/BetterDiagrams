/**
 * The hand-rolled PDF writer, verified structurally: object counts, page
 * tree, per-page MediaBoxes, and an xref whose recorded offset is real.
 */
import { describe, expect, it } from "vitest";
import { buildJpegPdf, buildSinglePageJpegPdf } from "./export-helpers";

// Payload bytes are opaque to the writer — any bytes stand in for a JPEG.
const jpegA = new TextEncoder().encode("AAAA-jpeg-bytes");
const jpegB = new TextEncoder().encode("BB");

async function pdfText(blob: Blob): Promise<string> {
  return new TextDecoder("latin1").decode(new Uint8Array(await blob.arrayBuffer()));
}

describe("buildJpegPdf", () => {
  it("lays out one page per image, sized to that image", async () => {
    const text = await pdfText(
      buildJpegPdf([
        { jpeg: jpegA, pxWidth: 960, pxHeight: 480 },
        { jpeg: jpegB, pxWidth: 400, pxHeight: 800 },
      ]),
    );

    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toContain("/Kids[3 0 R 6 0 R]");
    expect(text).toContain("/Count 2");
    // 8 objects: catalog, pages, then (page, contents, image) × 2.
    expect(text.match(/\d+ 0 obj/g)).toHaveLength(8);
    expect(text).toContain("xref\n0 9\n");
    expect(text).toContain("/Size 9");
    // Per-page boxes at 72/96 scaling: 960px → 720pt, 400px → 300pt.
    expect(text).toContain("/MediaBox[0 0 720 360]");
    expect(text).toContain("/MediaBox[0 0 300 600]");
    expect(text).toContain("/Width 960/Height 480");
    expect(text).toContain("/Width 400/Height 800");

    // The startxref number points at the actual xref keyword.
    const startxref = Number(/startxref\n(\d+)\n%%EOF$/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
  });

  it("refuses an empty page list", () => {
    expect(() => buildJpegPdf([])).toThrow();
  });
});

describe("buildSinglePageJpegPdf", () => {
  it("keeps the historical single-page shape", async () => {
    const text = await pdfText(buildSinglePageJpegPdf(jpegA, 960, 480));
    expect(text).toContain("/Kids[3 0 R]");
    expect(text).toContain("/Count 1");
    expect(text).toContain("/Size 6");
    expect(text.match(/\d+ 0 obj/g)).toHaveLength(5);
  });
});
