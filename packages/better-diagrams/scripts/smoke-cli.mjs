/**
 * The `better-diagrams` command as a person gets it: installed from the
 * packed tarball by npx, outside any checkout, run on a diagram with
 * --no-open, and answering at the link it prints — which has to be the link
 * that opens that diagram, not the editor's front page. Its links and scratch
 * go to a throwaway BD_HOME, never ~/.better-diagrams.
 *
 *   npm pack && node scripts/smoke-cli.mjs ./mosphere-better-diagrams-0.1.0.tgz
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!process.argv[2]) {
  console.error("usage: node scripts/smoke-cli.mjs <the packed .tgz>");
  process.exit(2);
}
const tarball = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), "bd-smoke-"));
const work = join(root, "repo");
mkdirSync(work);
const env = { ...process.env, BD_HOME: join(root, "home") };
const command = ["--yes", "--package", tarball, "better-diagrams"];

let server;
function fail(message, output = "") {
  console.error(`smoke-cli: ${message}${output ? `\n--- its output:\n${output}` : ""}`);
  stop();
  process.exit(1);
}
function stop() {
  // npx runs the command as a child of its own: the group goes together.
  if (server?.exitCode === null) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}

// 1. It installs, and it runs.
const help = spawnSync("npx", [...command, "--help"], { cwd: work, env, encoding: "utf8" });
if (help.status !== 0 || !help.stderr.includes("usage: better-diagrams")) {
  fail(`--help exited ${help.status}`, `${help.stdout}${help.stderr}`);
}

// 2. On a diagram, it prints the link that opens it.
writeFileSync(
  join(work, "smoke.json"),
  `${JSON.stringify({ version: 1, meta: { title: "Smoke" }, nodes: [{ id: "a", label: "Smoke", kind: "service", x: 0, y: 0 }], edges: [] }, null, 2)}\n`,
);
server = spawn("npx", [...command, "smoke.json", "--no-open", "--port", "0"], { cwd: work, env, detached: true });
let output = "";
const link = await new Promise((done) => {
  const timer = setTimeout(() => done(null), 120_000);
  const read = (chunk) => {
    output += chunk;
    // A whole address: up to the end of its line, never a chunk's half of one.
    const found = output.match(/(http:\/\/127\.0\.0\.1:\d+\S*)\s/);
    if (found) {
      clearTimeout(timer);
      done(found[1]);
    }
  };
  server.stdout.on("data", read);
  server.stderr.on("data", read);
  server.on("exit", () => done(null));
});
if (!link) fail("the command printed no address", output);
const open = new URL(link).searchParams.get("open");
if (!open) fail(`the command printed ${link}, which opens the editor's front page, not smoke.json`, output);

// 3. The link answers with the editor, and names a file the store lists.
const page = await fetch(link);
const html = await page.text();
if (page.status !== 200 || !html.includes('<div id="root">')) fail(`${link} answered ${page.status} without the editor`, output);
const listing = await (await fetch(new URL("/__templates", link))).json();
if (!listing.templates?.some((entry) => `${entry.folder}/${entry.file}` === open)) {
  fail(`?open=${open} names no file the editor lists`, output);
}

// The layout command, from the same tarball: a rough diagram, linted and fixed.
const rough = join(work, "rough.json");
writeFileSync(
  rough,
  JSON.stringify({
    version: 1,
    nodes: [
      { id: "a", label: "Alpha", kind: "service", x: 0, y: 0, w: 170, h: 76 },
      { id: "b", label: "Bravo", kind: "service", x: 30, y: 20, w: 170, h: 76 },
    ],
    edges: [{ id: "e", source: "a", target: "b", label: "" }],
  }),
);
const layout = (...args) =>
  spawnSync("npx", ["--yes", "--package", tarball, "bd-layout", ...args], { cwd: work, env, encoding: "utf8" });
const lint = layout("lint", rough, "--min-score", "100");
if (lint.status !== 1 || !lint.stdout.includes("box-overlap")) fail("bd-layout lint should find the overlap and exit 1", lint.stdout + lint.stderr);
const typo = layout("lint", rough, "--min-scroe", "100");
if (typo.status !== 2) fail("bd-layout should refuse a flag it doesn't know, not pass the gate", typo.stdout + typo.stderr);
const fix = layout("fix", rough, "--write");
if (fix.status !== 0) fail("bd-layout fix failed", fix.stdout + fix.stderr);
const directed = layout("place", rough, "--mode", "directed", "--priority", "balanced", "--out", "directed.json");
if (directed.status !== 0 || !directed.stderr.includes("directed flow")) fail("bd-layout place --mode directed failed", directed.stdout + directed.stderr);
const relint = layout("lint", rough);
if (relint.status !== 0 || relint.stdout.includes("box-overlap")) fail("bd-layout fix left the overlap", relint.stdout + relint.stderr);

console.log(`smoke-cli: ok — ${link}`);
stop();
