import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { templatesPlugin } from "./vite-plugin-templates.js";

/**
 * Where templates live while you develop, at the repo root:
 *   templates/examples/ — curated and tracked; a file opened from here is
 *                         saved back here when edited, never deleted
 *   templates/scratch/  — auto-save's own folder for files made in the app;
 *                         git-ignored, rewritten as you work
 * Both are watched: an edit made by another program reloads in the open app
 * (the file on disk wins).
 *   templates/folders/  — FOLDER-FORMAT trees (one subdirectory each), read
 *                         only; imported through `importFolder` on the client.
 *                         Git-ignored: drop a data-model export in to try
 *                         it.
 * All show up under Settings ▾ → Templates.
 *
 * Plus folders OUTSIDE the repo: linked from the menu (Templates → Link a
 * folder…, kept in templates/linked.json, git-ignored), or named in
 * `BD_LINKED_DIRS`, separated like PATH —
 * `BD_LINKED_DIRS=~/work/tracker:~/notes npm run dev`. Their diagrams are live
 * like examples/ (edits save back, disk edits reload) and never deleted; a
 * linked folder that goes missing is never recreated — the app offers to
 * re-link it.
 */
//
// `BD_TEMPLATES_DIR` moves all three somewhere else — the e2e suite points it
// at a temporary folder, so a test of the disk sync never touches the repo's.
const TEMPLATES_ROOT = process.env.BD_TEMPLATES_DIR
  ? resolve(process.env.BD_TEMPLATES_DIR)
  : fileURLToPath(new URL("../templates", import.meta.url));
const TEMPLATE_DIRS = {
  examples: join(TEMPLATES_ROOT, "examples"),
  scratch: join(TEMPLATES_ROOT, "scratch"),
  folders: join(TEMPLATES_ROOT, "folders"),
};
// `~` is expanded by the plugin: a quoted value arrives with it unexpanded.
const LINKED_DIRS = (process.env.BD_LINKED_DIRS ?? "")
  .split(delimiter)
  .map((dir) => dir.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react(), templatesPlugin(TEMPLATE_DIRS, { linked: LINKED_DIRS, linksFile: join(TEMPLATES_ROOT, "linked.json") })],
  server: {
    port: 5173,
    // Optional: proxy AI generation to the local example server (npm run server).
    // The browser never sees an API key.
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  resolve: {
    // Consume the library from source so `npm run dev` picks up edits with no rebuild.
    alias: {
      "@mosphere/better-diagrams/styles.css": new URL(
        "../packages/better-diagrams/src/styles.css",
        import.meta.url,
      ).pathname,
      "@mosphere/better-diagrams": new URL(
        "../packages/better-diagrams/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
