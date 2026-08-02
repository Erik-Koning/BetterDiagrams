import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Component tests opt into jsdom with a `@vitest-environment` docblock.
    // (`environmentMatchGlobs` is deprecated in Vitest 3.)
    environment: "node",
    setupFiles: ["src/test-setup.ts"],
  },
});
