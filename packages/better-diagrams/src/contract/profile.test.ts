/**
 * profile.test.ts — observed data statistics: read from a folder import's
 * forensics.json, repaired, carried on field records, shown in the data
 * dictionary, and checked against what the schema declares.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFolderToFileMap } from "./folder/node";
import { importFolder } from "./folder/import";
import { documentFieldRecords, tableProfile } from "./fields";
import { lintTemplate } from "./lint";
import { dataDictionary, dictionaryCsv, dictionaryMarkdown } from "./dictionary";
import type { DiagramTemplate } from "./schema";

const FIXTURE = fileURLToPath(new URL("./folder/fixtures/datamodel-mini", import.meta.url));

/** The mini data model, with Account profiled. */
async function profiled(): Promise<DiagramTemplate> {
  const files = new Map(await readFolderToFileMap(FIXTURE));
  files.set(
    "core/account/forensics.json",
    JSON.stringify({
      automation: { flows: 3 },
      dataProfile: {
        lastModified: "2026-09-01T00:00:00Z",
        profiledAt: "2026-09-30T06:00:00Z",
        rowCount: 120,
        columns: {
          Name: { nullRate: 0.025, distinct: 117 },
          external_key: { nullRate: 0.5, distinct: 50 },
          owner_id: { orphanRate: 0.01, distinct: 8 },
          industry: { nullRate: 0.3, distinct: 12, min: "Agriculture", max: "Utilities" },
          bogus: { nullRate: 7, distinct: "many" },
        },
      },
    }),
  );
  return importFolder(files).template;
}

describe("a table's profile", () => {
  it("comes from forensics.json's dataProfile, repaired on read", async () => {
    const doc = await profiled();
    const account = doc.nodes.find((n) => n.id === "core/account")!;
    expect(tableProfile(account)).toEqual({
      rowCount: 120,
      profiledAt: "2026-09-30T06:00:00Z",
      lastModified: "2026-09-01T00:00:00Z",
      columns: {
        Name: { nullRate: 0.025, distinct: 117 },
        external_key: { nullRate: 0.5, distinct: 50 },
        owner_id: { distinct: 8, orphanRate: 0.01 },
        industry: { nullRate: 0.3, distinct: 12, min: "Agriculture", max: "Utilities" },
      },
    });
    expect(tableProfile({ data: { model: { profile: "nope" } } })).toBeUndefined();
  });

  it("reaches each field record by column name, whatever its case", async () => {
    const records = documentFieldRecords(await profiled()).get("core/account")!;
    expect(records.find((r) => r.name === "name")!.profile).toEqual({ nullRate: 0.025, distinct: 117 });
    expect(records.find((r) => r.name === "description")!.profile).toBeUndefined();
  });
});

describe("checks: declared against observed", () => {
  it("finds a required column with nulls, a unique one with duplicates, and keys pointing at missing rows", async () => {
    const findings = lintTemplate(await profiled()).filter((f) => /^dm-(required-has-nulls|unique-has-duplicates|orphaned-references)$/.test(f.rule));
    expect(findings.map((f) => [f.rule, f.message])).toEqual([
      ["dm-required-has-nulls", '"Account.name" is declared required, but 2.5% of rows are null'],
      ["dm-unique-has-duplicates", '"Account.external_key" is declared unique, but has 50 distinct values in 60 rows'],
      ["dm-orphaned-references", '"Account.owner_id": 1% of values match no row of user'],
    ]);
    expect(findings[0]!.fields).toEqual([{ nodeId: "core/account", fieldId: "name" }]);
  });

  it("say nothing about a table nobody profiled", async () => {
    const files = await readFolderToFileMap(FIXTURE);
    const findings = lintTemplate(importFolder(files).template).filter((f) => /^dm-(required-has-nulls|unique-has-duplicates|orphaned-references)$/.test(f.rule));
    expect(findings).toEqual([]);
  });

  it("leave one column of a composite key alone — it repeats by design", () => {
    const doc = {
      version: 1 as const,
      nodes: [
        {
          id: "lines",
          label: "Lines",
          kind: "table",
          icon: "none",
          description: "",
          parentId: null,
          fields: [
            { id: "order_id", name: "order_id", key: "pk" as const },
            { id: "line_no", name: "line_no", key: "pk" as const },
          ],
          data: { model: { profile: { rowCount: 100, columns: { order_id: { distinct: 30 }, line_no: { distinct: 5 } } } } },
        },
      ],
      edges: [],
    } as unknown as DiagramTemplate;
    expect(lintTemplate(doc).filter((f) => f.rule === "dm-unique-has-duplicates")).toEqual([]);
  });
});

describe("the dictionary with a profile", () => {
  it("adds Nulls and Distinct, and says when the table changed and was profiled", async () => {
    const tables = dataDictionary(await profiled());
    const md = dictionaryMarkdown(tables);
    expect(md).toContain("Last changed: 2026-09-01 · Profiled: 2026-09-30");
    expect(md).toContain("| Nulls | Distinct |");
    expect(md).toMatch(/\| name \|.*\| 2\.5% \| 117 \|/);
    const csv = dictionaryCsv(tables);
    expect(csv.split("\r\n")[0]).toMatch(/,Nulls,Distinct$/);
  });

  it("leaves both columns out when nothing was profiled", async () => {
    const files = await readFolderToFileMap(FIXTURE);
    const tables = dataDictionary(importFolder(files).template);
    expect(dictionaryMarkdown(tables)).not.toContain("Nulls");
    expect(dictionaryCsv(tables).split("\r\n")[0]).not.toContain("Nulls");
  });
});
