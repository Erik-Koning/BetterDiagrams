// npm run test:gallery
import assert from "node:assert/strict";
import { test } from "node:test";
import { anonymise, pseudo } from "./anonymise.mjs";
import { agreement, crossValidate, distinctPicks, fitWeights, reviewerAgreement, rowsFrom, withFittedCosts } from "./fit.mjs";
import { choosePairs, countFlag, escapeHtml, flagValue, newPicks, parsePicks, runName } from "./pairing.mjs";

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

test("pseudo-words replace the letters and digits of every script", () => {
  const out = pseudo("Платёжный шлюз 顧客注文 Zürich ٣", rng(5));
  assert.equal([...out].length, [..."Платёжный шлюз 顧客注文 Zürich ٣"].length);
  assert.match(out, /^[A-Za-z]+ [a-z]+ [a-z]{4} [A-Z][a-z]{5} \d$/);
});

test("an anonymised document keeps its structure, geometry and anchors, and none of its words", () => {
  const doc = {
    version: 1,
    meta: { title: "Acme payments", routing: "orthogonal" },
    nodes: [
      { id: "orders", label: "Orders", kind: "table", x: 10, y: 20, w: 200, h: 120, tags: ["pii"], fields: [{ id: "orders.id", name: "id", type: "uuid" }, { id: "orders.customer", name: "customer_id", type: "uuid" }] },
      { id: "customers", label: "Customers", kind: "table", x: 400, y: 20, w: 200, h: 120, url: "https://acme.example", fields: [{ name: "id", type: "uuid" }] },
      { id: "vpc", label: "Acme VPC", kind: "group", x: 0, y: 0, w: 900, h: 400 },
    ],
    edges: [{ id: "fk", source: "orders", target: "customers", label: "belongs to", startField: "orders.customer", endField: "id", startLabel: "*", endLabel: "1", start: { side: "right" } }],
    zones: [{ id: "aws", label: "Acme AWS", x: 0, y: 0, w: 1000, h: 500 }],
  };
  const out = anonymise(doc, 5);
  const text = JSON.stringify(out);
  for (const word of ["Orders", "orders", "Customers", "Acme", "customer", "belongs", "pii", "example"]) assert.ok(!text.includes(word), word);
  assert.deepEqual(out.meta, { routing: "orthogonal" });
  assert.deepEqual(out.nodes.map((n) => [n.id, n.kind, n.x, n.y, n.w, n.h]), [["n1", "table", 10, 20, 200, 120], ["n2", "table", 400, 20, 200, 120], ["n3", "group", 0, 0, 900, 400]]);
  const [e] = out.edges;
  assert.equal(e.source, "n1");
  assert.equal(e.target, "n2");
  // A line tied to table rows names them by id, as validation wants: by the
  // field's old id where it had one, by its name where it didn't.
  assert.deepEqual(out.nodes[0].fields.map((f) => f.id), ["f1", "f2"]);
  assert.equal(e.startField, "f2");
  assert.equal(e.endField, out.nodes[1].fields[0].id);
  assert.equal(e.startLabel, "*");
  assert.equal(e.endLabel, "1");
  assert.deepEqual(e.start, { side: "right" });
  assert.equal(out.zones[0].id, "z1");
});

