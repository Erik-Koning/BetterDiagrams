/**
 * @vitest-environment jsdom
 *
 * The hooks a host extends the editor through: saying no to an edit
 * (`onBeforeChange`), hearing what an edit added and removed, hover and
 * errors, rows of its own in the right-click menu, marks of its own on
 * nodes (`nodeDecorations`) and fields of its own in the inspector
 * (`dataFields`).
 */
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ArchitectureStudio, type StudioHandle } from "./ArchitectureStudio";
import { clearWelcomeSuppression } from "./WelcomeModal";
import { addNode, removeNodes } from "../contract/edit";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";
import { taskStateChanges } from "../contract/task-states";

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

const node = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;

const plan = (): DiagramTemplate =>
  validateTemplate({
    version: 1,
    nodes: [
      { id: "design", label: "Design", kind: "task", x: 0, y: 0 },
      { id: "build", label: "Build", kind: "task", x: 300, y: 0 },
      { id: "svc", label: "Service", kind: "service", x: 700, y: 0 },
    ],
    edges: [{ id: "pre", source: "design", target: "build" }],
  });

const find = (template: DiagramTemplate, id: string) => template.nodes.find((n) => n.id === id);

beforeEach(() => clearWelcomeSuppression());

describe("onBeforeChange", () => {
  it("refuses an edit: the canvas goes back, and nobody hears of it", async () => {
    const ref = createRef<StudioHandle>();
    const onChange = vi.fn();
    const onTaskDoneChange = vi.fn();
    // Nothing is finished without sign-off.
    let signedOff = false;
    const onBeforeChange = vi.fn((next: DiagramTemplate, previous: DiagramTemplate) =>
      taskStateChanges(previous, next).some((c) => c.done) && !signedOff ? "Needs sign-off first" : undefined,
    );
    const { container } = mount(
      <ArchitectureStudio
        ref={ref}
        defaultValue={plan()}
        onChange={onChange}
        onTaskDoneChange={onTaskDoneChange}
        onBeforeChange={onBeforeChange}
        welcome={false}
      />,
    );
    await waitFor(() => expect(node(container, "design")).toBeTruthy());
    const check = () => within(node(container, "design")).getByRole("checkbox", { name: /Design/ });

    fireEvent.click(check());
    await waitFor(() => expect(onBeforeChange).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Needs sign-off first")).toBeTruthy());
    expect(find(ref.current!.getTemplate(), "design")?.done).toBeUndefined();
    await waitFor(() => expect(check().getAttribute("aria-checked")).not.toBe("true"));
    expect(onChange).not.toHaveBeenCalled();
    expect(onTaskDoneChange).not.toHaveBeenCalled();
    expect(ref.current!.canUndo()).toBe(false);

    // The edit it has no quarrel with goes through as ever.
    signedOff = true;
    fireEvent.click(check());
    await waitFor(() => expect(onTaskDoneChange).toHaveBeenCalledTimes(1));
    expect(find(ref.current!.getTemplate(), "design")?.done).toBe(true);
    await waitFor(() => expect(check().getAttribute("aria-checked")).toBe("true"));
    expect(ref.current!.canUndo()).toBe(true);
  });

  it("commits the document the host hands back, as the one undo step", async () => {
    const ref = createRef<StudioHandle>();
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio
        ref={ref}
        defaultValue={plan()}
        onChange={onChange}
        onBeforeChange={(next, previous) =>
          taskStateChanges(previous, next).length
            ? { ...next, nodes: next.nodes.map((n) => (n.done ? { ...n, description: "Signed off" } : n)) }
            : undefined
        }
        welcome={false}
      />,
    );
    await waitFor(() => expect(node(container, "design")).toBeTruthy());
    fireEvent.click(within(node(container, "design")).getByRole("checkbox", { name: /Design/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(find(ref.current!.getTemplate(), "design")).toMatchObject({ done: true, description: "Signed off" });
    expect(find(onChange.mock.lastCall![0], "design")).toMatchObject({ done: true, description: "Signed off" });
    await waitFor(() => expect(within(node(container, "design")).getByText("Signed off")).toBeTruthy());

    act(() => {
      ref.current!.undo();
    });
    expect(find(ref.current!.getTemplate(), "design")).toMatchObject({ description: "" });
    expect(find(ref.current!.getTemplate(), "design")?.done).toBeUndefined();
  });

  it("is asked about the ref's edits and a delete, and not about undo or the host's own value", async () => {
    const ref = createRef<StudioHandle>();
    let allow = true;
    const onBeforeChange = vi.fn(() => allow);
    const first = plan();
    const { container, rerender } = mount(
      <ArchitectureStudio ref={ref} defaultValue={first} onBeforeChange={onBeforeChange} welcome={false} />,
    );
    await waitFor(() => expect(node(container, "svc")).toBeTruthy());

    act(() => {
      ref.current!.update((d) => addNode(d, { id: "more", label: "More", kind: "service" }));
    });
    expect(onBeforeChange).toHaveBeenCalledTimes(1);
    expect(find(ref.current!.getTemplate(), "more")).toBeTruthy();

    act(() => {
      ref.current!.undo();
    });
    expect(find(ref.current!.getTemplate(), "more")).toBeUndefined();
    expect(onBeforeChange).toHaveBeenCalledTimes(1);

    allow = false;
    act(() => {
      ref.current!.update((d) => removeNodes(d, ["svc"]));
    });
    expect(onBeforeChange).toHaveBeenCalledTimes(2);
    expect(find(ref.current!.getTemplate(), "svc")).toBeTruthy();

    // The Delete key, on the canvas.
    act(() => ref.current!.select({ nodes: ["svc"] }));
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(onBeforeChange).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(node(container, "svc")).toBeTruthy());
    expect(find(ref.current!.getTemplate(), "svc")).toBeTruthy();

    rerender(
      <ArchitectureStudio
        ref={ref}
        value={{ ...first, nodes: first.nodes.filter((n) => n.id !== "svc") }}
        onBeforeChange={onBeforeChange}
        welcome={false}
      />,
    );
    await act(async () => {});
    expect(onBeforeChange).toHaveBeenCalledTimes(3);
  });
});

describe("a refused edit, to whoever asked for it", () => {
  it("keeps its notice: the action that was refused doesn't go on to say it worked", async () => {
    const { container } = mount(
      <ArchitectureStudio defaultValue={plan()} onBeforeChange={() => "Layout is frozen"} welcome={false} />,
    );
    await waitFor(() => expect(node(container, "svc")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Arrange" }));
    fireEvent.click((await screen.findAllByRole("menuitem", { name: /^Tidy/ }))[0]!);
    await waitFor(() => expect(screen.getByText("Layout is frozen")).toBeTruthy());
    expect(screen.queryByText(/^Tidied/)).toBeNull();
  });

  it("tells the ref: setTaskState is false, and update hands back the document as it was", () => {
    const ref = createRef<StudioHandle>();
    let allow = false;
    mount(<ArchitectureStudio ref={ref} defaultValue={plan()} onBeforeChange={() => allow} welcome={false} />);
    let done = true;
    act(() => {
      done = ref.current!.setTaskState("design", "done");
    });
    expect(done).toBe(false);
    expect(ref.current!.getTaskState("design")).toBe("notDone");
    let report: ReturnType<StudioHandle["update"]> | undefined;
    act(() => {
      report = ref.current!.update((d) => removeNodes(d, ["svc"]));
    });
    expect(find(report!.template, "svc")).toBeTruthy();

    allow = true;
    act(() => {
      done = ref.current!.setTaskState("design", "done");
    });
    expect(done).toBe(true);
    expect(ref.current!.getTaskState("design")).toBe("done");
  });
});

describe("what an edit added and removed", () => {
  it("reports nodes and connections once per edit, and again when undo brings them back", async () => {
    const ref = createRef<StudioHandle>();
    const onNodesAdd = vi.fn();
    const onNodesDelete = vi.fn();
    const onEdgesAdd = vi.fn();
    const onEdgesDelete = vi.fn();
    const { container } = mount(
      <ArchitectureStudio
        ref={ref}
        defaultValue={plan()}
        onNodesAdd={onNodesAdd}
        onNodesDelete={onNodesDelete}
        onEdgesAdd={onEdgesAdd}
        onEdgesDelete={onEdgesDelete}
        welcome={false}
      />,
    );
    await waitFor(() => expect(node(container, "design")).toBeTruthy());

    act(() => {
      ref.current!.update((d) => ({
        ...addNode(d, { id: "ship", label: "Ship", kind: "task" }),
        edges: [...d.edges, { ...d.edges[0]!, id: "then", source: "build", target: "ship" }],
      }));
    });
    expect(onNodesAdd).toHaveBeenCalledTimes(1);
    expect(onNodesAdd.mock.calls[0]![0].map((n: { id: string }) => n.id)).toEqual(["ship"]);
    expect(onEdgesAdd).toHaveBeenCalledTimes(1);
    expect(onEdgesAdd.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: "then", source: "build", target: "ship" })]);
    expect(onNodesDelete).not.toHaveBeenCalled();

    // Deleting a node takes its connections with it: one report of each.
    act(() => ref.current!.select({ nodes: ["design"] }));
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(onNodesDelete).toHaveBeenCalledTimes(1));
    expect(onNodesDelete.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: "design", label: "Design" })]);
    expect(onEdgesDelete).toHaveBeenCalledTimes(1);
    expect(onEdgesDelete.mock.calls[0]![0].map((e: { id: string }) => e.id)).toEqual(["pre"]);

    act(() => {
      ref.current!.undo();
    });
    expect(onNodesAdd).toHaveBeenCalledTimes(2);
    expect(onNodesAdd.mock.calls[1]![0].map((n: { id: string }) => n.id)).toEqual(["design"]);
    expect(onEdgesAdd).toHaveBeenCalledTimes(2);
  });

  it("stays quiet for the host's own value", async () => {
    const onNodesDelete = vi.fn();
    const first = plan();
    const { rerender } = mount(<ArchitectureStudio value={first} onNodesDelete={onNodesDelete} welcome={false} />);
    rerender(
      <ArchitectureStudio
        value={{ ...first, nodes: first.nodes.filter((n) => n.id !== "svc") }}
        onNodesDelete={onNodesDelete}
        welcome={false}
      />,
    );
    await act(async () => {});
    expect(onNodesDelete).not.toHaveBeenCalled();
  });
});

