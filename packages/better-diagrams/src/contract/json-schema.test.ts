import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import { diagramJsonSchema, type JsonSchema } from "./json-schema";
import {
  EDGE_KEYS,
  EXAMPLE_TEMPLATE,
  EXAMPLE_ZONED_TEMPLATE,
  NODE_FIELD_KEYS,
  NODE_KEYS,
  SETTINGS_KEYS,
  TEMPLATE_KEYS,
  validateTemplate,
} from "./schema";
import { ZONE_KEYS } from "./zones";
import { PATH_KEYS } from "./paths";

const compile = (schema: JsonSchema) => new Ajv2020({ strict: true, allowUnionTypes: true }).compile(schema);
const schema = diagramJsonSchema();
const validate = compile(schema);
const defs = schema.$defs as Record<string, { properties: Record<string, unknown> }>;
const keysOf = (part: { properties: Record<string, unknown> }) => Object.keys(part.properties).sort();

/** The repo's example documents — real ones, written in the editor. */
const EXAMPLES_DIR = join(__dirname, "../../../../templates/examples");
const examples = readdirSync(EXAMPLES_DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, doc: JSON.parse(readFileSync(join(EXAMPLES_DIR, name), "utf8")) }))
  .filter(({ doc }) => Array.isArray(doc.nodes));

describe("diagramJsonSchema", () => {
  it("is a schema ajv compiles in strict mode", () => {
    expect(typeof validate).toBe("function");
  });

  it("describes every key validation keeps — and nothing else", () => {
    expect(Object.keys(schema.properties as object).sort()).toEqual([...TEMPLATE_KEYS].sort());
    expect(keysOf(defs.node)).toEqual([...NODE_KEYS].sort());
    expect(keysOf(defs.edge)).toEqual([...EDGE_KEYS].sort());
    expect(keysOf(defs.zone)).toEqual([...ZONE_KEYS].sort());
    expect(keysOf(defs.path)).toEqual([...PATH_KEYS].sort());
    expect(keysOf(defs.field)).toEqual([...NODE_FIELD_KEYS].sort());
    expect(keysOf((schema.properties as Record<string, { properties: Record<string, unknown> }>).settings)).toEqual(
      [...SETTINGS_KEYS].sort(),
    );
  });

  it("accepts every validated document", () => {
    expect(examples.length).toBeGreaterThan(2);
    for (const { name, doc } of [
      { name: "EXAMPLE_TEMPLATE", doc: EXAMPLE_TEMPLATE },
      { name: "EXAMPLE_ZONED_TEMPLATE", doc: EXAMPLE_ZONED_TEMPLATE },
      ...examples,
    ]) {
      const ok = validate(validateTemplate(doc));
      expect(ok ? [] : validate.errors, name).toEqual([]);
    }
  });

  it("rejects what validation would repair: a typo'd key, an unknown kind, a bad colour", () => {
    const base = validateTemplate(EXAMPLE_TEMPLATE);
    const node = base.nodes[0];
    expect(validate({ ...base, nodes: [{ ...node, colour: "#fff" }] })).toBe(false);
    expect(validate.errors![0]).toMatchObject({ keyword: "additionalProperties", params: { additionalProperty: "colour" } });
    expect(validate({ ...base, nodes: [{ ...node, kind: "vault" }] })).toBe(false);
    expect(validate({ ...base, nodes: [{ ...node, color: "red" }] })).toBe(false);
    expect(validate({ ...base, edges: [{ source: "a", target: "b", style: "zigzag" }] })).toBe(false);
  });

  it("takes a registry's kinds and icons", () => {
    const custom = compile(diagramJsonSchema({ knownKinds: ["vault"], knownIcons: ["key"] }));
    const doc = { nodes: [{ id: "v", kind: "vault", icon: "key" }], edges: [] };
    expect(custom(doc)).toBe(true);
    expect(validate(doc)).toBe(false);
  });

  it("keeps a $schema reference through validation", () => {
    const doc = validateTemplate({ $schema: "./node_modules/@mosphere/better-diagrams/schema.json", nodes: [], edges: [] });
    expect(Object.keys(doc)[0]).toBe("$schema");
    expect(validate(doc)).toBe(true);
  });
});
