/**
 * @vitest-environment jsdom
 *
 * Zone resize → proportional member scaling, end to end through the real
 * ZoneNode and studio context. Lives in its own file because it partially
 * mocks @xyflow/react (NodeResizer becomes a button that replays a resize
 * gesture), and that mock must not leak into the main suite.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { ArchitectureStudio } from "./ArchitectureStudio";
import type { DiagramTemplate } from "../contract/schema";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    // The ZONE resizer (minWidth 120) becomes a button that replays a
    // 2x-both-axes gesture; other nodes' resizers render nothing.
    NodeResizer: (props: {
      minWidth?: number;
      onResizeStart?: (e: unknown, p: { x: number; y: number; width: number; height: number }) => void;
      onResizeEnd?: (e: unknown, p: { x: number; y: number; width: number; height: number }) => void;
    }) =>
      props.minWidth === 120 ? (
        <button
          type="button"
          data-testid="zone-resize"
          onClick={() => {
            props.onResizeStart?.(null, { x: 100, y: 100, width: 400, height: 300 });
            props.onResizeEnd?.(null, { x: 100, y: 100, width: 800, height: 600 });
          }}
        />
      ) : null,
  };
});

const doc: DiagramTemplate = {
  version: 1,
  zones: [
    {
      id: "z",
      label: "Region",
      shape: "rounded",
      x: 100,
      y: 100,
      w: 400,
      h: 300,
      providers: ["aws", "gcp"],
      provider: "aws",
    },
  ],
  nodes: [
    {
      id: "a",
      label: "A",
      kind: "service",
      icon: "box",
      description: "",
      parentId: null,
      zoneId: "z",
      x: 150,
      y: 150,
      w: 170,
      h: 76,
    },
    {
      // Hidden under the aws selection — NOT in the React Flow store, so a
      // store-walking implementation would silently skip it.
      id: "hid",
      label: "Hidden",
      kind: "service",
      icon: "box",
      description: "",
      parentId: null,
      zoneId: "z",
      providers: ["gcp"],
      x: 200,
      y: 200,
      w: 170,
      h: 76,
    },
  ],
  edges: [],
};

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

describe("zone resize scales members", () => {
  it("scales visible AND provider-hidden members in one commit", async () => {
    const onChange = vi.fn();
    const { findByTestId } = mount(<ArchitectureStudio defaultValue={doc} onChange={onChange} />);

    fireEvent.click(await findByTestId("zone-resize"));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls.at(-1)![0] as DiagramTemplate;

    expect(next.zones![0]).toMatchObject({ x: 100, y: 100, w: 800, h: 600 });
    const a = next.nodes.find((n) => n.id === "a")!;
    expect(a).toMatchObject({ x: 200, y: 200, w: 340, h: 152 });
    // The invisible member scaled identically — the ghost-mode invariant.
    const hid = next.nodes.find((n) => n.id === "hid")!;
    expect(hid).toMatchObject({ x: 300, y: 300, w: 340, h: 152 });
  });
});
