/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `@joinedcontext/sdk` is linked from this repository (T-1439) and carries its own `react` in
  // `sdk/node_modules`. Without deduping, a component from it renders against a second copy of
  // React whose hook dispatcher is null — every hook inside the grid throws "invalid hook call"
  // (measured: `Cannot read properties of null (reading 'useMemo')`).
  resolve: {
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
  build: {
    outDir: "dist",
  },
  // The policy the Rust server sends (src/server.rs), so the e2e journeys run under the same
  // rules as dev: a library that needs `eval` fails here before it fails there.
  preview: {
    headers: {
      "Content-Security-Policy":
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; " +
        "form-action 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:",
    },
  },
  server: {
    // `@joinedcontext/sdk` is `link:../sdk` and its package entry is TypeScript source, not a
    // built bundle, so Vite serves it over `/@fs/` — which `server.fs.allow` guards. Vite 8
    // derives that allow-list from the nearest package root, `ui/`, where Vite 5 walked up to
    // the `.git` directory; `../sdk` became unreachable and every test file that imports the
    // SDK failed to collect with "Cannot find module /@fs/.../sdk/src/…", 86 of 142 of them.
    // The sibling package is named on its own rather than the repository root, so nothing else
    // outside `ui/` is served.
    fs: { allow: [".", "../sdk"] },
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
  test: {
    environment: "jsdom",
    // Transforming this suite's modules takes about 7 s and was redone on every invocation; the
    // fast lane runs a handful of files at a time, dozens of times a day. Cached on disk under
    // node_modules/.vite, keyed by content, so a changed file still transforms.
    fsModuleCache: true,
    // i18next-icu's ESM build default-imports intl-messageformat, whose CJS entry has no
    // __esModule marker — Node's interop then hands back the namespace object and
    // `new IntlMessageFormat()` throws. Inlining makes vitest resolve both through Vite,
    // which picks the ESM build the browser bundle already uses.
    server: { deps: { inline: ["i18next-icu", "intl-messageformat"] } },
    setupFiles: ["./tests/setup.ts"],
    globals: true,
    css: true,
    include: ["tests/**/*.test.{ts,tsx}"],
    // Rendering the whole app (router, i18n, rjsf) takes seconds on a shared CPU, and the
    // 5 s default would kill a test in the middle of an assertion that is merely slow.
    testTimeout: 20_000,
    // Coverage is measured, never targeted (T-2136): the thresholds below are what the suite
    // reached on 2026-09-20, so the number can rise and cannot fall. `ci-full` runs
    // `pnpm vitest run --coverage`; the fast lane does not, because instrumenting every module
    // costs more than the lane's whole budget.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // The bundle entry, the generated API types and the CSS-only modules have nothing to
      // cover: `main.tsx` mounts React and `schema.d.ts` is types.
      exclude: ["src/main.tsx", "src/api/schema.d.ts", "src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
      // Measured on 2026-09-20 over the whole suite (217 files, 2 136 cases): lines 91.17,
      // statements 90.71, functions 88.91, branches 81.68. Each threshold is that number floored
      // to the whole percent, so a single line does not flap the build and the figure can only be
      // raised by hand when the suite has earned it.
      thresholds: { lines: 91, statements: 90, functions: 88, branches: 81 },
    },
  },
});
