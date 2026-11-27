/**
 * @vitest-environment jsdom
 *
 * What a host building on the editor hears and can do: a task changing
 * state (`onTaskDoneChange`), an edit itemised (`onDocumentChange`), clicks,
 * and the handle's task-state and viewport methods.
 */
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ArchitectureStudio, type StudioHandle } from "./ArchitectureStudio";
import { clearWelcomeSuppression } from "./WelcomeModal";
import { addNode } from "../contract/edit";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";
import { setTaskState } from "../contract/task-states";
import type { TemplateDiff } from "../contract/diff";

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

const FLOW = ["todo", "doing", "review", "shipped"];

const plan = (settings?: Record<string, unknown>) =>
  doc({
    nodes: [
      { id: "design", label: "Design", kind: "task", x: 0, y: 0 },
      { id: "build", label: "Build", kind: "task", x: 300, y: 0 },
      { id: "svc", label: "Service", kind: "service", x: 700, y: 0 },
    ],
    edges: [{ id: "pre", source: "design", target: "build" }],
    ...(settings ? { settings } : {}),
  });

beforeEach(() => clearWelcomeSuppression());

describe("onTaskDoneChange", () => {
  it("reports done and notDone from the corner check, and again on undo", async () => {
    const onTaskDoneChange = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={plan()} onTaskDoneChange={onTaskDoneChange} welcome={false} />);
    await waitFor(() => expect(node(container, "design")).toBeTruthy());
    expect(onTaskDoneChange).not.toHaveBeenCalled();

    fireEvent.click(within(node(container, "design")).getByRole("checkbox", { name: /Design/ }));
    await waitFor(() => expect(onTaskDoneChange).toHaveBeenCalledTimes(1));
    expect(onTaskDoneChange).toHaveBeenLastCalledWith("design", "done", {
      previous: "notDone",
      done: true,
      states: ["notDone", "done"],
      node: expect.objectContaining({ id: "design", done: true }),
    });

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(onTaskDoneChange).toHaveBeenCalledTimes(2));
    expect(onTaskDoneChange).toHaveBeenLastCalledWith(
      "design",
      "notDone",
      expect.objectContaining({ previous: "done", done: false }),
    );
  });

  it("needs no onChange, and says nothing for an edit that moves no task", async () => {
    const ref = createRef<StudioHandle>();
    const onTaskDoneChange = vi.fn();
    mount(<ArchitectureStudio ref={ref} defaultValue={plan()} onTaskDoneChange={onTaskDoneChange} welcome={false} />);
    act(() => {
      ref.current!.update((d) => addNode(d, { id: "more", label: "More", kind: "task", done: true }));
    });
    // A task that arrives finished hasn't changed state: it is new.
    expect(onTaskDoneChange).not.toHaveBeenCalled();
    act(() => {
      ref.current!.update((d) => setTaskState(d, "more", "notDone"));
    });
    expect(onTaskDoneChange).toHaveBeenCalledTimes(1);
    expect(onTaskDoneChange).toHaveBeenLastCalledWith("more", "notDone", expect.objectContaining({ previous: "done" }));
  });

  it("reports a document's own states by name", async () => {
    const ref = createRef<StudioHandle>();
    const onTaskDoneChange = vi.fn();
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio
        ref={ref}
        defaultValue={plan({ taskStates: FLOW })}
        onChange={onChange}
        onTaskDoneChange={onTaskDoneChange}
        welcome={false}
      />,
    );
    const studio = ref.current!;
    expect(studio.getTaskState("design")).toBe("todo");
    expect(studio.getTaskState("svc")).toBeUndefined();

    let moved = false;
    act(() => {
      moved = studio.setTaskState("design", "review");
    });
    expect(moved).toBe(true);
    expect(studio.getTaskState("design")).toBe("review");
    expect(onTaskDoneChange).toHaveBeenLastCalledWith("design", "review", {
      previous: "todo",
      done: false,
      states: FLOW,
      node: expect.objectContaining({ id: "design", stage: "review" }),
    });
    // The card says it in words, and the edit is one undo step like any other.
    expect(await within(node(container, "design")).findByText("Review")).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(studio.canUndo()).toBe(true);

    // The corner check takes it to the last state.
    fireEvent.click(within(node(container, "design")).getByRole("checkbox", { name: /Design/ }));
    await waitFor(() => expect(studio.getTaskState("design")).toBe("shipped"));
    expect(onTaskDoneChange).toHaveBeenLastCalledWith(
      "design",
      "shipped",
      expect.objectContaining({ previous: "review", done: true }),
    );
  });

  it("refuses a state the task can't be in, and a node that isn't a task", () => {
    const ref = createRef<StudioHandle>();
    const onTaskDoneChange = vi.fn();
    mount(<ArchitectureStudio ref={ref} defaultValue={plan()} onTaskDoneChange={onTaskDoneChange} welcome={false} />);
    act(() => {
      expect(ref.current!.setTaskState("design", "review")).toBe(false);
      expect(ref.current!.setTaskState("svc", "done")).toBe(false);
      expect(ref.current!.setTaskState("nope", "done")).toBe(false);
      // Already there: true, and nothing to report.
      expect(ref.current!.setTaskState("design", "notDone")).toBe(true);
    });
    expect(onTaskDoneChange).not.toHaveBeenCalled();
    expect(ref.current!.canUndo()).toBe(false);
  });

  it("reports a change the host made through value, once", async () => {
    const onTaskDoneChange = vi.fn();
    const first = plan();
    const { rerender } = mount(<ArchitectureStudio value={first} onTaskDoneChange={onTaskDoneChange} welcome={false} />);
    const next = setTaskState(first, "build", "done");
    rerender(<ArchitectureStudio value={next} onTaskDoneChange={onTaskDoneChange} welcome={false} />);
    await waitFor(() => expect(onTaskDoneChange).toHaveBeenCalledTimes(1));
    expect(onTaskDoneChange).toHaveBeenLastCalledWith("build", "done", expect.objectContaining({ previous: "notDone" }));
    rerender(<ArchitectureStudio value={next} onTaskDoneChange={onTaskDoneChange} welcome={false} />);
    expect(onTaskDoneChange).toHaveBeenCalledTimes(1);
  });

  it("doesn't compare one file's tasks with the next file's", async () => {
    const onTaskDoneChange = vi.fn();
    const files = [
      { id: "one", name: "One" },
      { id: "two", name: "Two" },
    ];
    const one = plan();
    const two = setTaskState(plan(), "design", "done");
    const { rerender } = mount(
      <ArchitectureStudio value={one} files={files} activeFileId="one" onTaskDoneChange={onTaskDoneChange} welcome={false} />,
    );
    rerender(
      <ArchitectureStudio value={two} files={files} activeFileId="two" onTaskDoneChange={onTaskDoneChange} welcome={false} />,
    );
    await act(async () => {});
    expect(onTaskDoneChange).not.toHaveBeenCalled();
  });
});

