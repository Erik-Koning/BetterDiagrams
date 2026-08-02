/**
 * The contract half's one real promise: you can copy it into a backend and run
 * it. That only holds if nothing in it reaches for React, @xyflow/react, or the
 * DOM — and a promise that isn't tested is a comment.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const sources = readdirSync(HERE).filter(
  (f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes(".test."),
);

/** Import specifiers, ignoring anything inside a comment. */
function importsOf(file: string): string[] {
  const source = readFileSync(join(HERE, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return [...source.matchAll(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g)].map(
    (m) => m[1] ?? m[2],
  );
}

describe("contract isolation", () => {
  it("has source files to check", () => {
    expect(sources.length).toBeGreaterThan(3);
  });

  it("imports nothing outside itself", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const specifier of importsOf(file)) {
        // Relative imports within contract/ are fine; everything else is not.
        // That covers React, @xyflow/react, and any npm package, in one rule.
        const ok = specifier.startsWith("./") && !specifier.startsWith("../");
        if (!ok) offenders.push(`${file} → ${specifier}`);
      }
    }
    expect(offenders, "contract/ must stay dependency-free").toEqual([]);
  });

  it("never reaches into react/", () => {
    for (const file of sources) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/react/i);
      }
    }
  });

  it("touches no DOM or browser global", () => {
    // `document`/`window` here would throw the moment the file ran in Node.
    for (const file of sources) {
      const source = readFileSync(join(HERE, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const global of ["document.", "window.", "navigator.", "HTMLElement", "localStorage"]) {
        expect(source.includes(global), `${file} uses ${global}`).toBe(false);
      }
    }
  });

  it("runs end to end with no DOM present", async () => {
    // This file's vitest environment is `node` — there is genuinely no DOM
    // here, so the import and the round-trip below are the real proof.
    expect(typeof globalThis.document).toBe("undefined");

    const contract = await import("./index");
    const template = contract.validateTemplate(contract.EXAMPLE_ZONED_TEMPLATE);
    const { nodes, edges } = contract.toReactFlow(template);
    const back = contract.fromReactFlow(nodes, edges, { base: template });

    expect(back.nodes).toHaveLength(contract.EXAMPLE_ZONED_TEMPLATE.nodes.length);
    expect(contract.buildSystemPrompt()).toContain("zones");
    expect(contract.autoLayout(template).nodes).toHaveLength(template.nodes.length);
    // Visibility and the clipboard are the other two things a backend would
    // realistically want, and both are pure.
    expect(contract.visibleElements(template).nodes.size).toBeGreaterThan(0);
    expect(contract.copyFragment(template, ["api"]).nodes).toHaveLength(1);
  });

  it("does not export the DOM-bound renderers", () => {
    // PNG/PDF/SVG need a canvas, so they live in react/. If one leaked into
    // contract/ the isolation promise would be false at runtime, not just in
    // the import graph.
    return import("./index").then((contract) => {
      expect("renderTemplateToCanvas" in contract).toBe(false);
      expect("renderTemplateToSvg" in contract).toBe(false);
    });
  });
});
