/**
 * vite-plugin-templates.js — the disk store behind auto-save.
 *
 * The editor keeps its workspace in localStorage, which is fine for a browser
 * but invisible everywhere else: you cannot read it, diff it, or commit it. A
 * few lines of dev middleware turn every open document into a real `.json`
 * file, so the diagrams you make while developing are ordinary files —
 * greppable, reviewable, and loadable back into the app.
 *
 * Two folders, two jobs:
 *
 *   scratch/   — where auto-save WRITES. Every open file lands here as you
 *                work, and every session rewrites it. Git-ignored, because a
 *                folder that changes on every keystroke has no business in
 *                `git status`.
 *   examples/  — curated, tracked, READ-ONLY to this route. Drop a template
 *                in by hand (or promote one from scratch) and it is listed and
 *                loadable; nothing the app does can overwrite or delete it.
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
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROUTE = "/__templates";

/** The folder the app may write to. The other is read-only by construction. */
const WRITABLE = "scratch";

/**
 * A path we are willing to touch: a known folder, a plain slug for the file,
 * and — belt and braces against `..` games — a resolved path still inside
 * that folder.
 */
function safePath(dirs, folder, name) {
  const dir = dirs[folder];
  if (!dir) return null;
  if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(name)) return null;
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
 * What the dropdown needs to list a file without opening it: its name, which
 * editor can render it, where it lives, and when it last changed. The kind is
 * sniffed from the document's own shape — the same rule the welcome modal
 * uses on pasted JSON — so the files stay plain templates with nothing this
 * app invented in them.
 */
function describe(dir, folder, file) {
  const raw = readFileSync(join(dir, file), "utf8");
  const doc = JSON.parse(raw);
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
      listed.push({ folder, file, name: file, kind: "unreadable", nodes: 0, updated: 0 });
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

/** @param {{ scratch: string, examples: string, folders?: string }} dirs absolute folder paths */
export function templatesPlugin(dirs) {
  return {
    name: "better-diagrams-templates",
    configureServer(server) {
      mkdirSync(dirs.scratch, { recursive: true });
      server.middlewares.use(ROUTE, async (req, res) => {
        try {
          // Inside `use(prefix, …)` the prefix is already stripped: "/" lists
          // both folders, "/<folder>/name.json" addresses one file. Decoding
          // lives inside the try: a malformed escape throws, and an async
          // handler that throws before its try block leaves the request
          // hanging rather than answered.
          const path = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");

          if (req.method === "GET" && !path) {
            return json(res, 200, {
              dirs,
              templates: [...listFolder(dirs, "examples"), ...listFolder(dirs, WRITABLE), ...listFolders(dirs)],
            });
          }

          const [folder, name, extra] = path.split("/");
          // A folder-format tree is served whole, as a file map, read-only.
          if (folder === FOLDERS && req.method === "GET") {
            const root = dirs[FOLDERS];
            if (!root || !name || extra || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
              return json(res, 400, { error: `Bad folder path: ${path}` });
            }
            const full = resolve(root, name);
            if (!full.startsWith(resolve(root) + sep)) return json(res, 400, { error: `Bad folder path: ${path}` });
            return json(res, 200, { name, files: readFolderMap(full) });
          }
          const full = !extra ? safePath(dirs, folder, name ?? "") : null;
          if (!full) return json(res, 400, { error: `Bad template path: ${path}` });

          if (req.method === "GET") {
            return json(res, 200, JSON.parse(readFileSync(full, "utf8")));
          }
          // Only scratch takes writes. A curated example is edited by a person
          // in an editor, not by auto-save catching a workspace file that
          // happened to share its name.
          if (folder !== WRITABLE) {
            return json(res, 403, { error: `${folder}/ is read-only; auto-save writes to ${WRITABLE}/` });
          }
          if (req.method === "PUT") {
            // The folder can vanish under a running server (a `git clean`, a
            // stray `rm -rf`); recreate it rather than failing every write
            // until someone restarts vite.
            mkdirSync(dirs[WRITABLE], { recursive: true });
            const body = await readBody(req);
            // Parse before writing: a malformed body should fail loudly here
            // rather than land a broken file on disk.
            const doc = JSON.parse(body);
            writeFileSync(full, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
            return json(res, 200, { ok: true, folder, file: name });
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
      server.config.logger.info(`  ➜  templates:  ${dirs.examples} (examples), ${dirs.scratch} (scratch, auto-save)${dirs.folders ? `, ${dirs.folders} (folders)` : ""}`, {
        timestamp: true,
      });
    },
  };
}
