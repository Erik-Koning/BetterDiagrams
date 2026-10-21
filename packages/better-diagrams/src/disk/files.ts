/**
 * files.ts — the file-system helpers the disk store is built from: paths
 * shown the way a person types them, existence checks that never throw, and
 * a write that never leaves half a file behind.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** `~/work` → `/Users/you/work`: a typed path, or a quoted env value, arrives unexpanded. */
export const expandHome = (path: string): string => path.replace(/^~(?=$|[/\\])/, homedir());

/** `/Users/you/work` → `~/work`, for logs and the menu. */
export function displayOf(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** Is there a directory at `path` right now? */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Is there a file (or a link to one) at `path` right now? */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Is anything at `path` — a file, a folder, or a link, dangling or not? */
export function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** `realpath`, or the resolved path itself when there is nothing there to resolve. */
export function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Where the symlink at `full` points, as an absolute path — null when it is no symlink. */
export function linkTarget(full: string): string | null {
  try {
    return lstatSync(full).isSymbolicLink() ? resolve(dirname(full), readlinkSync(full)) : null;
  } catch {
    return null;
  }
}

/** Is `path` strictly inside `dir`? Both are compared resolved, never by prefix alone. */
export const isInside = (path: string, dir: string): boolean => resolve(path).startsWith(resolve(dir) + sep);

/** The nearest folder that exists at or above `path` — where a dialog opens. */
export function nearestDir(path: string): string | null {
  let dir = resolve(expandHome(path));
  while (!isDir(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return dir;
}

/**
 * Write `text` to `path` so no reader ever sees half of it: into a temporary
 * file beside it, flushed to disk, then renamed over it in one step. A crash
 * mid-write leaves the old file whole, and a watcher in the folder — an
 * editor, another dev server, a test runner — only ever reads a finished
 * file. A symlink is written THROUGH: the rename lands on the file it points
 * at, so the link stays a link. The file keeps its permissions.
 */
export function writeFileAtomic(path: string, text: string): void {
  const real = realOrResolved(path);
  let mode: number | undefined;
  try {
    mode = statSync(real).mode & 0o7777;
  } catch {
    mode = undefined; // a new file: the umask decides, as for any other
  }
  // Not ending in .json, so no watcher (this server's included) takes it for a diagram.
  const tmp = join(dirname(real), `.${basename(real)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const fd = openSync(tmp, "wx", mode ?? 0o666);
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // `open`'s mode is masked by the umask; the file's own mode is not.
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, real);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
