/**
 * The documents the gallery draws: the hand-made fixtures, anonymised real
 * documents (gallery/real), a few seeded random graphs that nobody shaped to
 * look good, and a dozen small flows, each one shape a direction can take.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./engine.mjs";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const SYLLABLES = ["ka", "lo", "mi", "ren", "to", "sa", "vel", "dor", "pi", "nu", "gar", "ix", "bel", "tor", "an"];
const KINDS = ["service", "service", "service", "database", "queue", "client", "external"];

/** Seeded graphs of a few kinds, unplaced, so only the engine decides where things go. */
export function stressDocs() {
  const make = (name, seed, n, edgeCount, opts = {}) => {
    const random = rng(seed);
    const word = () => {
      const parts = 1 + Math.floor(random() * 3);
      let w = "";
      for (let i = 0; i < parts; i += 1) w += SYLLABLES[Math.floor(random() * SYLLABLES.length)];
      return w[0].toUpperCase() + w.slice(1);
    };
    const groups = opts.groups ?? 0;
    const nodes = [];
    for (let g = 0; g < groups; g += 1) nodes.push({ id: `g${g}`, label: `${word()} tier`, kind: "group", x: 0, y: 0, w: 400, h: 300 });
    for (let i = 0; i < n; i += 1) {
      const label = random() < 0.3 ? `${word()} ${word()}` : word();
      nodes.push({
        id: `n${i}`,
        label,
        kind: KINDS[Math.floor(random() * KINDS.length)],
        x: 0,
        y: 0,
        w: 170,
        h: 76,
        ...(groups ? { parentId: `g${Math.floor((i * groups) / n)}` } : {}),
      });
    }
    const edges = [];
    const seen = new Set();
    const add = (a, b) => {
      const key = `${a}>${b}`;
      if (a === b || seen.has(key) || seen.has(`${b}>${a}`)) return;
      seen.add(key);
      edges.push({ id: `e${edges.length}`, source: `n${a}`, target: `n${b}`, label: random() < 0.4 ? word().toLowerCase() : "" });
    };
    if (opts.hub) for (let i = 1; i < n; i += 1) if (random() < 0.7) add(0, i);
    let guard = 0;
    while (edges.length < edgeCount && guard++ < edgeCount * 50) {
      const a = Math.floor(random() * n);
      const b = Math.floor(random() * n);
      // A DAG only points forward; a mesh goes anywhere.
      if (opts.dag && a >= b) continue;
      add(a, b);
    }
    return { name, doc: { version: 1, nodes, edges } };
  };
  return [
    make("stress-dag", 11, 18, 26, { dag: true }),
    make("stress-mesh", 23, 14, 24),
    make("stress-hub", 37, 13, 16, { hub: true }),
    make("stress-groups", 41, 20, 28, { dag: true, groups: 3 }),
  ];
}

/**
 * Graphs with a direction to them, unplaced: the shapes a flow takes, each small
 * enough that a reader can say at a glance whether the arrangement got it. A
 * pipeline, a branch that rejoins, shortcuts past a stage, a loop, a fan out
 * and back in, traffic both ways, and the ones where keeping every line
 * pointing one way and keeping lines from crossing can't both be had.
 */
