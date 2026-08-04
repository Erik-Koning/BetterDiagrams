/**
 * @vitest-environment jsdom
 *
 * SequenceStudio component tests. The first test is the design's load-bearing
 * spike: participants must render edges (incl. a self-edge) through custom
 * geometry in jsdom. Gesture assertions are written transform-independent —
 * "far down is later" — so fitView's viewport can't break them.
 */
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SequenceStudio } from "./SequenceStudio";
import {
  EXAMPLE_SEQUENCE,
  validateSequence,
  type SequenceTemplate,
} from "../../contract/sequence";

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1400px; height: 900px",
    }),
  });
}

const example = validateSequence(EXAMPLE_SEQUENCE);

describe("SequenceStudio", () => {
  it("renders participants, messages, self-messages, fragments, and notes", async () => {
    const { container } = mount(<SequenceStudio defaultValue={example} />);

    expect(screen.getByText("Customer")).toBeInTheDocument();
    expect(screen.getByText("Payment Gateway")).toBeInTheDocument();

    // Every message renders a path — including the self-message (the RF
    // self-edge assumption this whole design leans on).
    await waitFor(() =>
      expect(container.querySelectorAll(".as-seq-msg__line").length).toBe(
        example.messages.length,
      ),
    );
    // Autonumbered labels from meta.autonumber.
    expect(screen.getByText(/1\. Place order/)).toBeInTheDocument();
    expect(screen.getByText(/3\. Validate cart/)).toBeInTheDocument();

    // Fragments and their operators.
    expect(screen.getByText("loop")).toBeInTheDocument();
    expect(screen.getByText("alt")).toBeInTheDocument();
    expect(screen.getByText("[card valid]")).toBeInTheDocument();
    // Activation bars.
    expect(container.querySelectorAll(".as-seq-bar").length).toBe(3);
    // The note.
    expect(screen.getByText("Idempotent by order id")).toBeInTheDocument();
  });

  it("adds a participant from the Insert menu", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Insert ▾" }));
    await user.click(screen.getByRole("menuitem", { name: /^Participant / }));

    const latest = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
    expect(latest.participants).toHaveLength(example.participants.length + 1);
    expect(latest.participants.at(-1)!.label).toBe("New Participant");
  });

  it("press-drag on a lifeline creates an activation bar anchored to rows", async () => {
    const onChange = vi.fn();
    const { container } = mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    const strips = container.querySelectorAll(".as-seq-lifeline__hit");
    expect(strips.length).toBe(example.participants.length);
    const strip = strips[0] as HTMLElement;

    fireEvent.pointerDown(strip, { pointerId: 1, clientX: 140, clientY: 200 });
    fireEvent.pointerMove(strip, { pointerId: 1, clientX: 140, clientY: 320 });
    fireEvent.pointerUp(strip, { pointerId: 1 });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const latest = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
    expect(latest.activations!.length).toBe(example.activations!.length + 1);
    const added = latest.activations!.find(
      (a) => !example.activations!.some((o) => o.id === a.id),
    )!;
    // Anchored to real message ids, in order.
    const idx = new Map(latest.messages.map((m, i) => [m.id, i]));
    expect(idx.has(added.from)).toBe(true);
    expect(added.to === undefined || idx.get(added.to)! >= idx.get(added.from)!).toBe(true);
  });

  it("refuses a bar when the diagram has no messages yet", async () => {
    const onChange = vi.fn();
    const { container } = mount(
      <SequenceStudio
        defaultValue={validateSequence({ participants: [{ id: "a", label: "A" }], messages: [] })}
        onChange={onChange}
      />,
    );
    const strip = container.querySelector(".as-seq-lifeline__hit") as HTMLElement;
    fireEvent.pointerDown(strip, { pointerId: 1, clientX: 140, clientY: 220 });
    fireEvent.pointerUp(strip, { pointerId: 1 });

    expect(await screen.findByText(/Add a message first/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("dragging a message label far down moves it to the end of time", async () => {
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    const label = (await screen.findByText(/1\. Place order/)).closest(
      ".as-seq-msg__label",
    ) as HTMLElement;
    fireEvent.pointerDown(label, { pointerId: 1, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 300, clientY: 9000 });
    fireEvent.pointerUp(label, { pointerId: 1 });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const latest = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
    expect(latest.messages.at(-1)!.id).toBe("m1");
    // Everything renormalized: same set, new order.
    expect(latest.messages).toHaveLength(example.messages.length);
  });

  it("undo restores the original message order", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    const label = (await screen.findByText(/1\. Place order/)).closest(
      ".as-seq-msg__label",
    ) as HTMLElement;
    fireEvent.pointerDown(label, { pointerId: 1, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 300, clientY: 9000 });
    fireEvent.pointerUp(label, { pointerId: 1 });
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Undo" }));
    const latest = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
    expect(latest.messages.map((m) => m.id)).toEqual(example.messages.map((m) => m.id));
  });

  it("edits a message from the inspector and swaps its direction", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    // Select the first message via its interaction path (edges materialize
    // after the measurement pass, so wait for them).
    await waitFor(() => expect(container.querySelector(".react-flow__edge")).not.toBeNull());
    fireEvent.click(container.querySelector(".react-flow__edge") as HTMLElement);

    await user.selectOptions(await screen.findByLabelText("Message style"), "async");
    let latest = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
    const edited = latest.messages.find((m) => m.style === "async" && m.id === "m1");
    expect(edited).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Swap message direction" }));
    latest = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
    const swapped = latest.messages.find((m) => m.id === "m1")!;
    expect(swapped.from).toBe("web");
    expect(swapped.to).toBe("user");
  });

  it("deletes a participant and cascades its messages", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    fireEvent.click(screen.getByText("Orders DB"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    const latest = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
    expect(latest.participants.find((p) => p.id === "db")).toBeUndefined();
    // Messages touching db are gone; the db activation cascaded with them.
    expect(latest.messages.some((m) => m.from === "db" || m.to === "db")).toBe(false);
    expect(latest.activations?.some((a) => a.participant === "db")).toBeFalsy();
  });

  it("reports the canvas selection to the host in document terms", async () => {
    const onSelectionChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onSelectionChange={onSelectionChange} />);

    // The mount itself reports (an empty selection), so a host that remounts
    // the editor per file never keeps the previous document's selection.
    expect(onSelectionChange).toHaveBeenCalledWith({
      participants: [],
      messages: [],
      activations: [],
      fragments: [],
      notes: [],
    });

    fireEvent.click(screen.getByText("Orders DB"));
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        participants: ["db"],
        messages: [],
        activations: [],
        fragments: [],
        notes: [],
      }),
    );

    // A note buckets under `notes` with its DOCUMENT id — no canvas prefix.
    fireEvent.click(screen.getByText("Idempotent by order id"));
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        participants: [],
        messages: [],
        activations: [],
        fragments: [],
        notes: ["n1"],
      }),
    );
  });

  it("toggles autonumber from the View menu", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /^View/ }));
    await user.click(screen.getByRole("checkbox", { name: "Autonumber messages" }));

    const latest = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
    expect("autonumber" in (latest.meta ?? {})).toBe(false);
    expect(screen.queryByText(/1\. Place order/)).not.toBeInTheDocument();
    expect(screen.getByText("Place order")).toBeInTheDocument();
  });

  it("renders the version tag chip from meta", () => {
    mount(
      <SequenceStudio
        defaultValue={validateSequence({ ...example, meta: { ...example.meta, versionTag: "v7" } })}
      />,
    );
    expect(screen.getByRole("button", { name: "v7" })).toBeInTheDocument();
  });

  it("survives StrictMode + controlled mode without spurious commits", async () => {
    const user = userEvent.setup();
    const seen: SequenceTemplate[] = [];
    function Host() {
      const [doc, setDoc] = useState(example);
      return (
        <SequenceStudio
          value={doc}
          onChange={(next) => {
            seen.push(next);
            setDoc(next);
          }}
        />
      );
    }
    mount(
      <StrictMode>
        <Host />
      </StrictMode>,
    );
    // Mounting alone commits nothing.
    expect(seen).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Insert ▾" }));
    await user.click(screen.getByRole("menuitem", { name: /^Actor / }));

    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.at(-1)!.participants).toHaveLength(example.participants.length + 1);
    // The echoed value round-trip must not have reset or re-committed.
    const after = seen.length;
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.length).toBe(after);
  });

  it("drags a fragment branch divider to another row", async () => {
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
        { id: "f", kind: "alt", label: "g", from: "m1", to: "m4", elses: [{ label: "b1", at: "m2" }] },
      ],
    });
    const { container } = mount(<SequenceStudio defaultValue={doc} onChange={onChange} />);

    const divider = container.querySelector(".as-seq-frag__else") as HTMLElement;
    expect(divider).toBeTruthy();
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 200, clientY: 5000 });
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 200, clientY: 5000 });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const latest = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
    // Far down clamps to the span's last row.
    expect(latest.fragments![0].elses).toEqual([{ label: "b1", at: "m4" }]);
  });

  it("generates a sequence from the AI panel's context box", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const generated = {
      version: 1,
      participants: [{ id: "x", label: "Generated Svc", kind: "service" }],
      messages: [],
    };
    const generate = vi.fn().mockResolvedValue(JSON.stringify(generated));
    mount(<SequenceStudio defaultValue={example} onChange={onChange} generate={generate} />);

    await user.click(screen.getByRole("button", { name: /AI/ }));
    await user.type(
      screen.getByPlaceholderText(/Describe the sequence/),
      "checkout flow: user pays, api charges, db records",
    );
    await user.click(screen.getByRole("button", { name: "Generate sequence" }));

    await waitFor(() => expect(screen.getByText("Generated Svc")).toBeInTheDocument());
    // The request carried the user's flow context and the sequence contract.
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "create",
        input: "checkout flow: user pays, api charges, db records",
        systemPrompt: expect.stringContaining("SEQUENCE DIAGRAM"),
      }),
      expect.anything(),
    );
    const latest = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
    expect(latest.participants[0].label).toBe("Generated Svc");
  });

  it("omits the AI panel entirely without a generator", () => {
    mount(<SequenceStudio defaultValue={example} />);
    expect(screen.queryByRole("button", { name: /AI/ })).not.toBeInTheDocument();
  });

  it("renders the file selector and selects in the sequence editor too", async () => {
    const user = userEvent.setup();
    const onFileSelect = vi.fn();
    mount(
      <SequenceStudio
        defaultValue={example}
        files={[
          { id: "s1", name: "Order flow", kind: "seq" },
          { id: "s2", name: "Refunds", kind: "seq" },
        ]}
        activeFileId="s1"
        onFileSelect={onFileSelect}
      />,
    );

    expect(screen.queryByText("seq·studio")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Order flow ▾" }));
    await user.click(screen.getByRole("menuitem", { name: /Refunds/ }));
    expect(onFileSelect).toHaveBeenCalledWith("s2");
  });

  it("renaming the active file writes the document's meta.title", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(
      <SequenceStudio
        defaultValue={example}
        onChange={onChange}
        files={[{ id: "s1", name: "Order flow", kind: "seq" }]}
        activeFileId="s1"
        onFileRename={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Order flow ▾" }));
    await user.click(screen.getByRole("button", { name: "Rename Order flow" }));
    const input = screen.getByLabelText("File name");
    await user.clear(input);
    await user.type(input, "Checkout{Enter}");

    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
      expect(last.meta?.title).toBe("Checkout");
    });
  });

  it("confirms before deleting a non-empty file here too", async () => {
    const user = userEvent.setup();
    const onFileDelete = vi.fn();
    mount(
      <SequenceStudio
        defaultValue={example}
        files={[
          { id: "s1", name: "Order flow", kind: "seq" },
          { id: "s2", name: "Refunds", kind: "seq" },
        ]}
        activeFileId="s1"
        onFileDelete={onFileDelete}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Order flow ▾" }));
    await user.click(screen.getByRole("button", { name: "Delete Refunds" }));
    await user.click(screen.getByRole("button", { name: "Delete file" }));
    expect(onFileDelete).toHaveBeenCalledWith("s2");
  });

  it("hides editing affordances in readOnly mode", () => {
    const { container } = mount(<SequenceStudio defaultValue={example} readOnly />);
    expect(screen.queryByRole("button", { name: "Insert ▾" })).not.toBeInTheDocument();
    expect(container.querySelector(".as-seq-lifeline__hit")).toBeNull();
    // Export stays available.
    expect(screen.getByRole("button", { name: "Export ▾" })).toBeInTheDocument();
  });

  it("still draws the messages when editing is disabled", async () => {
    const { container } = mount(<SequenceStudio defaultValue={example} readOnly />);
    // Read-only hides the connect affordance; it must not unmount the handles,
    // because React Flow positions every edge from their measured bounds.
    await waitFor(() =>
      expect(container.querySelectorAll(".as-seq-msg__line")).toHaveLength(
        example.messages.length,
      ),
    );
  });

  // ── Timeline mode ─────────────────────────────────────────────────────────
  // The API arrives in March, the ledger in June — two stops, so there is a
  // "before" the scrubber can actually show.
  const phased = validateSequence({
    version: 1,
    meta: { title: "Phased flow" },
    participants: [
      { id: "u", label: "Customer", kind: "actor" },
      { id: "api", label: "Order API", kind: "service", date: "2026-03-02" },
      { id: "led", label: "Ledger", kind: "database", date: "2026-06-15" },
    ],
    messages: [
      { id: "m1", from: "u", to: "api", label: "Place order", style: "sync" },
      { id: "m2", from: "api", to: "led", label: "Post entry", style: "sync" },
      { id: "m3", from: "api", to: "u", label: "Receipt", style: "reply" },
    ],
  });

  it("renders a participant's date as a chip and offers the timeline", () => {
    mount(<SequenceStudio defaultValue={phased} />);
    expect(screen.getByText(/^Jun 15/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Timeline/ })).toBeInTheDocument();
  });

  it("has no timeline control when nothing is dated", () => {
    mount(<SequenceStudio defaultValue={example} />);
    expect(screen.queryByRole("button", { name: /Timeline/ })).not.toBeInTheDocument();
  });

  it("drops a later participant and the messages that need it, then restores them", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(<SequenceStudio defaultValue={phased} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Timeline/ }));
    await user.click(screen.getByRole("button", { name: "Hide later" }));
    // Walk back to the first dated point — deterministic however the real
    // date moves, since the cursor opens on today inside the plan's span.
    for (let guard = 0; guard < 20; guard++) {
      const back = screen.getByRole("button", { name: "Previous dated point" });
      if ((back as HTMLButtonElement).disabled) break;
      await user.click(back);
    }

    // March: the API exists, the ledger does not.
    await waitFor(() => expect(screen.queryByText("Ledger")).not.toBeInTheDocument());
    expect(screen.getByText("Customer")).toBeInTheDocument();
    expect(screen.getByText("Order API")).toBeInTheDocument();
    // Time is array order, so the remaining flow really is a two-row diagram.
    // Edges appear only once React Flow has measured the new instance's nodes.
    await waitFor(() =>
      expect(container.querySelectorAll(".as-seq-msg__line")).toHaveLength(2),
    );

    await user.click(screen.getByRole("button", { name: "Exit timeline" }));
    await waitFor(() => expect(screen.getByText("Ledger")).toBeInTheDocument());
    // Scrubbing is a view — it must never commit.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stamps the cursor onto inserts and keeps hidden steps through the commit", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={phased} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Timeline/ }));
    await user.click(screen.getByRole("button", { name: "Hide later" }));
    for (let guard = 0; guard < 20; guard++) {
      const back = screen.getByRole("button", { name: "Previous dated point" });
      if ((back as HTMLButtonElement).disabled) break;
      await user.click(back);
    }
    await waitFor(() => expect(screen.queryByText("Ledger")).not.toBeInTheDocument());

    // Editing stays live while scrubbing — and the commit it causes must not
    // destroy the hidden June participant or its messages.
    await user.click(screen.getByRole("button", { name: "Insert ▾" }));
    await user.click(screen.getByRole("menuitem", { name: /Participant/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
    expect(last.participants.some((p) => p.id === "led")).toBe(true);
    expect(last.messages).toHaveLength(phased.messages.length);
    // The insert inherits the cursor — the first stop, March.
    const added = last.participants.find(
      (p) => !phased.participants.some((d) => d.id === p.id),
    );
    expect(added?.date).toBe("2026-03-02");
  });

  it("sets a participant's date from the inspector", async () => {
    const onChange = vi.fn();
    mount(<SequenceStudio defaultValue={example} onChange={onChange} />);

    fireEvent.click(screen.getByText("Order API"));
    const field = await screen.findByLabelText("Participant date");
    fireEvent.change(field, { target: { value: "2026-06-15" } });

    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)![0] as SequenceTemplate;
      expect(last.participants.find((p) => p.id === "api")?.date).toBe("2026-06-15");
    });
  });
});

