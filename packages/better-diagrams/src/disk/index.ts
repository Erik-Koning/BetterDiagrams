/**
 * @mosphere/better-diagrams/disk — diagrams as files, for a local editor.
 *
 * The disk store an app's file menu talks to: it lists, reads and writes
 * diagram JSON in folders on this machine, links folders and single files
 * from other repos, saves a document wherever the person picks, formats what
 * it writes the way the target repo formats JSON, and tells the open page
 * when another program changes a file.
 *
 *   import { createDiskStore } from "@mosphere/better-diagrams/disk";
 *   const store = createDiskStore({ dirs: { scratch, examples, symlinks } });
 *   http.createServer((req, res) => store.handle(req, res).then((served) => served || next()));
 *
 * `startStandalone` serves a built editor beside it — `better-diagrams` on
 * the command line. Node only, and local only: never mount it on a server
 * anyone else can reach.
 */
export { createDiskStore, isDiagram, DISK_ROUTE, CHANGE_EVENT, LINKS_EVENT, LINKED_PREFIX } from "./store";
export type {
  DiskDirs,
  DiskLogger,
  DiskStore,
  DiskStoreOptions,
  LinkedFolder,
  LinkFileResult,
  LinkSource,
  Listing,
  TemplateEntry,
} from "./store";
export type { DiskWatcher, WatchEvent } from "./watch";
export { formatDiagram, plainJson } from "./format";
export { writeFileAtomic } from "./files";
export { startStandalone } from "./standalone";
export type { Standalone, StandaloneOptions } from "./standalone";
