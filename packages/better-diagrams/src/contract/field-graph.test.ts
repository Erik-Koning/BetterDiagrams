/**
 * field-graph.test.ts — routes between FIELDS: `fieldPaths`, the two-tier
 * `between`, and `reachableFrom`, on a hand-built model and on the imported
 * Salesforce fixture.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { between, fieldPaths, keyFrequency, reachableFrom, shortestPaths } from "./graph";
import { readFolderToFileMap } from "./folder/node";
import { importFolder } from "./folder/import";
import type { DiagramTemplate } from "./schema";

const node = (id: string) => ({ id });
const fk = (id: string, source: string, target: string, field: string, over: Record<string, unknown> = {}) => ({
  id,
  source,
  target,
  startField: field,
  endField: "Id",
  ...over,
});

/**
 *   contact.AccountId ─→ account.Id           (c-a)
 *   contact.OwnerId   ─→ user.Id              (c-u)
 *   case.AccountId    ─→ account.Id           (k-a)
 *   case.ContactId    ─→ contact.Id           (k-c)
 *   comment.ParentId  ═→ case.Id              (m-k, master-detail)
 *   task.WhatId       ─→ account.Id           (t-a)
 *   task.WhoId        ─→ contact.Id           (t-c)
 *   island                                    (no edges)
 */
const MODEL = {
  nodes: ["contact", "account", "user", "case", "comment", "task", "island"].map(node),
  edges: [
    fk("c-a", "contact", "account", "AccountId"),
    fk("c-u", "contact", "user", "OwnerId"),
    fk("k-a", "case", "account", "AccountId"),
    fk("k-c", "case", "contact", "ContactId"),
    fk("m-k", "comment", "case", "ParentId"),
    fk("t-a", "task", "account", "WhatId"),
    fk("t-c", "task", "contact", "WhoId"),
  ],
};
const U = { undirected: true };

