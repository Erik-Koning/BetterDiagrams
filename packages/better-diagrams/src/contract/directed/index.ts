/**
 * directed/ — the "directed" arrangement: a flow drawn so that its lines don't
 * cross, and run one way, in that order of importance, at a rate of exchange
 * the document sets.
 *
 * Every other arrangement here decides which lines run backward before it
 * counts a crossing. This one prices the two together (`ranking.ts`), and then
 * chooses between whole pictures the same way: the linter's cost, with what it
 * charges for crossings scaled up and a charge for running against the flow
 * added (`directedCost`), both by the document's `priority`.
 *
 * It is a family of the auto-placer, not a layout of its own: groups, zones,
 * locks, text that fits and routed lines are all `arrange.ts`'s, the same as
 * for every other arrangement. What is here is which rank a box takes.
 */
import { autoPlaceWith, type ArrangeOptions } from "../arrange";
import { acyclicOrder, flatRanks, forestOf, layered, ranksInOrder, tidyTree, type Flow, type PlaceEngine, type PlaceLink, type RankPlan } from "../autoplace";
import { LAYOUT_RULES, lintLayout, type LayoutReport, type LayoutRuleId } from "../layout-lint";
import type { DiagramTemplate, DirectedMethod, DirectedPriority } from "../schema";
import { measureFlow, type FlowMetrics } from "./metrics";
import { fewestBackOrder, searchRanks, type RankWeights } from "./ranking";

export interface DirectedOptions extends ArrangeOptions {
  /** What to give up for what. Unset, the document's `settings.directed` decides, then "mostly-crossings". */
  priority?: DirectedPriority;
  /** How to find the arrangement. Unset, the document's `settings.directed` decides, then "best". */
  method?: DirectedMethod;
}

/** How many backward lines a crossing is worth, at each priority. */
const EXCHANGE: Record<DirectedPriority, number> = {
  crossings: 9,
  "mostly-crossings": 3,
  balanced: 1,
  "mostly-direction": 1 / 3,
  direction: 1 / 9,
};

export interface DirectedWeights {
  /** What multiplies the cost of a crossing, and of lines running on or beside each other. */
  crossing: number;
  /** What multiplies the cost of running against the flow. */
  direction: number;
}

/**
 * The two weights for a priority. Their product is always 1, so a priority
 * moves cost from one to the other and the rest of what a picture is judged by
 * (boxes on boxes, lines through boxes, size) keeps its place between them.
 */
export function directedWeights(priority: DirectedPriority): DirectedWeights {
  const root = Math.sqrt(EXCHANGE[priority]);
  return { crossing: root, direction: 1 / root };
}

/** What the linter already charges for, that this arrangement charges more or less for. */
const CROSSING_RULES: readonly LayoutRuleId[] = ["line-crossing", "shallow-crossing", "line-overlap", "close-lines"];
/** A backward line costs what a crossing does, before the priority is applied: that is what "balanced" means. */
const BACKWARD_COST = LAYOUT_RULES["line-crossing"].cost;
/** A main line turned round costs this much again: a flow drawn inside out isn't worth one line fewer running backward. */
const TURNED_COST = BACKWARD_COST;
/** A forward line leaving by the wrong face, or arriving at it. */
const PORT_COST = 2;
/** A line's worth of travel against the flow, beyond the count of lines that run backward. */
const AGAINST_COST = 3;
/** A rank skipped: a lane to thread and a longer line, worth a fraction of a crossing. */
const SPAN_COST = 1.2;

/**
 * What a picture costs as a directed flow: the linter's cost, with its charge
 * for crossings scaled by the priority, and a charge for direction added.
 */
export function directedCost(report: LayoutReport, flow: FlowMetrics, weights: DirectedWeights): number {
  let crossing = 0;
  for (const rule of CROSSING_RULES) crossing += (report.counts[rule] ?? 0) * LAYOUT_RULES[rule].cost;
  const forward = Math.max(0, flow.directed - flow.backward - flow.flat);
  const direction =
    BACKWARD_COST * flow.backward +
    TURNED_COST * flow.turned +
    PORT_COST * (1 - flow.portDiscipline) * forward * 2 +
    AGAINST_COST * (1 - flow.flowConsistency) * flow.directed;
  return report.cost + (weights.crossing - 1) * crossing + weights.direction * direction;
}

/** A graph's own key: its boxes and its lines, in the order given. */
const graphKey = (ids: readonly string[], links: readonly PlaceLink[]) =>
  `${ids.join("\u0000")}\u0001${links
    .map((l) => `${l.source}\u0000${l.target}\u0000${l.weight ?? 1}${l.tether ? "t" : ""}${l.undirected ? "u" : ""}`)
    .join("\u0001")}`;

/**
 * Whose ranks a layout uses:
 *   "reading"   the ranked family's own, in the order a reader meets the boxes;
 *   "eager"     the search priced for crossings above all;
 *   "strict"    the search priced for direction above all;
 *   "searched"  the search at the document's own priority, started from all three;
 *   "annealed"  that search allowed to get worse on the way to better.
 * No one of them is best for every document: the search prices a model of the
 * drawing, and the model is not the drawing. So each is laid out in full, and
 * the pictures are compared as drawn, at the document's priority
 * (`directedCost`). The two ends are laid out at every priority, which is what
 * keeps the priority honest: a picture found for one setting that is better at
 * another is there to be chosen.
 */
type Ranks = "reading" | "eager" | "strict" | "searched" | "annealed";

