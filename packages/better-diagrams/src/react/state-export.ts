/**
 * state-export.ts — turning a list of state combos into one download.
 *
 * The per-format exporters produce exactly one file from one document; this
 * runner is the loop above them: materialize each combo, render it, and pack
 * the results — a lone file when there is one, a zip when there are several,
 * or one multi-page PDF when the user asked for the states as pages.
 *
 * Renderers are injected rather than imported so the same loop serves both
 * studios (architecture and sequence render with different functions and
 * document types) and so tests can run it without a real canvas.
 */

import { comboSlug, type StateAxes, type StateCombo } from "../contract/states";
import {
  blobToUint8,
  buildJpegPdf,
  canvasToBlob,
  type PdfPageImage,
  type RenderedCanvas,
} from "./export-helpers";
import type { ExportResult } from "./registry-types";
import { buildZip, type ZipEntry } from "./zip";

export type StateExportFormat = "png" | "svg" | "pdf";

/** PDF packing: every combo a page of one file, or one file per combo. */
export type PdfLayout = "single" | "separate";

export interface StateExportJob<TDoc> {
  format: StateExportFormat;
  /** Base filename, no extension. */
  filename: string;
  /** For combo slugs — must be the axes the combos were enumerated from. */
  axes: StateAxes;
  combos: StateCombo[];
  /** Ignored unless format is "pdf". */
  pdfLayout: PdfLayout;
  materialize(combo: StateCombo): TDoc;
  /** Required for "svg". */
  renderSvg?(doc: TDoc): string;
  /** Required for "png" and "pdf". */
  renderCanvas?(doc: TDoc): RenderedCanvas;
}

const JPEG_QUALITY = 0.92; // matches the single-state PDF exporters

/** Rendering happens on the main thread; yield between combos so the page paints. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve));

export async function runStateExport<TDoc>(job: StateExportJob<TDoc>): Promise<ExportResult> {
  const { format, filename, axes, combos, materialize } = job;
  if (!combos.length) throw new Error("Nothing selected to export");

  if (format === "pdf" && job.pdfLayout === "single") {
    const pages: PdfPageImage[] = [];
    for (const combo of combos) {
      // CSS pixels, not the 2x backing store — see `PdfPageImage`. Passing the
      // backing-store size prints every page at twice its physical size.
      const { canvas, width, height } = requireCanvas(job)(materialize(combo));
      pages.push({
        jpeg: await blobToUint8(await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY)),
        pxWidth: width,
        pxHeight: height,
      });
      await breathe();
    }
    return { blob: buildJpegPdf(pages), filename: `${filename}-states.pdf` };
  }

  const entries: ZipEntry[] = [];
  for (const combo of combos) {
    const name = `${filename}${comboSlug(axes, combo)}.${format}`;
    entries.push({ name, data: await renderComboBytes(job, combo) });
    await breathe();
  }

  if (entries.length === 1) {
    const { name, data } = entries[0];
    // Copy into a fresh ArrayBuffer-backed view; BlobPart rejects the generic
    // Uint8Array<ArrayBufferLike> that flows out of the render pipeline.
    return { blob: new Blob([new Uint8Array(data)], { type: MIME[format] }), filename: name };
  }
  return { blob: buildZip(entries), filename: `${filename}-states.zip` };
}

const MIME: Record<StateExportFormat, string> = {
  png: "image/png",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

function requireCanvas<TDoc>(job: StateExportJob<TDoc>): (doc: TDoc) => RenderedCanvas {
  if (!job.renderCanvas) throw new Error(`${job.format} export needs a canvas renderer`);
  return job.renderCanvas;
}

async function renderComboBytes<TDoc>(
  job: StateExportJob<TDoc>,
  combo: StateCombo,
): Promise<Uint8Array> {
  const doc = job.materialize(combo);
  switch (job.format) {
    case "svg": {
      if (!job.renderSvg) throw new Error("svg export needs an SVG renderer");
      return new TextEncoder().encode(job.renderSvg(doc));
    }
    case "png": {
      const { canvas } = requireCanvas(job)(doc);
      return blobToUint8(await canvasToBlob(canvas, "image/png"));
    }
    case "pdf": {
      const { canvas, width, height } = requireCanvas(job)(doc);
      const jpeg = await blobToUint8(await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY));
      const pdf = buildJpegPdf([{ jpeg, pxWidth: width, pxHeight: height }]);
      return blobToUint8(pdf);
    }
  }
}
