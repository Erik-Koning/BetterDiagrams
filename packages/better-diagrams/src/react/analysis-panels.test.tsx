/**
 * @vitest-environment jsdom
 *
 * analysis-panels.test.tsx — the data-model analyses in the editor's left
 * sidebar and paths panel: neighbourhood focus, SQL for a route, and field
 * consistency in key usage. (Impact, checks, structure, governance, schema
 * changes and lineage have their own describe blocks below as they land.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
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

const table = (id: string, label: string, fields: Array<Record<string, unknown>>, x: number, y = 100) => ({
  id, label, kind: "table", icon: "none", description: "", parentId: null, x, y, w: 230, h: 160,
  fields: fields.map((f) => ({ id: String(f.id), name: String(f.id), ...f })),
});
const fk = (id: string, source: string, target: string, field: string, over: Record<string, unknown> = {}) => ({
  id, source, target, label: "", style: "solid", color: "slate", startField: field, endField: "id", ...over,
});

/**
 *   users ← orders.user_id ← items.order_id ;  logs alone ;  tenants ← users.tenant_id, orders.tenant_id
 *   tenant_id is uuid on users, varchar(36) on orders — inconsistent.
 */
const MODEL: DiagramTemplate = validateTemplate({
  version: 1,
  nodes: [
    table("tenants", "Tenants", [{ id: "id", key: "pk", type: "uuid" }], 100),
    table("users", "Users", [{ id: "id", key: "pk", type: "uuid" }, { id: "tenant_id", key: "fk", type: "uuid", required: true }], 400),
    table("orders", "Orders", [{ id: "id", key: "pk", type: "uuid" }, { id: "tenant_id", key: "fk", type: "varchar(36)" }, { id: "user_id", key: "fk", type: "uuid", required: true }], 700),
    table("items", "Items", [{ id: "id", key: "pk", type: "uuid" }, { id: "order_id", key: "fk", type: "uuid" }], 1000),
    table("logs", "Logs", [{ id: "id", key: "pk", type: "uuid" }], 1300),
  ],
  edges: [
    fk("u-t", "users", "tenants", "tenant_id"),
    fk("o-t", "orders", "tenants", "tenant_id"),
    fk("o-u", "orders", "users", "user_id", { data: { model: { field: "user_id", targetField: "id", required: true } } }),
    fk("i-o", "items", "orders", "order_id"),
  ],
});
const dimmed = (container: HTMLElement, id: string) =>
  container.querySelector(`.react-flow__node[data-id="${id}"] .as-node--dimmed`) !== null;

async function nodeMenu(container: HTMLElement, id: string) {
  const node = container.querySelector(`.react-flow__node[data-id="${id}"]`)!;
  fireEvent.click(node);
  fireEvent.contextMenu(node);
  return within(await screen.findByRole("menu", { name: "Actions" }));
}

describe("neighbourhood", () => {
  it("focuses a table's neighbourhood from its menu, by depth and direction, dimming the rest", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} />);
    const menu = await nodeMenu(container, "orders");
    fireEvent.click(menu.getByRole("menuitem", { name: /Focus neighbourhood/ }));
    const panel = await screen.findByRole("region", { name: "Neighbourhood" });
    expect(within(panel).getByRole("status")).toHaveTextContent("3 tables within 1 join");
    await waitFor(() => expect(dimmed(container, "logs")).toBe(true));
    expect(dimmed(container, "items")).toBe(false);

    // Out: only what Orders references.
    fireEvent.click(within(panel).getByRole("button", { name: "Out" }));
    await waitFor(() => expect(within(panel).getByRole("status")).toHaveTextContent("2 tables within 1 join"));
    expect(dimmed(container, "items")).toBe(true);
    // Two joins out reaches nothing further; two joins either way reaches every table but Logs.
    fireEvent.click(within(panel).getByRole("button", { name: "Both" }));
    fireEvent.click(within(panel).getByRole("button", { name: "2" }));
    await waitFor(() => expect(within(panel).getByRole("status")).toHaveTextContent("3 tables within 2 joins"));

    // Refocus on a table in the list: the focus chip becomes that table.
    const near = within(panel).getByRole("region", { name: "1 join away" });
    const first = within(near).getAllByRole("button")[0]!.textContent;
    fireEvent.click(within(near).getAllByRole("button", { name: "Focus" })[0]!);
    await waitFor(() => expect(panel.querySelector(".as-paths__pins")!.textContent).toBe(first));

    // Escape closes it; the canvas comes back.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Neighbourhood" })).toBeNull());
    expect(dimmed(container, "logs")).toBe(false);
  });
});

