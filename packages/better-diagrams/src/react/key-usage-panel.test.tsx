/**
 * @vitest-environment jsdom
 *
 * key-usage-panel.test.tsx — the key-usage panel in the left sidebar:
 * searching field names, picking several, the share of tables using them,
 * the tables with and without them, dimming, and the sidebar it shares.
 */
import { act } from "react";
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
  id, label, kind: "table", icon: "none", description: "", parentId: null, x, y: 100, w: 230, h: 140, fields,
});
/** tenant_id on users and orders (→ tenants); created_at on orders and logs; items carries neither. */
const MODEL: DiagramTemplate = validateTemplate({
  version: 1,
  nodes: [
    table("tenants", "Tenants", [{ id: "id", name: "id", key: "pk" }], 100),
    table("users", "Users", [{ id: "id", name: "id", key: "pk" }, { id: "tenant_id", name: "tenant_id", key: "fk" }], 400),
    table("orders", "Orders", [
      { id: "id", name: "id", key: "pk" },
      { id: "tenant_id", name: "tenant_id", key: "fk" },
      { id: "created_at", name: "created_at" },
    ], 700),
    table("items", "Items", [{ id: "id", name: "id", key: "pk" }], 1000),
    table("logs", "Logs", [{ id: "id", name: "id", key: "pk" }, { id: "created_at", name: "created_at" }], 1300),
  ],
  edges: [
    { id: "u-t", source: "users", target: "tenants", label: "", style: "solid", color: "slate", startField: "tenant_id", endField: "id" },
    { id: "o-t", source: "orders", target: "tenants", label: "", style: "solid", color: "slate", startField: "tenant_id", endField: "id" },
  ],
});
const dimmed = (container: HTMLElement, id: string) =>
  container.querySelector(`.react-flow__node[data-id="${id}"] .as-node--dimmed`) !== null;

async function openPanel() {
  const user = userEvent.setup();
  const utils = mount(<ArchitectureStudio defaultValue={MODEL} />);
  await user.click(screen.getByRole("button", { name: "View" }));
  await user.click(screen.getByRole("menuitem", { name: /Key usage/ }));
  const panel = await screen.findByRole("region", { name: "Key usage" });
  return { ...utils, user, panel };
}

