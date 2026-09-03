/**
 * @vitest-environment jsdom
 *
 * Regressions for the sequence editor's verified bugs — one describe per
 * fault, each named for the thing a user saw go wrong rather than for the
 * function that was wrong. Gesture assertions stay transform-independent
 * ("far down is later"), like the main suite's.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SequenceStudio } from "./SequenceStudio";
import {
  EXAMPLE_SEQUENCE,
  validateSequence,
  type SeqNote,
  type SequenceTemplate,
} from "../../contract/sequence";
import {
  renderSequenceToMermaid,
  renderSequenceToPlantUml,
} from "../sequence-exporters";

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1400px; height: 900px",
    }),
  });
}

const example = validateSequence(EXAMPLE_SEQUENCE);

/** Four rows and a loop over the middle two — the smallest span to break. */
const framed = validateSequence({
  participants: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  messages: [
    { id: "m1", from: "a", to: "b", label: "one" },
    { id: "m2", from: "b", to: "a", label: "two" },
    { id: "m3", from: "a", to: "b", label: "three" },
    { id: "m4", from: "b", to: "a", label: "four" },
  ],
  activations: [{ id: "act", participant: "b", from: "m1", to: "m3" }],
  fragments: [{ id: "f", kind: "loop", label: "retry", from: "m1", to: "m3" }],
});

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)![0] as SequenceTemplate;

/** The label strip of the message whose text matches. */
const labelOf = async (text: RegExp | string) =>
  (await screen.findByText(text)).closest(".as-seq-msg__label") as HTMLElement;

/** A press with no movement — a click, not a drag. */
function press(el: HTMLElement, init: Record<string, unknown> = {}) {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 400, clientY: 400, ...init });
  fireEvent.pointerUp(el, { pointerId: 1, ...init });
}

// ── 1. A click on a lifeline ────────────────────────────────────────────────

describe("clicking a lifeline", () => {
  it("creates no activation bar", async () => {
    const onChange = vi.fn();
    const { container } = mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    press(container.querySelectorAll(".as-seq-lifeline__hit")[2] as HTMLElement);

    await new Promise((r) => setTimeout(r, 20));
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".as-seq-bar")).toHaveLength(
      example.activations!.length,
    );
  });

  it("selects the column instead of swallowing the press", async () => {
    const onSelectionChange = vi.fn();
    const { container } = mount(
      <SequenceStudio defaultValue={example} onSelectionChange={onSelectionChange} />,
    );

    press(container.querySelectorAll(".as-seq-lifeline__hit")[2] as HTMLElement);

    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ participants: ["api"] }),
      ),
    );
  });
});

// ── 2 + 13. The message label ───────────────────────────────────────────────

describe("the message label", () => {
  it("selects its message on a click, opening the inspector", async () => {
    mount(<SequenceStudio defaultValue={example} />);

    press(await labelOf(/1\. Place order/));

    const field = await screen.findByLabelText("Message label");
    expect(field).toHaveValue("Place order");
  });

  it("shift-clicking piles messages up for a fragment", async () => {
    const onSelectionChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onSelectionChange={onSelectionChange} />);

    press(await labelOf(/6\. Charge/));
    press(await labelOf(/7\. receipt/), { shiftKey: true });

    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ messages: ["m6", "m7"] }),
      ),
    );
  });

  it("does not jump a row when the grab point is nowhere near it", async () => {
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    // The press lands nowhere near the arrow's own y, and the drag is purely
    // sideways. Following the raw pointer y used to teleport the row under
    // the cursor on the first pixel; holding the grab offset means the row
    // does not move at all — and no move is no edit.
    const label = await labelOf(/1\. Place order/);
    fireEvent.pointerDown(label, { pointerId: 1, button: 0, clientX: 300, clientY: 800 });
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 320, clientY: 800 });
    fireEvent.pointerUp(label, { pointerId: 1 });

    await new Promise((r) => setTimeout(r, 20));
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ── 3. Deleting a participant ───────────────────────────────────────────────

