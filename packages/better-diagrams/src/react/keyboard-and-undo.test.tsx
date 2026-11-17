/**
 * @vitest-environment jsdom
 *
 * keyboard-and-undo.test.tsx — which keys reach an editor, and how many
 * steps its undo takes, in both editors.
 *
 * Each case is the thing a person did when the key went to the wrong place
 * or the undo stack filled with the wrong steps: an arrow on a slider that
 * moved the box behind it, a ⌘Z in a read-only view that handed the host
 * its own old document, a drag of an opacity slider that took a dozen ⌘Z
 * presses to take back.
 */
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArchitectureStudio, type StudioHandle } from "./ArchitectureStudio";
import { SequenceStudio, type SequenceStudioHandle } from "./sequence/SequenceStudio";
import { addNode } from "../contract/edit";
import { EXAMPLE_TEMPLATE, EXAMPLE_ZONED_TEMPLATE, validateTemplate, type DiagramTemplate } from "../contract/schema";
import { EXAMPLE_SEQUENCE, validateSequence, type SequenceTemplate } from "../contract/sequence";

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));

/** Press a key ON an element, the way a browser delivers it, and say whether anything took it. */
function press(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => void target.dispatchEvent(event));
  return event;
}

/** How many ⌘Z presses until there is nothing left to undo. */
function undoAll(handle: { canUndo: () => boolean; undo: () => boolean }): number {
  let steps = 0;
  while (handle.canUndo() && steps < 50) {
    act(() => void handle.undo());
    steps += 1;
  }
  return steps;
}

const zoneOf = (container: HTMLElement) =>
  waitFor(() => {
    const el = container.querySelector<HTMLElement>(".react-flow__node[data-id^='zone']");
    if (!el) throw new Error("no zone on the canvas yet");
    return el;
  });

const nodeOf = (container: HTMLElement, id: string) =>
  waitFor(() => {
    const el = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    if (!el) throw new Error(`no ${id} on the canvas yet`);
    return el;
  });

const BASE = validateTemplate(EXAMPLE_TEMPLATE);
const SEQUENCE = validateSequence(EXAMPLE_SEQUENCE);

// ── A read-only editor ──────────────────────────────────────────────────────

