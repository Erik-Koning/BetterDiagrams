/**
 * @vitest-environment jsdom
 *
 * Regression tests for the editor-level audit fixes.
 *
 * Each case is written as the action that hit the bug — a delete that left
 * the canvas and the document disagreeing, a ⌘Z that ate one character, a
 * ⌘S the browser took. Grouped by what the user was doing, not by the
 * function that changed.
 */
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArchitectureStudio } from "./ArchitectureStudio";
import { clearWelcomeSuppression } from "./WelcomeModal";

// Same stub as ArchitectureStudio.test.tsx: typing into a real CodeMirror
// EditorView is unreliable in jsdom, and JsonCodeEditor has its own tests.
vi.mock("./JsonCodeEditor", () => ({
  JsonCodeEditor: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (text: string) => void;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel ?? "Diagram JSON"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

import { validateTemplate, type DiagramTemplate } from "../contract/schema";

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

/** `validateTemplate` fills in every default, so these fixtures stay terse. */
const doc = (partial: Record<string, unknown>): DiagramTemplate =>
  validateTemplate({ version: 1, nodes: [], edges: [], ...partial });

/** The last document the host was handed. */
const latest = (onChange: ReturnType<typeof vi.fn>): DiagramTemplate =>
  onChange.mock.calls.at(-1)![0] as DiagramTemplate;

const node = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;

beforeEach(() => clearWelcomeSuppression());

describe("deleting", () => {
  const FOLDED = doc({
    nodes: [
      { id: "vpc", label: "VPC", kind: "group", x: 0, y: 0, w: 400, h: 300, collapsed: true },
      { id: "api", label: "API", kind: "service", parentId: "vpc", x: 20, y: 40 },
      { id: "wrk", label: "Worker", kind: "service", parentId: "vpc", x: 20, y: 150 },
      { id: "out", label: "Outside", kind: "service", x: 600, y: 40 },
    ],
    edges: [{ id: "e", source: "out", target: "api" }],
  });

  it("takes a collapsed group's hidden contents with it", async () => {
    const onChange = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={FOLDED} onChange={onChange} />);

    fireEvent.click(node(container, "vpc"));
    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // The document loses the frame AND its contents…
    expect(latest(onChange).nodes.map((n) => n.id)).toEqual(["out"]);
    // …and so does the canvas. They used to disagree: the children came back
    // as root nodes at coordinates that only meant something inside the box.
    await waitFor(() =>
      expect([...container.querySelectorAll(".react-flow__node")].map((n) => n.getAttribute("data-id"))).toEqual(
        ["out"],
      ),
    );
  });

  it("removes a zone's backdrop but keeps the nodes standing on it", async () => {
    const onChange = vi.fn();
    const ZONED = doc({
      zones: [
        { id: "z", label: "Region", providers: ["aws"], provider: "aws", x: 0, y: 0, w: 600, h: 400 },
      ],
      nodes: [{ id: "a", label: "A", kind: "service", zoneId: "z", x: 40, y: 60 }],
    });
    const { container } = mount(<ArchitectureStudio defaultValue={ZONED} onChange={onChange} />);

    fireEvent.click(node(container, "zone:z"));
    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => expect(latest(onChange).zones ?? []).toHaveLength(0));
    // Membership is a reference, not containment — the node stays, un-zoned.
    expect(latest(onChange).nodes.map((n) => n.id)).toEqual(["a"]);
    expect(latest(onChange).nodes[0]!.zoneId).toBeNull();
  });

  it("undoes in ONE press after select-all", async () => {
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={FOLDED} onChange={onChange} />);

    fireEvent.keyDown(window, { key: "a", metaKey: true });
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(latest(onChange).nodes).toHaveLength(0));

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    // One press, everything back. It used to take two, and the first looked
    // like undo doing nothing at all.
    await waitFor(() => expect(latest(onChange).nodes).toHaveLength(FOLDED.nodes.length));
  });
});

