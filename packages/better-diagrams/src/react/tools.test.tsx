/**
 * @vitest-environment jsdom
 *
 * The canvas tool tray and the rubber band it switches on.
 *
 * Two halves, because the feature has two: the tray is chrome and is tested
 * through the real editor, while the band is a gesture and is tested against a
 * stand-in canvas — jsdom lays nothing out, so a real <ReactFlow> measures
 * every node as a zero-sized box and no band would ever catch anything.
 */
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Edge, Node } from "@xyflow/react";
import { ArchitectureStudio } from "./ArchitectureStudio";
import { clearWelcomeSuppression } from "./WelcomeModal";
import {
  DRAG_THRESHOLD,
  boxesOverlap,
  edgePan,
  idsInBand,
  rectBetween,
  sameSet,
  useMarqueeSelect,
  type MarqueeFlow,
} from "./marquee";

vi.mock("./JsonCodeEditor", () => ({
  JsonCodeEditor: ({ value, ariaLabel }: { value: string; ariaLabel?: string }) => (
    <textarea aria-label={ariaLabel ?? "Diagram JSON"} value={value} readOnly />
  ),
}));

import { validateTemplate, type DiagramTemplate } from "../contract/schema";

const doc = (partial: Record<string, unknown>): DiagramTemplate =>
  validateTemplate({ version: 1, nodes: [], edges: [], ...partial });

const TWO = doc({
  nodes: [
    { id: "api", label: "API", kind: "service", x: 0, y: 0 },
    { id: "db", label: "DB", kind: "database", x: 400, y: 0 },
  ],
  edges: [{ id: "e", source: "api", target: "db" }],
});

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

beforeEach(() => clearWelcomeSuppression());
// `restoreMocks` is not on in vitest.config.ts, so the getBoundingClientRect
// spy below would outlive the describe that installs it.
afterEach(() => vi.restoreAllMocks());

// ── The tray ────────────────────────────────────────────────────────────────

