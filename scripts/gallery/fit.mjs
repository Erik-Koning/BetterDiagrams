/**
 * Fitting the layout linter to readers. Every recorded pick says "of these two
 * pictures of one diagram, this one". A rule's cost should be whatever makes
 * the linter's cost agree with those picks: the cheaper picture is the one
 * readers chose.
 *
 * The model is the linter's own: cost = Σ rule cost × count + the soft part
 * (line length and canvas size). Each weight is the current cost times a
 * factor e^u, so weights stay positive and the fit is pulled toward today's
 * judgement unless the picks say otherwise (an L2 penalty on u). The soft part
 * is the unit everything else is measured in, so its factor stays 1 and every
 * other factor is in the linter's own units: the ones printed, and written.
 * Errors keep a floor in those units: no fit may make an overlap cheap.
 * Agreement is measured on picks the fit didn't see, grouped by diagram, so one
 * diagram's pictures can't teach the fit about themselves. One reviewer's pick
 * of one pair counts once however often it was recorded.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEngine, REPO } from "./engine.mjs";

const PICKS = join(REPO, "gallery/picks.jsonl");
const DOCS = join(REPO, "gallery/docs");
const RULES_FILE = join(REPO, "packages/better-diagrams/src/contract/layout-lint.ts");

/**
 * The features of one picture: each rule's count; the soft part of the cost
 * (line length and canvas size); and, apart from it, how small the words come
 * out fitted to a window (`shrink`, per halving) and how far past readable
 * (`illegible`).
 */
export function featuresOf(engine, doc) {
  const report = engine.lintLayout(engine.validateTemplate(doc));
  const zoom = report.metrics.zoom ?? 1;
  const L = engine.lintInternals ?? {};
  const shrink = -Math.log2(zoom);
  const illegible = Math.max(0, (L.READABLE_ZOOM ?? 0.5) - zoom);
  // Weights of 0 where the engine has none: an older linter's cost has no legibility in it to take out.
  let soft = report.cost - shrink * (L.LEGIBILITY_WEIGHT ?? 0) - illegible * (L.ILLEGIBLE_WEIGHT ?? 0);
  for (const [rule, n] of Object.entries(report.counts)) soft -= n * engine.LAYOUT_RULES[rule].cost;
  return { counts: report.counts, soft, shrink, illegible };
}

/** The features past the rules, in the order a row lists them after the rule counts. */
export const EXTRA_FEATURES = ["soft", "shrink", "illegible"];

/** The two pictures of a pick, whichever was shown as A. */
const pairKey = (p) => (p.a && p.b ? [p.a, p.b].sort().join("|") : `${p.run}/${p.pair}`);

/**
 * Each reviewer's last word on each pair. A picks file read in twice, or a pair
 * judged again under the same name, is still one opinion: counted twice it would
 * weigh double in the fit and pass for two reviewers agreeing. A pick with no
 * name on it can't be told from anyone else's, so it stands.
 */
export function distinctPicks(picks) {
  const last = new Map();
  picks.forEach((p, i) => last.set(p.by ? `${p.by}|${pairKey(p)}` : `#${i}`, p));
  return [...last.values()];
}