describe("editing a label in the inspector", () => {
  const ONE = doc({ nodes: [{ id: "api", label: "API", kind: "service", x: 0, y: 0 }] });

  it("undoes the whole run of typing, not one character at a time", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={ONE} onChange={onChange} />);

    fireEvent.click(node(container, "api"));
    const field = await screen.findByLabelText("Node label");
    await user.type(field, "XYZ");
    await waitFor(() => expect(latest(onChange).nodes[0]!.label).toBe("APIXYZ"));

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(latest(onChange).nodes[0]!.label).toBe("API"));
  });

  it("keeps the node selected through undo, so the inspector stays open", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={ONE} />);

    fireEvent.click(node(container, "api"));
    const field = await screen.findByLabelText("Node label");
    await user.type(field, "Q");

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(screen.queryByLabelText("Node label")).toBeInTheDocument());
  });
});

describe("the keyboard", () => {
  const ONE = doc({ nodes: [{ id: "api", label: "API", kind: "service", x: 0, y: 0 }] });

  it("saves with ⌘S while the cursor is in a field", async () => {
    const onSave = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={ONE} onSave={onSave} />);

    fireEvent.click(node(container, "api"));
    const field = await screen.findByLabelText("Node label");
    field.focus();
    fireEvent.keyDown(field, { key: "s", metaKey: true });

    // It used to stand down for any focused input and hand ⌘S to the
    // browser's Save-Page dialog — from the one field people type in most.
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });

  it("Escape drops the selection before it does anything else", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={ONE} />);

    fireEvent.click(node(container, "api"));
    expect(await screen.findByLabelText("Node label")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("Node label")).not.toBeInTheDocument());
  });

  it("dismissing a menu by clicking the canvas does not also act on it", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={ONE} />);

    // The whole gesture, the way the dismiss logic sees it: pointerdown and
    // mousedown are what close the menu, the click is what gets swallowed.
    // Native jsdom events rather than user-event's: user-event pins `view`
    // to null on its mouse events, and d3-drag (under React Flow's node
    // drag) dereferences `event.view.document` on mousedown — which the
    // test-setup shim can only supply for events that leave `view` alone.
    const clickNode = (el: HTMLElement) => {
      fireEvent.pointerDown(el);
      fireEvent.mouseDown(el);
      fireEvent.mouseUp(el);
      fireEvent.click(el);
    };

    await user.click(screen.getByRole("button", { name: "Export" }));
    clickNode(node(container, "api"));

    // The click that got rid of the menu is spent on getting rid of it.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Node label")).not.toBeInTheDocument();

    // A second, ordinary click selects as it always did.
    clickNode(node(container, "api"));
    expect(await screen.findByLabelText("Node label")).toBeInTheDocument();
  });

  it("opens the name for renaming on F2", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={ONE} />);

    fireEvent.click(node(container, "api"));
    fireEvent.keyDown(window, { key: "F2" });

    // Double-click is the drill gesture and stays that way, so rename needed
    // a key of its own.
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument());
  });
});