test("only what the layout needs is copied: no key nobody listed, no names in settings, no word left whole", () => {
  const doc = {
    version: 1,
    meta: { title: "Secret Co", routing: "curved", author: "Jane Doe" },
    lineage: [{ id: "secret-lineage" }],
    settings: { arrange: "auto", layout: { direction: "down", rankGap: 120, note: "secret layout note" }, notation: "uml", groupContents: "hide", capacity: { "Jane Doe": 8 }, roadmap: { from: "2031-02-03", dayWidth: 4 }, htmlLines: "all" },
    zones: [{ id: "dc", label: "Zürich DC", description: "secret zone words", shape: "rounded", provider: "acme-cloud", providers: ["acme-cloud", "aws"], x: 0, y: 0, w: 900, h: 500 }],
    nodes: [
      { id: "acct", label: "Kundendaten", kind: "table", icon: "none", description: "Платёжный шлюз", title: "SECRET TITLE", note: "SECRET NOTE", team: "Payments", assignees: ["Jane Doe"], data: { crm: "secret-id" }, providers: ["acme-cloud"], zoneId: "dc", x: 0, y: 0, w: 200, h: 90,
        fields: [{ id: "AccountId", name: "AccountId", type: "uuid", key: "pk", tags: ["pii-secret"], comment: "SECRET COMMENT", description: "the customer" }] },
      { id: "year", label: "2024", kind: "service", icon: "none", description: "", providers: ["aws"], zoneId: "dc", x: 300, y: 0, w: 170, h: 76 },
      { id: "kanji", label: "顧客注文", kind: "service", icon: "none", description: "", x: 600, y: 0, w: 170, h: 76 },
    ],
    edges: [
      { id: "a", source: "year", target: "acct", label: "gehört zu", name: "SECRET EDGE NAME", relation: "Lookup(AcmeAccount)", endField: "AccountId", endLabel: "owner", startLabel: "0..n", style: "solid", color: "slate", data: { rule: "secret" } },
      { id: "b", source: "kanji", target: "acct", label: "", relation: "Lookup(AcmeAccount)", endField: "no such field", endLabel: "2024", style: "dashed", color: "slate" },
      { id: "c", source: "kanji", target: "year", label: "", relation: "dependency", style: "solid", color: "slate" },
      { id: "d", source: "kanji", target: "nowhere-secret", label: "", style: "solid", color: "slate" },
    ],
  };
  const out = anonymise(doc);
  const text = JSON.stringify(out);
  for (const word of ["SECRET", "secret", "Secret", "Jane", "Payments", "Zürich", "ü", "Kundendaten", "Платёжный", "顧客", "gehört", "Lookup", "Acme", "acme", "aws", "pii", "customer", "AccountId", "owner", "2024", "2031", "nowhere"]) {
    assert.ok(!text.includes(word), `"${word}" came through: ${text}`);
  }
  assert.deepEqual(Object.keys(out).sort(), ["edges", "meta", "nodes", "settings", "version", "zones"]);
  assert.deepEqual(out.meta, { routing: "curved" });
  // How it is arranged and drawn, and nothing that names a person or a day.
  assert.deepEqual(out.settings, { arrange: "auto", notation: "uml", groupContents: "hide", layout: { direction: "down", rankGap: 120 } });
  assert.deepEqual(Object.keys(out.nodes[0]).sort(), ["description", "fields", "h", "icon", "id", "kind", "label", "providers", "w", "x", "y", "zoneId"]);
  assert.deepEqual(Object.keys(out.nodes[0].fields[0]).sort(), ["description", "id", "key", "name", "type"]);
  // Providers are renumbered alike wherever they appear, so alternates stay alternates.
  assert.deepEqual(out.zones[0].providers, ["p1", "p2"]);
  assert.equal(out.zones[0].provider, "p1");
  assert.deepEqual(out.nodes.map((n) => n.providers), [["p1"], ["p2"], undefined]);
  // A line to nothing goes; a row that isn't there is not named; a real one is, by its new id.
  assert.equal(out.edges.length, 3);
  assert.equal(out.edges[0].endField, "f1");
  assert.equal(out.edges[1].endField, undefined);
  // One relation, one pseudo-word; the relation the drawing knows keeps its name.
  assert.equal(out.edges[0].relation, out.edges[1].relation);
  assert.match(out.edges[0].relation, /^[a-z]+\([a-z]+\)$/);
  assert.equal(out.edges[2].relation, "dependency");
  // A cardinality is a mark; a year or a role at a line's end is a word like any other.
  assert.equal(out.edges[0].startLabel, "0..n");
  assert.match(out.edges[0].endLabel, /^[a-z]{5}$/);
  assert.match(out.edges[1].endLabel, /^\d{4}$/);
  assert.match(out.nodes[1].label, /^\d{4}$/);
});

