import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The webview's page script: the library's studio and the web app's document
 * handling, bundled into one webview.js and one webview.css. A webview loads
 * only the files its page names, so there are no lazy chunks to find later.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The library from source, as the example app takes it, so a change to
      // it is in the next build with no library build first.
      "@mosphere/better-diagrams/styles.css": here("../better-diagrams/src/styles.css"),
      "@mosphere/better-diagrams": here("../better-diagrams/src/index.ts"),
      // The web app's own document handling: its registry, validation, loss
      // report and default view. The `better-diagrams` command serves that
      // app, so a file looks the same in the browser and here.
      "@app": here("../../example/src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: true,
    // The bundle is loaded from disk by VS Code, never over a network.
    chunkSizeWarningLimit: 8000,
    cssCodeSplit: false,
    rolldownOptions: {
      input: here("src/webview/main.tsx"),
      output: {
        codeSplitting: false,
        entryFileNames: "webview.js",
        assetFileNames: "webview[extname]",
      },
    },
  },
});
