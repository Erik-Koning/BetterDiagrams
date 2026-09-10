/**
 * @vitest-environment jsdom
 *
 * history.ts — what counts as a change worth an undo entry.
 */
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";
import { useHistory, type Snapshot } from "./history";

const nodes: Node[] = [{ id: "a", position: { x: 0, y: 0 }, data: { label: "A" } }];
const edges: Edge[] = [];

const snap = (template: Record<string, unknown>): Snapshot => ({
  nodes,
  edges,
  meta: { title: "T" },
  template,
});

describe("useHistory", () => {
  it("ignores a commit that changes nothing the document persists", () => {
    const { result } = renderHook(() => useHistory(snap({ version: 1 })));
    act(() => result.current.commit({ ...snap({ version: 1 }), nodes: nodes.map((n) => ({ ...n, selected: true })) }));
    expect(result.current.canUndo).toBe(false);
  });

  it("records a paths-only edit — the canvas cannot show one, so the document must", () => {
    const { result } = renderHook(() =>
      useHistory(snap({ version: 1, paths: [{ id: "p", title: "One", steps: ["a"] }] })),
    );
    act(() => result.current.commit(snap({ version: 1, paths: [{ id: "p", title: "Renamed", steps: ["a"] }] })));
    expect(result.current.canUndo).toBe(true);
    let previous: Snapshot | null = null;
    act(() => {
      previous = result.current.undo();
    });
    expect((previous!.template as { paths: Array<{ title: string }> }).paths[0].title).toBe("One");
  });
});
