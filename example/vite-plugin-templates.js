/**
 * vite-plugin-templates.js — the disk store behind auto-save.
 *
 * The editor keeps its workspace in localStorage, which is fine for a browser
 * but invisible everywhere else: you cannot read it, diff it, or commit it. A
 * few lines of dev middleware turn every open document into a real `.json`
 * file, so the diagrams you make while developing are ordinary files —
 * greppable, reviewable, and loadable back into the app.
 *
 * Three kinds of folder:
 *
 *   scratch/   — where auto-save writes a file that has no other home. Every
 *                file made in the app lands here as you work. Git-ignored,
 *                because a folder that changes on every keystroke has no
 *                business in `git status`.
 *   examples/  — curated and tracked. Listed and loadable; written ONLY when
 *                you opened that file in the app and edited it there — the
 *                client binds a workspace file to the file it was opened
 *                from, so auto-save never lands in examples/ by name
 *                collision. Never deleted by the app.
 *   linked     — folders OUTSIDE the repo, named in `BD_LINKED_DIRS` (see
 *                vite.config.js), for a diagram that lives with another
 *                project. Treated like examples/ — written only back to a
 *                file the app opened, never deleted — and more warily: a
 *                missing folder is skipped rather than created, and a JSON
 *                file that is not a diagram (a package.json, a tsconfig) is
 *                listed as unreadable and never written over.
 *
 * And all are WATCHED: a file changed by another program (an editor, a
 * script, an AI agent) is announced to the open app over Vite's HMR socket
 * as a `better-diagrams:template` event, and the app reloads it — the file
 * on disk wins. The server's own writes are not announced back, so a save
 * from the app never bounces into a reload of itself.
 *
 * DEV ONLY, deliberately. `configureServer` runs for `vite dev` and nowhere
 * else, so a production build has no route to write with and the app quietly
 * does without it (see `templates.js` on the client). Nothing here should ever
 * ship in a bundle.
 *
 * The route is `/__templates` rather than `/api/...` because `/api` is proxied
 * to the AI server (vite.config.js) — a separate prefix keeps the two from
 * ever having to argue about ordering.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

const ROUTE = "/__templates";

/** The folder auto-save owns: written, renamed and deleted by the app. */
const WRITABLE = "scratch";
/** Folders inside the repo the app may write a file it opened back to. Deleting stays scratch-only. */
const IN_REPO = [WRITABLE, "examples"];
/** Every linked folder's id starts with this — the client tells them apart by it (templates.js). */
const LINKED_PREFIX = "linked-";
/** The HMR event an outside edit is announced with (see templates.js). */
const CHANGE_EVENT = "better-diagrams:template";
/** Editors save in bursts (truncate, write, rename); announce once it settles. */
const SETTLE_MS = 120;
/** A file name the route will address — see `safePath`. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*\.json$/;

/**
 * A path we are willing to touch: a known folder, a plain file name (no
 * separators, no leading dot), and — belt and braces against `..` games — a
 * resolved path still inside that folder. Names are not held to the slug
 * the client writes with: a file someone else made, in a linked folder or
 * dropped into examples/, is called whatever they called it.
 */
function safePath(dirs, folder, name) {
  const dir = dirs[folder];
  if (!dir) return null;
  if (!FILE_NAME.test(name)) return null;
  const full = resolve(dir, name);
  return full.startsWith(resolve(dir) + sep) ? full : null;
}

