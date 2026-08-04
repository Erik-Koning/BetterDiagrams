import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";
import { fileURLToPath } from "node:url";

// `__dirname` is undefined in an ESM config (package.json has "type": "module").
const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * The React half is a client component: it uses hooks, refs, and the DOM. Next
 * App Router consumers need the directive on the built file, so it is stamped
 * onto that chunk only — `contract` must stay server-runnable, which is its
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
    dts({ include: ["src"], exclude: ["src/**/*.test.*"], rollupTypes: true }),
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
      ],
      output: {
        globals: { react: "React", "react-dom": "ReactDOM" },
        assetFileNames: "better-diagrams.css",
      },
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
