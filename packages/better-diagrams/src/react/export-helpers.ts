/**
 * export-helpers.ts — format plumbing shared by BOTH exporter sets
 * (architecture and sequence): emitted-commands → canvas, canvas → blob, and
 * the hand-rolled single-page PDF writer.
 */
import { drawToCanvas, drawToSvg, type Emitted } from "./draw";

export interface RenderedCanvas {
  canvas: HTMLCanvasElement;
  /** CSS-pixel dimensions (the canvas backing store is `scale`x larger). */
  width: number;
  height: number;
}

/** Replay an emitted command list onto an offscreen canvas. */
export function emittedToCanvas(emitted: Emitted, scale = 2): RenderedCanvas {
  if (typeof document === "undefined") {
    throw new Error("Image export requires a browser environment");
  }
  const { cmds, width, height, originX, originY } = emitted;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire a 2D canvas context");

  ctx.scale(scale, scale);
  ctx.translate(originX, originY);
  drawToCanvas(ctx, cmds);
  return { canvas, width, height };
}

/** Replay an emitted command list as a standalone SVG document. */
export function emittedToSvg(emitted: Emitted, opts: { gridId?: string } = {}): string {
  const { cmds, width, height, originX, originY } = emitted;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<g transform="translate(${originX} ${originY})">`,
    drawToSvg(cmds, opts),
    `</g></svg>`,
  ].join("\n");
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas produced no image data"))),
      type,
      quality,
    );
  });
}

export async function blobToUint8(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** One page of a JPEG-backed PDF, in CSS pixels. */
export interface PdfPageImage {
  jpeg: Uint8Array;
  pxWidth: number;
  pxHeight: number;
}

/**
 * Wrap JPEGs in a PDF, one full-bleed image per page. Hand-rolled to keep the
 * package free of a PDF dependency; the byte offsets in the xref table are
 * computed from encoded byte lengths, not string lengths, so non-ASCII
 * metadata cannot corrupt it.
 *
 * Each page carries its own MediaBox sized to its image — pages of differing
 * sizes in one file are valid PDF, and diagram states genuinely differ in
 * size, so no common page box exists to normalize onto.
 */
export function buildJpegPdf(pages: PdfPageImage[]): Blob {
  if (!pages.length) throw new Error("A PDF needs at least one page");

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let offset = 0;
  const offsets: number[] = [];

  const push = (data: string | Uint8Array) => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    parts.push(bytes);
    offset += bytes.length;
  };
  const startObject = (n: number) => {
    offsets[n] = offset;
  };

  // Objects: 1 catalog, 2 page tree, then per page i: 3+3i page, 4+3i
  // content stream, 5+3i image XObject.
  const objectCount = 2 + pages.length * 3;
  const kids = pages.map((_, i) => `${3 + 3 * i} 0 R`).join(" ");

  push("%PDF-1.4\n");
  startObject(1);
  push("1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n");
  startObject(2);
  push(`2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>endobj\n`);

  pages.forEach(({ jpeg, pxWidth, pxHeight }, i) => {
    // Map CSS pixels (96dpi) to PDF points (72dpi) so the page prints at a sane size.
    const ptW = Math.round((pxWidth * 72) / 96);
    const ptH = Math.round((pxHeight * 72) / 96);
    const pageObj = 3 + 3 * i;
    const contentObj = pageObj + 1;
    const imageObj = pageObj + 2;

    startObject(pageObj);
    push(
      `${pageObj} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${ptW} ${ptH}]/Contents ${contentObj} 0 R/Resources<</XObject<</Im0 ${imageObj} 0 R>>>>>>endobj\n`,
    );
    const contentBytes = encoder.encode(`q ${ptW} 0 0 ${ptH} 0 0 cm /Im0 Do Q`);
    startObject(contentObj);
    push(`${contentObj} 0 obj<</Length ${contentBytes.length}>>stream\n`);
    push(contentBytes);
    push("\nendstream endobj\n");
    startObject(imageObj);
    push(
      `${imageObj} 0 obj<</Type/XObject/Subtype/Image/Width ${pxWidth}/Height ${pxHeight}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpeg.length}>>stream\n`,
    );
    push(jpeg);
    push("\nendstream endobj\n");
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objectCount; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  push(xref + `trailer<</Size ${objectCount + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`);

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return new Blob([out], { type: "application/pdf" });
}

/** Wrap a JPEG in a single-page PDF. */
export function buildSinglePageJpegPdf(jpeg: Uint8Array, pxWidth: number, pxHeight: number): Blob {
  return buildJpegPdf([{ jpeg, pxWidth, pxHeight }]);
}