describe("hover and errors", () => {
  it("reports the node the pointer is on, then that it left", async () => {
    const onNodeHover = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={plan()} onNodeHover={onNodeHover} welcome={false} />);
    await waitFor(() => expect(node(container, "svc")).toBeTruthy());
    fireEvent.mouseEnter(node(container, "svc"));
    expect(onNodeHover).toHaveBeenLastCalledWith("svc");
    fireEvent.mouseLeave(node(container, "svc"));
    expect(onNodeHover).toHaveBeenLastCalledWith(null);
  });

  it("hands the host the message of a failure it showed", async () => {
    const onError = vi.fn();
    mount(
      <ArchitectureStudio
        defaultValue={plan()}
        onSave={() => Promise.reject(new Error("disk full"))}
        onError={onError}
        welcome={false}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Save failed: disk full"));
  });
});

describe("contextMenuItems", () => {
  it("adds the host's rows for what was right-clicked", async () => {
    const onSelect = vi.fn();
    const contextMenuItems = vi.fn((target: { kind: string }) =>
      target.kind === "node" ? [{ label: "Open in tracker", hint: "T-1", onSelect }] : [],
    );
    const { container } = mount(
      <ArchitectureStudio defaultValue={plan()} contextMenuItems={contextMenuItems} welcome={false} />,
    );
    await waitFor(() => expect(node(container, "svc")).toBeTruthy());

    fireEvent.contextMenu(node(container, "svc"));
    const item = await screen.findByRole("menuitem", { name: /Open in tracker/ });
    await waitFor(() =>
      expect(contextMenuItems).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "node", selection: expect.objectContaining({ nodes: ["svc"] }) }),
      ),
    );
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: /Open in tracker/ })).toBeNull();
  });
});

