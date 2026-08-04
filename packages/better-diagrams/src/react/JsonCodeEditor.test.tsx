/**
 * @vitest-environment jsdom
 *
 * Proves the real CodeMirror EditorView mounts under the jsdom shims in
 * test-setup.ts (Range measurement, elementFromPoint, scrollIntoView) — the
 * behavior tests in WelcomeModal.test.tsx stub this component out.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { JsonCodeEditor, transformPastedJson } from "./JsonCodeEditor";

/** Fire a paste with clipboard text — jsdom has no ClipboardEvent constructor. */
function paste(container: HTMLElement, text: string) {
  const content = container.querySelector(".cm-content")!;
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  content.dispatchEvent(event);
}

describe("JsonCodeEditor", () => {
  it("mounts a CodeMirror editor with gutters and placeholder", () => {
    const { container } = render(
      <JsonCodeEditor
        value=""
        onChange={vi.fn()}
        placeholder={'{\n  "version": 1\n}'}
        ariaLabel="Diagram JSON"
      />,
    );
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    expect(container.querySelector(".cm-gutters")).not.toBeNull();
    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(container.querySelector(".cm-placeholder")?.textContent).toContain('"version"');
  });

  it("adopts external value changes", () => {
    const { container, rerender } = render(<JsonCodeEditor value="" onChange={vi.fn()} />);
    rerender(<JsonCodeEditor value='{"version": 1}' onChange={vi.fn()} />);
    expect(container.querySelector(".cm-content")?.textContent).toContain('"version": 1');
  });

  it("prettifies a single-line JSON paste into an empty editor", () => {
    const onChange = vi.fn();
    const { container } = render(<JsonCodeEditor value="" onChange={onChange} />);
    paste(container, '{"version":1,"nodes":[{"id":"a"}],"edges":[]}');
    expect(onChange).toHaveBeenCalledWith(
      JSON.stringify({ version: 1, nodes: [{ id: "a" }], edges: [] }, null, 2),
    );
  });

  it("heals a damaged paste (fences, smart quotes, trailing comma)", () => {
    const onChange = vi.fn();
    const { container } = render(<JsonCodeEditor value="" onChange={onChange} />);
    paste(container, '```json\n{“version”: 1, "nodes": [],}\n```');
    expect(onChange).toHaveBeenCalledWith(JSON.stringify({ version: 1, nodes: [] }, null, 2));
  });

  it("leaves an unhealable paste to the default insert and the linter", () => {
    const onChange = vi.fn();
    const { container } = render(<JsonCodeEditor value="" onChange={onChange} />);
    paste(container, '{"kind":"client","icon":y React 18+ app"}');
    // Our handler declined — whether CodeMirror's own paste ran under jsdom,
    // the healed-path onChange (pretty multi-line text) must not have fired.
    for (const call of onChange.mock.calls) expect(call[0]).not.toContain("\n");
  });
});

describe("transformPastedJson", () => {
  it("passes deliberate formatting through untouched", () => {
    expect(transformPastedJson('{\n  "version": 1,\n  "nodes": []\n}')).toBeNull();
  });

  it("prettifies valid single-line JSON", () => {
    expect(transformPastedJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("strips prose and fences around the object", () => {
    expect(transformPastedJson('Sure!\n```json\n{"a": 1}\n```\nEnjoy.')).toBe('{\n  "a": 1\n}');
  });

  it("returns null for non-JSON text", () => {
    expect(transformPastedJson("hello world")).toBeNull();
    expect(transformPastedJson('{"icon":y React 18"}')).toBeNull();
  });
});
