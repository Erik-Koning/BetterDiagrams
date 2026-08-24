/**
 * @vitest-environment jsdom
 *
 * Direct-manipulation gestures on the labeled edge: drag-to-bend, waypoint
 * editing, endpoint pinning and re-attachment.
 *
 * Mounted in a bare React Flow — identity viewport, no fitView — rather than
 * the full studio, so client coordinates ARE flow coordinates and each
 * assertion can say exactly where things land. The full studio wiring
 * (routing pickers, inspector) is covered by ArchitectureStudio.test.tsx.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { ConnectionMode, ReactFlow, useReactFlow, type ReactFlowInstance } from "@xyflow/react";
import { EDGE_TYPES } from "./edges";
import { ConnectHandles } from "./nodes";
import { DiffCanvas } from "./DiffCanvas";
import { StudioContext, type StudioContextValue } from "./context";
import { createRegistry } from "./create-registry";
import { diffTemplates } from "../contract/diff";
import {
  MAX_EDGE_POINTS,
  validateTemplate,
  type DiagramEdgeData,
  type DiagramTemplate,
} from "../contract/schema";

/** A box with the four handles React Flow needs before it will draw an edge. */
function PlainNode() {
  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ConnectHandles hidden={false} />
    </div>
  );
}

const NODE = (id: string, x: number, y: number, data: Record<string, unknown> = {}) => ({
  id,
  type: "plain",
  position: { x, y },
  width: 100,
  height: 50,
  style: { width: 100, height: 50 },
  data,
});

const edgeData = (over: Partial<DiagramEdgeData> = {}): DiagramEdgeData => ({
  label: "",
  labelT: 0.5,
  style: "solid",
  color: "slate",
  routingResolved: "curved",
  ...over,
});

let flow: ReactFlowInstance | null = null;
function Probe() {
  flow = useReactFlow();
  return null;
}

const requestCommit = vi.fn();

function mountEdge(
  data: DiagramEdgeData = edgeData(),
  {
    selected = true,
    targetData = {} as Record<string, unknown>,
    extraEdges = [] as Array<Record<string, unknown>>,
    selfLoop = false,
  } = {},
) {
  const ctx: StudioContextValue = {
    registry: createRegistry(),
    readOnly: false,
    tagFilter: [],
    showTeams: true,
    requestCommit,
    beginZoneResize: () => {},
    endZoneResize: () => {},
    focus: null,
    drillInto: () => {},
    navigateToNode: () => {},
    childCounts: new Map(),
  };
  const utils = render(
    <StudioContext.Provider value={ctx}>
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow
          defaultNodes={[NODE("a", 0, 0), NODE("b", 300, 0, targetData), NODE("c", 300, 300)]}
          defaultEdges={
            [
              { id: "e1", source: "a", target: selfLoop ? "a" : "b", type: "labeled", data, selected },
              ...extraEdges,
            ] as never[]
          }
          nodeTypes={{ plain: PlainNode }}
          edgeTypes={EDGE_TYPES}
          // The studio's mode: source handles double as targets, so an edge
          // renders without the nodes declaring dedicated target handles.
          connectionMode={ConnectionMode.Loose}
        >
          <Probe />
        </ReactFlow>
      </div>
    </StudioContext.Provider>,
  );
  return utils;
}

const theEdge = () =>
  flow!.getEdges()[0] as unknown as { source: string; target: string; data: DiagramEdgeData };

beforeEach(() => {
  flow = null;
  requestCommit.mockClear();
});

