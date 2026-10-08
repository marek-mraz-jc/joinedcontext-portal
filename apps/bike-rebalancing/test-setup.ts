import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initSync } from "./wasm/pkg/bike_rebalancing.js";

// The module as the build lane binds it into wasm/pkg (builder/build-wasm.sh, or `pnpm wasm`), loaded once: jsdom has no
// worker, so the page calls it in place, and every test runs the real WebAssembly.
// jsdom gives this module an http: address, so the file is found from the app's folder, where vitest runs.
initSync({ module: readFileSync(resolve(process.cwd(), "wasm/pkg/bike_rebalancing_bg.wasm")) });