describe("a read-only editor", () => {
  it("does not undo the host's change, by key or by handle", async () => {
    const ref = createRef<StudioHandle>();
    const onChange = vi.fn();
    const { rerender } = mount(<ArchitectureStudio ref={ref} value={BASE} onChange={onChange} readOnly welcome={false} />);
    const changed = addNode(BASE, { id: "cdn", label: "Edge CDN", kind: "gateway" });
    rerender(<ArchitectureStudio ref={ref} value={changed} onChange={onChange} readOnly welcome={false} />);
    expect(await screen.findByText("Edge CDN")).toBeInTheDocument();
    onChange.mockClear();

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(ref.current!.undo()).toBe(false);
    await tick();

    expect(screen.getByText("Edge CDN")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not undo the host's change in a sequence either", async () => {
    const ref = createRef<SequenceStudioHandle>();
    const onChange = vi.fn();
    const { rerender } = mount(<SequenceStudio ref={ref} value={SEQUENCE} onChange={onChange} readOnly welcome={false} />);
    const changed: SequenceTemplate = { ...SEQUENCE, participants: [...SEQUENCE.participants, { id: "audit", label: "Audit Log", kind: "service" }] };
    rerender(<SequenceStudio ref={ref} value={changed} onChange={onChange} readOnly welcome={false} />);
    expect(await screen.findByText("Audit Log")).toBeInTheDocument();
    onChange.mockClear();

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(ref.current!.undo()).toBe(false);
    await tick();

    expect(screen.getByText("Audit Log")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["architecture", (props: object) => <ArchitectureStudio defaultValue={BASE} welcome={false} {...props} />],
    ["sequence", (props: object) => <SequenceStudio defaultValue={SEQUENCE} welcome={false} {...props} />],
  ])("does not ask a host that keeps the history to step it (%s)", (_, studio) => {
    const hostHistory = { undo: vi.fn(), redo: vi.fn() };
    mount(studio({ hostHistory, readOnly: true }));
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(hostHistory.undo).not.toHaveBeenCalled();
    expect(hostHistory.redo).not.toHaveBeenCalled();
  });
});

// ── Keys a focused control answers itself ───────────────────────────────────

describe("a key meant for the control that has focus", () => {
  it("steps the zone's opacity slider and leaves the zone where it is", async () => {
    const ref = createRef<StudioHandle>();
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={EXAMPLE_ZONED_TEMPLATE} welcome={false} />);
    fireEvent.click(await zoneOf(container));
    const slider = await screen.findByLabelText("Fill opacity");
    const before = JSON.stringify(ref.current!.getTemplate().zones);

    slider.focus();
    const event = press(slider, "ArrowRight");
    press(slider, "ArrowUp", { shiftKey: true });
    await tick();

    // Not prevented: the browser steps the slider, as it should.
    expect(event.defaultPrevented).toBe(false);
    expect(JSON.stringify(ref.current!.getTemplate().zones)).toBe(before);
  });

  it("Enter on a toolbar button presses it rather than renaming the selected node", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={BASE} welcome={false} />);
    fireEvent.click(await nodeOf(container, "gw"));
    const button = screen.getByRole("button", { name: /^Arrange/ });

    button.focus();
    const event = press(button, "Enter");
    await tick();

    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector("input[aria-label='Name']")).toBeNull();
  });

  it("the arrows walk a menu and never move the selected node behind it", async () => {
    const user = userEvent.setup();
    const ref = createRef<StudioHandle>();
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={BASE} welcome={false} />);
    fireEvent.click(await nodeOf(container, "gw"));
    const before = ref.current!.getTemplate().nodes.find((n) => n.id === "gw")!;

    await user.click(screen.getByRole("button", { name: /^Arrange/ }));
    const first = document.activeElement!;
    expect(first).toHaveAttribute("role", "menuitem");
    press(first, "ArrowDown");
    expect(document.activeElement).not.toBe(first);
    press(document.activeElement!, "ArrowLeft");
    press(document.activeElement!, "ArrowRight", { shiftKey: true });
    await tick();

    const after = ref.current!.getTemplate().nodes.find((n) => n.id === "gw")!;
    expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
  });

  it("the Arrange menu's Priority slider and Method keep the arrows instead of jumping to a row", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={{ ...BASE, settings: { arrange: "directed" } }} welcome={false} />);
    await user.click(screen.getByRole("button", { name: /^Arrange/ }));

    const priority = screen.getByRole("slider", { name: "Priority" });
    priority.focus();
    expect(press(priority, "ArrowDown").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(priority);

    const method = screen.getByRole("combobox", { name: "Method" });
    method.focus();
    expect(press(method, "ArrowUp").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(method);
  });

  it("a key something else already handled is not handled again", async () => {
    const ref = createRef<StudioHandle>();
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={BASE} welcome={false} />);
    fireEvent.click(await nodeOf(container, "gw"));
    const before = ref.current!.getTemplate().nodes.find((n) => n.id === "gw")!.x;

    const claim = (event: Event) => event.preventDefault();
    document.addEventListener("keydown", claim);
    try {
      press(document.body, "ArrowRight");
    } finally {
      document.removeEventListener("keydown", claim);
    }
    await tick();
    expect(ref.current!.getTemplate().nodes.find((n) => n.id === "gw")!.x).toBe(before);

    // The same key, unclaimed, still nudges: the guard is the claim, not the key.
    press(document.body, "ArrowRight");
    await waitFor(() => expect(ref.current!.getTemplate().nodes.find((n) => n.id === "gw")!.x).toBe(before + 1));
  });
});

// ── Compare ─────────────────────────────────────────────────────────────────

