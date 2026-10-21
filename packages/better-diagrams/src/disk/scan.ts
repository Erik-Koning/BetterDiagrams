/**
 * scan.ts — which JSON files in a linked folder could be diagrams.
 *
 * A linked folder is usually a whole repo, and its diagrams live wherever its
 * authors put them: `docs/architecture/BetterDiagram.json` as readily as the
 * root. In a git work tree git itself says which files belong to the project —
 * tracked, plus untracked-but-not-ignored — so build output, caches and
 * vendored code are left out by the project's own .gitignore. Anywhere else
 * the folder is walked, skipping the folders that never hold a diagram.
 * Hidden files and folders, and node_modules, are left out either way.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isFile } from "./files";

/** The most JSON files one linked folder lists; past it the listing says it was cut short. */
export const MAX_SCANNED = 2000;
/** How deep the walk goes where there is no git to ask. */
const MAX_DEPTH = 8;
/** Folders a walk never enters: dependencies and build output, not anyone's diagrams. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "target", "vendor"]);

export interface Scan {
  /** Paths relative to the folder, `/`-separated, sorted. */
  files: string[];
  /** More JSON files than `MAX_SCANNED` — the rest weren't looked at. */
  truncated: boolean;
}

/** A relative path a scan would never list: under a hidden folder, or node_modules. */
export const isSkippedPath = (relative: string): boolean =>
  relative.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules");

function viaGit(dir: string): string[] | null {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.json"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // not a work tree, or no git on this machine
  }
  // The index can list a file deleted from the work tree; only what is there counts.
  const files = [...new Set(out.split("\0").filter(Boolean))].filter((f) => !isSkippedPath(f) && isFile(join(dir, f)));
  // A folder git ignores wholesale lists nothing; a folder someone linked on purpose still has its diagrams.
  return files.length ? files : null;
}

function viaWalk(dir: string): string[] {
  const files: string[] = [];
  const walk = (at: string, prefix: string, depth: number) => {
    if (files.length > MAX_SCANNED) return;
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return; // unreadable — permissions, or gone mid-walk
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) walk(join(at, entry.name), rel, depth + 1);
      } else if (entry.name.endsWith(".json") && (entry.isFile() || isFile(join(at, entry.name)))) {
        files.push(rel);
      }
    }
  };
  walk(dir, "", 0);
  return files;
}

/** The JSON files in `dir`, at any depth, that a linked folder's listing considers. */
export function scanFolder(dir: string): Scan {
  const files = (viaGit(dir) ?? viaWalk(dir)).sort();
  return files.length > MAX_SCANNED ? { files: files.slice(0, MAX_SCANNED), truncated: true } : { files, truncated: false };
}