describe("deleting a participant that carries messages", () => {
  it("asks first and can be called off", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    fireEvent.click(screen.getByText("Order API"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog", { name: "Delete Order API?" });
    expect(dialog).toHaveTextContent("7 messages");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Order API")).toBeInTheDocument();
  });

  it("says exactly what went with it", async () => {
    const user = userEvent.setup();
    mount(<SequenceStudio defaultValue={example} />);

    fireEvent.click(screen.getByText("Web App"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete participant" }));

    expect(await screen.findByText("Removed Web App and 4 messages")).toBeInTheDocument();
  });

  it("goes quietly when the column has no messages", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const lonely = validateSequence({
      participants: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      messages: [{ id: "m1", from: "a", to: "b", label: "one" }],
    });
    mount(<SequenceStudio defaultValue={lonely} onChange={onChange} />);

    fireEvent.click(screen.getByText("C"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(screen.queryByRole("button", { name: "Delete participant" })).not.toBeInTheDocument();
    await waitFor(() => expect(last(onChange).participants).toHaveLength(2));
  });
});

// ── 4. Deleting / reordering a message ──────────────────────────────────────

describe("editing a message inside a fragment", () => {
  it("deleting the loop's first row leaves the loop over what is left", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={framed} onChange={onChange} />);

    press(await labelOf("one"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const t = last(onChange);
    expect(t.messages.map((m) => m.id)).toEqual(["m2", "m3", "m4"]);
    // The frame is still there, over the rows it still covers.
    expect(t.fragments).toEqual([
      expect.objectContaining({ id: "f", from: "m2", to: "m3" }),
    ]);
    // …and so is the bar, rather than dangling and being dropped.
    expect(t.activations).toEqual([
      expect.objectContaining({ id: "act", from: "m2", to: "m3" }),
    ]);
  });

  it("dragging the loop's first row to the bottom takes it OUT of the loop", async () => {
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={framed} onChange={onChange} />);

    const label = await labelOf("one");
    fireEvent.pointerDown(label, { pointerId: 1, button: 0, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 300, clientY: 9000 });
    fireEvent.pointerUp(label, { pointerId: 1 });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const t = last(onChange);
    expect(t.messages.at(-1)!.id).toBe("m1");
    // The frame kept the rows it framed — it did not stretch down after the
    // message and swallow the rest of the diagram.
    expect(t.fragments![0]).toEqual(expect.objectContaining({ from: "m2", to: "m3" }));
  });
});

// ── 5. Branch dividers ──────────────────────────────────────────────────────

describe("dragging a branch divider onto an occupied row", () => {
  it("lands on the nearest free row instead of deleting that branch", async () => {
    const onChange = vi.fn();
    const doc = validateSequence({
      participants: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      messages: [
        { id: "m1", from: "a", to: "b", label: "one" },
        { id: "m2", from: "b", to: "a", label: "two" },
        { id: "m3", from: "a", to: "b", label: "three" },
        { id: "m4", from: "b", to: "a", label: "four" },
      ],
      fragments: [
        {
          id: "f",
          kind: "alt",
          label: "g",
          from: "m1",
          to: "m4",
          elses: [
            { label: "second", at: "m2" },
            { label: "third", at: "m4" },
          ],
        },
      ],
    });
    const { container } = mount(<SequenceStudio defaultValue={doc} onChange={onChange} />);

    // Drag the FIRST divider far down, onto the row the second one holds.
    const divider = container.querySelectorAll(".as-seq-frag__else")[0] as HTMLElement;
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 200, clientY: 5000 });
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 200, clientY: 5000 });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // Both branches survive: the dragged one stopped one row short.
    expect(last(onChange).fragments![0].elses).toEqual([
      { label: "second", at: "m3" },
      { label: "third", at: "m4" },
    ]);
  });
});

// ── 6. Fragments that cannot be exported ────────────────────────────────────

