/**
 * @vitest-environment jsdom
 *
 * relations-ui.test.tsx — the relationship kinds where a reader meets them:
 * the registry that names them, the legend that explains them (canvas and
 * export), the inspector picker that dresses a line with one, and the
 * Mermaid ER line that follows them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ArchitectureStudio } from "./ArchitectureStudio";
import { createRegistry } from "./create-registry";
import { relationDef } from "./registry-types";
import { emitTemplate } from "./draw";
import { renderTemplateToMermaid } from "./exporters";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";
import { RELATION_KINDS, relationDressing } from "../contract/relations";

afterEach(cleanup);

const table = (id: string, label: string, fields: Array<Record<string, unknown>>, x: number, y: number) => ({
  id, label, kind: "table", icon: "none", description: "", parentId: null, x, y, w: 230, h: 120, fields,
});
const fk = (id: string, source: string, target: string, field: string, relation: string | undefined) => ({
  id, source, target, startField: field, endField: "id",
  // Dressed as the kind would dress it — what the importer or the picker writes.
  ...(relation ? { relation, ...relationDressing(RELATION_KINDS[relation]!) } : { style: "solid", color: "slate" }),
  label: "",
});

/** A recipe owns its breads; a bread merely refers to its main ingredient; a coupon points at a customer. */
const BAKERY: DiagramTemplate = validateTemplate({
  version: 1,
  meta: { title: "Bakery" },
  nodes: [
    table("bread", "Bread", [{ id: "id", name: "id", key: "pk" }, { id: "recipe_id", name: "recipe_id", key: "fk" }, { id: "ingredient_id", name: "ingredient_id", key: "fk" }], 0, 0),
    table("recipe", "Recipe", [{ id: "id", name: "id", key: "pk" }], 500, 0),
    table("ingredient", "Ingredient", [{ id: "id", name: "id", key: "pk" }], 500, 300),
    table("coupon", "Coupon", [{ id: "id", name: "id", key: "pk" }, { id: "customer_id", name: "customer_id", key: "fk" }], 0, 300),
    table("customer", "Customer", [{ id: "id", name: "id", key: "pk" }], 500, 600),
  ],
  edges: [
    fk("breads", "bread", "recipe", "recipe_id", "composition"),
    fk("main", "bread", "ingredient", "ingredient_id", "reference"),
    fk("coupons", "coupon", "customer", "customer_id", "reference"),
  ],
} as unknown as DiagramTemplate);

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

describe("registry", () => {
  it("carries the vocabulary, lets a host relabel or extend it, and names what nobody registered", () => {
    const plain = createRegistry();
    expect(plain.relationOrder).toEqual(["composition", "aggregation", "reference", "hierarchy", "polymorphic", "generalization"]);
    expect(relationDef(plain, "composition").label).toBe("Composition");
    // A source's own words for the same line.
    const crm = createRegistry({ relationKinds: { composition: { label: "Master-detail" }, reference: { label: "Lookup" }, ownership: { label: "Ownership", color: "emerald" } } });
    expect(relationDef(crm, "composition")).toMatchObject({ label: "Master-detail", style: "solid", color: "rose", startHead: "diamond-filled" });
    expect(relationDef(crm, "reference").label).toBe("Lookup");
    expect(crm.relationOrder).toEqual(["composition", "aggregation", "reference", "hierarchy", "polymorphic", "generalization", "ownership"]);
    // Unregistered: named after its id, drawn as the plain reference line.
    expect(relationDef(plain, "many-to-many")).toMatchObject({ label: "Many To Many", style: "dashed", color: "slate" });
  });
});

