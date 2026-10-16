/**
 * @vitest-environment jsdom
 *
 * The editors' document API: a host editing the JSON through the handle, or
 * through `value`, gets one undo step per edit, the repairs listed, and the
 * person's own history kept.
 */
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArchitectureStudio, type StudioHandle } from "./ArchitectureStudio";
import { SequenceStudio, type SequenceStudioHandle } from "./sequence/SequenceStudio";
import { addEdge, addNode, removeNodes } from "../contract/edit";
import { EXAMPLE_TEMPLATE, EXAMPLE_ZONED_TEMPLATE, validateTemplate, type DiagramTemplate } from "../contract/schema";
import { EXAMPLE_SEQUENCE, removeMessages } from "../contract/sequence";
import type { ValidationReport } from "../contract/validation-report";

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

const ids = (doc: DiagramTemplate) => doc.nodes.map((n) => n.id);

/** The canvas transform right now. */
const transformOf = (container: HTMLElement) =>
  (container.querySelector(".react-flow__viewport") as HTMLElement).style.transform;

/**
 * The transform once the view has moved off `from` and come to rest. The
 * handle's fits animate (up to 300 ms, after a 50 ms delay for `update`), so
 * "at rest" is no change for longer than any of them — two equal reads could
 * both fall between frames of one animation on a busy machine.
 */
async function movedFrom(container: HTMLElement, from: string): Promise<string> {
  let last = transformOf(container);
  let since = Date.now();
  await waitFor(
    () => {
      const t = transformOf(container);
      if (t !== last) [last, since] = [t, Date.now()];
      if (t === from) throw new Error("the view hasn't moved yet");
      if (Date.now() - since < 600) throw new Error("the view is still moving");
    },
    { timeout: 10_000, interval: 50 },
  );
  return last;
}

const byId = (doc: DiagramTemplate) => ({ ...doc, nodes: [...doc.nodes].sort((a, b) => a.id.localeCompare(b.id)) });

describe("StudioHandle: editing the document", () => {
  it("update lands as one undo step and is reported through onChange", async () => {
    const ref = createRef<StudioHandle>();
    const onChange = vi.fn();
    mount(<ArchitectureStudio ref={ref} defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} welcome={false} />);
    const studio = ref.current!;
    // The same nodes (the canvas orders frames ahead of their contents).
    expect(ids(studio.getTemplate()).sort()).toEqual(ids(validateTemplate(EXAMPLE_TEMPLATE)).sort());
    expect(studio.canUndo()).toBe(false);

    let report!: ValidationReport;
    act(() => {
      report = studio.update((doc) => addEdge(addNode(doc, { id: "cdn", label: "Edge CDN", kind: "gateway" }), { source: "cdn", target: "gw" }));
    });
    expect(report.issues).toEqual([]);
    expect(ids(report.template)).toContain("cdn");
    expect(onChange).toHaveBeenLastCalledWith(report.template);
    expect(byId(studio.getTemplate())).toEqual(byId(report.template));
    expect(await screen.findByText("Edge CDN")).toBeInTheDocument();
    // Readable straight after the edit, not a render later.
    expect(studio.canUndo()).toBe(true);
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();

    act(() => {
      expect(studio.undo()).toBe(true);
    });
    expect(ids(studio.getTemplate())).not.toContain("cdn");
    expect(screen.queryByText("Edge CDN")).not.toBeInTheDocument();
    expect(studio.canRedo()).toBe(true);
    act(() => {
      expect(studio.redo()).toBe(true);
    });
    expect(ids(studio.getTemplate())).toContain("cdn");
    act(() => {
      expect(studio.redo()).toBe(false);
    });
  });

  it("lists what validation repaired instead of losing it silently", () => {
    const ref = createRef<StudioHandle>();
    mount(<ArchitectureStudio ref={ref} defaultValue={EXAMPLE_TEMPLATE} welcome={false} />);
    let report!: ValidationReport;
    act(() => {
      report = ref.current!.update((doc) => ({
        ...doc,
        edges: [...doc.edges, { id: "typo", source: "api", target: "paymnts", label: "", style: "solid", color: "slate" }],
      }));
    });
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "missing-reference", path: `/edges/${EXAMPLE_TEMPLATE.edges.length}` }),
    ]);
    expect(report.template.edges.map((e) => e.id)).not.toContain("typo");
  });

  it("knows the registry's kinds, which validation without it would turn into services", () => {
    const ref = createRef<StudioHandle>();
    const registry = { nodeKinds: { vault: { label: "Vault", color: "#a78bfa", icon: "lock" as const } } };
    mount(<ArchitectureStudio ref={ref} defaultValue={EXAMPLE_TEMPLATE} registry={registry} welcome={false} />);
    let report!: ValidationReport;
    act(() => {
      report = ref.current!.update((doc) => addNode(doc, { id: "v", label: "Secrets", kind: "vault" }));
    });
    expect(report.issues).toEqual([]);
    expect(report.template.nodes.find((n) => n.id === "v")!.kind).toBe("vault");
  });

  it("select and getSelection speak document ids", () => {
    const ref = createRef<StudioHandle>();
    const onSelectionChange = vi.fn();
    mount(
      <ArchitectureStudio ref={ref} defaultValue={EXAMPLE_TEMPLATE} onSelectionChange={onSelectionChange} welcome={false} />,
    );
    act(() => ref.current!.select({ nodes: ["gw", "db"], edges: ["e1"] }));
    expect(ref.current!.getSelection()).toEqual({ nodes: ["gw", "db"], edges: ["e1"], zones: [] });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ nodes: ["gw", "db"], edges: ["e1"], zones: [] });
    // An update keeps the selection for whatever still exists.
    act(() => {
      ref.current!.update((doc) => removeNodes(doc, ["db"]));
    });
    expect(ref.current!.getSelection().nodes).toEqual(["gw"]);
  });

  it("selects zones by their document id", () => {
    const ref = createRef<StudioHandle>();
    const onSelectionChange = vi.fn();
    mount(
      <ArchitectureStudio
        ref={ref}
        defaultValue={EXAMPLE_ZONED_TEMPLATE}
        onSelectionChange={onSelectionChange}
        welcome={false}
      />,
    );
    act(() => ref.current!.select({ zones: ["region"], nodes: ["ghost-of-nothing"] }));
    expect(ref.current!.getSelection()).toEqual({ nodes: [], edges: [], zones: ["region"] });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ nodes: [], edges: [], zones: ["region"] });
    act(() => ref.current!.select({}));
    expect(ref.current!.getSelection()).toEqual({ nodes: [], edges: [], zones: [] });
  });

  it("fitView frames the nodes given, or the whole level; update moves the view only when asked", async () => {
    const ref = createRef<StudioHandle>();
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={EXAMPLE_TEMPLATE} welcome={false} />);
    await waitFor(() => expect(transformOf(container)).toMatch(/scale/));
    const scale = (t: string) => Number(t.match(/scale\(([\d.]+)\)/)![1]);

    act(() => ref.current!.fitView(["gw"]));
    const one = await movedFrom(container, transformOf(container));

    // An edit leaves the view where the person put it…
    act(() => {
      ref.current!.update((doc) => addNode(doc, { id: "cdn", label: "Edge CDN", kind: "gateway" }));
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(transformOf(container)).toBe(one);
    // …unless the host asks for the whole level, which fits further out than one card.
    act(() => {
      ref.current!.update((doc) => removeNodes(doc, ["cdn"]), { fit: true });
    });
    const whole = await movedFrom(container, one);
    expect(scale(whole)).toBeLessThan(scale(one));

    act(() => ref.current!.fitView(["gw"]));
    expect(await movedFrom(container, whole)).toBe(one);
    act(() => ref.current!.fitView());
    expect(await movedFrom(container, one)).toBe(whole);

    // Ids this level doesn't draw are ignored; none drawn is no move at all.
    act(() => ref.current!.fitView(["nowhere", "gw"]));
    expect(await movedFrom(container, whole)).toBe(one);
    act(() => ref.current!.fitView(["nowhere"]));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(transformOf(container)).toBe(one);
  }, 30_000);
});