describe("SequenceStudio welcome modal", () => {
  it("shows over a brand-new sequence and dismisses via the manual CTA", async () => {
    const user = userEvent.setup();
    mount(<SequenceStudio defaultValue={{ version: 1, participants: [], messages: [] }} />);
    expect(screen.getByRole("dialog", { name: "Get started" })).toBeInTheDocument();
    expect(screen.getByText("BetterDiagrams")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Insert Node Manually/ }));
    expect(screen.queryByRole("dialog", { name: "Get started" })).not.toBeInTheDocument();
  });

  it("does not show over a sequence with content", () => {
    mount(<SequenceStudio defaultValue={example} />);
    expect(screen.queryByRole("dialog", { name: "Get started" })).not.toBeInTheDocument();
  });
});

describe("multi-state export modal", () => {
  const dated = validateSequence({
    version: 1,
    participants: [
      { id: "u", label: "User", kind: "actor" },
      { id: "api", label: "API", kind: "service" },
    ],
    messages: [
      { id: "m1", from: "u", to: "api", label: "call", style: "sync", date: "2026-03-01" },
      { id: "m2", from: "api", to: "u", label: "reply", style: "reply", date: "2026-09-30" },
    ],
    activations: [],
    fragments: [],
    notes: [],
  });

  it("dated sequences get the modal with only a Dates axis", async () => {
    const user = userEvent.setup();
    mount(<SequenceStudio defaultValue={dated} />);

    await user.click(screen.getByRole("button", { name: "Export ▾" }));
    await user.click(screen.getByRole("menuitem", { name: /SVG vector/ }));
    const dialog = screen.getByRole("dialog", { name: "Export SVG" });
    // No zone axes in a sequence — the one fieldset is the dates.
    expect(within(dialog).getAllByRole("group")).toHaveLength(1);
    expect(within(dialog).getByRole("group", { name: "Dates" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("radio", { name: /All states/ }));
    expect(within(dialog).getByText("2 files → sequence-states.zip")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Export" }));
    await screen.findByText("Exported 2 states → sequence-states.zip");
  });

  it("undated sequences export immediately, no modal", async () => {
    const user = userEvent.setup();
    mount(<SequenceStudio defaultValue={example} />);

    await user.click(screen.getByRole("button", { name: "Export ▾" }));
    await user.click(screen.getByRole("menuitem", { name: /SVG vector/ }));
    expect(screen.queryByRole("dialog", { name: "Export SVG" })).not.toBeInTheDocument();
    await screen.findByText("Exported sequence.svg");
  });
});
