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
 *   linked     — folders OUTSIDE the repo, for a diagram that lives with
 *                another project: named in `BD_LINKED_DIRS` (see
 *                vite.config.js), or linked from the app's menu — the
 *                server shows the system's folder dialog, since a browser's
 *                own picker never says where a folder is — and kept in the
 *                links file across restarts. Treated like examples/ —
 *                written only back to a file the app opened, never deleted —
 *                and more warily: a missing folder is reported, never
 *                recreated (the app offers a re-link), and a JSON file that
 *                is not a diagram (a package.json, a tsconfig) is listed as
 *                unreadable and never written over.
 *   symlinks/  — ONE file from another folder, rather than the whole folder:
 *                the app's Link a file… shows the system's file dialog and
 *                symlinks the pick in here. Writes go through the link to
 *                the file itself, the file itself is watched, and
 *                unlinking removes only the link. Git-ignored.
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
import { exec, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const ROUTE = "/__templates";

/** The folder auto-save owns: written, renamed and deleted by the app. */
const WRITABLE = "scratch";
/** Folders inside the repo the app may write a file it opened back to. Deleting stays scratch-only. */
const IN_REPO = [WRITABLE, "examples"];
/** Every linked folder's id starts with this — the client tells them apart by it (templates.js). */
const LINKED_PREFIX = "linked-";
/** The route segment that links and unlinks folders: `/__templates/links`. */
const LINKS = "links";
/** The folder of symlinks to single files elsewhere — and the route segment that makes and removes them. */
const SYMLINKS = "symlinks";
/** The HMR event an outside edit is announced with (see templates.js). */
const CHANGE_EVENT = "better-diagrams:template";
/** The HMR event a linked folder vanishing (or coming back) is announced with. */
const LINKS_EVENT = "better-diagrams:links";
/** Editors save in bursts (truncate, write, rename); announce once it settles. */
const SETTLE_MS = 120;
/** A diagram is never megabytes: the most a save takes, or a listing reads. */
const MAX_BYTES = 5_000_000;
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
      if (size > MAX_BYTES) {
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
  // A linked folder can hold a package-lock.json of many megabytes; it is
  // listed on every menu open, so don't parse one. (A save is capped the same.)
  if (statSync(join(dir, file)).size > MAX_BYTES) return unreadable(folder, file, "too large to be a diagram");
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

/** Where the symlink at `full` points, as an absolute path — null when it is no symlink. */
function linkTarget(full) {
  try {
    return lstatSync(full).isSymbolicLink() ? resolve(dirname(full), readlinkSync(full)) : null;
  } catch {
    return null;
  }
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
    // A symlink says where it points, so the menu can — and one whose file
    // has moved says that, rather than "not readable".
    const target = linkTarget(join(dir, file));
    const pointsAt = target ? { target: displayOf(target) } : {};
    if (target && !existsSync(target)) {
      listed.push({ ...unreadable(folder, file, `links to ${displayOf(target)}, which is missing`), ...pointsAt });
      continue;
    }
    // One unreadable file must not take the whole list down — hand-edited
    // JSON is exactly what these folders invite.
    try {
      listed.push({ ...describe(dir, folder, file), ...pointsAt });
    } catch {
      listed.push({ ...unreadable(folder, file, "not readable as JSON"), ...pointsAt });
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

/** Is there a directory at `path` right now? */
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `~/work` → `/Users/you/work`: a typed path, or a quoted env value, arrives unexpanded. */
const expandHome = (path) => path.replace(/^~(?=$|[/\\])/, homedir());

/** `/Users/you/work` → `~/work`, for logs and the menu. */
function displayOf(dir) {
  const home = homedir();
  return dir === home || dir.startsWith(home + sep) ? `~${dir.slice(home.length)}` : dir;
}

/**
 * A linked folder, with the id the route and the client's bindings know it
 * by: `linked-<name>-<hash of the path>`. Hashing the path keeps the id the
 * same across restarts however the folders are listed, and keeps two folders
 * that share a name apart. `source` says where the link came from: `env`
 * (BD_LINKED_DIRS) or `saved` (linked from the app, kept in the links file).
 */
function makeLink(path, source) {
  const dir = resolve(expandHome(path));
  const name = basename(dir);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "folder";
  const hash = createHash("sha1").update(dir).digest("hex").slice(0, 6);
  return { folder: `${LINKED_PREFIX}${slug}-${hash}`, name, dir, display: displayOf(dir), source };
}

/** The folders linked from the app on an earlier run. A missing or broken file is no links. */
function readSavedLinks(file) {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"))?.linked;
    return Array.isArray(saved) ? saved.filter((dir) => typeof dir === "string") : [];
  } catch {
    return [];
  }
}

/** The nearest folder that exists at or above `path` — where a re-link's dialog opens. */
function nearestDir(path) {
  let dir = resolve(expandHome(path));
  while (!isDir(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return dir;
}

/** The dialog waits on a person; give up only on one long since walked away from. */
const PICK_TIMEOUT_MS = 10 * 60_000;

/**
 * The command standing in for each dialog — the e2e suite's, since no dialog
 * can be clicked in a headless run. It prints the path it "picked".
 */
const STAND_IN = { folder: "BD_FOLDER_PICKER", file: "BD_FILE_PICKER" };

/** Can this server show a folder (or file) dialog? */
const canPick = (what = "folder") => Boolean(process.env[STAND_IN[what]]) || platform() === "darwin" || platform() === "linux";

const appleString = (text) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Ask for a folder, or a diagram's `.json` file, with the operating system's
 * own dialog. A browser's pickers never tell the page where a folder or file
 * IS — but this server runs on the same machine as the person using it, so it
 * can ask instead and get a real path back. Resolves to `{ path }`,
 * `{ cancelled: true }`, or `{ unsupported: true }` where there is no dialog
 * to show (the client then asks for a typed path, or says so).
 */
function pick(what, { prompt, near }) {
  const start = near ? nearestDir(near) : null;
  const run = (command, args) =>
    new Promise((done) => {
      const finish = (error, stdout, stderr) => done({ error, stdout: String(stdout ?? "").trim(), stderr: String(stderr ?? "") });
      if (args) execFile(command, args, { timeout: PICK_TIMEOUT_MS }, finish);
      else exec(command, { timeout: PICK_TIMEOUT_MS }, finish);
    });
  const picked = ({ error, stdout }, cancelled) => {
    if (error) {
      if (cancelled(error)) return { cancelled: true };
      throw new Error(`The ${what} dialog failed: ${error.message}`);
    }
    return stdout ? { path: stdout } : { cancelled: true };
  };

  const standIn = process.env[STAND_IN[what]];
  if (standIn) return run(standIn).then((r) => picked(r, () => false));
  if (platform() === "darwin") {
    // `activate` brings osascript's own dialog to the front — it would
    // otherwise open behind the browser that asked for it.
    const location = start ? ` default location (POSIX file ${appleString(start)})` : "";
    const script =
      what === "file"
        ? `POSIX path of (choose file with prompt ${appleString(prompt)} of type {"public.json"}${location})`
        : `POSIX path of (choose folder with prompt ${appleString(prompt)}${location})`;
    return run("osascript", ["-e", "activate", "-e", script]).then((r) =>
      picked({ ...r, stdout: r.stdout.replace(/(.)\/$/, "$1") }, () => /-128/.test(r.stderr)),
    );
  }
  if (platform() === "linux") {
    const kind = what === "file" ? ["--file-filter=Diagram JSON | *.json"] : ["--directory"];
    return run("zenity", ["--file-selection", ...kind, `--title=${prompt}`, ...(start ? [`--filename=${start}/`] : [])]).then((r) =>
      r.error?.code === "ENOENT" ? { unsupported: true } : picked(r, (error) => error.code === 1),
    );
  }
  return Promise.resolve({ unsupported: true });
}

/** A file name a symlink can carry and the route will address: `My plan (v2).json` → `My plan -v2-.json`. */
function linkName(file) {
  const stem = basename(file, ".json")
    .replace(/[^A-Za-z0-9 ._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return stem || "diagram";
}

/** Is anything at `path` — a file, a folder, or a link, dangling or not? */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** `realpath`, or the resolved path itself when there is nothing there to resolve. */
function realOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * @param {{ scratch: string, examples: string, folders?: string, symlinks?: string }} repoDirs absolute folder paths
 * @param {{ linked?: string[], linksFile?: string }} [options] `linked`: folders outside the
 *   repo to link (BD_LINKED_DIRS); `linksFile`: where folders linked from the app are kept
 */
export function templatesPlugin(repoDirs, { linked: linkedPaths = [], linksFile } = {}) {
  return {
    name: "better-diagrams-templates",
    configureServer(server) {
      const { logger } = server.config;
      // Both watched folders exist before the watcher is pointed at them — a
      // fresh BD_TEMPLATES_DIR (the e2e suite's) starts with neither.
      mkdirSync(repoDirs.scratch, { recursive: true });
      mkdirSync(repoDirs.examples, { recursive: true });
      if (repoDirs.symlinks) mkdirSync(repoDirs.symlinks, { recursive: true });

      /** id → linked folder. Links come and go while the server runs: Link a folder…, Re-link…, Unlink. */
      const links = new Map();
      /** Every folder the route can address, by the id it is addressed with. */
      const folderDirs = { ...repoDirs };
      /** Folders the app may write a file it opened back to. Deleting stays scratch-only, but for a symlink. */
      const savable = new Set(repoDirs.symlinks ? [...IN_REPO, SYMLINKS] : IN_REPO);
      /**
       * Folders this server has asked the watcher for. Never UNwatched:
       * chokidar's unwatch puts a path on an ignore list for good, which would
       * blind Vite's own HMR too were a linked folder inside its root. An
       * unlinked folder's events are dropped by `folderOf` instead.
       */
      const watchedDirs = new Set();
      const watch = (dir) => {
        if (watchedDirs.has(dir) || !isDir(dir)) return;
        server.watcher.add(dir);
        watchedDirs.add(dir);
      };
      /** Link a folder, or hand back the link it already has (BD_LINKED_DIRS's wins over a saved one). */
      const addLink = (path, source) => {
        const link = makeLink(path, source);
        const known = links.get(link.folder);
        if (known) {
          watch(known.dir); // a folder that was missing and is back
          return known;
        }
        links.set(link.folder, link);
        folderDirs[link.folder] = link.dir;
        savable.add(link.folder);
        watch(link.dir);
        return link;
      };
      const removeLink = (id) => {
        const link = links.get(id);
        links.delete(id);
        delete folderDirs[id];
        savable.delete(id);
      };
      const saveLinks = () => {
        if (!linksFile) return;
        const saved = [...links.values()].filter((l) => l.source === "saved").map((l) => l.dir);
        const about = "Folders linked from Settings → Templates → Link a folder…; git-ignored. BD_LINKED_DIRS adds more.";
        writeFileSync(linksFile, `${JSON.stringify({ about, linked: saved }, null, 2)}\n`, "utf8");
      };
      for (const path of linkedPaths) addLink(path, "env");
      if (linksFile) for (const path of readSavedLinks(linksFile)) addLink(path, "saved");
      for (const link of links.values()) {
        if (!isDir(link.dir)) {
          logger.warn(`  ➜  templates:  linked folder ${link.display} is missing — its files can't sync until it's back or re-linked`, {
            timestamp: true,
          });
        }
      }

      /**
       * A symlinked file's real path → its link in symlinks/. The watcher is
       * pointed at each file itself, wherever it lives, and reports changes
       * by that path; this is how one is told back to the app as the link
       * it opened. Re-read on every listing, so a link made by hand counts.
       */
      const symlinkOf = new Map();
      const trackSymlinks = () => {
        symlinkOf.clear();
        if (!repoDirs.symlinks) return;
        let names;
        try {
          names = readdirSync(repoDirs.symlinks).filter((f) => f.endsWith(".json"));
        } catch {
          return;
        }
        for (const name of names) {
          const full = join(repoDirs.symlinks, name);
          const target = linkTarget(full);
          if (!target || !existsSync(target)) continue;
          const real = realOrResolved(target);
          symlinkOf.set(real, full);
          if (!watchedDirs.has(real)) {
            server.watcher.add(real);
            watchedDirs.add(real);
          }
        }
      };
      trackSymlinks();

      /** Everything the menu lists, and the folders it lists them under. */
      const listing = () => {
        trackSymlinks();
        return {
          dirs: repoDirs,
          linked: [...links.values()].map((l) => {
            watch(l.dir); // one that was missing and is back is watched again
            return { ...l, missing: !isDir(l.dir) };
          }),
          picker: canPick("folder"),
          filePicker: Boolean(repoDirs.symlinks) && canPick("file"),
          templates: [
            ...listFolder(folderDirs, "examples"),
            ...listFolder(folderDirs, WRITABLE),
            ...listFolders(repoDirs),
            ...(repoDirs.symlinks ? listFolder(folderDirs, SYMLINKS) : []),
            ...[...links.keys()].flatMap((id) => listFolder(folderDirs, id)),
          ],
        };
      };

      /**
       * Link one diagram file from another folder: a symlink to it in
       * symlinks/, named after it. Resolves to `{ entry }`, the listing row
       * the app opens; or `{ error }`. A file the menu already lists — in
       * examples/, a linked folder, or linked before — is handed back as it
       * is, never linked twice.
       */
      const linkFile = (path) => {
        const full = resolve(expandHome(path));
        const shown = displayOf(full);
        let real;
        try {
          real = realpathSync(full);
        } catch {
          return { error: `${shown} isn't there` };
        }
        if (!statSync(real).isFile()) return { error: `${shown} isn't a file` };
        if (!real.endsWith(".json")) return { error: `${shown} isn't a .json file` };
        if (statSync(real).size > MAX_BYTES) return { error: `${shown} is too large to be a diagram` };
        let doc;
        try {
          doc = JSON.parse(readFileSync(real, "utf8"));
        } catch {
          return { error: `${shown} isn't valid JSON` };
        }
        if (!isDiagram(doc)) return { error: `${shown} is JSON, but not a diagram` };

        trackSymlinks();
        const linkedAs = symlinkOf.get(real);
        if (linkedAs) return { entry: listFolder(folderDirs, SYMLINKS).find((t) => t.file === basename(linkedAs)) };
        const home = Object.entries(folderDirs).find(
          ([folder, dir]) => folder !== FOLDERS && folder !== SYMLINKS && realOrResolved(dir) === dirname(real),
        );
        if (home) {
          const entry = listFolder(folderDirs, home[0]).find((t) => t.file === basename(real));
          if (entry && entry.kind !== "unreadable") return { entry };
        }
        const root = realOrResolved(dirname(repoDirs.symlinks));
        if (real.startsWith(root + sep)) return { error: `${shown} is already under Templates` };

        // Named after the file; a name another link holds gets a number.
        const stem = linkName(real);
        let name = `${stem}.json`;
        for (let n = 2; lstatOrNull(join(repoDirs.symlinks, name)); n++) name = `${stem}-${n}.json`;
        try {
          symlinkSync(full, join(repoDirs.symlinks, name));
        } catch (error) {
          // Windows makes links only with Developer Mode on (or as admin).
          return { error: `Couldn't make the link: ${error.message}` };
        }
        trackSymlinks();
        return { entry: listFolder(folderDirs, SYMLINKS).find((t) => t.file === name) };
      };

      /** path → the exact text this server last wrote there, so its own writes are not announced. */
      const lastWritten = new Map();
      const pending = new Map();
      const folderOf = (full) =>
        [...savable].find(
          (folder) => resolve(full).startsWith(resolve(folderDirs[folder]) + sep) && !relative(folderDirs[folder], full).includes(sep),
        );
      const announce = (path) => {
        // A symlinked file changed where it lives: it is the link that the
        // app opened, and the link that the app wrote through.
        const full = symlinkOf.get(resolve(path)) ?? path;
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
            // Looked up again: the folder may have been unlinked meanwhile.
            if (!folderDirs[folder]) return;
            server.ws.send({ type: "custom", event: CHANGE_EVENT, data: { folder, file: relative(folderDirs[folder], full) } });
          }, SETTLE_MS),
        );
      };
      for (const folder of IN_REPO) watch(folderDirs[folder]);
      server.watcher.on("change", announce);
      server.watcher.on("add", announce);
      // A linked folder moved, renamed or deleted under the running server:
      // tell the app, which re-lists and offers a re-link. It is added to
      // the watcher again once it is back (see `listing`).
      server.watcher.on("unlinkDir", (path) => {
        const link = [...links.values()].find((l) => l.dir === resolve(path));
        if (!link) return;
        watchedDirs.delete(link.dir); // added again once it is back
        server.ws.send({ type: "custom", event: LINKS_EVENT, data: { folder: link.folder } });
      });
      // The same for a symlinked file moved or deleted where it lives: the
      // app re-lists, and the menu shows its link as missing.
      server.watcher.on("unlink", (path) => {
        const link = symlinkOf.get(resolve(path));
        if (!link) return;
        watchedDirs.delete(resolve(path)); // added again once it is back
        server.ws.send({ type: "custom", event: LINKS_EVENT, data: { folder: SYMLINKS, file: basename(link) } });
      });

      server.middlewares.use(ROUTE, async (req, res) => {
        try {
          // Inside `use(prefix, …)` the prefix is already stripped: "/" lists
          // every folder, "/<folder>/name.json" addresses one file. Decoding
          // lives inside the try: a malformed escape throws, and an async
          // handler that throws before its try block leaves the request
          // hanging rather than answered.
          const path = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");

          if (req.method === "GET" && !path) return json(res, 200, listing());

          const [folder, name, extra] = path.split("/");
          // Linking from the app. POST { dir } links a typed path; POST
          // { pick: true, near? } asks with the system's folder dialog,
          // opening near where a lost folder used to be. `replaces` names a
          // link this one takes over from (a re-link) — dropped if it was
          // saved; one from BD_LINKED_DIRS stays until the env says otherwise.
          if (folder === LINKS) {
            if (req.method === "POST" && !name) {
              // JSON only: a page on another site can send a text/plain POST
              // without a CORS preflight, and must not get to link folders
              // or open dialogs on this machine. JSON forces the preflight,
              // which Vite refuses for any origin but localhost.
              if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
                return json(res, 415, { error: "Send the link as application/json" });
              }
              const body = JSON.parse((await readBody(req)) || "{}");
              let dir = typeof body.dir === "string" ? body.dir.trim() : "";
              if (body.pick) {
                const prompt = body.replaces ? "Pick the folder that holds the diagram now" : "Pick a folder of diagram JSON to link";
                const picked = await pick("folder", { prompt, near: typeof body.near === "string" ? body.near : undefined });
                if (!picked.path) return json(res, 200, picked);
                dir = picked.path;
              }
              if (!dir) return json(res, 400, { error: "No folder given" });
              const full = resolve(expandHome(dir));
              if (!isDir(full)) return json(res, 400, { error: `${displayOf(full)} isn't a folder` });
              if (Object.values(repoDirs).some((d) => full === resolve(d) || full.startsWith(resolve(d) + sep))) {
                return json(res, 400, { error: `${displayOf(full)} is already under Templates` });
              }
              const link = addLink(full, "saved");
              const old = typeof body.replaces === "string" ? links.get(body.replaces) : undefined;
              if (old && old.source === "saved" && old.folder !== link.folder) removeLink(old.folder);
              saveLinks();
              return json(res, 200, { link, ...listing() });
            }
            if (req.method === "DELETE" && name && !extra) {
              const link = links.get(name);
              if (!link) return json(res, 404, { error: `No linked folder ${name}` });
              if (link.source !== "saved") {
                return json(res, 409, { error: `${link.display} is linked by BD_LINKED_DIRS — unlink it there` });
              }
              removeLink(name);
              saveLinks();
              return json(res, 200, { ok: true, ...listing() });
            }
            res.statusCode = 405;
            return res.end("Method not allowed");
          }
          // Linking one file. POST { path } links a typed path; POST
          // { pick: true } asks with the system's file dialog. JSON only, for
          // the same reason as a folder link.
          if (folder === SYMLINKS && !name && req.method === "POST") {
            if (!repoDirs.symlinks) return json(res, 404, { error: "This server links no files" });
            if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
              return json(res, 415, { error: "Send the link as application/json" });
            }
            const body = JSON.parse((await readBody(req)) || "{}");
            let path = typeof body.path === "string" ? body.path.trim() : "";
            if (body.pick) {
              const picked = await pick("file", { prompt: "Pick a diagram JSON file to link", near: path || undefined });
              if (!picked.path) return json(res, 200, picked);
              path = picked.path;
            }
            if (!path) return json(res, 400, { error: "No file given" });
            const linked = linkFile(path);
            if (!linked.entry) return json(res, 400, { error: linked.error ?? `Couldn't link ${path}` });
            return json(res, 200, { entry: linked.entry, ...listing() });
          }
          // Unlinking one: removes the link and never the file it points at
          // — nor a plain file someone put in symlinks/ by hand.
          if (folder === SYMLINKS && req.method === "DELETE" && name && !extra) {
            const full = safePath(folderDirs, SYMLINKS, name);
            if (!full) return json(res, 400, { error: `Bad template path: ${path}` });
            if (!lstatOrNull(full)?.isSymbolicLink()) return json(res, 409, { error: `${name} isn't a link — not deleting it` });
            unlinkSync(full);
            return json(res, 200, { ok: true, ...listing() });
          }
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
            const link = links.get(folder);
            const pointsAt = folder === SYMLINKS ? linkTarget(full) : null;
            // Nor write a symlinked file back where it used to be: the
            // menu shows its link as missing instead.
            if (pointsAt && !existsSync(pointsAt)) {
              return json(res, 404, { error: "missing — moved or deleted", missing: true });
            }
            if (link || folder === SYMLINKS) {
              // Outside the repo, never recreate a folder that has gone (it
              // was moved, or a drive unmounted): the app offers a re-link.
              if (link && !isDir(link.dir)) return json(res, 404, { error: `${link.display} is missing`, missing: true });
              // And write only over a diagram: never over a package.json,
              // and never over a diagram caught half-saved by its editor
              // (the app tries again; the finished save reloads).
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
      const linkedLog = [...links.values()].map((l) => `, ${l.display} (linked)`).join("");
      logger.info(
        `  ➜  templates:  ${repoDirs.examples} (examples), ${repoDirs.scratch} (scratch, auto-save)${repoDirs.folders ? `, ${repoDirs.folders} (folders)` : ""}${repoDirs.symlinks ? `, ${repoDirs.symlinks} (symlinks)` : ""}${linkedLog}`,
        { timestamp: true },
      );
    },
  };
}
