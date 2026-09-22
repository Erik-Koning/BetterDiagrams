/**
 * @vitest-environment jsdom
 *
 * `edgesOnHover`: the canvas shows its cards alone, and a connection is drawn
 * only while the pointer is over a node it touches — or while that node, or
 * the connection itself, is selected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { ArchitectureStudio } from "./ArchitectureStudio";
import { clearWelcomeSuppression } from "./WelcomeModal";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";

vi.mock("./JsonCodeEditor", () => ({
  JsonCodeEditor: ({ value, ariaLabel }: { value: string; ariaLabel?: string }) => (
    <textarea aria-label={ariaLabel ?? "Diagram JSON"} value={value} readOnly />
  ),
}));

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

const doc = (partial: Record<string, unknown>): DiagramTemplate =>
  validateTemplate({ version: 1, nodes: [], edges: [], ...partial });

const node = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const edge = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.react-flow__edge[data-id="${id}"]`)!;

const THREE = doc({
  nodes: [
    { id: "a", label: "A", kind: "service", x: 0, y: 0 },
    { id: "b", label: "B", kind: "service", x: 300, y: 0 },
    { id: "c", label: "C", kind: "service", x: 600, y: 0 },
  ],
  edges: [
    { id: "ab", source: "a", target: "b", label: "calls" },
    { id: "bc", source: "b", target: "c", label: "reads" },
  ],
});

/** The label layers hidden with their lines — they render outside the edge. */
const dormantLabels = (container: HTMLElement) =>
  container.querySelectorAll(".as-edge__labellayer.as-edge--dormant").length;

beforeEach(() => clearWelcomeSuppression());

describe("edgesOnHover", () => {
  it("is off by default: every connection is drawn", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={THREE} />);
    await waitFor(() => expect(edge(container, "ab")).toBeTruthy());
    expect(edge(container, "ab").classList.contains("as-edge--dormant")).toBe(false);
    expect(edge(container, "bc").classList.contains("as-edge--dormant")).toBe(false);
  });

  it("hides every connection until the pointer is over a node it touches", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={THREE} edgesOnHover />);
    await waitFor(() => expect(edge(container, "ab")).toBeTruthy());
    expect(edge(container, "ab").classList.contains("as-edge--dormant")).toBe(true);
    expect(edge(container, "bc").classList.contains("as-edge--dormant")).toBe(true);
    expect(dormantLabels(container)).toBe(2);

    // Over A: only A's line shows — and only its label.
    fireEvent.mouseEnter(node(container, "a"));
    await waitFor(() => expect(edge(container, "ab").classList.contains("as-edge--dormant")).toBe(false));
    expect(edge(container, "bc").classList.contains("as-edge--dormant")).toBe(true);
    expect(dormantLabels(container)).toBe(1);

    // Over B: both of B's lines.
    fireEvent.mouseLeave(node(container, "a"));
    fireEvent.mouseEnter(node(container, "b"));
    await waitFor(() => expect(edge(container, "bc").classList.contains("as-edge--dormant")).toBe(false));
    expect(edge(container, "ab").classList.contains("as-edge--dormant")).toBe(false);

    // Off the cards: everything goes again.
    fireEvent.mouseLeave(node(container, "b"));
    await waitFor(() => expect(edge(container, "ab").classList.contains("as-edge--dormant")).toBe(true));
    expect(edge(container, "bc").classList.contains("as-edge--dormant")).toBe(true);
  });

  it("keeps a selected node's connections drawn after the pointer leaves", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={THREE} edgesOnHover />);
    await waitFor(() => expect(edge(container, "ab")).toBeTruthy());

    fireEvent.mouseEnter(node(container, "c"));
    fireEvent.click(node(container, "c"));
    fireEvent.mouseLeave(node(container, "c"));
    await waitFor(() => expect(edge(container, "bc").classList.contains("as-edge--dormant")).toBe(false));
    expect(edge(container, "ab").classList.contains("as-edge--dormant")).toBe(true);

    // Deselecting lets it go.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(edge(container, "bc").classList.contains("as-edge--dormant")).toBe(true));
  });

  it("lights the wiring inside a group when its frame is hovered", async () => {
    const GROUPED = doc({
      nodes: [
        { id: "vpc", label: "VPC", kind: "group", x: 0, y: 0, w: 500, h: 300 },
        { id: "api", label: "API", kind: "service", parentId: "vpc", x: 20, y: 40 },
        { id: "db", label: "DB", kind: "database", parentId: "vpc", x: 300, y: 40 },
        { id: "out", label: "Outside", kind: "service", x: 700, y: 40 },
      ],
      edges: [
        { id: "in", source: "api", target: "db" },
        { id: "far", source: "out", target: "out" },
      ],
    });
    const { container } = mount(<ArchitectureStudio defaultValue={GROUPED} edgesOnHover />);
    await waitFor(() => expect(edge(container, "in")).toBeTruthy());
    expect(edge(container, "in").classList.contains("as-edge--dormant")).toBe(true);

    fireEvent.mouseEnter(node(container, "vpc"));
    await waitFor(() => expect(edge(container, "in").classList.contains("as-edge--dormant")).toBe(false));
  });
});