describe("SQL for a route", () => {
  it("shows the JOIN chain for a route, in the dialect asked for, with the fan-out said", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} />);
    const menu = await nodeMenu(container, "items");
    fireEvent.click(menu.getByRole("menuitem", { name: /Pin table for search/ }));
    const menu2 = await nodeMenu(container, "users");
    fireEvent.click(menu2.getByRole("menuitem", { name: /Pin table for search/ }));
    fireEvent.click(screen.getByRole("button", { name: "Show paths" }));
    const panel = await screen.findByRole("region", { name: "Paths between pinned fields" });
    fireEvent.click(within(panel).getByRole("button", { name: "SQL for route 1" }));
    const sql = within(panel).getByRole("group", { name: "SQL for this route" });
    expect(sql.querySelector("pre")!.textContent).toBe(
      "SELECT *\nFROM items AS t0\n  LEFT JOIN orders AS t1 ON t1.id = t0.order_id\n  INNER JOIN users AS t2 ON t2.id = t1.user_id",
    );
    fireEvent.change(within(sql).getByRole("combobox", { name: "SQL dialect" }), { target: { value: "tsql" } });
    fireEvent.change(within(sql).getByRole("combobox", { name: "Join style" }), { target: { value: "left" } });
    expect(sql.querySelector("pre")!.textContent).toContain("LEFT JOIN users AS t2");
    // Each hop walks a key to what it references — one row per row, nothing to warn about.
    expect(within(sql).queryByRole("listitem")).toBeNull();
  });
});

describe("key usage — consistency", () => {
  it("flags a name stored two ways, lists the ways, and narrows to one", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} />);
    await user.click(screen.getByRole("button", { name: "View", exact: true } as never));
    await user.click(screen.getByRole("menuitem", { name: /Key usage/ }));
    const panel = await screen.findByRole("region", { name: "Key usage" });
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Inconsistent only" }));
    const listed = within(panel).getByRole("region", { name: "Shared fields" });
    const bars = within(listed).getAllByRole("button");
    expect(bars.map((b) => b.querySelector(".as-usage__name")!.textContent)).toEqual(["tenant_id"]);
    // Orders' row doesn't say whether it is required, so only the type differs.
    expect(bars[0]!.querySelector(".as-usage__badge--mixed")).toHaveAttribute("title", "2 types: uuid, varchar");

    fireEvent.click(bars[0]!);
    const ways = within(panel).getByRole("list", { name: "How tenant_id is stored" });
    const variants = within(ways).getAllByRole("button");
    expect(variants.map((b) => b.textContent)).toEqual(["uuid · 1 table · required", "varchar(36) · 1 table"]);
    fireEvent.click(variants[1]!);
    const using = within(panel).getByRole("region", { name: "Tables using them" });
    expect(within(using).getByRole("heading")).toHaveTextContent("Storing tenant_id as varchar");
    expect(within(using).getAllByRole("button").map((b) => b.querySelector(".as-paths__itemlabel")!.textContent)).toEqual(["Orders"]);
    await waitFor(() => expect(dimmed(container, "users")).toBe(true));
    expect(dimmed(container, "orders")).toBe(false);
  });
});

