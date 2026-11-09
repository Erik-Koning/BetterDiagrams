import { describe, expect, it } from "vitest";
import { elementSpans, selectedSpans } from "./json-ranges";

const doc = {
  version: 1,
  meta: { title: "Shop", note: "a \"quoted\" {brace} [bracket]" },
  nodes: [
    { id: "web", label: "Storefront", x: 0, tags: ["edge", "public"], data: { id: "not-me" } },
    { id: "api", label: "Orders API" },
  ],
  edges: [{ id: "e1", source: "web", target: "api" }],
  zones: [],
};

describe("where a diagram's elements sit in its JSON", () => {
  for (const [name, text] of [
    ["pretty", JSON.stringify(doc, null, 2)],
    ["tabs", JSON.stringify(doc, null, "\t")],
    ["one line", JSON.stringify(doc)],
  ] as const) {
    it(`finds each element's whole object by section and id (${name})`, () => {
      const spans = elementSpans(text);
      for (const [section, id] of [["nodes", "web"], ["nodes", "api"], ["edges", "e1"]] as const) {
        const span = spans.get(section)!.get(id)!;
        const object = JSON.parse(text.slice(span.start, span.end));
        expect(object.id).toBe(id);
      }
      // A nested object's id is the node's data, not an element.
      expect([...spans.get("nodes")!.keys()]).toEqual(["web", "api"]);
      expect(spans.has("zones")).toBe(false);
    });
  }

  it("lights the selection in document order, ignoring ids that aren't there", () => {
    const text = JSON.stringify(doc, null, 2);
    const spans = selectedSpans(text, { edges: ["e1"], nodes: ["api", "gone"], zones: [] });
    expect(spans.map((s) => JSON.parse(text.slice(s.start, s.end)).id)).toEqual(["api", "e1"]);
    expect(selectedSpans(text, null)).toEqual([]);
  });

  it("gives what it found before text that isn't whole JSON, and nothing for text that isn't an object", () => {
    const text = JSON.stringify(doc, null, 2);
    const cut = text.slice(0, text.indexOf('"edges"') + 20);
    expect([...elementSpans(cut).get("nodes")!.keys()]).toEqual(["web", "api"]);
    expect(elementSpans("[1, 2]").size).toBe(0);
    expect(elementSpans("").size).toBe(0);
  });
});
