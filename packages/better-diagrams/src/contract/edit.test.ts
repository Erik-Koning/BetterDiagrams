import { describe, expect, it } from "vitest";
import {
  addEdge,
  addNode,
  addZone,
  removeEdges,
  removeElements,
  removeNodes,
  removeZones,
  renameNode,
  uniqueId,
  updateEdge,
  updateNode,
  updateZone,
} from "./edit";
import { validateTemplate, type DiagramTemplate } from "./schema";

/** api → db, a group holding a worker, a dot at the end of a dangling arrow, one zone. */
function sample(): DiagramTemplate {
  return validateTemplate({
    version: 1,
    zones: [{ id: "aws", label: "AWS", providers: ["aws"], provider: "aws", x: 0, y: 0, w: 800, h: 600 }],
    nodes: [
      { id: "api", label: "API", kind: "service", x: 40, y: 40, zoneId: "aws" },
      { id: "db", label: "DB", kind: "database", x: 300, y: 40 },
      { id: "jobs", label: "Jobs", kind: "group", x: 40, y: 300, w: 320, h: 200 },
      { id: "worker", label: "Worker", kind: "service", parentId: "jobs", x: 20, y: 40 },
      { id: "dot", label: "", kind: "point", x: 600, y: 300 },
    ],
    edges: [
      { id: "e1", source: "api", target: "db", label: "reads" },
      { id: "e2", source: "worker", target: "db" },
      { id: "e3", source: "api", target: "dot" },
    ],
    paths: [{ id: "read", title: "Read", steps: ["api", "db"] }],
    lineage: [{ id: "l1", from: { nodeId: "api", fieldId: "x" }, to: { nodeId: "db", fieldId: "y" } }],
    analyses: [{ id: "a1", title: "From the API", kind: "neighbourhood", from: ["api"], depth: 1, direction: "out", keysOnly: false }],
    meta: { title: "Sample", views: { jobs: { nodes: { worker: { x: 1, y: 2, w: 100, h: 50 } } } } },
  });
}

describe("uniqueId", () => {
  it("slugs the base and counts up past every id in use", () => {
    const doc = sample();
    expect(uniqueId(doc, "Redis Cache")).toBe("redis-cache");
    expect(uniqueId(doc, "API")).toBe("api-2");
    expect(uniqueId(doc, "e1")).toBe("e1-2"); // edge ids count too
    expect(uniqueId(doc, "Café ✨")).toBe("cafe");
    expect(uniqueId(doc, "!!!")).toBe("node");
  });
});

describe("addNode", () => {
  it("fills what a node needs, makes an id from the label, and places it without moving anything", () => {
    const before = sample();
    const doc = addNode(before, { label: "Redis Cache", kind: "database" });
    const node = doc.nodes.at(-1)!;
    expect(node).toMatchObject({ id: "redis-cache", label: "Redis Cache", kind: "database", icon: "none", parentId: null });
    expect(node.w).toBeGreaterThan(0);
    // Placed somewhere free rather than piled on the origin with the API.
    expect(node.x !== 0 || node.y !== 0).toBe(true);
    for (const old of before.nodes) {
      const now = doc.nodes.find((n) => n.id === old.id)!;
      expect([now.x, now.y]).toEqual([old.x, old.y]);
    }
    expect(before.nodes).toHaveLength(5); // the input is untouched
  });

  it("keeps a position it is given, and survives validation as written", () => {
    const doc = addNode(sample(), { id: "cdn", label: "CDN", kind: "gateway", x: 500, y: 500 });
    const cdn = validateTemplate(doc).nodes.find((n) => n.id === "cdn")!;
    expect([cdn.x, cdn.y, cdn.kind]).toEqual([500, 500, "gateway"]);
  });

  it("refuses an id in use and references to nothing", () => {
    expect(() => addNode(sample(), { id: "api" })).toThrow('A node with id "api" already exists');
    expect(() => addNode(sample(), { parentId: "nope" })).toThrow('No node with id "nope" for the parent');
    expect(() => addNode(sample(), { zoneId: "gcp" })).toThrow('No zone with id "gcp"');
  });
});

