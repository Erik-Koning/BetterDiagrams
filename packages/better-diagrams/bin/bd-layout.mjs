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
 * Every command also takes --kinds <a,b> for kinds of your own (a registry's),
 * and --container-kinds <a,b> for those of them that hold other boxes. Without
 * them a kind this package doesn't know is read as a plain service, so fix,
 * place and best refuse to write a document that has one.
 *
 * Without --write or --out the result goes to stdout, so it pipes. What was done
 * goes to stderr. Exits 2 for a bad command line or a file that isn't a diagram.
 * Runs against the built package (`npm run build` first when developing).
 */
import { readFile, writeFile } from "node:fs/promises";

const contract = await import(new URL("../dist/contract.js", import.meta.url).href).catch((error) => {
  console.error(
    error?.code === "ERR_MODULE_NOT_FOUND"
      ? "bd-layout: the package is not built — run `npm run build` in packages/better-diagrams first."
      : `bd-layout: couldn't load the package: ${error?.message ?? error}`,
  );
  process.exit(2);
});
const {
  CONTAINER_KINDS,
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

const VALUE_FLAGS = new Set(["min-score", "out", "algorithm", "direction", "shape", "spacing", "kinds", "container-kinds"]);
const SWITCHES = new Set(["json", "write", "all-canvases", "help"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const equals = a.indexOf("=");
    const key = a.slice(2, equals < 0 ? undefined : equals);
    if (SWITCHES.has(key)) {
      if (equals >= 0) fail(`--${key} takes no value`);
      flags[key] = true;
      continue;
    }
    // A misspelt flag must not pass for one that was never given.
    if (!VALUE_FLAGS.has(key)) fail(`no flag --${key}. ${USAGE}`);
    if (equals >= 0) {
      flags[key] = a.slice(equals + 1);
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

const USAGE = [
  "usage: bd-layout lint <file.json> [--json] [--min-score <n>] [--all-canvases]",
  "       bd-layout fix <file.json> [--write | --out <file>] [--all-canvases]",
  "       bd-layout place <file.json> [--algorithm <a>] [--direction <d>] [--shape <s>] [--spacing <s>] [--write | --out <file>]",
  "       bd-layout best <file.json> [--write | --out <file>]",
  "       each also takes --kinds <a,b> and --container-kinds <a,b> for kinds of your own",
].join("\n");

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
const list = (value) => (value ? String(value).split(",").map((k) => k.trim()).filter(Boolean) : []);
const ownContainers = list(flags["container-kinds"]);
const knownKinds = [...list(flags.kinds), ...ownContainers];
const containerKinds = ownContainers.length ? [...CONTAINER_KINDS, ...ownContainers] : undefined;
let doc;
try {
  doc = validateTemplate(raw, { knownKinds, ...(containerKinds ? { containerKinds } : {}) });
} catch (error) {
  fail(`${file} isn't a diagram: ${error.message}`);
}
// Validation reads a kind it doesn't know as a service. Writing that back would lose the kind.
const kept = new Map(doc.nodes.map((n) => [n.id, n.kind]));
const lost = [...new Set((Array.isArray(raw?.nodes) ? raw.nodes : []).filter((n) => n && typeof n.kind === "string" && kept.has(n.id) && kept.get(n.id) !== n.kind).map((n) => n.kind))];
if (lost.length) {
  const message = `${file} uses ${lost.length === 1 ? "a kind" : "kinds"} this package doesn't know (${lost.join(", ")}); pass --kinds ${lost.join(",")}`;
  if (command !== "lint") fail(`${message}, or the result would turn ${lost.length === 1 ? "it" : "them"} into services`);
  console.error(`bd-layout: ${message} to measure ${lost.length === 1 ? "it" : "them"} as drawn`);
}
if (flags.write && flags.out) fail("--write and --out are two places to put one result; give one");
const frames = flags["all-canvases"] ? "all" : "root";
const kindOptions = containerKinds ? { containerKinds } : {};

function printReport(report, stream) {
  stream.write(`score ${report.score}/100  ${report.metrics.boxes} boxes, ${report.metrics.lines} lines, ${Math.round(report.metrics.width)}×${Math.round(report.metrics.height)}\n`);
  for (const f of report.findings) stream.write(`  ${f.severity.padEnd(7)} ${f.rule.padEnd(18)} ${f.message}\n`);
}

if (command === "lint") {
  const floor = flags["min-score"] === undefined ? null : Number(flags["min-score"]);
  if (floor !== null && (flags["min-score"] === "" || !Number.isFinite(floor))) fail(`--min-score wants a number, not "${flags["min-score"]}"`);
  const report = lintLayout(doc, { frames, ...kindOptions });
  if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report, process.stdout);
  // Not process.exit(): a long report into a pipe would be cut off where the pipe's buffer ends.
  process.exitCode = floor !== null && report.score < floor ? 1 : 0;
} else {
  await arrange();
}

async function arrange() {

const options = {
  ...kindOptions,
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

// The score is of the canvases that were arranged.
const after = lintLayout(result, { frames: options.frames, ...kindOptions });
const before = lintLayout(doc, { frames: options.frames, ...kindOptions });
process.stderr.write(`bd-layout: ${note}: score ${before.score} → ${after.score}\n`);

// Nothing to do is nothing to write: the file stays as its author left it.
if (flags.write && result === doc) return;
const json = `${JSON.stringify(result, null, 2)}\n`;
const target = flags.write ? file : flags.out;
if (!target) {
  process.stdout.write(json);
  return;
}
try {
  await writeFile(target, json);
} catch (error) {
  fail(`couldn't write ${target}: ${error.message}`);
}
}
