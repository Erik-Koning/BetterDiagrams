/**
 * @vitest-environment jsdom
 *
 * Data-model rendering: the rows on the canvas, the same rows in an export,
 * and the inspector that edits them.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";
import {
  FIELD_ROW_H,
  fieldListTop,
  validateTemplate,
  type DiagramTemplate,
} from "../contract/schema";
import { emitTemplate } from "./draw";
import { renderTemplateToMermaid } from "./exporters";
import { createRegistry } from "./create-registry";
import { ArchitectureStudio } from "./ArchitectureStudio";

afterEach(cleanup);

const MODEL = validateTemplate({
  version: 1,
  nodes: [
    {
      id: "users",
      label: "users",
      kind: "table",
      icon: "none",
      description: "",
      parentId: null,
      x: 0,
      y: 0,
      w: 230,
      h: 200,
      fields: [
        { id: "id", name: "id", type: "uuid", key: "pk", required: true },
        { id: "email", name: "email", type: "citext" },
      ],
    },
    {
      id: "orders",
      label: "orders",
      kind: "table",
      icon: "none",
      description: "",
      parentId: null,
      x: 600,
      y: 0,
      w: 230,
      h: 200,
      fields: [{ id: "user_id", name: "user_id", type: "uuid", key: "fk" }],
    },
  ],
  edges: [
    {
      id: "fk1",
      source: "orders",
      target: "users",
      label: "",
      style: "solid",
      color: "slate",
      startField: "user_id",
      endField: "id",
      startLabel: "0..*",
      endLabel: "1",
    },
  ],
} as unknown as DiagramTemplate);

const texts = (t: DiagramTemplate) =>
  emitTemplate(t, createRegistry())
    .cmds.filter((c) => c.op === "text")
    .map((c) => (c as { text: string }).text);

describe("export", () => {
  it("draws every row, its type, and its key badge", () => {
    const out = texts(MODEL);
    expect(out).toContain("id*");
    expect(out).toContain("uuid");
    expect(out).toContain("email");
    expect(out).toContain("citext");
    expect(out).toContain("PK");
    expect(out).toContain("FK");
  });

  it("draws the cardinality at both ends", () => {
    const out = texts(MODEL);
    expect(out).toContain("0..*");
    expect(out).toContain("1");
  });

  it("lands a field-anchored edge on the row, not the middle of the box", () => {
    const { cmds } = emitTemplate(MODEL, createRegistry());
    // The edge path is the only stroked path with a bezier/line command run
    // between the two tables; its first point is the source attachment.
    const edgePath = cmds.find(
      (c) => c.op === "path" && c.tag?.id === "edge:fk1",
    ) as { d: string } | undefined;
    expect(edgePath).toBeDefined();
    const [, startY] = /^M ([\d.-]+) ([\d.-]+)/.exec(edgePath!.d)!.slice(1).map(Number);
    // `user_id` is the first row of orders, whose box top is y = 0.
    expect(startY).toBeCloseTo(fieldListTop(false) + FIELD_ROW_H / 2, 5);
  });

  it("draws a crow's foot at a cardinality end, and no arrowhead there", () => {
    const { cmds } = emitTemplate(MODEL, createRegistry());
    const edge = cmds.filter((c) => c.tag?.id === "edge:fk1");
    // "0..*" at the source end and "1" at the target: a foot with a ring, and
    // the two bars of exactly-one. Neither end keeps the default arrowhead.
    const paths = edge.filter((c) => c.op === "path").map((c) => (c as { d: string }).d);
    expect(paths.some((d) => d.includes("A 4 4"))).toBe(true);
    expect(edge.some((c) => c.op === "poly")).toBe(false);
  });

  it("keeps the arrowhead on an end whose label is role text, not cardinality", () => {
    const roles = validateTemplate({
      ...MODEL,
      edges: [{ ...MODEL.edges[0], startLabel: undefined, endLabel: "owns" }],
    });
    const edge = emitTemplate(roles, createRegistry()).cmds.filter((c) => c.tag?.id === "edge:fk1");
    expect(edge.some((c) => c.op === "poly")).toBe(true);
  });

  it("leaves an ordinary diagram's output untouched", () => {
    const plain = validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
        { id: "b", label: "B", kind: "service", icon: "box", description: "", parentId: null, x: 400, y: 0, w: 170, h: 76 },
      ],
      edges: [{ id: "e1", source: "a", target: "b", label: "calls", style: "solid", color: "slate" }],
    } as unknown as DiagramTemplate);
    const before = JSON.stringify(emitTemplate(plain, createRegistry()).cmds);
    expect(before).toContain("calls");
    expect(before).not.toContain("PK");
  });
});

describe("mermaid", () => {
  it("exports a data model as an erDiagram, with columns and cardinality", () => {
    const out = renderTemplateToMermaid(MODEL);
    expect(out.startsWith("erDiagram")).toBe(true);
    expect(out).toContain("uuid id PK");
    expect(out).toContain('citext email');
    expect(out).toContain("uuid user_id FK");
    // orders 0..* ──> users 1
    expect(out).toContain("orders }o--|| users");
  });

  it("keeps a mixed document a flowchart — a service has no columns to claim", () => {
    const mixed = validateTemplate({
      ...MODEL,
      nodes: [
        ...MODEL.nodes,
        { id: "api", label: "API", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 400, w: 170, h: 76 },
      ],
      edges: [],
    } as unknown as DiagramTemplate);
    expect(renderTemplateToMermaid(mixed)).toContain("flowchart LR");
  });

  it("reads free-form cardinality, and falls back to exactly-one", () => {
    const one = validateTemplate({
      ...MODEL,
      edges: [{ ...MODEL.edges[0], startLabel: "1", endLabel: "0..1" }],
    });
    expect(renderTemplateToMermaid(one)).toContain("orders ||--o| users");
    const none = validateTemplate({
      ...MODEL,
      edges: [{ ...MODEL.edges[0], startLabel: undefined, endLabel: undefined }],
    });
    expect(renderTemplateToMermaid(none)).toContain("orders ||--|| users");
  });
});

describe("canvas", () => {
  const mount = (ui: React.ReactElement) => {
    const host = document.createElement("div");
    Object.assign(host.style, { width: "1200px", height: "800px" });
    document.body.appendChild(host);
    return render(ui, { container: host });
  };

  /**
   * Select a canvas node with a plain click. userEvent's full pointer sequence
   * drives React Flow's d3-drag handlers, which reach for a window jsdom has
   * already torn down between tests — the same reason the studio's own suite
   * uses fireEvent here.
   */
  const selectNode = async (label: string) =>
    fireEvent.click((await screen.findAllByText(label))[0]);

  it("renders a row per field, with its key badge and type", async () => {
    mount(<ArchitectureStudio defaultValue={MODEL} welcome={false} />);
    const rows = await screen.findAllByText("email");
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.getAllByText("uuid").length).toBeGreaterThan(0);
    expect(screen.getAllByText("pk").length).toBeGreaterThan(0);
  });

  it("draws the cardinality symbols on the canvas", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={MODEL} welcome={false} />);
    await screen.findAllByText("email");
    await waitFor(() => expect(container.querySelectorAll(".as-edge__crow")).toHaveLength(2));
    // The relationship reads by its symbols, so neither end keeps an arrowhead.
    expect(container.querySelectorAll(".as-edge__arrow")).toHaveLength(0);
  });

  it("edits a row through the inspector and keeps it in the emitted document", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={MODEL} welcome={false} onChange={onChange} />);

    await selectNode("orders");
    const name = await screen.findByLabelText("Field 1 name");
    await user.clear(name);
    await user.type(name, "customer_id");

    const last = onChange.mock.calls.at(-1)?.[0] as DiagramTemplate | undefined;
    expect(last?.nodes.find((n) => n.id === "orders")?.fields?.[0].name).toBe("customer_id");
  });

  it("adds and removes a row", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={MODEL} welcome={false} onChange={onChange} />);

    await selectNode("orders");
    await user.click(await screen.findByRole("button", { name: "+ field" }));
    expect(
      (onChange.mock.calls.at(-1)?.[0] as DiagramTemplate).nodes.find((n) => n.id === "orders")
        ?.fields,
    ).toHaveLength(2);

    await user.click(await screen.findByRole("button", { name: /Remove user_id/ }));
    expect(
      (onChange.mock.calls.at(-1)?.[0] as DiagramTemplate).nodes.find((n) => n.id === "orders")
        ?.fields,
    ).toHaveLength(1);
  });

  it("inserts a table that already has its key row", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={MODEL} welcome={false} onChange={onChange} />);

    await user.click(await screen.findByRole("button", { name: "Insert ▾" }));
    await user.click(await screen.findByRole("menuitem", { name: /Table/ }));

    const doc = onChange.mock.calls.at(-1)?.[0] as DiagramTemplate;
    const added = doc.nodes.at(-1)!;
    expect(added.kind).toBe("table");
    expect(added.fields).toEqual([{ id: "id", name: "id", type: "uuid", key: "pk", required: true }]);
    // Tall enough to show it — the validator's floor, not a guess.
    expect(added.h).toBeGreaterThanOrEqual(fieldListTop(false) + FIELD_ROW_H);
  });

  it("offers no field editor on an ordinary service node", async () => {
    const plain = validateTemplate({
      version: 1,
      nodes: [{ id: "api", label: "API", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 }],
      edges: [],
    } as unknown as DiagramTemplate);
    mount(<ArchitectureStudio defaultValue={plain} welcome={false} />);
    await selectNode("API");
    await screen.findByLabelText("Node label");
    expect(screen.queryByRole("button", { name: "+ field" })).toBeNull();
  });
});