describe("drag-to-bend", () => {
  it("births a waypoint under the pointer and drags it in one gesture", async () => {
    const { container } = mountEdge();
    await waitFor(() => expect(container.querySelector(".as-edge__hit")).toBeTruthy());
    const hit = container.querySelector(".as-edge__hit")!;

    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 25, button: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 200, clientY: 120 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 210, clientY: 140 });
    fireEvent.pointerUp(hit, { pointerId: 1 });

    expect(theEdge().data.points).toEqual([[210, 140]]);
    expect(requestCommit).toHaveBeenCalledTimes(1);
  });

  it("keeps a plain click a click — below the threshold nothing bends", async () => {
    const { container } = mountEdge();
    await waitFor(() => expect(container.querySelector(".as-edge__hit")).toBeTruthy());
    const hit = container.querySelector(".as-edge__hit")!;

    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 25, button: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 201, clientY: 26 });
    fireEvent.pointerUp(hit, { pointerId: 1 });

    expect(theEdge().data.points).toBeUndefined();
    expect(requestCommit).not.toHaveBeenCalled();
  });

  it("orders a second bend among the stored waypoints by position along the curve", async () => {
    const { container } = mountEdge(edgeData({ points: [[200, 120]] }));
    await waitFor(() => expect(container.querySelector(".as-edge__hit")).toBeTruthy());
    const hit = container.querySelector(".as-edge__hit")!;

    // Grab near the source, well before the existing waypoint.
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 120, clientY: 40, button: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 130, clientY: 90 });
    fireEvent.pointerUp(hit, { pointerId: 1 });

    expect(theEdge().data.points).toEqual([
      [130, 90],
      [200, 120],
    ]);
  });

  it("leaves click-to-select intact — the grab gesture must not eat the click", async () => {
    const { container } = mountEdge(edgeData(), { selected: false });
    await waitFor(() => expect(container.querySelector(".as-edge__hit")).toBeTruthy());
    const hit = container.querySelector(".as-edge__hit")!;

    // The real sequence a click produces: down, up, click.
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 25, button: 0 });
    fireEvent.pointerUp(hit, { pointerId: 1 });
    fireEvent.click(hit, { clientX: 200, clientY: 25 });

    await waitFor(() => expect(flow!.getEdges()[0].selected).toBe(true));
  });

  it("refuses to bend past the validation cap — a 17th point would be lost on round-trip", async () => {
    const full = Array.from({ length: MAX_EDGE_POINTS }, (_, i) => [150 + i, 100] as [number, number]);
    const { container } = mountEdge(edgeData({ points: full }));
    await waitFor(() => expect(container.querySelector(".as-edge__hit")).toBeTruthy());
    const hit = container.querySelector(".as-edge__hit")!;

    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 25, button: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 200, clientY: 120 });
    fireEvent.pointerUp(hit, { pointerId: 1 });
    fireEvent.doubleClick(hit, { clientX: 200, clientY: 25 });

    expect(theEdge().data.points).toHaveLength(MAX_EDGE_POINTS);
    expect(requestCommit).not.toHaveBeenCalled();
  });

  it("snaps a dragged bend onto the endpoints' reference lines", async () => {
    const { container } = mountEdge();
    await waitFor(() => expect(container.querySelector(".as-edge__hit")).toBeTruthy());
    const hit = container.querySelector(".as-edge__hit")!;

    // Both attachments sit at y=25; releasing 4px off snaps level with them,
    // and the guide line shows while the snap holds.
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 25, button: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 200, clientY: 120 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 210, clientY: 29 });
    expect(container.querySelector(".as-edge__guide")).toBeTruthy();
    fireEvent.pointerUp(hit, { pointerId: 1 });

    expect(theEdge().data.points).toEqual([[210, 25]]);
    expect(container.querySelector(".as-edge__guide")).toBeNull();
  });

  it("double-click edits the label inline — bending is the drag gesture", async () => {
    const { container } = mountEdge();
    await waitFor(() => expect(container.querySelector(".as-edge__hit")).toBeTruthy());
    const hit = container.querySelector(".as-edge__hit")!;

    fireEvent.doubleClick(hit, { clientX: 200, clientY: 25 });
    // No waypoint was born — the editor was.
    expect(theEdge().data.points).toBeUndefined();
    const input = container.querySelector(".as-edge__labeledit") as HTMLInputElement;
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: "publishes" } });
    fireEvent.blur(input);

    expect(theEdge().data.label).toBe("publishes");
    expect(requestCommit).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".as-edge__labeledit")).toBeNull();
  });
});