export function flowDocs() {
  const doc = (name, labels, pairs, groups = []) => {
    const nodes = groups.map((g) => ({ id: g.id, label: g.label, kind: "group", x: 0, y: 0, w: 400, h: 300 }));
    labels.forEach((label, i) => {
      const group = groups.find((g) => g.members.includes(i));
      nodes.push({ id: `n${i}`, label, kind: "service", x: 0, y: 0, w: 170, h: 76, ...(group ? { parentId: group.id } : {}) });
    });
    const edges = pairs.map(([a, b, more], i) => ({ id: `e${i}`, source: `n${a}`, target: `n${b}`, label: "", ...more }));
    return { name, doc: { version: 1, nodes, edges } };
  };
  const names = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
  const chain = (n) => Array.from({ length: n - 1 }, (_, i) => [i, i + 1]);
  const random = rng(97);
  const pick = (n) => Math.floor(random() * n);

  // Three ranks of five, joined at random: nothing but the order within a rank can help.
  const wide = [];
  const seen = new Set();
  for (const [from, to] of [[0, 5], [5, 10]]) {
    while (wide.length < (from === 0 ? 9 : 18)) {
      const a = from + pick(5);
      const b = to + pick(5);
      if (seen.has(`${a}>${b}`)) continue;
      seen.add(`${a}>${b}`);
      wide.push([a, b]);
    }
  }
  // Eight boxes, sixteen lines, a third of them pointing back at an earlier box.
  const mesh = [];
  const meshSeen = new Set();
  while (mesh.length < 16) {
    let a = pick(8);
    let b = pick(8);
    if (a === b) continue;
    if (a > b && random() < 0.67) [a, b] = [b, a];
    if (meshSeen.has(`${a}>${b}`) || meshSeen.has(`${b}>${a}`)) continue;
    meshSeen.add(`${a}>${b}`);
    mesh.push([a, b]);
  }

  return [
    doc("flow-pipeline", ["Ingest", "Validate", "Enrich", "Score", "Store", "Notify"], chain(6)),
    doc("flow-branch", ["Start", "Check", "Fast path", "Slow path", "Review", "Merge", "Done"], [[0, 1], [1, 2], [1, 3], [3, 4], [2, 5], [4, 5], [5, 6]]),
    doc("flow-shortcuts", names("Stage", 8), [...chain(8), [0, 2], [1, 4], [2, 5], [3, 6], [0, 5], [4, 7]]),
    doc("flow-retry", ["Request", "Queue", "Worker", "Check", "Publish", "Dead letter"], [...chain(5), [3, 1, { label: "retry" }], [3, 5]]),
    doc("flow-fan", ["Router", ...names("Worker", 6), "Collector"], [...Array.from({ length: 6 }, (_, i) => [0, i + 1]), ...Array.from({ length: 6 }, (_, i) => [i + 1, 7])]),
    doc("flow-two-way", ["Client", "Gateway", "Orders", "Stock", "Billing"], [[0, 1], [1, 0], [1, 2], [2, 1], [2, 3], [3, 2], [2, 4], [4, 2], [1, 4]]),
    doc("flow-mesh", names("Service", 8), mesh),
    doc("flow-wide", [...names("Source", 5), ...names("Step", 5), ...names("Sink", 5)], wide),
    doc("flow-ends", [...names("Input", 4), ...names("Join", 3), ...names("Output", 4)], [[0, 4], [1, 4], [1, 5], [2, 5], [3, 6], [2, 6], [4, 7], [4, 8], [5, 8], [5, 9], [6, 9], [6, 10], [0, 9]]),
    doc("flow-loops", ["Plan", "Build", "Test", "Stage", "Release", "Monitor"], [...chain(6), [2, 1, { label: "fails" }], [5, 0, { label: "next" }], [3, 1]]),
    doc(
      "flow-tiers",
      ["Web", "Mobile", "Partner", "Auth", "Catalog", "Checkout", "Users", "Products", "Ledger"],
      [[0, 3], [1, 3], [2, 3], [0, 4], [1, 5], [3, 6], [4, 7], [5, 8], [5, 7], [4, 6], [8, 5, { label: "receipt" }]],
      [
        { id: "front", label: "Front ends", members: [0, 1, 2] },
        { id: "services", label: "Services", members: [3, 4, 5] },
        { id: "data", label: "Data", members: [6, 7, 8] },
      ],
    ),
    doc("flow-long-skip", names("Step", 10), [...chain(10), [0, 9], [2, 7], [1, 5], [4, 8]]),
  ];
}

/** Every gallery document, validated by `engine`; `only` narrows it by name. */
export function loadCorpus(engine, only = []) {
  const docs = [];
  for (const [name, make] of Object.entries(engine.ARRANGE_FIXTURES ?? {})) docs.push({ name, doc: make() });
  const real = join(REPO, "gallery/real");
  for (const file of readdirSync(real).filter((f) => f.endsWith(".json")).sort()) {
    docs.push({ name: `real-${file.replace(/\.json$/, "")}`, doc: JSON.parse(readFileSync(join(real, file), "utf8")) });
  }
  docs.push(...stressDocs(), ...flowDocs());
  return docs
    .filter((d) => !only.length || only.includes(d.name))
    .map((d) => ({ name: d.name, doc: engine.validateTemplate(d.doc) }));
}
