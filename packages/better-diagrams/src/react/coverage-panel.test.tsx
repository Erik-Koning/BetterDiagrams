/**
 * @vitest-environment jsdom
 *
 * coverage-panel.test.tsx — the key-coverage panel: the header percentage,
 * chosen and candidate bars, hover dimming, the smallest set, scope, and
 * the ref/prop surface.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArchitectureStudio, type StudioHandle } from "./ArchitectureStudio";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";

afterEach(cleanup);

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

const table = (id: string, label: string, fields: Array<{ id: string; name: string; key?: string }>, x: number) => ({
  id, label, kind: "table", icon: "none", description: "", parentId: null, x, y: 100, w: 230, h: 120, fields,
});
/** users ← orders.user_id ; orders ← items.order_id ; logs alone. */
const MODEL: DiagramTemplate = validateTemplate({
  version: 1,
  nodes: [
    table("users", "Users", [{ id: "id", name: "id", key: "pk" }], 100),
    table("orders", "Orders", [{ id: "id", name: "id", key: "pk" }, { id: "user_id", name: "user_id", key: "fk" }], 500),
    table("items", "Items", [{ id: "id", name: "id", key: "pk" }, { id: "order_id", name: "order_id", key: "fk" }], 900),
    table("logs", "Logs", [{ id: "id", name: "id", key: "pk" }], 1300),
  ],
  edges: [
    { id: "o-u", source: "orders", target: "users", label: "", style: "solid", color: "slate", startField: "user_id", endField: "id" },
    { id: "i-o", source: "items", target: "orders", label: "", style: "solid", color: "slate", startField: "order_id", endField: "id" },
  ],
});
const dimmed = (container: HTMLElement, id: string) =>
  container.querySelector(`.react-flow__node[data-id="${id}"] .as-node--dimmed`) !== null;

