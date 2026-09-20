/**
 * folder/tree.ts — a {@link FolderTree} from a flat {@link FileMap}.
 *
 * Paths are normalised (forward slashes, no leading `./` or `/`, no empty
 * segments), folders are created for every path prefix whether or not a file
 * sits directly in them, and children are sorted by name so the tree — and
 * everything derived from it — is the same whatever order the map came in.
 */
import type { FileMap, FolderEntry, FolderTree } from "./types";

export function normalizePath(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg && seg !== ".")
    .join("/");
}

export function buildFolderTree(files: FileMap): FolderTree {
  const root: FolderEntry = { path: "", parentPath: null, depth: 0, files: {}, children: [] };
  const byPath = new Map<string, FolderEntry>([["", root]]);

  const folderFor = (path: string): FolderEntry => {
    const found = byPath.get(path);
    if (found) return found;
    const cut = path.lastIndexOf("/");
    const parentPath = cut < 0 ? "" : path.slice(0, cut);
    const parent = folderFor(parentPath);
    const entry: FolderEntry = { path, parentPath, depth: parent.depth + 1, files: {}, children: [] };
    parent.children.push(entry);
    byPath.set(path, entry);
    return entry;
  };

  for (const [rawPath, content] of files) {
    const path = normalizePath(rawPath);
    if (!path) continue;
    const cut = path.lastIndexOf("/");
    const dir = cut < 0 ? "" : path.slice(0, cut);
    const base = cut < 0 ? path : path.slice(cut + 1);
    folderFor(dir).files[base] = content;
  }

  for (const entry of byPath.values()) {
    entry.children.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  return { root, byPath };
}

/**
 * The same tree with `child` as its root — for a dropped directory whose
 * top-level folder name is part of every path. Paths are rewritten relative
 * to the new root.
 */
export function rerootTree(tree: FolderTree, child: FolderEntry): FolderTree {
  const prefix = child.path ? `${child.path}/` : "";
  const files = new Map<string, string>();
  for (const entry of tree.byPath.values()) {
    if (entry !== child && !entry.path.startsWith(prefix)) continue;
    const rel = entry.path === child.path ? "" : entry.path.slice(prefix.length);
    for (const [base, content] of Object.entries(entry.files)) {
      files.set(rel ? `${rel}/${base}` : base, content);
    }
  }
  return buildFolderTree(files);
}

/** Depth-first, parents before children, siblings in name order. */
export function* walkTree(entry: FolderEntry): Generator<FolderEntry> {
  yield entry;
  for (const child of entry.children) yield* walkTree(child);
}

/** Parse a JSON file in a folder, or undefined when absent or unreadable. */
export function readJson<T = unknown>(entry: FolderEntry, name: string): T | undefined {
  const text = entry.files[name];
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
