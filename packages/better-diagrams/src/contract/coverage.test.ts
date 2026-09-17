/**
 * coverage.test.ts — what a set of keys reaches, what each candidate would
 * add, and the fewest keys that reach everything.
 */
import { describe, expect, it } from "vitest";
import { keyCoverage, marginalGains, minimalKeyCover } from "./coverage";

const node = (id: string) => ({ id, label: id });
const fk = (id: string, source: string, target: string, field: string) => ({
  id, source, target, startField: field, endField: "Id",
});
/**
 *   contact.AccountId → account   (c-a)      case.AccountId → account (k-a)
 *   contact.OwnerId   → user      (c-u)      case.ContactId → contact (k-c)
 *   comment.ParentId  → case      (m-k)      task.WhatId    → account (t-a)
 *   task.WhoId        → contact   (t-c)      island: no keys
 */
const DOC = {
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
const K = (nodeId: string, fieldId: string) => ({ nodeId, fieldId });

describe("keyCoverage", () => {
  it("all tables: a key covers the two tables it joins; the island is the ceiling", () => {
    const r = keyCoverage(DOC, [K("contact", "AccountId")]);
    expect([...r.reached].sort()).toEqual(["account", "contact"]);
    expect(r.total).toBe(7);
    expect(r.fraction).toBeCloseTo(2 / 7);
    expect(r.unreachable).toBe(1);
    expect(r.byKey.get(`contact${String.fromCharCode(0)}AccountId`)!.sort()).toEqual(["account", "contact"]);
    expect(keyCoverage(DOC, []).reached.size).toBe(0);
    // Keys are added in order; the second's contribution is only what was new.
    const two = keyCoverage(DOC, [K("contact", "AccountId"), K("case", "AccountId"), K("contact", "AccountId")]);
    expect(two.byKey.get(`case${String.fromCharCode(0)}AccountId`)).toEqual(["case"]);
    expect(two.byKey.size).toBe(2);
    expect(keyCoverage(DOC, [K("contact", "Nope")]).reached.size).toBe(0);
  });

  it("from a root: breadth-first over the chosen keys only, honouring direction when asked", () => {
    const from = keyCoverage(DOC, [K("comment", "ParentId"), K("case", "ContactId")], { scope: { kind: "from", nodeId: "comment" } });
    expect([...from.reached].sort()).toEqual(["case", "comment", "contact"]);
    expect(from.unreachable).toBe(1); // with every key, everything but the island is reachable from comment
    const directed = keyCoverage(DOC, [K("contact", "AccountId")], { scope: { kind: "from", nodeId: "account" }, undirected: false });
    expect([...directed.reached]).toEqual(["account"]);
    expect(keyCoverage(DOC, [K("contact", "AccountId")], { scope: { kind: "from", nodeId: "nope" } }).reached.size).toBe(0);
  });
});

describe("marginalGains", () => {
  it("ranks candidates by what they would add, ties by document order, skipping chosen keys", () => {
    const gains = marginalGains(DOC, [K("contact", "AccountId")]);
    // ParentId adds comment + case; every other key adds one table; ties keep document order.
    expect(gains.map((g) => [g.ref.fieldId, g.adds.length])).toEqual([
      ["ParentId", 2],
      ["OwnerId", 1],
      ["AccountId", 1],
      ["ContactId", 1],
      ["WhatId", 1],
      ["WhoId", 1],
    ]);
    expect(gains.find((g) => g.ref.fieldId === "AccountId" && g.ref.nodeId === "contact")).toBeUndefined();
    expect(gains[0].fraction).toBeCloseTo(2 / 7);
  });
});

describe("minimalKeyCover", () => {
  it("greedy first, then the exact pass finds the smaller set and proves it", () => {
    const r = minimalKeyCover(DOC);
    // Six reachable tables, two per key: three disjoint keys do it; greedy needs four.
    expect(r.keys).toHaveLength(3);
    expect(r.reached.size).toBe(6);
    expect(r.optimal).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.fraction).toBeCloseTo(6 / 7);
    const covered = keyCoverage(DOC, r.keys);
    expect(covered.reached.size).toBe(6);
  });

  it("skips the exact pass above the candidate cap, and stops on the budget", () => {
    const capped = minimalKeyCover(DOC, { exactUpTo: 2 });
    expect(capped.keys).toHaveLength(4);
    expect(capped.optimal).toBe(false);
    expect(capped.truncated).toBe(false);
    // A clock that jumps 50 ms per read against a 1 ms budget: the first
    // greedy round still completes, then it stops and says so.
    let t = 0;
    const timed = minimalKeyCover(DOC, { budgetMs: 1, now: () => (t += 50) });
    expect(timed.truncated).toBe(true);
    expect(timed.optimal).toBe(false);
    expect(timed.keys).toHaveLength(1);
    expect(timed.reached.size).toBeGreaterThan(0);
  });

  it("stays fast on a model with hundreds of keys", () => {
    const objects = 200;
    const nodes = Array.from({ length: objects }, (_, i) => node(`t${i}`));
    const edges = nodes.flatMap((n, i) =>
      Array.from({ length: 3 }, (_, k) => fk(`${n.id}-${k}`, n.id, `t${(i + 1 + k * 7) % objects}`, `Ref${k}__c`)),
    );
    const big = { nodes, edges };
    const started = performance.now();
    const r = minimalKeyCover(big);
    const elapsed = performance.now() - started;
    expect(r.reached.size).toBe(objects);
    expect(elapsed).toBeLessThan(500);
    expect(marginalGains(big, r.keys.slice(0, 5))).toHaveLength(600 - 5);
  });

  it("from a root, and on a model with nothing to cover", () => {
    const r = minimalKeyCover(DOC, { scope: { kind: "from", nodeId: "comment" } });
    expect(r.reached.has("comment")).toBe(true);
    expect(r.reached.has("island")).toBe(false);
    expect(keyCoverage(DOC, r.keys, { scope: { kind: "from", nodeId: "comment" } }).reached.size).toBe(r.reached.size);
    expect(minimalKeyCover({ nodes: [node("a")], edges: [] })).toMatchObject({ keys: [], optimal: true, fraction: 0 });
  });
});