describe("canvas legend", () => {
  it("lists the kinds the visible lines carry, in vocabulary order, with counts and the line as the swatch", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={BAKERY} welcome={false} />);
    const key = await screen.findByRole("list", { name: "Relationships" });
    const rows = within(key).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["Composition1", "Reference2"]);
    // The sample is the line itself: a diamond drawn for the composition, none for the reference.
    expect(rows[0].querySelectorAll("svg.as-legend__line path")).toHaveLength(2);
    expect(rows[1].querySelectorAll("svg.as-legend__line path")).toHaveLength(1);
    expect(rows[0].getAttribute("title")).toBe(RELATION_KINDS.composition!.description);
    // Nothing else claims the key: no zones, no lit paths.
    expect(within(container).queryByText("Infrastructure")).not.toBeInTheDocument();
  });

  it("reads a registry's names, and stays silent for a diagram whose lines say nothing", async () => {
    const registry = { relationKinds: { composition: { label: "Master-detail" }, reference: { label: "Lookup" } } };
    mount(<ArchitectureStudio defaultValue={BAKERY} registry={registry} welcome={false} />);
    const key = await screen.findByRole("list", { name: "Relationships" });
    expect(within(key).getAllByRole("listitem").map((r) => r.textContent)).toEqual(["Master-detail1", "Lookup2"]);
    cleanup();
    const mute = validateTemplate({ ...BAKERY, edges: BAKERY.edges.map(({ relation: _r, ...e }) => e) });
    mount(<ArchitectureStudio defaultValue={mute} welcome={false} />);
    await screen.findAllByText("Bread");
    expect(screen.queryByRole("list", { name: "Relationships" })).not.toBeInTheDocument();
  });
});

describe("legend parity under a folded group", () => {
  /**
   * A subject area folded to a chip: its inner composition is off screen,
   * its two references to the outside collapse into one summarising line
   * that claims no kind, and one reference from elsewhere still draws. Both
   * keys must say the same thing about it.
   */
  const FOLDED: DiagramTemplate = validateTemplate({
    version: 1,
    nodes: [
      { id: "orders", label: "Orders", kind: "group", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 600, h: 300, collapsed: true },
      { ...table("order", "Order", [{ id: "id", name: "id", key: "pk" }, { id: "customer_id", name: "customer_id", key: "fk" }], 20, 40), parentId: "orders" },
      { ...table("line", "Line", [{ id: "id", name: "id", key: "pk" }, { id: "order_id", name: "order_id", key: "fk" }, { id: "customer_id", name: "customer_id", key: "fk" }], 320, 40), parentId: "orders" },
      table("customer", "Customer", [{ id: "id", name: "id", key: "pk" }], 800, 0),
      table("coupon", "Coupon", [{ id: "id", name: "id", key: "pk" }, { id: "customer_id", name: "customer_id", key: "fk" }], 800, 400),
    ],
    edges: [
      fk("lines", "line", "order", "order_id", "composition"),
      fk("order-customer", "order", "customer", "customer_id", "reference"),
      fk("line-customer", "line", "customer", "customer_id", "reference"),
      fk("coupon-customer", "coupon", "customer", "customer_id", "reference"),
    ],
  } as unknown as DiagramTemplate);

  it("counts what is drawn — the canvas key and the picture's key agree", async () => {
    mount(<ArchitectureStudio defaultValue={FOLDED} welcome={false} />);
    const key = await screen.findByRole("list", { name: "Relationships" });
    // One reference on screen (Coupon → Customer); the chip's summarising line carries no kind.
    expect(within(key).getAllByRole("listitem").map((r) => r.textContent)).toEqual(["Reference"]);

    const texts = emitTemplate(FOLDED, createRegistry()).cmds.filter((c) => c.op === "text").map((c) => (c as { text: string }).text);
    expect(texts).toContain("RELATIONSHIPS");
    expect(texts).toContain("Reference");
    expect(texts).not.toContain("Composition");

    // Unfolded, both keys see every line again.
    cleanup();
    const open = validateTemplate({ ...FOLDED, nodes: FOLDED.nodes.map((n) => (n.id === "orders" ? { ...n, collapsed: false } : n)) });
    mount(<ArchitectureStudio defaultValue={open} welcome={false} />);
    const openKey = await screen.findByRole("list", { name: "Relationships" });
    expect(within(openKey).getAllByRole("listitem").map((r) => r.textContent)).toEqual(["Composition1", "Reference3"]);
    const openTexts = emitTemplate(open, createRegistry()).cmds.filter((c) => c.op === "text").map((c) => (c as { text: string }).text);
    expect(openTexts).toContain("Composition");
    expect(openTexts.filter((t) => t === "3")).toHaveLength(1);
  });
});