describe("fragments that no renderer could parse", () => {
  it("refuses a span that crosses an existing frame", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const doc = validateSequence({
      participants: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      messages: [
        { id: "m1", from: "a", to: "b", label: "one" },
        { id: "m2", from: "b", to: "a", label: "two" },
        { id: "m3", from: "a", to: "b", label: "three" },
        { id: "m4", from: "b", to: "a", label: "four" },
      ],
      fragments: [{ id: "f", kind: "opt", label: "g", from: "m1", to: "m2" }],
    });
    mount(<SequenceStudio defaultValue={doc} onChange={onChange} />);

    press(await labelOf("two"));
    press(await labelOf("three"), { shiftKey: true });
    await user.click(screen.getByRole("button", { name: "Insert ▾" }));
    await user.click(screen.getByRole("menuitem", { name: /Fragment around selection/ }));

    expect(await screen.findByText(/crosses the opt fragment/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still allows a properly nested one", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={framed} onChange={onChange} />);

    press(await labelOf("two"));
    await user.click(screen.getByRole("button", { name: "Insert ▾" }));
    await user.click(screen.getByRole("menuitem", { name: /Fragment around selection/ }));

    await waitFor(() => expect(last(onChange).fragments).toHaveLength(2));
  });

  it("offers + branch only on the kinds that can hold one", async () => {
    const user = userEvent.setup();
    const { container } = mount(<SequenceStudio defaultValue={framed} onChange={vi.fn()} />);

    fireEvent.click(container.querySelector(".as-seq-frag__tab") as HTMLElement);
    // The frame is a `loop`: Mermaid takes no divider inside one.
    expect(await screen.findByLabelText("Fragment kind")).toHaveValue("loop");
    expect(screen.queryByRole("button", { name: "+ branch" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Fragment kind"), "alt");
    expect(await screen.findByRole("button", { name: "+ branch" })).toBeInTheDocument();
  });
});

// ── 6 + 7. What the text exporters emit ─────────────────────────────────────

describe("the text exporters", () => {
  const par = validateSequence({
    participants: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    messages: [
      { id: "m1", from: "a", to: "b", label: "one", style: "async" },
      { id: "m2", from: "b", to: "a", label: "two" },
    ],
    fragments: [
      { id: "f", kind: "par", label: "both", from: "m1", to: "m2", elses: [{ label: "and two", at: "m2" }] },
    ],
  });

  it("splits a par with `and`, not `else`", () => {
    const out = renderSequenceToMermaid(par);
    expect(out).toContain("  par both");
    expect(out).toContain("  and and two");
    expect(out).not.toContain("else");
  });

  it("draws async dashed, agreeing with the canvas", () => {
    // `-)` is Mermaid's SOLID open arrow; the dashed one is `--)`.
    expect(renderSequenceToMermaid(par)).toContain("a--)b: one");
    // PlantUML's `->>` is likewise solid; `-->>` is the dashed open arrow.
    expect(renderSequenceToPlantUml(par)).toContain("a -->> b : one");
  });

  it("drops a divider from a kind that cannot express one", () => {
    const loop = validateSequence({
      ...par,
      fragments: [{ ...par.fragments![0], kind: "loop" }],
    });
    expect(renderSequenceToMermaid(loop)).not.toContain("and two");
    expect(renderSequenceToPlantUml(loop)).not.toContain("and two");
  });
});

// ── 9. Branch labels ────────────────────────────────────────────────────────

describe("branch guards", () => {
  const branched = validateSequence({
    participants: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    messages: [
      { id: "m1", from: "a", to: "b", label: "one" },
      { id: "m2", from: "b", to: "a", label: "two" },
      { id: "m3", from: "a", to: "b", label: "three" },
    ],
    fragments: [
      {
        id: "f",
        kind: "alt",
        label: "valid",
        from: "m1",
        to: "m3",
        elses: [
          { label: "second", at: "m2" },
          { label: "third", at: "m3" },
        ],
      },
    ],
  });

  it("can be renamed", async () => {
    const onChange = vi.fn();
    const { container } = mount(<SequenceStudio defaultValue={branched} onChange={onChange} />);

    fireEvent.click(container.querySelector(".as-seq-frag__tab") as HTMLElement);
    fireEvent.change(await screen.findByLabelText("Branch 1 guard"), {
      target: { value: "card declined" },
    });

    await waitFor(() =>
      expect(last(onChange).fragments![0].elses![0].label).toBe("card declined"),
    );
  });

  it("can be removed one at a time, not just from the end", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(<SequenceStudio defaultValue={branched} onChange={onChange} />);

    fireEvent.click(container.querySelector(".as-seq-frag__tab") as HTMLElement);
    await user.click(await screen.findByRole("button", { name: "Remove branch 1" }));

    await waitFor(() =>
      expect(last(onChange).fragments![0].elses).toEqual([{ label: "third", at: "m3" }]),
    );
  });
});

// ── 10. Message endpoints ───────────────────────────────────────────────────

describe("a message's endpoints", () => {
  it("can be re-pointed at another participant", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    press(await labelOf(/1\. Place order/));
    await user.selectOptions(await screen.findByLabelText("Message to"), "api");

    await waitFor(() =>
      expect(last(onChange).messages.find((m) => m.id === "m1")!.to).toBe("api"),
    );
  });

  it("can leave the system entirely — a lost message", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    press(await labelOf(/1\. Place order/));
    await user.selectOptions(await screen.findByLabelText("Message to"), "");

    await waitFor(() =>
      expect(last(onChange).messages.find((m) => m.id === "m1")!.to).toBeNull(),
    );
    // Both ends in the environment is not a message, so the other side's
    // option is closed off rather than silently dropping the row.
    const from = screen.getByLabelText("Message from") as HTMLSelectElement;
    const env = [...from.options].find((o) => o.value === "")!;
    expect(env.disabled).toBe(true);
  });
});

// ── 11. Insert ▸ Message ────────────────────────────────────────────────────

describe("Insert ▸ Message", () => {
  it("uses the two selected participants", async () => {
    const onChange = vi.fn();
    const { container } = mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    const strips = container.querySelectorAll(".as-seq-lifeline__hit");
    press(strips[0] as HTMLElement);
    press(strips[4] as HTMLElement, { shiftKey: true });
    await waitFor(() => expect(screen.queryByLabelText("Message label")).toBeNull());

    fireEvent.keyDown(window, { key: "m" });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const added = last(onChange).messages.find((m) => !example.messages.some((o) => o.id === m.id))!;
    expect([added.from, added.to]).toEqual(["user", "pay"]);
  });

  it("inserts after the selected message and selects the new one", async () => {
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    press(await labelOf(/1\. Place order/));
    fireEvent.keyDown(window, { key: "m" });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const t = last(onChange);
    // Row 2, right under the step being looked at — not row 10.
    expect(t.messages[1].label).toBe("message");
    expect([t.messages[1].from, t.messages[1].to]).toEqual(["user", "web"]);
    // …and the inspector is already on it.
    await waitFor(() => expect(screen.getByLabelText("Message label")).toHaveValue("message"));
  });
});

// ── 15 + 16 + 17 + 18. Chrome ───────────────────────────────────────────────

describe("read-only mode", () => {
  it("does not advertise editing gestures", () => {
    const { container } = mount(<SequenceStudio defaultValue={example} readOnly />);
    expect(container.querySelector(".as-hint")).toBeNull();
  });

  it("still shows them when editing is on", () => {
    const { container } = mount(<SequenceStudio defaultValue={example} />);
    expect(container.querySelector(".as-hint")).not.toBeNull();
  });
});

describe("Escape", () => {
  it("closes the AI panel, as the shortcuts sheet promises", async () => {
    const user = userEvent.setup();
    mount(<SequenceStudio defaultValue={example} generate={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /AI/ }));
    expect(screen.getByPlaceholderText(/Describe the sequence/)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Describe the sequence/)).not.toBeInTheDocument(),
    );
  });
});

