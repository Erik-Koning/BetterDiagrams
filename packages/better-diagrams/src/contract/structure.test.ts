/**
 * structure.test.ts — hubs, articulation points and bridges, islands,
 * suggested domains, misplaced tables.
 */
import { describe, expect, it } from "vitest";
import { modelStructure, summarizeStructure } from "./structure";

const table = (id: string, parentId?: string) => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  fields: [{ id: "id", name: "id", key: "pk" as const }],
  ...(parentId ? { parentId } : {}),
});
const fk = (id: string, source: string, target: string) => ({ id, source, target, startField: `${target}_id`, endField: "id" });

/**
 *   Two triangles joined by one key (hub_a — hub_b), a tail off hub_b,
 *   and a table no key touches:
 *
 *   a1 ─ a2          b1 ─ b2
 *    \  /             \  /
 *    hubA ─────────── hubB ─ tail        lonely
 */
const DOC = {
  nodes: [
    table("a1", "sales"),
    table("a2", "sales"),
    table("hubA", "sales"),
    table("b1", "billing"),
    table("b2", "billing"),
    table("hubB", "sales"),
    table("tail", "billing"),
    table("lonely"),
    { id: "note", label: "A note" },
  ],
  edges: [
    fk("e1", "a1", "a2"),
    fk("e2", "a2", "hubA"),
    fk("e3", "a1", "hubA"),
    fk("e4", "b1", "b2"),
    fk("e5", "b2", "hubB"),
    fk("e6", "b1", "hubB"),
    fk("bridge", "hubA", "hubB"),
    fk("e7", "tail", "hubB"),
    { id: "arch", source: "note", target: "a1" },
  ],
};