describe("checks panel", () => {
  const UNDECLARED: DiagramTemplate = validateTemplate({
    version: 1,
    nodes: [
      table("customers", "Customers", [{ id: "id", key: "pk", type: "uuid" }], 100),
      table("orders", "Orders", [{ id: "id", key: "pk", type: "uuid" }, { id: "customer_id", type: "uuid" }], 500),
      table("logs", "Logs", [{ id: "message", type: "text" }], 900),
    ],
    edges: [],
  });

  it("opens from the Checks menu with every finding by rule; a finding is a jump that marks its column", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={UNDECLARED} />);
    await user.click(screen.getByRole("button", { name: /^Checks/ }));
    await user.click(screen.getByRole("menuitem", { name: /Show all \d+ in a panel/ }));
    const panel = await screen.findByRole("region", { name: "Checks" });
    expect(within(panel).getByRole("status")).toHaveTextContent(/finding/);
    const undeclared = within(panel).getByRole("list", { name: "Undeclared reference" });
    fireEvent.click(within(undeclared).getByRole("button", { name: /Orders\.customer_id/ }));
    await waitFor(() =>
      expect(container.querySelector('.react-flow__node[data-id="orders"] [data-field-id="customer_id"]')).toHaveClass("as-node__field--match"),
    );
    // Errors only: no undeclared reference is an error.
    fireEvent.click(within(panel).getByRole("button", { name: "Errors" }));
    expect(within(panel).queryByRole("list", { name: "Undeclared reference" })).toBeNull();
  });

  it("fixes a finding by drawing the reference, and ignores one with a tag — each one undoable edit", async () => {
    const user = userEvent.setup();
    const changes: DiagramTemplate[] = [];
    mount(<ArchitectureStudio defaultValue={UNDECLARED} onChange={(t) => changes.push(t)} />);
    await user.click(screen.getByRole("button", { name: /^Checks/ }));
    await user.click(screen.getByRole("menuitem", { name: /Show all/ }));
    const panel = await screen.findByRole("region", { name: "Checks" });
    const undeclared = within(panel).getByRole("list", { name: "Undeclared reference" });
    fireEvent.click(within(undeclared).getByRole("button", { name: "Fix" }));
    await waitFor(() => expect(changes.at(-1)?.edges).toHaveLength(1));
    expect(changes.at(-1)!.edges[0]).toMatchObject({ source: "orders", target: "customers", startField: "customer_id", endField: "id", relation: "reference" });
    await waitFor(() => expect(within(panel).queryByRole("list", { name: "Undeclared reference" })).toBeNull());

    const noKey = within(panel).getByRole("list", { name: "Table without a primary key" });
    fireEvent.click(within(noKey).getByRole("button", { name: "Ignore" }));
    await waitFor(() => expect(changes.at(-1)!.nodes.find((n) => n.id === "logs")!.tags).toEqual(["lint-ignore:dm-no-primary-key"]));
    await waitFor(() => expect(within(panel).queryByRole("list", { name: "Table without a primary key" })).toBeNull());
  });

  it("suggests a sensitivity tag for a column that looks personal, and Fix tags the row", async () => {
    const user = userEvent.setup();
    const changes: DiagramTemplate[] = [];
    const doc = validateTemplate({
      version: 1,
      nodes: [table("people", "People", [{ id: "id", key: "pk" }, { id: "email", type: "text" }], 100)],
      edges: [],
    });
    mount(<ArchitectureStudio defaultValue={doc} onChange={(t) => changes.push(t)} />);
    await user.click(screen.getByRole("button", { name: /^Checks/ }));
    await user.click(screen.getByRole("menuitem", { name: /Show all/ }));
    const panel = await screen.findByRole("region", { name: "Checks" });
    const sensitive = within(panel).getByRole("list", { name: "Looks sensitive, not tagged" });
    expect(sensitive).toHaveTextContent('"People.email" looks like an email address but carries no sensitive tag');
    fireEvent.click(within(sensitive).getByRole("button", { name: "Fix" }));
    await waitFor(() => expect(changes.at(-1)!.nodes[0]!.fields!.find((f) => f.id === "email")!.tags).toEqual(["pii:email"]));
    await waitFor(() => expect(within(panel).queryByRole("list", { name: "Looks sensitive, not tagged" })).toBeNull());
  });
});