describe("endpoint handles", () => {
  it("renders one handle at each end of a selected edge", async () => {
    const { container } = mountEdge();
    await waitFor(() =>
      expect(container.querySelectorAll(".as-edge__endpoint")).toHaveLength(2),
    );
  });

  it("pins the anchor to the nearest perimeter point when released on its own node", async () => {
    const { container } = mountEdge();
    await waitFor(() =>
      expect(container.querySelectorAll(".as-edge__endpoint")).toHaveLength(2),
    );
    const endHandle = container.querySelectorAll(".as-edge__endpoint")[1];

    // Node b is at (300, 0)–(400, 50); release near its bottom-centre.
    fireEvent.pointerDown(endHandle, { pointerId: 1, clientX: 300, clientY: 25, button: 0 });
    fireEvent.pointerMove(endHandle, { pointerId: 1, clientX: 350, clientY: 45 });
    fireEvent.pointerUp(endHandle, { pointerId: 1 });

    expect(theEdge().data.end).toEqual({ side: "bottom", t: 0.5 });
    expect(theEdge().target).toBe("b");
    expect(requestCommit).toHaveBeenCalledTimes(1);
  });

  it("re-attaches the edge when its end is dropped on another node", async () => {
    const { container } = mountEdge(edgeData({ end: { side: "top", t: 0.25 } }));
    await waitFor(() =>
      expect(container.querySelectorAll(".as-edge__endpoint")).toHaveLength(2),
    );
    const endHandle = container.querySelectorAll(".as-edge__endpoint")[1];

    // Node c is at (300, 300)–(400, 350); drop the end inside it.
    fireEvent.pointerDown(endHandle, { pointerId: 1, clientX: 320, clientY: 12, button: 0 });
    fireEvent.pointerMove(endHandle, { pointerId: 1, clientX: 350, clientY: 330 });
    fireEvent.pointerUp(endHandle, { pointerId: 1 });

    expect(theEdge().target).toBe("c");
    // The old anchor described the box the line left — it does not survive.
    expect(theEdge().data.end).toBeUndefined();
    expect(requestCommit).toHaveBeenCalledTimes(1);
  });

  it("hand-pinning a field-anchored end replaces the row attachment", async () => {
    // With the field reference kept, fieldAnchors would re-aim the pinned
    // fraction back at the row and the drag would appear to do nothing.
    const { container } = mountEdge(edgeData({ endField: "f2" }), {
      targetData: { fields: [{ id: "f1", name: "id" }, { id: "f2", name: "user_id" }] },
    });
    await waitFor(() =>
      expect(container.querySelectorAll(".as-edge__endpoint")).toHaveLength(2),
    );
    const endHandle = container.querySelectorAll(".as-edge__endpoint")[1];

    fireEvent.pointerDown(endHandle, { pointerId: 1, clientX: 300, clientY: 25, button: 0 });
    fireEvent.pointerMove(endHandle, { pointerId: 1, clientX: 350, clientY: 45 });
    fireEvent.pointerUp(endHandle, { pointerId: 1 });

    expect(theEdge().data.end).toEqual({ side: "bottom", t: 0.5 });
    expect(theEdge().data.endField).toBeUndefined();
  });

  it("dropping an end on its own source turns the edge into a self-loop", async () => {
    const { container } = mountEdge();
    await waitFor(() =>
      expect(container.querySelectorAll(".as-edge__endpoint")).toHaveLength(2),
    );
    const endHandle = container.querySelectorAll(".as-edge__endpoint")[1];

    // Drop the END handle inside the SOURCE node a at (0, 0)–(100, 50).
    fireEvent.pointerDown(endHandle, { pointerId: 1, clientX: 300, clientY: 25, button: 0 });
    fireEvent.pointerMove(endHandle, { pointerId: 1, clientX: 50, clientY: 25 });
    fireEvent.pointerUp(endHandle, { pointerId: 1 });

    // A retry arrow: a→a, drawn as a loop. Validation keeps it now.
    expect(theEdge().target).toBe("a");
    expect(theEdge().data.end).toBeUndefined();
    expect(requestCommit).toHaveBeenCalledTimes(1);
  });
});

describe("end glyphs", () => {
  it("draws the chosen glyphs — the arrow filled, hollow ones stroked", async () => {
    // UML aggregation: hollow diamond at the source of a plain forward edge.
    const { container } = mountEdge(edgeData({ startHead: "diamond" }));
    await waitFor(() => expect(container.querySelector(".as-edge__arrow")).toBeTruthy());
    // The default forward arrow still points at the target…
    expect(container.querySelectorAll(".as-edge__arrow")).toHaveLength(1);
    // …and the diamond strokes like the (also hollow) crow's feet.
    expect(container.querySelectorAll(".as-edge__crow")).toHaveLength(1);
  });

  it("renders a self-loop with its arrowhead", async () => {
    const { container } = mountEdge(edgeData(), { selfLoop: true });
    await waitFor(() => expect(container.querySelector(".as-edge__stroke")).toBeTruthy());
    expect(container.querySelectorAll(".as-edge__arrow")).toHaveLength(1);
    const d = container.querySelector(".as-edge__stroke")!.getAttribute("d")!;
    // Out the right face of node a (0,0)-(100,50), back into its top.
    expect(d.startsWith("M 100 15")).toBe(true);
  });
});

