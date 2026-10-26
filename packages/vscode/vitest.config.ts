import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mosphere/better-diagrams/disk": fileURLToPath(new URL("../better-diagrams/src/disk/index.ts", import.meta.url)),
      "@mosphere/better-diagrams": fileURLToPath(new URL("../better-diagrams/src/index.ts", import.meta.url)),
      "@app": fileURLToPath(new URL("../../example/src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
