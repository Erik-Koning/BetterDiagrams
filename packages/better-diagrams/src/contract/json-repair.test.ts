import { describe, expect, it } from "vitest";
import { approximateJsonFix, parseLlmJson, repairJsonText } from "./json-repair";

const heal = (raw: string) => {
  const { text, repairs } = repairJsonText(raw);
  return { value: JSON.parse(text), repairs };
};

describe("repairJsonText", () => {
  it("returns valid JSON byte-identical, with no repairs", () => {
    const raw = '{\n  "a": [1, 2],\n  "b": "x — y"\n}';
    expect(repairJsonText(raw)).toEqual({ text: raw, repairs: [], approximations: [] });
  });

  it("straightens smart double quotes", () => {
    const { value, repairs } = heal("{“label”: “Payments — v2”}");
    expect(value).toEqual({ label: "Payments — v2" });
    expect(repairs).toContain("straightened smart quotes");
  });

  it("keeps smart quotes inside straight-quoted strings as content", () => {
    const { value } = heal('{"label": "he said “hi”",}');
    expect(value).toEqual({ label: "he said “hi”" });
  });

  it("converts single-quoted strings, unwrapping \\' and escaping inner double quotes", () => {
    const { value, repairs } = heal("{'label': 'it\\'s a \"win\"'}");
    expect(value).toEqual({ label: 'it\'s a "win"' });
    expect(repairs).toContain("converted single-quoted strings");
  });

  it("removes trailing commas in objects and arrays", () => {
    const { value, repairs } = heal('{"a": [1, 2,], "b": 3,}');
    expect(value).toEqual({ a: [1, 2], b: 3 });
    expect(repairs).toEqual(["removed a trailing comma"]);
  });

  it("inserts missing commas between siblings", () => {
    const { value, repairs } = heal('{"a": 1 "b": [1 2]}');
    expect(value).toEqual({ a: 1, b: [1, 2] });
    expect(repairs).toEqual(["inserted a missing comma"]);
  });

  it("quotes bare keys and inserts a missing colon", () => {
    const { value, repairs } = heal('{version: 1, "label" "x"}');
    expect(value).toEqual({ version: 1, label: "x" });
    expect(repairs).toContain("quoted a bare key");
    expect(repairs).toContain("inserted a missing colon");
  });

  it("strips // and /* */ comments", () => {
    const { value, repairs } = heal('{\n  // count\n  "a": 1 /* inline */\n}');
    expect(value).toEqual({ a: 1 });
    expect(repairs).toEqual(["removed comments"]);
  });

  it("normalizes Python literals", () => {
    const { value } = heal('{"a": True, "b": False, "c": None, "d": NaN}');
    expect(value).toEqual({ a: true, b: false, c: null, d: null });
  });

  it("rejoins a string hard-wrapped by a terminal", () => {
    const { value, repairs } = heal('{"description": "Any React 18+ app embed\nding the editors"}');
    expect(value).toEqual({ description: "Any React 18+ app embedding the editors" });
    expect(repairs).toEqual(["rejoined a line-wrapped string"]);
  });

  it("drops zero-width characters and unicode spaces", () => {
    const { value, repairs } = heal('{"a": "x​y"}');
    expect(value).toEqual({ a: "xy" });
    expect(repairs).toContain("removed invisible characters");
  });

  it("closes a truncated document, filling a half-written member with null", () => {
    const { value, repairs } = heal('{"version":1,"nodes":[{"id":"a","x":');
    expect(value).toEqual({ version: 1, nodes: [{ id: "a", x: null }] });
    expect(repairs).toContain("closed unclosed brackets (the text looks cut off)");
  });

  it("closes an unterminated string at the cut-off point", () => {
    const { value } = heal('{"nodes":[{"label":"Paymen');
    expect(value).toEqual({ nodes: [{ label: "Paymen" }] });
  });

  it("heals a mismatched closer by closing the inner bracket", () => {
    const { value, repairs } = heal('{"nodes": [}');
    expect(value).toEqual({ nodes: [] });
    expect(repairs).toContain("closed an unclosed bracket");
  });

  it("drops stray trailing punctuation after the document", () => {
    const { value } = heal('{"a": 1}},');
    expect(value).toEqual({ a: 1 });
  });

  it("refuses text with a lost chunk, pointing at the damage", () => {
    // The real-world sample: a copy dropped `"window","description":"An`
    // between `"icon":` and `y React 18`. No repair can reconstruct that.
    const mangled = '{"id":"host-app","kind":"client","icon":y React 18+ app","x":40}';
    expect(() => repairJsonText(mangled)).toThrow(
      /Unreadable JSON at line 1, column 41 .*"y" is not a JSON value.*re-copy/s,
    );
  });

  it("refuses prose where a value should be", () => {
    expect(() => repairJsonText('{"a": 1} trailing prose')).toThrow(/Unreadable JSON/);
  });
});

