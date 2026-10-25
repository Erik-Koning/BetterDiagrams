/**
 * Icon suggestions: the icons a box's own words point at.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_ICON_PATHS } from "./icons";
import { ICON_KEYWORDS, iconKeywords, suggestIcons } from "./icon-suggest";

const ALL = ["none", ...Object.keys(BUILTIN_ICON_PATHS)];

describe("suggestIcons", () => {
  it("reads a box's name for what it is", () => {
    expect(suggestIcons("Postgres", ALL)[0]).toBe("database");
    expect(suggestIcons("Payments service", ALL)[0]).toBe("card");
    expect(suggestIcons("Load balancer", ALL)[0]).toBe("balance");
    expect(suggestIcons("Clinic staff", ALL)[0]).toBe("users");
  });

  it("matches whole words only, and offers nothing for words it doesn't know", () => {
    expect(suggestIcons("Adder", ALL)).toEqual([]);
    expect(suggestIcons("", ALL)).toEqual([]);
  });

  it("ranks by how many words agree, and caps the list", () => {
    const picks = suggestIcons("Order checkout and payment billing", ALL, 2);
    expect(picks).toHaveLength(2);
    expect(picks).toEqual(["card", "cart"]);
  });

  it("only offers icons the registry has, never none, and a registry icon by its name", () => {
    expect(suggestIcons("Postgres database", ["none", "server"])).toEqual([]);
    expect(suggestIcons("The kafka cluster", ["none", "kafka"])).toEqual(["kafka"]);
  });

  it("knows a word for every built-in icon, and none for icons that don't exist", () => {
    for (const name of Object.keys(ICON_KEYWORDS)) expect(BUILTIN_ICON_PATHS[name]).toBeDefined();
    expect(iconKeywords("database")).toContain("postgres");
    expect(iconKeywords("nope")).toBeUndefined();
  });
});
