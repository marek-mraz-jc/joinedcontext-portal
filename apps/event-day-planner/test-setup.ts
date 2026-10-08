import "@testing-library/jest-dom/vitest";
// The module as the build lane binds it into wasm/pkg (builder/build-wasm.sh, or `pnpm wasm`),
// loaded once: jsdom has no worker, so the page calls it in place, and every test runs the real
// WebAssembly. Vite inlines its bytes, so no file is read and no network is asked.
import wasm from "./wasm/pkg/event_day_planner_bg.wasm?url&inline";
import { initSync } from "./wasm/pkg/event_day_planner.js";

initSync({ module: Uint8Array.from(atob(wasm.slice(wasm.indexOf(",") + 1)), (c) => c.charCodeAt(0)) });