describe("modelStructure", () => {
  const s = modelStructure(DOC);

  it("ranks the tables holding the model together first", () => {
    expect(s.hubs.slice(0, 2)).toEqual(["hubB", "hubA"]);
    expect(s.metrics.get("hubB")).toMatchObject({ degreeIn: 4, degreeOut: 0 });
    expect(s.metrics.get("a1")!.betweenness).toBe(0);
    expect(s.metrics.get("hubB")!.centrality).toBeGreaterThan(s.metrics.get("hubA")!.centrality);
    expect(s.hubs).not.toContain("lonely");
    expect(s.approximate).toBe(false);
  });

  it("finds the tables and keys whose loss splits the model", () => {
    expect(s.articulation.sort()).toEqual(["hubA", "hubB"]);
    expect(s.bridges.sort()).toEqual(["bridge", "e7"]);
    // Without HubB: the tail, the b-pair, and the a-side.
    expect(s.splits).toEqual({ hubA: 2, hubB: 3 });
  });

  it("never calls one of two parallel keys a bridge", () => {
    const doubled = { nodes: DOC.nodes, edges: [...DOC.edges, fk("bridge2", "hubB", "hubA")] };
    expect(modelStructure(doubled).bridges).toEqual(["e7"]);
  });

  it("lists the tables no key touches, and leaves non-tables out", () => {
    expect(s.islands).toEqual(["lonely"]);
    expect(s.metrics.has("note")).toBe(false);
  });

  it("suggests the two clusters as domains, named after their most central table", () => {
    expect(s.domains).toHaveLength(2);
    const byLabel = Object.fromEntries(s.domains.map((d) => [d.label, [...d.tables].sort()]));
    expect(byLabel).toEqual({ HubA: ["a1", "a2", "hubA"], HubB: ["b1", "b2", "hubB", "tail"] });
    expect(s.domains[0]).toMatchObject({ id: "domain-1", label: "HubB", internalKeys: 4, externalKeys: 1 });
    expect(s.modularity).toBeGreaterThan(0.3);
  });

  it("is deterministic", () => {
    expect(modelStructure(DOC).domains).toEqual(s.domains);
  });

  it("flags a table whose keys mostly lead into another group", () => {
    expect(s.misplaced).toEqual([{ nodeId: "hubB", group: "sales", pullsToward: "billing", share: 0.75 }]);
  });

  it("samples betweenness past the threshold and says so", () => {
    const approx = modelStructure(DOC, { sampleAbove: 3 });
    expect(approx.approximate).toBe(true);
    expect(approx.hubs[0]).toBe("hubB");
  });

  it("summarises as plain JSON, the way the panels read it", () => {
    const sum = summarizeStructure(DOC, s, { hubs: 2 });
    expect(sum.hubs).toEqual([
      { id: "hubB", degree: 4, centrality: expect.any(Number) },
      { id: "hubA", degree: 3, centrality: expect.any(Number) },
    ]);
    expect(sum.articulation).toEqual([{ id: "hubB", splits: 3 }, { id: "hubA", splits: 2 }]);
    expect(sum.bridges).toContainEqual({ edgeId: "bridge", source: "hubA", target: "hubB", field: "hubB_id" });
    expect(sum.tables).toBe(8);
    expect(JSON.parse(JSON.stringify(sum))).toEqual(sum);
  });

  it("finds the clusters under tables every cluster points at, and sets those aside as shared", () => {
    // 30 clusters of 20 tables, each table keyed to a few in its own cluster —
    // and every one also to users and accounts, as real models are.
    const nodes = [table("users"), table("accounts")];
    const edges = [fk("a-u", "accounts", "users")];
    for (let c = 0; c < 30; c++) {
      for (let k = 0; k < 20; k++) {
        const id = `c${c}t${k}`;
        nodes.push(table(id));
        edges.push(fk(`${id}-u`, id, "users"), fk(`${id}-a`, id, "accounts"));
        for (const d of [1, 7]) edges.push(fk(`${id}-${d}`, id, `c${c}t${(k + d) % 20}`));
      }
    }
    // One table joined to nothing but the shared ones.
    nodes.push(table("lookup"));
    edges.push(fk("l-u", "lookup", "users"));
    const big = modelStructure({ nodes, edges });
    expect(big.shared).toEqual(["users", "accounts"]);
    expect(big.unassigned).toEqual(["lookup"]);
    // Every domain stays inside one cluster, and the clusters are found.
    const clusterOf = (id: string) => id.split("t")[0];
    for (const d of big.domains) expect(new Set(d.tables.map(clusterOf)).size, d.label).toBe(1);
    expect(big.domains.length).toBeGreaterThanOrEqual(28);
    expect(big.domains.length).toBeLessThanOrEqual(36);
    expect(big.modularity).toBeGreaterThan(0.8);
    expect(modelStructure({ nodes, edges }).domains).toEqual(big.domains);
    // Without setting anything aside, the shared tables glue it into far fewer.
    expect(modelStructure({ nodes, edges }, { sharedThreshold: false }).shared).toEqual([]);
  });

  it("keeps a table at the centre of its own domain in it, however many keys it has", () => {
    // Product: eight production tables around it, two from elsewhere — a centre, not shared.
    const nodes = [table("product"), table("order"), table("vendor"), table("vendor_contact"), table("order_line_note")];
    const edges = [fk("v-c", "vendor_contact", "vendor"), fk("n-o", "order_line_note", "order"), fk("o-p", "order", "product"), fk("v-p", "vendor", "product")];
    for (let k = 0; k < 8; k++) {
      nodes.push(table(`prod${k}`));
      edges.push(fk(`p${k}`, `prod${k}`, "product"), fk(`q${k}`, `prod${k}`, `prod${(k + 1) % 8}`));
    }
    const s = modelStructure({ nodes, edges });
    // Clustering cuts the ring of production tables in two; the half without
    // Product exists only around it, so it counts as Product's home, not as
    // another domain Product's keys spread to.
    expect(s.shared).toEqual([]);
    expect(s.domains.find((d) => d.tables.includes("product"))!.tables).toContain("prod0");
  });

  it("handles an empty model", () => {
    expect(modelStructure({ nodes: [], edges: [] })).toMatchObject({ hubs: [], bridges: [], domains: [], modularity: 0 });
  });
});
