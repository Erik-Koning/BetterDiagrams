/**
 * @vitest-environment jsdom
 *
 * The roadmap's ruler and gridlines, placed from React Flow's transform.
 * Which ticks exist is roadmap.test.ts's; this is where they land on screen.
 */
import { useLayoutEffect } from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { RoadmapBackdrop, RoadmapRuler } from "./RoadmapChrome";

const AXIS = { from: "2026-03-01", dayWidth: 10 };

function At({ transform }: { transform: [number, number, number] }) {
  const store = useStoreApi();
  useLayoutEffect(() => store.setState({ transform }), [store, transform]);
  return null;
}

function mount(ui: React.ReactElement, transform: [number, number, number] = [0, 0, 1]) {
  return render(
    <ReactFlowProvider initialWidth={1000} initialHeight={600}>
      <At transform={transform} />
      {ui}
    </ReactFlowProvider>,
  );
}

const units = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>(".as-roadmap-ruler__unit")].map((el) => [el.textContent, el.style.left]);

describe("RoadmapRuler", () => {
  it("names each week where it begins, the first with its year, the strong line on a new month", () => {
    const { container } = mount(<RoadmapRuler axis={AXIS} today="2026-09-01" />, [100, 0, 1]);
    // Mar 2 is day 1: x 10, on screen 110. The week of Feb 16 starts off screen,
    // too close to the next to keep its name.
    expect(units(container).slice(0, 3)).toEqual([
      ["Feb 23 ’26", "40px"],
      ["Mar 2", "110px"],
      ["Mar 9", "180px"],
    ]);
    expect(container.querySelector(".as-roadmap-ruler__unit--major")?.textContent).toBe("Mar 2");
  });

  it("marks today, and leaves out a name the marker would cover", () => {
    const { container } = mount(<RoadmapRuler axis={AXIS} today="2026-03-04" />, [100, 0, 1]);
    // Mar 4 is day 3: its middle is x 35, on screen 135 — over Mar 2's name at 110.
    expect(container.querySelector<HTMLElement>(".as-roadmap-ruler__today")?.style.left).toBe("135px");
    expect(units(container).slice(0, 2)).toEqual([
      ["Feb 23 ’26", "40px"],
      ["Mar 9", "180px"],
    ]);
  });

  it("leaves out a name that would run into the one before it", () => {
    // 8px a day: weeks 56px apart, and the first name, with its year, needs more — so Mar 9 gives way.
    const { container } = mount(<RoadmapRuler axis={{ ...AXIS, dayWidth: 8 }} today="2026-09-01" />, [0, 0, 1]);
    expect(units(container).slice(0, 3)).toEqual([
      ["Mar 2 ’26", "8px"],
      ["Mar 16", "120px"],
      ["Mar 23", "176px"],
    ]);
  });

  it("pins the name of the week the left edge falls in, when there is room for it", () => {
    const { container } = mount(<RoadmapRuler axis={AXIS} today="2026-09-01" />, [-15, 0, 1]);
    expect(units(container).slice(0, 2)).toEqual([
      ["Mar 2 ’26", "0px"],
      ["Mar 9", "65px"],
    ]);
    expect(container.querySelector(".as-roadmap-ruler__unit--pinned")?.textContent).toBe("Mar 2 ’26");
  });

  it("goes to months zoomed out, and labels the Unscheduled column when there is one", () => {
    const { container } = mount(<RoadmapRuler axis={AXIS} today="2027-06-01" unscheduledEdge={-48} />, [100, 0, 0.25]);
    // The calendar starts at the column's edge (screen 88): January began
    // left of it, and February too close to it, so March names the year.
    expect(units(container).slice(0, 2)).toEqual([
      ["Mar ’26", "100px"],
      ["Apr", "177.5px"],
    ]);
    // -48 × 0.25 + 100 = 88 from the left; 1000 − 88 from the right.
    expect(container.querySelector<HTMLElement>(".as-roadmap-ruler__unscheduled")?.style.right).toBe("912px");
    // Today is off screen to the right.
    expect(container.querySelector(".as-roadmap-ruler__today")).toBeNull();
  });
});

describe("RoadmapBackdrop", () => {
  it("draws no lines over the Unscheduled column", () => {
    const { container } = mount(<RoadmapBackdrop axis={AXIS} today="2026-03-04" unscheduledEdge={-48} />, [100, 0, 1]);
    const lines = [...container.querySelectorAll(".as-roadmap-backdrop__line")].map((l) => l.getAttribute("x1"));
    // The edge is at screen 52: the week of Feb 23 (screen 40) began left of it.
    expect(lines.slice(0, 2)).toEqual(["110.5", "180.5"]);
  });

  it("draws a crisp line where each unit begins, and the today line", () => {
    const { container } = mount(<RoadmapBackdrop axis={AXIS} today="2026-03-04" />, [100, 0, 1]);
    const lines = [...container.querySelectorAll(".as-roadmap-backdrop__line")].map((l) => l.getAttribute("x1"));
    // The week of Feb 16 began off screen to the left.
    expect(lines.slice(0, 3)).toEqual(["40.5", "110.5", "180.5"]);
    expect(container.querySelector(".as-roadmap-backdrop__today")?.getAttribute("x1")).toBe("135");
  });
});
