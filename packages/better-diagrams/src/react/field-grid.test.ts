/**
 * field-grid.test.ts — the grid's pure half: sorting is stable and puts the
 * interesting values first, filtering reads every text column, and the two
 * exports escape what they must.
 */
import { describe, expect, it } from "vitest";
import type { FieldRecord } from "../contract/fields";
import { GRID_COLUMNS, cellText, fileSlug, filterRecords, sortRecords, toCsv, toTsv } from "./field-grid";

const rec = (over: Partial<FieldRecord> & { id: string }): FieldRecord => ({
  name: over.id,
  row: true,
  fk: [],
  ...over,
});

const RECORDS: FieldRecord[] = [
  rec({ id: "Id", key: "pk", type: "id" }),
  rec({ id: "Name", label: "Account Name", type: "string", required: true }),
  rec({ id: "OwnerId", key: "fk", type: "→ User", required: true, fk: [{ label: "User" }] }),
  rec({ id: "ParentId", key: "fk", type: "→ Account", fk: [{ label: "Account", nodeId: "core/account", edgeId: "e" }] }),
  rec({ id: "Score", type: "double", formula: 'IF(Amount > 10, "big", "small")', unique: true, externalId: true, row: false }),
  rec({ id: "Description", type: "textarea", visible: false, row: false }),
];

describe("cellText", () => {
  it("renders keys, ticks, references and visibility as short text", () => {
    const by = Object.fromEntries(RECORDS.map((r) => [r.id, r]));
    expect(cellText(by.Id, "key")).toBe("PK");
    expect(cellText(by.Name, "required")).toBe("✓");
    expect(cellText(by.Id, "required")).toBe("");
    expect(cellText(by.ParentId, "fk")).toBe("→ Account");
    expect(cellText(by.Description, "visible")).toBe("hidden");
    expect(cellText(by.Score, "externalId")).toBe("✓");
    expect(cellText(by.Score, "formula")).toBe('IF(Amount > 10, "big", "small")');
    expect(cellText(by.Name, "label")).toBe("Account Name");
    expect(cellText(by.Id, "label")).toBe("");
  });
});

describe("filterRecords", () => {
  it("matches name, label, type, formula and reference labels, case-insensitively", () => {
    const ids = (q: string) => filterRecords(RECORDS, q).map((r) => r.id);
    expect(ids("account")).toEqual(["Name", "ParentId"]);
    expect(ids("USER")).toEqual(["OwnerId"]);
    expect(ids("amount")).toEqual(["Score"]);
    expect(ids("textarea")).toEqual(["Description"]);
    expect(ids("")).toHaveLength(RECORDS.length);
    expect(filterRecords(RECORDS, "")).not.toBe(RECORDS);
  });
});

describe("sortRecords", () => {
  it("text ascending puts empties last; descending inverts the comparison; ties keep document order", () => {
    expect(sortRecords(RECORDS, "label", "asc").map((r) => r.id)).toEqual(["Name", "Id", "OwnerId", "ParentId", "Score", "Description"]);
    expect(sortRecords(RECORDS, "label", "desc").map((r) => r.id)).toEqual(["Id", "OwnerId", "ParentId", "Score", "Description", "Name"]);
    expect(sortRecords(RECORDS, "type", "asc").map((r) => r.id)).toEqual(["Score", "Id", "Name", "Description", "ParentId", "OwnerId"]);
  });

  it("booleans put true first, keys pk before fk before none", () => {
    expect(sortRecords(RECORDS, "required", "asc").map((r) => r.id)).toEqual(["Name", "OwnerId", "Id", "ParentId", "Score", "Description"]);
    expect(sortRecords(RECORDS, "key", "asc").map((r) => r.id)).toEqual(["Id", "OwnerId", "ParentId", "Name", "Score", "Description"]);
    expect(sortRecords(RECORDS, "visible", "asc").map((r) => r.id).at(-1)).toBe("Description");
    expect(sortRecords(RECORDS, "fk", "asc").map((r) => r.id).slice(0, 2)).toEqual(["ParentId", "OwnerId"]);
  });

  it("does not mutate its input", () => {
    const copy = [...RECORDS];
    sortRecords(RECORDS, "name", "desc");
    expect(RECORDS).toEqual(copy);
  });
});

describe("exports", () => {
  it("CSV quotes commas, quotes and newlines, with CRLF ends", () => {
    const csv = toCsv([rec({ id: "F", label: 'say "hi", now', formula: "a\nb" })], GRID_COLUMNS);
    const [head, row, tail] = csv.split("\r\n");
    expect(head).toBe(GRID_COLUMNS.map((c) => c.title).join(","));
    expect(row).toBe(',F,"say ""hi"", now",,,,,,,"a\nb"'.replace("\n", "\n"));
    expect(tail).toBe("");
    expect(toCsv([])).toBe(`${GRID_COLUMNS.map((c) => c.title).join(",")}\r\n`);
  });

  it("TSV flattens tabs and newlines inside a cell", () => {
    const tsv = toTsv([rec({ id: "F", formula: "a\tb\nc" })]);
    const lines = tsv.split("\n");
    expect(lines[0].split("\t")).toEqual(GRID_COLUMNS.map((c) => c.title));
    expect(lines[1].split("\t").at(-1)).toBe("a b c");
    expect(lines[1].split("\t")).toHaveLength(GRID_COLUMNS.length);
  });

  it("slugs a label for a filename", () => {
    expect(fileSlug("Case Comment (legacy)")).toBe("case-comment-legacy");
    expect(fileSlug("   ")).toBe("node");
  });
});