describe("impact panel", () => {
  it("shows what depends on a table, dims the rest, and lights the chain to a table under the pointer", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} />);
    const menu = await nodeMenu(container, "users");
    fireEvent.click(menu.getByRole("menuitem", { name: /Show impact/ }));
    const panel = await screen.findByRole("region", { name: "Impact" });
    expect(within(panel).getByRole("status")).toHaveTextContent("2 tables depend on Users");
    await waitFor(() => expect(dimmed(container, "logs")).toBe(true));
    expect(dimmed(container, "items")).toBe(false);
    const two = within(panel).getByRole("region", { name: "2 hops away" });
    const items = within(two).getByRole("button", { name: /Items/ });
    expect(items).toHaveTextContent("via Orders.order_id");
    fireEvent.mouseEnter(items);
    await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="items"]')).toHaveClass("as-path-node"));
    fireEvent.mouseLeave(items);
    fireEvent.click(within(panel).getByRole("button", { name: "Dependencies" }));
    await waitFor(() => expect(within(panel).getByRole("status")).toHaveTextContent("Users depends on 1 table"));
  });
});

describe("governance and schema changes", () => {
  const GOV: DiagramTemplate = validateTemplate({
    ...MODEL,
    nodes: MODEL.nodes.map((n) =>
      n.id === "users"
        ? { ...n, team: "Identity", description: "Who signs in", fields: n.fields!.map((f) => (f.id === "id" ? f : { ...f, tags: ["pii"] })) }
        : n,
    ),
  });

  it("governance: what is documented and owned, sensitive columns and what reaches them, and the dictionary", async () => {
    const user = userEvent.setup();
    const downloads: string[] = [];
    const created = URL.createObjectURL;
    URL.createObjectURL = () => "blob:x";
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    };
    try {
      mount(<ArchitectureStudio defaultValue={GOV} />);
      await user.click(screen.getByRole("button", { name: "View", exact: true } as never));
      await user.click(screen.getByRole("menuitem", { name: /^Governance/ }));
      const panel = await screen.findByRole("region", { name: "Governance" });
      const docs = within(panel).getByRole("region", { name: "Documentation" });
      expect(docs).toHaveTextContent("Tables described20%");
      expect(docs).toHaveTextContent("Tables owned20%");
      const sensitive = within(panel).getByRole("region", { name: "Sensitive columns" });
      expect(within(sensitive).getByRole("button")).toHaveTextContent("Users.tenant_idpii");
      fireEvent.click(within(panel).getByRole("button", { name: ".csv" }));
      await waitFor(() => expect(downloads.some((d) => d.endsWith("-dictionary.csv"))).toBe(true));
    } finally {
      URL.createObjectURL = created;
      HTMLAnchorElement.prototype.click = click;
    }
  });

  it("schema changes: against the compare baseline, column by column, filtered by impact", async () => {
    const next: DiagramTemplate = validateTemplate({
      ...MODEL,
      nodes: MODEL.nodes
        .filter((n) => n.id !== "logs")
        .map((n) => (n.id === "orders" ? { ...n, fields: n.fields!.map((f) => (f.id === "tenant_id" ? { ...f, type: "uuid" } : f)) } : n)),
    });
    mount(<ArchitectureStudio defaultValue={next} diffBase={MODEL} />);
    fireEvent.click(await screen.findByRole("button", { name: "Schema changes" }));
    const panel = await screen.findByRole("region", { name: "Schema changes" });
    expect(within(panel).getByRole("status")).toHaveTextContent("2 breaking · 0 caution · 0 safe");
    const orders = within(panel).getByRole("region", { name: "Orders" });
    expect(orders).toHaveTextContent("tenant_id");
    expect(orders).toHaveTextContent("type varchar(36) → uuid");
    fireEvent.click(within(panel).getByRole("button", { name: /^Safe/ }));
    expect(within(panel).queryByRole("region", { name: "Orders" })).toBeNull();
  });
});

/** Three clusters of four tables, every table also keyed to Users — the shape real models have. */
export const HUB_MODEL: DiagramTemplate = validateTemplate({
  version: 1,
  nodes: [
    table("users", "Users", [{ id: "id", key: "pk" }], 100),
    ...[0, 1, 2].flatMap((c) =>
      [0, 1, 2, 3].map((k) =>
        table(`c${c}t${k}`, `C${c}T${k}`, [{ id: "id", key: "pk" }, { id: "user_id", key: "fk" }, { id: "next_id", key: "fk" }], 300 + k * 260, 100 + c * 260),
      ),
    ),
  ],
  edges: [0, 1, 2].flatMap((c) =>
    [0, 1, 2, 3].flatMap((k) => [
      fk(`c${c}t${k}-u`, `c${c}t${k}`, "users", "user_id"),
      fk(`c${c}t${k}-n`, `c${c}t${k}`, `c${c}t${(k + 1) % 4}`, "next_id"),
    ]),
  ),
});