describe("fieldPaths", () => {
  it("the direct route: one edge anchored at both fields", () => {
    const r = fieldPaths(MODEL, { nodeId: "contact", fieldId: "AccountId" }, { nodeId: "account", fieldId: "Id" }, U);
    expect(r.walks[0]).toEqual({ nodes: ["contact", "account"], edges: ["c-a"] });
    expect(r.constrained).toEqual({ from: true, to: true });
    expect(r.truncated).toBe(false);
  });

  it("holds both ends to their fields: the first hop leaves through the pinned field", () => {
    // comment.ParentId can only leave through m-k; Account.Id is reached by
    // three edges, so there are three routes in, ranked shortest first.
    const r = fieldPaths(MODEL, { nodeId: "comment", fieldId: "ParentId" }, { nodeId: "account", fieldId: "Id" }, U);
    expect(r.walks.map((w) => w.edges)).toEqual([
      ["m-k", "k-a"],
      ["m-k", "k-c", "c-a"],
      ["m-k", "k-c", "t-c", "t-a"],
    ]);
    expect(r.walks.every((w) => w.edges[0] === "m-k")).toBe(true);
    // Undirected: from contact.OwnerId the only way out is through user, a dead end.
    expect(fieldPaths(MODEL, { nodeId: "contact", fieldId: "OwnerId" }, { nodeId: "account", fieldId: "Id" }, U).walks).toEqual([]);
  });

  it("falls back to the table when a field anchors nothing, and says so", () => {
    const r = fieldPaths(MODEL, { nodeId: "contact", fieldId: "Email" }, { nodeId: "account", fieldId: "Id" }, U);
    expect(r.constrained).toEqual({ from: false, to: true });
    expect(r.walks[0]).toEqual({ nodes: ["contact", "account"], edges: ["c-a"] });
    const plain = fieldPaths(MODEL, { nodeId: "contact" }, { nodeId: "account" }, U);
    expect(plain.constrained).toEqual({ from: false, to: false });
    expect(plain.walks.map((w) => w.edges)).toEqual([["c-a"], ["k-c", "k-a"], ["t-c", "t-a"]]);
  });

  it("honours direction unless told not to", () => {
    // Child → parent only: Account.Id never leaves in directed mode.
    expect(fieldPaths(MODEL, { nodeId: "account", fieldId: "Id" }, { nodeId: "contact", fieldId: "AccountId" }).walks).toEqual([]);
    expect(fieldPaths(MODEL, { nodeId: "account", fieldId: "Id" }, { nodeId: "contact", fieldId: "AccountId" }, U).walks[0].edges).toEqual(["c-a"]);
    expect(fieldPaths(MODEL, { nodeId: "comment", fieldId: "ParentId" }, { nodeId: "account", fieldId: "Id" }).walks.map((w) => w.edges)).toEqual([
      ["m-k", "k-a"],
      ["m-k", "k-c", "c-a"],
    ]);
  });

  it("bounds: k, maxDepth, and the same table twice", () => {
    const k1 = fieldPaths(MODEL, { nodeId: "comment", fieldId: "ParentId" }, { nodeId: "account", fieldId: "Id" }, { ...U, k: 1 });
    expect(k1.walks).toHaveLength(1);
    expect(k1.truncated).toBe(true);
    const shallow = fieldPaths(MODEL, { nodeId: "comment", fieldId: "ParentId" }, { nodeId: "account", fieldId: "Id" }, { ...U, maxDepth: 2 });
    expect(shallow.walks.map((w) => w.edges)).toEqual([["m-k", "k-a"]]);
    expect(shallow.truncated).toBe(true);
    expect(fieldPaths(MODEL, { nodeId: "contact", fieldId: "Id" }, { nodeId: "contact", fieldId: "AccountId" }, U).walks).toEqual([]);
    expect(fieldPaths(MODEL, { nodeId: "island", fieldId: "Id" }, { nodeId: "account", fieldId: "Id" }, U).walks).toEqual([]);
    expect(fieldPaths(MODEL, { nodeId: "nope" }, { nodeId: "account" }, U).walks).toEqual([]);
  });

  it("shortestPaths gained maxDepth without changing its default", () => {
    expect(shortestPaths(MODEL, "comment", "account", 5, U)).toHaveLength(3);
    expect(shortestPaths(MODEL, "comment", "account", 5, { ...U, maxDepth: 2 })).toHaveLength(1);
    expect(shortestPaths(MODEL, "comment", "account", 5, { ...U, maxDepth: 1 })).toEqual([]);
  });
});

