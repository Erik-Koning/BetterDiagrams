/**
 * @vitest-environment jsdom
 *
 * field-pins.test.tsx — clicking a row opens the field menu; pinning marks
 * the row, fills the strip, reaches the host, survives drilling, and is
 * pruned when the node goes away.
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const table = (id: string, label: string, fields: Array<{ id: string; name: string; key?: string; type?: string }>, x: number, over: Record<string, unknown> = {}) => ({
  id, label, kind: "table", icon: "none", description: "", parentId: null, x, y: 100, w: 230, h: 120, fields, ...over,
});

const MODEL: DiagramTemplate = validateTemplate({
  version: 1,
  meta: { title: "Shop" },
  nodes: [
    table("users", "Users", [{ id: "id", name: "id", key: "pk" }, { id: "email", name: "email", type: "text" }], 100),
    table("orders", "Orders", [{ id: "id", name: "id", key: "pk" }, { id: "user_id", name: "user_id", key: "fk", type: "→ users" }], 500, {
      data: { fields: [{ name: "id", type: "uuid" }, { name: "user_id", type: "uuid", relationship: { kind: "lookup", referenceTo: ["Users"] } }, { name: "total", type: "money" }] },
    }),
    table("items", "Items", [{ id: "id", name: "id", key: "pk" }, { id: "order_id", name: "order_id", key: "fk" }], 900),
    table("logs", "Logs", [{ id: "id", name: "id", key: "pk" }], 1300),
  ],
  edges: [
    { id: "o-u", source: "orders", target: "users", label: "", style: "solid", color: "slate", startField: "user_id", endField: "id" },
    { id: "i-o", source: "items", target: "orders", label: "", style: "solid", color: "slate", startField: "order_id", endField: "id" },
  ],
});

const row = (container: HTMLElement, nodeId: string, fieldId: string) =>
  container.querySelector(`.react-flow__node[data-id="${nodeId}"] .as-node__field[data-field-id="${fieldId}"]`) as HTMLElement;

describe("field rows and pins", () => {
  it("a row click opens the field menu, selects the node once, and never opens the node menu", async () => {
    const onSelectionChange = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} onSelectionChange={onSelectionChange} />);
    const r = row(container, "orders", "user_id");
    expect(r.classList.contains("nodrag")).toBe(true);
    fireEvent.click(r);
    const menu = await screen.findByRole("menu", { name: "Actions" });
    expect(within(menu).getByText(/Orders · user_id/)).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Pin for search/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "View all fields" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Follow reference/ })).toBeInTheDocument();
    // Hand-authored document: the row is editable.
    expect(within(menu).getByRole("menuitem", { name: "Edit…" })).toBeInTheDocument();
    await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith({ nodes: ["orders"], edges: [], zones: [] }));
    const selects = onSelectionChange.mock.calls.filter((c) => c[0].nodes.includes("orders"));
    expect(selects).toHaveLength(1);
  });

  it("pinning marks the row, shows the strip, reaches the host and the ref, and unpins", async () => {
    const ref = { current: null as StudioHandle | null };
    const onPinsChange = vi.fn();
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={MODEL} onPinsChange={onPinsChange} />);
    expect(onPinsChange).toHaveBeenCalledWith([]);
    expect(screen.queryByRole("toolbar", { name: "Pinned fields" })).not.toBeInTheDocument();

    fireEvent.click(row(container, "orders", "user_id"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Actions" })).getByRole("menuitem", { name: /Pin for search/ }));
    await waitFor(() => expect(row(container, "orders", "user_id").classList.contains("as-node__field--pinned")).toBe(true));
    expect(onPinsChange).toHaveBeenLastCalledWith([{ nodeId: "orders", fieldId: "user_id" }]);
    expect(ref.current!.getPins()).toEqual([{ nodeId: "orders", fieldId: "user_id" }]);
    const strip = screen.getByRole("toolbar", { name: "Pinned fields" });
    expect(within(strip).getByRole("button", { name: "Orders · user_id" })).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: "Show paths" })).toBeDisabled();

    // A second pin through the ref enables Show paths; the menu now offers Unpin.
    ref.current!.setPins([{ nodeId: "orders", fieldId: "user_id" }, { nodeId: "users", fieldId: "id" }, { nodeId: "users", fieldId: "id" }]);
    await waitFor(() => expect(within(strip).getByRole("button", { name: "Show paths" })).toBeEnabled());
    expect(ref.current!.getPins()).toHaveLength(2);
    fireEvent.click(row(container, "users", "id"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Actions" })).getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(ref.current!.getPins()).toEqual([{ nodeId: "orders", fieldId: "user_id" }]));

    fireEvent.click(within(strip).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Pinned fields" })).not.toBeInTheDocument());
    expect(onPinsChange).toHaveBeenLastCalledWith([]);
  });

  it("a pin is pruned when its node leaves the document", async () => {
    const ref = { current: null as StudioHandle | null };
    const onPinsChange = vi.fn();
    function Host() {
      const [doc, setDoc] = useState(MODEL);
      return (
        <>
          <button type="button" onClick={() => setDoc({ ...doc, nodes: doc.nodes.filter((n) => n.id !== "items"), edges: doc.edges.filter((e) => e.source !== "items") })}>
            drop items
          </button>
          <ArchitectureStudio ref={ref} value={doc} onChange={setDoc} onPinsChange={onPinsChange} />
        </>
      );
    }
    mount(<Host />);
    ref.current!.setPins([{ nodeId: "items", fieldId: "order_id" }, { nodeId: "users", fieldId: "id" }]);
    await waitFor(() => expect(onPinsChange).toHaveBeenLastCalledWith([{ nodeId: "items", fieldId: "order_id" }, { nodeId: "users", fieldId: "id" }]));
    fireEvent.click(screen.getByText("drop items"));
    await waitFor(() => expect(ref.current!.getPins()).toEqual([{ nodeId: "users", fieldId: "id" }]));
    expect(onPinsChange).toHaveBeenLastCalledWith([{ nodeId: "users", fieldId: "id" }]);
  });

  it("Edit… is withheld for a folder-imported document; Follow reference navigates", async () => {
    const imported = validateTemplate({ ...MODEL, meta: { title: "Shop", folderFormat: { dialect: "generic", version: 1 } } });
    const onSelectionChange = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={imported} onSelectionChange={onSelectionChange} />);
    fireEvent.click(row(container, "orders", "user_id"));
    const menu = await screen.findByRole("menu", { name: "Actions" });
    expect(within(menu).queryByRole("menuitem", { name: "Edit…" })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Follow reference/ }));
    await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith({ nodes: ["users"], edges: [], zones: [] }));
  });

  it("Follow reference marks both halves of the join — the foreign key and the key it points at", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} />);
    const marked = (nodeId: string, fieldId: string) => row(container, nodeId, fieldId).classList.contains("as-node__field--match");
    fireEvent.click(row(container, "orders", "user_id"));
    const menu = await screen.findByRole("menu", { name: "Actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Follow reference/ }));
    await waitFor(() => expect(marked("users", "id")).toBe(true));
    expect(marked("orders", "user_id")).toBe(true);
    expect(marked("users", "email")).toBe(false);
    // Either table of the pair keeps the marks; anything else lets them go.
    fireEvent.click(container.querySelector('.react-flow__node[data-id="orders"]')!);
    await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="orders"]')!.classList.contains("selected")).toBe(true));
    expect(marked("users", "id")).toBe(true);
    expect(marked("orders", "user_id")).toBe(true);
    fireEvent.click(row(container, "items", "id"));
    await waitFor(() => expect(marked("users", "id")).toBe(false));
    expect(marked("orders", "user_id")).toBe(false);
  });

  it("the grid's Follow reference marks the same pair", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} />);
    const marked = (nodeId: string, fieldId: string) => row(container, nodeId, fieldId).classList.contains("as-node__field--match");
    fireEvent.click(row(container, "orders", "user_id"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Actions" })).getByRole("menuitem", { name: "View all fields" }));
    const grid = await screen.findByRole("dialog");
    fireEvent.click(within(grid).getByRole("button", { name: "Go to Users" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(marked("users", "id")).toBe(true));
    expect(marked("orders", "user_id")).toBe(true);
  });

  it("navigateToField from the ref highlights the row; the highlight clears on a new selection", async () => {
    const ref = { current: null as StudioHandle | null };
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={MODEL} />);
    ref.current!.navigateToField({ nodeId: "users", fieldId: "email" });
    await waitFor(() => expect(row(container, "users", "email").classList.contains("as-node__field--match")).toBe(true));
    fireEvent.click(row(container, "items", "id"));
    await waitFor(() => expect(row(container, "users", "email").classList.contains("as-node__field--match")).toBe(false));
  });

  it("a selected pinned table keeps both its ring and its pin mark", () => {
    const css = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../styles.css"), "utf8") as string;
    const combined = css.match(/\.as-node--selected\.as-node--pinned \{[^}]*\}/)?.[0];
    expect(combined).toBeTruthy();
    expect(combined).toContain("inset 3px 0 0");
    expect(combined).toContain("0 0 0 3px");
  });

  it("rows stay 19px and inert states never change the box", () => {
    const css = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../styles.css"), "utf8") as string;
    const block = css.match(/\.as-node__field \{[^}]*\}/)![0];
    expect(block).toContain("height: 19px");
    for (const m of css.matchAll(/\.as-node__field(?:--[a-z]+|\.nodrag)(?::hover)? \{([^}]*)\}/g)) {
      expect(m[1]).not.toMatch(/\b(height|padding|border(?!-radius))\s*:/);
    }
  });
});

describe("field search and the grid's openers", () => {
  it("matches fields, marks the row on Enter, and opens the grid for a field the node doesn't draw", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} />);
    const input = screen.getByRole("textbox", { name: "Search nodes and fields" });
    fireEvent.change(input, { target: { value: "user_id" } });
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.getByText("Orders · user_id")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(row(container, "orders", "user_id").classList.contains("as-node__field--match")).toBe(true));

    fireEvent.change(input, { target: { value: "total" } });
    expect(screen.getByText(/Orders · total/)).toBeInTheDocument();
    expect(screen.getByText(/not a row/)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", { name: "Orders — fields" });
    expect(within(dialog).getByRole("row", { name: /total/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Orders — fields" })).not.toBeInTheDocument());
  });

  it("the field menu, the node menu and the inspector all open the grid", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} />);
    fireEvent.click(row(container, "orders", "user_id"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Actions" })).getByRole("menuitem", { name: "View all fields" }));
    const dialog = await screen.findByRole("dialog", { name: "Orders — fields" });
    expect(within(dialog).getAllByRole("row")).toHaveLength(4); // header + id, user_id, total
    expect(within(dialog).getByRole("row", { name: /user_id/ })).toHaveAttribute("aria-selected", "true");
    // Following a reference from the grid closes it and lands on the table.
    fireEvent.click(within(dialog).getByRole("button", { name: "Go to Users" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Orders — fields" })).not.toBeInTheDocument());

    // Inspector button, once a record node is selected.
    fireEvent.click(row(container, "users", "email"));
    fireEvent.keyDown(document, { key: "Escape" });
    const button = await screen.findByRole("button", { name: /View all fields \(2\)/ });
    fireEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "Users — fields" })).toBeInTheDocument();
  });
});

describe("paths between pins", () => {
  const nodeEl = (container: HTMLElement, id: string) => container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;

  it("Show paths lights the routes, lists the tables between, hover isolates one, Escape closes", async () => {
    const ref = { current: null as StudioHandle | null };
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={MODEL} />);
    ref.current!.setPins([{ nodeId: "items", fieldId: "order_id" }, { nodeId: "users", fieldId: "id" }]);
    const strip = await screen.findByRole("toolbar", { name: "Pinned fields" });
    fireEvent.click(within(strip).getByRole("button", { name: "Show paths" }));
    const panel = await screen.findByRole("region", { name: "Paths between pinned fields" });
    const route = within(panel).getByRole("button", { name: /Items\.order_id → Orders → Users\.id/ });
    expect(route).toHaveTextContent("2 hops");
    await waitFor(() => expect(nodeEl(container, "orders").classList.contains("as-path-node")).toBe(true));
    expect(nodeEl(container, "logs").classList.contains("as-path-node")).toBe(false);
    const betweenList = within(panel).getByRole("region", { name: "Tables between" });
    expect(within(betweenList).getByRole("button", { name: "Orders" })).toBeInTheDocument();
    expect(screen.getAllByText("Routes").length).toBeGreaterThanOrEqual(2); // panel caption + legend
    // No dimming with two pins.
    expect(nodeEl(container, "logs").querySelector(".as-node--dimmed")).toBeNull();
    // Hover keeps the glow on that route only; leaving restores all.
    fireEvent.mouseEnter(route);
    await waitFor(() => expect(nodeEl(container, "orders").classList.contains("as-path-node")).toBe(true));
    fireEvent.mouseLeave(route);
    // Direction toggle: child → parent only, and items.order_id → users.id still exists that way.
    fireEvent.click(within(panel).getByLabelText("Ignore arrow direction"));
    await waitFor(() => expect(within(panel).getByRole("button", { name: /Items\.order_id → Orders → Users\.id/ })).toBeInTheDocument());
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Paths between pinned fields" })).not.toBeInTheDocument());
    expect(within(strip).getByRole("button", { name: "Show paths" })).toHaveAttribute("aria-pressed", "false");
  });

  it("hides the key ranking with one route — its hop strip already names the keys", async () => {
    const ref = { current: null as StudioHandle | null };
    mount(<ArchitectureStudio ref={ref} defaultValue={MODEL} />);
    ref.current!.setPins([{ nodeId: "items", fieldId: "order_id" }, { nodeId: "users", fieldId: "id" }]);
    const strip = await screen.findByRole("toolbar", { name: "Pinned fields" });
    fireEvent.click(within(strip).getByRole("button", { name: "Show paths" }));
    const panel = await screen.findByRole("region", { name: "Paths between pinned fields" });
    expect(within(panel).getByRole("region", { name: "Routes" }).querySelectorAll(".as-routes__row")).toHaveLength(1);
    expect(within(panel).queryByRole("region", { name: "Keys most routes use" })).not.toBeInTheDocument();
  });

  it("ranks the keys across routes; hover previews the routes through one, click keeps them, never pins", async () => {
    // comment → case → account, and comment → case → contact → account: two
    // routes, ParentId on both, Case.AccountId on the short one alone.
    const t = (id: string, label: string, fields: string[], x: number) =>
      table(id, label, fields.map((f) => ({ id: f, name: f })), x);
    const fk = (id: string, source: string, target: string, field: string) =>
      ({ id, source, target, label: "", style: "solid", color: "slate", startField: field, endField: "Id" });
    const DIAMOND = validateTemplate({
      version: 1,
      nodes: [t("comment", "Comment", ["Id", "ParentId"], 100), t("case", "Case", ["Id", "AccountId", "ContactId"], 500), t("contact", "Contact", ["Id", "AccountId"], 900), t("account", "Account", ["Id"], 1300)],
      edges: [fk("m-k", "comment", "case", "ParentId"), fk("k-a", "case", "account", "AccountId"), fk("k-c", "case", "contact", "ContactId"), fk("c-a", "contact", "account", "AccountId")],
    });
    const ref = { current: null as StudioHandle | null };
    const onPinsChange = vi.fn();
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={DIAMOND} onPinsChange={onPinsChange} />);
    ref.current!.setPins([{ nodeId: "comment", fieldId: "ParentId" }, { nodeId: "account", fieldId: "Id" }]);
    const strip = await screen.findByRole("toolbar", { name: "Pinned fields" });
    fireEvent.click(within(strip).getByRole("button", { name: "Show paths" }));
    const panel = await screen.findByRole("region", { name: "Paths between pinned fields" });
    expect(within(panel).getByRole("region", { name: "Routes" }).querySelectorAll(".as-routes__row")).toHaveLength(2);
    const keys = within(panel).getByRole("region", { name: "Keys most routes use" });
    expect(within(keys).getByRole("button", { name: /Comment · ParentId/ })).toHaveTextContent("2 of 2");
    const caseKey = within(keys).getByRole("button", { name: /Case · AccountId/ });
    expect(caseKey).toHaveTextContent("1 of 2");
    // Both routes lit: contact is on the long one.
    await waitFor(() => expect(nodeEl(container, "contact").classList.contains("as-path-node")).toBe(true));

    // Hover: only the short route, through Case.AccountId, stays lit.
    fireEvent.mouseEnter(caseKey);
    await waitFor(() => expect(nodeEl(container, "contact").classList.contains("as-path-node")).toBe(false));
    expect(nodeEl(container, "case").classList.contains("as-path-node")).toBe(true);
    fireEvent.mouseLeave(caseKey);
    await waitFor(() => expect(nodeEl(container, "contact").classList.contains("as-path-node")).toBe(true));

    // Click keeps it — and adds no pin: the pair view stays.
    fireEvent.click(caseKey);
    expect(caseKey).toHaveAttribute("aria-pressed", "true");
    fireEvent.mouseLeave(caseKey);
    await waitFor(() => expect(nodeEl(container, "contact").classList.contains("as-path-node")).toBe(false));
    expect(ref.current!.getPins()).toHaveLength(2);
    expect(within(panel).getByRole("heading", { name: "Paths between pins" })).toBeInTheDocument();

    // Keeping a route lets the key go, and the other way round.
    const longRoute = within(panel).getByRole("button", { name: /Comment\.ParentId → Case → Contact → Account\.Id/ });
    fireEvent.click(longRoute);
    expect(caseKey).toHaveAttribute("aria-pressed", "false");
    expect(longRoute).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(caseKey);
    expect(longRoute).toHaveAttribute("aria-pressed", "false");
    expect(caseKey).toHaveAttribute("aria-pressed", "true");
    // Clicked again, it lets go: every route lights.
    fireEvent.click(caseKey);
    expect(caseKey).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(nodeEl(container, "contact").classList.contains("as-path-node")).toBe(true));
  });

  it("three pins dim everything outside the kept set, in either mode", async () => {
    const ref = { current: null as StudioHandle | null };
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={MODEL} />);
    ref.current!.setPins([{ nodeId: "items", fieldId: "order_id" }, { nodeId: "users", fieldId: "id" }, { nodeId: "orders", fieldId: "user_id" }]);
    const strip = await screen.findByRole("toolbar", { name: "Pinned fields" });
    fireEvent.click(within(strip).getByRole("button", { name: "Show paths" }));
    const panel = await screen.findByRole("region", { name: "Paths between pinned fields" });
    expect(within(panel).getByRole("heading", { name: "Between 3 pins" })).toBeInTheDocument();
    await waitFor(() => expect(nodeEl(container, "logs").querySelector(".as-node--dimmed")).not.toBeNull());
    expect(nodeEl(container, "users").querySelector(".as-node--dimmed")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Reachable" }));
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Reachable" })).toHaveAttribute("aria-pressed", "true"));
    expect(nodeEl(container, "logs").querySelector(".as-node--dimmed")).not.toBeNull();
    expect(within(panel).getByText("Reachable from the pins")).toBeInTheDocument();
    // Dropping to one pin closes the panel and lifts the dimming.
    ref.current!.setPins([{ nodeId: "users", fieldId: "id" }]);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Paths between pinned fields" })).not.toBeInTheDocument());
    await waitFor(() => expect(nodeEl(container, "logs").querySelector(".as-node--dimmed")).toBeNull());
  });
});

describe("table pins and hop keys", () => {
  it("the node menu pins a whole table; routes show the key on each hop", async () => {
    const ref = { current: null as StudioHandle | null };
    const onPinsChange = vi.fn();
    const { container } = mount(<ArchitectureStudio ref={ref} defaultValue={MODEL} onPinsChange={onPinsChange} />);
    fireEvent.contextMenu(container.querySelector('.react-flow__node[data-id="users"]')!);
    const menu = await screen.findByRole("menu", { name: "Actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Pin table for search/ }));
    await waitFor(() => expect(onPinsChange).toHaveBeenLastCalledWith([{ nodeId: "users" }]));
    await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="users"] .as-node--pinned')).not.toBeNull());
    const strip = screen.getByRole("toolbar", { name: "Pinned fields" });
    expect(within(strip).getByRole("button", { name: "Users" })).toBeInTheDocument();

    ref.current!.setPins([{ nodeId: "items", fieldId: "order_id" }, { nodeId: "users" }]);
    await waitFor(() => expect(within(strip).getByRole("button", { name: "Show paths" })).toBeEnabled());
    fireEvent.click(within(strip).getByRole("button", { name: "Show paths" }));
    const panel = await screen.findByRole("region", { name: "Paths between pinned fields" });
    const route = within(panel).getByRole("button", { name: /Items\.order_id → Orders → Users/ });
    expect(route).toHaveTextContent("order_id▸user_id");
    // One route lit alone is drawn in the bright route colour, with the key on each hop.
    fireEvent.mouseEnter(route);
    await waitFor(() =>
      expect([...container.querySelectorAll(".as-edge__routekeytext")].map((el) => el.textContent).sort()).toEqual(["order_id", "user_id"]),
    );
    expect((container.querySelector('.react-flow__node[data-id="orders"]') as HTMLElement).style.getPropertyValue("--as-path-ink")).toBe("var(--as-route)");
    // The only route between these pins stays singled out — and bright — when the pointer leaves.
    fireEvent.mouseLeave(route);
    expect(within(panel).getByRole("region", { name: "Routes" }).querySelectorAll(".as-routes__row")).toHaveLength(1);
    expect(container.querySelector(".as-edge__routekeytext")).not.toBeNull();
    expect(within(panel).queryByText(/anchors no line/)).not.toBeInTheDocument();

    // Unpin the table from its menu.
    fireEvent.contextMenu(container.querySelector('.react-flow__node[data-id="users"]')!);
    const menu2 = await screen.findByRole("menu", { name: "Actions" });
    fireEvent.click(await within(menu2).findByRole("menuitem", { name: /Unpin table/ }));
    await waitFor(() => expect(ref.current!.getPins()).toEqual([{ nodeId: "items", fieldId: "order_id" }]));
  });
});

describe("show references — a key's other direction", () => {
  it("marks the key, every foreign-key row pointing at it, and the tables they sit in", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} />);
    const marked = (nodeId: string, fieldId: string) => row(container, nodeId, fieldId).classList.contains("as-node__field--match");
    const card = (nodeId: string) => container.querySelector(`.react-flow__node[data-id="${nodeId}"] .as-node`)!;
    fireEvent.click(row(container, "users", "id"));
    const menu = await screen.findByRole("menu", { name: "Actions" });
    // A key points nowhere, so there is nothing to follow — but something points at it.
    expect(within(menu).queryByRole("menuitem", { name: /Follow reference/ })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Show references \(1\)/ }));
    await waitFor(() => expect(marked("orders", "user_id")).toBe(true));
    expect(marked("users", "id")).toBe(true);
    expect(marked("users", "email")).toBe(false);
    expect(card("orders").classList.contains("as-node--match")).toBe(true);
    expect(card("users").classList.contains("as-node--match")).toBe(true);
    expect(card("items").classList.contains("as-node--match")).toBe(false);
    await screen.findByText("1 reference from 1 table marked");
  });

  it("is withheld on a key nothing points at", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} />);
    fireEvent.click(row(container, "logs", "id"));
    const menu = await screen.findByRole("menu", { name: "Actions" });
    expect(within(menu).queryByRole("menuitem", { name: /Show references/ })).not.toBeInTheDocument();
  });
});

describe("lifting the marks", () => {
  const show = async (container: HTMLElement) => {
    fireEvent.click(row(container, "users", "id"));
    const menu = await screen.findByRole("menu", { name: "Actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Show references/ }));
    await waitFor(() => expect(row(container, "orders", "user_id").classList.contains("as-node__field--match")).toBe(true));
  };
  const card = (container: HTMLElement, nodeId: string) => container.querySelector(`.react-flow__node[data-id="${nodeId}"] .as-node`)!;

  it("every card a shown reference did not touch steps back, and comes forward again with the marks", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} />);
    await show(container);
    expect(card(container, "items").classList.contains("as-node--unmarked")).toBe(true);
    expect(card(container, "logs").classList.contains("as-node--unmarked")).toBe(true);
    expect(card(container, "orders").classList.contains("as-node--unmarked")).toBe(false);
    expect(card(container, "users").classList.contains("as-node--unmarked")).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(row(container, "orders", "user_id").classList.contains("as-node__field--match")).toBe(false));
    expect(card(container, "items").classList.contains("as-node--unmarked")).toBe(false);
    expect(card(container, "users").classList.contains("as-node--match")).toBe(false);
  });

  it("Escape lifts the marks before it drops the selection", async () => {
    const onSelectionChange = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} onSelectionChange={onSelectionChange} />);
    await show(container);
    // The row click selected Users; the first Escape takes the marks only.
    await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith({ nodes: ["users"], edges: [], zones: [] }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(row(container, "users", "id").classList.contains("as-node__field--match")).toBe(false));
    expect(onSelectionChange).toHaveBeenLastCalledWith({ nodes: ["users"], edges: [], zones: [] });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith({ nodes: [], edges: [], zones: [] }));
  });
});
