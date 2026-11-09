/**
 * The documents the gallery draws: the hand-made fixtures, anonymised real
 * documents (gallery/real), and a few seeded random graphs that nobody shaped
 * to look good.
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

/** Every gallery document, validated by `engine`; `only` narrows it by name. */
export function loadCorpus(engine, only = []) {
  const docs = [];
  for (const [name, make] of Object.entries(engine.ARRANGE_FIXTURES ?? {})) docs.push({ name, doc: make() });
  const real = join(REPO, "gallery/real");
  for (const file of readdirSync(real).filter((f) => f.endsWith(".json")).sort()) {
    docs.push({ name: `real-${file.replace(/\.json$/, "")}`, doc: JSON.parse(readFileSync(join(real, file), "utf8")) });
  }
  docs.push(...stressDocs());
  return docs
    .filter((d) => !only.length || only.includes(d.name))
    .map((d) => ({ name: d.name, doc: engine.validateTemplate(d.doc) }));
}