describe("between", () => {
  it("tier 1 is exact under the bounds and always inside tier 2", () => {
    const r = between(MODEL, { nodeId: "comment", fieldId: "ParentId" }, { nodeId: "account", fieldId: "Id" }, U);
    expect([...r.onRoutes.nodes].sort()).toEqual(["account", "case", "comment", "contact", "task"]);
    expect([...r.onRoutes.edges].sort()).toEqual(["c-a", "k-a", "k-c", "m-k", "t-a", "t-c"]);
    expect(r.routes).toBe(3);
    expect(r.truncated).toBe(false);
    for (const n of r.onRoutes.nodes) expect(r.corridor.nodes.has(n)).toBe(true);
    for (const e of r.onRoutes.edges) expect(r.corridor.edges.has(e)).toBe(true);
    // user is reachable from comment but never on a simple route to account:
    // the corridor within 8 hops still admits it (in via contact, back out
    // through the same table), which is exactly what tier 2 is allowed to do.
    expect(r.onRoutes.nodes.has("user")).toBe(false);
    expect(r.corridor.nodes.has("island")).toBe(false);
  });

  it("holds the last hop to the pinned field", () => {
    // Into contact.Id there are two anchored edges (k-c, t-c); c-a is anchored at AccountId, not Id.
    const r = between(MODEL, { nodeId: "account", fieldId: "Id" }, { nodeId: "contact", fieldId: "Id" }, U);
    expect([...r.onRoutes.edges].sort()).toEqual(["k-a", "k-c", "t-a", "t-c"]);
    expect(r.onRoutes.edges.has("c-a")).toBe(false);
  });

  it("stops at the expansion limit and at the time budget, and says so", () => {
    const limited = between(MODEL, { nodeId: "comment", fieldId: "ParentId" }, { nodeId: "account", fieldId: "Id" }, { ...U, limit: 2 });
    expect(limited.truncated).toBe(true);
    expect(limited.routes).toBeLessThan(3);
    expect(limited.corridor.nodes.size).toBeGreaterThan(0);

    let t = 0;
    const timed = between(MODEL, { nodeId: "comment", fieldId: "ParentId" }, { nodeId: "account", fieldId: "Id" }, {
      ...U,
      budgetMs: 1,
      limit: 100_000,
      now: () => (t += 100),
    });
    // The clock jumps 100 ms per read; the budget is checked every 256 expansions, and this model has fewer — never truncated by time.
    expect(timed.truncated).toBe(false);
    expect(timed.routes).toBe(3);
  });

  it("the time budget stops a dense enumeration and leaves the corridor intact", () => {
    // 14 tables, every pair joined: simple routes between two of them number in the millions.
    const ids = Array.from({ length: 14 }, (_, i) => `t${i}`);
    const edges: Array<{ id: string; source: string; target: string; startField: string; endField: string }> = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) edges.push(fk(`${ids[i]}-${ids[j]}`, ids[i], ids[j], `Ref_${ids[j]}`));
    }
    const dense = { nodes: ids.map(node), edges };
    let t = 0;
    const r = between(dense, { nodeId: "t0" }, { nodeId: "t13" }, { ...U, maxDepth: 8, limit: 10_000_000, budgetMs: 50, now: () => (t += 1) });
    expect(r.truncated).toBe(true);
    expect(r.routes).toBeGreaterThan(0);
    expect(r.corridor.nodes.size).toBe(14);
    // And the expansion limit alone, with an unlimited clock.
    const capped = between(dense, { nodeId: "t0" }, { nodeId: "t13" }, { ...U, maxDepth: 8, limit: 5_000, budgetMs: 1e9 });
    expect(capped.truncated).toBe(true);
  });

  it("directed vs undirected, and nothing between unrelated tables", () => {
    const directed = between(MODEL, { nodeId: "account", fieldId: "Id" }, { nodeId: "contact", fieldId: "AccountId" });
    expect(directed.routes).toBe(0);
    expect(directed.corridor.nodes).toEqual(new Set(["account"]));
    expect(between(MODEL, { nodeId: "island" }, { nodeId: "account" }, U).routes).toBe(0);
    expect(between(MODEL, { nodeId: "account" }, { nodeId: "account" }, U).corridor.nodes.size).toBe(0);
  });
});

describe("keyFrequency", () => {
  it("counts, per key, the routes that travel it, most-used first", () => {
    const r = keyFrequency(MODEL, { nodeId: "comment", fieldId: "ParentId" }, { nodeId: "account", fieldId: "Id" }, U);
    expect(r.routes).toBe(3);
    // Ties keep the document order of each key's first edge (c-a, k-a, …, t-a, t-c).
    expect(r.keys.map((k) => [`${k.ref.nodeId}.${k.ref.fieldId}`, k.routes, k.edges])).toEqual([
      ["comment.ParentId", 3, ["m-k"]],
      ["case.ContactId", 2, ["k-c"]],
      ["contact.AccountId", 1, ["c-a"]],
      ["case.AccountId", 1, ["k-a"]],
      ["task.WhatId", 1, ["t-a"]],
      ["task.WhoId", 1, ["t-c"]],
    ]);
    expect(r.keys[0].share).toBe(1);
    expect(r.keys[1].share).toBeCloseTo(2 / 3);
    expect(r.truncated).toBe(false);
    expect(r.constrained).toEqual({ from: true, to: true });
  });

  it("agrees with between on the edges, and inherits its bounds", () => {
    const a = { nodeId: "comment", fieldId: "ParentId" };
    const b = { nodeId: "account", fieldId: "Id" };
    const edgesUsed = new Set(keyFrequency(MODEL, a, b, U).keys.flatMap((k) => k.edges));
    expect(edgesUsed).toEqual(between(MODEL, a, b, U).onRoutes.edges);
    expect(keyFrequency(MODEL, a, b, { ...U, limit: 2 }).truncated).toBe(true);
    expect(keyFrequency(MODEL, { nodeId: "island" }, b, U)).toMatchObject({ keys: [], routes: 0 });
  });
});