describe("controlled value: the host's edits and the person's history", () => {
  const withCdn = addNode(validateTemplate(EXAMPLE_TEMPLATE), { id: "cdn", label: "Edge CDN", kind: "gateway", x: 0, y: 0 });

  it("a change to value within one file is an undo step, not a new history", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = mount(
      <ArchitectureStudio value={EXAMPLE_TEMPLATE} activeFileId="one" onChange={onChange} welcome={false} />,
    );
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toBeDisabled();

    rerender(<ArchitectureStudio value={withCdn} activeFileId="one" onChange={onChange} welcome={false} />);
    expect(screen.getByText("Edge CDN")).toBeInTheDocument();
    // Adopting the host's own value is not an edit to report back.
    expect(onChange).not.toHaveBeenCalled();
    expect(undo).toBeEnabled();

    await user.click(undo);
    expect(screen.queryByText("Edge CDN")).not.toBeInTheDocument();
    expect(ids(onChange.mock.calls.at(-1)![0])).not.toContain("cdn");
  });

  it("a new activeFileId starts the history afresh, even with the same content", () => {
    const { rerender } = mount(<ArchitectureStudio value={EXAMPLE_TEMPLATE} activeFileId="one" onChange={vi.fn()} welcome={false} />);
    rerender(<ArchitectureStudio value={withCdn} activeFileId="one" onChange={vi.fn()} welcome={false} />);
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    rerender(<ArchitectureStudio value={withCdn} activeFileId="two" onChange={vi.fn()} welcome={false} />);
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });
});

describe("SequenceStudioHandle", () => {
  it("edits the sequence as one undo step, and value changes keep the history", () => {
    const ref = createRef<SequenceStudioHandle>();
    const onChange = vi.fn();
    const { rerender } = mount(
      <SequenceStudio ref={ref} value={EXAMPLE_SEQUENCE} activeFileId="one" onChange={onChange} welcome={false} />,
    );
    const first = EXAMPLE_SEQUENCE.messages[0].id;
    act(() => {
      ref.current!.update((doc) => removeMessages(doc, [first]));
    });
    expect(ref.current!.getTemplate().messages.map((m) => m.id)).not.toContain(first);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(ref.current!.canUndo()).toBe(true);
    act(() => {
      expect(ref.current!.undo()).toBe(true);
    });
    expect(ref.current!.getTemplate().messages.map((m) => m.id)).toContain(first);

    // The host's change to value within the file is undoable too…
    const fewer = removeMessages(EXAMPLE_SEQUENCE, [first]);
    rerender(<SequenceStudio ref={ref} value={fewer} activeFileId="one" onChange={onChange} welcome={false} />);
    expect(ref.current!.canUndo()).toBe(true);
    // …and a new file starts afresh.
    rerender(<SequenceStudio ref={ref} value={EXAMPLE_SEQUENCE} activeFileId="two" onChange={onChange} welcome={false} />);
    expect(ref.current!.canUndo()).toBe(false);
  });
});