describe("nodeDecorations", () => {
  it("draws the host's badge and ring on the node, and nothing in the document", async () => {
    const ref = createRef<StudioHandle>();
    const { container, rerender } = mount(
      <ArchitectureStudio
        ref={ref}
        defaultValue={plan()}
        nodeDecorations={{ svc: { badge: "Failing", ring: "#dc2626", title: "2 alerts", className: "host-alert" } }}
        welcome={false}
      />,
    );
    await waitFor(() => expect(node(container, "svc")).toBeTruthy());
    const badge = within(node(container, "svc")).getByText("Failing");
    expect(badge.getAttribute("title")).toBe("2 alerts");
    const card = node(container, "svc").querySelector<HTMLElement>(".as-node")!;
    expect(card.classList.contains("as-node--ringed")).toBe(true);
    expect(card.classList.contains("host-alert")).toBe(true);
    expect(card.style.getPropertyValue("--as-deco-ring")).toBe("#dc2626");
    expect(node(container, "design").querySelector(".as-node__deco")).toBeNull();
    expect(JSON.stringify(ref.current!.getTemplate())).not.toContain("Failing");

    rerender(<ArchitectureStudio ref={ref} defaultValue={plan()} nodeDecorations={{}} welcome={false} />);
    await waitFor(() => expect(within(node(container, "svc")).queryByText("Failing")).toBeNull());
  });
});

