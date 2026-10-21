/**
 * store.ts — the disk store behind the editor's live files.
 *
 * An editor in a browser keeps its workspace in localStorage, which is fine
 * for a browser but invisible everywhere else: you cannot read it, diff it,
 * or commit it. This route turns every open document into a real `.json`
 * file, so the diagrams you make are ordinary files — greppable, reviewable,
 * and committed beside the code they describe.
 *
 * Four kinds of folder:
 *
 *   scratch/   — where auto-save writes a file that has no other home. Every
 *                file made in the app lands here as you work.
 *   examples/  — curated and tracked. Listed and loadable; written ONLY when
 *                you opened that file in the app and edited it there — the
 *                client binds a workspace file to the file it was opened
 *                from, so auto-save never lands in examples/ by name
 *                collision. Never deleted by the app.
 *   linked     — folders elsewhere, for diagrams that live with another
 *                project: named when the store is made (BD_LINKED_DIRS, the
 *                command line), or linked from the app's menu — the server
 *                shows the system's folder dialog, since a browser's own
 *                picker never says where a folder is — and kept in the links
 *                file across restarts. Listed at any depth (see scan.ts) and
 *                treated like examples/ — written only back to a file the app
 *                opened, never deleted — and more warily: a missing folder is
 *                reported, never recreated (the app offers a re-link), a JSON
 *                file that is not a diagram (a package.json, a tsconfig) is
 *                left out of the listing and never written over, and nothing
 *                is written outside the folder.
 *   symlinks/  — ONE file from another folder, rather than the whole folder:
 *                the app's Link a file… shows the system's file dialog and
 *                symlinks the pick in here, and New file on disk… and Save
 *                as… do the same for a file they write. Writes go through the link to the file
 *                itself, the file itself is watched, and unlinking removes
 *                only the link. A link answers to the file it pointed at when
 *                a page bound to it: a page that names another (the link was
 *                remade under the same name for a different file) is refused
 *                rather than handed that file.
 *
 * And all are WATCHED: a file changed by another program (an editor, a
 * script, an AI agent) is announced to the open app, and the app reloads it —
 * the file on disk wins. The store's own writes are not announced back, so a
 * save from the app never bounces into a reload of itself.
 *
 * Every write is atomic (files.ts) and formatted the way the repo it lands in
 * formats JSON (format.ts).
 *
 * A LOCAL tool, deliberately: it reads and writes files and shows dialogs on
 * the machine it runs on, for a page served from that machine. The Vite dev
 * server mounts it (`configureServer` runs for `vite dev` and nowhere else);
 * `better-diagrams` runs it on its own, on 127.0.0.1 only.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { createEventHub, type EventHub } from "./events";
import {
  displayOf,
  expandHome,
  isDir,
  isFile,
  isInside,
  linkTarget,
  lstatOrNull,
  realOrResolved,
  writeFileAtomic,
} from "./files";
import { formatDiagram } from "./format";
import { canPick, pick } from "./pick";
import { isSkippedPath, scanFolder } from "./scan";
import { createFsWatcher, type DiskWatcher, type FsWatcher } from "./watch";

/** Where the route lives. Not `/api/…`: a host proxies that to its AI server. */
export const DISK_ROUTE = "/__templates";
/** The event an outside edit is announced with: `{ folder, file }`. */
export const CHANGE_EVENT = "better-diagrams:template";
/** The event a linked folder (or a symlinked file) vanishing, or coming back, is announced with. */
export const LINKS_EVENT = "better-diagrams:links";

/** The folder auto-save owns: written, renamed and deleted by the app. */
const WRITABLE = "scratch";
/** Every linked folder's id starts with this — the client tells them apart by it. */
export const LINKED_PREFIX = "linked-";
/** The folder of symlinks to single files elsewhere — and the route segment that makes and removes them. */
const SYMLINKS = "symlinks";
/** The folder-format root: one subdirectory per tree, served read-only. */
const FOLDERS = "folders";
/** Route segments that are not folders. */
const LINKS = "links";
const SAVE_AS = "save-as";
const EVENTS = "events";

/** Announce an outside edit once the editor writing it has settled (truncate, write, rename). */
const SETTLE_MS = 120;
/** A diagram is never megabytes: the most a save takes, or a listing reads. */
const MAX_BYTES = 5_000_000;
/** A file name the route will address. Names are not held to the slug the client writes with. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*\.json$/;
/** A folder on the way to a file in a linked folder: no separators, no leading dot. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9 ._-]*$/;
/** JSON that didn't parse but reads like a diagram someone broke — listed, so they find it. */
const LOOKS_LIKE_DIAGRAM = /"(nodes|participants)"\s*:/;

const FOLDER_FILE = /\.(json|ya?ml|md)$/i;
const FOLDER_SKIP = new Set(["node_modules", ".git"]);

export interface DiskDirs {
  /** Auto-save's own folder. */
  scratch: string;
  /** Curated, tracked diagrams. */
  examples?: string;
  /** Folder-format trees, served read-only. */
  folders?: string;
  /** Symlinks to single files elsewhere. Without it, Link a file… and Save as… aren't offered. */
  symlinks?: string;
}

/** Where a linked folder came from: the env (BD_LINKED_DIRS), the command line, or the app's menu. */
export type LinkSource = "env" | "cli" | "saved";

export interface LinkedFolder {
  /** The id the route and the app's bindings know it by: `linked-<name>-<hash of the path>`. */
  folder: string;
  name: string;
  dir: string;
  /** `dir` as a person reads it: `~/work/tracker`. */
  display: string;
  source: LinkSource;
}