describe("inspector", () => {
  it("picking a kind dresses the line as the legend shows it; clearing keeps the dressing", async () => {
    const onChange = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={BAKERY} onChange={onChange} welcome={false} />);
    await waitFor(() => expect(container.querySelector('[data-id="coupons"] .as-edge__hit')).toBeTruthy());
    fireEvent.click(container.querySelector('[data-id="coupons"] .as-edge__hit')!);
    const picker = await screen.findByLabelText("Relationship kind");
    expect(picker).toHaveValue("reference");
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["relation: none", "Composition", "Aggregation", "Reference", "Hierarchy", "Polymorphic", "Generalization"]);

    fireEvent.change(picker, { target: { value: "composition" } });
    await waitFor(() => {
      const edge = (onChange.mock.calls.at(-1)?.[0] as DiagramTemplate).edges.find((e) => e.id === "coupons")!;
      expect(edge).toMatchObject({ relation: "composition", style: "solid", color: "rose", startHead: "diamond-filled", startLabel: "*", endLabel: "1" });
    });

    fireEvent.change(picker, { target: { value: "" } });
    await waitFor(() => {
      const edge = (onChange.mock.calls.at(-1)?.[0] as DiagramTemplate).edges.find((e) => e.id === "coupons")!;
      expect(edge.relation).toBeUndefined();
      // The line looks as it did — "none" is a statement about meaning, not a restyle.
      expect(edge).toMatchObject({ style: "solid", color: "rose", startHead: "diamond-filled" });
    });
  });
});

describe("export", () => {
  it("draws the same key into the picture: a RELATIONSHIPS block with a line sample per kind", () => {
    const { cmds } = emitTemplate(BAKERY, createRegistry());
    const texts = cmds.filter((c) => c.op === "text").map((c) => (c as { text: string }).text);
    expect(texts).toContain("RELATIONSHIPS");
    expect(texts).toContain("Composition");
    expect(texts).toContain("Reference");
    expect(texts).not.toContain("INFRASTRUCTURE");
    // Counts as on the canvas: two references, one composition.
    expect(texts.filter((t) => t === "2")).toHaveLength(1);
    // The composition's sample carries its diamond — a hollow stroked path
    // beside the dashed/solid line samples.
    const samples = cmds.filter((c) => c.op === "path" && "dash" in c && !c.tag);
    expect(samples.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves a picture without relationship kinds exactly as it was", () => {
    const mute = validateTemplate({ ...BAKERY, edges: BAKERY.edges.map(({ relation: _r, ...e }) => e) });
    const texts = emitTemplate(mute, createRegistry()).cmds.filter((c) => c.op === "text").map((c) => (c as { text: string }).text);
    expect(texts).not.toContain("RELATIONSHIPS");
  });

  it("Mermaid draws a composition identifying (solid) and every other kind non-identifying (dashed)", () => {
    const out = renderTemplateToMermaid(BAKERY);
    expect(out).toContain("bread }o--|| recipe");
    expect(out).toContain("bread }o..o| ingredient");
    // A line that says nothing about its kind stays solid, as it always did.
    const mute = validateTemplate({ ...BAKERY, edges: BAKERY.edges.map(({ relation: _r, ...e }) => e) });
    expect(renderTemplateToMermaid(mute)).toContain("bread }o--o| ingredient");
  });
});