describe("key usage panel", () => {
  it("opens in the left sidebar and lists the names tables share before anything is typed", async () => {
    const { panel } = await openPanel();
    expect(panel).toHaveClass("as-panel");
    const shared = within(panel).getByRole("region", { name: "Shared fields" });
    const names = within(shared).getAllByRole("button").map((b) => b.querySelector(".as-usage__name")!.textContent);
    expect(names).toEqual(["id", "created_at", "tenant_id"]);
    expect(within(shared).getByRole("button", { name: /tenant_id/ })).toHaveTextContent("2 tables");
    expect(within(panel).getByText(/Pick a field above/)).toBeInTheDocument();
  });

  it("searches names, picks several, and scores the tables using any — or all — of them", async () => {
    const { panel, container, user } = await openPanel();
    const search = within(panel).getByRole("searchbox", { name: "Search field names or keys" });
    await user.type(search, "tenant");
    const matches = within(panel).getByRole("region", { name: "Matching fields" });
    expect(within(matches).getAllByRole("button")).toHaveLength(1);
    // Enter picks the top match.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(panel).getByText("40%")).toBeInTheDocument());
    expect(within(panel).getByText("2 of 5 tables use them")).toBeInTheDocument();
    const using = within(panel).getByRole("region", { name: "Tables using them" });
    expect(within(using).getAllByRole("button").map((b) => b.textContent)).toEqual(["Userstenant_id", "Orderstenant_id"]);
    await waitFor(() => expect(dimmed(container, "logs")).toBe(true));
    expect(dimmed(container, "users")).toBe(false);

    await user.clear(search);
    await user.type(search, "created");
    fireEvent.click(within(within(panel).getByRole("region", { name: "Matching fields" })).getByRole("button", { name: /created_at/ }));
    await waitFor(() => expect(within(panel).getByText("60%")).toBeInTheDocument());
    const picked = within(panel).getByRole("region", { name: "Picked fields" });
    expect(within(picked).getAllByRole("button", { pressed: true })).toHaveLength(2);
    expect(within(picked).getByRole("button", { name: "Clear" })).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "All" }));
    await waitFor(() => expect(within(panel).getByText("20%")).toBeInTheDocument());
    expect(within(panel).getByText("1 of 5 tables have all of them")).toBeInTheDocument();
    expect(within(within(panel).getByRole("region", { name: "Tables using them" })).getByRole("button")).toHaveTextContent("Orders");
  });

  it("can count the table a key points at, and lists the tables without them", async () => {
    const { panel, user } = await openPanel();
    await user.type(within(panel).getByRole("searchbox"), "tenant_id{Enter}");
    await waitFor(() => expect(within(panel).getByText("40%")).toBeInTheDocument());
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Count the tables they point at" }));
    await waitFor(() => expect(within(panel).getByText("60%")).toBeInTheDocument());
    const using = within(panel).getByRole("region", { name: "Tables using them" });
    expect(within(using).getByRole("button", { name: /Tenants/ })).toHaveTextContent("← tenant_id");
    const without = within(panel).getByText("Tables without them").closest("details")!;
    expect([...without.querySelectorAll(".as-paths__itemlabel")].map((e) => e.textContent)).toEqual(["Items", "Logs"]);
  });

  it("keys only narrows the search to primary and foreign keys", async () => {
    const { panel } = await openPanel();
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Keys only" }));
    const shared = within(panel).getByRole("region", { name: "Shared fields" });
    expect(within(shared).getAllByRole("button").map((b) => b.querySelector(".as-usage__name")!.textContent)).toEqual(["id", "tenant_id"]);
  });

  it("going to a table marks the picked fields it carries", async () => {
    const { panel, container, user } = await openPanel();
    await user.type(within(panel).getByRole("searchbox"), "tenant_id{Enter}");
    const using = await within(panel).findByRole("region", { name: "Tables using them" });
    fireEvent.click(within(using).getByRole("button", { name: /Orders/ }));
    await waitFor(() =>
      expect(container.querySelector('.react-flow__node[data-id="orders"] [data-field-id="tenant_id"]')).toHaveClass("as-node__field--match"),
    );
  });

  it("shares the sidebar: opening the paths or references panel closes it, and Escape in its box clears then closes", async () => {
    const { panel, user } = await openPanel();
    const search = within(panel).getByRole("searchbox");
    await user.type(search, "zz");
    expect(within(panel).getByText(/No field name contains “zz”/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Key usage" })).toBeNull());

    // Open it again, then open key coverage: one panel of each kind at a time.
    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(screen.getByRole("menuitem", { name: /Key usage/ }));
    await screen.findByRole("region", { name: "Key usage" });
    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(screen.getByRole("menuitem", { name: /Key coverage/ }));
    await screen.findByRole("region", { name: "Key coverage" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Key usage" })).toBeNull());
  });

  it("is view state a host can read, set, open, and follow", async () => {
    const ref = { current: null as StudioHandle | null };
    const onKeyUsageChange = vi.fn();
    mount(<ArchitectureStudio ref={ref} defaultValue={MODEL} onKeyUsageChange={onKeyUsageChange} />);
    expect(onKeyUsageChange).toHaveBeenCalledWith([]);

    // Names are matched without regard to case, so a pick is its lowercased name, once.
    act(() => ref.current!.setUsageKeys(["Tenant_ID", "tenant_id", " created_at "]));
    expect(ref.current!.getUsageKeys()).toEqual(["tenant_id", "created_at"]);
    expect(onKeyUsageChange).toHaveBeenLastCalledWith(["tenant_id", "created_at"]);

    act(() => ref.current!.openKeyUsage());
    const panel = await screen.findByRole("region", { name: "Key usage" });
    expect(within(panel).getByText("60%")).toBeInTheDocument();
    fireEvent.click(within(within(panel).getByRole("region", { name: "Picked fields" })).getByRole("button", { name: /created_at/ }));
    await waitFor(() => expect(onKeyUsageChange).toHaveBeenLastCalledWith(["tenant_id"]));
    act(() => ref.current!.openKeyUsage(false));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Key usage" })).toBeNull());
    // Closing the panel keeps the picks, as coverage keeps its keys.
    expect(ref.current!.getUsageKeys()).toEqual(["tenant_id"]);
  });
});
