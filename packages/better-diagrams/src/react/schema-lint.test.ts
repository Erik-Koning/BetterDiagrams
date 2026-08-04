/**
 * schema-lint tests. EditorState + the JSON language parse headlessly — no
 * DOM, no EditorView — so these run in the default node environment.
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import {
  SEQUENCE_LINT,
  buildArchitectureLint,
  docDiagnostics,
  type JsonDocLint,
} from "./schema-lint";
import { EXAMPLE_TEMPLATE, EXAMPLE_ZONED_TEMPLATE } from "../contract/schema";
import { EXAMPLE_SEQUENCE } from "../contract/sequence";

const ARCH = buildArchitectureLint();

function warnings(doc: string, lint: JsonDocLint = ARCH) {
  const state = EditorState.create({ doc, extensions: [json()] });
  return docDiagnostics(state, lint);
}

describe("docDiagnostics — keys", () => {
  it("flags an unknown top-level key as a warning, positioned on the key", () => {
    const doc = '{"version": 1, "nodes": [], "edges": [], "layout": "auto"}';
    const found = warnings(doc);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].message).toContain('Unknown key "layout"');
    expect(found[0].message).toContain("ignored on insert");
    expect(doc.slice(found[0].from, found[0].to)).toBe('"layout"');
  });

  it("flags unknown node keys and suggests near misses", () => {
    const doc = '{"version": 1, "nodes": [{"id": "a", "lable": "API"}], "edges": []}';
    const found = warnings(doc);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('did you mean "label"?');
  });

  it("checks edges and zones at their own vocabularies", () => {
    const doc = JSON.stringify({
      version: 1,
      zones: [{ id: "z", label: "Z", sparkles: true }],
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      edges: [{ id: "e", source: "a", target: "b", weight: 3 }],
    });
    const messages = warnings(doc).map((d) => d.message);
    expect(messages).toHaveLength(2);
    expect(messages.join(" ")).toContain('"sparkles"');
    expect(messages.join(" ")).toContain('"weight"');
  });

  it("lets meta carry arbitrary keys — its index signature allows them", () => {
    const doc = '{"version": 1, "meta": {"anything": 1, "goes": true}, "nodes": [], "edges": []}';
    expect(warnings(doc)).toHaveLength(0);
  });

  it("does not descend into structures it does not know", () => {
    const doc = '{"version": 1, "nodes": [], "edges": [], "layout": {"algo": "elk"}}';
    const found = warnings(doc);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"layout"');
  });

  it("only warns on the key when it is misspelled — the value rule never fires", () => {
    const doc = JSON.stringify({
      version: 1,
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      edges: [{ id: "e", source: "a", target: "b", stlye: "wavy" }],
    });
    const found = warnings(doc);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('Unknown key "stlye"');
  });
});

describe("docDiagnostics — values", () => {
  it("flags an unknown node kind with the coercion consequence, on the value", () => {
    const doc = '{"version": 1, "nodes": [{"id": "a", "label": "A", "kind": "spaceship"}], "edges": []}';
    const found = warnings(doc);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('Unknown kind "spaceship"');
    expect(found[0].message).toContain('It will be inserted as "service".');
    expect(doc.slice(found[0].from, found[0].to)).toBe('"spaceship"');
  });

  it("suggests a near-miss value", () => {
    const doc = '{"version": 1, "nodes": [{"id": "a", "label": "A", "kind": "databse"}], "edges": []}';
    expect(warnings(doc)[0].message).toContain('did you mean "database"?');
  });

  it("accepts registry-extended kinds only when the vocab includes them", () => {
    const doc = '{"version": 1, "nodes": [{"id": "a", "label": "A", "kind": "lambda"}], "edges": []}';
    expect(warnings(doc, buildArchitectureLint({ kinds: ["lambda"] }))).toHaveLength(0);
    expect(warnings(doc)).toHaveLength(1);
  });

  it("never warns on legal-but-stripped defaults (active / forward / solid)", () => {
    const doc = JSON.stringify({
      version: 1,
      zones: [
        { id: "z", label: "Z", providers: ["azure"], provider: "azure", outline: "solid" },
      ],
      nodes: [
        { id: "a", label: "A", status: "active" },
        { id: "b", label: "B" },
      ],
      edges: [{ id: "e", source: "a", target: "b", direction: "forward" }],
    });
    expect(warnings(doc)).toHaveLength(0);
  });

  it("flags each unknown providers entry with the kept-but-hidden consequence", () => {
    const doc = JSON.stringify({
      version: 1,
      nodes: [{ id: "a", label: "A", providers: ["azzure", "aws", "gpc"] }],
      edges: [],
    });
    const found = warnings(doc);
    expect(found).toHaveLength(2);
    expect(found[0].message).toContain('Unknown provider "azzure"');
    expect(found[0].message).toContain('did you mean "azure"?');
    expect(found[0].message).toContain("kept on insert");
    expect(found[1].message).toContain('"gpc"');
  });
});

describe("docDiagnostics — references", () => {
  it("flags a dangling edge source as a dropped edge; the resolving end stays silent", () => {
    const doc = JSON.stringify({
      version: 1,
      nodes: [{ id: "a", label: "A" }],
      edges: [{ id: "e", source: "ghost", target: "a" }],
    });
    const found = warnings(doc);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('Unknown node id "ghost"');
    expect(found[0].message).toContain("The whole edge will be dropped on insert.");
  });

  it("flags dangling parentId/zoneId as cleared; null is silent", () => {
    const doc = JSON.stringify({
      version: 1,
      nodes: [
        { id: "a", label: "A", parentId: "nope", zoneId: "nozone" },
        { id: "b", label: "B", parentId: null },
      ],
      edges: [],
    });
    const messages = warnings(doc).map((d) => d.message);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.includes("It will be cleared on insert."))).toBe(true);
  });

  it("checks zone provider against the zone's OWN list, not the global one", () => {
    // "aws" is globally known — the warning is about this zone's list.
    const doc = JSON.stringify({
      version: 1,
      zones: [{ id: "z", label: "Z", providers: ["azure"], provider: "aws" }],
      nodes: [],
      edges: [],
    });
    const found = warnings(doc);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("not one of this zone's providers");
    expect(found[0].message).toContain('fall back to "azure"');
  });

  it("checks the zone provider regardless of property order", () => {
    // `provider` written BEFORE `providers` — the sibling scan must not
    // depend on document order.
    const doc =
      '{"version": 1, "zones": [{"id": "z", "label": "Z", "provider": "aws", "providers": ["azure"]}], "nodes": [], "edges": []}';
    const found = warnings(doc);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('fall back to "azure"');
  });

  it("warns on both endpoints when both dangle — each is individually true", () => {
    const doc = JSON.stringify({
      version: 1,
      nodes: [{ id: "a", label: "A" }],
      edges: [{ id: "e", source: "ghost", target: "phantom" }],
    });
    expect(warnings(doc)).toHaveLength(2);
  });

  it("stays silent on a zone provider when the zone lists no providers", () => {
    // The validator synthesizes [provider] — legal, not a mistake.
    const doc = JSON.stringify({
      version: 1,
      zones: [{ id: "z", label: "Z", provider: "somewhere" }],
      nodes: [],
      edges: [],
    });
    expect(warnings(doc)).toHaveLength(0);
  });
});

describe("docDiagnostics — sequence", () => {
  const seq = (doc: string) => warnings(doc, SEQUENCE_LINT);

  it("checks the sequence vocabularies, including nested fragment elses", () => {
    const doc = JSON.stringify({
      version: 1,
      participants: [{ id: "a", label: "A", kind: "actor", colour: "red" }],
      messages: [{ id: "m", from: null, to: "a", label: "x", style: "sync" }],
      fragments: [
        { id: "f", kind: "alt", label: "", from: "m", to: "m", elses: [{ label: "x", at: "m", why: 1 }] },
      ],
    });
    const messages = seq(doc).map((d) => d.message);
    expect(messages).toHaveLength(2);
    expect(messages.join(" ")).toContain('"colour"');
    expect(messages.join(" ")).toContain('"why"');
    expect(messages[0]).toContain("sequence schema");
  });

  it("reports a cascade only at its root cause", () => {
    // The message's dangling `from` dooms it — but the activation that
    // references the doomed message id stays quiet; its id IS declared.
    const doc = JSON.stringify({
      version: 1,
      participants: [{ id: "a", label: "A", kind: "actor" }],
      messages: [{ id: "m", from: "ghost", to: "a", label: "x", style: "sync" }],
      activations: [{ id: "b1", participant: "a", from: "m" }],
    });
    const found = seq(doc);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('Unknown participant id "ghost"');
    expect(found[0].message).toContain("The whole message will be dropped on insert.");
  });

  it("treats null endpoints as legal (lost/found) and dangling note anchors as ignored", () => {
    const doc = JSON.stringify({
      version: 1,
      participants: [{ id: "a", label: "A", kind: "actor" }],
      messages: [{ id: "m", from: null, to: "a", label: "x", style: "sync" }],
      notes: [{ id: "n", text: "t", side: "over", participant: "a", at: "nope" }],
    });
    const found = seq(doc);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('Unknown message id "nope"');
    expect(found[0].message).toContain("It will be ignored on insert.");
  });

  it("resolves ids the validator INVENTS for id-less elements", () => {
    // A participant with no id becomes "p1" on insert — referencing it is fine.
    const doc = JSON.stringify({
      version: 1,
      participants: [{ label: "A", kind: "actor" }],
      messages: [{ id: "m", from: "p1", to: null, label: "x", style: "sync" }],
    });
    expect(seq(doc)).toHaveLength(0);
  });
});

describe("docDiagnostics — dates", () => {
  it("accepts everything normalizeDate reads, warns on the rest, skips empty", () => {
    const doc = JSON.stringify({
      version: 1,
      nodes: [
        { id: "a", label: "A", date: "2026/3" },
        { id: "b", label: "B", date: "2026-03-14T10:00:00Z" },
        { id: "c", label: "C", date: "" },
        { id: "d", label: "D", date: "next spring" },
        { id: "e", label: "E", date: "14-03-2026" },
      ],
      edges: [],
    });
    const found = warnings(doc);
    expect(found).toHaveLength(2);
    expect(found.every((d) => d.message.includes("Unrecognisable date"))).toBe(true);
    expect(found.every((d) => d.message.includes("It will be ignored on insert."))).toBe(true);
  });
});

describe("docDiagnostics — robustness", () => {
  it("accepts the shipped examples without a single warning", () => {
    expect(warnings(JSON.stringify(EXAMPLE_TEMPLATE, null, 2))).toHaveLength(0);
    expect(warnings(JSON.stringify(EXAMPLE_ZONED_TEMPLATE, null, 2))).toHaveLength(0);
    expect(warnings(JSON.stringify(EXAMPLE_SEQUENCE, null, 2), SEQUENCE_LINT)).toHaveLength(0);
  });

  it("skips reference checks on documents that do not parse — no crash, no wrong warnings", () => {
    expect(warnings('{"version": 1, "edges": [{"source": "a"')).toHaveLength(0);
  });

  it("survives a property with no value yet — mid-typing states never crash", () => {
    expect(() => warnings('{"version": 1, "nodes": [{"kind": }], "edges": []}')).not.toThrow();
    expect(() => warnings('{"nodes": [{"kind"')).not.toThrow();
    expect(() => warnings("[1, 2")).not.toThrow();
  });
});
