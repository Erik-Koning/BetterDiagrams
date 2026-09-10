/**
 * @vitest-environment jsdom
 *
 * Clearing a connection's route: dropping the hand-drawn waypoints a drag put
 * on a line. The bends are presentation, so losing them must be one undo
 * away — that is the whole reason this is an action and not a delete key.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArchitectureStudio } from "./ArchitectureStudio";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";

vi.mock("./JsonCodeEditor", () => ({
  JsonCodeEditor: () => <textarea aria-label="Diagram JSON" />,
}));

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

/** Two bent lines and one straight one, so scope is observable. */
const doc: DiagramTemplate = validateTemplate({
  version: 1,
  nodes: [
    { id: "a", label: "A", kind: "service", x: 0, y: 0 },
    { id: "b", label: "B", kind: "service", x: 400, y: 0 },
    { id: "c", label: "C", kind: "service", x: 400, y: 300 },
  ],
  edges: [
    { id: "e1", source: "a", target: "b", points: [[200, -80]] },
    { id: "e2", source: "a", target: "c", points: [[120, 220], [300, 260]] },
    { id: "e3", source: "b", target: "c" },
  ],
});

const latest = (onChange: ReturnType<typeof vi.fn>): DiagramTemplate =>
  onChange.mock.calls.at(-1)![0] as DiagramTemplate;

const pointsOf = (t: DiagramTemplate, id: string) => t.edges.find((e) => e.id === id)?.points;

describe("clearing edge routes", () => {
  it("the fixture keeps its bends through validation", () => {
    expect(pointsOf(doc, "e1")).toHaveLength(1);
    expect(pointsOf(doc, "e2")).toHaveLength(2);
    expect(pointsOf(doc, "e3")).toBeUndefined();
  });

  it("the Arrange item clears every bend on the canvas, and one undo puts them all back", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio value={doc} onChange={onChange} welcome={false} />);

    await user.click(screen.getByRole("button", { name: "Arrange" }));
    const item = screen.getByRole("menuitem", { name: /Clear routes/ });
    // The count is the number of lines it would actually change — e3 has no
    // bends, so it is not offered as one of them.
    expect(item.textContent).toContain("(2)");
    await user.click(item);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const flat = latest(onChange);
    expect(pointsOf(flat, "e1")).toBeUndefined();
    expect(pointsOf(flat, "e2")).toBeUndefined();

    // ⌘Z — every route comes back in ONE step, not one line at a time.
    const calls = onChange.mock.calls.length;
    fireEvent.keyDown(document, { key: "z", metaKey: true });
    await waitFor(() => expect(onChange.mock.calls.length).toBeGreaterThan(calls));
    const back = latest(onChange);
    expect(pointsOf(back, "e1")).toHaveLength(1);
    expect(pointsOf(back, "e2")).toHaveLength(2);
  });

  it("is offered as disabled when nothing on the canvas is bent", async () => {
    const user = userEvent.setup();
    const straight = validateTemplate({
      version: 1,
      nodes: [{ id: "a", label: "A", kind: "service", x: 0, y: 0 }],
      edges: [],
    });
    mount(<ArchitectureStudio value={straight} welcome={false} />);
    await user.click(screen.getByRole("button", { name: "Arrange" }));
    expect(screen.getByRole("menuitem", { name: /Clear routes/ })).toBeDisabled();
  });

  it("clears one line's route from the inspector, leaving the others alone", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio value={doc} onChange={onChange} welcome={false} />,
    );

    const hit = '.react-flow__edge[data-id="e2"] .as-edge__hit';
    await waitFor(() => expect(container.querySelector(hit)).toBeTruthy());
    fireEvent.click(container.querySelector(hit)!);

    // The inspector's own button, which has always been here — it now shares
    // the studio's clear rather than patching `points: undefined` itself.
    const button = await screen.findByRole("button", { name: "Clear route (2)" });
    await user.click(button);

    await waitFor(() => expect(pointsOf(latest(onChange), "e2")).toBeUndefined());
    // The other line is untouched: the inspector acts on the one it is showing.
    expect(pointsOf(latest(onChange), "e1")).toHaveLength(1);
    // Nothing left to clear, so the control goes away.
    await waitFor(() => expect(screen.queryByRole("button", { name: /Clear route/ })).toBeNull());
  });

  it("is not offered at all in read-only mode", () => {
    const { container } = mount(<ArchitectureStudio value={doc} readOnly welcome={false} />);
    // read-only hides the whole Arrange menu, and with it every editing
    // action — the straighten included, rather than shown-but-inert.
    expect(screen.queryByRole("button", { name: "Arrange" })).toBeNull();
    expect(container.querySelector(".as-edge__waypoint")).toBeNull();
  });
});
