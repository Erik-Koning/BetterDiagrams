/**
 * watch.ts — a small file watcher on `node:fs`, for the disk store run
 * without Vite (whose chokidar watcher it uses otherwise).
 *
 * It speaks chokidar's four events — add, change, unlink, unlinkDir — with
 * absolute paths, which is all the store listens for. A folder is watched
 * recursively where the platform does that natively (macOS, Windows); on
 * Linux, where recursion means a watch per subfolder, a folder is watched
 * on its own and the store adds the subfolders its diagrams live in. A file
 * is watched through its folder, so a save that renames a new file over it —
 * the way most editors and agents write — keeps being seen.
 */
import { watch, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDir, isFile } from "./files";

export type WatchEvent = "add" | "change" | "unlink" | "unlinkDir";

export interface DiskWatcher {
  add(path: string): unknown;
  on(event: WatchEvent, listener: (path: string) => void): unknown;
  /** Does adding a folder watch everything beneath it? Chokidar's does; absent means yes. */
  recursive?: boolean;
}

export interface FsWatcher extends DiskWatcher {
  recursive: boolean;
  close(): void;
}

/** Editors save in bursts; classify a path once it has been quiet this long. */
const SETTLE_MS = 50;

export function createFsWatcher(): FsWatcher {
  const recursive = process.platform === "darwin" || process.platform === "win32";
  const listeners: Record<WatchEvent, Array<(path: string) => void>> = { add: [], change: [], unlink: [], unlinkDir: [] };
  const emit = (event: WatchEvent, path: string) => {
    for (const listener of listeners[event]) listener(path);
  };
  /** Watched folders, by path; `files` set when only some of the folder's files are of interest. */
  const watched = new Map<string, { watcher: FSWatcher; files: Set<string> | null }>();
  /** Files known to exist — so the first event for one is `add`, later ones `change`. */
  const known = new Set<string>();
  const pending = new Map<string, NodeJS.Timeout>();

  const classify = (path: string) => {
    if (isFile(path)) {
      if (known.has(path)) emit("change", path);
      else {
        known.add(path);
        emit("add", path);
      }
      return;
    }
    if (known.delete(path)) {
      emit("unlink", path);
      return;
    }
    const folder = watched.get(path);
    if (folder && !isDir(path)) {
      folder.watcher.close();
      watched.delete(path);
      emit("unlinkDir", path);
    }
  };
  const settle = (path: string) => {
    clearTimeout(pending.get(path));
    pending.set(
      path,
      setTimeout(() => {
        pending.delete(path);
        classify(path);
      }, SETTLE_MS),
    );
  };

  const watchFolder = (dir: string, files: Set<string> | null) => {
    const watcher = watch(dir, { recursive: files ? false : recursive, persistent: false }, (_type, name) => {
      // A folder's own removal comes through as an event without a name, or naming itself.
      if (!name || !isDir(dir)) {
        settle(dir);
        return;
      }
      const path = join(dir, name.toString());
      const entry = watched.get(dir);
      if (entry?.files && !entry.files.has(path)) return;
      settle(path);
    });
    watcher.on("error", () => settle(dir));
    watched.set(dir, { watcher, files });
  };

  return {
    recursive,
    add(path) {
      const full = resolve(path);
      if (isDir(full)) {
        const entry = watched.get(full);
        if (entry && !entry.files) return;
        entry?.watcher.close(); // was watched for single files; now for everything in it
        watchFolder(full, null);
        return;
      }
      if (!isFile(full)) return;
      known.add(full);
      const dir = dirname(full);
      const entry = watched.get(dir);
      if (entry) {
        entry.files?.add(full);
        return;
      }
      watchFolder(dir, new Set([full]));
    },
    on(event, listener) {
      listeners[event].push(listener);
    },
    close() {
      for (const { watcher } of watched.values()) watcher.close();
      watched.clear();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}