export interface TemplateEntry {
  folder: string;
  /** The file's path in its folder, `/`-separated — nested only in a linked folder. */
  file: string;
  /** The document's `meta.title`, else the file's name. */
  name: string;
  kind: "architecture" | "sequence" | "unreadable";
  nodes: number;
  updated: number;
  /** Why an `unreadable` entry can't open. */
  reason?: string;
  /** For a link in symlinks/: the file it points at, as a person reads it. */
  target?: string;
  /** For a link: its file has moved or gone. */
  missing?: boolean;
}

export interface Listing {
  dirs: DiskDirs;
  linked: Array<LinkedFolder & { missing: boolean; skipped: number; truncated: boolean }>;
  /** Can the store show a folder dialog — and a file one, Open file…'s one, and a save one? */
  picker: boolean;
  filePicker: boolean;
  openPicker: boolean;
  savePicker: boolean;
  /** The store streams its own events (Server-Sent Events at `/__templates/events`). */
  events: boolean;
  templates: TemplateEntry[];
}

export interface DiskLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface DiskStoreOptions {
  dirs: DiskDirs;
  /** Folders to link from the start. */
  linked?: string[];
  /** What those are: "env" (the default — BD_LINKED_DIRS) or "cli". */
  linkedSource?: Exclude<LinkSource, "saved">;
  /** Where folders linked from the app are kept across restarts. */
  linksFile?: string;
  /** The watcher to use — Vite's chokidar under `vite dev`. Absent, a `node:fs` one (watch.ts). */
  watcher?: DiskWatcher;
  /** How to tell the open app — Vite's HMR socket under `vite dev`. Absent, the store streams events itself. */
  notify?: (event: string, data: unknown) => void;
  logger?: DiskLogger;
  /** Where the dialogs' stand-in commands are read from (see pick.ts). */
  env?: NodeJS.ProcessEnv;
}

export type LinkFileResult = { entry: TemplateEntry } | { error: string };

/** What Open file… through the store gets back: a diagram linked, or any other file's text to read in as a copy. */
type OpenFileResult = LinkFileResult | { copy: { name: string; text: string } };

export interface DiskStore {
  /** Answer a request to the route. Resolves to false for any other URL, which is left unanswered. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Everything the app's menu lists. */
  listing(): Listing;
  /** Link one diagram file — what `better-diagrams some/file.json` opens. */
  linkFile(path: string): LinkFileResult;
  close(): void;
}

/**
 * Is this JSON a diagram at all? A linked folder is someone else's project,
 * with its package.json and tsconfig.json beside the diagram; opening one of
 * those would bind it, and the first edit would write a diagram over it.
 */
export const isDiagram = (doc: unknown): boolean => {
  const d = doc as { nodes?: unknown; participants?: unknown } | null;
  if (Array.isArray(d?.participants)) return true;
  if (!Array.isArray(d?.nodes)) return false;
  // A React Flow export has nodes too, but the editor converts one rather
  // than editing it: bound, its first save would write a diagram over it.
  const first: unknown = d.nodes[0];
  return !(first && typeof first === "object" && "position" in first);
};

/** A listing the menu shows but will not open, and why. */
const unreadable = (folder: string, file: string, reason: string): TemplateEntry => ({
  folder,
  file,
  name: file.split("/").pop() ?? file,
  kind: "unreadable",
  reason,
  nodes: 0,
  updated: 0,
});

