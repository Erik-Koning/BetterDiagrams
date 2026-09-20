import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { templatesPlugin } from "./vite-plugin-templates.js";

/**
 * Where templates live while you develop, at the repo root:
 *   templates/examples/ — curated and tracked; the app reads, never writes
 *   templates/scratch/  — auto-save's own folder; git-ignored, rewritten as
 *                         you work
 *   templates/folders/  — FOLDER-FORMAT trees (one subdirectory each), read
 *                         only; imported through `importFolder` on the client.
 *                         Git-ignored: drop a data-model export in to try
 *                         it.
 * All show up under Settings ▾ → Templates.
 */
const TEMPLATE_DIRS = {
  examples: fileURLToPath(new URL("../templates/examples", import.meta.url)),
  scratch: fileURLToPath(new URL("../templates/scratch", import.meta.url)),
  folders: fileURLToPath(new URL("../templates/folders", import.meta.url)),
};

export default defineConfig({
  plugins: [react(), templatesPlugin(TEMPLATE_DIRS)],
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
