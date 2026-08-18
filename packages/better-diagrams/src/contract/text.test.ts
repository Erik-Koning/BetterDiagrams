/**
 * The measurement three things share: validateTemplate growing a wrapped
 * node's height, the canvas laying its label out, and the PNG/SVG exporters
 * drawing it. They only agree because they call the same functions, so these
 * tests pin the behaviour those three rely on.
 */
import { describe, expect, it } from "vitest";
import { approxTextWidth, ellipsise, wrapText, wrappedLineCount } from "./text";

describe("approxTextWidth", () => {
  it("scales with length and size, and mono is wider than sans", () => {
    expect(approxTextWidth("abcd", 10, "sans")).toBeCloseTo(20.8);
    expect(approxTextWidth("ab", 20, "sans")).toBeCloseTo(20.8);
    expect(approxTextWidth("abcd", 10, "mono")).toBeGreaterThan(
      approxTextWidth("abcd", 10, "sans"),
    );
  });

  it("measures the empty string as nothing", () => {
    expect(approxTextWidth("", 13, "sans")).toBe(0);
  });
});

describe("wrapText", () => {
  it("breaks on words rather than mid-word", () => {
    const lines = wrapText("alpha beta gamma delta", 13, "sans", 60, 10);
    expect(lines.length).toBeGreaterThan(1);
    // Rejoining reproduces the input exactly — which is only possible if every
    // break landed on a space rather than inside a word.
    expect(lines.join(" ")).toBe("alpha beta gamma delta");
  });

  it("ellipsises the last line when it runs out of lines", () => {
    const lines = wrapText("alpha beta gamma delta epsilon", 13, "sans", 60, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
  });

  it("does not ellipsise when everything fits", () => {
    const lines = wrapText("alpha beta", 13, "sans", 400, 2);
    expect(lines).toEqual(["alpha beta"]);
  });

  it("returns nothing for blank text", () => {
    expect(wrapText("", 13, "sans", 100, 2)).toEqual([]);
    expect(wrapText("   ", 13, "sans", 100, 2)).toEqual([]);
  });

  it("keeps a single unbreakable word rather than dropping it", () => {
    // Narrower than the word: it overhangs instead of vanishing. The CSS side
    // uses overflow-wrap for the same case.
    expect(wrapText("supercalifragilistic", 13, "sans", 20, 3)).toEqual(["supercalifragilistic"]);
  });
});

describe("wrappedLineCount", () => {
  it("never reports fewer than one line, even for nothing", () => {
    expect(wrappedLineCount("", 13, "sans", 100)).toBe(1);
    expect(wrappedLineCount("short", 13, "sans", 1000)).toBe(1);
  });

  it("grows as the available width shrinks", () => {
    const label = "A deliberately long component label";
    const wide = wrappedLineCount(label, 13, "sans", 400);
    const narrow = wrappedLineCount(label, 13, "sans", 100);
    expect(narrow).toBeGreaterThan(wide);
  });

  it("is uncapped — this is what grows a node's height, so nothing is hidden", () => {
    const many = wrappedLineCount("one two three four five six seven eight", 13, "sans", 40);
    expect(many).toBeGreaterThan(4);
  });

  it("survives a zero or negative width instead of looping", () => {
    expect(wrappedLineCount("anything", 13, "sans", 0)).toBe(1);
    expect(wrappedLineCount("anything", 13, "sans", -50)).toBe(1);
  });
});

describe("ellipsise", () => {
  it("leaves text that fits untouched", () => {
    expect(ellipsise("short", 13, "sans", 400)).toBe("short");
  });

  it("truncates with an ellipsis when it doesn't fit", () => {
    const out = ellipsise("a very long label indeed", 13, "sans", 60);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan("a very long label indeed".length);
  });
});