describe("model structure", () => {
  const outlined = (container: HTMLElement, id: string) =>
    container.querySelector(`.react-flow__node[data-id="${id}"] .as-node--domain`) !== null;

  it("ranks hubs, points at one to dim to its neighbours, lists bridges, and colours by domain", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} />);
    await user.click(screen.getByRole("button", { name: "View", exact: true } as never));
    await user.click(screen.getByRole("menuitem", { name: /^Model structure/ }));
    const panel = await screen.findByRole("region", { name: "Model structure" });
    expect(within(panel).getByRole("status")).toHaveTextContent("5 tables · 1 domain · 1 bridge key · 1 unjoined");

    const hubs = within(panel).getByRole("list", { name: "Hubs" });
    const first = within(hubs).getAllByRole("button")[0]!;
    expect(first).toHaveTextContent("Orders");
    fireEvent.mouseEnter(first);
    await waitFor(() => expect(dimmed(container, "logs")).toBe(true));
    expect(dimmed(container, "items")).toBe(false);
    fireEvent.mouseLeave(first);
    await waitFor(() => expect(dimmed(container, "logs")).toBe(false));

    fireEvent.click(within(panel).getByRole("tab", { name: "Bridges" }));
    expect(within(panel).getByRole("region", { name: "Tables holding the model together" })).toHaveTextContent("Orderswithout it: 2 pieces");
    expect(within(panel).getByRole("region", { name: "Bridge keys" })).toHaveTextContent("Items.order_id → Orders");

    fireEvent.click(within(panel).getByRole("tab", { name: "Domains" }));
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Colour tables by domain" }));
    await waitFor(() => expect(outlined(container, "users")).toBe(true));
    expect(outlined(container, "logs")).toBe(false);
    const domain = within(within(panel).getByRole("list", { name: "Domains" })).getAllByRole("button", { pressed: false })[0]!;
    fireEvent.click(domain);
    await waitFor(() => expect(dimmed(container, "logs")).toBe(true));
    expect(dimmed(container, "items")).toBe(false);

    fireEvent.click(within(panel).getByRole("button", { name: "Close model structure panel" }));
    await waitFor(() => expect(outlined(container, "users")).toBe(false));
    expect(dimmed(container, "logs")).toBe(false);
  });

  it("sets aside a table every cluster points at, and finds the clusters under it", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={HUB_MODEL} />);
    await user.click(screen.getByRole("button", { name: "View", exact: true } as never));
    await user.click(screen.getByRole("menuitem", { name: /^Model structure/ }));
    const panel = await screen.findByRole("region", { name: "Model structure" });
    expect(within(panel).getByRole("status")).toHaveTextContent("13 tables · 3 domains · 1 shared");
    fireEvent.click(within(panel).getByRole("tab", { name: "Domains" }));
    expect(within(panel).getByRole("region", { name: "Shared tables" })).toHaveTextContent("Users");
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Colour tables by domain" }));
    await waitFor(() => expect(outlined(container, "c0t0")).toBe(true));
    // A shared table belongs to no one domain, so it wears no domain's colour.
    expect(outlined(container, "users")).toBe(false);
  });
});