describe("the tool tray", () => {
  const trigger = () => screen.getByRole("button", { expanded: false, name: /Cursor/ });

  it("opens on hover, without a click being spent on it", async () => {
    mount(<ArchitectureStudio defaultValue={TWO} />);

    expect(screen.queryByRole("menu", { name: "Canvas tools" })).not.toBeInTheDocument();
    fireEvent.pointerEnter(trigger(), { pointerType: "mouse" });

    const tray = await screen.findByRole("menu", { name: "Canvas tools" });
    expect(
      [...tray.querySelectorAll('[role="menuitemradio"]')].map((el) => el.textContent),
    ).toEqual([
      expect.stringContaining("Cursor"),
      expect.stringContaining("Select"),
      expect.stringContaining("Pan"),
    ]);
    // Cursor is where the editor starts, and the tray says so.
    expect(screen.getByRole("menuitemradio", { name: /Cursor/ })).toBeChecked();
  });

  it("stays shut for a finger — a tap would open it under the very press", () => {
    mount(<ArchitectureStudio defaultValue={TWO} />);
    fireEvent.pointerEnter(trigger(), { pointerType: "touch" });
    expect(screen.queryByRole("menu", { name: "Canvas tools" })).not.toBeInTheDocument();
  });

  it("closes again a moment after the pointer leaves", async () => {
    mount(<ArchitectureStudio defaultValue={TWO} />);
    const button = trigger();
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(screen.getByRole("menu", { name: "Canvas tools" })).toBeInTheDocument();

    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    // Not immediately: the gap between the button and the tray it opened is
    // crossed with the pointer inside neither, and closing there would shut
    // the tray in the face of a pointer travelling towards it.
    expect(screen.getByRole("menu", { name: "Canvas tools" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Canvas tools" })).not.toBeInTheDocument(),
    );
  });

  it("picks a tool and says which one is live", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={TWO} />);

    fireEvent.pointerEnter(trigger(), { pointerType: "mouse" });
    await user.click(screen.getByRole("menuitemradio", { name: /Select/ }));

    expect(screen.queryByRole("menu", { name: "Canvas tools" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Select/ })).toBeInTheDocument();
    expect(container.querySelector(".as-canvas")).toHaveClass("as-canvas--tool-select");
  });

  it("answers V, M and H, and Escape puts the arrow back", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={TWO} />);
    const canvas = () => container.querySelector(".as-canvas")!;

    fireEvent.keyDown(window, { key: "m" });
    await waitFor(() => expect(canvas()).toHaveClass("as-canvas--tool-select"));

    fireEvent.keyDown(window, { key: "h" });
    await waitFor(() => expect(canvas()).toHaveClass("as-canvas--tool-pan"));

    fireEvent.keyDown(window, { key: "v" });
    await waitFor(() => expect(canvas()).toHaveClass("as-canvas--tool-cursor"));

    fireEvent.keyDown(window, { key: "h" });
    await waitFor(() => expect(canvas()).toHaveClass("as-canvas--tool-pan"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(canvas()).toHaveClass("as-canvas--tool-cursor"));
  });

  it("leaves ⌘V alone — paste is not a tool switch", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={TWO} />);
    fireEvent.keyDown(window, { key: "m" });
    await waitFor(() =>
      expect(container.querySelector(".as-canvas")).toHaveClass("as-canvas--tool-select"),
    );
    fireEvent.keyDown(window, { key: "v", metaKey: true });
    expect(container.querySelector(".as-canvas")).toHaveClass("as-canvas--tool-select");
  });

  it("⇧/⌘ + click adds a box to the selection — and the same chord takes it out", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={TWO} />);
    const box = (id: string) =>
      container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
    const selected = () =>
      [...container.querySelectorAll(".react-flow__node.selected")].map((n) =>
        n.getAttribute("data-id"),
      );
    // The whole gesture: d3-drag (under React Flow) listens for mousedown, and
    // the selection itself lands on the click.
    const click = (el: HTMLElement, init: Record<string, unknown> = {}) => {
      fireEvent.pointerDown(el, init);
      fireEvent.mouseDown(el, init);
      fireEvent.mouseUp(el, init);
      fireEvent.click(el, init);
    };

    click(box("api"));
    await waitFor(() => expect(selected()).toEqual(["api"]));

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    click(box("db"), { shiftKey: true });
    await waitFor(() => expect(selected()).toEqual(["api", "db"]));

    // …and out again. A modifier-click is a TOGGLE, so the pre-drag snapshot
    // that makes an additive BAND work must not be armed by one — restoring
    // it here would undo every remove.
    click(box("db"), { shiftKey: true });
    await waitFor(() => expect(selected()).toEqual(["api"]));
    fireEvent.keyUp(window, { key: "Shift" });
  });

  it("stands the band down while Compare owns the canvas", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={TWO} diffBase={TWO} />);

    fireEvent.keyDown(window, { key: "m" });
    await waitFor(() =>
      expect(container.querySelector(".as-canvas")).toHaveClass("as-canvas--tool-select"),
    );
    // DiffCanvas renders a React Flow of its own, with its own pane, inside
    // this canvas — a band there would draw over a read-only diff and
    // re-select the editor's elements underneath it.
    expect(container.querySelector(".as-diffcanvas")).toBeInTheDocument();
    expect(container.querySelector(".as-marquee")).not.toBeInTheDocument();
  });

  it("stops the boxes being draggable under Select and Pan", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={TWO} />);
    const draggable = () => container.querySelectorAll(".react-flow__node.draggable").length;

    await waitFor(() => expect(draggable()).toBeGreaterThan(0));

    // Otherwise every band and every pan would begin by shoving whatever box
    // the press happened to land on.
    fireEvent.keyDown(window, { key: "m" });
    await waitFor(() => expect(draggable()).toBe(0));

    fireEvent.keyDown(window, { key: "h" });
    await waitFor(() => expect(draggable()).toBe(0));

    fireEvent.keyDown(window, { key: "v" });
    await waitFor(() => expect(draggable()).toBeGreaterThan(0));
  });
});

// ── The band ────────────────────────────────────────────────────────────────