describe("compare", () => {
  it("leaves the hidden selection alone: no nudge, no lock, no restack", async () => {
    const ref = createRef<StudioHandle>();
    const onChange = vi.fn();
    const doc = validateTemplate(EXAMPLE_ZONED_TEMPLATE);
    const { rerender } = mount(<ArchitectureStudio ref={ref} defaultValue={doc} onChange={onChange} welcome={false} />);
    await tick();
    act(() => ref.current!.select({ nodes: ["api"], zones: ["region"] }));
    await tick();
    rerender(<ArchitectureStudio ref={ref} defaultValue={doc} diffBase={doc} onChange={onChange} welcome={false} />);
    await tick();
    const before = JSON.stringify(ref.current!.getTemplate());

    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "l", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "]", metaKey: true });
    fireEvent.keyDown(window, { key: "[", metaKey: true, shiftKey: true });
    await tick();

    expect(JSON.stringify(ref.current!.getTemplate())).toBe(before);
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ── One gesture, one undo step ──────────────────────────────────────────────

describe("a slider or a colour picker", () => {
  it("undoes one drag of the zone's opacity in one step", async () => {
    const ref = createRef<StudioHandle>();
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={EXAMPLE_ZONED_TEMPLATE} welcome={false} />);
    fireEvent.click(await zoneOf(container));
    const slider = await screen.findByLabelText("Fill opacity");
    for (const value of [0.2, 0.24, 0.28, 0.32]) {
      fireEvent.change(slider, { target: { value: String(value) } });
      await tick();
    }
    expect(undoAll(ref.current!)).toBe(1);
  });

  it("undoes one sweep of a colour picker in one step, but each swatch click on its own", async () => {
    const ref = createRef<StudioHandle>();
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={EXAMPLE_ZONED_TEMPLATE} welcome={false} />);
    fireEvent.click(await zoneOf(container));
    const picker = await screen.findByLabelText("Custom zone colour");
    for (const value of ["#ff0000", "#ee1100", "#dd2200"]) {
      fireEvent.change(picker, { target: { value } });
      await tick();
    }
    expect(undoAll(ref.current!)).toBe(1);

    const swatches = screen.getAllByRole("button", { name: /^Zone colour / });
    fireEvent.click(swatches[1]!);
    await tick();
    fireEvent.click(swatches[2]!);
    await tick();
    expect(undoAll(ref.current!)).toBe(2);
  });

  it("undoes one sweep of a node's colour picker in one step", async () => {
    const ref = createRef<StudioHandle>();
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={BASE} welcome={false} />);
    fireEvent.click(await nodeOf(container, "gw"));
    const picker = await screen.findByLabelText("Custom node colour");
    for (const value of ["#ff0000", "#ee1100", "#dd2200"]) {
      fireEvent.change(picker, { target: { value } });
      await tick();
    }
    expect(undoAll(ref.current!)).toBe(1);
  });
});

// ── The sequence editor ─────────────────────────────────────────────────────

const labelOf = async (text: RegExp | string) =>
  (await screen.findByText(text)).closest(".as-seq-msg__label") as HTMLElement;

/** A press with no movement — a click, not a drag. */
function click(el: HTMLElement, init: Record<string, unknown> = {}) {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 400, clientY: 400, ...init });
  fireEvent.pointerUp(el, { pointerId: 1, ...init });
}

describe("typing in the sequence inspector", () => {
  it("undoes a run of typing in one step, and a run in another message as another", async () => {
    const ref = createRef<SequenceStudioHandle>();
    const onChange = vi.fn();
    mount(<SequenceStudio ref={ref} defaultValue={SEQUENCE} onChange={onChange} welcome={false} />);

    click(await labelOf(/1\. Place order/));
    const first = await screen.findByLabelText("Message label");
    for (const ch of ["x", "y", "z"]) {
      fireEvent.change(first, { target: { value: (first as HTMLInputElement).value + ch } });
      await tick();
    }
    await waitFor(() => expect((onChange.mock.calls.at(-1)![0] as SequenceTemplate).messages[0]!.label).toBe("Place orderxyz"));

    // Another message selected: its typing is a different edit, even straight away.
    click(await labelOf(/2\. POST/));
    await waitFor(() => expect(screen.getByLabelText("Message label")).not.toHaveValue("Place orderxyz"));
    const second = screen.getByLabelText("Message label") as HTMLInputElement;
    fireEvent.change(second, { target: { value: second.value + "!" } });
    await tick();

    expect(undoAll(ref.current!)).toBe(2);
    expect(ref.current!.getTemplate().messages[0]!.label).toBe("Place order");
  });
});

