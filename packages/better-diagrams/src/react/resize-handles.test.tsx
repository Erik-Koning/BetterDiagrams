/**
 * @vitest-environment jsdom
 *
 * A node's resize handles come up on hover as well as on selection — for
 * every box on the canvas: cards, frames, notes, zones. Written as the
 * pointer journeys that reach (or must not reach) them.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { ArchitectureStudio } from "./ArchitectureStudio";
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

const DOC = doc({
  zones: [{ id: "z", label: "Region", providers: ["aws"], provider: "aws", x: 0, y: 0, w: 900, h: 700 }],
  nodes: [
    { id: "g", label: "Frame", kind: "group", x: 40, y: 40, w: 400, h: 300 },
    { id: "in", label: "Inside", kind: "service", parentId: "g", x: 30, y: 60 },
    { id: "card", label: "Card", kind: "service", x: 600, y: 40 },
    { id: "note", label: "A note", kind: "text", x: 600, y: 300 },
    { id: "pinned", label: "Pinned", kind: "service", x: 600, y: 500, locked: true },
  ],
});

/** React Flow's wrapper for a node — the element hover is read from. */
const wrapper = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;

const handles = (container: HTMLElement, id: string) =>
  wrapper(container, id).querySelectorAll(".react-flow__resize-control.handle").length;

async function mounted(container: HTMLElement, ...ids: string[]) {
  await waitFor(() => {
    for (const id of ids) expect(wrapper(container, id)).toBeTruthy();
  });
}

describe("resize handles", () => {
  it("come up while the pointer rests on a card, frame, note or zone, and go when it leaves", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={DOC} onChange={() => {}} />);
    await mounted(container, "card", "g", "note", "zone:z");

    for (const id of ["card", "g", "note", "zone:z"]) {
      expect(handles(container, id), `${id} before hover`).toBe(0);
      fireEvent.pointerEnter(wrapper(container, id));
      await waitFor(() => expect(handles(container, id), `${id} hovered`).toBe(4));
      fireEvent.pointerLeave(wrapper(container, id));
      await waitFor(() => expect(handles(container, id), `${id} left`).toBe(0));
    }
  });

  it("stay up for a selected node after the pointer has left it", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={DOC} onChange={() => {}} />);
    await mounted(container, "card");

    fireEvent.pointerEnter(wrapper(container, "card"));
    fireEvent.click(wrapper(container, "card"));
    await waitFor(() => expect(wrapper(container, "card").classList.contains("selected")).toBe(true));
    fireEvent.pointerLeave(wrapper(container, "card"));
    // Still there: selection is the touch route, where there is no hover.
    expect(handles(container, "card")).toBe(4);
  });

  it("never reach a locked node, nor any node of a read-only diagram", async () => {
    const editable = mount(<ArchitectureStudio defaultValue={DOC} onChange={() => {}} />);
    await mounted(editable.container, "pinned");
    fireEvent.pointerEnter(wrapper(editable.container, "pinned"));
    fireEvent.click(wrapper(editable.container, "pinned"));
    await waitFor(() => expect(wrapper(editable.container, "pinned").classList.contains("selected")).toBe(true));
    expect(handles(editable.container, "pinned")).toBe(0);

    const readOnly = mount(<ArchitectureStudio defaultValue={DOC} onChange={() => {}} readOnly />);
    await mounted(readOnly.container, "card", "g");
    fireEvent.pointerEnter(wrapper(readOnly.container, "card"));
    fireEvent.pointerEnter(wrapper(readOnly.container, "g"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handles(readOnly.container, "card")).toBe(0);
    expect(handles(readOnly.container, "g")).toBe(0);
  });
});