/** A file name a symlink can carry and the route will address: `My plan (v2).json` → `My plan -v2-.json`. */
function linkName(file: string): string {
  const stem = basename(file, ".json")
    .replace(/[^A-Za-z0-9 ._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return stem || "diagram";
}

/** The folders linked from the app on an earlier run. A missing or broken file is no links. */
function readSavedLinks(file: string): string[] {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"))?.linked;
    return Array.isArray(saved) ? saved.filter((dir: unknown): dir is string => typeof dir === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A linked folder, with the id the route and the client's bindings know it
 * by. Hashing the path keeps the id the same across restarts however the
 * folders are listed, and keeps two folders that share a name apart.
 */
function makeLink(path: string, source: LinkSource): LinkedFolder {
  const dir = resolve(expandHome(path));
  const name = basename(dir);
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "folder";
  const hash = createHash("sha1").update(dir).digest("hex").slice(0, 6);
  return { folder: `${LINKED_PREFIX}${slug}-${hash}`, name, dir, display: displayOf(dir), source };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Refused rather than buffered.
      if (size > MAX_BYTES) {
        fail(new Error("Template too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

const json = (res: ServerResponse, status: number, payload: unknown) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
  return true;
};

/**
 * JSON only, for anything that links, picks or saves: a page on another site
 * can send a text/plain POST without a CORS preflight, and must not get to
 * link folders, write files or open dialogs on this machine. JSON forces the
 * preflight, which nothing here answers for another origin.
 */
const isJson = (req: IncomingMessage) => /^application\/json\b/.test(req.headers["content-type"] ?? "");

/** A tree as the `FileMap` the client hands to `importFolder`: relative path → text. */
function readFolderMap(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!FOLDER_SKIP.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile() || !FOLDER_FILE.test(entry.name) || statSync(full).size > MAX_BYTES) continue;
      files[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return files;
}

export function createDiskStore(options: DiskStoreOptions): DiskStore {
  const { dirs: repoDirs, linked: linkedPaths = [], linkedSource = "env", linksFile, env = process.env } = options;
  const logger: DiskLogger = options.logger ?? { info: (m) => console.log(m), warn: (m) => console.warn(m) };
  const ownWatcher: FsWatcher | null = options.watcher ? null : createFsWatcher();
  const watcher: DiskWatcher = options.watcher ?? (ownWatcher as FsWatcher);
  const hub: EventHub | null = options.notify ? null : createEventHub();
  const notify = options.notify ?? ((event: string, data: unknown) => hub?.send(event, data));
  const warn = (message: string) => logger.warn(message);

  // The watched folders exist before the watcher is pointed at them — a
  // fresh BD_TEMPLATES_DIR (the e2e suite's) starts with none.
  for (const dir of [repoDirs.scratch, repoDirs.examples, repoDirs.symlinks]) if (dir) mkdirSync(dir, { recursive: true });

  /** Folders inside the store the app may write a file it opened back to. Deleting stays scratch-only. */
  const inRepo = [WRITABLE, ...(repoDirs.examples ? ["examples"] : [])];
  /** id → linked folder. Links come and go while the store runs: Link a folder…, Re-link…, Unlink. */
  const links = new Map<string, LinkedFolder>();
  /** Every folder the route can address, by the id it is addressed with. */
  const folderDirs: Record<string, string> = Object.fromEntries(
    Object.entries(repoDirs).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  /** Folders the app may write a file it opened back to. */
  const savable = new Set(repoDirs.symlinks ? [...inRepo, SYMLINKS] : inRepo);

  /**
   * Folders (and files) this store has asked the watcher for. Never
   * UNwatched: chokidar's unwatch puts a path on an ignore list for good,
   * which would blind Vite's own HMR too were a linked folder inside its
   * root. An unlinked folder's events are dropped by `folderOf` instead.
   */
  const watched = new Set<string>();
  const watch = (path: string) => {
    if (watched.has(path) || !existsSync(path)) return;
    watcher.add(path);
    watched.add(path);
  };

  /** Link a folder, or hand back the link it already has (one named at the start wins over a saved one). */
  const addLink = (path: string, source: LinkSource) => {
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
  const removeLink = (id: string) => {
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
  for (const path of linkedPaths) addLink(path, linkedSource);
  if (linksFile) for (const path of readSavedLinks(linksFile)) addLink(path, "saved");
  for (const link of links.values()) {
    if (!isDir(link.dir)) warn(`  ➜  templates:  linked folder ${link.display} is missing — its files can't sync until it's back or re-linked`);
  }

  /**
   * A path we are willing to touch: a known folder, a plain file name (no
   * separators, no leading dot) — or, in a linked folder, folders of plain
   * names on the way to one — and, belt and braces against `..` games, a
   * resolved path still inside that folder.
   */
  const safePath = (folder: string, name: string): string | null => {
    const dir = folderDirs[folder];
    if (!dir) return null;
    const segments = name.split("/");
    if (segments.length > 1 && !folder.startsWith(LINKED_PREFIX)) return null;
    if (!FILE_NAME.test(segments[segments.length - 1])) return null;
    if (!segments.slice(0, -1).every((s) => SEGMENT.test(s) && s !== "node_modules")) return null;
    const full = resolve(dir, ...segments);
    return isInside(full, dir) ? full : null;
  };

  /**
   * What the menu needs to list a file without opening it: its name, which
   * editor can render it, where it lives, and when it last changed. The kind
   * is sniffed from the document's own shape, so the files stay plain
   * templates with nothing this app invented in them. Null for a file a
   * linked folder leaves out of its listing — JSON that isn't a diagram.
   * Kept by size and time, since a linked repo is listed on every menu open.
   */
  const described = new Map<string, { mtimeMs: number; size: number; entry: TemplateEntry | null }>();
  /** Keys `describe` was asked for during the listing under way — the rest are files gone since, dropped after it. */
  const describedNow = new Set<string>();
  const describe = (full: string, folder: string, file: string, { hideOthers = false } = {}): TemplateEntry | null => {
    const stats = statSync(full);
    const key = `${folder}\0${hideOthers}\0${full}`;
    describedNow.add(key);
    const known = described.get(key);
    if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) return known.entry;
    const entry = ((): TemplateEntry | null => {
      const name = file.split("/").pop() ?? file;
      // Never parse a package-lock.json of many megabytes. (A save is capped the same.)
      if (stats.size > MAX_BYTES) return hideOthers ? null : unreadable(folder, file, "too large to be a diagram");
      if (!hideOthers && !FILE_NAME.test(name)) return unreadable(folder, file, "a file name the app can't open");
      const raw = readFileSync(full, "utf8");
      let doc: { meta?: { title?: unknown }; nodes?: unknown[]; participants?: unknown[] };
      try {
        doc = JSON.parse(raw);
      } catch {
        return hideOthers && !LOOKS_LIKE_DIAGRAM.test(raw) ? null : unreadable(folder, file, "not readable as JSON");
      }
      if (!isDiagram(doc)) return hideOthers ? null : unreadable(folder, file, "JSON, but not a diagram");
      if (!safePath(folder, file)) return unreadable(folder, file, "a file name the app can't open");
      const title = doc.meta?.title;
      return {
        folder,
        file,
        name: typeof title === "string" && title.trim() ? title : name.replace(/\.json$/, ""),
        kind: Array.isArray(doc.participants) ? "sequence" : "architecture",
        nodes: Array.isArray(doc.nodes) ? doc.nodes.length : (doc.participants?.length ?? 0),
        updated: stats.mtimeMs,
      };
    })();
    described.set(key, { mtimeMs: stats.mtimeMs, size: stats.size, entry });
    return entry;
  };

  /** A repo folder, listed flat: every .json file in it, unreadable ones included — these folders hold diagrams only. */
  const listFolder = (folder: string): TemplateEntry[] => {
    const dir = folderDirs[folder];
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return []; // the folder may not exist yet — nothing to list, not an error
    }
    const listed: TemplateEntry[] = [];
    for (const file of files) {
      // A link made by Link a file… says where it points, so the menu can.
      // Any symlink whose file has moved says that, rather than "not readable".
      const target = linkTarget(join(dir, file));
      const pointsAt = target && folder === SYMLINKS ? { target: displayOf(target) } : {};
      if (target && !existsSync(target)) {
        listed.push({ ...unreadable(folder, file, `links to ${displayOf(target)}, which is missing`), ...pointsAt, missing: true });
        continue;
      }
      // One unreadable file must not take the whole list down — hand-edited
      // JSON is exactly what these folders invite.
      try {
        const entry = describe(join(dir, file), folder, file);
        if (entry) listed.push({ ...entry, ...pointsAt });
      } catch {
        listed.push({ ...unreadable(folder, file, "not readable as JSON"), ...pointsAt });
      }
    }
    return listed.sort((a, b) => b.updated - a.updated);
  };

  /** Files in linked folders the app has read or written — announced even when a listing leaves them out. */
  const served = new Set<string>();
  /** Files the last listing of each linked folder showed. */
  const listedLinked = new Set<string>();

  /** A linked folder, at any depth: its diagrams, and a count of the JSON it left out. */
  const listLinked = (id: string) => {
    const link = links.get(id);
    if (!link || !isDir(link.dir)) return { entries: [] as TemplateEntry[], skipped: 0, truncated: false };
    const { files, truncated } = scanFolder(link.dir);
    // A linked folder holding this store's own folders lists them under their own captions, not twice.
    const own = [repoDirs.scratch, repoDirs.examples, repoDirs.symlinks, repoDirs.folders].filter((d): d is string => Boolean(d));
    const entries: TemplateEntry[] = [];
    let skipped = 0;
    for (const file of files) {
      const full = join(link.dir, ...file.split("/"));
      if (own.some((dir) => isInside(full, dir))) continue;
      try {
        const entry = describe(full, id, file, { hideOthers: true });
        if (!entry) {
          skipped += 1;
          continue;
        }
        entries.push(entry);
        listedLinked.add(full);
        // A watcher that doesn't recurse is pointed at each folder a diagram lives in.
        if (watcher.recursive === false && file.includes("/")) watch(dirname(full));
      } catch {
        skipped += 1; // gone between the scan and the read
      }
    }
    return { entries: entries.sort((a, b) => b.updated - a.updated), skipped, truncated };
  };

  const listFolders = (): TemplateEntry[] => {
    const root = repoDirs.folders;
    if (!root) return [];
    let names: string[];
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
      return { folder: FOLDERS, file: name, name: title, kind: "architecture" as const, nodes: 0, updated: statSync(join(root, name)).mtimeMs };
    });
  };

  /**
   * A symlinked file's real path → its link in symlinks/. The watcher is
   * pointed at each file itself, wherever it lives, and reports changes by
   * that path; this is how one is told back to the app as the link it
   * opened. Re-read on every listing, so a link made by hand counts.
   */
  const symlinkOf = new Map<string, string>();
  const trackSymlinks = () => {
    symlinkOf.clear();
    if (!repoDirs.symlinks) return;
    let names: string[];
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
      watch(real);
    }
  };
  trackSymlinks();

  const listing = (): Listing => {
    trackSymlinks();
    listedLinked.clear();
    describedNow.clear();
    const linked = [...links.values()].map((l) => {
      watch(l.dir); // one that was missing and is back is watched again
      return { ...l, missing: !isDir(l.dir), ...listLinked(l.folder) };
    });
    const templates = [
      ...(repoDirs.examples ? listFolder("examples") : []),
      ...listFolder(WRITABLE),
      ...listFolders(),
      ...(repoDirs.symlinks ? listFolder(SYMLINKS) : []),
      ...linked.flatMap((l) => l.entries),
    ];
    for (const key of described.keys()) if (!describedNow.has(key)) described.delete(key);
    return {
      dirs: repoDirs,
      linked: linked.map(({ entries: _entries, ...l }) => l),
      picker: canPick("folder", env),
      filePicker: Boolean(repoDirs.symlinks) && canPick("file", env),
      openPicker: Boolean(repoDirs.symlinks) && canPick("open", env),
      savePicker: Boolean(repoDirs.symlinks) && canPick("save", env),
      events: Boolean(hub),
      templates,
    };
  };

  /**
   * Where a real file is already addressable: a repo folder it sits in, or a
   * linked folder it sits anywhere under. Never symlinks/ or folders/.
   */
  const locate = (real: string): { folder: string; file: string } | null => {
    for (const [folder, dir] of Object.entries(folderDirs)) {
      if (folder === FOLDERS || folder === SYMLINKS) continue;
      const root = realOrResolved(dir);
      if (!real.startsWith(root + sep)) continue;
      const file = relative(root, real).split(sep).join("/");
      if (!folder.startsWith(LINKED_PREFIX) && file.includes("/")) continue;
      if (folder.startsWith(LINKED_PREFIX) && isSkippedPath(file)) continue;
      if (!safePath(folder, file)) continue;
      return { folder, file };
    }
    return null;
  };

  /** The listing row for one file, read fresh — a link's carries where it points. */
  const entryFor = (folder: string, file: string): TemplateEntry | undefined => {
    const full = safePath(folder, file);
    if (!full) return undefined;
    try {
      const target = folder === SYMLINKS ? linkTarget(full) : null;
      const entry = describe(full, folder, file);
      return entry ? { ...entry, ...(target ? { target: displayOf(target) } : {}) } : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Open file… through the store, whose dialog says where the pick lives: a
   * diagram JSON is linked, as Link a file… links it, so edits save to it;
   * anything else — a SQL script, a CSV, a dbt manifest, a React Flow export
   * — comes back as its text, for the page to read in as a copy, the way the
   * browser's own picker hands a file over.
   */
  const openFile = (path: string): OpenFileResult => {
    const full = resolve(expandHome(path));
    const shown = displayOf(full);
    let real: string;
    try {
      real = realOrResolved(full);
      if (!statSync(real).isFile()) return { error: `${shown} isn't a file` };
    } catch {
      return { error: `${shown} isn't there` };
    }
    if (statSync(real).size > MAX_BYTES) return { error: `${shown} is too large to open` };
    const text = readFileSync(real, "utf8");
    if (real.endsWith(".json")) {
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        doc = undefined; // read in, it says what is wrong with it
      }
      if (isDiagram(doc)) return linkFile(full);
    }
    return { copy: { name: basename(full), text } };
  };

  /**
   * Link one diagram file from another folder: a symlink to it in symlinks/,
   * named after it. A file the menu already lists — in examples/, a linked
   * folder, or linked before — is handed back as it is, never linked twice.
   *
   * `replaces` names a link to point at this file instead (a re-link, for a
   * file that moved): the link keeps its name, so the app's files bound to
   * it stay bound — and learn its new target from the answer.
   */
  const linkFile = (path: string, replaces?: string): LinkFileResult => {
    if (!repoDirs.symlinks) return { error: "This store links no files" };
    const full = resolve(expandHome(path));
    const shown = displayOf(full);
    let real: string;
    try {
      real = realOrResolved(full);
      if (!statSync(real).isFile()) return { error: `${shown} isn't a file` };
    } catch {
      return { error: `${shown} isn't there` };
    }
    if (!real.endsWith(".json")) return { error: `${shown} isn't a .json file` };
    if (statSync(real).size > MAX_BYTES) return { error: `${shown} is too large to be a diagram` };
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(real, "utf8"));
    } catch {
      return { error: `${shown} isn't valid JSON` };
    }
    if (!isDiagram(doc)) return { error: `${shown} is JSON, but not a diagram` };

    trackSymlinks();
    const linkedAs = symlinkOf.get(real);
    const home = locate(real);
    const own = realOrResolved(repoDirs.symlinks);

    if (replaces !== undefined) {
      const link = safePath(SYMLINKS, replaces);
      if (!link || !lstatOrNull(link)?.isSymbolicLink()) return { error: `${replaces} isn't a link to re-link` };
      if (linkedAs && linkedAs !== link) return { error: `${shown} is linked already, as ${basename(linkedAs)}` };
      // Two names for one file would be two open copies writing over each other.
      if (home || real.startsWith(own + sep)) return { error: `${shown} is already listed under Templates — open it from there` };
      // Made beside it and renamed over it, so a link that can't be made
      // leaves the old one as it was.
      try {
        rmSync(`${link}.relink`, { force: true }); // one a crash left behind
        symlinkSync(full, `${link}.relink`);
        renameSync(`${link}.relink`, link);
      } catch (error) {
        rmSync(`${link}.relink`, { force: true });
        return { error: `Couldn't re-link: ${(error as Error).message}` };
      }
      trackSymlinks();
      const entry = entryFor(SYMLINKS, replaces);
      return entry ? { entry } : { error: `Couldn't read ${shown}` };
    }

    if (linkedAs) {
      const entry = entryFor(SYMLINKS, basename(linkedAs));
      if (entry) return { entry };
    }
    if (home) {
      const entry = entryFor(home.folder, home.file);
      if (entry && entry.kind !== "unreadable") return { entry };
    }
    if (real.startsWith(own + sep)) return { error: `${shown} is already under Templates` };

    // Named after the file; a name another link holds gets a number.
    const stem = linkName(real);
    let name = `${stem}.json`;
    for (let n = 2; lstatOrNull(join(repoDirs.symlinks, name)); n++) name = `${stem}-${n}.json`;
    try {
      symlinkSync(full, join(repoDirs.symlinks, name));
    } catch (error) {
      // Windows makes links only with Developer Mode on (or as admin).
      return { error: `Couldn't make the link: ${(error as Error).message}` };
    }
    trackSymlinks();
    const entry = entryFor(SYMLINKS, name);
    return entry ? { entry } : { error: `Couldn't read ${shown}` };
  };

  /** path → the exact text this store last wrote there, so its own writes are not announced. */
  const lastWritten = new Map<string, string>();

  /**
   * Save a diagram to a path of the person's choosing, and link it the way
   * opening it would have: a file in a folder the store lists is bound
   * there; anywhere else it is symlinked into symlinks/. Never over a file
   * that isn't a diagram, and over one that is only when `overwrite` says so
   * (the save dialog asks before replacing; a typed path has to).
   */
  const saveAs = async (
    path: string,
    doc: unknown,
    overwrite: boolean,
  ): Promise<{ entry: TemplateEntry } | { status: number; error: string; exists?: boolean }> => {
    let full = resolve(expandHome(path));
    if (!extname(full)) full += ".json"; // a name typed without one
    const shown = displayOf(full);
    if (!full.endsWith(".json")) return { status: 400, error: `${shown} isn't a .json file` };
    if (!isDir(dirname(full))) return { status: 400, error: `${displayOf(dirname(full))} isn't a folder` };
    if (lstatOrNull(full)) {
      if (!isFile(full)) return { status: 409, error: `${shown} isn't a file` };
      let onDisk: unknown = null;
      try {
        onDisk = JSON.parse(readFileSync(full, "utf8"));
      } catch {
        // Not JSON: not a diagram either.
      }
      if (!isDiagram(onDisk)) return { status: 409, error: `${shown} is not a diagram — not writing over it` };
      if (!overwrite) return { status: 409, error: `${shown} exists`, exists: true };
    }
    // Where it really lives — through a symlinked folder on the way (macOS's
    // /var is /private/var), even for a file that isn't there yet.
    const real = lstatOrNull(full) ? realOrResolved(full) : join(realOrResolved(dirname(full)), basename(full));
    for (const [folder, reason] of [
      [SYMLINKS, "holds links only"],
      [FOLDERS, "is read-only"],
    ] as const) {
      const dir = folderDirs[folder];
      if (dir && (real === realOrResolved(dir) || real.startsWith(realOrResolved(dir) + sep))) return { status: 400, error: `${folder}/ ${reason}` };
    }
    const home = locate(real);
    if (!home && !repoDirs.symlinks) return { status: 400, error: `${shown} isn't in a folder this store lists` };
    const text = await formatDiagram(real, doc, { warn });
    const homePath = home ? safePath(home.folder, home.file) : null;
    if (homePath) lastWritten.set(homePath, text);
    try {
      writeFileAtomic(full, text);
    } catch (error) {
      return { status: 500, error: `Couldn't write ${shown}: ${(error as Error).message}` };
    }
    if (home && homePath) {
      served.add(homePath);
      const entry = entryFor(home.folder, home.file);
      return entry ? { entry } : { status: 500, error: `Couldn't read ${shown} back` };
    }
    const linked = linkFile(full);
    if ("error" in linked) return { status: 500, error: `Saved ${shown}, but ${linked.error}` };
    // Its own write, not news: recorded under the path it is addressed by now.
    const addressed = safePath(linked.entry.folder, linked.entry.file);
    if (addressed) lastWritten.set(addressed, text);
    return linked;
  };

  /**
   * Link a diagram file, making it first — holding `doc`, titled after its
   * name — if it isn't there yet. One that is there is linked as it is:
   * making a new file is never a reason to write over an old one.
   */
  const linkOrCreate = async (
    path: string,
    doc: unknown,
  ): Promise<{ entry: TemplateEntry; created: boolean } | { status: number; error: string }> => {
    let full = resolve(expandHome(path));
    if (!extname(full)) full += ".json"; // a name typed without one
    if (lstatOrNull(full)) {
      const linked = linkFile(full);
      return "error" in linked ? { status: 400, error: linked.error } : { entry: linked.entry, created: false };
    }
    const d = doc as { meta?: unknown };
    const meta = d.meta && typeof d.meta === "object" ? (d.meta as { title?: unknown }) : {};
    const titled = typeof meta.title === "string" && meta.title.trim() ? doc : { ...d, meta: { ...meta, title: basename(full, ".json") } };
    const saved = await saveAs(full, titled, false);
    return "error" in saved ? saved : { entry: saved.entry, created: true };
  };

  /** Which savable folder a changed path belongs to, and its file there — only what the app could have open. */
  const folderOf = (full: string): { folder: string; file: string } | undefined => {
    for (const folder of savable) {
      const dir = folderDirs[folder];
      if (!dir || !isInside(full, dir)) continue;
      const file = relative(dir, full).split(sep).join("/");
      if (!folder.startsWith(LINKED_PREFIX)) {
        if (file.includes("/")) continue;
        return { folder, file };
      }
      // A linked repo changes constantly (builds, caches): announce only
      // what the menu lists, or what the app has open.
      if (!listedLinked.has(full) && !served.has(full)) continue;
      return { folder, file };
    }
    return undefined;
  };

  const pending = new Map<string, NodeJS.Timeout>();
  const announce = (path: string) => {
    // A symlinked file changed where it lives: it is the link that the app
    // opened, and the link that the app wrote through.
    const full = symlinkOf.get(resolve(path)) ?? resolve(path);
    if (!full.endsWith(".json")) return;
    const at = folderOf(full);
    if (!at) return;
    clearTimeout(pending.get(full));
    pending.set(
      full,
      setTimeout(() => {
        pending.delete(full);
        let text: string;
        try {
          text = readFileSync(full, "utf8");
        } catch {
          return; // gone again (an editor's temp file, a delete) — nothing to load
        }
        if (lastWritten.get(full) === text) return; // our own save
        lastWritten.delete(full);
        // Looked up again: the folder may have been unlinked meanwhile.
        if (!folderDirs[at.folder]) return;
        notify(CHANGE_EVENT, at);
      }, SETTLE_MS),
    );
  };
  for (const folder of inRepo) watch(folderDirs[folder]);
  if (repoDirs.symlinks) watch(repoDirs.symlinks);
  watcher.on("change", announce);
  watcher.on("add", announce);
  // A linked folder moved, renamed or deleted under the running store: tell
  // the app, which re-lists and offers a re-link. It is watched again once
  // it is back (see `listing`).
  watcher.on("unlinkDir", (path) => {
    const link = [...links.values()].find((l) => l.dir === resolve(path));
    if (!link) return;
    watched.delete(link.dir);
    notify(LINKS_EVENT, { folder: link.folder });
  });
  // The same for a symlinked file moved or deleted where it lives: the app
  // re-lists, and the menu shows its link as missing.
  watcher.on("unlink", (path) => {
    const link = symlinkOf.get(resolve(path));
    if (!link) return;
    watched.delete(resolve(path));
    notify(LINKS_EVENT, { folder: SYMLINKS, file: basename(link) });
  });

  /**
   * A link answers to the file it pointed at when the page bound to it. The
   * page says which (`?target=`); a link that points somewhere else now —
   * removed and remade under the same name for another file, or re-pointed
   * from another page — is refused, never read or written as that file.
   */
  const movedTarget = (folder: string, full: string, expected: string | null): string | null => {
    if (folder !== SYMLINKS || !expected) return null;
    const now = linkTarget(full);
    return now && displayOf(now) !== expected ? displayOf(now) : null;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = req.url ?? "/";
    const query = url.indexOf("?");
    const pathname = query === -1 ? url : url.slice(0, query);
    if (pathname !== DISK_ROUTE && !pathname.startsWith(`${DISK_ROUTE}/`)) return false;
    const params = new URLSearchParams(query === -1 ? "" : url.slice(query + 1));
    try {
      // Split BEFORE decoding: a nested file in a linked folder arrives as
      // one encoded segment (`docs%2Fplan.json`), and `safePath` judges it.
      let parts: string[];
      try {
        parts = pathname
          .slice(DISK_ROUTE.length)
          .split("/")
          .filter(Boolean)
          .map((segment) => decodeURIComponent(segment));
      } catch {
        return json(res, 400, { error: `Bad template path: ${pathname}` });
      }
      const [folder, name, extra] = parts;

      if (req.method === "GET" && !folder) return json(res, 200, listing());

      if (folder === EVENTS && !name && req.method === "GET" && hub) {
        hub.serve(req, res);
        return true;
      }

      // Linking from the app. POST { dir } links a typed path; POST
      // { pick: true, near? } asks with the system's folder dialog, opening
      // near where a lost folder used to be. `replaces` names a link this one
      // takes over from (a re-link) — dropped if it was saved; one named at
      // the start stays until the store is made without it.
      if (folder === LINKS) {
        if (req.method === "POST" && !name) {
          if (!isJson(req)) return json(res, 415, { error: "Send the link as application/json" });
          const body = JSON.parse((await readBody(req)) || "{}");
          let dir = typeof body.dir === "string" ? body.dir.trim() : "";
          if (body.pick) {
            const prompt = body.replaces ? "Pick the folder that holds the diagram now" : "Pick a folder of diagram JSON to link";
            const picked = await pick("folder", { prompt, near: typeof body.near === "string" ? body.near : undefined }, env);
            if (!("path" in picked)) return json(res, 200, picked);
            dir = picked.path;
          }
          if (!dir) return json(res, 400, { error: "No folder given" });
          const full = resolve(expandHome(dir));
          if (!isDir(full)) return json(res, 400, { error: `${displayOf(full)} isn't a folder` });
          if (Object.values(repoDirs).some((d) => typeof d === "string" && (full === resolve(d) || isInside(full, d)))) {
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
          if (link.source === "env") return json(res, 409, { error: `${link.display} is linked by BD_LINKED_DIRS — unlink it there` });
          if (link.source === "cli") return json(res, 409, { error: `${link.display} was linked on the command line — it goes when that does` });
          removeLink(name);
          saveLinks();
          return json(res, 200, { ok: true, ...listing() });
        }
        res.statusCode = 405;
        res.end("Method not allowed");
        return true;
      }

      // Linking one file. POST { path } links a typed path; POST
      // { pick: true, near? } asks with the system's file dialog. `replaces`
      // names a link to re-point (a file that moved). `create` is a diagram
      // to make the file with if it isn't there yet — New file on disk… —
      // and the dialog is then a save dialog, which can name a file that
      // doesn't exist, suggesting `name`. `open` is Open file…: any file,
      // linked if it is a diagram, else answered as `copy` (see openFile).
      if (folder === SYMLINKS && !name && req.method === "POST") {
        if (!repoDirs.symlinks) return json(res, 404, { error: "This store links no files" });
        if (!isJson(req)) return json(res, 415, { error: "Send the link as application/json" });
        const body = JSON.parse((await readBody(req)) || "{}");
        const creating = body.create !== undefined;
        const replacing = typeof body.replaces === "string";
        const opening = body.open === true;
        if (creating && !isDiagram(body.create)) return json(res, 400, { error: "Send the diagram to make the file with as `create`" });
        if (creating && replacing) return json(res, 400, { error: "A re-link points at a file that is there; it never makes one" });
        if (opening && (creating || replacing)) return json(res, 400, { error: "Open file… opens a file that is there; it never makes or re-links one" });
        let path = typeof body.path === "string" ? body.path.trim() : "";
        if (body.pick) {
          const picked = await pick(
            creating ? "save" : opening ? "open" : "file",
            {
              prompt: creating
                ? "Name the new diagram file (picking one that exists links it as it is)"
                : replacing
                  ? `Pick where ${body.replaces} is now`
                  : opening
                    ? "Open a file (a diagram JSON is linked, so edits save to it)"
                    : "Pick a diagram JSON file to link",
              near: (typeof body.near === "string" && body.near) || path || undefined,
              ...(creating && typeof body.name === "string" && body.name ? { name: body.name } : {}),
            },
            env,
          );
          if (!("path" in picked)) return json(res, 200, picked);
          path = picked.path;
        }
        if (!path) return json(res, 400, { error: "No file given" });
        if (opening) {
          const opened = openFile(path);
          if ("error" in opened) return json(res, 400, { error: opened.error });
          if ("copy" in opened) return json(res, 200, { copy: opened.copy });
          return json(res, 200, { entry: opened.entry, ...listing() });
        }
        if (creating) {
          const made = await linkOrCreate(path, body.create);
          if ("error" in made) return json(res, made.status, { error: made.error });
          return json(res, 200, { entry: made.entry, created: made.created, ...listing() });
        }
        const linked = linkFile(path, typeof body.replaces === "string" ? body.replaces : undefined);
        if ("error" in linked) return json(res, 400, { error: linked.error });
        return json(res, 200, { entry: linked.entry, ...listing() });
      }

      // Save as… POST { doc, pick: true, name?, near? } asks with the
      // system's save dialog; POST { doc, path, overwrite? } saves to a typed
      // path. Answers with the listing row the app binds the file to.
      if (folder === SAVE_AS && !name && req.method === "POST") {
        if (!isJson(req)) return json(res, 415, { error: "Send the diagram as application/json" });
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!isDiagram(body.doc)) return json(res, 400, { error: "Send the diagram to save as `doc`" });
        let path = typeof body.path === "string" ? body.path.trim() : "";
        let overwrite = body.overwrite === true;
        if (body.pick) {
          const picked = await pick(
            "save",
            {
              prompt: "Save the diagram as",
              near: typeof body.near === "string" && body.near ? body.near : undefined,
              name: typeof body.name === "string" && body.name ? body.name : undefined,
            },
            env,
          );
          if (!("path" in picked)) return json(res, 200, picked);
          path = picked.path;
          overwrite = true; // the dialog asked before replacing
        }
        if (!path) return json(res, 400, { error: "No file given" });
        const saved = await saveAs(path, body.doc, overwrite);
        if ("error" in saved) return json(res, saved.status, { error: saved.error, ...(saved.exists ? { exists: true } : {}) });
        return json(res, 200, { entry: saved.entry, ...listing() });
      }

      // Unlinking one: removes the link and never the file it points at —
      // nor a plain file someone put in symlinks/ by hand.
      if (folder === SYMLINKS && req.method === "DELETE" && name && !extra) {
        const full = safePath(SYMLINKS, name);
        if (!full) return json(res, 400, { error: `Bad template path: ${pathname}` });
        if (!lstatOrNull(full)?.isSymbolicLink()) return json(res, 409, { error: `${name} isn't a link — not deleting it` });
        unlinkSync(full);
        return json(res, 200, { ok: true, ...listing() });
      }

      // A folder-format tree is served whole, as a file map, read-only.
      if (folder === FOLDERS && req.method === "GET") {
        const root = repoDirs.folders;
        if (!root || !name || extra || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
          return json(res, 400, { error: `Bad folder path: ${pathname}` });
        }
        const full = resolve(root, name);
        if (!isInside(full, root)) return json(res, 400, { error: `Bad folder path: ${pathname}` });
        return json(res, 200, { name, files: readFolderMap(full) });
      }

      const full = folder && !extra ? safePath(folder, name ?? "") : null;
      if (!full) return json(res, 400, { error: `Bad template path: ${pathname}` });
      const link = links.get(folder);
      const moved = movedTarget(folder, full, params.get("target"));
      if (moved) {
        return json(res, 409, { error: `${name} links to ${moved} now, not ${params.get("target")}`, moved: true, target: moved });
      }

      if (req.method === "GET") {
        if (!isFile(full)) return json(res, 404, { error: `${name} isn't there`, missing: true });
        if (link) served.add(full);
        return json(res, 200, JSON.parse(readFileSync(full, "utf8")));
      }
      // Writes go to scratch, or back to an example, linked or symlinked file
      // the app opened (the client only sends one there for a file bound to
      // it). Deleting is scratch-only: closing a file in the app must never
      // remove a tracked example, or anything outside the store.
      if (req.method === "PUT") {
        if (!savable.has(folder)) return json(res, 403, { error: `${folder}/ is read-only` });
        const pointsAt = linkTarget(full);
        // Never write a symlinked file back where it used to be, in any
        // folder: the menu shows its link as missing instead.
        if (pointsAt && !existsSync(pointsAt)) return json(res, 404, { error: "missing — moved or deleted", missing: true });
        // symlinks/ holds links: a save never makes a file there, so a link
        // removed by hand fails its saves rather than becoming a copy.
        if (folder === SYMLINKS && !lstatOrNull(full)) {
          return json(res, 404, { error: "its link was removed — link the file again", missing: true });
        }
        if (link || folder === SYMLINKS) {
          // Outside the store, never recreate a folder that has gone (it
          // was moved, or a drive unmounted): the app offers a re-link.
          if (link && !isDir(link.dir)) return json(res, 404, { error: `${link.display} is missing`, missing: true });
          if (link && !isDir(dirname(full))) return json(res, 404, { error: `${displayOf(dirname(full))} is missing`, missing: true });
          // Nor anywhere outside the linked folder — through a symlinked folder inside it, say.
          const parent = realOrResolved(dirname(full));
          const root = link ? realOrResolved(link.dir) : "";
          if (link && parent !== root && !parent.startsWith(root + sep)) {
            return json(res, 403, { error: `${name} is outside ${link.display}` });
          }
          // And write only over a diagram: never over a package.json, and
          // never over a diagram caught half-saved by its editor (the app
          // tries again; the finished save reloads).
          let onDisk: unknown;
          try {
            onDisk = JSON.parse(readFileSync(full, "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") onDisk = null;
          }
          if (onDisk !== undefined && !isDiagram(onDisk)) return json(res, 409, { error: `${name} is not a diagram — not writing over it` });
        } else {
          // The folder can vanish under a running store (a `git clean`, a
          // stray `rm -rf`); recreate it rather than failing every write.
          mkdirSync(folderDirs[folder], { recursive: true });
        }
        // Parsed before writing: a malformed body fails loudly here rather
        // than landing a broken file on disk.
        const doc = JSON.parse(await readBody(req));
        if (!isDiagram(doc)) return json(res, 400, { error: "That isn't a diagram — not writing it" });
        const text = await formatDiagram(realOrResolved(full), doc, { warn });
        lastWritten.set(full, text);
        writeFileAtomic(full, text);
        if (link) served.add(full);
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
      res.end("Method not allowed");
      return true;
    } catch (error) {
      return json(res, 500, { error: String((error as Error)?.message ?? error) });
    }
  };

  const named = [
    ...(repoDirs.examples ? [`${repoDirs.examples} (examples)`] : []),
    `${repoDirs.scratch} (scratch, auto-save)`,
    ...(repoDirs.folders ? [`${repoDirs.folders} (folders)`] : []),
    ...(repoDirs.symlinks ? [`${repoDirs.symlinks} (symlinks)`] : []),
    ...[...links.values()].map((l) => `${l.display} (linked)`),
  ];
  logger.info(`  ➜  templates:  ${named.join(", ")}`);

  return {
    handle,
    listing,
    linkFile: (path) => linkFile(path),
    close() {
      hub?.close();
      ownWatcher?.close();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}