test("a roadmap stops being one, since its dates are gone", () => {
  const out = anonymise({ version: 1, settings: { arrange: "roadmap", roadmap: { from: "2031-02-03", dayWidth: 4 } }, nodes: [{ id: "t", label: "Ship", kind: "task", date: "2031-03-01", startDate: "2031-02-03", storyPoints: 3, x: 0, y: 0, w: 170, h: 76 }], edges: [] });
  assert.equal(out.settings, undefined);
  assert.deepEqual(Object.keys(out.nodes[0]).sort(), ["h", "id", "kind", "label", "storyPoints", "w", "x", "y"]);
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

test("a floor keeps an error rule from being fitted away, in the linter's own units", () => {
  // Picks that would push rule 0 to nothing: B has one more of it and far less
  // of the soft part, and readers chose B every time.
  const rows = Array.from({ length: 60 }, (_, i) => ({ x: [1, -30], y: -1, doc: `d${i}` }));
  const prior = [60, 1];
  const loose = fitWeights(rows, prior, { lambda: 0.3, unit: 1 });
  assert.ok(loose.weights[0] / loose.weights[1] < 30, "these picks do push the rule down");
  const { weights, factors } = fitWeights(rows, prior, { lambda: 0.3, floors: [0.5, null], unit: 1 });
  // Half of today's 60, measured against the soft part: what gets printed and written.
  assert.ok(weights[0] / weights[1] >= 30 - 1e-6, `the rule fell to ${weights[0] / weights[1]}`);
  assert.equal(factors[1], 1);
});

test("a fit is written whole, or not at all", () => {
  const source = [
    "export const LEGIBILITY_WEIGHT = 16;",
    "export const ILLEGIBLE_WEIGHT = 1500;",
    "export const LAYOUT_RULES = {",
    '  "box-overlap": { label: "Boxes overlap", severity: "error", penalty: 14, cap: 60, cost: 60 },',
    '  intruder: { label: "A box sits in someone else\'s frame", severity: "warning", penalty: 6, cap: 24, cost: 22 },',
    "};",
  ].join("\n");
  const out = withFittedCosts(source, { "box-overlap": 41.5, intruder: 9 }, { LEGIBILITY_WEIGHT: 12.5, ILLEGIBLE_WEIGHT: 900 });
  assert.match(out, /"box-overlap": \{.*cap: 60, cost: 41\.5 \}/);
  assert.match(out, /intruder: \{.*cap: 24, cost: 9 \}/);
  assert.match(out, /LEGIBILITY_WEIGHT = 12\.5;/);
  assert.match(out, /ILLEGIBLE_WEIGHT = 900;/);
  // A rule whose line isn't where it's looked for is said, and nothing comes back to write.
  assert.throws(() => withFittedCosts(source, { "box-overlap": 41.5, "line-hook": 3 }, { LEGIBILITY_WEIGHT: 12.5 }), /nothing written.*line-hook/);
  assert.throws(() => withFittedCosts(source, { intruder: 9 }, { READABLE_ZOOM: 0.4 }), /nothing written.*READABLE_ZOOM/);
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

test("one reviewer's pick recorded twice is one opinion, to the agreement and to the fit", () => {
  const pick = { run: "r", pair: "p1", a: "h1", b: "h2", pick: "a", doc: "x", by: "ana" };
  // Alone and doubled, there is nobody to agree with.
  assert.equal(reviewerAgreement([pick, { ...pick }]), null);
  // A second reviewer, shown the same two the other way round in another run, chose the same picture.
  const other = { run: "r2", pair: "p9", a: "h2", b: "h1", pick: "b", doc: "x", by: "ben" };
  assert.deepEqual(reviewerAgreement([pick, { ...pick }, other]), { rate: 1, pairs: 1 });
  // Changing one's mind keeps the last word.
  assert.deepEqual(distinctPicks([pick, { ...pick, pick: "b" }]).map((p) => p.pick), ["b"]);
  const features = new Map([
    ["h1", { counts: {}, soft: 1, shrink: 0, illegible: 0 }],
    ["h2", { counts: {}, soft: 2, shrink: 0, illegible: 0 }],
  ]);
  assert.equal(rowsFrom([pick, { ...pick }, other], features, []).length, 2);
});

const cellsOf = (count) => Array.from({ length: count }, (_, i) => ({ variant: `v${i}`, shot: `s${i}.png`, text: JSON.stringify({ nodes: [{ id: "n", x: i * 10, y: 0 }] }) }));

test("pairs are the same for a seed, and a cut leaves every document some", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ name: `doc${i}`, cells: cellsOf(4) }));
  const all = choosePairs(rows, { per: 3, max: 80, seed: 4 });
  assert.equal(all.length, 30);
  assert.deepEqual(choosePairs(rows, { per: 3, max: 80, seed: 4 }), all);
  assert.notDeepEqual(choosePairs(rows, { per: 3, max: 80, seed: 5 }), all);
  // Two pictures with every box in the same place are one picture, and never a pair.
  const same = [{ name: "flat", cells: [...cellsOf(1), ...cellsOf(1)] }];
  assert.equal(choosePairs(same).length, 0);

  const cut = choosePairs(rows, { per: 3, max: 14, seed: 4 });
  assert.equal(cut.length, 14);
  assert.deepEqual(cut.map((p) => p.id), Array.from({ length: 14 }, (_, i) => `p${String(i + 1).padStart(3, "0")}`));
  const perDoc = rows.map((r) => cut.filter((p) => p.doc === r.name).length);
  assert.ok(perDoc.every((n) => n >= 1 && n <= 2), `a document was dropped, or took another's share: ${perDoc}`);
  // What the cut leaves is all there is to store: the caller is handed nothing else.
  assert.ok(cut.every((p) => all.some((q) => q.doc === p.doc && q.a === p.a && q.b === p.b)));
});

