/**
 * @vitest-environment jsdom
 *
 * host-embedding.test.tsx — what a host page gets from the root without
 * doing anything of its own: one undo history when it keeps one
 * (`hostHistory`), and a colour scheme `light-dark()` still works under once
 * the stylesheet is compiled.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "lightningcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ArchitectureStudio } from "./ArchitectureStudio";
import { SequenceStudio } from "./sequence/SequenceStudio";
import { LIGHT_THEME, colorSchemeOf } from "./theme";
import { validateTemplate } from "../contract/schema";
import { EXAMPLE_SEQUENCE, validateSequence } from "../contract/sequence";

afterEach(cleanup);

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

const DIAGRAM = validateTemplate({
  version: 1,
  nodes: [{ id: "a", label: "A", kind: "service", x: 0, y: 0 }],
  edges: [],
});
const SEQUENCE = validateSequence(EXAMPLE_SEQUENCE);

const studios = {
  architecture: (props: Record<string, unknown>) => <ArchitectureStudio defaultValue={DIAGRAM} welcome={false} {...props} />,
  sequence: (props: Record<string, unknown>) => <SequenceStudio defaultValue={SEQUENCE} welcome={false} {...props} />,
};

describe.each(Object.entries(studios))("%s studio", (_, studio) => {
  it("leaves undo and redo to a host that keeps the history", () => {
    const hostHistory = { undo: vi.fn(), redo: vi.fn() };
    const onChange = vi.fn();
    mount(studio({ hostHistory, onChange }));
    const undo = screen.getByRole("button", { name: "Undo" });
    const redo = screen.getByRole("button", { name: "Redo" });
    // Nothing in the editor's own history, and still enabled: only the host knows.
    expect(undo).toBeEnabled();
    expect(redo).toBeEnabled();
    fireEvent.click(undo);
    fireEvent.click(redo);
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(hostHistory.undo).toHaveBeenCalledTimes(2);
    expect(hostHistory.redo).toHaveBeenCalledTimes(3);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables the buttons when the host says there's nothing to step", () => {
    mount(studio({ hostHistory: { undo: vi.fn(), redo: vi.fn(), canUndo: false, canRedo: true } }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
  });

  it("keeps its own history otherwise", () => {
    mount(studio({}));
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("marks its root with the theme's colour scheme", () => {
    const { container, unmount } = mount(studio({}));
    expect(container.querySelector(".as-root")?.getAttribute("data-color-scheme")).toBe("dark");
    unmount();
    const light = mount(studio({ theme: LIGHT_THEME }));
    expect(light.container.querySelector(".as-root")?.getAttribute("data-color-scheme")).toBe("light");
  });
});

describe("colorSchemeOf", () => {
  it("reads the scheme the root's style sets, else dark", () => {
    expect(colorSchemeOf({})).toBe("dark");
    expect(colorSchemeOf({ "--as-color-scheme": "light" } as React.CSSProperties)).toBe("light");
    expect(colorSchemeOf({ "--as-color-scheme": "dark" } as React.CSSProperties)).toBe("dark");
  });
});

describe("the stylesheet, compiled for a browser without light-dark()", () => {
  // As Vite builds it (lightningcss, for browsers older than Chrome 123 /
  // Safari 17.5): light-dark(a, b) becomes two variables that only a
  // literal color-scheme switches. The root must carry that switch itself,
  // or a host page that declares no scheme gets cards with no paint.
  const css = transform({
    filename: "styles.css",
    code: readFileSync(join(__dirname, "../styles.css")),
    targets: { chrome: 107 << 16, safari: 16 << 16, firefox: 104 << 16 },
  }).code.toString();
  const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

  it("still lowers light-dark()", () => {
    expect(css).toContain("var(--lightningcss-light");
  });

  it("switches it on the root, for either scheme", () => {
    expect(rule('.as-root[data-color-scheme="light"]')).toMatch(/--lightningcss-light: initial;\s*--lightningcss-dark: ;/);
    expect(rule('.as-root[data-color-scheme="dark"]')).toMatch(/--lightningcss-light: ;\s*--lightningcss-dark: initial;/);
  });
});
