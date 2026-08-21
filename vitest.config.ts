import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// One root config for every workspace's tests rather than a per-app vitest.config.ts:
// there's no per-app dev-server behavior (proxying, BASE_PATH, polling) a test run needs,
// so a single jsdom project covering apps/** and packages/** avoids four copies that would
// only ever drift the way the four vite.config.ts files already have.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["apps/**/src/**/*.test.{ts,tsx}", "packages/**/src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globals: true,
    css: false,
  },
});