/** Rows for fitting: x = features of B minus features of A; y = +1 when A was picked. */
export function rowsFrom(picks, featuresByHash, ruleIds) {
  const rows = [];
  for (const p of distinctPicks(picks)) {
    if (p.pick === "tie") continue;
    const a = featuresByHash.get(p.a);
    const b = featuresByHash.get(p.b);
    if (!a || !b) continue;
    const x = ruleIds.map((r) => (b.counts[r] ?? 0) - (a.counts[r] ?? 0));
    for (const f of EXTRA_FEATURES) x.push((b[f] ?? 0) - (a[f] ?? 0));
    rows.push({ x, y: p.pick === "a" ? 1 : -1, doc: p.doc });
  }
  return rows;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const dot = (w, x) => w.reduce((sum, wi, i) => sum + wi * x[i], 0);

/** How often a weighting agrees with the picks; a tie in cost counts half. */
export function agreement(rows, w) {
  if (!rows.length) return NaN;
  let right = 0;
  for (const r of rows) {
    const m = dot(w, r.x) * r.y;
    right += m > 1e-9 ? 1 : Math.abs(m) <= 1e-9 ? 0.5 : 0;
  }
  return right / rows.length;
}

/**
 * Fit weights w = prior × scale × e^u. The scale is fitted first (a cost is
 * only meaningful up to one), then u, by Adam on the logistic loss plus
 * lambda·Σu². `floors` are the least factor each weight may fall to. `unit`
 * is the index of the weight the others are measured against: its factor stays
 * 1, so a floor of 0.5 means half of today's cost in the units the linter
 * uses, whatever the fit would have liked to do to the unit itself.
 */
export function fitWeights(rows, prior, { lambda = 1, iterations = 3000, floors = [], unit = null } = {}) {
  const n = prior.length;
  const loss = (w) => rows.reduce((sum, r) => sum + Math.log1p(Math.exp(-r.y * dot(w, r.x))), 0);
  // The scale: a coarse search, then a finer one around the best.
  let scale = 1;
  let best = Infinity;
  for (let k = -8; k <= 4; k += 0.25) {
    const s = 2 ** k;
    const l = loss(prior.map((p) => p * s));
    if (l < best) {
      best = l;
      scale = s;
    }
  }
  const u = new Array(n).fill(0);
  const m = new Array(n).fill(0);
  const v = new Array(n).fill(0);
  const rate = 0.05;
  const weights = () => prior.map((p, i) => p * scale * Math.exp(u[i]));
  for (let t = 1; t <= iterations; t += 1) {
    const w = weights();
    const grad = new Array(n).fill(0);
    for (const r of rows) {
      const margin = r.y * dot(w, r.x);
      const g = -r.y * sigmoid(-margin);
      for (let i = 0; i < n; i += 1) if (r.x[i]) grad[i] += g * r.x[i] * w[i];
    }
    for (let i = 0; i < n; i += 1) {
      if (i === unit) continue;
      grad[i] += 2 * lambda * u[i];
      m[i] = 0.9 * m[i] + 0.1 * grad[i];
      v[i] = 0.999 * v[i] + 0.001 * grad[i] * grad[i];
      const mh = m[i] / (1 - 0.9 ** t);
      const vh = v[i] / (1 - 0.999 ** t);
      u[i] -= (rate * mh) / (Math.sqrt(vh) + 1e-8);
      if (floors[i] != null) u[i] = Math.max(u[i], Math.log(floors[i]));
      u[i] = Math.min(u[i], Math.log(20));
    }
  }
  return { weights: weights(), scale, factors: u.map(Math.exp) };
}

/** Agreement on picks the fit never saw: k folds, each a set of whole diagrams. */
export function crossValidate(rows, prior, options = {}, k = 5) {
  const docs = [...new Set(rows.map((r) => r.doc))].sort();
  if (docs.length < 2) return { fitted: NaN, prior: NaN };
  const folds = Math.min(k, docs.length);
  const foldOf = new Map(docs.map((d, i) => [d, i % folds]));
  let fittedRight = 0;
  let priorRight = 0;
  let total = 0;
  for (let f = 0; f < folds; f += 1) {
    const train = rows.filter((r) => foldOf.get(r.doc) !== f);
    const test = rows.filter((r) => foldOf.get(r.doc) === f);
    if (!test.length || !train.length) continue;
    const { weights } = fitWeights(train, prior, options);
    fittedRight += agreement(test, weights) * test.length;
    priorRight += agreement(test, prior) * test.length;
    total += test.length;
  }
  return { fitted: fittedRight / total, prior: priorRight / total, pairs: total };
}

/** How often two reviewers who saw the same pair agreed: the ceiling a linter can reach. */
export function reviewerAgreement(picks) {
  const byPair = new Map();
  for (const p of distinctPicks(picks)) {
    const key = pairKey(p);
    const list = byPair.get(key) ?? [];
    // The picture chosen, not the letter: another run may show the same two the other way round.
    list.push(p.pick === "tie" ? "tie" : (p[p.pick] ?? p.pick));
    byPair.set(key, list);
  }
  let agree = 0;
  let total = 0;
  for (const list of byPair.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        total += 1;
        agree += list[i] === list[j] ? 1 : list[i] === "tie" || list[j] === "tie" ? 0.5 : 0;
      }
    }
  }
  return total ? { rate: agree / total, pairs: total } : null;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/**
 * The linter's source with a fitted model written into it: every rule's cost
 * and the named constants. All of it or nothing: a rule or a constant whose
 * line can't be found is an error naming it, since a linter with half a fit in
 * it is not the one whose agreement was reported.
 */
export function withFittedCosts(source, costs, constants = {}) {
  let text = source;
  const missed = [];
  for (const [rule, cost] of Object.entries(costs)) {
    const pattern = new RegExp(`(\\n  "?${escapeRegExp(rule)}"?: \\{[^\\n]*?cost: )([\\d.]+)( \\})`);
    if (pattern.test(text)) text = text.replace(pattern, `$1${cost}$3`);
    else missed.push(rule);
  }
  for (const [name, value] of Object.entries(constants)) {
    const pattern = new RegExp(`(\\bconst ${escapeRegExp(name)} = )([\\d.]+)(;)`);
    if (pattern.test(text)) text = text.replace(pattern, `$1${value}$3`);
    else missed.push(name);
  }
  if (missed.length) throw new Error(`nothing written: no line to put the fitted value on for ${missed.join(", ")}`);
  return text;
}