describe("saved analyses", () => {
  it("saves the open analysis with what it says, opens it again from the menu, and undoes the save", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={MODEL} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "View", exact: true } as never));
    await user.click(screen.getByRole("menuitem", { name: /Key usage/ }));
    let panel = await screen.findByRole("region", { name: "Key usage" });
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Inconsistent only" }));
    fireEvent.click(within(within(panel).getByRole("region", { name: "Shared fields" })).getAllByRole("button")[0]!);

    fireEvent.click(within(panel).getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("dialog", { name: "Save analysis" });
    expect(dialog).toHaveTextContent("2 of 5 tables use them (40%)");
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    expect(title).toHaveValue("Key usage: tenant_id");
    await user.clear(title);
    await user.type(title, "Tenant audit");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const saved = (onChange.mock.calls.at(-1)![0] as DiagramTemplate).analyses;
    expect(saved).toEqual([
      expect.objectContaining({
        id: "tenant-audit",
        title: "Tenant audit",
        kind: "usage",
        names: ["tenant_id"],
        snapshot: { headline: "2 of 5 tables use them (40%)", value: 0.4 },
      }),
    ]);

    fireEvent.click(within(panel).getByRole("button", { name: "Close key usage panel" }));
    await user.click(screen.getByRole("button", { name: "Analyses (1)" }));
    const item = screen.getByRole("menuitem", { name: /^Tenant audit/ });
    expect(item).toHaveTextContent("Key usage · 2 of 5 tables use them (40%)");
    await user.click(item);
    panel = await screen.findByRole("region", { name: "Key usage" });
    expect(within(panel).getByRole("region", { name: "Tables using them" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect((onChange.mock.calls.at(-1)![0] as DiagramTemplate).analyses).toBeUndefined());
  });

  it("shows drift, renames, deletes, and opens through the ref", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const ref = createRef<StudioHandle>();
    const doc = validateTemplate({
      ...MODEL,
      analyses: [
        { id: "t", title: "Tenant", kind: "usage", names: ["tenant_id"], match: "any", includeTargets: false, snapshot: { headline: "1 of 5", value: 0.2 } },
        { id: "imp", title: "Users impact", kind: "impact", subject: { nodeId: "users" }, direction: "dependents", via: "keys" },
      ],
    } as never);
    mount(<ArchitectureStudio ref={ref} defaultValue={doc} onChange={onChange} />);
    expect(ref.current!.getAnalyses().map((a) => a.id)).toEqual(["t", "imp"]);
    act(() => {
      expect(ref.current!.openAnalysis("imp")).toBe(true);
    });
    expect(await screen.findByRole("region", { name: "Impact" })).toHaveTextContent("Users");
    expect(ref.current!.openAnalysis("nope")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Analyses (2)" }));
    expect(screen.getByRole("menuitem", { name: /^Tenant/ })).toHaveTextContent("was 20%, now 40%");
    await user.click(screen.getByRole("menuitem", { name: "Rename Tenant" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename analysis" });
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Tenant key");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect((onChange.mock.calls.at(-1)![0] as DiagramTemplate).analyses![0]).toMatchObject({ id: "t", title: "Tenant key" });

    await user.click(screen.getByRole("button", { name: "Analyses (2)" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete Users impact" }));
    expect((onChange.mock.calls.at(-1)![0] as DiagramTemplate).analyses!.map((a) => a.id)).toEqual(["t"]);
  });
});

describe("column lineage", () => {
  const row = (container: HTMLElement, nodeId: string, fieldId: string) =>
    container.querySelector(`.react-flow__node[data-id="${nodeId}"] .as-node__field[data-field-id="${fieldId}"]`) as HTMLElement;
  const LINEAGE: DiagramTemplate = validateTemplate({
    ...MODEL,
    lineage: [
      { id: "l1", from: { nodeId: "users", fieldId: "id" }, to: { nodeId: "orders", fieldId: "user_id" }, transform: "copy" },
      { id: "l2", from: { nodeId: "orders", fieldId: "user_id" }, to: { nodeId: "items", fieldId: "order_id" }, job: "etl" },
    ],
  } as never);

  it("traces a column both ways: lists, marks the rows, dims other tables, and draws the links row to row", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={LINEAGE} />);
    // A column with no lineage is not offered the trace.
    fireEvent.click(row(container, "logs", "id"));
    let menu = await screen.findByRole("menu", { name: "Actions" });
    expect(within(menu).queryByRole("menuitem", { name: /Trace lineage/ })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(row(container, "orders", "user_id"));
    menu = await screen.findByRole("menu", { name: "Actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Trace lineage/ }));
    const panel = await screen.findByRole("region", { name: "Lineage" });
    expect(within(panel).getByRole("status")).toHaveTextContent("1 upstream column · 1 downstream");
    expect(within(panel).getByRole("region", { name: "Comes from" })).toHaveTextContent("Users.idcopy");
    expect(within(panel).getByRole("region", { name: "Flows into" })).toHaveTextContent("Items.order_id· etl");
    await waitFor(() => expect(dimmed(container, "logs")).toBe(true));
    expect(dimmed(container, "items")).toBe(false);
    expect(row(container, "users", "id")).toHaveClass("as-node__field--match");
    expect(container.querySelectorAll(".as-lineage__line")).toHaveLength(2);

    fireEvent.mouseEnter(within(panel).getByRole("button", { name: /Items\.order_id/ }));
    await waitFor(() => expect(container.querySelector(".as-lineage__line--on")).toHaveAttribute("data-lineage", "l2"));

    fireEvent.click(within(panel).getByRole("button", { name: "Upstream" }));
    await waitFor(() => expect(within(panel).getByRole("status")).toHaveTextContent("1 upstream column · 0 downstream"));
    fireEvent.click(within(panel).getByRole("button", { name: "Close lineage panel" }));
    await waitFor(() => expect(container.querySelectorAll(".as-lineage__line")).toHaveLength(0));
    expect(dimmed(container, "logs")).toBe(false);
  });

  it("draws a link to a table a level down on the card that stands for it, and marks a column the model doesn't list", async () => {
    const nested: DiagramTemplate = validateTemplate({
      version: 1,
      nodes: [
        table("orders", "Orders", [{ id: "id", key: "pk" }, { id: "total" }], 100),
        { id: "warehouse", label: "Warehouse", kind: "service", icon: "none", description: "", parentId: null, x: 600, y: 100, w: 200, h: 90 },
        { ...table("facts", "Facts", [{ id: "revenue" }], 0), parentId: "warehouse" },
      ],
      edges: [],
      lineage: [
        { id: "l1", from: { nodeId: "orders", fieldId: "total" }, to: { nodeId: "facts", fieldId: "revenue" } },
        { id: "l2", from: { nodeId: "orders", fieldId: "total" }, to: { nodeId: "orders", fieldId: "total_old" } },
      ],
    } as never);
    const { container } = mount(<ArchitectureStudio defaultValue={nested} />);
    fireEvent.click(row(container, "orders", "total"));
    const menu = await screen.findByRole("menu", { name: "Actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Trace lineage/ }));
    const panel = await screen.findByRole("region", { name: "Lineage" });
    // Facts lives inside Warehouse, so it has no card here: its line lands on the Warehouse card.
    expect(container.querySelector('.react-flow__node[data-id="facts"]')).toBeNull();
    await waitFor(() => expect(container.querySelector('.as-lineage__line[data-lineage="l1"]')).not.toBeNull());
    expect(within(panel).getByRole("button", { name: /Orders\.total_old/ })).toHaveTextContent("not in the model");
    expect(within(panel).getByRole("button", { name: /Facts\.revenue/ })).not.toHaveTextContent("not in the model");
  });

  it("imports OpenLineage events into the document, undoably", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={MODEL} onChange={onChange} />);
    const events = [
      {
        eventType: "COMPLETE",
        job: { namespace: "etl", name: "orders_from_users" },
        outputs: [{ namespace: "db", name: "public.orders", facets: { columnLineage: { fields: { user_id: { inputFields: [{ namespace: "db", name: "public.users", field: "id" }] } } } } }],
      },
    ];
    const input = screen.getByLabelText("OpenLineage events") as HTMLInputElement;
    await user.upload(input, new File([JSON.stringify(events)], "events.json", { type: "application/json" }));
    await waitFor(() =>
      expect((onChange.mock.calls.at(-1)?.[0] as DiagramTemplate | undefined)?.lineage).toEqual([
        { id: "users.id->orders.user_id", from: { nodeId: "users", fieldId: "id" }, to: { nodeId: "orders", fieldId: "user_id" }, job: "orders_from_users" },
      ]),
    );
    expect(await screen.findByText(/Imported 1 lineage link/)).toBeInTheDocument();
  });
});
