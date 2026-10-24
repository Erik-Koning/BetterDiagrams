import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The extension's half that runs in VS Code's extension host: one CommonJS
 * file, with the library bundled in from source — its disk code
 * (isDiagram, formatDiagram) and, for the agent tools, its prompts,
 * validation and checks — and the web app's document handling. Only what
 * those reach is kept. `vscode` is the host's, and Node's built-ins stay
 * imports.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@mosphere/better-diagrams/disk": here("../better-diagrams/src/disk/index.ts"),
      "@mosphere/better-diagrams": here("../better-diagrams/src/index.ts"),
      "@app": here("../../example/src"),
    },
  },
  ssr: {
    noExternal: true,
    external: ["vscode"],
  },
  build: {
    ssr: "src/extension.ts",
    outDir: "dist",
    emptyOutDir: false,
    target: "node20",
    sourcemap: true,
    minify: false,
    rolldownOptions: {
      external: ["vscode", /^node:/],
      output: {
        format: "cjs",
        entryFileNames: "extension.cjs",
      },
    },
  },
});