describe("dangling ends (point nodes)", () => {
  it("dragging a point-backed end through space moves the dot itself", async () => {
    const { container } = mountEdge(edgeData(), { targetData: { kind: "point" } });
    await waitFor(() =>
      expect(container.querySelectorAll(".as-edge__endpoint")).toHaveLength(2),
    );
    const endHandle = container.querySelectorAll(".as-edge__endpoint")[1];

    fireEvent.pointerDown(endHandle, { pointerId: 1, clientX: 300, clientY: 25, button: 0 });
    fireEvent.pointerMove(endHandle, { pointerId: 1, clientX: 500, clientY: 200 });
    fireEvent.pointerUp(endHandle, { pointerId: 1 });

    // The dot (100×50 in this harness) is re-centred on the release point —
    // no anchor is pinned, because on a dot an anchor fraction means nothing.
    const b = flow!.getNodes().find((n) => n.id === "b")!;
    expect(b.position).toEqual({ x: 450, y: 175 });
    expect(theEdge().data.end).toBeUndefined();
    expect(requestCommit).toHaveBeenCalledTimes(1);
  });

  it("re-attaching a dangling end onto a real node sweeps the stranded dot", async () => {
    const { container } = mountEdge(edgeData(), { targetData: { kind: "point" } });
    await waitFor(() =>
      expect(container.querySelectorAll(".as-edge__endpoint")).toHaveLength(2),
    );
    const endHandle = container.querySelectorAll(".as-edge__endpoint")[1];

    fireEvent.pointerDown(endHandle, { pointerId: 1, clientX: 300, clientY: 25, button: 0 });
    fireEvent.pointerMove(endHandle, { pointerId: 1, clientX: 350, clientY: 330 });
    fireEvent.pointerUp(endHandle, { pointerId: 1 });

    expect(theEdge().target).toBe("c");
    expect(flow!.getNodes().some((n) => n.id === "b")).toBe(false);
  });

  it("keeps the dot when another edge still holds it", async () => {
    const { container } = mountEdge(edgeData(), {
      targetData: { kind: "point" },
      extraEdges: [{ id: "e2", source: "c", target: "b", type: "labeled", data: edgeData() }],
    });
    await waitFor(() =>
      expect(container.querySelectorAll(".as-edge__endpoint")).toHaveLength(2),
    );
    const endHandle = container.querySelectorAll(".as-edge__endpoint")[1];

    fireEvent.pointerDown(endHandle, { pointerId: 1, clientX: 300, clientY: 25, button: 0 });
    fireEvent.pointerMove(endHandle, { pointerId: 1, clientX: 350, clientY: 330 });
    fireEvent.pointerUp(endHandle, { pointerId: 1 });

    expect(theEdge().target).toBe("c");
    // e2 still ends on the dot — it is not stranded, so it stays.
    expect(flow!.getNodes().some((n) => n.id === "b")).toBe(true);
  });
});

describe("compare overlay", () => {
  it("its edges cannot be bent, even while the surrounding editor is editable", async () => {
    const doc: DiagramTemplate = validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 100, h: 50 },
        { id: "b", label: "B", kind: "service", icon: "box", description: "", parentId: null, x: 300, y: 0, w: 100, h: 50 },
      ],
      edges: [{ id: "e1", source: "a", target: "b", label: "", style: "solid", color: "slate" }],
    });
    const ctx: StudioContextValue = {
      registry: createRegistry(),
      readOnly: false, // the editor around the overlay IS editable
      tagFilter: [],
      showTeams: true,
      requestCommit,
      beginZoneResize: () => {},
      endZoneResize: () => {},
      focus: null,
      drillInto: () => {},
      navigateToNode: () => {},
      childCounts: new Map(),
    };
    const { container } = render(
      <StudioContext.Provider value={ctx}>
        <div style={{ width: 800, height: 600 }}>
          <DiffCanvas base={doc} current={doc} diff={diffTemplates(doc, doc)} />
        </div>
      </StudioContext.Provider>,
    );
    await waitFor(() => expect(container.querySelector(".as-edge__hit")).toBeTruthy());
    const hit = container.querySelector(".as-edge__hit")!;
    const before = container.querySelector(".as-edge__stroke")!.getAttribute("d");

    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 200, clientY: 25, button: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 200, clientY: 120 });
    fireEvent.pointerUp(hit, { pointerId: 1 });
    fireEvent.doubleClick(hit, { clientX: 200, clientY: 25 });

    expect(container.querySelector(".as-edge__stroke")!.getAttribute("d")).toBe(before);
    expect(requestCommit).not.toHaveBeenCalled();
  });
});
