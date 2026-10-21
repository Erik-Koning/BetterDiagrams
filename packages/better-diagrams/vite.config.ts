import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";
import { fileURLToPath } from "node:url";

// `__dirname` is undefined in an ESM config (package.json has "type": "module").
const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * The React half is a client component: it uses hooks, refs, and the DOM. Next
 * App Router consumers need the directive on the module they import, so it is
 * stamped onto the root entry only — the client boundary, whose imports are
 * client modules with it — and `contract` stays server-runnable, which is its
 * entire reason for existing.
 */
const useClientBanner = {
  name: "use-client-banner",
  generateBundle(_options: unknown, bundle: Record<string, { type: string; name?: string; code?: string }>) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type === "chunk" && chunk.name === "better-diagrams" && chunk.code) {
        chunk.code = `"use client";\n${chunk.code}`;
      }
    }
  },
};

export default defineConfig({
  plugins: [
    react(),
    // `bundleTypes` is v5's name for v4's `rollupTypes`: one rolled-up
    // declaration file per entry, which the `exports` map points at.
    dts({ include: ["src"], exclude: ["src/**/*.test.*"], bundleTypes: true }),
    useClientBanner,
  ],
  build: {
    lib: {
      entry: {
        // Two entries so `@mosphere/better-diagrams/contract` is a real
        // build artifact, not just a source-tree convention — importing it
        // must not pull the React half into a backend bundle.
        "better-diagrams": `${here}src/index.ts`,
        contract: `${here}src/contract/index.ts`,
        // The Node adapter for the folder format: its own entry, so importing
        // `contract` never pulls `node:fs` into a browser bundle.
        "contract-folder-node": `${here}src/contract/folder/node.ts`,
        // The AI route, for a host's server. Its provider SDKs are optional
        // peers, imported only when that provider answers.
        server: `${here}src/server/index.ts`,
        // The disk store behind a local editor's live files, and the
        // standalone server `better-diagrams` runs. Node only; Prettier, an
        // optional peer, is imported only to format what it writes.
        disk: `${here}src/disk/index.ts`,
      },
      name: "ArchitectureStudio",
      formats: ["es", "cjs"],
    },
    rollupOptions: {
      // Externalised, not bundled: React so the host supplies exactly one
      // copy, and React Flow because it carries its own context and store —
      // two bundled copies would mean two stores and a doubled payload for
      // any host that already uses it. It stays a normal `dependency`, so
      // npm installs it and the host's bundler dedupes. CodeMirror for the
      // same reason: @codemirror/state checks extensions by instanceof, so a
      // bundled second copy breaks hosts that already ship an editor.
      external: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "@xyflow/react",
        /^@codemirror\//,
        /^@lezer\//,
        /^node:/,
        "@anthropic-ai/sdk",
        "openai",
        "prettier",
      ],
      output: {
        globals: { react: "React", "react-dom": "ReactDOM" },
        assetFileNames: "better-diagrams.css",
        // One file per source module rather than one per entry. A host's
        // bundler can then drop whole modules the host never reaches —
        // `sideEffects` says only the CSS has any — and a dynamic `import()`
        // inside the editor (the HTML page builder, the JSON code editor and
        // CodeMirror with it) stays a real split point in the host's build
        // instead of being inlined into one file here.
        preserveModules: true,
        preserveModulesRoot: "src",
      },
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
