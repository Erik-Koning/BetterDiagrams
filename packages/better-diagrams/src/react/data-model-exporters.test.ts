/**
 * data-model-exporters.test.ts — the data dictionary and schema change
 * report exporters: when the Export menu offers them, and what they write.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_EXPORTERS } from "./exporters";
import { createRegistry } from "./create-registry";
import { EXAMPLE_TEMPLATE, validateTemplate } from "../contract/schema";
import bakeryJson from "../../../../templates/examples/bakery-data-model.json";

const registry = createRegistry();
const bakery = validateTemplate(bakeryJson);

describe("data-model exporters", () => {
  it("offer a dictionary only for a model with tables, and a change report only against a baseline", () => {
    const { "dictionary-md": md, "dictionary-csv": csv, "schema-report": report } = BUILTIN_EXPORTERS;
    expect(md!.available!({ template: bakery })).toBe(true);
    expect(csv!.available!({ template: EXAMPLE_TEMPLATE })).toBe(false);
    expect(report!.available!({ template: bakery })).toBe(false);
    expect(report!.available!({ template: bakery, diffBase: bakery })).toBe(true);
  });

  it("write the dictionary as Markdown and CSV", async () => {
    const md = await (await BUILTIN_EXPORTERS["dictionary-md"]!.run({ template: bakery, registry, filename: "bakery" }))!.blob.text();
    expect(md).toMatch(/^# Bakery data model — data dictionary\n/);
    expect(md).toContain("| Field | Label | Type | Key | Required | References | Tags | Description |");
    const out = await BUILTIN_EXPORTERS["dictionary-csv"]!.run({ template: bakery, registry, filename: "bakery" });
    expect(out!.filename).toBe("bakery-dictionary.csv");
    expect((await out!.blob.text()).split("\r\n").length).toBeGreaterThan(10);
  });

  it("write a self-contained change report, filtered in the page", async () => {
    const next = validateTemplate({ ...bakery, nodes: bakery.nodes.filter((n) => n.id !== "cutlery") });
    const out = await BUILTIN_EXPORTERS["schema-report"]!.run({ template: next, diffBase: bakery, registry, filename: "bakery" });
    const html = await out!.blob.text();
    expect(out!.filename).toBe("bakery-schema-changes.html");
    expect(html).toMatch(/<p class="summary">\d+ breaking · \d+ caution · \d+ safe · 1 removed<\/p>/);
    expect(html).toContain('data-filter="breaking"');
    expect(html).not.toMatch(/src="http|href="http|@import/);
  });
});
