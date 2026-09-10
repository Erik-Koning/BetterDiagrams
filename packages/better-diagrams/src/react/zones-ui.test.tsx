/**
 * @vitest-environment jsdom
 *
 * Adding and moving an infra zone.
 *
 * A zone is a BACKDROP: it paints behind everything and its body is
 * click-through, so a press inside it reaches the node on top. That left the
 * small chip at its top-left corner as the only way to pick a region up —
 * and a newly inserted zone was dropped dead-centre in the viewport, where
 * that chip could land under the toolbar or past the edge of the canvas.
 * The region could then not be moved at all.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArchitectureStudio, placeNewZone, zoneDragMembers } from "./ArchitectureStudio";
import { validateTemplate, ZONE_DRAG_HANDLE, type DiagramTemplate } from "../contract/schema";

vi.mock("./JsonCodeEditor", () => ({
  JsonCodeEditor: () => <textarea aria-label="Diagram JSON" />,
}));

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

/** A roomy viewport, so size-to-fit is not what is under test. */
const VIEW = { x: 0, y: 0, w: 1600, h: 1000 };
const BOUNDS = { minX: 0, minY: 0, maxX: 600, maxY: 400 };
const box = (x: number, y: number, w = 180, h = 80) => ({ x, y, w, h });

describe("placeNewZone", () => {
  it("takes the top-left corner of the view when nothing is in the way", () => {
    const spot = placeNewZone(VIEW, [], BOUNDS);
    expect({ x: spot.x, y: spot.y }).toEqual({ x: 24, y: 24 });
    expect(spot.offscreen).toBe(false);
  });

  it("steps to the next corner rather than landing on a node", () => {
    // A node parked in the top-left corner pushes the zone to the top-right.
    const spot = placeNewZone(VIEW, [box(30, 30)], BOUNDS);
    expect(spot.x).toBeGreaterThan(VIEW.w / 2);
    expect(spot.y).toBe(24);
  });

  it("never overlaps anything it was told about", () => {
    const occupied = [box(30, 30), box(1300, 40), box(60, 800)];
    const spot = placeNewZone(VIEW, occupied, BOUNDS);
    for (const o of occupied) {
      const clear =
        spot.x + spot.w <= o.x || o.x + o.w <= spot.x || spot.y + spot.h <= o.y || o.y + o.h <= spot.y;
      expect(clear, `overlaps ${JSON.stringify(o)}`).toBe(true);
    }
  });

  it("shrinks to fit a viewport too small to hold the default box", () => {
    // The bug this guards: the view used to be clamped UP to the zone's own
    // size, so a viewport that could not hold the zone reported that it
    // could — and the bottom corners were computed off the edge of the
    // screen, taking the drag chip with them.
    const tight = { x: 0, y: 0, w: 600, h: 300 };
    const spot = placeNewZone(tight, [], BOUNDS);
    expect(spot.w).toBeLessThanOrEqual(tight.w - 48);
    expect(spot.h).toBeLessThanOrEqual(tight.h - 48);
    expect(spot.x + spot.w).toBeLessThanOrEqual(tight.x + tight.w);
    expect(spot.y + spot.h).toBeLessThanOrEqual(tight.y + tight.h);
  });

  it("keeps a floor on the size, however cramped the view", () => {
    const spot = placeNewZone({ x: 0, y: 0, w: 40, h: 30 }, [], BOUNDS);
    expect(spot.w).toBeGreaterThanOrEqual(240);
    expect(spot.h).toBeGreaterThanOrEqual(160);
  });

  it("goes below the diagram, and says so, when every corner is taken", () => {
    // Four nodes, one parked in each corner of the view.
    const occupied = [
      box(24, 24, 600, 400),
      box(1000, 24, 600, 400),
      box(24, 600, 600, 400),
      box(1000, 600, 600, 400),
    ];
    const spot = placeNewZone(VIEW, occupied, BOUNDS);
    expect(spot.offscreen).toBe(true);
    expect(spot.y).toBeGreaterThan(BOUNDS.maxY);
  });
});

describe("zoneDragMembers", () => {
  /** `zoneId` is what makes a node a member; `parentId` is nesting. */
  const n = (id: string, zoneId: string | null, parentId?: string) =>
    ({ id, zoneId, parentId: parentId ?? null }) as never;

  it("takes every node the zone owns", () => {
    expect(zoneDragMembers([n("a", "r"), n("b", "r"), n("c", null)], "r").sort()).toEqual(["a", "b"]);
  });

  it("leaves a child out when its container is coming too", () => {
    // React Flow stores a child's position relative to its container, so a
    // child moves for free — applying the delta to both moves it twice.
    const nodes = [n("grp", "r"), n("kid", "r", "grp"), n("loose", "r")];
    expect(zoneDragMembers(nodes, "r").sort()).toEqual(["grp", "loose"]);
  });

  it("keeps a child whose container belongs to a DIFFERENT zone", () => {
    // The container is not moving, so the child has to be moved itself.
    const nodes = [n("grp", "other"), n("kid", "r", "grp")];
    expect(zoneDragMembers(nodes, "r")).toEqual(["kid"]);
  });

  it("is empty for a zone that owns nothing", () => {
    expect(zoneDragMembers([n("a", "other"), n("b", null)], "r")).toEqual([]);
  });

  it("leaves out a member that is not on the canvas being dragged", () => {
    // A node on a drilled-in level keeps its declared zone while its
    // coordinates are in its PARENT's space. Moving it by a root-space delta
    // would shove it across a level nobody is looking at.
    const nodes = [n("here", "r"), n("elsewhere", "r")];
    expect(zoneDragMembers(nodes, "r", new Set(["here"]))).toEqual(["here"]);
  });

  it("still de-nests against members the canvas is not showing", () => {
    // The container is off-canvas so it is not moving; its on-canvas child
    // therefore has to be moved on its own.
    const nodes = [n("grp", "r"), n("kid", "r", "grp")];
    expect(zoneDragMembers(nodes, "r", new Set(["kid"]))).toEqual(["kid"]);
  });
});

