// The analyser of the tests: the same module the worker loads, compiled for the browser, run
// in-process (jsdom has no Worker). Vite inlines the module's bytes for the test, so no file is
// read and no network is asked. `pnpm test` builds wasm/pkg first when it is missing.
import wasm from "../wasm/pkg/alerts_heatmap_bg.wasm?url&inline";
import { analyse, initSync } from "../wasm/pkg/alerts_heatmap.js";
import { parseAnswer } from "./analysis";
import type { Analyser } from "./analysis";

const base64 = wasm.slice(wasm.indexOf(",") + 1);
initSync({ module: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) });

export const inProcess: Analyser = async (input) => parseAnswer(analyse(JSON.stringify(input)));
