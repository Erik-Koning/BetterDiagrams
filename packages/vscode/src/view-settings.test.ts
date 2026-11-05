import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW } from "@app/documents.js";
import { VIEW_DEFAULTS } from "./protocol";
import { VIEW_KEYS, viewChange, viewFrom } from "./view-settings";

describe("the view settings", () => {
  it("start where the web app's view does, and where package.json says they do", () => {
    expect(VIEW_DEFAULTS).toMatchObject({
      presentation: DEFAULT_VIEW.studioMode,
      gradients: DEFAULT_VIEW.gradients,
      minimap: DEFAULT_VIEW.minimap,
      linesOnHover: DEFAULT_VIEW.edgesOnHover,
    });
    const settings = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).contributes.configuration.properties;
    for (const key of VIEW_KEYS) expect(settings[`betterDiagrams.${key}`]?.default, key).toEqual(VIEW_DEFAULTS[key]);
  });

  it("reads each one, and an unset one as its default", () => {
    const set: Record<string, unknown> = { theme: "dark", presentation: "technical", minimap: true, accent: "#AABBCC" };
    expect(viewFrom((key) => set[key])).toEqual({
      ...VIEW_DEFAULTS,
      theme: "dark",
      presentation: "technical",
      minimap: true,
      accent: "#aabbcc",
    });
  });

  it("reads a value that isn't one of the choices as the default, never as itself", () => {
    const junk: Record<string, unknown> = { theme: "sepia", presentation: 3, gradients: "yes", accent: "red", ai: null };
    expect(viewFrom((key) => junk[key])).toEqual(VIEW_DEFAULTS);
  });

  it("lets the webview change only view settings, each one checked", () => {
    expect(viewChange({ theme: "light", minimap: true, aiModel: "gpt-x", files: ["/etc"] })).toEqual({ theme: "light", minimap: true });
    expect(viewChange({ accent: "" })).toEqual({ accent: "" });
    expect(viewChange({ theme: "neon" })).toEqual({ theme: "auto" });
    expect(viewChange(null)).toEqual({});
  });
});
