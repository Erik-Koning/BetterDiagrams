import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
      "@mosphere/architect-better-code-diagrams/styles.css": new URL(
        "../packages/architecture-studio/src/styles.css",
        import.meta.url,
      ).pathname,
      "@mosphere/architect-better-code-diagrams": new URL(
        "../packages/architecture-studio/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
