#!/usr/bin/env node
/**
 * bd-layout — check and improve where a diagram's boxes and lines go, from the
 * command line. For a script, a CI job, or a model checking its own work.
 *
 *   bd-layout lint <file.json> [--json] [--min-score <n>] [--all-canvases]
 *       What's wrong with the picture, and a score out of 100. Exits 1 when the
 *       score is under --min-score. Changes nothing.
 *
 *   bd-layout fix <file.json> [--write | --out <file>]
 *       Keep the arrangement, fix what lint finds: line up what's nearly in line,
 *       clear overlaps, route lines and labels around what's in the way.
 *
 *   bd-layout place <file.json> [--algorithm <a>] [--direction <d>] [--shape <s>]
 *                               [--spacing <s>] [--write | --out <file>]
 *       Place everything from the graph, ignoring where things are now.
 *
 *   bd-layout best <file.json> [--write | --out <file>]
 *       Keep the author's arrangement if it's any good (polished), otherwise
 *       place from the graph. The one to run after a model writes a diagram.
 *
 * Without --write or --out the result goes to stdout, so it pipes. What was done
 * goes to stderr. Runs against the built package (`npm run build` first when
 * developing).
 */
import { readFile, writeFile } from "node:fs/promises";

const contract = await import(new URL("../dist/contract.js", import.meta.url).href).catch(() => null);
if (!contract) {
  console.error("bd-layout: the package is not built — run `npm run build` in packages/better-diagrams first.");
  process.exit(2);
}
const {
  LAYOUT_ALGORITHMS,
  LAYOUT_DIRECTIONS,
  LAYOUT_SHAPES,
  LAYOUT_SPACINGS,
  arrangeBest,
  autoPlace,
  lintLayout,
  polishLayout,
  validateTemplate,
} = contract;

const VALUE_FLAGS = new Set(["min-score", "out", "algorithm", "direction", "shape", "spacing"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    if (!VALUE_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) fail(`--${key} wants a value`);
    flags[key] = next;
    i += 1;
  }
  return { positional, flags };
}

function fail(message) {
  console.error(`bd-layout: ${message}`);
  process.exit(2);
}

const USAGE = "usage: bd-layout <lint|fix|place|best> <file.json> [--write | --out <file>] (see the top of this script for the flags)";

function oneOf(value, allowed, name) {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) fail(`--${name} wants one of ${allowed.join(", ")}, not "${value}"`);
  return value;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, file] = positional;
if (flags.help || !command) {
  console.error(USAGE);
  process.exit(flags.help ? 0 : 2);
}
if (!["lint", "fix", "place", "best"].includes(command)) fail(`no command "${command}". ${USAGE}`);
if (!file) fail(`${command} wants a diagram file. ${USAGE}`);

let raw;
try {
  raw = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  fail(`couldn't read ${file}: ${error.message}`);
}
const doc = validateTemplate(raw);
const frames = flags["all-canvases"] ? "all" : "root";

function printReport(report, stream) {
  stream.write(`score ${report.score}/100  ${report.metrics.boxes} boxes, ${report.metrics.lines} lines, ${Math.round(report.metrics.width)}×${Math.round(report.metrics.height)}\n`);
  for (const f of report.findings) stream.write(`  ${f.severity.padEnd(7)} ${f.rule.padEnd(18)} ${f.message}\n`);
}

if (command === "lint") {
  const report = lintLayout(doc, { frames });
  if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report, process.stdout);
  const floor = flags["min-score"] === undefined ? null : Number(flags["min-score"]);
  if (floor !== null && !Number.isFinite(floor)) fail(`--min-score wants a number, not "${flags["min-score"]}"`);
  process.exit(floor !== null && report.score < floor ? 1 : 0);
}

const options = {
  frames: flags["all-canvases"] || command !== "fix" ? "all" : "root",
  algorithm: oneOf(flags.algorithm, LAYOUT_ALGORITHMS, "algorithm"),
  direction: oneOf(flags.direction, LAYOUT_DIRECTIONS, "direction"),
  shape: oneOf(flags.shape, LAYOUT_SHAPES, "shape"),
  spacing: oneOf(flags.spacing, LAYOUT_SPACINGS, "spacing"),
};
for (const key of Object.keys(options)) if (options[key] === undefined) delete options[key];

let result;
let note;
if (command === "fix") {
  result = polishLayout(doc, options);
  note = result === doc ? "nothing a polish could improve" : "polished";
} else if (command === "place") {
  result = autoPlace(doc, options);
  note = "placed from the graph";
} else {
  const best = arrangeBest(doc, options);
  result = best.template;
  note = { kept: "kept the author's arrangement", polished: "kept the author's arrangement, polished", placed: "placed from the graph" }[best.source];
}

const after = lintLayout(result, { frames });
const before = lintLayout(doc, { frames });
process.stderr.write(`bd-layout: ${note}: score ${before.score} → ${after.score}\n`);

const json = `${JSON.stringify(result, null, 2)}\n`;
const target = flags.write ? file : flags.out;
if (target) await writeFile(target, json);
else process.stdout.write(json);
