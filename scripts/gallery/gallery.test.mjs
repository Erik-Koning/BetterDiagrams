// npm run test:gallery
import assert from "node:assert/strict";
import { test } from "node:test";
import { anonymise, pseudo } from "./anonymise.mjs";
import { agreement, crossValidate, fitWeights, reviewerAgreement, rowsFrom } from "./fit.mjs";

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

test("pseudo-words keep a text's shape and lose its letters", () => {
  const random = rng(3);
  const out = pseudo("Orders DB (v2)", random);
  assert.equal(out.length, "Orders DB (v2)".length);
  assert.match(out, /^[A-Z][a-z]{5} [A-Z]{2} \([a-z]\d\)$/);
  assert.notEqual(out.slice(0, 6), "Orders");
});

test("an anonymised document keeps its structure, geometry and anchors, and none of its words", () => {
  const doc = {
    version: 1,
    meta: { title: "Acme payments", routing: "orthogonal" },
    nodes: [
      { id: "orders", label: "Orders", kind: "table", x: 10, y: 20, w: 200, h: 120, tags: ["pii"], fields: [{ id: "orders.id", name: "id", type: "uuid" }, { name: "customer_id", type: "uuid" }] },
      { id: "customers", label: "Customers", kind: "table", x: 400, y: 20, w: 200, h: 120, url: "https://acme.example", fields: [{ name: "id", type: "uuid" }] },
      { id: "vpc", label: "Acme VPC", kind: "group", x: 0, y: 0, w: 900, h: 400 },
    ],
    edges: [{ id: "fk", source: "orders", target: "customers", label: "belongs to", startField: "customer_id", endField: "id", startLabel: "*", endLabel: "1", start: { side: "right" } }],
    zones: [{ id: "aws", label: "Acme AWS", x: 0, y: 0, w: 1000, h: 500 }],
  };
  const out = anonymise(doc, 5);
  const text = JSON.stringify(out);
  for (const word of ["Orders", "Customers", "Acme", "customer_id", "belongs", "pii", "example"]) assert.ok(!text.includes(word), word);
  assert.deepEqual(out.meta, { routing: "orthogonal" });
  assert.deepEqual(out.nodes.map((n) => [n.id, n.kind, n.x, n.y, n.w, n.h]), [["n1", "table", 10, 20, 200, 120], ["n2", "table", 400, 20, 200, 120], ["n3", "group", 0, 0, 900, 400]]);
  const [e] = out.edges;
  assert.equal(e.source, "n1");
  assert.equal(e.target, "n2");
  // A line tied to table rows still names the rows it is tied to, renamed alike.
  assert.equal(e.startField, out.nodes[0].fields[1].name);
  assert.equal(e.endField, out.nodes[1].fields[0].name);
  assert.equal(e.startLabel, "*");
  assert.equal(e.endLabel, "1");
  assert.deepEqual(e.start, { side: "right" });
  assert.equal(out.zones[0].id, "z1");
});

test("a fit learns which rule readers mind, and agrees with them on pictures it didn't see", () => {
  // Readers mind rule 0 three times as much as rule 1; today's costs say the opposite.
  const random = rng(11);
  const truth = [3, 1, 0.2];
  const prior = [1, 3, 1];
  const rows = [];
  for (let i = 0; i < 240; i += 1) {
    const x = [Math.round((random() - 0.5) * 6), Math.round((random() - 0.5) * 6), (random() - 0.5) * 10];
    const z = truth.reduce((s, t, k) => s + t * x[k], 0);
    rows.push({ x, y: z > 0 ? 1 : -1, doc: `d${i % 12}` });
  }
  assert.ok(agreement(rows, prior) < 0.8);
  const { weights } = fitWeights(rows, prior, { lambda: 0.3 });
  assert.ok(weights[0] > weights[1], `fitted ${weights}`);
  assert.ok(agreement(rows, weights) > 0.9);
  const cv = crossValidate(rows, prior, { lambda: 0.3 });
  assert.ok(cv.fitted > cv.prior, JSON.stringify(cv));
  assert.ok(cv.fitted > 0.85, JSON.stringify(cv));
});

test("a floor keeps an error rule from being fitted away", () => {
  // Picks that would push rule 0 to nothing.
  const rows = Array.from({ length: 60 }, (_, i) => ({ x: [1, -1], y: 1, doc: `d${i}` }));
  const { factors } = fitWeights(rows, [5, 1], { lambda: 0.01, floors: [0.5, null] });
  assert.ok(factors[0] >= 0.5 - 1e-9);
});

test("rows read picks as B's features minus A's, and leave out ties and missing pictures", () => {
  const features = new Map([
    ["h1", { counts: { "line-crossing": 2 }, soft: 10, shrink: 1, illegible: 0 }],
    ["h2", { counts: { "line-crossing": 5, "box-overlap": 1 }, soft: 12, shrink: 0.5, illegible: 0 }],
  ]);
  const rows = rowsFrom(
    [
      { a: "h1", b: "h2", pick: "a", doc: "x" },
      { a: "h1", b: "h2", pick: "tie", doc: "x" },
      { a: "h1", b: "missing", pick: "b", doc: "x" },
    ],
    features,
    ["box-overlap", "line-crossing"],
  );
  // Rule counts, then the soft part, how small the words get, and how far past readable.
  assert.deepEqual(rows, [{ x: [1, 3, 2, -0.5, 0], y: 1, doc: "x" }]);
});

test("reviewers who saw the same pair are compared, a tie counting half", () => {
  const picks = [
    { run: "r", pair: "p1", pick: "a" },
    { run: "r", pair: "p1", pick: "a" },
    { run: "r", pair: "p2", pick: "a" },
    { run: "r", pair: "p2", pick: "b" },
    { run: "r", pair: "p3", pick: "tie" },
    { run: "r", pair: "p3", pick: "b" },
    { run: "r", pair: "p4", pick: "a" },
  ];
  assert.deepEqual(reviewerAgreement(picks), { rate: 1.5 / 3, pairs: 3 });
});