describe("the inspector", () => {
  const TWO = doc({
    nodes: [
      { id: "a", label: "A", kind: "service", x: 0, y: 0 },
      { id: "b", label: "B", kind: "service", x: 300, y: 0 },
    ],
    edges: [{ id: "e", source: "a", target: "b", label: "calls" }],
  });

  it("appears for a multi-selection, with the actions a single node has", async () => {
    mount(<ArchitectureStudio defaultValue={TWO} />);

    fireEvent.keyDown(window, { key: "a", metaKey: true });

    // Selecting more than one used to hide the bar entirely — taking Delete
    // and Duplicate with it, so a multi-selection had FEWER controls than one.
    await waitFor(() => expect(screen.getByText(/2 nodes/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Duplicate the selection" })).toBeInTheDocument();
  });

  it("offers a multi-selection every setting the elements share, and writes it to all", async () => {
    const onChange = vi.fn();
    const THREE = doc({
      nodes: [
        { id: "a", label: "A", kind: "service", x: 0, y: 0 },
        { id: "b", label: "B", kind: "service", x: 300, y: 0 },
        { id: "c", label: "C", kind: "database", x: 600, y: 0 },
      ],
      edges: [
        { id: "ab", source: "a", target: "b", label: "calls" },
        { id: "bc", source: "b", target: "c", label: "reads" },
      ],
    });
    mount(<ArchitectureStudio defaultValue={THREE} onChange={onChange} />);
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    // Nodes and connections together: the count is the tab strip, nodes first.
    await waitFor(() => expect(screen.getByRole("tab", { name: "3 nodes" })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "3 nodes" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByLabelText("Start anchor")).not.toBeInTheDocument();

    // The settings a single node has, minus the ones that name ONE node.
    expect(screen.queryByLabelText("Node label")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Node description")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Documentation link")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Text alignment"), { target: { value: "center" } });
    await waitFor(() =>
      expect(latest(onChange).nodes.map((n) => n.textAlign)).toEqual(["center", "center", "center"]),
    );
    // One write, one undo entry: ⌘Z clears all three at once.
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() =>
      expect(latest(onChange).nodes.map((n) => n.textAlign)).toEqual([undefined, undefined, undefined]),
    );

    // Likewise the connections: the side each end leaves from, the heads,
    // the routing — everything but the label and the step number.
    fireEvent.click(screen.getByRole("tab", { name: "2 connections" }));
    expect(screen.queryByLabelText("Text alignment")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Edge label")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Sequence number")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Start anchor"), { target: { value: "right" } });
    fireEvent.change(screen.getByLabelText("End anchor"), { target: { value: "left" } });
    fireEvent.change(screen.getByLabelText("Edge direction"), { target: { value: "both" } });
    await waitFor(() => {
      for (const e of latest(onChange).edges) {
        expect(e).toMatchObject({ start: { side: "right" }, end: { side: "left" }, direction: "both" });
      }
    });
  });

  it("clears every link a multi-selection carries in one step, and offers nothing when none has one", async () => {
    const onChange = vi.fn();
    const LINKED = doc({
      nodes: [
        { id: "a", label: "A", kind: "table", url: "/entities/a", x: 0, y: 0 },
        { id: "b", label: "B", kind: "table", url: "/entities/b", x: 300, y: 0 },
        { id: "c", label: "C", kind: "table", x: 600, y: 0 },
      ],
    });
    const { container } = mount(<ArchitectureStudio defaultValue={LINKED} onChange={onChange} />);
    expect(container.querySelectorAll(".as-node__link")).toHaveLength(2);

    fireEvent.keyDown(window, { key: "a", metaKey: true });
    // Still no input — a link names ONE place — but the selection can drop the ones it has.
    const clear = await screen.findByRole("button", { name: "Clear links (2)" });
    expect(screen.queryByLabelText("Documentation link")).not.toBeInTheDocument();
    fireEvent.click(clear);
    await waitFor(() => expect(latest(onChange).nodes.map((n) => n.url)).toEqual([undefined, undefined, undefined]));
    expect(container.querySelectorAll(".as-node__link")).toHaveLength(0);
    // Nothing left to clear: the section goes away rather than offering a no-op.
    expect(screen.queryByRole("button", { name: /^Clear link/ })).not.toBeInTheDocument();

    // One write, one undo entry.
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(latest(onChange).nodes.map((n) => n.url)).toEqual(["/entities/a", "/entities/b", undefined]));
  });

  it("shows Mixed where a multi-selection disagrees, until one value is set for all", async () => {
    const onChange = vi.fn();
    const MIXED = doc({
      nodes: [
        { id: "a", label: "A", kind: "service", status: "planned", tags: ["pci"], x: 0, y: 0 },
        { id: "b", label: "B", kind: "service", tags: ["pci", "gdpr"], x: 300, y: 0 },
      ],
    });
    mount(<ArchitectureStudio defaultValue={MIXED} onChange={onChange} />);
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    await waitFor(() => expect(screen.getByText(/2 nodes/)).toBeInTheDocument());

    const status = screen.getByLabelText("Lifecycle status") as HTMLSelectElement;
    expect(status.value).toBe("");
    expect(screen.getByRole("option", { name: "Mixed" })).toBeInTheDocument();
    fireEvent.change(status, { target: { value: "deprecated" } });
    await waitFor(() =>
      expect(latest(onChange).nodes.map((n) => n.status)).toEqual(["deprecated", "deprecated"]),
    );
    expect(screen.queryByRole("option", { name: "Mixed" })).not.toBeInTheDocument();

    // Tags: every tag anyone carries is offered; a chip is ON only when all
    // carry it. Toggling the shared one strips it everywhere; toggling the
    // partial one gives it to everyone.
    const chip = (tag: string) => screen.getByRole("button", { name: new RegExp(`^${tag}`) });
    expect(chip("pci")).toHaveAttribute("aria-pressed", "true");
    expect(chip("gdpr")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip("gdpr"));
    await waitFor(() => expect(latest(onChange).nodes.map((n) => n.tags)).toEqual([["pci", "gdpr"], ["pci", "gdpr"]]));
    fireEvent.click(chip("pci"));
    await waitFor(() => expect(latest(onChange).nodes.map((n) => n.tags)).toEqual([["gdpr"], ["gdpr"]]));
  });

  it("says what a connection joins, and can turn it round", async () => {
    const onChange = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={TWO} onChange={onChange} />);

    await waitFor(() => expect(container.querySelector(".as-edge__hit")).toBeTruthy());
    fireEvent.click(container.querySelector(".as-edge__hit")!);

    await waitFor(() => expect(screen.getByText("A → B")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Reverse this connection" }));

    await waitFor(() => {
      const reversed = latest(onChange).edges[0]!;
      expect([reversed.source, reversed.target]).toEqual(["b", "a"]);
    });
  });

  it("adds a tag on Enter, and abandons a half-typed one on blur", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={TWO} onChange={onChange} />);

    fireEvent.click(node(container, "a"));
    const box = await screen.findByLabelText("Node tags — add");

    await user.type(box, "pci{Enter}");
    await waitFor(() => expect(latest(onChange).nodes[0]!.tags).toEqual(["pci"]));

    // A fragment left in the box when focus moves away is abandoned. It used
    // to be committed, so clicking the canvas mid-word invented a tag.
    await user.type(box, "gd");
    fireEvent.blur(box);
    await waitFor(() => expect(box).toHaveValue(""));
    expect(latest(onChange).nodes[0]!.tags).toEqual(["pci"]);
  });
});

describe("search", () => {
  it("names the match it centred on", async () => {
    const user = userEvent.setup();
    mount(
      <ArchitectureStudio
        defaultValue={doc({
          nodes: [
            { id: "a", label: "Alpha", kind: "service", x: 0, y: 0 },
            { id: "b", label: "Alpine", kind: "service", x: 300, y: 0 },
          ],
        })}
      />,
    );

    const field = screen.getByLabelText("Search nodes and fields");
    await user.type(field, "alp");
    expect(screen.getByText("1/2")).toBeInTheDocument();

    // The first Enter lands on match 1, and the readout agrees. It used to
    // advance first, so the counter ran one ahead of the highlighted node.
    await user.type(field, "{Enter}");
    expect(screen.getByText("1/2")).toBeInTheDocument();
    await user.type(field, "{Enter}");
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });
});

describe("a host that keeps several files", () => {
  it("does not rename a newly selected file to the previous document's title", async () => {
    const onFileRename = vi.fn();
    const A = doc({ meta: { title: "Payments" }, nodes: [{ id: "a", label: "A", kind: "service" }] });
    const B = doc({ nodes: [{ id: "b", label: "B", kind: "service" }] });

    function Host() {
      const [active, setActive] = useState("A");
      return (
        <>
          <button type="button" onClick={() => setActive("B")}>
            switch
          </button>
          {/* No `key` — the editor is NOT remounted per file, which the
              README supports and which is where the reconciler read the
              previous file's title on the swap render. */}
          <ArchitectureStudio
            value={active === "A" ? A : B}
            onChange={() => {}}
            files={[
              { id: "A", name: "Payments", kind: "arch" },
              { id: "B", name: "Untitled 2", kind: "arch" },
            ]}
            activeFileId={active}
            onFileSelect={setActive}
            onFileRename={onFileRename}
          />
        </>
      );
    }
    mount(<Host />);
    onFileRename.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    await waitFor(() => expect(screen.getByText("B")).toBeInTheDocument());

    // B has no title of its own, so nothing should have renamed it.
    expect(onFileRename.mock.calls.filter(([id]) => id === "B")).toEqual([]);
  });
});

describe("lighting a path", () => {
  const WIRED = doc({
    nodes: [
      { id: "u", label: "User", kind: "client", x: 0, y: 0 },
      { id: "api", label: "API", kind: "service", x: 300, y: 0 },
      { id: "db", label: "DB", kind: "database", x: 600, y: 0 },
      { id: "q", label: "Queue", kind: "queue", x: 300, y: 200 },
    ],
    edges: [
      { id: "e1", source: "u", target: "api" },
      { id: "e2", source: "api", target: "db" },
      { id: "e3", source: "api", target: "q" },
    ],
    paths: [
      { id: "read", title: "Read a record", steps: ["u", "api", "db"] },
      { id: "enqueue", title: "Enqueue a job", steps: ["api", "q"], color: "violet" },
    ],
  });
  const lit = (container: HTMLElement, id: string) => node(container, id).classList.contains("as-path-node");

  it("offers the Paths menu only when the document names a path", () => {
    mount(<ArchitectureStudio defaultValue={doc({ nodes: WIRED.nodes, edges: WIRED.edges })} />);
    expect(screen.queryByRole("button", { name: "Paths" })).toBeNull();
  });

  it("glows the members of a ticked path — and the document is not an edit away", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={WIRED} onChange={onChange} />);
    const emitted = onChange.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Paths" }));
    await user.click(screen.getByRole("checkbox", { name: "Read a record" }));

    await waitFor(() => expect(lit(container, "api")).toBe(true));
    expect(lit(container, "u")).toBe(true);
    expect(lit(container, "db")).toBe(true);
    expect(lit(container, "q")).toBe(false);
    // u → e1 → api → e2 → db: the API is the third step of five.
    expect(node(container, "api").style.getPropertyValue("--as-path-step")).toBe("2");
    expect(node(container, "api").style.getPropertyValue("--as-path-steps")).toBe("5");
    expect(node(container, "api").style.getPropertyValue("--as-path-ink")).toBe("var(--as-edge-sky)");
    // Both inferred edges run their dash flow; the queue's does not.
    await waitFor(() => expect(container.querySelectorAll(".as-edge__flow")).toHaveLength(2));
    // The key, and the count on the button.
    expect(container.querySelector(".as-legend")!.textContent).toContain("Paths");
    expect(container.querySelector(".as-legend")!.textContent).toContain("Read a record");
    expect(screen.getByRole("button", { name: "Paths (1)" })).toBeTruthy();
    // Lighting is a view: nothing was committed.
    expect(onChange.mock.calls.length).toBe(emitted);

    // Everything, then nothing.
    await user.click(screen.getByRole("menuitem", { name: "Select all" }));
    await waitFor(() => expect(lit(container, "q")).toBe(true));
    expect(container.querySelector(".as-legend")!.textContent).toContain("Enqueue a job");
    await user.click(screen.getByRole("button", { name: "Paths (2)" }));
    await user.click(screen.getByRole("menuitem", { name: "Clear" }));
    await waitFor(() => expect(lit(container, "api")).toBe(false));
    expect(container.querySelectorAll(".as-edge__flow")).toHaveLength(0);
    expect(container.querySelector(".as-legend")).toBeNull();
    expect(onChange.mock.calls.length).toBe(emitted);
  });

  it("keeps the key out of a legend-less editor", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={WIRED} legend={false} />);
    await user.click(screen.getByRole("button", { name: "Paths" }));
    await user.click(screen.getByRole("checkbox", { name: "Enqueue a job" }));
    await waitFor(() => expect(lit(container, "q")).toBe(true));
    expect(container.querySelector(".as-legend")).toBeNull();
  });
});