describe("reachableFrom", () => {
  it("walks only the pinned field's edges on the first step, then everything", () => {
    const r = reachableFrom(MODEL, [{ nodeId: "contact", fieldId: "OwnerId" }], U);
    expect(r.constrained).toEqual([true]);
    expect(r.nodes).toEqual(new Map([["contact", 0], ["user", 1]]));
    expect(r.edges).toEqual(["c-u"]);
    const all = reachableFrom(MODEL, [{ nodeId: "contact" }], U);
    expect(all.constrained).toEqual([false]);
    expect(all.nodes.get("comment")).toBe(2); // contact → case → comment
    expect(all.nodes.has("island")).toBe(false);
  });

  it("merges several starts, keeps the nearest distance, and bounds depth", () => {
    const r = reachableFrom(MODEL, [{ nodeId: "comment", fieldId: "ParentId" }, { nodeId: "task", fieldId: "WhatId" }], U);
    expect(r.nodes.get("account")).toBe(1);
    expect(r.nodes.get("case")).toBe(1);
    expect(r.nodes.get("contact")).toBe(2);
    const near = reachableFrom(MODEL, [{ nodeId: "comment", fieldId: "ParentId" }], { ...U, maxDepth: 1 });
    expect([...near.nodes.keys()].sort()).toEqual(["case", "comment"]);
    expect(near.edges).toEqual(["m-k"]);
  });
});

describe("on the imported Salesforce fixture", () => {
  let template: DiagramTemplate;
  const load = async () => {
    template ??= importFolder(
      await readFolderToFileMap(fileURLToPath(new URL("./folder/fixtures/sf-datamodel-mini", import.meta.url))),
    ).template;
    return template;
  };

  it("Contact.AccountId → Account.Id is one hop; Case.ContactId → Account.Id is two", async () => {
    const t = await load();
    const one = fieldPaths(t, { nodeId: "core/contact", fieldId: "AccountId" }, { nodeId: "core/account", fieldId: "Id" }, U);
    expect(one.walks[0].edges).toEqual(["core/contact::AccountId::core/account"]);
    const two = fieldPaths(t, { nodeId: "ops/support/case", fieldId: "ContactId" }, { nodeId: "core/account", fieldId: "Id" }, U);
    expect(two.walks[0].edges).toEqual(["ops/support/case::ContactId::core/contact", "core/contact::AccountId::core/account"]);
    expect(two.constrained).toEqual({ from: true, to: true });
  });

  it("the hierarchy self-loop never advances a walk", async () => {
    const t = await load();
    const r = fieldPaths(t, { nodeId: "core/account", fieldId: "ParentId" }, { nodeId: "core/account", fieldId: "Id" }, U);
    expect(r.walks).toEqual([]);
    const b = between(t, { nodeId: "core/preference", fieldId: "Account__c" }, { nodeId: "ops/support/case/case-comment", fieldId: "ParentId" }, U);
    expect(b.onRoutes.edges.has("core/account::ParentId::core/account")).toBe(false);
    // Two routes: Account → Case directly, and Account → Contact → Case.
    expect([...b.onRoutes.nodes].sort()).toEqual(
      ["core/account", "core/contact", "core/preference", "ops/support/case", "ops/support/case/case-comment"].sort(),
    );
    expect(b.routes).toBe(2);
  });
});
