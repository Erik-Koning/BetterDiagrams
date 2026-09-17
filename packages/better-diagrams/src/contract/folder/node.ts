/**
 * folder/node.ts — the Node adapter: a directory to a {@link FileMap} and
 * back. The only file in `contract/` that touches the filesystem, published
 * on its own subpath (`@mosphere/better-diagrams/contract/folder/node`) so
 * a browser bundle importing `contract` never pulls `node:fs`.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { FileMap } from "./types";

export interface ReadFolderOptions {
  /** Files to read. Default: `.json`, `.yaml`/`.yml`, `.md`. */
  include?: RegExp;
  /** Files larger than this are skipped. Default 5 MB. */
  maxBytes?: number;
  /** Directory names never descended into. */
  skipDirs?: readonly string[];
}

const DEFAULT_INCLUDE = /\.(json|ya?ml|md)$/i;
const DEFAULT_SKIP = ["node_modules", ".git"];

export async function readFolderToFileMap(dir: string, opts: ReadFolderOptions = {}): Promise<FileMap> {
  const include = opts.include ?? DEFAULT_INCLUDE;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const skip = new Set(opts.skipDirs ?? DEFAULT_SKIP);
  const files = new Map<string, string>();

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !include.test(entry.name)) continue;
      const { size } = await stat(full);
      if (size > maxBytes) continue;
      const rel = relative(dir, full).split(sep).join("/");
      files.set(rel, await readFile(full, "utf8"));
    }
  };
  await walk(dir);
  return files;
}

/** Write every file (creating directories), then remove the deletions. */
export async function writeFileMap(
  dir: string,
  files: ReadonlyMap<string, string>,
  deletions: readonly string[] = [],
): Promise<void> {
  for (const [rel, content] of files) {
    const full = join(dir, ...rel.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  for (const rel of deletions) {
    await rm(join(dir, ...rel.split("/")), { force: true, recursive: true });
  }
}