describe("a shortcut acts on the selection the click just made", () => {
  /**
   * React Flow reports its selection from an effect, one scheduler tick
   * after the click. A shortcut in that gap used to act on the PREVIOUS
   * selection — ⌘D duplicated the node you had, not the one you clicked.
   * The click and the key are dispatched back to back here, with nothing
   * awaited between them, which is exactly the gap.
   */
  it("⌘D right after a click duplicates the clicked node, not the one selected before", async () => {
    const onChange = vi.fn();
    const DOC = validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "Alpha", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
        { id: "b", label: "Bravo", kind: "service", icon: "box", description: "", parentId: null, x: 400, y: 0, w: 170, h: 76 },
      ],
      edges: [],
    });
    const { container } = mount(<ArchitectureStudio defaultValue={DOC} onChange={onChange} />);
    const card = (id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;

    // Select Alpha the slow way, and let every report land.
    fireEvent.click(card("a"));
    await waitFor(() => expect(card("a").classList.contains("selected")).toBe(true));

    // Now click Bravo and press ⌘D in the same breath.
    fireEvent.click(card("b"));
    fireEvent.keyDown(window, { key: "d", metaKey: true });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const doc = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    const copies = doc.nodes.filter((n) => !["a", "b"].includes(n.id));
    expect(copies.map((n) => n.label)).toEqual(["Bravo"]);
  });
});