describe("the sequence editor's keyboard", () => {
  it("answers only when it is the editor in use", async () => {
    const one = vi.fn();
    const two = vi.fn();
    const first = mount(<SequenceStudio defaultValue={SEQUENCE} onChange={one} welcome={false} />);
    const second = mount(<SequenceStudio defaultValue={SEQUENCE} onChange={two} welcome={false} />);

    // The first to mount holds the keyboard until the other is touched.
    fireEvent.keyDown(window, { key: "n" });
    await waitFor(() => expect(one).toHaveBeenCalled());
    expect(two).not.toHaveBeenCalled();

    fireEvent.pointerDown(second.container.querySelector(".as-root")!);
    one.mockClear();
    fireEvent.keyDown(window, { key: "n" });
    await waitFor(() => expect(two).toHaveBeenCalled());
    expect(one).not.toHaveBeenCalled();
    first.unmount();
  });

  it("does nothing behind the delete dialog", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={SEQUENCE} onChange={onChange} welcome={false} />);
    fireEvent.click(screen.getByText("Order API"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog");

    fireEvent.keyDown(window, { key: "n" });
    fireEvent.keyDown(window, { key: "m" });
    await tick();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("saves with ⌘S from the field just typed in, instead of leaving it to the browser", async () => {
    const onSave = vi.fn();
    mount(<SequenceStudio defaultValue={SEQUENCE} onSave={onSave} welcome={false} />);
    click(await labelOf(/1\. Place order/));
    const field = await screen.findByLabelText("Message label");
    field.focus();

    const event = press(field, "s", { metaKey: true });

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });

  it("undoes with ⌘Z straight after a pick from a list, focus still on it", async () => {
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={SEQUENCE} onChange={onChange} welcome={false} />);
    click(await labelOf(/1\. Place order/));
    const style = (await screen.findByLabelText("Message style")) as HTMLSelectElement;
    const was = style.value;
    const other = [...style.options].find((o) => o.value !== was)!.value;

    style.focus();
    fireEvent.change(style, { target: { value: other } });
    await waitFor(() => expect((onChange.mock.calls.at(-1)![0] as SequenceTemplate).messages[0]!.style ?? "sync").toBe(other));
    press(style, "z", { metaKey: true });

    await waitFor(() => expect((onChange.mock.calls.at(-1)![0] as SequenceTemplate).messages[0]!.style ?? "sync").toBe(was));
  });
});

// ── The AI chat on a blank canvas ───────────────────────────────────────────

describe("drawing with the AI chat on a blank canvas", () => {
  it("keeps the arrangement chosen before there was anything to arrange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const reply = JSON.stringify({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "service", x: 0, y: 0 },
        { id: "b", label: "B", kind: "service", x: 0, y: 0 },
        { id: "c", label: "C", kind: "service", x: 0, y: 0 },
      ],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c" },
      ],
    });
    const generate = vi.fn().mockResolvedValue(reply);
    mount(<ArchitectureStudio defaultValue={{ version: 1, nodes: [], edges: [] }} onChange={onChange} generate={generate} welcome={false} />);

    await user.click(screen.getByRole("button", { name: /^Arrange/ }));
    await user.click(screen.getByRole("radio", { name: "Directed flow" }));
    await user.click(screen.getByRole("button", { name: "AI" }));
    await user.type(screen.getByRole("textbox", { name: "Message" }), "draw a b c");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect((onChange.mock.calls.at(-1)![0] as DiagramTemplate).nodes).toHaveLength(3));
    const drawn = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(drawn.settings?.arrange).toBe("directed");
    // Arranged by it, too: the model piled every box on one spot.
    const spots = new Set(drawn.nodes.map((n) => `${n.x},${n.y}`));
    expect(spots.size).toBe(3);
  });

  it("lets a reply that says how to arrange itself have its way", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const reply = JSON.stringify({
      version: 1,
      settings: { arrange: "untangle" },
      nodes: [
        { id: "a", label: "A", kind: "service" },
        { id: "b", label: "B", kind: "service" },
      ],
      edges: [{ id: "e1", source: "a", target: "b" }],
    });
    const generate = vi.fn().mockResolvedValue(reply);
    mount(<ArchitectureStudio defaultValue={{ version: 1, nodes: [], edges: [] }} onChange={onChange} generate={generate} welcome={false} />);

    await user.click(screen.getByRole("button", { name: /^Arrange/ }));
    await user.click(screen.getByRole("radio", { name: "Directed flow" }));
    await user.click(screen.getByRole("button", { name: "AI" }));
    await user.type(screen.getByRole("textbox", { name: "Message" }), "draw a b");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect((onChange.mock.calls.at(-1)![0] as DiagramTemplate).nodes).toHaveLength(2));
    expect((onChange.mock.calls.at(-1)![0] as DiagramTemplate).settings?.arrange).toBe("untangle");
  });
});