describe("inserting a zone", () => {
  const doc: DiagramTemplate = validateTemplate({
    version: 1,
    nodes: [{ id: "a", label: "Alpha", kind: "service", x: 40, y: 40, w: 180, h: 76 }],
    edges: [],
  });

  it("leaves the new zone selected, so it can be moved straight away", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio value={doc} onChange={onChange} welcome={false} />,
    );

    await user.click(screen.getByRole("button", { name: /^Insert/ }));
    await user.click(screen.getByRole("menuitem", { name: /^Zone/ }));

    await waitFor(() => {
      const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
      expect(latest.zones).toHaveLength(1);
    });
    // The rebuild that follows the insert used to replace every node object
    // and drop the selection with it, so the zone came back unpicked.
    await waitFor(() =>
      expect(container.querySelector('.react-flow__node[data-id^="zone:"].selected')).toBeTruthy(),
    );
  });
});

describe("the zone drag surface", () => {
  const zoned: DiagramTemplate = validateTemplate({
    version: 1,
    nodes: [],
    edges: [],
    zones: [
      {
        id: "r",
        label: "Region",
        shape: "rounded",
        x: 0,
        y: 0,
        w: 400,
        h: 300,
        providers: ["aws"],
        provider: "aws",
      },
    ],
  });

  it("puts the drag class on the header chip, always", () => {
    const { container } = mount(<ArchitectureStudio value={zoned} welcome={false} />);
    const header = container.querySelector<HTMLElement>(".as-zone__header")!;
    expect(header.classList.contains("as-zone__grab")).toBe(true);
    // The class the renderer paints and the one both node builders name have
    // to be the same string, or a zone becomes undraggable.
    expect(ZONE_DRAG_HANDLE).toBe(".as-zone__grab");
    // And the drag marker carries NO geometry of its own. It is worn by two
    // elements with nothing in common — a chip that hugs its content at the
    // top-left, and a pad that fills the region — so a box declared on it
    // stretched the chip across the whole zone.
    const grabRule = [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules];
        } catch {
          return [];
        }
      })
      .filter((r): r is CSSStyleRule => r instanceof CSSStyleRule)
      .find((r) => r.selectorText === ".as-zone__grab");
    if (grabRule) {
      for (const prop of ["position", "inset", "top", "right", "bottom", "left", "width", "height"]) {
        expect(grabRule.style.getPropertyValue(prop), `${prop} on .as-zone__grab`).toBe("");
      }
    }
    // The pad is the element that owns the geometry, and only it.
    expect(header.classList.contains("as-zone__pad")).toBe(false);
  });

  it("lays the interior pad from the start, so the first press already drags", async () => {
    const { container } = mount(<ArchitectureStudio value={zoned} welcome={false} />);
    const pads = () => container.querySelectorAll(".as-zone__pad").length;
    // Not "once selected": a region picks up on mouse down like a node, with
    // no click to select it first.
    expect(pads()).toBe(1);
    expect(container.querySelector('.react-flow__node[data-id^="zone:"].selected')).toBeNull();

    // And it stays put once the zone IS selected.
    await userEvent.setup().click(container.querySelector<HTMLElement>(".as-zone__header")!);
    await waitFor(() =>
      expect(container.querySelector('.react-flow__node[data-id^="zone:"].selected')).toBeTruthy(),
    );
    expect(pads()).toBe(1);
  });

  it("gives a locked zone no drag surface", () => {
    const locked = validateTemplate({
      ...zoned,
      zones: [{ ...zoned.zones![0], locked: true }],
    });
    const { container } = mount(<ArchitectureStudio value={locked} welcome={false} />);
    expect(container.querySelectorAll(".as-zone__pad")).toHaveLength(0);
  });

  it("offers no drag surface at all in read-only mode", async () => {
    const { container } = mount(<ArchitectureStudio value={zoned} readOnly welcome={false} />);
    const header = container.querySelector<HTMLElement>(".as-zone__header")!;
    await userEvent.setup().click(header);
    expect(container.querySelectorAll(".as-zone__pad")).toHaveLength(0);
  });
});