export async function fitCommand({ write = false, by = "" } = {}) {
  if (!existsSync(PICKS)) throw new Error("no picks yet: record some with `npm run gallery -- pick`");
  const engine = await loadEngine(REPO, join(REPO, "gallery/out/.engine"));
  // `by` keeps only the picks of reviewers whose name starts with it: one round, or one person.
  const recorded = readFileSync(PICKS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const picks = distinctPicks(recorded).filter((p) => (p.by ?? "").startsWith(by));
  if (recorded.length !== distinctPicks(recorded).length) {
    console.log(`${recorded.length - distinctPicks(recorded).length} picks recorded more than once by one reviewer, counted once`);
  }
  const ruleIds = [...engine.LAYOUT_RULE_IDS];
  const features = new Map();
  for (const p of picks) {
    for (const hash of [p.a, p.b]) {
      if (features.has(hash)) continue;
      const file = join(DOCS, `${hash}.json`);
      if (existsSync(file)) features.set(hash, featuresOf(engine, JSON.parse(readFileSync(file, "utf8"))));
    }
  }
  const rows = rowsFrom(picks, features, ruleIds);
  const L = engine.lintInternals ?? {};
  const prior = [...ruleIds.map((r) => engine.LAYOUT_RULES[r].cost), 1, L.LEGIBILITY_WEIGHT ?? 16, L.ILLEGIBLE_WEIGHT ?? 1500];
  const floors = [...ruleIds.map((r) => (engine.LAYOUT_RULES[r].severity === "error" ? 0.5 : null)), null, null, null];
  // The soft part keeps its weight of 1, so every factor, and every floor, is in the linter's units.
  const unitAt = ruleIds.length;
  const ceiling = reviewerAgreement(picks);
  console.log(`${picks.length} picks, ${rows.length} usable (not ties, both pictures stored), from ${new Set(rows.map((r) => r.doc)).size} diagrams`);
  if (ceiling) console.log(`reviewers agreed with each other on ${(ceiling.rate * 100).toFixed(0)}% of ${ceiling.pairs} shared pairs`);
  console.log(`today's costs agree with ${(agreement(rows, prior) * 100).toFixed(0)}% of picks`);

  let chosen = null;
  for (const lambda of [0.3, 1, 3, 10]) {
    const cv = crossValidate(rows, prior, { lambda, floors, unit: unitAt });
    console.log(`lambda ${String(lambda).padEnd(4)} held-out agreement: fitted ${(cv.fitted * 100).toFixed(0)}%, today's ${(cv.prior * 100).toFixed(0)}%`);
    if (!chosen || cv.fitted > chosen.cv.fitted) chosen = { lambda, cv };
  }
  const { weights, scale } = fitWeights(rows, prior, { lambda: chosen.lambda, floors, unit: unitAt });
  // The lambda was chosen by the same held-out picks it is then reported on, so that figure flatters a little.
  console.log(`\nfitted on every pick with lambda ${chosen.lambda}: agrees with ${(agreement(rows, weights) * 100).toFixed(0)}% (held out: ${(chosen.cv.fitted * 100).toFixed(0)}%, the best of the four lambdas above, so if anything a little high)`);
  // Back in the linter's own units: the soft part keeps its weight of 1.
  const unit = weights[unitAt];
  console.log("\nrule".padEnd(22), "today".padStart(8), "fitted".padStart(8), "seen in".padStart(9));
  const fitted = {};
  for (const [i, rule] of ruleIds.entries()) {
    const seen = rows.filter((r) => r.x[i]).length;
    fitted[rule] = Math.round((weights[i] / unit) * 10) / 10;
    console.log(rule.padEnd(22), String(engine.LAYOUT_RULES[rule].cost).padStart(8), String(fitted[rule]).padStart(8), String(seen).padStart(9));
  }
  const constants = {};
  for (const [k, name] of EXTRA_FEATURES.entries()) {
    if (name === "soft") continue;
    const i = ruleIds.length + k;
    const value = Math.round((weights[i] / unit) * 10) / 10;
    constants[name === "shrink" ? "LEGIBILITY_WEIGHT" : "ILLEGIBLE_WEIGHT"] = value;
    console.log(`${name} weight`.padEnd(22), String(prior[i]).padStart(8), String(value).padStart(8), String(rows.filter((r) => r.x[i]).length).padStart(9));
  }
  console.log(`(scale ${scale.toFixed(3)}; the soft part keeps a weight of 1)`);
  if (write) {
    // The rules' costs and the two legibility weights together: they were fitted together.
    writeFileSync(RULES_FILE, withFittedCosts(readFileSync(RULES_FILE, "utf8"), fitted, constants));
    console.log(`\nwrote the fitted costs and legibility weights into ${RULES_FILE.replace(`${REPO}/`, "")}`);
  }
}
