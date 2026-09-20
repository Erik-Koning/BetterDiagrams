/**
 * @vitest-environment jsdom
 *
 * folder-exporters.test.ts — the two folder exporters hand back a zip whose
 * entries are exactly the file map `exportFolder` produces.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_EXPORTERS, FOLDER_EXPORTERS } from "./exporters";
import { resolveRegistry } from "./registry";
import { EXAMPLE_TEMPLATE, validateTemplate } from "../contract/schema";
import { exportFolder } from "../contract/folder";
import type { ExportContext } from "./registry-types";

const ctx = (): ExportContext => ({
  template: validateTemplate(EXAMPLE_TEMPLATE),
  registry: resolveRegistry(),
  filename: "clinic",
});

/** Entry names of a store-only zip: each local header's name field. */
async function zipNames(blob: Blob): Promise<string[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const names: string[] = [];
  let at = 0;
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const size = view.getUint32(at + 18, true);
    names.push(new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen)));
    at += 30 + nameLen + extraLen + size;
  }
  return names;
}

describe("folder exporters", () => {
  it("folder-full zips the whole generic tree", async () => {
    const out = (await BUILTIN_EXPORTERS["folder-full"].run(ctx())) as { blob: Blob; filename: string };
    expect(out.filename).toBe("clinic-folder.zip");
    const expected = [...exportFolder(ctx().template, { mode: "full" }).files.keys()];
    expect((await zipNames(out.blob)).sort()).toEqual(expected.sort());
  });

  it("folder-sidecar is opt-in and zips only .better-diagrams/", async () => {
    expect(BUILTIN_EXPORTERS["folder-sidecar"]).toBeUndefined();
    const out = (await FOLDER_EXPORTERS["folder-sidecar"].run(ctx())) as { blob: Blob; filename: string };
    expect(out.filename).toBe("clinic-sidecar.zip");
    expect((await zipNames(out.blob)).sort()).toEqual([".better-diagrams/layout.json", ".better-diagrams/overrides.json"]);
  });
});
