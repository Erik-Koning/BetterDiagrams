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

    await user.click(screen.getByRole("button", { name: "Export ▾" }));
    await user.click(node(container, "api"));

    // The click that got rid of the menu is spent on getting rid of it.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Node label")).not.toBeInTheDocument();

    // A second, ordinary click selects as it always did.
    await user.click(node(container, "api"));
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

    const field = screen.getByLabelText("Search nodes");
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