describe("band geometry", () => {
  it("catches a box the band merely touches", () => {
    const band = { x: 0, y: 0, width: 50, height: 50 };
    expect(boxesOverlap(band, { x: 40, y: 40, width: 100, height: 100 })).toBe(true);
    expect(boxesOverlap(band, { x: 60, y: 0, width: 10, height: 10 })).toBe(false);
    // Edge-to-edge is a miss, the same as React Flow's own band.
    expect(boxesOverlap(band, { x: 50, y: 0, width: 10, height: 10 })).toBe(false);
  });

  it("reads a rectangle from corners given in any order", () => {
    expect(rectBetween({ x: 90, y: 80 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 80,
      height: 60,
    });
  });

  it("returns the ids inside the band", () => {
    const boxes = [
      { id: "a", x: 0, y: 0, width: 40, height: 40 },
      { id: "b", x: 200, y: 0, width: 40, height: 40 },
    ];
    expect([...idsInBand({ x: -5, y: -5, width: 60, height: 60 }, boxes)]).toEqual(["a"]);
    expect([...idsInBand({ x: -5, y: -5, width: 400, height: 60 }, boxes)]).toEqual(["a", "b"]);
  });

  it("pans harder the further past the edge the pointer is", () => {
    const bounds = { left: 0, top: 0, right: 800, bottom: 600 };
    expect(edgePan({ x: 400, y: 300 }, bounds)).toEqual({ x: 0, y: 0 });
    const near = edgePan({ x: 20, y: 300 }, bounds);
    const past = edgePan({ x: -50, y: 300 }, bounds);
    expect(near.x).toBeGreaterThan(0);
    expect(past.x).toBeGreaterThan(near.x);
    expect(edgePan({ x: 400, y: 610 }, bounds).y).toBeLessThan(0);
  });

  it("compares sets by content", () => {
    expect(sameSet(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(sameSet(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
  });
});

/**
 * A canvas the band can be dragged across, with the boxes laid out by hand.
 *
 * Screen and flow coordinates are the same here (identity viewport), so the
 * client coordinates a test fires read straight off the layout below.
 */
const BOXES: Node[] = [
  { id: "a", position: { x: 0, y: 0 }, data: {}, measured: { width: 100, height: 60 } },
  { id: "b", position: { x: 200, y: 0 }, data: {}, measured: { width: 100, height: 60 } },
  { id: "c", position: { x: 400, y: 0 }, data: {}, measured: { width: 100, height: 60 } },
];

function Board({ enabled = true, preselected = [] as string[], hiddenEdge = false }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<Node[]>(() =>
    BOXES.map((n) => ({ ...n, selected: preselected.includes(n.id) })),
  );
  const [edges, setEdges] = useState<Edge[]>(() => [
    { id: "a-b", source: "a", target: "b" },
    { id: "b-c", source: "b", target: "c", hidden: hiddenEdge },
  ]);

  const live = useRef({ nodes, edges });
  live.current = { nodes, edges };
  const flow = useRef<MarqueeFlow>({
    getNodes: () => live.current.nodes,
    getEdges: () => live.current.edges,
    getInternalNode: (id) => {
      const found = live.current.nodes.find((n) => n.id === id);
      return found ? { internals: { positionAbsolute: found.position } } : undefined;
    },
    screenToFlowPosition: (point) => ({ ...point }),
    flowToScreenPosition: (point) => ({ ...point }),
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    setViewport: () => {},
  }).current;

  const marquee = useMarqueeSelect({ enabled, surfaceRef, flow, setNodes, setEdges });

  return (
    <div ref={surfaceRef} onPointerDownCapture={marquee.onPointerDownCapture}>
      <div ref={marquee.bandRef} data-testid="band" hidden />
      <div className="react-flow__pane" data-testid="pane">
        <button type="button" data-testid="in-node">
          a control inside a box
        </button>
      </div>
      <output data-testid="nodes">
        {nodes.filter((n) => n.selected).map((n) => n.id).join(",")}
      </output>
      <output data-testid="edges">
        {edges.filter((e) => e.selected).map((e) => e.id).join(",")}
      </output>
    </div>
  );
}

const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 });

function drag(from: [number, number], to: [number, number], modifier?: "shiftKey" | "metaKey") {
  const keys = modifier ? { [modifier]: true } : {};
  fireEvent.pointerDown(screen.getByTestId("pane"), { ...at(...from), ...keys });
  fireEvent.pointerMove(window, { ...at(...to), ...keys });
  fireEvent.pointerUp(window, { ...at(...to), ...keys });
}

describe("the Select tool's band", () => {
  beforeEach(() => {
    // jsdom measures everything as zero, which would put the whole canvas
    // inside the auto-pan strip.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600,
      toJSON: () => ({}),
    } as DOMRect);
  });

  it("highlights every box the drag sweeps, and their lines", () => {
    render(<Board />);
    drag([-10, -10], [310, 80]);

    expect(screen.getByTestId("nodes")).toHaveTextContent("a,b");
    // A caught box brings its wiring, so a copied selection arrives connected.
    expect(screen.getByTestId("edges")).toHaveTextContent("a-b,b-c");
  });

  it("leaves a hidden line alone", () => {
    render(<Board hiddenEdge />);
    drag([-10, -10], [310, 80]);

    expect(screen.getByTestId("nodes")).toHaveTextContent("a,b");
    // "b-c" is hidden — the timeline's hide-later mode does that to anything
    // dated after the cursor — and selecting it would put an invisible line
    // in reach of the next Delete.
    expect(screen.getByTestId("edges")).toHaveTextContent("a-b");
    expect(screen.getByTestId("edges")).not.toHaveTextContent("b-c");
  });

  it("leaves a click alone — press and release is still an ordinary click", () => {
    render(<Board preselected={["c"]} />);
    // Exactly at the threshold, which is still a click — a hand that shifts a
    // few pixels between press and release is aiming, not dragging.
    const jitter = at(150 + DRAG_THRESHOLD, 30);
    fireEvent.pointerDown(screen.getByTestId("pane"), at(150, 30));
    fireEvent.pointerMove(window, jitter);
    fireEvent.pointerUp(window, jitter);

    // Nothing banded, so nothing was re-selected: the press falls through to
    // whatever was under it, exactly as it does under the Cursor tool.
    expect(screen.getByTestId("nodes")).toHaveTextContent("c");
    expect(screen.getByTestId("band")).not.toBeVisible();
  });

  it("replaces the selection with a plain band", () => {
    render(<Board preselected={["c"]} />);
    drag([-10, -10], [110, 80]);
    expect(screen.getByTestId("nodes")).toHaveTextContent("a");
    expect(screen.getByTestId("nodes")).not.toHaveTextContent("c");
  });

  it("MERGES into the selection when ⇧ or ⌘ is held", () => {
    render(<Board preselected={["c"]} />);
    drag([-10, -10], [110, 80], "shiftKey");
    expect(screen.getByTestId("nodes")).toHaveTextContent("a,c");

    // …and again, so a third band adds to the running total rather than to
    // whatever the last band alone caught.
    drag([190, -10], [310, 80], "metaKey");
    expect(screen.getByTestId("nodes")).toHaveTextContent("a,b,c");
  });

  it("shows the band while dragging and takes it away on release", () => {
    render(<Board />);
    fireEvent.pointerDown(screen.getByTestId("pane"), at(10, 10));
    fireEvent.pointerMove(window, at(210, 110));

    const band = screen.getByTestId("band");
    expect(band).toBeVisible();
    expect(band.style.left).toBe("10px");
    expect(band.style.width).toBe("200px");
    expect(band.style.height).toBe("100px");

    fireEvent.pointerUp(window, at(210, 110));
    expect(band).not.toBeVisible();
  });

  it("swallows the click a band ends on, so the pane cannot clear it", () => {
    render(<Board />);
    const onClick = vi.fn();
    screen.getByTestId("pane").addEventListener("click", onClick);

    drag([-10, -10], [110, 80]);
    fireEvent.click(screen.getByTestId("pane"));
    expect(onClick).not.toHaveBeenCalled();

    // Only the one click. The next is the user's own again.
    fireEvent.click(screen.getByTestId("pane"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps its hands off a control on the canvas", () => {
    render(<Board />);
    fireEvent.pointerDown(screen.getByTestId("in-node"), at(10, 10));
    fireEvent.pointerMove(window, at(210, 110));
    expect(screen.getByTestId("band")).not.toBeVisible();
    fireEvent.pointerUp(window, at(210, 110));
  });

  it("does nothing at all under another tool", () => {
    render(<Board enabled={false} />);
    drag([-10, -10], [310, 80]);
    expect(screen.getByTestId("nodes")).toBeEmptyDOMElement();
  });
});
