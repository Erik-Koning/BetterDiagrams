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

/**
 * What a browser will actually allocate. Every current engine refuses a
 * dimension past 16384px or a total area past 256 megapixels, and it refuses
 * by handing back a blank canvas rather than by throwing — which is how an
 * oversized diagram used to surface as "Canvas produced no image data".
 */
const MAX_CANVAS_DIM = 16384;
const MAX_CANVAS_AREA = 268_435_456;

/** Oversampling steps, largest first: sharpness is worth giving up for a file. */
const SCALE_STEPS = [2, 1.5, 1];

/**
 * The largest of `SCALE_STEPS` at or below `requested` that a browser canvas
 * can hold — or null when even 1:1 is too big for one.
 */
function fittingScale(width: number, height: number, requested: number): number | null {
  const steps = SCALE_STEPS.filter((s) => s <= requested);
  for (const scale of steps.length ? steps : [requested]) {
    const w = Math.ceil(width * scale);
    const h = Math.ceil(height * scale);
    if (w <= MAX_CANVAS_DIM && h <= MAX_CANVAS_DIM && w * h <= MAX_CANVAS_AREA) return scale;
  }
  return null;
}

/**
 * Replay an emitted command list onto an offscreen canvas.
 *
 * The oversampling drops to 1.5x and then to 1x rather than the export
 * failing: a large diagram at a lower resolution is a usable file, and a
 * diagram too large even at 1:1 gets told so in words instead of failing later
 * with a message about missing image data.
 */
export function emittedToCanvas(emitted: Emitted, scale = 2): RenderedCanvas {
  if (typeof document === "undefined") {
    throw new Error("Image export requires a browser environment");
  }
  const { cmds, width, height, originX, originY } = emitted;
  const fitted = fittingScale(width, height, scale);
  if (fitted === null) {
    throw new Error(
      `This diagram is ${Math.ceil(width)}×${Math.ceil(height)} pixels — larger than a browser ` +
        `canvas can hold, so it cannot be rendered as an image. Export it as SVG (which has no ` +
        `size limit), or make the picture smaller by collapsing a group or hiding a zone's ` +
        `alternatives before exporting again.`,
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * fitted);
  canvas.height = Math.ceil(height * fitted);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire a 2D canvas context");

  ctx.scale(fitted, fitted);
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
      (blob) =>
        blob
          ? resolve(blob)
          : // Size is the usual cause, so the message names it: a bare
            // "no image data" left the user with nothing to act on.
            reject(
              new Error(
                `Could not encode the ${canvas.width}×${canvas.height} image — it is probably ` +
                  `too large for this browser. Try the SVG export instead.`,
              ),
            ),
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
