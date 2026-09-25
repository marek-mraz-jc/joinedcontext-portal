import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative, so the build works under whatever path it is served from: `/apps/{name}/` on the
  // static host, `JC_BASE_PATH` behind a `ui-rust` server (AP-14). An absolute `/assets/…` would
  // be asked of the origin's root, where no app is served.
  base: "./",
  plugins: [react()],
  // MapLibre's worker is an ES module importing the library's shared chunk (map-worker.ts).
  worker: { format: "es" },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "functions/**/*.test.ts"],
    // The published SDK imports its map's stylesheet; inlined, Vite handles the CSS that Node
    // cannot import (the build lane installs the packed SDK, not its sources, ADR-N-026).
    server: { deps: { inline: ["@joinedcontext/sdk"] } },
  },
});