describe("updateNode", () => {
  it("merges a patch, and an explicit undefined clears a key", () => {
    const doc = updateNode(sample(), "api", { label: "Gateway API", zoneId: undefined, tags: ["edge"] });
    const api = doc.nodes.find((n) => n.id === "api")!;
    expect(api.label).toBe("Gateway API");
    expect(api.tags).toEqual(["edge"]);
    expect("zoneId" in api).toBe(false);
  });

  it("takes a function of the node", () => {
    const doc = updateNode(sample(), "db", (n) => ({ ...n, label: n.label.toLowerCase() }));
    expect(doc.nodes.find((n) => n.id === "db")!.label).toBe("db");
  });

  it("renames through a new id, rewriting the references", () => {
    const doc = updateNode(sample(), "api", { id: "gateway" });
    expect(doc.edges.find((e) => e.id === "e1")!.source).toBe("gateway");
    expect(doc.paths![0].steps).toEqual(["gateway", "db"]);
  });

  it("refuses a parent that would contain itself, and an unknown node", () => {
    expect(() => updateNode(sample(), "jobs", { parentId: "worker" })).toThrow("cannot be placed inside itself");
    expect(() => updateNode(sample(), "jobs", { parentId: "jobs" })).toThrow("cannot be placed inside itself");
    expect(() => updateNode(sample(), "ghost", { label: "x" })).toThrow('No node with id "ghost"');
  });
});

describe("renameNode", () => {
  it("rewrites every reference: edges, children, paths, lineage, analyses and per-view layout", () => {
    let doc = renameNode(sample(), "api", "edge-api");
    expect(doc.edges.filter((e) => e.source === "edge-api").map((e) => e.id)).toEqual(["e1", "e3"]);
    expect(doc.paths![0].steps[0]).toBe("edge-api");
    expect(doc.lineage![0].from.nodeId).toBe("edge-api");
    expect(doc.analyses![0]).toMatchObject({ kind: "neighbourhood", from: ["edge-api"] });

    doc = renameNode(doc, "jobs", "batch");
    expect(doc.nodes.find((n) => n.id === "worker")!.parentId).toBe("batch");
    expect(Object.keys(doc.meta!.views!)).toEqual(["batch"]);
    doc = renameNode(doc, "worker", "runner");
    expect(Object.keys(doc.meta!.views!.batch.nodes!)).toEqual(["runner"]);
    // Validation agrees nothing was left dangling.
    expect(validateTemplate(doc)).toEqual(doc);
  });

  it("refuses a taken or empty id", () => {
    expect(() => renameNode(sample(), "api", "db")).toThrow('A node with id "db" already exists');
    expect(() => renameNode(sample(), "api", " ")).toThrow("cannot be empty");
  });
});

describe("removing", () => {
  it("a node takes its descendants, their edges, and a dot left with no line", () => {
    const doc = removeNodes(sample(), ["jobs", "api"]);
    expect(doc.nodes.map((n) => n.id)).toEqual(["db"]);
    expect(doc.edges).toEqual([]);
    // A path loses the step (the editor's rule); lineage and analyses that
    // pointed at a removed node go with it.
    expect(doc.paths![0].steps).toEqual(["db"]);
    expect(doc.lineage).toBeUndefined();
    expect(doc.analyses).toBeUndefined();
    expect(doc.meta!.views).toBeUndefined();
    expect(doc.meta!.title).toBe("Sample");
  });

  it("an edge takes a dot it strands, and no other node", () => {
    const doc = removeEdges(sample(), ["e3", "e1"]);
    expect(doc.nodes.map((n) => n.id)).not.toContain("dot");
    expect(doc.nodes.map((n) => n.id)).toContain("api");
  });

  it("a zone keeps its members and clears their zoneId", () => {
    const doc = removeZones(sample(), ["aws"]);
    expect(doc.zones).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "api")!.zoneId).toBeNull();
  });

  it("ignores ids the document doesn't have and returns the same document", () => {
    const doc = sample();
    expect(removeElements(doc, { nodes: ["nope"], edges: ["nope"], zones: ["nope"] })).toBe(doc);
  });

  it("matches what validation keeps", () => {
    const doc = removeElements(sample(), { nodes: ["db"], zones: ["aws"] });
    expect(validateTemplate(doc)).toEqual(doc);
  });
});

