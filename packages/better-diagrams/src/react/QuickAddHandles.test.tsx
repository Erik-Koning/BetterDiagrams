/**
 * @vitest-environment jsdom
 *
 * The side arrows off a selected card, through the real editor. Where the new
 * box lands is quick-add.test.ts's; this is that the arrows show when they
 * should, and that a click adds a wired, selected, nameable box.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ArchitectureStudio } from "./ArchitectureStudio";
import { clearWelcomeSuppression } from "./WelcomeModal";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";

vi.mock("./JsonCodeEditor", () => ({
  JsonCodeEditor: ({ value, ariaLabel }: { value: string; ariaLabel?: string }) => (
    <textarea aria-label={ariaLabel ?? "Diagram JSON"} value={value} readOnly />
  ),
}));

const DOC = validateTemplate({
  version: 1,
  nodes: [
    { id: "api", label: "API", kind: "service", x: 0, y: 0, w: 170, h: 76 },
    { id: "db", label: "DB", kind: "database", x: 0, y: 400 },
    { id: "vpc", label: "VPC", kind: "group", x: 600, y: 0, w: 320, h: 240 },
  ],
  edges: [],
});

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

const arrows = () => screen.queryAllByRole("button", { name: /^Add a connected / });

beforeEach(() => clearWelcomeSuppression());

describe("quick-add arrows", () => {
  it("stand off all four sides of a selected card, and add a wired box on the side clicked", async () => {
    const onChange = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={DOC} onChange={onChange} />);
    await waitFor(() => expect(container.querySelector('[data-id="api"]')).toBeTruthy());
    expect(arrows()).toHaveLength(0);

    fireEvent.click(container.querySelector('[data-id="api"]')!);
    await waitFor(() => expect(arrows()).toHaveLength(4));
    expect(arrows().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Add a connected Service above",
      "Add a connected Service to the right",
      "Add a connected Service below",
      "Add a connected Service to the left",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Add a connected Service to the right" }));

    await waitFor(() => {
      const t = onChange.mock.calls.at(-1)?.[0] as DiagramTemplate | undefined;
      expect(t?.nodes).toHaveLength(4);
    });
    const t = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    const added = t.nodes.find((n) => !["api", "db", "vpc"].includes(n.id))!;
    expect(added).toMatchObject({ kind: "service", x: 260, y: 0 });
    expect(t.edges).toEqual([expect.objectContaining({ source: "api", target: added.id })]);

    // Selected, so the arrows move on to it, and its name is open to type.
    await waitFor(() => expect(container.querySelector(`[data-id="${added.id}"] input[aria-label="Name"]`)).toBeTruthy());
    await waitFor(() =>
      expect(container.querySelector(".as-quick-add")?.getAttribute("data-id")).toBe(added.id),
    );
  });

  it("add inside the card's frame, and the frame grows to hold the new box", async () => {
    const onChange = vi.fn();
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "vpc", label: "VPC", kind: "group", x: 0, y: 0, w: 320, h: 240 },
        { id: "api", label: "API", kind: "service", parentId: "vpc", x: 28, y: 52, w: 170, h: 76 },
      ],
      edges: [],
    });
    const { container } = mount(<ArchitectureStudio defaultValue={doc} onChange={onChange} />);
    await waitFor(() => expect(container.querySelector('[data-id="api"]')).toBeTruthy());
    fireEvent.click(container.querySelector('[data-id="api"]')!);
    fireEvent.click(await screen.findByRole("button", { name: "Add a connected Service to the right" }));

    await waitFor(() => expect((onChange.mock.calls.at(-1)?.[0] as DiagramTemplate | undefined)?.nodes).toHaveLength(3));
    const t = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    const added = t.nodes.find((n) => n.id !== "api" && n.id !== "vpc")!;
    expect(added).toMatchObject({ parentId: "vpc", x: 288, y: 52 });
    expect(t.nodes.find((n) => n.id === "vpc")).toMatchObject({ x: 0, y: 0, w: 288 + 170 + 28 });
  });

  it("are not offered on a frame, or on a diagram that cannot be edited", async () => {
    const { container, unmount } = mount(<ArchitectureStudio defaultValue={DOC} />);
    await waitFor(() => expect(container.querySelector('[data-id="vpc"]')).toBeTruthy());
    fireEvent.click(container.querySelector('[data-id="vpc"]')!);
    await waitFor(() => expect(container.querySelector('[data-id="vpc"].selected')).toBeTruthy());
    expect(arrows()).toHaveLength(0);
    unmount();

    const ro = mount(<ArchitectureStudio defaultValue={DOC} readOnly />);
    await waitFor(() => expect(ro.container.querySelector('[data-id="api"]')).toBeTruthy());
    fireEvent.click(ro.container.querySelector('[data-id="api"]')!);
    await waitFor(() => expect(ro.container.querySelector('[data-id="api"].selected')).toBeTruthy());
    expect(arrows()).toHaveLength(0);
  });
});
