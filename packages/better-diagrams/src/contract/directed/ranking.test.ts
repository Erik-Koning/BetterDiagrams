/**
 * The ranking search: a chain stays a chain, joined boxes never share a rank,
 * what it finds never costs more than where it started, and what a crossing is
 * worth against a backward line is the caller's to say.
 */
import { describe, expect, it } from "vitest";
import { acyclicOrder, flatRanks, type PlaceLink } from "../autoplace";
import { fewestBackOrder, searchRanks, type RankWeights } from "./ranking";

const link = (source: string, target: string, more: Partial<PlaceLink> = {}): PlaceLink => ({ source, target, ...more });
const weights = (crossing: number, backward: number, turned = backward): RankWeights => ({ crossing, backward, turned, span: 1.2 });
const letters = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));

/** A seeded graph with a direction to it and some lines against it. */
function tangle(n: number, m: number, seed: number): { ids: string[]; links: PlaceLink[] } {
  let s = seed;
  const random = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const ids = letters(n);
  const links: PlaceLink[] = [];
  const seen = new Set<string>();
  while (links.length < m) {
    let a = Math.floor(random() * n);
    let b = Math.floor(random() * n);
    if (a === b) continue;
    if (a > b && random() < 0.7) [a, b] = [b, a];
    if (seen.has(`${a},${b}`) || seen.has(`${b},${a}`)) continue;
    seen.add(`${a},${b}`);
    links.push(link(ids[a]!, ids[b]!));
  }
  return { ids, links };
}

describe("an order with few lines backward", () => {
  it("is the chain's own order", () => {
    const ids = letters(5);
    const order = fewestBackOrder(ids, [link("a", "b"), link("b", "c"), link("c", "d"), link("d", "e")]);
    expect(ids.map((id) => order.get(id))).toEqual([0, 1, 2, 3, 4]);
  });

  it("turns one line of a loop round, and no more", () => {
    const ids = letters(4);
    const links = [link("a", "b"), link("b", "c"), link("c", "d"), link("d", "a")];
    const order = fewestBackOrder(ids, links);
    expect(links.filter((l) => order.get(l.source)! > order.get(l.target)!)).toHaveLength(1);
  });
});

describe("searching for ranks", () => {
  it("leaves a chain as it is", () => {
    const ids = letters(6);
    const links = ids.slice(1).map((id, i) => link(ids[i]!, id));
    const found = searchRanks(ids, links, weights(15, 5), [flatRanks(ids, links)]);
    expect(ids.map((id) => found.rank.get(id))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(found).toMatchObject({ crossings: 0, backward: 0, span: 0 });
  });

  it("never puts two joined boxes in one rank, and never costs more than where it started", () => {
    for (const seed of [3, 11, 29]) {
      const { ids, links } = tangle(12, 22, seed);
      const w = weights(15, 5);
      const start = searchRanks(ids, links, w, [flatRanks(ids, links)], { budget: 0 });
      const found = searchRanks(ids, links, w, [flatRanks(ids, links)]);
      expect(found.cost).toBeLessThanOrEqual(start.cost + 1e-9);
      for (const l of links) expect(found.rank.get(l.source)).not.toBe(found.rank.get(l.target));
      // Dense: every rank from 0 up to the last is used.
      const used = new Set(found.rank.values());
      expect([...used].sort((a, b) => a - b)).toEqual(Array.from({ length: used.size }, (_, i) => i));
    }
  });

  it("gives the same answer every time, annealed or not", () => {
    const { ids, links } = tangle(12, 22, 7);
    for (const anneal of [false, true]) {
      const once = searchRanks(ids, links, weights(15, 5), [flatRanks(ids, links)], { anneal });
      const again = searchRanks(ids, links, weights(15, 5), [flatRanks(ids, links)], { anneal });
      expect([...again.rank]).toEqual([...once.rank]);
      expect([...again.across]).toEqual([...once.across]);
    }
  });

  it("annealing ends no worse than the plain search began", () => {
    const { ids, links } = tangle(12, 22, 13);
    const w = weights(15, 5);
    const start = searchRanks(ids, links, w, [flatRanks(ids, links)], { budget: 0 });
    expect(searchRanks(ids, links, w, [flatRanks(ids, links)], { anneal: true }).cost).toBeLessThanOrEqual(start.cost + 1e-9);
  });

  it("trades as it is told: dearer crossings never mean more of them, dearer backward lines never more of those", () => {
    for (const seed of [5, 17, 41]) {
      const { ids, links } = tangle(11, 20, seed);
      const seeds = [flatRanks(ids, links)];
      const crossingsFirst = searchRanks(ids, links, weights(81, 1), seeds);
      const directionFirst = searchRanks(ids, links, weights(1, 81), seeds);
      expect(crossingsFirst.crossings).toBeLessThanOrEqual(directionFirst.crossings);
      expect(directionFirst.backward).toBeLessThanOrEqual(crossingsFirst.backward);
    }
  });

  it("doesn't start a loop from its middle to save a line: a main line turned round costs more than a return line", () => {
    // plan → build → test → ship, with two lines back to build and one back to plan.
    const ids = ["plan", "build", "test", "ship"];
    const links = [link("plan", "build"), link("build", "test"), link("test", "ship"), link("test", "build"), link("ship", "build"), link("ship", "plan")];
    const reading = acyclicOrder(ids, links);
    const found = searchRanks(ids, links, weights(15, 5), [flatRanks(ids, links)], { reading });
    expect(ids.map((id) => found.rank.get(id))).toEqual([0, 1, 2, 3]);
  });

  it("a line with no direction is nobody's to run backward, and one that only tethers isn't ranked by at all", () => {
    const ids = letters(3);
    const found = searchRanks(ids, [link("b", "a", { undirected: true }), link("b", "c")], weights(15, 5), [new Map([["a", 0], ["b", 1], ["c", 2]])]);
    expect(found.backward).toBe(0);
    const tethered = searchRanks(ids, [link("a", "b"), link("c", "a", { tether: true })], weights(15, 5), [new Map([["a", 0], ["b", 1], ["c", 0]])]);
    expect(tethered).toMatchObject({ backward: 0, crossings: 0 });
  });

  it("opens a start that put two joined boxes in one rank", () => {
    const ids = letters(3);
    const found = searchRanks(ids, [link("a", "b"), link("b", "c")], weights(15, 5), [new Map([["a", 0], ["b", 0], ["c", 0]])]);
    expect(ids.map((id) => found.rank.get(id))).toEqual([0, 1, 2]);
  });

  it("an empty graph, and boxes with nothing joining them, come back ranked", () => {
    expect(searchRanks([], [], weights(15, 5), [new Map()]).rank.size).toBe(0);
    const loose = searchRanks(letters(3), [], weights(15, 5), [new Map()]);
    expect([...loose.rank.values()]).toEqual([0, 0, 0]);
  });
});