describe("per-view layout", () => {
  /** A drill-in level that has a ghost dragged into place and a ghost edge routed. */
  function withGhosts(): DiagramTemplate {
    const doc = sample();
    return validateTemplate({
      ...doc,
      meta: {
        ...doc.meta,
        views: {
          jobs: {
            nodes: { worker: { x: 1, y: 2, w: 100, h: 50 }, "ghost:api": { x: 400, y: 10, w: 170, h: 76 } },
            edges: { "ghost:e1": { labelT: 0.3 } },
          },
        },
      },
    });
  }

  it("keeps a ghost's place through an unrelated removal", () => {
    const doc = removeEdges(withGhosts(), ["e3"]);
    expect(Object.keys(doc.meta!.views!.jobs.nodes!)).toEqual(["worker", "ghost:api"]);
    expect(Object.keys(doc.meta!.views!.jobs.edges!)).toEqual(["ghost:e1"]);
  });

  it("drops a ghost's place with the element it stands for", () => {
    const doc = removeNodes(withGhosts(), ["api"]);
    expect(Object.keys(doc.meta!.views!.jobs.nodes!)).toEqual(["worker"]);
    expect(doc.meta!.views!.jobs.edges).toBeUndefined(); // e1 went with the API
  });

  it("renames a ghost's key with its node or edge", () => {
    let doc = renameNode(withGhosts(), "api", "gateway");
    expect(Object.keys(doc.meta!.views!.jobs.nodes!)).toEqual(["worker", "ghost:gateway"]);
    doc = updateEdge(doc, "e1", { id: "reads" });
    expect(Object.keys(doc.meta!.views!.jobs.edges!)).toEqual(["ghost:reads"]);
    expect(validateTemplate(doc)).toEqual(doc);
  });
});

describe("defaults", () => {
  it("survive an explicit undefined in what is added", () => {
    const node = addNode(sample(), { id: "n", label: "N", w: undefined, h: undefined, icon: undefined }).nodes.at(-1)!;
    expect(node.w).toBeGreaterThan(0);
    expect(node.h).toBeGreaterThan(0);
    expect(node.icon).toBe("none");
    const edge = addEdge(sample(), { source: "api", target: "db", label: undefined, style: undefined }).edges.at(-1)!;
    expect([edge.label, edge.style, edge.color]).toEqual(["", "solid", "slate"]);
    const zone = addZone(sample(), { id: "z", shape: undefined, w: undefined }).zones!.at(-1)!;
    expect([zone.shape, zone.w]).toEqual(["rounded", 400]);
  });

  it("an id cut to length doesn't end on a dash", () => {
    expect(uniqueId(sample(), `${"a".repeat(47)} b`)).toBe("a".repeat(47));
  });
});

describe("edges", () => {
  it("connect existing nodes with defaults and a readable id", () => {
    const doc = addEdge(sample(), { source: "worker", target: "api", label: "calls" });
    expect(doc.edges.at(-1)).toEqual({ id: "e-worker-api", source: "worker", target: "api", label: "calls", style: "solid", color: "slate" });
    expect(() => addEdge(sample(), { source: "api", target: "nope" })).toThrow('No node with id "nope" for the target');
    expect(() => addEdge(sample(), { id: "e1", source: "api", target: "db" })).toThrow('An edge with id "e1" already exists');
  });

  it("update checks new ends, drops a field anchor its end no longer has, and renames into paths", () => {
    const withField = updateEdge(sample(), "e1", { endField: "id" });
    const moved = updateEdge(withField, "e1", { target: "worker" });
    expect(moved.edges.find((e) => e.id === "e1")).not.toHaveProperty("endField");
    expect(() => updateEdge(sample(), "e1", { target: "nope" })).toThrow('No node with id "nope"');

    const doc = addEdge(sample(), { id: "e1b", source: "api", target: "db" });
    const withStep = { ...doc, paths: [{ id: "read", title: "Read", steps: ["api", "e1", "db"] }] };
    expect(updateEdge(withStep, "e1", { id: "reads" }).paths![0].steps).toEqual(["api", "reads", "db"]);
  });
});

describe("zones", () => {
  it("add with validation's defaults, and a rename moves the members with it", () => {
    let doc = addZone(sample(), { label: "Azure", provider: "azure" });
    expect(doc.zones!.at(-1)).toMatchObject({ id: "azure", label: "Azure", shape: "rounded", providers: ["azure"], provider: "azure" });
    doc = updateZone(doc, "aws", { id: "amazon" });
    expect(doc.nodes.find((n) => n.id === "api")!.zoneId).toBe("amazon");
    expect(() => addZone(doc, { id: "amazon" })).toThrow("already exists");
  });
});
