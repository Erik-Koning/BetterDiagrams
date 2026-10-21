/**
 * vite-plugin-templates.js — the disk store behind auto-save, mounted on the
 * Vite dev server.
 *
 * The store itself is the library's `@mosphere/better-diagrams/disk` (see
 * packages/better-diagrams/src/disk/store.ts for the folders it keeps and the
 * rules it keeps them by), read from source like the rest of the example so
 * it needs no build — Vite bundles the config and what it imports. This file
 * only plugs it into Vite: its chokidar watcher sees outside edits, and its
 * HMR socket tells the open app about them, as a `better-diagrams:template`
 * event the app reloads on (see `templates.js` on the client).
 *
 * DEV ONLY, deliberately. `configureServer` runs for `vite dev` and nowhere
 * else, so a production build has no route to write with and the app quietly
 * does without it. Nothing here should ever ship in a bundle. (Outside a
 * checkout of this repo, `better-diagrams` serves the built app with the same
 * store.)
 */
import { createDiskStore } from "../packages/better-diagrams/src/disk/index.ts";

/**
 * @param {{ scratch: string, examples: string, folders?: string, symlinks?: string }} repoDirs absolute folder paths
 * @param {{ linked?: string[], linksFile?: string }} [options] `linked`: folders outside the
 *   repo to link (BD_LINKED_DIRS); `linksFile`: where folders linked from the app are kept
 */
export function templatesPlugin(repoDirs, { linked = [], linksFile } = {}) {
  return {
    name: "better-diagrams-templates",
    configureServer(server) {
      const { logger } = server.config;
      const store = createDiskStore({
        dirs: repoDirs,
        linked,
        linksFile,
        watcher: server.watcher,
        notify: (event, data) => server.ws.send({ type: "custom", event, data }),
        logger: {
          info: (message) => logger.info(message, { timestamp: true }),
          warn: (message) => logger.warn(message, { timestamp: true }),
        },
      });
      server.middlewares.use((req, res, next) => {
        store.handle(req, res).then((served) => {
          if (!served) next();
        }, next);
      });
      server.httpServer?.once("close", () => store.close());
    },
  };
}