describe("key coverage panel", () => {
  it("opens from the View menu and the ref; scores keys; hover previews; Escape closes", async () => {
    const user = userEvent.setup();
    const ref = { current: null as StudioHandle | null };
    const onCoverageChange = vi.fn();
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={MODEL} onCoverageChange={onCoverageChange} />);
    expect(onCoverageChange).toHaveBeenCalledWith([]);

    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(screen.getByRole("menuitem", { name: /Key coverage/ }));
    const panel = await screen.findByRole("region", { name: "Key coverage" });
    expect(within(panel).getByText("0%")).toBeInTheDocument();
    expect(within(panel).getByText(/0 of 4 tables · 0 keys/)).toBeInTheDocument();
    expect(within(panel).getByText(/1 table no key reaches/)).toBeInTheDocument();
    const candidates = within(panel).getByRole("region", { name: "Candidate keys" });
    expect(within(candidates).getAllByRole("button")).toHaveLength(2);
    // Nothing chosen, nothing hovered: no dimming yet.
    expect(dimmed(container, "logs")).toBe(false);

    // Hovering a candidate previews what it would reach.
    fireEvent.mouseEnter(within(candidates).getByRole("button", { name: /Orders · user_id/ }));
    await waitFor(() => expect(dimmed(container, "items")).toBe(true));
    expect(dimmed(container, "users")).toBe(false);
    fireEvent.mouseLeave(within(candidates).getByRole("button", { name: /Orders · user_id/ }));
    await waitFor(() => expect(dimmed(container, "items")).toBe(false));

    // Choosing it scores 2 of 4 and dims the rest.
    fireEvent.click(within(candidates).getByRole("button", { name: /Orders · user_id/ }));
    await waitFor(() => expect(within(panel).getByText("50%")).toBeInTheDocument());
    expect(onCoverageChange).toHaveBeenLastCalledWith([{ nodeId: "orders", fieldId: "user_id" }]);
    expect(ref.current!.getCoverageKeys()).toEqual([{ nodeId: "orders", fieldId: "user_id" }]);
    const chosen = within(panel).getByRole("region", { name: "Chosen keys" });
    expect(within(chosen).getByRole("button", { name: /Orders · user_id/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(chosen).getByRole("button", { name: /Orders · user_id/ })).toHaveTextContent("+2 · 50%");
    await waitFor(() => expect(dimmed(container, "logs")).toBe(true));
    expect(dimmed(container, "items")).toBe(true);
    expect(dimmed(container, "users")).toBe(false);

    // Dropping it from the chosen list.
    fireEvent.click(within(chosen).getByRole("button", { name: /Orders · user_id/ }));
    await waitFor(() => expect(within(panel).getByText("0%")).toBeInTheDocument());

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Key coverage" })).not.toBeInTheDocument());
    await waitFor(() => expect(dimmed(container, "logs")).toBe(false));
    ref.current!.openCoverage();
    expect(await screen.findByRole("region", { name: "Key coverage" })).toBeInTheDocument();
  });

  it("is not offered in the View menu for a document with no tables; the ref still opens it", async () => {
    const user = userEvent.setup();
    const ref = { current: null as StudioHandle | null };
    const services: DiagramTemplate = validateTemplate({
      version: 1,
      nodes: [
        { id: "api", label: "API", kind: "service", icon: "none", description: "", parentId: null, x: 100, y: 100, w: 200, h: 100 },
        { id: "db", label: "DB", kind: "database", icon: "none", description: "", parentId: null, x: 500, y: 100, w: 200, h: 100 },
      ],
      edges: [{ id: "a-d", source: "api", target: "db", label: "", style: "solid", color: "slate" }],
    });
    mount(<ArchitectureStudio ref={ref} defaultValue={services} />);
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(screen.queryByRole("menuitem", { name: /Key coverage/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Keys")).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    ref.current!.openCoverage();
    expect(await screen.findByRole("region", { name: "Key coverage" })).toBeInTheDocument();
  });

  it("finds the smallest set and says it is proven; scope from a selected table; keys prune", async () => {
    const ref = { current: null as StudioHandle | null };
    const { container, rerender } = mount(<ArchitectureStudio ref={ref} defaultValue={MODEL} />);
    ref.current!.openCoverage();
    const panel = await screen.findByRole("region", { name: "Key coverage" });
    fireEvent.click(within(panel).getByRole("button", { name: "Find smallest set" }));
    await waitFor(() => expect(within(panel).getByText("75%")).toBeInTheDocument());
    expect(within(panel).getByText(/Smallest set, proven/)).toBeInTheDocument();
    expect(ref.current!.getCoverageKeys()).toHaveLength(2);
    expect(within(panel).getByText(/Every key is chosen/)).toBeInTheDocument();

    // Scope from the selected table: only what its keys reach from there.
    expect(within(panel).getByRole("button", { name: "From a table" })).toBeDisabled();
    fireEvent.click(container.querySelector('.react-flow__node[data-id="items"]')!);
    await waitFor(() => expect(within(panel).getByRole("button", { name: "From Items" })).toBeEnabled());
    fireEvent.click(within(panel).getByRole("button", { name: "From Items" }));
    await waitFor(() => expect(within(panel).getByText(/3 of 4 tables/)).toBeInTheDocument());
    fireEvent.click(within(panel).getByRole("button", { name: "All tables" }));

    // Keys through the ref, deduplicated; a key whose table leaves the document is pruned.
    ref.current!.setCoverageKeys([{ nodeId: "items", fieldId: "order_id" }, { nodeId: "items", fieldId: "order_id" }]);
    await waitFor(() => expect(ref.current!.getCoverageKeys()).toEqual([{ nodeId: "items", fieldId: "order_id" }]));
    rerender(<ArchitectureStudio ref={ref} defaultValue={MODEL} value={{ ...MODEL, nodes: MODEL.nodes.filter((n) => n.id !== "items"), edges: MODEL.edges.filter((e) => e.source !== "items") }} />);
    await waitFor(() => expect(ref.current!.getCoverageKeys()).toEqual([]));
  });
});