describe("dataFields", () => {
  const fields = [
    { key: "ticket", label: "Ticket", placeholder: "ABC-1" },
    { key: "cost", label: "Cost", type: "number" as const },
    { key: "tier", label: "Tier", type: "select" as const, options: ["gold", { value: "std", label: "Standard" }] },
    { key: "audited", label: "Audited", type: "checkbox" as const },
    { key: "sprint", label: "Sprint", kinds: ["task"] },
  ];

  it("edits the node's data bag from the inspector, and clears what is emptied", async () => {
    const ref = createRef<StudioHandle>();
    mount(<ArchitectureStudio ref={ref} defaultValue={plan()} dataFields={fields} welcome={false} />);
    act(() => ref.current!.select({ nodes: ["svc"] }));
    const group = await screen.findByRole("group", { name: "Data" });
    // A field for tasks alone is not offered on a service.
    expect(within(group).queryByLabelText("Sprint")).toBeNull();
    const data = () => find(ref.current!.getTemplate(), "svc")?.data;

    fireEvent.change(within(group).getByLabelText("Ticket"), { target: { value: "ABC-7" } });
    await waitFor(() => expect(data()).toEqual({ ticket: "ABC-7" }));
    fireEvent.change(within(group).getByLabelText("Cost"), { target: { value: "12.5" } });
    fireEvent.change(within(group).getByLabelText("Tier"), { target: { value: "std" } });
    fireEvent.click(within(group).getByLabelText("Audited"));
    await waitFor(() => expect(data()).toEqual({ ticket: "ABC-7", cost: 12.5, tier: "std", audited: true }));
    expect((within(group).getByLabelText("Ticket") as HTMLInputElement).value).toBe("ABC-7");

    fireEvent.change(within(group).getByLabelText("Ticket"), { target: { value: "" } });
    fireEvent.change(within(group).getByLabelText("Cost"), { target: { value: "" } });
    fireEvent.change(within(group).getByLabelText("Tier"), { target: { value: "" } });
    fireEvent.click(within(group).getByLabelText("Audited"));
    await waitFor(() => expect(data()).toBeUndefined());
  });

  it("undoes a run of typing in one field as the one edit it was", async () => {
    const ref = createRef<StudioHandle>();
    mount(<ArchitectureStudio ref={ref} defaultValue={plan()} dataFields={fields} welcome={false} />);
    act(() => ref.current!.select({ nodes: ["svc"] }));
    const group = await screen.findByRole("group", { name: "Data" });
    const data = () => find(ref.current!.getTemplate(), "svc")?.data;
    for (const text of ["A", "AB", "ABC"]) {
      fireEvent.change(within(group).getByLabelText("Ticket"), { target: { value: text } });
      await waitFor(() => expect(data()).toEqual({ ticket: text }));
    }
    // Another field is another edit.
    fireEvent.change(within(group).getByLabelText("Tier"), { target: { value: "gold" } });
    await waitFor(() => expect(data()).toEqual({ ticket: "ABC", tier: "gold" }));

    act(() => {
      ref.current!.undo();
    });
    expect(data()).toEqual({ ticket: "ABC" });
    act(() => {
      ref.current!.undo();
    });
    expect(data()).toBeUndefined();
    expect(ref.current!.canUndo()).toBe(false);
  });

  it("keeps the keys it doesn't name, and offers a kind's own fields on that kind", async () => {
    const ref = createRef<StudioHandle>();
    const start = plan();
    mount(
      <ArchitectureStudio
        ref={ref}
        defaultValue={{ ...start, nodes: start.nodes.map((n) => (n.id === "design" ? { ...n, data: { externalId: 42 } } : n)) }}
        dataFields={fields}
        welcome={false}
      />,
    );
    act(() => ref.current!.select({ nodes: ["design"] }));
    const group = await screen.findByRole("group", { name: "Data" });
    fireEvent.change(within(group).getByLabelText("Sprint"), { target: { value: "S4" } });
    await waitFor(() => expect(find(ref.current!.getTemplate(), "design")?.data).toEqual({ externalId: 42, sprint: "S4" }));
  });

  it("shows no Data group without fields", async () => {
    const ref = createRef<StudioHandle>();
    mount(<ArchitectureStudio ref={ref} defaultValue={plan()} welcome={false} />);
    act(() => ref.current!.select({ nodes: ["svc"] }));
    await screen.findByRole("group", { name: "Node" });
    expect(screen.queryByRole("group", { name: "Data" })).toBeNull();
  });
});
