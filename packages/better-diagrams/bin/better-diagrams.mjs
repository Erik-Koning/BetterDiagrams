#!/usr/bin/env node
/**
 * better-diagrams — the editor, for the diagrams a repo keeps beside its code.
 *
 *   better-diagrams                          # link this folder, open the editor
 *   better-diagrams docs/BetterDiagram.json  # open that file, live
 *   better-diagrams ../other-repo docs/arch  # link folders; files and folders mix
 *     --new        start a .json path that isn't there yet as an empty diagram
 *     --port <n>   the port to try first (default 5199; the next free one is taken)
 *     --no-open    don't open the browser
 *
 * Serves the built editor on 127.0.0.1 with the disk store behind it: files
 * open live — edits save back to them, formatted the way their repo formats
 * JSON, and edits made to them elsewhere reload in the editor. Save as…
 * writes a new file anywhere and keeps editing it there. Links and
 * scratch live in ~/.better-diagrams (BD_HOME moves them). No checkout of
 * Better Diagrams needed — `npx @mosphere/better-diagrams` runs it.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const disk = await import(new URL("../dist/disk.js", import.meta.url).href).catch(() => null);
const appDir = fileURLToPath(new URL("../app/", import.meta.url));
if (!disk || !existsSync(join(appDir, "index.html"))) {
  console.error("better-diagrams: the package is not built — run `npm run build && npm run build:app` at the repo root first.");
  process.exit(2);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") flags.port = argv[++i];
    else if (a.startsWith("--")) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
if (flags.help || flags.h) {
  console.error("usage: better-diagrams [file.json | folder]... [--new] [--port <n>] [--no-open]");
  process.exit(0);
}
const port = flags.port === undefined ? 5199 : Number(flags.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`better-diagrams: --port wants a port number, not ${flags.port}`);
  process.exit(2);
}

const folders = [];
const files = [];
for (const arg of positional.length ? positional : ["."]) {
  const path = resolve(arg);
  if (existsSync(path) && statSync(path).isDirectory()) {
    folders.push(path);
  } else if (existsSync(path)) {
    if (!path.endsWith(".json")) {
      console.error(`better-diagrams: ${arg} isn't a .json diagram or a folder`);
      process.exit(2);
    }
    files.push(path);
  } else if (flags.new && path.endsWith(".json") && existsSync(dirname(path))) {
    // A new diagram, titled after its file, written the way the repo formats JSON.
    const doc = { version: 1, meta: { title: basename(path, ".json") }, nodes: [], edges: [] };
    disk.writeFileAtomic(path, await disk.formatDiagram(path, doc));
    console.error(`better-diagrams: started ${arg}`);
    files.push(path);
  } else {
    console.error(`better-diagrams: ${arg} isn't there${path.endsWith(".json") ? " — add --new to start it as an empty diagram" : ""}`);
    process.exit(2);
  }
}

const home = resolve(process.env.BD_HOME ?? join(homedir(), ".better-diagrams"));
const quiet = { info: () => {}, warn: (message) => console.error(message.trim()) };
let running;
try {
  running = await disk.startStandalone({ appDir, home, linked: folders, port, logger: quiet });
} catch (error) {
  console.error(`better-diagrams: ${error.message}`);
  process.exit(1);
}

// Each file is linked the way Link a file on disk… links it: one in a linked
// folder opens from there, anything else is symlinked into ~/.better-diagrams.
let open = null;
for (const file of files) {
  const linked = running.store.linkFile(file);
  if (linked.error) {
    console.error(`better-diagrams: ${linked.error}`);
    continue;
  }
  open ??= linked.entry;
}
const url = open ? `${running.url}/?open=${encodeURIComponent(`${open.folder}/${open.file}`)}` : `${running.url}/`;

const shown = (path) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
console.error(`Better Diagrams on ${running.url}`);
for (const folder of folders) console.error(`  linked  ${shown(folder)}`);
for (const file of files) console.error(`  file    ${shown(file)}`);
console.error("  Ctrl+C to stop");

if (!flags["no-open"]) {
  const [command, args] =
    platform() === "darwin" ? ["open", [url]] : platform() === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => console.error(`  open ${url}`)).unref();
  } catch {
    console.error(`  open ${url}`);
  }
}

const stop = () => {
  void running.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
