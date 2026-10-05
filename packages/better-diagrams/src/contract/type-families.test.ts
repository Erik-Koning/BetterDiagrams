/**
 * type-families.test.ts — when two column types are the same type.
 */
import { describe, expect, it } from "vitest";
import { normalizeType, sameType } from "./type-families";

describe("normalizeType", () => {
  it("lowercases, collapses space, splits parameters and folds synonyms", () => {
    expect(normalizeType("VARCHAR(255)")).toEqual({ family: "varchar", params: "255" });
    expect(normalizeType(" character  varying (36) ")).toEqual({ family: "varchar", params: "36" });
    expect(normalizeType("NUMERIC(10, 2)")).toEqual({ family: "decimal", params: "10,2" });
    expect(normalizeType("int4")).toEqual({ family: "integer" });
    expect(normalizeType("timestamp with time zone")).toEqual({ family: "timestamptz" });
    expect(normalizeType('"uuid"')).toEqual({ family: "uuid" });
    expect(normalizeType("int[]")).toEqual({ family: "integer[]" });
  });

  it("calls a missing type untyped, and keeps near relations apart", () => {
    expect(normalizeType(undefined)).toEqual({ family: "untyped" });
    expect(normalizeType("  ")).toEqual({ family: "untyped" });
    expect(normalizeType("bigint").family).not.toBe(normalizeType("int").family);
    expect(normalizeType("text").family).not.toBe(normalizeType("varchar").family);
  });

  it("folds a platform's reference into the id it points at, and takes a host's own aliases", () => {
    expect(normalizeType("reference").family).toBe(normalizeType("id").family);
    expect(normalizeType("string", { string: "text" })).toEqual({ family: "text" });
  });
});

describe("sameType", () => {
  it("compares families, or parameters too when strict", () => {
    expect(sameType("varchar(36)", "VARCHAR(255)")).toBe(true);
    expect(sameType("varchar(36)", "VARCHAR(255)", { strict: true })).toBe(false);
    expect(sameType("uuid", "varchar(36)")).toBe(false);
  });
});