/** The rankings of a graph, found once however many times it is laid out. */
function rankingsFor(weights: DirectedWeights, anneal: boolean) {
  const rankWeights: RankWeights = {
    crossing: BACKWARD_COST * weights.crossing,
    backward: BACKWARD_COST * weights.direction,
    turned: TURNED_COST * weights.direction,
    span: SPAN_COST,
  };
  const eager = directedWeights("crossings");
  const eagerWeights: RankWeights = {
    crossing: BACKWARD_COST * eager.crossing,
    backward: BACKWARD_COST * eager.direction,
    turned: TURNED_COST * eager.direction,
    span: SPAN_COST,
  };
  const strict = directedWeights("direction");
  const strictWeights: RankWeights = {
    crossing: BACKWARD_COST * strict.crossing,
    backward: BACKWARD_COST * strict.direction,
    turned: TURNED_COST * strict.direction,
    span: SPAN_COST,
  };
  const found = new Map<string, { reading: RankPlan; eager: RankPlan; strict: RankPlan; searched: RankPlan }>();
  return (ids: readonly string[], links: readonly PlaceLink[]) => {
    const key = graphKey(ids, links);
    let entry = found.get(key);
    if (!entry) {
      const reading = flatRanks(ids, links);
      const fewestBack = ranksInOrder(ids, links, fewestBackOrder(ids, links));
      const usable = links.filter((l) => !l.tether && l.source !== l.target);
      const order = acyclicOrder(ids, usable);
      // A search priced for crossings above all takes moves this one would turn
      // down, and some of them lead where this one wants to be. What it finds is
      // one more place to start from, judged at this priority's own prices.
      const eager = searchRanks(ids, links, eagerWeights, [reading, fewestBack], { reading: order });
      // And one priced for direction above all: the other end of the same road.
      const strictest = searchRanks(ids, links, strictWeights, [reading, fewestBack], { reading: order });
      const searched = searchRanks(ids, links, rankWeights, [reading, fewestBack, eager.rank, strictest.rank], { anneal, reading: order });
      entry = {
        reading: { rank: reading },
        eager: { rank: eager.rank, across: eager.across },
        strict: { rank: strictest.rank, across: strictest.across },
        searched: { rank: searched.rank, across: searched.across },
      };
      found.set(key, entry);
    }
    return entry;
  };
}

/** The ranked layout, on ranks chosen one of the ways above. */
function rankedEngine(weights: DirectedWeights, ranks: Ranks): PlaceEngine {
  const rankingsOf = rankingsFor(weights, ranks === "annealed");
  const planOf = (ids: readonly string[], links: readonly PlaceLink[]): RankPlan => {
    const rankings = rankingsOf(ids, links);
    return ranks === "annealed" ? rankings.searched : rankings[ranks];
  };
  return {
    place(items, links, opts) {
      // One box, or two: there is nothing to trade.
      if (items.length < 3) return null;
      // A tree has no crossings to trade for anything: it is drawn as one, every parent centred on its children.
      if (forestOf(items, links)) {
        const tree = tidyTree(items, links, opts);
        if (tree) return { ...tree, family: "tree" };
      }
      const plan = planOf(
        items.map((i) => i.id),
        links,
      );
      return { ...layered(items, links, opts, plan), family: "layered" };
    },
    ranks: (ids, links) => new Map(planOf(ids, links).rank),
  };
}

/**
 * Arrange a document as a directed flow. Pure: the document is not changed.
 * Direction, spacing and gaps come from `settings.layout` like any other
 * arrangement; `settings.directed` (or the options) says what to trade for what.
 */
export function directedLayout(template: DiagramTemplate, options: DirectedOptions = {}): DiagramTemplate {
  const { priority: askedPriority, method: askedMethod, ...arrange } = options;
  const priority = askedPriority ?? template.settings?.directed?.priority ?? "mostly-crossings";
  const method = askedMethod ?? template.settings?.directed?.method ?? "best";
  const weights = directedWeights(priority);

  const drilled = typeof arrange.frames === "object" ? arrange.frames.drill : null;
  const lintOptions = { containerKinds: arrange.containerKinds, frames: arrange.frames ?? ("root" as const) };
  const flowOptions = { containerKinds: arrange.containerKinds, frames: drilled === null ? ("root" as const) : { drill: drilled } };
  const priced = new WeakMap<DiagramTemplate, number>();
  const cost = (settled: DiagramTemplate, flow?: Flow): number => {
    const known = priced.get(settled);
    if (known !== undefined) return known;
    const value = directedCost(lintLayout(settled, lintOptions), measureFlow(settled, { ...flowOptions, axis: flow }), weights);
    priced.set(settled, value);
    return value;
  };

  // The reader's ranks go first in every method, and are read every way the
  // document allows. What follows is laid out the way that won, since comparing
  // directions is a full layout each, and has to beat it to be chosen.
  let flows: { outer: Flow; inner: Flow } | undefined;
  const ranked = (ranks: Ranks) => () =>
    autoPlaceWith(template, arrange, {
      engine: rankedEngine(weights, ranks),
      cost,
      ...(flows ? { flows } : { chose: (won: { outer: Flow; inner: Flow }) => (flows = won) }),
    });
  const ways: Array<() => DiagramTemplate> = [ranked("reading")];
  if (method === "best" || method === "layered") ways.push(ranked("searched"), ranked("eager"), ranked("strict"));
  if (method === "best" || method === "anneal") ways.push(ranked("annealed"));

  let best: DiagramTemplate | null = null;
  let bestCost = Infinity;
  for (const way of ways) {
    const doc = way();
    const value = cost(doc);
    // The first way stands unless a later one is plainly better: see `autoPlace`.
    if (value < bestCost * 0.97) {
      best = doc;
      bestCost = value;
    }
  }
  return best ?? template;
}