describe("repairJsonText in approximate mode", () => {
  it("salvages the lost-chunk paste by guessing a string at the damage", () => {
    // The real-world sample again — approximate mode trades the fused text
    // for a flagged guess so the other members survive.
    const mangled =
      '{"id":"host-app","kind":"client","icon":y React 18+ app embedding the editors","x":40}';
    const { text, repairs, approximations } = repairJsonText(mangled, { approximate: true });
    expect(JSON.parse(text)).toEqual({
      id: "host-app",
      kind: "client",
      icon: "y React 18+ app embedding the editors",
      x: 40,
    });
    expect(repairs).toEqual([]);
    expect(approximations).toHaveLength(1);
    const [site] = approximations;
    expect(mangled.slice(site.from, site.to)).toBe("y React 18+ app embedding the editors\"");
    expect(site.note).toContain("guessed a string value");
  });

  it("replaces an unreadable number with 0", () => {
    const { text, approximations } = repairJsonText('{"x": 4-.0e, "y": 2}', {
      approximate: true,
    });
    expect(JSON.parse(text)).toEqual({ x: 0, y: 2 });
    expect(approximations[0].note).toContain("with 0");
  });

  it("recovers every damage site, not just the first", () => {
    const { text, approximations } = repairJsonText('{"a": @@, "b": zz 12, "c": 3}', {
      approximate: true,
    });
    expect(JSON.parse(text)).toEqual({ a: "@@", b: "zz 12", c: 3 });
    expect(approximations).toHaveLength(2);
  });

  it("drops damaged text trailing the document", () => {
    const { text, approximations } = repairJsonText('{"a": 1} garbage', {
      approximate: true,
    });
    expect(JSON.parse(text)).toEqual({ a: 1 });
    expect(approximations).toHaveLength(1);
  });

  it("stays off unless asked — safe mode still refuses", () => {
    expect(() => repairJsonText('{"a": @@}')).toThrow(/Unreadable JSON/);
  });

  it("retracts a comma emitted for a token that was then dropped as garbage", () => {
    // The comma (inserted or from the source) is emitted before the next
    // token is dispatched; when that token is dropped at a key position, the
    // comma must not dangle before the closer.
    for (const input of ['{"a": 1 ©}', '{"a": 1, ©}', '{"a": 1 ©', '{"a": 1 {}}', '{"a": 1 2}']) {
      const { text, approximations } = repairJsonText(input, { approximate: true });
      expect(JSON.parse(text)).toEqual({ a: 1 });
      expect(approximations.length).toBeGreaterThan(0);
    }
  });

  it("survives multi-code-unit damage (emoji) and stray colons", () => {
    expect(JSON.parse(repairJsonText('{"a": 😀}', { approximate: true }).text)).toEqual({
      a: "😀",
    });
    expect(JSON.parse(repairJsonText('{"a" :: 1}', { approximate: true }).text)).toEqual({ a: 1 });
  });
});

describe("approximateJsonFix", () => {
  it("returns null for text the safe healer already handles", () => {
    expect(approximateJsonFix('{"a": 1,}')).toBeNull();
    expect(approximateJsonFix('{"a": 1}')).toBeNull();
    expect(approximateJsonFix("no json here")).toBeNull();
  });

  it("maps damage sites into the original text across a prose prefix", () => {
    const text = 'Sure! Here you go:\n{"icon":y React 18"}';
    const fix = approximateJsonFix(text);
    if (!fix) throw new Error("expected a fix");
    expect(JSON.parse(fix.text)).toEqual({ icon: "y React 18" });
    const [site] = fix.sites;
    expect(text.slice(site.from, site.to)).toBe('y React 18"');
  });
});

describe("parseLlmJson", () => {
  it("parses a fenced reply", () => {
    expect(parseLlmJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("heals inside the extracted object only", () => {
    expect(parseLlmJson('Here you go:\n{"a": [1,],}\nHope that helps.')).toEqual({ a: [1] });
  });

  it("salvages a reply truncated before any closing brace", () => {
    expect(parseLlmJson('{"version":1,"nodes":[{"id":"a"')).toEqual({
      version: 1,
      nodes: [{ id: "a" }],
    });
  });

  it("still reports text with no JSON at all", () => {
    expect(() => parseLlmJson("I cannot help with that.")).toThrow(/No JSON object/);
  });
});