describe("a model reply that was cut off", () => {
  it("says so instead of applying the missing steps as deletions", async () => {
    const user = userEvent.setup();
    const generate = vi
      .fn()
      .mockResolvedValue(
        '{"version":1,"participants":[{"id":"a","label":"A","kind":"service"},' +
          '{"id":"b","label":"B","kind":"service"}],"messages":[{"id":"m1","from":"a","to' ,
      );
    mount(<SequenceStudio defaultValue={example} generate={generate} />);

    await user.click(screen.getByRole("button", { name: /AI/ }));
    await user.type(screen.getByPlaceholderText(/Describe the sequence/), "a flow");
    await user.click(screen.getByRole("button", { name: "Generate sequence" }));

    expect(await screen.findByText(/cut off, so anything after/)).toBeInTheDocument();
  });
});

describe("View ▾", () => {
  it("points at the keyboard shortcuts sheet", async () => {
    const user = userEvent.setup();
    mount(<SequenceStudio defaultValue={example} />);

    await user.click(screen.getByRole("button", { name: /^View/ }));
    await user.click(screen.getByRole("menuitem", { name: /Keyboard shortcuts/ }));

    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });
});

describe("⌘D", () => {
  it("duplicates the selected message directly under it", async () => {
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={framed} onChange={onChange} />);

    press(await labelOf("two"));
    fireEvent.keyDown(window, { key: "d", metaKey: true });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const t = last(onChange);
    expect(t.messages).toHaveLength(5);
    expect(t.messages.map((m) => m.label)).toEqual(["one", "two", "two", "three", "four"]);
  });

  it("duplicates a selected participant into the next column", async () => {
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={framed} onChange={onChange} />);

    fireEvent.click(screen.getByText("A"));
    fireEvent.keyDown(window, { key: "d", metaKey: true });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(last(onChange).participants.map((p) => p.label)).toEqual(["A", "A copy", "B"]);
  });
});