function readBody(req) {
  return new Promise((resolve_, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // A diagram is never megabytes; refuse anything that large rather than
      // buffering it.
      if (size > 5_000_000) {
        reject(new Error("Template too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve_(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const json = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
};

/**
 * Is this JSON a diagram at all? A linked folder is someone else's project,
 * with its package.json and tsconfig.json beside the diagram; opening one of
 * those would bind it, and the first edit would write a diagram over it.
 */
const isDiagram = (doc) => Array.isArray(doc?.nodes) || Array.isArray(doc?.participants);

/** A listing the menu shows but will not open, and why. */
const unreadable = (folder, file, reason) => ({ folder, file, name: file, kind: "unreadable", reason, nodes: 0, updated: 0 });

/**
 * What the dropdown needs to list a file without opening it: its name, which
 * editor can render it, where it lives, and when it last changed. The kind is
 * sniffed from the document's own shape — the same rule the welcome modal
 * uses on pasted JSON — so the files stay plain templates with nothing this
 * app invented in them.
 */
function describe(dir, folder, file) {
  if (!FILE_NAME.test(file)) return unreadable(folder, file, "a file name the app can't open");
  const raw = readFileSync(join(dir, file), "utf8");
  const doc = JSON.parse(raw);
  if (!isDiagram(doc)) return unreadable(folder, file, "JSON, but not a diagram");
  return {
    folder,
    file,
    name: typeof doc?.meta?.title === "string" && doc.meta.title.trim() ? doc.meta.title : file.replace(/\.json$/, ""),
    kind: Array.isArray(doc?.participants) ? "sequence" : "architecture",
    nodes: Array.isArray(doc?.nodes) ? doc.nodes.length : (doc?.participants?.length ?? 0),
    updated: statSync(join(dir, file)).mtimeMs,
  };
}

function listFolder(dirs, folder) {
  const dir = dirs[folder];
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // the folder may not exist yet — nothing to list, not an error
  }
  const listed = [];
  for (const file of files) {
    // One unreadable file must not take the whole list down — hand-edited
    // JSON is exactly what these folders invite.
    try {
      listed.push(describe(dir, folder, file));
    } catch {
      listed.push(unreadable(folder, file, "not readable as JSON"));
    }
  }
  return listed.sort((a, b) => b.updated - a.updated);
}

/** The folder-format root: one subdirectory per tree, listed by name. */
const FOLDERS = "folders";
const FOLDER_FILE = /\.(json|ya?ml|md)$/i;
const FOLDER_SKIP = new Set(["node_modules", ".git"]);
const FOLDER_MAX_BYTES = 5_000_000;

function listFolders(dirs) {
  const root = dirs[FOLDERS];
  if (!root) return [];
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
  return names.sort().map((name) => {
    let title = name;
    try {
      const manifest = JSON.parse(readFileSync(join(root, name, "schema.json"), "utf8"));
      if (typeof manifest?.title === "string" && manifest.title.trim()) title = manifest.title;
    } catch {
      // No root manifest, or not JSON — the folder name is the title.
    }
    return { folder: FOLDERS, file: name, name: title, kind: "architecture", nodes: 0, updated: statSync(join(root, name)).mtimeMs };
  });
}

/**
 * A tree as the `FileMap` the client hands to `importFolder`: relative path
 * → text, the same files and limits the Node adapter reads.
 */
function readFolderMap(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!FOLDER_SKIP.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile() || !FOLDER_FILE.test(entry.name) || statSync(full).size > FOLDER_MAX_BYTES) continue;
      files[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return files;
}

/**
 * The linked folders that exist, each with the id the route and the client's
 * bindings know it by: `linked-<name>-<hash of the path>`. Hashing the path
 * keeps the id the same across restarts however the list is ordered, and
 * keeps two folders that share a name apart. A folder that is not there is
 * skipped with a warning — the app never creates folders outside the repo.
 */
function linkFolders(paths, logger) {
  const home = homedir();
  const linked = [];
  for (const path of paths) {
    const dir = resolve(path);
    if (linked.some((l) => l.dir === dir)) continue;
    const display = dir === home || dir.startsWith(home + sep) ? `~${dir.slice(home.length)}` : dir;
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      // missing — reported below
    }
    if (!isDir) {
      logger.warn(`  ➜  templates:  linked folder ${display} is not a directory — skipped`, { timestamp: true });
      continue;
    }
    const name = basename(dir);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "folder";
    const hash = createHash("sha1").update(dir).digest("hex").slice(0, 6);
    linked.push({ folder: `${LINKED_PREFIX}${slug}-${hash}`, name, dir, display });
  }
  return linked;
}

/**
 * @param {{ scratch: string, examples: string, folders?: string, linked?: string[] }} dirs
 *   absolute folder paths; `linked` lists the folders outside the repo
 */
export function templatesPlugin(dirs) {
  const { linked: linkedPaths = [], ...repoDirs } = dirs;
  return {
    name: "better-diagrams-templates",
    configureServer(server) {
      // Both watched folders exist before the watcher is pointed at them — a
      // fresh BD_TEMPLATES_DIR (the e2e suite's) starts with neither.
      mkdirSync(repoDirs.scratch, { recursive: true });
      mkdirSync(repoDirs.examples, { recursive: true });

      const linked = linkFolders(linkedPaths, server.config.logger);
      const linkedIds = new Set(linked.map((l) => l.folder));
      /** Every folder the route can address, by the id it is addressed with. */
      const folderDirs = { ...repoDirs, ...Object.fromEntries(linked.map((l) => [l.folder, l.dir])) };
      /** Folders the app may write a file it opened back to. Deleting stays scratch-only. */
      const savable = new Set([...IN_REPO, ...linkedIds]);

      /** path → the exact text this server last wrote there, so its own writes are not announced. */
      const lastWritten = new Map();
      const pending = new Map();
      const watched = [...savable].filter((folder) => folderDirs[folder]);
      const folderOf = (full) =>
        watched.find(
          (folder) => resolve(full).startsWith(resolve(folderDirs[folder]) + sep) && !relative(folderDirs[folder], full).includes(sep),
        );
      const announce = (full) => {
        const folder = folderOf(full);
        if (!folder || !full.endsWith(".json")) return;
        clearTimeout(pending.get(full));
        pending.set(
          full,
          setTimeout(() => {
            pending.delete(full);
            let text;
            try {
              text = readFileSync(full, "utf8");
            } catch {
              return; // gone again (an editor's temp file, a delete) — nothing to load
            }
            if (lastWritten.get(full) === text) return; // our own save
            lastWritten.delete(full);
            server.ws.send({ type: "custom", event: CHANGE_EVENT, data: { folder, file: relative(folderDirs[folder], full) } });
          }, SETTLE_MS),
        );
      };
      server.watcher.add(watched.map((folder) => folderDirs[folder]));
      server.watcher.on("change", announce);
      server.watcher.on("add", announce);

      server.middlewares.use(ROUTE, async (req, res) => {
        try {
          // Inside `use(prefix, …)` the prefix is already stripped: "/" lists
          // every folder, "/<folder>/name.json" addresses one file. Decoding
          // lives inside the try: a malformed escape throws, and an async
          // handler that throws before its try block leaves the request
          // hanging rather than answered.
          const path = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");

          if (req.method === "GET" && !path) {
            return json(res, 200, {
              dirs: repoDirs,
              linked,
              templates: [
                ...listFolder(folderDirs, "examples"),
                ...listFolder(folderDirs, WRITABLE),
                ...listFolders(repoDirs),
                ...linked.flatMap((l) => listFolder(folderDirs, l.folder)),
              ],
            });
          }

          const [folder, name, extra] = path.split("/");
          // A folder-format tree is served whole, as a file map, read-only.
          if (folder === FOLDERS && req.method === "GET") {
            const root = repoDirs[FOLDERS];
            if (!root || !name || extra || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
              return json(res, 400, { error: `Bad folder path: ${path}` });
            }
            const full = resolve(root, name);
            if (!full.startsWith(resolve(root) + sep)) return json(res, 400, { error: `Bad folder path: ${path}` });
            return json(res, 200, { name, files: readFolderMap(full) });
          }
          const full = !extra ? safePath(folderDirs, folder, name ?? "") : null;
          if (!full) return json(res, 400, { error: `Bad template path: ${path}` });

          if (req.method === "GET") {
            return json(res, 200, JSON.parse(readFileSync(full, "utf8")));
          }
          // Writes go to scratch, or back to an example or linked file the app
          // opened (the client only sends one there for a file bound to it).
          // Deleting is scratch-only: closing a file in the app must never
          // remove a tracked example from the repo, or anything outside it.
          if (req.method === "PUT") {
            if (!savable.has(folder)) return json(res, 403, { error: `${folder}/ is read-only` });
            if (linkedIds.has(folder)) {
              // Outside the repo, write only over a diagram: never over a
              // package.json, and never over a diagram caught half-saved by
              // its editor (the app tries again; the finished save reloads).
              let onDisk;
              try {
                onDisk = JSON.parse(readFileSync(full, "utf8"));
              } catch (error) {
                if (error?.code !== "ENOENT") onDisk = null;
              }
              if (onDisk !== undefined && !isDiagram(onDisk)) {
                return json(res, 409, { error: `${name} is not a diagram — not writing over it` });
              }
            } else {
              // The folder can vanish under a running server (a `git clean`, a
              // stray `rm -rf`); recreate it rather than failing every write
              // until someone restarts vite.
              mkdirSync(folderDirs[folder], { recursive: true });
            }
            const body = await readBody(req);
            // Parse before writing: a malformed body should fail loudly here
            // rather than land a broken file on disk.
            const doc = JSON.parse(body);
            const text = `${JSON.stringify(doc, null, 2)}\n`;
            lastWritten.set(full, text);
            writeFileSync(full, text, "utf8");
            return json(res, 200, { ok: true, folder, file: name });
          }
          if (folder !== WRITABLE) {
            return json(res, 403, { error: `${folder}/ is never deleted by the app; only ${WRITABLE}/ is` });
          }
          if (req.method === "DELETE") {
            rmSync(full, { force: true });
            return json(res, 200, { ok: true, folder, file: name });
          }
          res.statusCode = 405;
          return res.end("Method not allowed");
        } catch (error) {
          return json(res, 500, { error: String(error?.message ?? error) });
        }
      });
      const linkedLog = linked.map((l) => `, ${l.display} (linked)`).join("");
      server.config.logger.info(
        `  ➜  templates:  ${repoDirs.examples} (examples), ${repoDirs.scratch} (scratch, auto-save)${repoDirs.folders ? `, ${repoDirs.folders} (folders)` : ""}${linkedLog}`,
        { timestamp: true },
      );
    },
  };
}
