import "@testing-library/jest-dom/vitest";
import { afterAll } from "vitest";
import { recordControls } from "@joinedcontext/sdk/testing";

// jsdom has no ResizeObserver; every browser the app runs in does. The map's observer is inert here.
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!("ResizeObserver" in globalThis)) {
  Object.defineProperty(globalThis, "ResizeObserver", { value: InertResizeObserver, configurable: true });
}

// The Apps' coverage gate reads which controls the tests rendered and which they exercised (T-3373).
recordControls(afterAll);