// ── 8 + 12. Drops on the canvas ─────────────────────────────────────────────
//
// React Flow drives node drags through d3-drag: mousedown on the node, then
// mousemove/mouseup on the window. The viewport transform is read back so the
// client coordinates aim where fitView actually put things.

function flowToClient(container: HTMLElement) {
  const viewport = container.querySelector(".react-flow__viewport") as HTMLElement;
  const m = viewport.style.transform.match(
    /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/,
  );
  const [tx, ty, k] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1];
  return (x: number, y: number) => ({ clientX: x * k + tx, clientY: y * k + ty });
}

/** Wait until fitView has stopped moving, then map flow → client. */
async function settled(container: HTMLElement) {
  let prev = "";
  await waitFor(() => {
    const t = (container.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
    expect(t).toMatch(/scale/);
    if (t !== prev) {
      prev = t;
      throw new Error("viewport still animating");
    }
  });
  return flowToClient(container);
}

async function dragNode(
  container: HTMLElement,
  testId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const client = await settled(container);
  const node = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
  // React Flow starts the drag on the first move past its own 1px threshold
  // and measures the grab offset THERE, so the press is only a warm-up: the
  // node travels `to - from`, not `to - press`.
  fireEvent.mouseDown(node, { button: 0, ...client(from.x - 24, from.y) });
  fireEvent.mouseMove(document, { ...client(from.x, from.y) });
  fireEvent.mouseMove(document, { ...client(to.x, to.y) });
  fireEvent.mouseUp(document, { ...client(to.x, to.y) });
}

describe("dropping a note on another lifeline", () => {
  const noted = validateSequence({
    participants: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
    messages: [
      { id: "m1", from: "a", to: "b", label: "one" },
      { id: "m2", from: "b", to: "c", label: "two" },
    ],
    notes: [{ id: "n1", text: "hello", side: "right", participant: "a", at: "m1" }],
  });

  it("re-anchors it to the column it landed on", async () => {
    const onChange = vi.fn();
    const { container } = mount(<SequenceStudio defaultValue={noted} onChange={onChange} />);

    // Column c's lifeline is at 60 + 2*200 + 80 = 540; land the card's left
    // edge just right of it so its centre reads as "right of c".
    await dragNode(container, "rf__node-note:n1", { x: 180, y: 180 }, { x: 560, y: 180 });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const note = last(onChange).notes![0] as SeqNote;
    expect(note.participant).toBe("c");
  });

  it("dropped above the first row it floats free again", async () => {
    const onChange = vi.fn();
    const { container } = mount(<SequenceStudio defaultValue={noted} onChange={onChange} />);

    await dragNode(container, "rf__node-note:n1", { x: 180, y: 180 }, { x: 180, y: 60 });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(last(onChange).notes![0].at).toBeUndefined();
  });
});

describe("dragging a participant header", () => {
  it("swaps past the halfway point, not a whole column", async () => {
    const onChange = vi.fn();
    const three = validateSequence({
      participants: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      messages: [{ id: "m1", from: "a", to: "b", label: "one" }],
    });
    const { container } = mount(<SequenceStudio defaultValue={three} onChange={onChange} />);

    // A is at x = 60, B at 260. 150px right of A is past the halfway point.
    await dragNode(container, "rf__node-a", { x: 100, y: 20 }, { x: 250, y: 20 });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(last(onChange).participants.map((p) => p.id)).toEqual(["b", "a", "c"]);
  });
});
