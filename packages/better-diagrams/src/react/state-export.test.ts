/**
 * The combo→download runner, exercised with injected fake renderers — no real
 * canvas. What's under test is the packing logic: one file vs zip vs
 * multi-page PDF, and the state-suffixed names inside.
 */
import { describe, expect, it } from "vitest";
import type { StateAxes, StateCombo } from "../contract/states";
import type { RenderedCanvas } from "./export-helpers";
import { runStateExport } from "./state-export";

const axes: StateAxes = {
  zones: [{ zoneId: "z", label: "Zone", slug: "zone", providers: ["a", "b"], current: "a" }],
  stops: ["2026-01-01", "2026-06-01"],
};
const combo = (provider: string, at: string | null): StateCombo => ({
  providers: { z: provider },
  at,
});

/** A "canvas" whose toBlob emits its payload string plus the requested type. */
const fakeCanvas = (payload: string): RenderedCanvas =>
  ({
    canvas: {
      width: 200,
      height: 100,
      toBlob(cb: (b: Blob | null) => void, type?: string) {
        cb(new Blob([new TextEncoder().encode(`${payload}:${type}`)], { type }));
      },
    },
    width: 100,
    height: 50,
  }) as unknown as RenderedCanvas;

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Entry names, read from the central directory the way an unzipper would. */
function zipNames(out: Uint8Array): string[] {
  const dv = new DataView(out.buffer, out.byteOffset);
  const eocd = out.length - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = dv.getUint16(at + 28, true);
    names.push(new TextDecoder().decode(out.slice(at + 46, at + 46 + nameLen)));
    at += 46 + nameLen;
  }
  return names;
}

describe("runStateExport", () => {
  it("a single combo exports a lone state-suffixed file", async () => {
    const result = await runStateExport({
      format: "svg",
      filename: "diagram",
      axes,
      combos: [combo("a", "2026-01-01")],
      pdfLayout: "single",
      materialize: (c) => c,
      renderSvg: (c) => `<svg>${c.providers.z}</svg>`,
    });
    expect(result.filename).toBe("diagram--zone-a--2026-01-01.svg");
    expect(new TextDecoder().decode(await blobBytes(result.blob))).toBe("<svg>a</svg>");
  });

  it("several svg combos pack into a zip, named per state", async () => {
    const combos = [
      combo("a", "2026-01-01"),
      combo("a", "2026-06-01"),
      combo("b", "2026-01-01"),
      combo("b", "2026-06-01"),
    ];
    const result = await runStateExport({
      format: "svg",
      filename: "diagram",
      axes,
      combos,
      pdfLayout: "single",
      materialize: (c) => c,
      renderSvg: (c) => `<svg>${c.providers.z}:${c.at}</svg>`,
    });
    expect(result.filename).toBe("diagram-states.zip");
    expect(zipNames(await blobBytes(result.blob))).toEqual([
      "diagram--zone-a--2026-01-01.svg",
      "diagram--zone-a--2026-06-01.svg",
      "diagram--zone-b--2026-01-01.svg",
      "diagram--zone-b--2026-06-01.svg",
    ]);
  });

  it("pdf 'single' renders every combo as a page of one file", async () => {
    const result = await runStateExport({
      format: "pdf",
      filename: "diagram",
      axes,
      combos: [combo("a", "2026-01-01"), combo("b", "2026-01-01"), combo("b", "2026-06-01")],
      pdfLayout: "single",
      materialize: (c) => c,
      renderCanvas: (c) => fakeCanvas(`page-${c.providers.z}-${c.at}`),
    });
    expect(result.filename).toBe("diagram-states.pdf");
    const text = new TextDecoder("latin1").decode(await blobBytes(result.blob));
    expect(text).toContain("/Count 3");
    expect(text).toContain("page-a-2026-01-01:image/jpeg");
    expect(text).toContain("page-b-2026-06-01:image/jpeg");
  });

  it("pdf 'separate' zips one single-page pdf per combo", async () => {
    const result = await runStateExport({
      format: "pdf",
      filename: "diagram",
      axes,
      combos: [combo("a", null), combo("b", null)],
      pdfLayout: "separate",
      materialize: (c) => c,
      renderCanvas: (c) => fakeCanvas(`doc-${c.providers.z}`),
    });
    expect(result.filename).toBe("diagram-states.zip");
    const bytes = await blobBytes(result.blob);
    expect(zipNames(bytes)).toEqual(["diagram--zone-a.pdf", "diagram--zone-b.pdf"]);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.match(/%PDF-/g)).toHaveLength(2);
    expect(text).toContain("/Count 1");
  });

  it("png combos zip as pngs", async () => {
    const result = await runStateExport({
      format: "png",
      filename: "diagram",
      axes,
      combos: [combo("a", null), combo("b", null)],
      pdfLayout: "single",
      materialize: (c) => c,
      renderCanvas: (c) => fakeCanvas(`img-${c.providers.z}`),
    });
    expect(zipNames(await blobBytes(result.blob))).toEqual([
      "diagram--zone-a.png",
      "diagram--zone-b.png",
    ]);
    const text = new TextDecoder("latin1").decode(await blobBytes(result.blob));
    expect(text).toContain("img-a:image/png");
  });

  it("refuses an empty combo list", async () => {
    await expect(
      runStateExport({
        format: "svg",
        filename: "d",
        axes,
        combos: [],
        pdfLayout: "single",
        materialize: (c) => c,
        renderSvg: () => "<svg/>",
      }),
    ).rejects.toThrow();
  });
});
