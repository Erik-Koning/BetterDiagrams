// @vitest-environment jsdom
/**
 * The Layout panel, as someone uses it: the score and what's behind it, the
 * choices and the gallery, each one undoable, and all of it gone in a read-only
 * document, where it can still report but not change anything.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import { ArchitectureStudio } from "./ArchitectureStudio";
import { LayoutPanel, type LayoutPanelProps } from "./LayoutPanel";
import { layoutCandidates } from "../contract/arrange";
import { ARRANGE_FIXTURES } from "../contract/arrange.fixtures";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";

// The real thing, counted: how often the gallery lays the document out is the cost
// of having the panel open.
vi.mock("../contract/arrange", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contract/arrange")>();
  return { ...actual, layoutCandidates: vi.fn(actual.layoutCandidates) };
});

const OVERLAPPING = validateTemplate({
  version: 1,
  nodes: [
    { id: "a", label: "Alpha", kind: "service", x: 0, y: 0, w: 170, h: 76 },
    { id: "b", label: "Bravo", kind: "service", x: 30, y: 20, w: 170, h: 76 },
    { id: "c", label: "Charlie", kind: "service", x: 500, y: 0, w: 170, h: 76 },
  ],
  edges: [{ id: "e1", source: "a", target: "c", label: "" }, { id: "e2", source: "b", target: "c", label: "" }],
});

const panel = (over: Partial<LayoutPanelProps> = {}) => {
  const handlers = {
    onPrefs: vi.fn(),
    onArrange: vi.fn(),
    onPolish: vi.fn(),
    onArrangeSelection: vi.fn(),
    onStraighten: vi.fn(),
    onCandidate: vi.fn(),
    onJump: vi.fn(),
    onPoint: vi.fn(),
    onClose: vi.fn(),
  };
  render(<LayoutPanel template={OVERLAPPING} options={{}} canEdit selected={0} selectedLines={0} {...handlers} {...over} />);
  return handlers;
};

describe("LayoutPanel", () => {
  it("says how good the picture is, and what's behind that", async () => {
    const user = userEvent.setup();
    const { onJump } = panel();
    expect(screen.getByRole("status", { name: /Layout score \d+ out of 100/ })).toBeInTheDocument();
    // The counts beside the score, which still tell a few problems from many where the score has bent.
    expect(within(screen.getByRole("status")).getByText(/^2 errors, \d+ notes?$/)).toBeInTheDocument();
    await user.click(screen.getByText("Boxes overlap"));
    await user.click(screen.getByRole("button", { name: /"Alpha" and "Bravo" overlap/ }));
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ rule: "box-overlap", nodeIds: ["a", "b"] }));
  });

  it("shows a finding on the canvas while it's pointed at", async () => {
    const user = userEvent.setup();
    const { onPoint } = panel();
    await user.click(screen.getByText("Boxes overlap"));
    const item = screen.getByRole("button", { name: /"Alpha" and "Bravo" overlap/ });
    await user.hover(item);
    expect(onPoint).toHaveBeenLastCalledWith(expect.objectContaining({ rule: "box-overlap" }));
    await user.unhover(item);
    expect(onPoint).toHaveBeenLastCalledWith(null);
  });

  it("stops pointing at a finding that went away under the pointer", async () => {
    const user = userEvent.setup();
    const onPoint = vi.fn();
    const props = { options: {}, canEdit: true, selected: 0, selectedLines: 0, onPrefs: vi.fn(), onArrange: vi.fn(), onPolish: vi.fn(), onArrangeSelection: vi.fn(), onStraighten: vi.fn(), onCandidate: vi.fn(), onJump: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<LayoutPanel template={OVERLAPPING} {...props} onPoint={onPoint} />);
    await user.click(screen.getByText("Boxes overlap"));
    await user.hover(screen.getByRole("button", { name: /"Alpha" and "Bravo" overlap/ }));
    expect(onPoint).toHaveBeenLastCalledWith(expect.objectContaining({ rule: "box-overlap" }));
    // The overlap is fixed elsewhere (an undo, a polish): nothing leaves the button, it just isn't there.
    const apart = { ...OVERLAPPING, nodes: OVERLAPPING.nodes.map((n, i) => ({ ...n, x: i * 400, y: 0 })) };
    rerender(<LayoutPanel template={apart} {...props} onPoint={onPoint} />);
    await waitFor(() => expect(screen.queryByText("Boxes overlap")).not.toBeInTheDocument());
    expect(onPoint).toHaveBeenLastCalledWith(null);
  });

  it("starts the gap sliders where an arrangement would put the gaps", () => {
    panel({ template: { ...OVERLAPPING, settings: { layout: { spacing: "airy" } } } });
    expect(screen.getByRole("slider", { name: "Between ranks" })).toHaveValue("134");
    document.body.innerHTML = "";
    panel({ template: { ...OVERLAPPING, settings: { layout: { rankGap: 400 } } } });
    expect(screen.getByRole("slider", { name: "Between ranks" })).toHaveValue("400");
  });

  it("names each choice by the word on it, and an arrow by what it means", () => {
    panel();
    expect(within(screen.getByRole("group", { name: "Style" })).getByRole("button", { name: "Layered" })).toHaveAttribute("title", expect.stringMatching(/Ranks along/));
    expect(within(screen.getByRole("group", { name: "Direction" })).getByRole("button", { name: "Left to right" })).toHaveTextContent("→");
  });

  it("offers each choice, with the document's own marked", async () => {
    const user = userEvent.setup();
    const { onPrefs } = panel({ template: { ...OVERLAPPING, settings: { layout: { direction: "down" } } } });
    const direction = within(screen.getByRole("group", { name: "Direction" }));
    expect(direction.getByRole("button", { name: "Top to bottom" })).toHaveAttribute("aria-pressed", "true");
    await user.click(direction.getByRole("button", { name: "Right to left" }));
    expect(onPrefs).toHaveBeenCalledWith({ direction: "left" });
    await user.click(within(screen.getByRole("group", { name: "Spacing" })).getByRole("button", { name: "Airy" }));
    expect(onPrefs).toHaveBeenCalledWith({ spacing: "airy" });
    await user.click(within(screen.getByRole("group", { name: "Line ends" })).getByRole("button", { name: "Bundled" }));
    expect(onPrefs).toHaveBeenCalledWith({ ends: "bundled" });
    await user.click(within(screen.getByRole("group", { name: "Shape" })).getByRole("button", { name: "Wide" }));
    expect(onPrefs).toHaveBeenCalledWith({ shape: "wide" });
    await user.click(within(screen.getByRole("group", { name: "Style" })).getByRole("button", { name: "Radial" }));
    expect(onPrefs).toHaveBeenCalledWith({ algorithm: "radial" });
  });

  it("gives Arrange selection only with something to arrange", async () => {
    const user = userEvent.setup();
    panel();
    expect(screen.getByRole("button", { name: "Selection" })).toBeDisabled();
    document.body.innerHTML = "";
    const { onArrangeSelection } = panel({ selected: 3 });
    await user.click(screen.getByRole("button", { name: "Selection" }));
    expect(onArrangeSelection).toHaveBeenCalled();
  });

  it("gives Straighten only with a line selected", async () => {
    const user = userEvent.setup();
    panel();
    expect(screen.getByRole("button", { name: "Straighten" })).toBeDisabled();
    document.body.innerHTML = "";
    const { onStraighten } = panel({ selectedLines: 1 });
    await user.click(screen.getByRole("button", { name: "Straighten" }));
    expect(onStraighten).toHaveBeenCalled();
  });

  it("applies a gap when the slider is let go, not on every step of the drag", () => {
    const { onPrefs } = panel();
    const slider = screen.getByRole("slider", { name: "Between ranks" });
    fireEvent.change(slider, { target: { value: "200" } });
    expect(onPrefs).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(onPrefs).toHaveBeenCalledWith({ rankGap: 200 });
  });

  it("shows the other arrangements, each with its score, and picks one", async () => {
    const user = userEvent.setup();
    const { onCandidate } = panel({ template: ARRANGE_FIXTURES.gatewayHub!() });
    const cards = screen.getAllByRole("button", { name: /Use this arrangement|Radial|Best fit|Left to right|Grid/ });
    expect(cards.length).toBeGreaterThan(2);
    await user.click(screen.getByTitle(/Use this arrangement: Grid/));
    expect(onCandidate).toHaveBeenCalledWith(expect.objectContaining({ algorithm: "grid" }));
  });

  it("measures again once the document stops changing, not on every frame of a drag or a click", () => {
    vi.useFakeTimers();
    try {
      const props = { options: {}, canEdit: true, selected: 0, selectedLines: 0, onPrefs: vi.fn(), onArrange: vi.fn(), onPolish: vi.fn(), onArrangeSelection: vi.fn(), onStraighten: vi.fn(), onCandidate: vi.fn(), onJump: vi.fn(), onPoint: vi.fn(), onClose: vi.fn() };
      const doc = ARRANGE_FIXTURES.gatewayHub!();
      const moved = (dx: number) => ({ ...doc, nodes: doc.nodes.map((n, i) => (i === 0 ? { ...n, x: n.x + dx } : n)) });
      const { rerender } = render(<LayoutPanel template={doc} {...props} />);
      const before = vi.mocked(layoutCandidates).mock.calls.length;
      for (let frame = 1; frame <= 6; frame++) {
        rerender(<LayoutPanel template={moved(frame * 10)} {...props} />);
        act(() => vi.advanceTimersByTime(40));
      }
      expect(layoutCandidates).toHaveBeenCalledTimes(before);
      act(() => vi.advanceTimersByTime(1000));
      expect(layoutCandidates).toHaveBeenCalledTimes(before + 1);
      // Selecting a box hands the panel the same document as a new object.
      rerender(<LayoutPanel template={structuredClone(moved(60))} {...props} />);
      act(() => vi.advanceTimersByTime(1000));
      expect(layoutCandidates).toHaveBeenCalledTimes(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("catches the score up once the document settles", () => {
    vi.useFakeTimers();
    try {
      const props = { options: {}, canEdit: false, selected: 0, selectedLines: 0, onPrefs: vi.fn(), onArrange: vi.fn(), onPolish: vi.fn(), onArrangeSelection: vi.fn(), onStraighten: vi.fn(), onCandidate: vi.fn(), onJump: vi.fn(), onPoint: vi.fn(), onClose: vi.fn() };
      const { rerender } = render(<LayoutPanel template={OVERLAPPING} {...props} />);
      expect(screen.getByText("Boxes overlap")).toBeInTheDocument();
      const apart = { ...OVERLAPPING, nodes: OVERLAPPING.nodes.map((n) => (n.id === "b" ? { ...n, y: 300 } : n)) };
      rerender(<LayoutPanel template={apart} {...props} />);
      expect(screen.getByText("Boxes overlap")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByText("Boxes overlap")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits to be asked before comparing arrangements of a very large diagram", async () => {
    const user = userEvent.setup();
    const big = validateTemplate({
      version: 1,
      nodes: Array.from({ length: 130 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, kind: "service", x: i * 200, y: 0, w: 170, h: 76 })),
      edges: [],
    });
    panel({ template: big });
    expect(screen.queryByTitle(/Use this arrangement/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Compare arrangements" }));
    expect(await screen.findAllByTitle(/Use this arrangement/)).not.toHaveLength(0);
  });

  it("reports in a read-only document, and offers no changes", () => {
    panel({ canEdit: false });
    expect(screen.getByRole("status", { name: /Layout score/ })).toBeInTheDocument();
    expect(screen.getByText("Boxes overlap")).toBeInTheDocument();
    for (const name of ["Arrange", "Polish", "Selection"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Direction" })).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Use this arrangement/)).not.toBeInTheDocument();
  });

  it("says so when there's nothing to fix", () => {
    panel({
      template: validateTemplate({
        version: 1,
        nodes: [
          { id: "a", label: "Alpha", kind: "service", x: 0, y: 0, w: 170, h: 76 },
          { id: "b", label: "Bravo", kind: "service", x: 300, y: 0, w: 170, h: 76 },
        ],
        edges: [{ id: "e", source: "a", target: "b", label: "" }],
      }),
    });
    expect(screen.getByText(/Nothing to fix/)).toBeInTheDocument();
  });
});

describe("in the studio", () => {
  const mount = (over: { readOnly?: boolean; doc?: DiagramTemplate } = {}) => {
    const onChange = vi.fn();
    render(
      <ReactFlowProvider>
        <div style={{ width: 1200, height: 800 }}>
          <ArchitectureStudio defaultValue={over.doc ?? OVERLAPPING} onChange={onChange} {...(over.readOnly ? { readOnly: true } : {})} />
        </div>
      </ReactFlowProvider>,
    );
    return onChange;
  };
  const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)![0] as DiagramTemplate;

  it("Best fit is what a document starts on, and Polish clears an overlap as one undo step", async () => {
    const user = userEvent.setup();
    const onChange = mount();
    await user.click(screen.getByRole("button", { name: "Arrange" }));
    expect(screen.getByRole("radio", { name: "Best fit" })).toBeChecked();
    await user.click(screen.getByRole("menuitem", { name: /^Polish/ }));
    await screen.findByText(/Polished/);
    const a = last(onChange).nodes.find((n) => n.id === "a")!;
    const b = last(onChange).nodes.find((n) => n.id === "b")!;
    expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(last(onChange).nodes.find((n) => n.id === "b")).toMatchObject({ x: 30, y: 20 }));
  });

  it("a choice in the panel arranges, is stored in the document, and undoes in one step", async () => {
    const user = userEvent.setup();
    const onChange = mount();
    await user.click(screen.getByRole("button", { name: "Arrange" }));
    await user.click(screen.getByRole("menuitem", { name: /Layout panel/ }));
    const region = await screen.findByRole("region", { name: "Layout" });
    await user.click(within(within(region).getByRole("group", { name: "Direction" })).getByRole("button", { name: "Top to bottom" }));
    await waitFor(() => expect(last(onChange).settings).toEqual({ arrange: "auto", layout: { direction: "down" } }));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(last(onChange).settings).toBeUndefined());
  });

  it("choosing a default again leaves nothing stored", async () => {
    const user = userEvent.setup();
    const onChange = mount({ doc: { ...OVERLAPPING, settings: { arrange: "auto", layout: { direction: "down" } } } });
    await user.click(screen.getByRole("button", { name: "Arrange" }));
    await user.click(screen.getByRole("menuitem", { name: /Layout panel/ }));
    const region = await screen.findByRole("region", { name: "Layout" });
    await user.click(within(within(region).getByRole("group", { name: "Direction" })).getByRole("button", { name: "Auto" }));
    await waitFor(() => expect(last(onChange).settings).toEqual({ arrange: "auto" }));
  });

  it("an arrangement picked from the gallery is laid out from the document as it is, and remembered", async () => {
    const user = userEvent.setup();
    const onChange = mount({ doc: ARRANGE_FIXTURES.gatewayHub!() });
    await user.click(screen.getByRole("button", { name: "Arrange" }));
    await user.click(screen.getByRole("menuitem", { name: /Layout panel/ }));
    await user.click(await screen.findByTitle(/Use this arrangement: Grid/));
    await waitFor(() => expect(last(onChange).settings).toEqual({ arrange: "auto", layout: { algorithm: "grid" } }));
    const nodes = last(onChange).nodes;
    const overlap = nodes.some((a, i) =>
      nodes.some((b, j) => j > i && !a.parentId && !b.parentId && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h),
    );
    expect(overlap).toBe(false);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(last(onChange).settings).toBeUndefined());
  });

  it("a ring, a mesh or a grid from the gallery leaves the direction someone chose alone", async () => {
    const user = userEvent.setup();
    const onChange = mount({ doc: { ...ARRANGE_FIXTURES.gatewayHub!(), settings: { arrange: "auto", layout: { direction: "down" } } } });
    await user.click(screen.getByRole("button", { name: "Arrange" }));
    await user.click(screen.getByRole("menuitem", { name: /Layout panel/ }));
    await user.click(await screen.findByTitle(/Use this arrangement: Grid/));
    await waitFor(() => expect(last(onChange).settings).toEqual({ arrange: "auto", layout: { algorithm: "grid", direction: "down" } }));
  });

  it("an arrangement picked for a roadmap leaves the roadmap behind whole, as the Arrange menu does", async () => {
    const user = userEvent.setup();
    const card = { icon: "none", description: "", parentId: null, x: 0, y: 0 };
    const roadmap = validateTemplate({
      version: 1,
      nodes: [
        { ...card, id: "design", label: "Design", kind: "task", date: "2026-03-10", w: 420, h: 84 },
        { ...card, id: "build", label: "Build", kind: "task", startDate: "2026-04-01", date: "2026-04-20", x: 500, w: 390, h: 84 },
        { ...card, id: "svc", label: "Billing", kind: "service", x: 0, y: 300, w: 170, h: 76 },
      ],
      edges: [{ id: "db", source: "design", target: "build", label: "" }],
      settings: { arrange: "roadmap", roadmap: { from: "2026-03-01", dayWidth: 10 } },
    });
    const onChange = mount({ doc: roadmap });
    await user.click(screen.getByRole("button", { name: "Arrange" }));
    await user.click(screen.getByRole("menuitem", { name: /Layout panel/ }));
    await user.click(await screen.findByTitle(/Use this arrangement: Grid/));
    await waitFor(() => expect(last(onChange).settings?.arrange).toBe("auto"));
    // No axis for dates nobody is laying out by, and no task still as wide as its dates were.
    expect(last(onChange).settings?.roadmap).toBeUndefined();
    const widths = last(onChange).nodes.filter((n) => n.kind === "task").map((n) => n.w);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeLessThan(390);
  });

  it("an old document that chose flow keeps arranging as flow", async () => {
    const user = userEvent.setup();
    const onChange = mount({ doc: { ...OVERLAPPING, settings: { arrange: "flow" } } });
    await user.click(screen.getByRole("button", { name: "Arrange" }));
    expect(screen.getByRole("radio", { name: "Left to right" })).toBeChecked();
    await user.click(screen.getByRole("menuitem", { name: /^Tidy/ }));
    await screen.findByText("Tidied");
    expect(last(onChange).settings?.arrange).toBe("flow");
    expect(last(onChange).edges.every((e) => !e.start?.auto)).toBe(true);
  });
});