test("a reviewer's file is read whole before any of it counts", () => {
  const key = new Map([
    ["p001", { id: "p001", doc: "x", a: { hash: "h1", variant: "auto" }, b: { hash: "h2", variant: "grid" } }],
    ["p002", { id: "p002", doc: "y", a: { hash: "h3", variant: "auto" }, b: { hash: "h4", variant: "tree" } }],
  ]);
  const about = { run: "v1", by: "ana", at: "2031-01-01T00:00:00.000Z" };
  const picks = parsePicks("# round one\np001 A tangles, crossings\n\np002 tie\n", key, about);
  assert.deepEqual(picks.map((p) => [p.pair, p.a, p.b, p.pick, p.reasons, p.by, p.run]), [
    ["p001", "h1", "h2", "a", ["tangles", "crossings"], "ana", "v1"],
    ["p002", "h3", "h4", "tie", [], "ana", "v1"],
  ]);
  // A slip on the last line, and a pair that isn't in the run: both named, nothing returned.
  assert.throws(() => parsePicks("p001 A\np002 C\np077 B\n", key, about), /nothing recorded[\s\S]*line 2[\s\S]*line 3.*no pair called p077/);
});

test("recording a file again adds nothing, and another reviewer's picks still count", () => {
  const pick = (by, choice, a = "h1", b = "h2") => ({ pair: "p001", run: "v1", doc: "x", a, b, pick: choice, by });
  const recorded = [pick("ana", "a")];
  assert.deepEqual(newPicks([pick("ana", "a")], recorded), []);
  // The same two pictures the other way round are still the pair she has judged.
  assert.deepEqual(newPicks([pick("ana", "b", "h2", "h1")], recorded), []);
  assert.deepEqual(newPicks([pick("ben", "a")], recorded), [pick("ben", "a")]);
  // Said twice in one file: once, the last.
  assert.deepEqual(newPicks([pick("cy", "a"), pick("cy", "b")], recorded), [pick("cy", "b")]);
});

test("a flag with nothing after it, a count that isn't one, and a run that is a path are all refused", () => {
  assert.equal(flagValue(["compare", "--base", "main"], "base", "x"), "main");
  assert.equal(flagValue(["compare"], "base", "x"), "x");
  assert.throws(() => flagValue(["compare", "--out"], "out", "x"), /--out wants a value/);
  assert.throws(() => flagValue(["compare", "--out", "--only", "a"], "out", "x"), /--out wants a value/);
  assert.equal(countFlag(["pairs", "r", "--per", "4"], "per", 3), 4);
  assert.equal(countFlag(["pairs", "r"], "per", 3), 3);
  assert.throws(() => countFlag(["pairs", "r", "--per", "abc"], "per", 3), /--per wants a whole number/);
  assert.throws(() => countFlag(["pairs", "r", "--max", "0"], "max", 80), /--max wants a whole number/);
  assert.equal(runName("variants-2031-01-01T10-00-00"), "variants-2031-01-01T10-00-00");
  for (const bad of ["../elsewhere", "a/b", "..", ".", "", undefined]) assert.throws(() => runName(bad), /plain name/);
  assert.equal(escapeHtml(`<b onclick="x">R&D's</b>`), "&lt;b onclick=&quot;x&quot;&gt;R&amp;D&#39;s&lt;/b&gt;");
});