describe("the task inspector", () => {
  it("offers the task's own states, and a field to name them", async () => {
    const ref = createRef<StudioHandle>();
    const onTaskDoneChange = vi.fn();
    mount(<ArchitectureStudio ref={ref} defaultValue={plan()} onTaskDoneChange={onTaskDoneChange} welcome={false} />);
    act(() => ref.current!.select({ nodes: ["design"] }));

    // The field is asked for from the picker's last row, not always there.
    expect(screen.queryByRole("textbox", { name: "Task states" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Task status" }));
    fireEvent.click(screen.getByRole("option", { name: /Edit states/ }));
    const states = await screen.findByRole("textbox", { name: "Task states" });
    expect(states).toHaveAttribute("placeholder", "Not done, Done");
    // The default pair keeps its Done check; states of the task's own replace it with the picker.
    expect(screen.getByRole("checkbox", { name: "Done" })).toBeInTheDocument();
    fireEvent.change(states, { target: { value: "open, testing, closed" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(ref.current!.getTemplate().nodes.find((n) => n.id === "design")!.states).toEqual(["open", "testing", "closed"]),
    );
    expect(ref.current!.getTaskState("design")).toBe("open");
    expect(screen.queryByRole("checkbox", { name: "Done" })).toBeNull();
    // Applied, the panel is gone again.
    expect(screen.queryByRole("textbox", { name: "Task states" })).toBeNull();
    // Naming the states moved nothing: "notDone" became the new first state.
    expect(onTaskDoneChange).toHaveBeenCalledTimes(1);
    expect(onTaskDoneChange).toHaveBeenLastCalledWith("design", "open", expect.objectContaining({ previous: "notDone" }));

    // Opened again it shows them as the card does, and offers the way back.
    fireEvent.click(screen.getByRole("button", { name: "Task status" }));
    fireEvent.click(screen.getByRole("option", { name: /Edit states/ }));
    expect(await screen.findByRole("textbox", { name: "Task states" })).toHaveValue("Open, Testing, Closed");
    fireEvent.click(screen.getByRole("button", { name: "Use default states" }));
    await waitFor(() => expect(ref.current!.getTemplate().nodes.find((n) => n.id === "design")).not.toHaveProperty("states"));
  });
});

describe("a task card with states of its own", () => {
  it("always says which state it is in: where it starts, between, and done", async () => {
    const d = setTaskState(setTaskState(plan({ taskStates: FLOW }), "design", "review"), "build", "shipped");
    const { container } = mount(
      <ArchitectureStudio defaultValue={{ ...d, nodes: [...d.nodes, { ...d.nodes[0]!, id: "later", label: "Later", x: 0, y: 300 }] }} welcome={false} />,
    );
    await waitFor(() => expect(node(container, "design")).toBeTruthy());
    const pill = (id: string) => node(container, id).querySelector<HTMLElement>(".as-node__stage")!;
    expect(pill("design").textContent).toBe("Review");
    expect(pill("design").classList.contains("as-node__stage--between")).toBe(true);
    expect(pill("build").textContent).toBe("Shipped");
    expect(pill("build").classList.contains("as-node__stage--last")).toBe(true);
    expect(node(container, "svc").querySelector(".as-node__stage")).toBeNull();
  });

  it("wears no pill on the default pair: the corner check says it", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={plan()} welcome={false} />);
    await waitFor(() => expect(node(container, "design")).toBeTruthy());
    expect(node(container, "design").querySelector(".as-node__stage")).toBeNull();
  });
});

describe("onDocumentChange", () => {
  it("itemises an edit, and stays quiet for the host's own value", async () => {
    const ref = createRef<StudioHandle>();
    const seen: TemplateDiff[] = [];
    const first = plan();
    const { rerender } = mount(
      <ArchitectureStudio ref={ref} value={first} onDocumentChange={(diff) => seen.push(diff)} welcome={false} />,
    );
    act(() => {
      ref.current!.update((d) => addNode(d, { id: "more", label: "More", kind: "task", x: 0, y: 300 }));
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.nodes.added).toEqual(["more"]);

    act(() => {
      ref.current!.setTaskState("design", "done");
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.nodes.changed).toEqual([{ id: "design", fields: ["done"] }]);

    rerender(
      <ArchitectureStudio
        ref={ref}
        value={setTaskState(ref.current!.getTemplate(), "build", "done")}
        onDocumentChange={(diff) => seen.push(diff)}
        welcome={false}
      />,
    );
    await act(async () => {});
    expect(seen).toHaveLength(2);
  });
});

describe("onNodesMove", () => {
  it("reports a nudge once, with where the node was and is, and again on undo", async () => {
    const ref = createRef<StudioHandle>();
    const onNodesMove = vi.fn();
    mount(<ArchitectureStudio ref={ref} defaultValue={plan()} onNodesMove={onNodesMove} welcome={false} />);
    act(() => ref.current!.select({ nodes: ["svc"] }));
    expect(onNodesMove).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(onNodesMove).toHaveBeenCalledTimes(1));
    const [moves, template] = onNodesMove.mock.calls[0]!;
    expect(moves).toHaveLength(1);
    expect(moves[0].nodeId).toBe("svc");
    expect(moves[0].from).toEqual({ x: 700, y: 0, parentId: null });
    expect(moves[0].to.x).toBeGreaterThan(700);
    expect(template.nodes.find((n: { id: string }) => n.id === "svc").x).toBe(moves[0].to.x);

    act(() => {
      ref.current!.undo();
    });
    expect(onNodesMove).toHaveBeenCalledTimes(2);
    expect(onNodesMove.mock.calls[1]![0]).toEqual([{ nodeId: "svc", from: moves[0].to, to: moves[0].from }]);
  });

  it("reports every node one edit moved in one call, and nothing for an edit that moves none", () => {
    const ref = createRef<StudioHandle>();
    const onNodesMove = vi.fn();
    mount(<ArchitectureStudio ref={ref} defaultValue={plan()} onNodesMove={onNodesMove} welcome={false} />);
    act(() => {
      ref.current!.setTaskState("design", "done");
    });
    expect(onNodesMove).not.toHaveBeenCalled();
    act(() => {
      ref.current!.update((d) => ({ ...d, nodes: d.nodes.map((n) => (n.kind === "task" ? { ...n, y: n.y + 40 } : n)) }));
    });
    expect(onNodesMove).toHaveBeenCalledTimes(1);
    expect(onNodesMove.mock.calls[0]![0].map((m: { nodeId: string }) => m.nodeId).sort()).toEqual(["build", "design"]);
  });

  it("stays quiet for the host's own value", async () => {
    const onNodesMove = vi.fn();
    const first = plan();
    const { rerender } = mount(<ArchitectureStudio value={first} onNodesMove={onNodesMove} welcome={false} />);
    rerender(
      <ArchitectureStudio
        value={{ ...first, nodes: first.nodes.map((n) => (n.id === "svc" ? { ...n, x: 900 } : n)) }}
        onNodesMove={onNodesMove}
        welcome={false}
      />,
    );
    await act(async () => {});
    expect(onNodesMove).not.toHaveBeenCalled();
  });
});

describe("clicks", () => {
  it("report the node or connection by its document id", async () => {
    const onNodeClick = vi.fn();
    const onNodeDoubleClick = vi.fn();
    const onEdgeClick = vi.fn();
    const { container } = mount(
      <ArchitectureStudio
        defaultValue={plan()}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeClick={onEdgeClick}
        readOnly
        welcome={false}
      />,
    );
    await waitFor(() => expect(node(container, "svc")).toBeTruthy());
    fireEvent.click(node(container, "svc"));
    expect(onNodeClick).toHaveBeenCalledWith("svc", expect.anything());
    fireEvent.doubleClick(node(container, "svc"));
    expect(onNodeDoubleClick).toHaveBeenCalledWith("svc", expect.anything());

    const line = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('.react-flow__edge[data-id="pre"]');
      expect(found).toBeTruthy();
      return found!;
    });
    fireEvent.click(line);
    expect(onEdgeClick).toHaveBeenCalledWith("pre", expect.anything());
  });
});

describe("the viewport", () => {
  it("can be read and set through the handle", async () => {
    const ref = createRef<StudioHandle>();
    mount(<ArchitectureStudio ref={ref} defaultValue={plan()} welcome={false} />);
    act(() => ref.current!.setViewport({ x: 40, y: -20, zoom: 1.5 }));
    await waitFor(() => expect(ref.current!.getViewport()).toEqual({ x: 40, y: -20, zoom: 1.5 }));
  });
});
