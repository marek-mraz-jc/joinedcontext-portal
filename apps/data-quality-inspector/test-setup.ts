import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver; every browser the app runs in does. The map's observer is inert here.
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!("ResizeObserver" in globalThis)) {
  Object.defineProperty(globalThis, "ResizeObserver", { value: InertResizeObserver, configurable: true });
}
